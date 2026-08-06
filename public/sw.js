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

const CACHE = 'manga-shell-v1.0.2';

const PRECACHE = ['./', './index.html', './icon-192.png', './manifest.webmanifest'];

/**
 * 앱을 여는 데 실제로 필요한 번들까지 설치 때 담는다.
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
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
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
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ota/')) return; // OTA 패키지 및 최신 번들 매니페스트는 캐싱 금지
  if (url.pathname.startsWith('/@')) return;

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
