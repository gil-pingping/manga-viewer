/**
 * 오프라인 서재 — 챕터 메타와 이미지 바이트를 태블릿에 남긴다.
 *
 * 왜 필요한가: 이미지 호스트가 Referer 를 검사한다. 실측(네이버 웹툰):
 * Referer 없음 403 · 다른 오리진 Referer 403 · 원본 페이지 Referer 200.
 * CORS 헤더도 없다. 즉 **브라우저 혼자서는 그 이미지를 절대 못 불러온다** —
 * 프록시가 Referer 를 붙여줘야 한다.
 *
 * 그래서 가져오기(다운로드)는 프록시가 살아 있을 때만 된다. 하지만 바이트를
 * 한 번 받아 저장해두면 읽기는 아무것도 필요 없다. 태블릿 단독 사용의 답이 이것이다.
 *
 * 저장소는 IndexedDB 다. Cache API 가 더 간단하지만 secure context 전용이라
 * `http://<LAN IP>:5173` 에서 `window.caches` 가 undefined 다. IndexedDB 는 어디서나 된다.
 */

import { fetchPageImage } from './platform/nativeHttp.js';

const DB_NAME = 'mangaViewer';
const DB_VERSION = 2;
const CHAPTERS = 'chapters';
const PAGES = 'pages';
const RECENT_CHAPTERS = 'recent_chapters';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHAPTERS)) {
        db.createObjectStore(CHAPTERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PAGES)) {
        db.createObjectStore(PAGES, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(RECENT_CHAPTERS)) {
        db.createObjectStore(RECENT_CHAPTERS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 트랜잭션 하나를 약속으로 감싼다. work 의 반환값을 결과로 준다 */
async function run(storeNames, mode, work) {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const result = await work(tx);
  await done;
  return result;
}

/* ==================================================================== */
/* 읽기                                                                  */
/* ==================================================================== */

/** 저장된 챕터 메타 전부. 최근에 담은 것이 앞 */
export async function listChapters() {
  const rows = await run([CHAPTERS], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(CHAPTERS).getAll())
  );

  // 예전에 `{ url }` 만 저장한 기록이 남아 있다. 마이그레이션 대신 읽을 때 채운다
  for (const row of rows) {
    row.pages = (row.pages || []).map((p, i) => ({
      ...p,
      pageNumber: p.pageNumber ?? i + 1,
      name: p.name || `Page ${i + 1}`,
    }));
  }

  return rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/**
 * 챕터의 페이지 바이트를 꺼내 화면에 걸 수 있는 주소로 바꾼다.
 *
 * 한 장이라도 빠졌으면 부분 저장이므로 null 을 돌려 온라인 경로를 쓰게 한다.
 * (중간에 구멍 난 챕터를 열어 빈 컷을 보여주는 것이 제일 나쁘다)
 */
export async function resolveOffline(chapter) {
  const keys = (chapter.pages || []).map((p) => p.url);
  if (keys.length === 0) return null;

  const rows = await run([PAGES], 'readonly', (tx) => {
    const store = tx.objectStore(PAGES);
    return Promise.all(keys.map((k) => reqToPromise(store.get(k))));
  });

  if (rows.some((r) => !r || !r.blob)) return null;
  return rows.map((r) => URL.createObjectURL(r.blob));
}

/**
 * 담아둔 컷 한 장만 꺼낸다 (키는 page.url).
 * 책장 표지는 한 장이면 되므로 챕터 전체를 여는 resolveOffline 을 쓰지 않는다.
 */
export async function pageBlobUrl(key) {
  if (!key) return null;
  try {
    const row = await run([PAGES], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(PAGES).get(key))
    );
    return row?.blob ? URL.createObjectURL(row.blob) : null;
  } catch {
    return null;
  }
}

/* ==================================================================== */
/* 쓰기                                                                  */
/* ==================================================================== */

/**
 * 챕터를 통째로 받아 저장한다.
 *
 * 한 장씩 받아 곧바로 넣는다 — 다 모아서 한 번에 쓰면 138장짜리에서
 * 메모리에 30MB 를 들고 있게 된다. 이미 있는 장은 건너뛰므로 이어받기가 된다.
 */
export async function saveChapter(chapter, { onProgress, signal } = {}) {
  const pages = chapter.pages || [];
  let bytes = 0;

  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw new Error('중단됨');

    const key = pages[i].url;

    const have = await run([PAGES], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(PAGES).get(key))
    );

    if (have?.blob) {
      bytes += have.blob.size;
    } else {
      const res = await fetchPageImage(pages[i], { signal });
      if (res.status === 401) {
        // 공개 배포(Cloudflare)에서 쿠키가 없거나 만료된 경우. 상태 코드만 보여주면
        // 원인을 알 수 없으니 무엇을 해야 하는지 적어준다
        throw new Error('인증이 만료됐습니다. 토큰이 붙은 주소로 다시 한 번 열어주세요 (?t=...).');
      }
      if (!res.ok) throw new Error(`${i + 1}번째 장을 받지 못했습니다 (${res.status})`);
      const blob = res.blob;
      if (blob.size === 0) throw new Error(`${i + 1}번째 장이 비어 있습니다`);
      bytes += blob.size;
      await run([PAGES], 'readwrite', (tx) => tx.objectStore(PAGES).put({ url: key, blob }));
    }

    onProgress?.(i + 1, pages.length);
  }

  const record = {
    id: chapter.id,
    title: chapter.title || '',
    label: chapter.label || '',
    /**
     * url 만 남기면 안 된다.
     *
     * 예전에 `{ url }` 로만 잘라 저장했더니 서재에서 복원한 챕터의 페이지 번호가
     * 사라져 화면 구석에 `undefined` 딱지가 찍혔다. 온라인으로 열 때는 멀쩡하고
     * **오프라인으로 열 때만** 보여서 원인을 찾기 어려웠다.
     * 화면이 쓰는 필드는 같이 남긴다 (url 은 여전히 서재의 키다).
     */
    pages: pages.map((p, i) => ({
      url: p.url,
      originalUrl: p.originalUrl || null,
      refererUrl: p.refererUrl || null,
      pageNumber: p.pageNumber ?? i + 1,
      name: p.name || `Page ${i + 1}`,
    })),
    sourceUrl: chapter.sourceUrl || null,
    prevUrl: chapter.prevUrl || null,
    nextUrl: chapter.nextUrl || null,
    pageCount: pages.length,
    bytes,
    savedAt: Date.now(),
  };

  await run([CHAPTERS], 'readwrite', (tx) => tx.objectStore(CHAPTERS).put(record));
  return record;
}

/**
 * 이 챕터만 쓰는 페이지 주소를 고른다 — 지워도 안전한 것들.
 *
 * 다른 챕터가 같은 주소를 쓰고 있으면 바이트를 남겨야 한다. 같은 화를 두 번
 * 불러 id 가 둘이 된 경우에 한쪽을 지우면서 바이트까지 날리면 나머지가
 * 구멍 난 챕터가 되고, 그건 화면에 빈 컷으로만 나타나 원인을 찾기 어렵다.
 * 삭제는 되돌릴 수 없으니 이 판단만 순수 함수로 떼어 테스트한다.
 */
export function orphanPageUrls(all, id) {
  const target = all.find((c) => c.id === id);
  if (!target) return [];

  const stillUsed = new Set();
  for (const c of all) {
    if (c.id === id) continue;
    for (const p of c.pages || []) stillUsed.add(p.url);
  }

  return (target.pages || []).map((p) => p.url).filter((u) => !stillUsed.has(u));
}

/** 챕터와 (다른 챕터가 안 쓰는) 그 이미지를 지운다 */
export async function deleteChapter(id) {
  const all = await listChapters();
  if (!all.some((c) => c.id === id)) return;

  const orphans = orphanPageUrls(all, id);

  await run([CHAPTERS, PAGES], 'readwrite', (tx) => {
    tx.objectStore(CHAPTERS).delete(id);
    const store = tx.objectStore(PAGES);
    for (const u of orphans) store.delete(u);
  });
}

/** 브라우저가 알려주는 사용량 (없는 브라우저도 있다) */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used, quota } = await navigator.storage.estimate();
  return { used, quota };
}

/**
 * 저장 공간을 지우지 말라고 요청한다.
 *
 * 요청하지 않으면 브라우저가 공간이 부족할 때 조용히 비운다. 서재가 사라지는
 * 것이 이 앱에서 가장 나쁜 실패라서 boot 때 한 번 부른다.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

export function formatBytes(n) {
  if (!n) return '0B';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export async function readRecentChaptersFromDb() {
  const rows = await run([RECENT_CHAPTERS], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(RECENT_CHAPTERS).getAll())
  );
  return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
