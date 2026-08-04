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

const FETCH_TIMEOUT_MS = 20000;
const IMPORT_TTL_MS = 5 * 60 * 1000;
const MAX_PAGES = 2000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

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
function assertFetchableUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('올바른 URL이 아닙니다.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('http/https 주소만 가져올 수 있습니다.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  const isBlockedHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host);

  if (isBlockedHost) {
    throw new Error('사설망 주소는 가져올 수 없습니다.');
  }

  return parsed;
}

function upstreamFetch(url, headers) {
  return fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

export default function mangaProxyPlugin() {
  return {
    name: 'manga-proxy',
    configureServer(server) {
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
          const parsed = assertFetchableUrl(targetUrl);

          // 이미지 CDN은 보통 "만화를 읽던 그 페이지"를 Referer 로 기대한다.
          let referer = parsed.origin + '/';
          if (refererHint) {
            try {
              referer = new URL(refererHint).href;
            } catch {
              /* 힌트가 깨졌으면 이미지 오리진을 그대로 쓴다 */
            }
          }

          const response = await upstreamFetch(parsed.href, {
            'User-Agent': BROWSER_UA,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            Referer: referer,
          });

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
    },
  };
}
