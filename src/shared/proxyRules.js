/**
 * 프록시가 어디서 돌아도 같아야 하는 규칙.
 *
 * 두 곳에서 쓴다:
 *  - vite-proxy-plugin.js  (맥이나 태블릿에서 도는 Node 서버)
 *  - worker/index.js       (Cloudflare Worker)
 *
 * 왜 한 파일인가: 이 프로젝트에서 규칙을 두 곳에 복붙했다가 한쪽만 고쳐서
 * 같은 사이트가 경로에 따라 다르게 동작한 버그가 이미 났다. 가드가 갈리면
 * 그건 버그가 아니라 보안 구멍이 된다.
 *
 * `src/core/` 가 아닌 이유: core 는 순수 함수만 두기로 했고 upstreamFetch 는 I/O 다.
 */

export const FETCH_TIMEOUT_MS = 20000;

/**
 * 브라우저 UA 를 실어야 한다.
 *
 * 실측(네이버 이미지 호스트, 2026-08-05): **브라우저 UA 면 Referer 없이도 200**,
 * UA 가 curl 이면 Referer 가 원본 페이지일 때만 200. 즉 조건은 "UA 또는 Referer".
 * 둘 다 보내는 편이 안전하다.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * 프록시가 필요한 진짜 이유 — CORS.
 *
 * 실측: 타 오리진에서 `<img src>` 로 **표시는 된다**(690×1600 로드 확인).
 * 하지만 `Access-Control-Allow-Origin` 이 없어서 `fetch` 로 **바이트를 읽을 수 없다**
 * (`TypeError: Failed to fetch`). 오프라인 서재는 바이트를 저장해야 하므로
 * 프록시를 반드시 거쳐야 한다. 표시만 할 거면 프록시가 없어도 된다.
 */
export function imageRequestHeaders(refererUrl, fallbackUrl = null) {
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  };

  let referer = fallbackUrl;
  if (refererUrl) {
    try {
      referer = assertFetchableUrl(refererUrl, true).href;
    } catch {
      /* 힌트가 깨졌으면 호출자가 준 이미지 오리진을 쓴다 */
    }
  }
  if (referer) headers.Referer = referer;
  return headers;
}

/** refererUrl 은 보통 그 사이트 자신의 오리진을 넘긴다 (자기 사이트에서 온 것처럼) */
export function pageRequestHeaders(refererUrl) {
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
  };
  if (refererUrl) headers.Referer = refererUrl;
  return headers;
}

/**
 * 가져와도 되는 주소인가.
 *
 * 이 프록시는 LAN(또는 인터넷)에 열려 있다. 그냥 두면 남이 사설망(공유기 관리
 * 페이지, 클라우드 메타데이터 169.254.169.254)을 찔러보는 통로가 된다.
 *
 * allowPrivate 은 "요청자가 이 기기 자신일 때"만 참이다. 기기 앞에 앉은 사람은
 * 자기 로컬 테스트 사이트를 가리킬 수 있어야 하지만, 남은 안 된다.
 * Cloudflare 에서는 항상 false 다 — 사설망 개념이 없고 인터넷에 열려 있으니까.
 */
export function assertFetchableUrl(rawUrl, allowPrivate) {
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

  if (isBlockedHost && !allowPrivate) {
    throw new Error(
      '사설망 주소는 가져올 수 없습니다. ' +
        '로컬 테스트 사이트라면 이 기기(localhost)에서 뷰어를 열고 시도하세요.'
    );
  }

  return parsed;
}

/**
 * 상류 요청. 한 번은 다시 시도한다.
 *
 * 사이트가 순간적으로 거절하거나(연속 요청 시 흔하다) 타임아웃 한 번 났다고
 * 사용자에게 "실패"를 띄우면 앱이 고장난 것처럼 보인다. 실제로 네이버 웹툰에서
 * 같은 페이지를 반복 요청하다 502 를 한 번 맞았고, 곧바로 다시 하면 200 이었다.
 */
export async function upstreamFetch(url, headers) {
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 700));
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // 5xx 는 재시도할 가치가 있다. 4xx 는 다시 해도 같은 답이 온다.
      if (res.status >= 500 && attempt === 0) {
        lastErr = new Error(`상류 ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('상류 요청 실패');
}
