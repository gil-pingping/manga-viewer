import { BROWSER_UA } from './proxyRules.js';

export const ANILIFE_ORIGIN = 'https://anilife.app';
export const ANILIFE_API_ORIGIN = 'https://api.anilife.app';

const WATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertAnilifeWatchId(id) {
  if (typeof id !== 'string' || !WATCH_ID_RE.test(id)) {
    throw new Error('올바른 애니라이프 watch ID가 아닙니다.');
  }
  return id;
}

export function parseAnilifeBuildVersion(html) {
  const version = typeof html === 'string' ? html.match(/\/_nuxt\/(\d{10,20})\//)?.[1] : null;
  if (!version) throw new Error('애니라이프 빌드 버전을 찾지 못했습니다.');
  return version;
}

export function anilifeMediaRequestHeaders(id, buildVersion, userAgent = BROWSER_UA) {
  assertAnilifeWatchId(id);
  if (!/^\d{10,20}$/.test(buildVersion || '')) {
    throw new Error('애니라이프 빌드 버전이 올바르지 않습니다.');
  }
  return {
    Accept: '*/*',
    Origin: ANILIFE_ORIGIN,
    Referer: `${ANILIFE_ORIGIN}/`,
    'User-Agent': userAgent,
    'X-Client-Id': 'web',
    'X-Build-Id': buildVersion,
    'X-Anilife-Referer': encodeURIComponent(`/watch?id=${id}`),
  };
}

export function assertAnilifeStreamUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('올바른 애니 스트림 URL이 아닙니다.');
  }
  const hostAllowed =
    parsed.hostname === 'api.gcdn.app' || /^edge-\d+\.gcdn\.app$/.test(parsed.hostname);
  const pathAllowed =
    parsed.pathname.startsWith('/v1/manifest/a/') || parsed.pathname.startsWith('/v1/media/');
  if (parsed.protocol !== 'https:' || !hostAllowed || !pathAllowed || parsed.href.length > 8192) {
    throw new Error('허용되지 않은 애니 스트림 URL입니다.');
  }
  return parsed;
}

export function anilifeStreamRequestHeaders(userAgent = BROWSER_UA, range = '') {
  const headers = {
    Accept: '*/*',
    Origin: ANILIFE_ORIGIN,
    Referer: `${ANILIFE_ORIGIN}/`,
    'User-Agent': userAgent,
  };
  if (range) headers.Range = range;
  return headers;
}
