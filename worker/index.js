/**
 * Cloudflare Worker — 앱 껍데기와 프록시를 한 오리진에서 낸다.
 *
 * 라우트
 *   GET      /api/proxy-image?url=&ref=   이미지 바이너리 중계 (스트리밍)
 *   GET      /api/fetch-page?url=         HTML 가져오기
 *   GET|POST /api/auth?t=                 토큰 확인 후 쿠키 발급
 *   GET      /api/render-page             501 — Worker 에는 브라우저가 없다
 *   그 밖에                                정적 자산
 *
 * 프록시가 필요한 이유는 표시가 아니라 **저장**이다. 실측: 타 오리진에서
 * `<img>` 로는 보이지만 `Access-Control-Allow-Origin` 이 없어 `fetch` 로
 * 바이트를 읽을 수 없다. 오프라인 서재는 바이트가 필요하다.
 *
 * 왜 인증이 붙는가: 이 주소는 인터넷에 공개된다. 그냥 두면 누구나 쓰는
 * 오픈 프록시가 되어 남의 트래픽을 대신 내주게 된다.
 */

import {
  assertFetchableUrl,
  imageRequestHeaders,
  pageRequestHeaders,
  upstreamFetch,
} from '../src/shared/proxyRules.js';

const COOKIE_NAME = 'mv_auth';
const COOKIE_MAX_AGE = 31536000; // 1년

function json(status, payload, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function textError(status, message) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/* ==================================================================== */
/* 인증                                                                  */
/* ==================================================================== */

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 길이·내용 모두 시간에 의존하지 않게 비교한다 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/**
 * 토큰이 설정돼 있지 않으면 모든 /api 를 막는다.
 *
 * 실수로 시크릿 없이 배포했을 때 "누구나 쓰는 프록시"가 되는 것보다
 * "내가 못 쓰는 프록시"가 낫다. 실패는 닫히는 쪽으로.
 */
async function authorize(request, env) {
  if (!env.MV_TOKEN) {
    return textError(
      503,
      'MV_TOKEN 시크릿이 설정되지 않았습니다.\n' +
        'npx wrangler secret put MV_TOKEN 으로 넣은 뒤 다시 배포하세요.'
    );
  }

  const expected = await sha256Hex(env.MV_TOKEN);
  if (constantTimeEqual(readCookie(request, COOKIE_NAME), expected)) return null; // 통과

  return json(401, {
    ok: false,
    error: '인증이 필요합니다. 토큰이 붙은 주소로 한 번 열어주세요 (?t=...).',
    needsAuth: true,
  });
}

async function handleAuth(request, env) {
  if (!env.MV_TOKEN) {
    return json(503, { ok: false, error: 'MV_TOKEN 시크릿이 설정되지 않았습니다.' });
  }

  const url = new URL(request.url);
  let token = url.searchParams.get('t');

  if (!token && request.method === 'POST') {
    try {
      const body = await request.json();
      token = body && body.token;
    } catch {
      // 본문이 JSON 이 아니면 토큰 없음으로 취급한다
    }
  }

  if (!token || !constantTimeEqual(String(token), env.MV_TOKEN)) {
    return json(401, { ok: false, error: '토큰이 맞지 않습니다.' });
  }

  const hash = await sha256Hex(env.MV_TOKEN);
  // http 로 띄운 로컬 개발에서는 Secure 쿠키가 저장되지 않는다
  const secure = url.protocol === 'https:' ? ' Secure;' : '';

  return json(
    200,
    { ok: true },
    {
      'Set-Cookie':
        `${COOKIE_NAME}=${hash}; Path=/; HttpOnly;${secure} ` +
        `SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
    }
  );
}

/* ==================================================================== */
/* 라우트                                                                */
/* ==================================================================== */

/**
 * 이미지 중계. 본문을 버퍼에 담지 않고 그대로 흘려보낸다.
 *
 * 무료 티어 CPU 는 요청당 10ms 다. 수 MB 를 arrayBuffer 로 받으면 그것만으로
 * 한도에 닿는다. 스트리밍하면 CPU 를 거의 쓰지 않는다.
 */
async function handleProxyImage(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  const ref = url.searchParams.get('ref');

  if (!target) return textError(400, 'url 파라미터가 필요합니다.');

  let parsed;
  try {
    // Cloudflare 에는 사설망이 없고 이 주소는 공개돼 있다 → 항상 막는다
    parsed = assertFetchableUrl(target, false);
  } catch (err) {
    return textError(400, err.message);
  }

  let upstream;
  try {
    upstream = await upstreamFetch(parsed.href, imageRequestHeaders(ref));
  } catch (err) {
    return textError(502, '이미지 중계 실패: ' + err.message);
  }

  if (!upstream.ok) {
    return textError(502, `원본 이미지 서버가 요청을 거부했습니다 (${upstream.status}).`);
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // 이미지 자리에 HTML 이 오면 링크가 만료됐거나 차단 페이지다
    return textError(502, '이미지 대신 HTML이 돌아왔습니다. 링크가 만료되었을 수 있습니다.');
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'image/jpeg',
      // 원격 SVG 등이 같은 오리진 문서로 실행되지 않게 막는다
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

async function handleFetchPage(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');

  if (!target) return json(400, { ok: false, error: 'url 파라미터가 필요합니다.' });

  let parsed;
  try {
    parsed = assertFetchableUrl(target, false);
  } catch (err) {
    return json(400, { ok: false, error: err.message });
  }

  let upstream;
  try {
    upstream = await upstreamFetch(parsed.href, pageRequestHeaders(parsed.origin + '/'));
  } catch (err) {
    return json(502, { ok: false, error: '페이지를 가져오지 못했습니다: ' + err.message });
  }

  if (!upstream.ok) {
    return json(502, { ok: false, error: `사이트가 ${upstream.status} 응답을 반환했습니다.` });
  }

  /**
   * text/plain 으로 돌려준다. 클라이언트는 DOMParser 로 파싱하므로 문제없고,
   * 이 주소를 직접 열었을 때 원격 HTML 이 우리 오리진 문서로 실행되지 않는다.
   */
  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Worker 에는 브라우저가 없다.
 *
 * Browser Rendering 은 유료 기능이라 무료 배포에서는 쓸 수 없다. 태블릿의
 * Termux 도 Chrome 을 못 깐다 — 같은 한계다. 사용자가 그 자리에서 할 수 있는
 * 일(북마클릿)을 알려주는 것이 유일하게 쓸모 있는 응답이다.
 */
function handleRenderPage() {
  return json(501, {
    ok: false,
    needsBookmarklet: true,
    error:
      '이 사이트는 이미지를 나중에 불러오는데, 여기서는 서버가 대신 열어볼 수 없습니다.\n' +
      '불러오기 창의 북마클릿을 쓰세요 — 브라우저에서 그 만화를 열고 북마클릿을 누르면 됩니다.',
  });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (!path.startsWith('/api/')) {
      // run_worker_first 설정상 여기까지 오는 일은 드물다. 방어적으로 넘긴다
      return env.ASSETS.fetch(request);
    }

    if (path === '/api/auth') return handleAuth(request, env);

    const denied = await authorize(request, env);
    if (denied) return denied;

    if (path === '/api/proxy-image') return handleProxyImage(request);
    if (path === '/api/fetch-page') return handleFetchPage(request);
    if (path === '/api/render-page') return handleRenderPage();

    return json(404, { ok: false, error: '없는 경로입니다.' });
  },
};
