import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  FETCH_TIMEOUT_MS,
  assertFetchableUrl,
  imageRequestHeaders,
  pageRequestHeaders,
} from '../shared/proxyRules.js';
import { OTA_ORIGIN } from '../core/otaManifest.js';
import { BUILT_IN_PROXY_TOKEN } from '../generated/proxyToken.js';
import {
  ANILIFE_API_ORIGIN,
  ANILIFE_ORIGIN,
  anilifeMediaRequestHeaders,
  anilifeStreamRequestHeaders,
  assertAnilifeStreamUrl,
  assertAnilifeWatchId,
  parseAnilifeBuildVersion,
} from '../shared/anilifeRules.js';

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

export function base64ToBlob(base64, type = 'application/octet-stream') {
  if (typeof base64 !== 'string') throw new Error('네이티브 응답이 base64 문자열이 아닙니다.');
  const binary = atob(base64);
  const chunks = [];
  for (let start = 0; start < binary.length; start += 8192) {
    const slice = binary.slice(start, start + 8192);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type });
}

const NATIVE_STREAM_CHUNK_BYTES = 256 * 1024;

function parseByteRange(range) {
  if (!range) return { start: 0, end: null };
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error('애니 스트림 Range가 올바르지 않습니다.');
  }
  return { start: Number(match[1]), end: Number(match[2]) };
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value || '');
  if (!match) throw new Error('애니 스트림 Content-Range가 없습니다.');
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function header(headers, name) {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : '';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('중단됨', 'AbortError');
}

async function nativeGet(options, { attempts = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      const response = await CapacitorHttp.get({
        connectTimeout: FETCH_TIMEOUT_MS,
        readTimeout: FETCH_TIMEOUT_MS,
        ...options,
      });
      if (response.status >= 500 && attempt === 0) continue;
      return response;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('네이티브 HTTP 요청 실패');
}

/** Android bridge 1MB 한계를 넘지 않도록 영상 바이트를 작은 Range로 나눠 받는다. */
export async function readRangedNativeBytes(request, { url, headers, range = '', signal } = {}) {
  const requested = parseByteRange(range);
  const chunks = [];
  let byteLength = 0;
  let start = requested.start;

  while (requested.end === null || start <= requested.end) {
    throwIfAborted(signal);
    const end = Math.min(
      start + NATIVE_STREAM_CHUNK_BYTES - 1,
      requested.end ?? Number.MAX_SAFE_INTEGER
    );
    const response = await request({
      url,
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      responseType: 'blob',
    });
    throwIfAborted(signal);
    if (response.status !== 200 && response.status !== 206) {
      const error = new Error(`애니 스트림이 ${response.status} 응답을 반환했습니다.`);
      error.status = response.status;
      throw error;
    }

    const bytes = new Uint8Array(await base64ToBlob(response.data).arrayBuffer());
    if (response.status === 200) {
      if (chunks.length) throw new Error('애니 스트림 서버가 Range 응답을 중단했습니다.');
      return { status: 200, data: bytes.buffer };
    }

    const received = parseContentRange(header(response.headers, 'content-range'));
    if (received.start !== start || received.end - received.start + 1 !== bytes.byteLength) {
      throw new Error('애니 스트림 Range 응답 크기가 맞지 않습니다.');
    }
    chunks.push(bytes);
    byteLength += bytes.byteLength;

    if (received.end + 1 >= received.total ||
        (requested.end !== null && received.end >= requested.end)) break;
    start = received.end + 1;
  }

  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: range ? 206 : 200, data: joined.buffer };
}

/**
 * 통신사 차단 우회용 Worker 중계 토큰.
 *
 * 왜 필요한가: 일부 회선이 만화 사이트·CDN 의 TLS 를 SNI 필터로 리셋한다
 * (실측: 같은 주소가 낮엔 되고 밤엔 TLS 단계에서 끊겼다). 기기 직접 연결이
 * 죽으면 해외 egress 인 Worker 를 중계로 쓴다 — 그 인증 토큰이다.
 * 설정 화면에서 한 번 넣으면 저장된다. 없으면 폴백 없이 원래 실패를 보고한다.
 */
export function proxyAuthToken() {
  // 설정 화면에서 직접 넣은 값이 우선, 없으면 빌드가 키체인에서 내장한 값
  try {
    return localStorage.getItem('mv:proxyToken') || BUILT_IN_PROXY_TOKEN || '';
  } catch {
    return BUILT_IN_PROXY_TOKEN || '';
  }
}

/**
 * 페이지 바이트를 어떤 charset 으로 읽을지 고른다. 순수 함수 — 규칙을 테스트로 고정한다.
 *
 * 실측(2026-09-11 wftoon227.com): 새로 보는 만화 사이트가 UTF-8 이 아니라 CP949 다.
 * curl 로 받은 본문이 `iconv -f CP949` 로만 풀리고, `<title>` 없이 이름은
 * `<meta property="og:title" content="헬퍼 2 : 킬베로스 42화">` 에만 있다.
 * 그 바이트를 UTF-8 로 읽으면 제목이 `���� 2 : ų���ν� 42ȭ` 로 뭉개지고(태블릿
 * IndexedDB 실측), 주소에는 U+FFFD 를 다시 인코딩한 `%EF%BF%BD` 가 박혀 저장된다.
 *
 * 진짜 피해는 글자가 아니라 이동이다: 수집기는 페이지 링크의 `다음화`/`이전화` 글자로
 * 다음 화를 찾는데 뭉개진 글자는 절대 안 맞아 쿼리 증가 추측으로 떨어졌고, 하필 작품 id 를
 * 올려서 "다음 화" 가 다른 만화로 갔다(실측: `?toon=185&num=42` 는 `호박장군 41화`).
 *
 * 순서: 응답 헤더 charset → 본문 앞부분 meta 스니핑 → UTF-8.
 * 헤더가 먼저인 이유: 중계 Worker 가 이미 UTF-8 로 바꿔 보낸 본문에도 원본의
 * `<meta charset=euc-kr>` 이 그대로 남아 있다 — 헤더를 믿어야 두 번 디코딩하지 않는다.
 */
const CP949_ALIASES = /^(euc-kr|euckr|ks_c_5601-1987|ks_c_5601|ksc5601|ksc_5601|cp949|(x-)?windows-949)$/;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.+-]+)/i;

export function pickCharset(contentType, bytes) {
  const fromHeader = /charset\s*=\s*["']?\s*([\w:.+-]+)/i.exec(contentType || '')?.[1];
  // 앞 2KB 만, latin1(절대 throw 하지 않는 단일바이트)로 스니핑한다 — 잘못된 디코딩이
  // 스니핑 자체를 깨뜨리면 안 된다. meta 는 ASCII 라 이걸로 충분하다.
  const head = fromHeader
    ? ''
    : new TextDecoder('latin1').decode((bytes || new Uint8Array()).slice(0, 2048));
  const label = (fromHeader || META_CHARSET.exec(head)?.[1] || 'utf-8').trim().toLowerCase();
  // CP949 한 무리는 전부 같은 디코더다. 이 WebView 의 TextDecoder 는 `euc-kr` 라벨만 받는다
  return CP949_ALIASES.test(label) ? 'euc-kr' : label;
}

/** 고른 charset 으로 실제 디코딩한다. 모르는 라벨이면 UTF-8 — 여기서 throw 하면 화면이 빈다. */
export function decodePageBytes(bytes, contentType) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const label = pickCharset(contentType, view);
  try {
    return new TextDecoder(label).decode(view);
  } catch {
    // TextDecoder 생성자만 던진다(모르는 라벨 → RangeError). 디코딩 자체는 안 던진다
    return new TextDecoder('utf-8').decode(view);
  }
}

/** 웹은 기존 Worker, APK는 태블릿 네트워크로 대상 HTML을 직접 받는다. */
export async function fetchPageDocument(targetUrl) {
  if (!isNativeApp()) {
    return fetch(`/api/fetch-page?url=${encodeURIComponent(targetUrl)}`);
  }

  const target = assertFetchableUrl(targetUrl, false);
  let direct = null;
  let directError = null;
  try {
    // responseType:'blob' — 'text' 로 받으면 CapacitorHttp 가 바이트를 UTF-8 로 먼저
    // 디코딩해 넘긴다. CP949 사이트에서는 그 시점에 글자가 이미 죽고, 한 번 죽은 바이트는
    // 되돌릴 방법이 없다(이미지 경로에서 실측한 교훈). 그래서 바이트로 받아 우리가 읽는다.
    direct = await nativeGet({
      url: target.href,
      headers: { ...pageRequestHeaders(target.origin + '/'), 'User-Agent': navigator.userAgent },
      responseType: 'blob',
    });
  } catch (err) {
    directError = err;
  }

  // 직접 연결이 끊기거나 차단 응답이면 Worker 중계로 한 번 더 받아본다
  if (!direct || direct.status >= 400) {
    const token = proxyAuthToken();
    if (token) {
      try {
        const viaWorker = await nativeGet({
          url: `${OTA_ORIGIN}/api/fetch-page?url=${encodeURIComponent(target.href)}`,
          headers: { 'X-MV-Token': token },
          responseType: 'blob',
        });
        if (viaWorker.status < 400) direct = viaWorker;
      } catch {
        /* 중계도 실패면 원래 결과를 보고한다 */
      }
    }
  }

  if (!direct) throw directError || new Error('페이지를 가져오지 못했습니다.');
  const status = direct.status >= 200 && direct.status <= 599 ? direct.status : 502;

  let body;
  try {
    const bytes = new Uint8Array(await base64ToBlob(direct.data).arrayBuffer());
    body = decodePageBytes(bytes, header(direct.headers, 'content-type'));
  } catch {
    // 브릿지가 base64 대신 이미 디코딩한 문자열을 넘긴 경우(readData 는 content-type 에
    // application/json 이 있으면 responseType 을 무시하고 텍스트로 읽는다). 바이트가 없으니
    // 복구는 불가 — 예전 동작 그대로 넘겨 최소한 나빠지지는 않게 한다.
    body = typeof direct.data === 'string' ? direct.data : JSON.stringify(direct.data);
  }

  // 우리가 이미 제대로 디코딩했다 — 아래쪽(DOMParser 등)이 다시 charset 을 추측하면 안 된다
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function fetchAnilifeMediaEnvelope(id) {
  assertAnilifeWatchId(id);
  if (!isNativeApp()) {
    return fetch(`/api/anilife-media?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
  }

  const watchUrl = `${ANILIFE_ORIGIN}/watch?id=${id}`;
  const watch = await fetchPageDocument(watchUrl);
  if (!watch.ok) throw new Error(`애니 페이지를 가져오지 못했습니다 (${watch.status}).`);
  const buildVersion = parseAnilifeBuildVersion(await watch.text());
  const media = await nativeGet({
    url: `${ANILIFE_API_ORIGIN}/v1/media/${id}`,
    headers: anilifeMediaRequestHeaders(id, buildVersion, navigator.userAgent),
    responseType: 'text',
  });
  const status = media.status >= 200 && media.status <= 599 ? media.status : 502;
  const body = typeof media.data === 'string' ? media.data : JSON.stringify(media.data);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function fetchAnilifeStreamResource(
  rawUrl,
  { responseType = 'text', range = '', signal } = {}
) {
  throwIfAborted(signal);
  const target = assertAnilifeStreamUrl(rawUrl);
  if (!isNativeApp()) {
    const response = await fetch(`/api/anilife-stream?url=${encodeURIComponent(target.href)}`, {
      headers: range ? { Range: range } : undefined,
      signal,
    });
    if (!response.ok) {
      const error = new Error(`애니 스트림이 ${response.status} 응답을 반환했습니다.`);
      error.status = response.status;
      throw error;
    }
    return {
      status: response.status,
      data: responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text(),
    };
  }

  const headers = anilifeStreamRequestHeaders(navigator.userAgent, range);
  if (responseType === 'arraybuffer') {
    return readRangedNativeBytes(nativeGet, { url: target.href, headers, range, signal });
  }

  const response = await nativeGet({
    url: target.href,
    headers,
    responseType: 'blob',
  });
  throwIfAborted(signal);
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`애니 스트림이 ${response.status} 응답을 반환했습니다.`);
    error.status = response.status;
    throw error;
  }
  const buffer = await base64ToBlob(
    response.data,
    header(response.headers, 'content-type') || 'application/octet-stream'
  ).arrayBuffer();
  return {
    status: response.status,
    data: new TextDecoder().decode(buffer),
  };
}

/**
 * 직접 연결이 타임아웃으로 멎은 이미지 호스트.
 *
 * 실측(2026-09-10 태블릿): 같은 CDN 이 대부분은 200 인데 간헐적으로 TCP 가 멎어
 * SocketTimeout 20초 → 재시도 20초 → 그제야 중계로 갔다. 그동안 컷은 검은 자리로 남는다.
 * 한 번 멎은 호스트는 이 세션 동안 바로 중계로 보낸다.
 * ponytail: 메모리만 — 앱을 다시 켜면 다시 직접 시도한다. 회선이 낮/밤으로 바뀌는 실측에 맞다.
 */
const directTimedOutHosts = new Set();
const IMAGE_DIRECT_TIMEOUT_MS = 8000;

export function isTimeoutError(err) {
  return /timeout/i.test(`${err?.code || ''} ${err?.message || ''}`);
}

export function shouldTryDirectImage(host) {
  return !directTimedOutHosts.has(host);
}

export function noteDirectImageFailure(host, err) {
  if (isTimeoutError(err)) directTimedOutHosts.add(host);
}

/**
 * 직접 받은 이미지 응답을 쓸 수 있는 바이트로 바꾼다. 순수 함수 — 규칙을 테스트로 고정한다.
 *
 * 실측(2026-09-11 태블릿 v1.4.11): 같은 CDN 이 같은 JPEG 를 200 으로 주면서 content-type 을
 * 제멋대로 붙였다. `font/woff2` 면 CapacitorHttp 가 base64 문자열을 넘겨 정상 렌더됐지만,
 * `application/json` 이면 본문을 이미 텍스트로 디코딩해 넘겼다 — 머리가 `JFIF` 앞에 U+FFFD 네 개,
 * 즉 FF D8 FF E0 가 대체문자로 뭉개진 상태다. 그래서 atob 이
 * `InvalidCharacterError: ... outside of the Latin1 range` 로 던지고(실측 101·103·110·111 컷),
 * 그 throw 가 아래 중계 폴백까지 건너뛰어 src 도 못 넣은 컷이 "이미지 실패 · 다시 시도" 로 남았다.
 *
 * 뭉개진 바이트는 되돌릴 수 없다 — 복구를 시도하면 깨진 이미지가 성공처럼 보이니 더 나쁘다.
 * 그래서 text/html 차단 응답과 똑같이 '실패한 직접 시도'로 접어 Worker 중계 차례를 준다.
 */
export function decodeDirectImageResponse({ status, contentType, data } = {}) {
  const type = contentType || 'application/octet-stream';
  // CapacitorHttp 가 텍스트로 디코딩해 넘기는 타입 = 바이트가 이미 깨져서 도착했다
  const decodedAsText = /^text\/|^application\/json\b|\+json\b/i.test(type);
  if (!(status >= 200 && status < 300)) {
    return { ok: false, status: status || 502, blob: null, reason: `직접 연결 ${status || 502} 응답` };
  }
  if (decodedAsText) {
    return { ok: false, status: 502, blob: null, reason: `이미지가 아닌 content-type (${type})` };
  }
  try {
    return { ok: true, status, blob: base64ToBlob(data, type), reason: '' };
  } catch {
    // 여기서 실패로 접어야(throw 를 밖으로 내보내지 않아야) 아래 중계까지 흐름이 닿는다
    return { ok: false, status: 502, blob: null, reason: `본문이 base64 가 아니다 (${type})` };
  }
}

/** 표시·서재 저장 모두 같은 바이트 경로를 쓴다. */
export async function fetchPageImage(page, { signal } = {}) {
  throwIfAborted(signal);

  const rawUrl = page?.originalUrl || page?.url;
  const isDirectHttp = rawUrl && /^https?:\/\//i.test(rawUrl) && !rawUrl.includes('/api/proxy-image');

  if (!isNativeApp() || !isDirectHttp) {
    const response = await fetch(page?.url || rawUrl, { signal });
    return {
      ok: response.ok,
      status: response.status,
      blob: response.ok ? await response.blob() : null,
    };
  }

  const target = assertFetchableUrl(rawUrl, false);
  const referer = page?.refererUrl || 'https://newtoki1.org/';

  let direct = null;
  let directError = null;
  if (shouldTryDirectImage(target.host)) {
    try {
      // 재시도 없음(attempts:1)·짧은 timeout — 멎은 회선은 중계가 받쳐준다
      const response = await nativeGet({
        url: target.href,
        headers: {
          ...imageRequestHeaders(referer, 'https://newtoki1.org/'),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        },
        responseType: 'blob',
        connectTimeout: IMAGE_DIRECT_TIMEOUT_MS,
        readTimeout: IMAGE_DIRECT_TIMEOUT_MS,
      }, { attempts: 1 });
      // content-type 이 틀린 건 회선 타임아웃이 아니다 — 호스트 메모를 더럽히지 않도록
      // 판정은 throw 없는 순수 함수가 하고, catch 에는 진짜 연결 실패만 남긴다
      direct = decodeDirectImageResponse({
        status: response.status,
        contentType: header(response.headers, 'content-type'),
        data: response.data,
      });
    } catch (err) {
      directError = err;
      noteDirectImageFailure(target.host, err);
    }
  }
  throwIfAborted(signal);
  if (direct?.ok) return direct;

  // 직접 연결이 죽는 회선(SNI 필터 실측)에서는 Worker 중계로 한 번 더 받아본다
  const token = proxyAuthToken();
  if (token) {
    try {
      let proxied = `${OTA_ORIGIN}/api/proxy-image?url=${encodeURIComponent(target.href)}`;
      if (referer) proxied += `&ref=${encodeURIComponent(referer)}`;
      const response = await nativeGet({
        url: proxied,
        headers: { 'X-MV-Token': token },
        responseType: 'blob',
      });
      throwIfAborted(signal);
      const contentType = header(response.headers, 'content-type') || 'image/jpeg';
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, blob: base64ToBlob(response.data, contentType) };
      }
    } catch {
      /* 중계도 실패면 원래 실패를 보고한다 */
    }
  }

  if (direct) return direct;
  throw directError || new Error('이미지를 가져오지 못했습니다.');
}

/**
 * 이 컷을 어디서 받을지 고른다. 순수 함수 — 규칙을 테스트로 고정한다.
 *
 *   { kind: 'stored', url }  이미 손에 있는 주소를 그대로 쓴다 (서재 blob, 로컬 파일, 웹 경로)
 *   { kind: 'fetch',  url }  네이티브가 원본 호스트에서 바이트를 받아야 한다
 */
export function pickImageSource(page, { native }) {
  const stored = page?.url || '';

  /**
   * 호출자가 서재에서 꺼낸 blob 을 이미 끼워 넣었으면 그게 답이다.
   *
   * 여기서 originalUrl 을 보고 네트워크로 나가면(예전 동작) 담아둔 바이트를 버리고
   * 서명이 만료된 원본을 다시 받으려 한다. 앱을 껐다 켜면 WebView 캐시도 비어 있어
   * 담아둔 화 전체가 "이미지 실패 · 다시 시도" 로 떴다 — 서재가 아예 안 쓰였다.
   */
  if (/^(blob:|data:)/i.test(stored)) return { kind: 'stored', url: stored };

  const rawUrl = page?.originalUrl || stored;
  const isDirectHttp = !!rawUrl && /^https?:\/\//i.test(rawUrl) && !rawUrl.includes('/api/proxy-image');

  if (!native || !isDirectHttp || /^(blob:|data:)/i.test(rawUrl)) {
    return { kind: 'stored', url: stored || rawUrl };
  }
  return { kind: 'fetch', url: rawUrl };
}

/**
 * 네이티브가 바이트를 못 받았을 때 브라우저에게 직접 맡길 주소. 순수 함수 — 규칙을 테스트로 고정한다.
 *
 * 실측(2026-09-11 태블릿): `.json` 으로 끝나는 컷은 CapacitorHttp 로 절대 못 받는다. CDN 이
 * 확장자대로 content-type 을 붙이고(`application/json`), 안드로이드 브릿지가 그 본문을 이미
 * 텍스트로 디코딩해 넘긴다 — responseType 을 arraybuffer·blob·text 로 다 바꿔봤지만 세 번 모두
 * 똑같이 뭉개진 154629자 문자열이었다(JPEG 머리가 U+FFFD). 클라이언트에서 되돌릴 방법이 없고,
 * Worker 중계는 지금 이 기기의 토큰에 401 을 준다 — 그래서 `.json` 컷은 받을 길이 아예 없었다.
 *
 * 그런데 같은 주소를 WebView(origin https://localhost) 의 맨 `new Image()` 에 그대로 넣으면
 * 렌더된다 — 실측 600x1000. 브라우저는 바이트를 스니핑해 엉터리 content-type 을 무시하고,
 * 이 CDN 은 Referer 검사도 nosniff 도 없다. 즉 '표시'만 놓고 보면 네이티브 fetch·중계·토큰
 * 전부 없이 <img src> 하나로 끝난다.
 *
 * 한계: Referer 를 검사하는 이미지 호스트라면 이 직접 시도도 실패한다. 그래도 지금보다 나빠지진
 * 않는다 — 지금은 throw 때문에 <img> 에 src 조차 안 들어가서(실측 src === "", __retries === 0)
 * 엔진의 error 핸들러도 자체 재시도도 아예 돌지 않았다. src 가 들어가면 최소한 그게 돈다.
 */
export function directDisplayUrl(page) {
  const raw = page?.originalUrl || page?.url || '';
  // 절대 http(s) 만. 상대 경로(/api/...)는 앱에서 https://localhost 로 붙어 404 고,
  // blob:·data: 는 pickImageSource 가 이미 'stored' 로 걸러 여기 오지 않는다
  return /^https?:\/\//i.test(raw) ? raw : null;
}

/** ReaderEngine이 만든 URL만 ReaderEngine이 revoke한다. */
export async function resolvePageImageUrl(page) {
  const source = pickImageSource(page, { native: isNativeApp() });
  if (source.kind === 'stored') return { url: source.url, owned: false };

  let failure = null;
  try {
    const response = await fetchPageImage(page);
    if (response.ok && response.blob) {
      return { url: URL.createObjectURL(response.blob), owned: true };
    }
    // 502 만 보면 회선 문제인지 content-type 문제인지 구분이 안 된다 — 실패한 이유를 붙인다
    const why = response.reason ? ` — ${response.reason}` : '';
    failure = new Error(`원본 이미지 서버가 요청을 거부했습니다 (${response.status})${why}.`);
  } catch (err) {
    failure = err;
  }

  // 네이티브 경로가 진짜로 끝난 뒤에야 브라우저에게 원본 주소를 그대로 맡긴다.
  // owned:false 필수 — 객체 URL 이 아니니 엔진이 revoke 하면 안 된다.
  // (fetchPageImage 의 반환 계약은 그대로 둔다 — src/library.js 는 서재에 담을 '바이트' 가
  //  필요해서 직접 호출하니, 바이트가 없는 `.json` 컷은 거기서 계속 큰 소리로 실패해야 한다)
  const direct = directDisplayUrl(page);
  if (direct) return { url: direct, owned: false };
  throw failure;
}
