/**
 * 오프라인 조회를 **실제 브라우저 IndexedDB** 로 검사한다. `npm test` 로 돌린다.
 *
 * 왜 진짜 브라우저인가: `resolveOffline` 은 CHAPTERS 행과 PAGES 바이트를
 * readonly 트랜잭션 **하나** 에서 읽는다 (`run(...)` 은 `work(tx)` 를 await 한 뒤
 * 트랜잭션 완료를 기다린다). 그 안에 `await` 가 끼어 있다 —
 * CHAPTERS get → await → PAGES get. IndexedDB 트랜잭션은 제어가 이벤트 루프로
 * 돌아가는 순간 자동 커밋되므로, await 뒤에 요청을 걸면 엔진에 따라
 * `TransactionInactiveError` 가 난다. mock 은 이걸 절대 잡지 못한다.
 * (여기서 확인한 것: Chrome 에서는 request.onsuccess 에서 resolve 한 promise 의
 *  continuation 이 같은 task 의 microtask 로 돌아 트랜잭션이 아직 살아 있다.)
 *
 * 무엇을 고친 테스트인가: 바이트는 PAGES 에 `page.url` =
 * `/api/proxy-image?url=<서명된 CDN 주소>&ref=...` 로 저장되고 **서명이 키 안에**
 * 있다. 재수집하면 `upsertChapter` 가 `chapter.pages` 를 새 서명으로 갈아치우므로
 * 메모리 쪽 url 과 저장 키가 어긋난다. 그 상태에서 메모리 쪽 url 로 찾으면 전부
 * miss → 온라인 폴백 → 서명 만료 뒤엔 챕터 전체가 "이미지 실패 · 다시 시도".
 * 바이트는 그 내내 기기에 있었다. 그래서 그 챕터의 CHAPTERS 행에 적힌 키가 기준이다.
 *
 * saveChapter 는 부르지 않는다 — 실제 이미지를 네트워크로 받는다. DB 를 직접 심는다.
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// vite 가 필요한 이유: library.js → nativeHttp.js 가 `@capacitor/core` 를 bare
// specifier 로 import 한다. 정적 파일 서버로는 그 해석이 안 된다
const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
});
await vite.listen();

let browser;
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');

  // 앱(index.html)을 띄우면 boot 가 같은 DB 에 쓴다. 오리진만 빌려 빈 문서를 띄운다
  await page.route('**/library-offline-check', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>library offline check</title>' })
  );
  await page.goto(`${origin}/library-offline-check`);

  const result = await page.evaluate(async () => {
    // 다른 세션이 남긴 서재가 결과를 바꾸지 않도록 먼저 지운다. 모듈을 import 하기
    // 전에 해야 한다 — 모듈이 연결을 잡고 있으면 deleteDatabase 가 blocked 된다
    await new Promise((done, fail) => {
      const req = indexedDB.deleteDatabase('mangaViewer');
      req.onsuccess = done;
      req.onerror = () => fail(req.error);
      req.onblocked = () => fail(new Error('test database delete blocked'));
    });

    const lib = await import('/src/library.js');
    // 스키마(이름·버전·store·keyPath)를 테스트에 베껴 쓰지 않는다. 모듈이 자기
    // openDb 로 만들게 한 뒤, 버전 없이 열어 그 위에 심는다
    await lib.listChapters();
    const db = await new Promise((done, fail) => {
      const req = indexedDB.open('mangaViewer');
      req.onsuccess = () => done(req.result);
      req.onerror = () => fail(req.error);
    });

    const put = (storeName, value) =>
      new Promise((done, fail) => {
        const tx = db.transaction([storeName], 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = done;
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
      });

    // 실제 키 모양 그대로: 서명이 쿼리 안에 들어 있다
    const key = (sig) =>
      `/api/proxy-image?url=${encodeURIComponent(`https://cdn.example.test/cut.jpg?sig=${sig}`)}&ref=https%3A%2F%2Fexample.test%2F1`;
    const pageOf = (sig, i) => ({ url: key(sig), pageNumber: i + 1, name: `Page ${i + 1}` });
    const chapterOf = (id, sigs) => ({ id, pages: sigs.map(pageOf) });
    // 바이트는 작게 — 이 테스트는 용량이 아니라 키 선택을 검사한다 (3바이트)
    const seedBytes = (sigs) => Promise.all(sigs.map((s) => put('pages', { url: key(s), blob: new Blob([1, 2, 3]) })));
    const seedRow = (id, sigs) => put('chapters', { ...chapterOf(id, sigs), pageCount: sigs.length, savedAt: Date.now() });

    // 예외를 그냥 터뜨리지 않고 문자열로 걷어 온다 — TransactionInactiveError 가
    // 났는지 node 쪽 assert 메시지에 그대로 실어야 한다
    const call = async (chapter) => {
      try {
        return { urls: await lib.resolveOffline(chapter), error: null };
      } catch (e) {
        return { urls: null, error: `${e?.name}: ${e?.message}` };
      }
    };

    // 1) 재수집: 바이트는 옛 서명(A)로 저장, 메모리 챕터는 새 서명(B)
    await seedRow('ch-recollected', ['A1', 'A2', 'A3']);
    await seedBytes(['A1', 'A2', 'A3']);
    const recollected = await call(chapterOf('ch-recollected', ['B1', 'B2', 'B3']));

    // 2) 장수는 같지만 한 장(C2)의 바이트가 없다 → 구멍 난 챕터를 열어선 안 된다
    await seedRow('ch-partial', ['C1', 'C2', 'C3']);
    await seedBytes(['C1', 'C3']);
    const partial = await call(chapterOf('ch-partial', ['D1', 'D2', 'D3']));

    // 3) CHAPTERS 행이 없다 (이 변경 전에 저장된 기록) → 메모리 쪽 url 로 찾는다
    await seedBytes(['E1', 'E2']);
    const noRow = await call(chapterOf('ch-no-row', ['E1', 'E2']));

    // 4) 행의 장수가 다르다 = 판본이 다르다. 순번으로 짝지으면 엉뚱한 컷이 뜬다.
    //    행(F 2장)은 버리고 메모리 쪽(G 3장)을 써야 한다 — F 에는 바이트를 심지 않아
    //    행을 쓰면 null 이 나오도록 해 둔다
    await seedRow('ch-count-mismatch', ['F1', 'F2']);
    await seedBytes(['G1', 'G2', 'G3']);
    const countMismatch = await call(chapterOf('ch-count-mismatch', ['G1', 'G2', 'G3']));

    db.close();
    return { recollected, partial, noRow, countMismatch };
  });

  const blobUrls = (r) => (r.urls || []).filter((u) => typeof u === 'string' && u.startsWith('blob:'));

  // 5) 단일 트랜잭션이 실제 엔진에서 살아남는지 — 이 테스트가 브라우저를 띄우는 이유
  assert.equal(
    result.recollected.error,
    null,
    `한 트랜잭션 안에서 CHAPTERS get 뒤 await 하고 PAGES 를 읽는 패턴이 실제 브라우저에서 실패했다: ${result.recollected.error}`
  );

  // 1) 회귀 자체: 고치기 전에는 null → 온라인 폴백 → 챕터 전체 "이미지 실패 · 다시 시도"
  assert.equal(
    blobUrls(result.recollected).length,
    3,
    `재수집으로 서명이 바뀐 챕터가 담아둔 바이트를 못 읽었다 (받은 값: ${JSON.stringify(result.recollected.urls)})`
  );

  assert.equal(
    result.partial.urls,
    null,
    '한 장이 빠진 부분 저장인데 오프라인으로 열었다 — 화면에 빈 컷(구멍)이 그대로 뜬다'
  );

  assert.equal(
    blobUrls(result.noRow).length,
    2,
    `CHAPTERS 행이 없는 예전 기록이 오프라인으로 안 열렸다 (받은 값: ${JSON.stringify(result.noRow.urls)})`
  );

  assert.equal(
    blobUrls(result.countMismatch).length,
    3,
    `장수가 다른 저장 행을 버리지 않았다 — 순번으로 짝지으면 엉뚱한 컷이 뜬다 (받은 값: ${JSON.stringify(result.countMismatch.urls)})`
  );

  // 만든 주소는 되돌려 준다. 안 하면 페이지가 blob 을 계속 붙들고 있다
  const created = [result.recollected, result.noRow, result.countMismatch].flatMap(blobUrls);
  await page.evaluate((urls) => urls.forEach((u) => URL.revokeObjectURL(u)), created);

  console.log('서재 오프라인 조회: 재수집 키 폴백 + 부분 저장 거부 통과 (단일 트랜잭션 실제 IndexedDB)');
} finally {
  await browser?.close();
  await vite.close();
}
