/**
 * 앱 껍데기를 오프라인에서도 열리게 한다.
 *
 * 이미지는 여기서 다루지 않는다 — 서재(IndexedDB)가 담당한다. 프록시 응답까지
 * 캐시하면 같은 바이트를 두 곳에 저장하게 된다.
 *
 * 주의: 서비스워커는 secure context 전용이다. `http://<LAN IP>:5173` 에서는
 * 등록 자체가 안 되고 `localhost`·`https` 에서만 된다. 등록 실패는 치명적이지
 * 않다 — 서재는 그대로 동작하고, 앱 껍데기만 서버가 필요해진다.
 */

const CACHE = 'manga-shell-v1';

const PRECACHE = ['./', './index.html', './icon-192.png', './manifest.webmanifest'];

/**
 * 앱을 여는 데 실제로 필요한 번들까지 설치 때 담는다.
 *
 * 왜 필요한가: **첫 방문의 js/css 요청은 서비스워커를 거치지 않는다.** 그때는
 * 아직 워커가 제어권을 잡기 전이라 fetch 핸들러가 안 불린다. 껍데기만 미리
 * 담아두면 "처음 열고 바로 오프라인" 에서 index.html 은 나오는데 스크립트가 없어
 * **정적 HTML 만 뜬다** — 화면엔 `– / –` 만 보이고 앱이 죽은 것처럼 보인다.
 * (실측으로 이 상태를 만났다. 온라인 새로고침을 한 번 더 해야 캐시됐다.)
 *
 * 파일명에 해시가 붙어 목록을 미리 적을 수 없으니, index.html 을 받아서
 * 거기 적힌 자산 주소를 그대로 긁는다.
 */
async function assetUrlsFromShell(cache) {
  try {
    const res = await cache.match('./index.html');
    if (!res) return [];
    const html = await res.text();
    const found = new Set();
    for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:js|css))["']/gi)) {
      found.add(new URL(m[1], self.location.href).href);
    }
    return [...found];
  } catch {
    return []; // 못 긁어도 치명적이지 않다 — 다음 로드에서 fetch 핸들러가 채운다
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 하나라도 실패하면 install 이 통째로 죽으므로 개별로 담는다
      await Promise.allSettled(
        PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })))
      );
      const assets = await assetUrlsFromShell(cache);
      await Promise.allSettled(assets.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 오리진은 건드리지 않는다
  if (url.pathname.startsWith('/api/')) return; // 프록시는 서재가 담당
  if (url.pathname.startsWith('/@')) return; // Vite dev 내부 모듈

  event.respondWith(networkFirst(req));
});

/**
 * 네트워크 우선, 실패하면 캐시.
 *
 * 캐시 우선으로 하면 개발 중에 고친 코드가 안 반영돼 유령 버그를 쫓게 된다.
 * 오프라인이 목적이니 "될 때는 최신, 안 될 때는 저장본"이 맞다.
 */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);

  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    // 주소창으로 들어온 요청이면 앱 껍데기를 돌려준다
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./')) || (await cache.match('./index.html'));
      if (shell) return shell;
    }

    throw err;
  }
}
