import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  FETCH_TIMEOUT_MS,
  assertFetchableUrl,
  imageRequestHeaders,
  pageRequestHeaders,
} from '../shared/proxyRules.js';
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

async function nativeGet(options) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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

/** 웹은 기존 Worker, APK는 태블릿 네트워크로 대상 HTML을 직접 받는다. */
export async function fetchPageDocument(targetUrl) {
  if (!isNativeApp()) {
    return fetch(`/api/fetch-page?url=${encodeURIComponent(targetUrl)}`);
  }

  const target = assertFetchableUrl(targetUrl, false);
  const response = await nativeGet({
    url: target.href,
    headers: { ...pageRequestHeaders(target.origin + '/'), 'User-Agent': navigator.userAgent },
    responseType: 'text',
  });
  const status = response.status >= 200 && response.status <= 599 ? response.status : 502;
  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  return new Response(body, {
    status,
    headers: { 'Content-Type': header(response.headers, 'content-type') || 'text/html' },
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
  const response = await nativeGet({
    url: target.href,
    headers: {
      ...imageRequestHeaders(referer, 'https://newtoki1.org/'),
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    },
    responseType: 'blob',
  });
  throwIfAborted(signal);

  const contentType = header(response.headers, 'content-type') || 'application/octet-stream';
  const gotHtml = contentType.includes('text/html');
  const ok = response.status >= 200 && response.status < 300 && !gotHtml;
  return {
    ok,
    status: gotHtml ? 502 : response.status || 502,
    blob: ok ? base64ToBlob(response.data, contentType) : null,
  };
}

/** ReaderEngine이 만든 URL만 ReaderEngine이 revoke한다. */
export async function resolvePageImageUrl(page) {
  const rawUrl = page?.originalUrl || page?.url;
  const isDirectHttp = rawUrl && /^https?:\/\//i.test(rawUrl) && !rawUrl.includes('/api/proxy-image');

  if (!isNativeApp() || !isDirectHttp || /^(blob:|data:)/.test(rawUrl || '')) {
    return { url: page?.url || rawUrl, owned: false };
  }
  const response = await fetchPageImage(page);
  if (!response.ok || !response.blob) {
    throw new Error(`원본 이미지 서버가 요청을 거부했습니다 (${response.status}).`);
  }
  return { url: URL.createObjectURL(response.blob), owned: true };
}
