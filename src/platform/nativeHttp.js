import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  FETCH_TIMEOUT_MS,
  assertFetchableUrl,
  imageRequestHeaders,
  pageRequestHeaders,
} from '../shared/proxyRules.js';

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

import { decodeHtmlBuffer } from '../shared/charsetDecoder.js';

function responseDataToBuffer(data) {
  if (typeof data === 'string') {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    return bytes.buffer;
  } else if (data instanceof ArrayBuffer) {
    return data;
  } else if (ArrayBuffer.isView(data)) {
    return data.buffer;
  }
  return new TextEncoder().encode(JSON.stringify(data || '')).buffer;
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
  const contentType = header(response.headers, 'content-type') || 'text/html';
  const buffer = responseDataToBuffer(response.data);
  const body = decodeHtmlBuffer(buffer, contentType);

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
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
