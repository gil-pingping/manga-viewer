/**
 * Vite 로컬 프록시 플러그인
 *
 * 라우트
 *   POST /api/import          북마클릿이 수집한 이미지 목록을 받아 메모리에 보관
 *   GET  /api/import/latest   뷰어가 방금 들어온 목록을 꺼내간다
 *   GET  /api/proxy-image     이미지 바이너리를 서버에서 가져와 중계 (Referer 유지)
 *
 * 이미지 중계가 필요한 이유: 상당수 이미지 호스트가 Referer 없는 요청이나
 * 다른 오리진에서의 요청을 거부하므로, 브라우저가 직접 <img>로 못 불러온다.
 */

import {
  assertFetchableUrl,
  BROWSER_UA,
  FETCH_TIMEOUT_MS,
  imageRequestHeaders,
  pageRequestHeaders,
  upstreamFetch,
} from './src/shared/proxyRules.js';

/**
 * 가드와 상류 요청은 Cloudflare Worker 와 **같은 파일을 공유한다**
 * (src/shared/proxyRules.js). 가드가 두 곳으로 갈리면 그건 버그가 아니라
 * 보안 구멍이 된다. 테스트(test/proxy-guard-check.mjs)가 이 경로로 가져간다.
 */
export { assertFetchableUrl };

const IMPORT_TTL_MS = 5 * 60 * 1000;
const MAX_PAGES = 2000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 최근 import 페이로드 (단일 슬롯이면 충분하다) */
let latestImport = null;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 이 프록시는 `host: true`로 LAN에 열려 있다. 같은 와이파이의 누구든
 * 공용 프록시로 악용해 사설망(공유기 관리 페이지 등)을 찔러볼 수 있으므로
 * 사설/루프백 대역과 http(s) 이외 스킴은 막는다.
 */
/**
 * 요청이 이 기기 자신에서 왔는가.
 *
 * 기기 앞에 앉은 사람은 자기 로컬 테스트 사이트를 가리킬 수 있어야 한다.
 * 반면 같은 와이파이의 다른 사람은 이 프록시로 사설망을 찔러볼 수 없어야 한다.
 * 그 둘을 가르는 기준이 "요청자가 루프백인가" 다.
 */
export function isLoopbackRequester(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/* assertFetchableUrl · upstreamFetch 는 src/shared/proxyRules.js 에 있다
   (Cloudflare Worker 와 공유한다 — 위 import 주석 참고) */

/* ==================================================================== */
/* 헤드리스 브라우저 (JS 렌더 사이트용)                                   */
/* ==================================================================== */

/**
 * 브라우저는 하나만 띄워 재사용한다. 매 요청마다 실행하면 1~3초씩 든다.
 * playwright-core 는 브라우저를 내려받지 않는다 — 설치된 Chrome 을 쓴다.
 * 그래서 의존성이 가볍다(13MB, 브라우저 바이너리 0).
 */
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = import('playwright-core')
      .then(({ chromium }) => chromium.launch({ channel: 'chrome', headless: true }))
      .catch((err) => {
        browserPromise = null; // 실패하면 다음 요청에서 다시 시도한다
        throw new Error(
          '헤드리스 브라우저를 띄우지 못했습니다. Chrome 이 설치돼 있어야 합니다: ' + err.message
        );
      });
  }
  return browserPromise;
}

/**
 * 페이지에 주입할 선별 규칙 소스.
 *
 * 북마클릿이 쓰는 것과 **같은 소스**다. collector 의 BUNDLED 를 재사용하므로
 * 규칙 사본이 생기지 않는다 — 이 프로젝트에서 복붙이 버그의 근원이었다.
 */
let rulesSourcePromise = null;

function getRulesSource() {
  if (!rulesSourcePromise) {
    rulesSourcePromise = (async () => {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));

      // 소스를 파일에서 그대로 읽는다. 모듈 로더가 어떻게 변환했는지에
      // 의존하지 않으므로 서버·북마클릿이 같은 규칙을 쓴다는 보장이 단순해진다.
      const files = [join(here, 'src/core/imageRules.js'), join(here, 'src/collect/fromDocument.js')];
      const parts = [];
      for (const f of files) {
        const text = await readFile(f, 'utf8');
        // 이 두 파일에는 import 문이 없다 (규칙은 자기완결적이다).
        // `export` 키워드만 떼면 클래식 스크립트로 실행된다.
        parts.push(text.replace(/^export\s+/gm, ''));
      }

      return (
        parts.join('\n') +
        '\n;globalThis.__mangaRules = {' +
        ' selectContentImages: selectContentImages,' +
        ' collectDescriptors: collectDescriptors };'
      );
    })();
  }
  return rulesSourcePromise;
}

export default function mangaProxyPlugin() {
  /**
   * dev 서버와 preview 서버가 같은 라우트를 공유한다.
   *
   * `configureServer` 는 `vite dev` 에만 걸린다. 빌드한 앱을 태블릿에서 직접
   * 띄우는 것이 목표라 `vite preview` 에도 같은 미들웨어가 있어야 가져오기가 된다.
   */
  const mount = (server) => {
      /* ---------------------------------------------------------------- */
      /* 북마클릿 → 뷰어 인수인계                                          */
      /* ---------------------------------------------------------------- */
      server.middlewares.use('/api/import', async (req, res) => {
        if (handlePreflight(req, res)) return;

        // mount 경로가 벗겨지므로 '/api/import/latest' 는 '/latest' 로 들어온다
        const isLatest = /^\/latest\/?(\?|$)/.test(req.url || '/');

        if (isLatest) {
          if (!latestImport || Date.now() - latestImport.at > IMPORT_TTL_MS) {
            latestImport = null;
            sendJson(res, 404, { ok: false, error: '대기 중인 수집 결과가 없습니다.' });
            return;
          }
          sendJson(res, 200, { ok: true, payload: latestImport.payload });
          return;
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST 로 보내주세요.' });
          return;
        }

        try {
          const raw = await readBody(req);
          const data = JSON.parse(raw);

          const pages = Array.isArray(data.pages) ? data.pages : [];
          const cleanPages = pages
            .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
            .slice(0, MAX_PAGES);

          if (cleanPages.length === 0) {
            sendJson(res, 400, { ok: false, error: '유효한 이미지 주소가 없습니다.' });
            return;
          }

          latestImport = {
            at: Date.now(),
            payload: {
              title: typeof data.title === 'string' ? data.title.slice(0, 200) : '수집한 만화',
              sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl : null,
              prevUrl: typeof data.prevUrl === 'string' ? data.prevUrl : null,
              nextUrl: typeof data.nextUrl === 'string' ? data.nextUrl : null,
              pages: cleanPages,
            },
          };

          server.config.logger.info(
            `[manga-proxy] 수집 ${cleanPages.length}장 수신: ${latestImport.payload.title}`
          );
          sendJson(res, 200, { ok: true, count: cleanPages.length });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
      });

      /* ---------------------------------------------------------------- */
      /* 페이지 HTML 가져오기                                              */
      /*                                                                  */
      /* 서버가 대신 받아오므로 CORS·CSP 를 타지 않는다. 네이버 웹툰처럼    */
      /* 본문 이미지 주소가 HTML 에 그대로 있는 사이트는 이것만으로 끝난다. */
      /* ---------------------------------------------------------------- */
      server.middlewares.use('/api/fetch-page', async (req, res) => {
        if (handlePreflight(req, res)) return;

        const targetUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
        if (!targetUrl) {
          sendJson(res, 400, { ok: false, error: 'url 파라미터가 필요합니다.' });
          return;
        }

        try {
          const parsed = assertFetchableUrl(targetUrl, isLoopbackRequester(req));
          const response = await upstreamFetch(
            parsed.href,
            pageRequestHeaders(parsed.origin + '/')
          );

          if (!response.ok) {
            sendJson(res, 502, {
              ok: false,
              error: `사이트가 ${response.status} 응답을 반환했습니다.`,
            });
            return;
          }

          const html = await response.text();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(html);
        } catch (err) {
          sendJson(res, 502, { ok: false, error: err.message });
        }
      });

      /* ---------------------------------------------------------------- */
      /* 헤드리스 렌더링 — JS 로 이미지를 채우는 사이트용                   */
      /*                                                                  */
      /* fetch-page 는 서버가 받은 HTML 만 본다. 컷을 JS 가 나중에 채우면    */
      /* 거기엔 아무것도 없다. 그때 실제 브라우저로 열어 렌더된 DOM 을 읽는다.*/
      /* 덕분에 주소 하나만 넣으면 그런 사이트도 된다 (북마클릿 불필요).      */
      /*                                                                  */
      /* 선별 규칙은 북마클릿이 쓰는 것과 같은 소스를 주입한다.              */
      /* 사본을 만들지 않으려고 collector 의 BUNDLED 를 그대로 재사용한다.   */
      /* ---------------------------------------------------------------- */
      server.middlewares.use('/api/render-page', async (req, res) => {
        if (handlePreflight(req, res)) return;

        const targetUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
        if (!targetUrl) {
          sendJson(res, 400, { ok: false, error: 'url 파라미터가 필요합니다.' });
          return;
        }

        let page = null;
        try {
          const parsed = assertFetchableUrl(targetUrl, isLoopbackRequester(req));
          const browser = await getBrowser();

          page = await browser.newPage({
            userAgent: BROWSER_UA,
            viewport: { width: 1280, height: 1600 },
            locale: 'ko-KR',
          });

          // 규칙 주입이 실패하면 원인을 로그로 남긴다 (조용히 실패하면 진단이 불가능)
          page.on('pageerror', (e) =>
            server.config.logger.warn('[manga-proxy] 페이지 오류: ' + String(e).slice(0, 300))
          );

          /**
           * 규칙을 페이지 전역에 올린다. CDP 주입이라 페이지 CSP 를 타지 않고,
           * 함수 선언이 그대로 전역이 되어 evaluate 에서 바로 부를 수 있다.
           * (new Function 으로 감싸면 선언이 그 스코프에 갇힌다)
           */
          // 규칙 주입. CDP 로 넣으므로 페이지 CSP 를 타지 않는다.
          await page.addInitScript({ content: await getRulesSource() });

          await page.goto(parsed.href, {
            waitUntil: 'domcontentloaded',
            timeout: FETCH_TIMEOUT_MS,
          });

          // 컷을 채울 시간 + lazy 로드를 깨우는 스크롤
          await page.waitForTimeout(1200);
          await page.evaluate(async () => {
            const step = Math.max(window.innerHeight, 800);
            for (let y = 0; y < document.body.scrollHeight && y < step * 40; y += step) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 90));
            }
            window.scrollTo(0, 0);
          });
          await page.waitForTimeout(600);

          const result = await page.evaluate(() => {
            // addInitScript 로 올려둔 전역 규칙을 그대로 쓴다
            const R = globalThis.__mangaRules;
            if (!R) throw new Error('규칙 주입 실패 (globalThis.__mangaRules 없음)');
            const pages = R.selectContentImages(R.collectDescriptors(document), location.href);

            const findLink = (re) => {
              const here = location.href.split('#')[0];
              const anchors = document.querySelectorAll('a[href]');
              for (let i = 0; i < anchors.length; i++) {
                const a = anchors[i];
                const text = (a.textContent || '').trim();
                if (!re.test(text) && !re.test(a.getAttribute('rel') || '')) continue;
                if (a.href.split('#')[0] === here) continue;
                return a.href;
              }
              return null;
            };

            return {
              title: (document.title || '').split(/[|>]/)[0].trim(),
              pages,
              prevUrl: findLink(/이전화|이전\s*화|prev/i),
              nextUrl: findLink(/다음화|다음\s*화|next/i),
            };
          });

          server.config.logger.info(
            `[manga-proxy] 헤드리스 렌더 ${result.pages.length}장: ${result.title}`
          );
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendJson(res, 502, { ok: false, error: err.message });
        } finally {
          if (page) await page.close().catch(() => {});
        }
      });

      /* ---------------------------------------------------------------- */
      /* 이미지 중계                                                       */
      /* ---------------------------------------------------------------- */
      server.middlewares.use('/api/proxy-image', async (req, res) => {
        if (handlePreflight(req, res)) return;

        const params = new URL(req.url, 'http://localhost').searchParams;
        const targetUrl = params.get('url');
        const refererHint = params.get('ref');

        if (!targetUrl) {
          res.writeHead(400);
          res.end('url 파라미터가 필요합니다.');
          return;
        }

        try {
          const parsed = assertFetchableUrl(targetUrl, isLoopbackRequester(req));

          // 이미지 CDN은 보통 "만화를 읽던 그 페이지"를 Referer 로 기대한다.
          const response = await upstreamFetch(
            parsed.href,
            imageRequestHeaders(refererHint, parsed.origin + '/')
          );

          if (!response.ok) {
            res.writeHead(response.status === 404 ? 404 : 502, {
              'Content-Type': 'text/plain; charset=utf-8',
            });
            res.end(`이미지 서버가 ${response.status} 응답을 반환했습니다.`);
            return;
          }

          const contentType = response.headers.get('content-type') || '';
          const buffer = Buffer.from(await response.arrayBuffer());

          // HTML 오류 페이지가 이미지인 척 돌아오는 경우를 걸러낸다
          if (contentType.includes('text/html')) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('이미지 대신 HTML이 돌아왔습니다. 링크가 만료되었을 수 있습니다.');
            return;
          }

          res.writeHead(200, {
            'Content-Type': contentType || 'image/jpeg',
            'Content-Length': buffer.length,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(buffer);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('이미지 중계 실패: ' + err.message);
        }
      });
  };

  return {
    name: 'manga-proxy',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
