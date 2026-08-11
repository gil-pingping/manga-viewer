import JSZip from 'jszip';
import {
  selectContentImages,
  explainSelection,
  NOT_IMAGE_EXT,
  JUNK_PATTERN,
} from './core/imageRules.js';
import { collectDescriptors, looksJsRendered, extractSeriesCover, findSeriesListUrl } from './collect/fromDocument.js';
import { fetchPageDocument, isNativeApp } from './platform/nativeHttp.js';
import { collectRenderedPage } from './platform/pageCollector.js';

/**
 * 만화 이미지 수집기
 *
 * 들어오는 경로 네 가지:
 *   1. 페이지 주소   서버가 HTML 을 받아 본문 컷을 찾는다 (주력)
 *   2. 북마클릿      브라우저에 이미 렌더된 화면에서 훑는다 (JS 로 채우는 사이트)
 *   3. 붙여넣기      이미지 주소 목록
 *   4. 로컬 파일     CBZ / ZIP / 이미지 여러 장
 *
 * 어느 경로든 산출물은 같은 page 객체 배열이고,
 * 본문 선별 판단은 전부 core/imageRules.js 한 곳에서 한다.
 */

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i;

export class UrlHarvester {
  /* ------------------------------------------------------------------ */
  /* 1. 북마클릿이 서버에 올려둔 수집 결과 받기                           */
  /* ------------------------------------------------------------------ */

  /**
   * 북마클릿은 목록을 먼저 올리고 뷰어를 열기 때문에 뷰어가 조금 먼저
   * 뜨는 경우가 있다. 그래서 잠깐 폴링한다.
   */
  static async fetchPendingImport({ attempts = 12, intervalMs = 400 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch('/api/import/latest', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.payload) return UrlHarvester.normalizeImportPayload(data.payload);
        }
      } catch {
        /* 서버가 아직 준비 안 됐으면 다음 시도 */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  /** URL 해시(#import=...)로 넘어온 페이로드 */
  static parseImportHash(hash) {
    const match = /[#&]import=([^&]+)/.exec(hash || '');
    if (!match) return null;
    if (match[1] === 'latest') return 'latest';
    try {
      return UrlHarvester.normalizeImportPayload(JSON.parse(decodeURIComponent(match[1])));
    } catch {
      return null;
    }
  }

  static normalizeImportPayload(payload) {
    const urls = (payload.pages || []).filter(
      (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
    );
    if (urls.length === 0) throw new Error('수집된 이미지가 없습니다.');

    return {
      title: payload.title || '수집한 만화',
      coverUrl: payload.coverUrl || null,
      targetUrl: payload.sourceUrl || null,
      prevUrl: payload.prevUrl || null,
      nextUrl: payload.nextUrl || null,
      pages: toPages(urls, payload.sourceUrl),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 2. 페이지 주소 하나 → 서버가 HTML 받아 본문 컷 추출                  */
  /* ------------------------------------------------------------------ */

  /**
   * 네이버 웹툰처럼 본문 이미지 주소가 HTML 에 그대로 실려 오는 사이트는
   * 주소 하나만 넣으면 끝난다. 북마클릿을 설치할 필요가 없다.
   */
  static async fetchFromUrl(
    targetUrl,
    { silentRenderedFallback = false } = {}
  ) {
    const parsedUrl = new URL(targetUrl);
    let res;
    try {
      res = await fetchPageDocument(targetUrl);
    } catch (err) {
      if (isNativeApp()) {
        return UrlHarvester.renderFromUrl(targetUrl, { silent: silentRenderedFallback });
      }
      throw err;
    }

    if (!res.ok) {
      // 데이터센터 차단·로그인 요구면 서버 흉내를 더 내지 않는다. 실제 WebView로 연다.
      if (isNativeApp() && [401, 403, 429].includes(res.status)) {
        return UrlHarvester.renderFromUrl(targetUrl, { silent: silentRenderedFallback });
      }
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body.error) detail = body.error;
      } catch {
        /* JSON 이 아니면 상태 코드만 */
      }
      throw new Error(`페이지를 가져오지 못했습니다 (${detail}).`);
    }

    const html = await res.text();
    if (!html || html.length < 200) {
      throw new Error('페이지 내용이 비어 있습니다. 로그인이 필요한 페이지일 수 있습니다.');
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');

    /**
     * 본문 컨테이너가 있는데 비어 있으면 컷은 브라우저가 나중에 채운다.
     * 이때 문서 전체로 물러나면 머리말·추천 썸네일이 본문으로 뽑혀
     * "3장 불러왔습니다" 처럼 엉뚱한 성공을 보고한다. 그게 더 나쁘다.
     */
    if (looksJsRendered(doc)) {
      // 서버가 실제 브라우저로 열어 렌더된 DOM 을 읽는다. 주소 하나로 끝난다.
      return await UrlHarvester.renderFromUrl(targetUrl, { silent: silentRenderedFallback });
    }

    // DOM → 서술자 → 규칙. 규칙 자체는 core 에만 있다
    const descriptors = collectDescriptors(doc);
    const imageUrls = selectContentImages(descriptors, targetUrl);

    // 정적 HTML 에 광고·placeholder 1~2장만 있고 실제 컷은 렌더 뒤 생기는 사이트가 있다.
    if (isNativeApp() && imageUrls.length < 3) {
      return UrlHarvester.renderFromUrl(targetUrl, { silent: silentRenderedFallback });
    }

    if (imageUrls.length === 0) {
      // 원인이 둘 다 가능하다: 그 화가 없거나 / 이미지를 JS 로 나중에 채우거나.
      // 어느 필터가 걸렀는지 진단을 실어 보낸다 — 개발자도구 없이 원인을 보게
      const err = new Error(
        '이미지를 찾지 못했습니다.\n' +
          '그 화가 아직 없거나, 이미지를 나중에 불러오는 사이트일 수 있습니다.'
      );
      err.diagnosis = explainSelection(descriptors, targetUrl);
      throw err;
    }

    let seriesCover = extractSeriesCover(doc, targetUrl);
    if (!seriesCover) {
      const listUrl = findSeriesListUrl(doc, targetUrl);
      if (listUrl) {
        try {
          const listRes = await fetchPageDocument(listUrl);
          if (listRes.ok) {
            const listHtml = await listRes.text();
            const listDoc = new DOMParser().parseFromString(listHtml, 'text/html');
            seriesCover = extractSeriesCover(listDoc, listUrl);
          }
        } catch (e) {
          console.warn('메인 목록 페이지 표지 추출 중 오류:', e);
        }
      }
    }

    return {
      title: cleanTitle(doc.title),
      coverUrl: seriesCover,
      targetUrl,
      prevUrl:
        findAdjacentLink(doc, /이전화|이전\s*화|prev/i, parsedUrl.origin, targetUrl) ||
        bumpEpisodeParam(targetUrl, -1),
      nextUrl:
        findAdjacentLink(doc, /다음화|다음\s*화|next/i, parsedUrl.origin, targetUrl) ||
        bumpEpisodeParam(targetUrl, +1),
      pages: toPages(imageUrls, targetUrl),
    };
  }

  /**
   * 서버가 헤드리스 브라우저로 페이지를 열어 렌더된 DOM 에서 컷을 읽는다.
   *
   * 이미지를 JS 로 채우는 사이트는 HTML 만 봐선 알 수 없다. fetchFromUrl 이
   * 그런 페이지를 감지하면 여기로 넘긴다 — 사용자는 주소만 넣으면 된다.
   *
   * 한계: 서버의 브라우저에는 사용자의 로그인 세션이 없다. 로그인이 필요한
   * 페이지는 여전히 북마클릿(사용자 브라우저)만 가능하다.
   */
  static async renderFromUrl(targetUrl, { silent = false } = {}) {
    let body = null;
    let res = null;

    if (isNativeApp()) {
      body = { ok: true, ...(await collectRenderedPage(targetUrl, { silent })) };
    } else {
      res = await fetch(`/api/render-page?url=${encodeURIComponent(targetUrl)}`);
      try {
        body = await res.json();
      } catch {
        throw new Error('헤드리스 렌더링 응답을 읽지 못했습니다.');
      }
    }

    if (!body.ok || (res && !res.ok)) {
      const reason = body && body.error ? body.error : `렌더링 실패 (${res?.status || 500})`;

      /**
       * 헤드리스가 아예 없는 환경이 둘 있다 — Cloudflare Worker 에는 브라우저가 없고,
       * 태블릿(Termux)에는 Chrome 을 못 깐다. "Chrome 을 설치하세요"는 그 환경에서
       * 할 수 없는 일이라 안내가 아니다. 그 자리에서 되는 길(북마클릿)을 알려준다.
       *
       * Worker 는 needsBookmarklet 을 명시해 준다. Node 서버는 문구로 판별한다.
       */
      if (body && body.needsBookmarklet) {
        // 서버가 이미 할 수 있는 일을 적어 보냈다. 그 문구를 그대로 쓴다
        const err = new Error(reason);
        err.needsBookmarklet = true;
        throw err;
      }

      if (/브라우저를 띄우지 못했습니다/.test(reason)) {
        const err = new Error(
          '이 사이트는 이미지를 나중에 불러오는데, 이 기기에서는 서버가 대신 열어볼 수 없습니다.\n' +
            '불러오기 창의 북마클릿을 쓰세요 — 브라우저에서 그 만화를 열고 북마클릿을 누르면 됩니다.'
        );
        err.needsBookmarklet = true;
        throw err;
      }

      throw new Error(reason);
    }

    if (!body.pages || body.pages.length === 0) {
      const err = new Error(
        '브라우저로 열어봤지만 이미지를 찾지 못했습니다.\n' +
          '로그인이 필요한 페이지라면 북마클릿을 쓰세요 (서버에는 로그인 세션이 없습니다).'
      );
      err.needsBookmarklet = true;
      throw err;
    }

    const sourceUrl = body.sourceUrl || targetUrl;
    return {
      title: body.title || '불러온 만화',
      coverUrl: body.coverUrl || null,
      targetUrl: sourceUrl,
      prevUrl: body.prevUrl || bumpEpisodeParam(sourceUrl, -1),
      nextUrl: body.nextUrl || bumpEpisodeParam(sourceUrl, +1),
      pages: toPages(body.pages, sourceUrl),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. 붙여넣기 (이미지 주소 목록)                                      */
  /* ------------------------------------------------------------------ */

  static parseRawText(rawText) {
    const text = (rawText || '').trim();
    if (!text) return [];

    const urlPattern = /https?:\/\/[^\s"'<>\\)]+/gi;
    const all = Array.from(new Set(text.match(urlPattern) || []))
      .map((u) => u.replace(/[),.]+$/, ''))
      .filter((u) => !JUNK_PATTERN.test(u))
      .filter((u) => !NOT_IMAGE_EXT.test(u));

    // 확장자나 이미지다운 경로가 있으면 그것만 고른다 (섞여 붙은 링크를 걸러낸다)
    const looksLikeImage = all.filter(
      (u) => IMAGE_EXT.test(u) || /\/(image|img|photo|file)s?\//i.test(u)
    );
    if (looksLikeImage.length > 0) return toPages(looksLikeImage, null);

    // 확장자 없이 서비스하는 CDN 도 흔하다 (예: /id/1011/900/1400).
    // 하나도 못 골랐으면 사용자가 이미지 목록을 붙였다고 믿고 웹페이지 주소만 뺀다.
    const notAPage = all.filter((u) => !/\.(html?|php|aspx?|jsp)(\?|#|$)/i.test(u));
    return toPages(notAPage, null);
  }

  /* ------------------------------------------------------------------ */
  /* 4. 로컬 파일                                                        */
  /* ------------------------------------------------------------------ */

  static async loadZipOrCbzFile(file) {
    const zip = new JSZip();
    const zipContent = await zip.loadAsync(file);

    const entries = Object.keys(zipContent.files)
      // macOS 압축이 끼워넣는 리소스 포크 제거
      .filter((name) => !name.startsWith('__MACOSX') && !name.split('/').pop().startsWith('.'))
      .filter((name) => !zipContent.files[name].dir && IMAGE_EXT.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (entries.length === 0) {
      throw new Error('압축 파일 안에서 이미지를 찾을 수 없습니다.');
    }

    const pages = [];
    for (let i = 0; i < entries.length; i++) {
      const blob = await zipContent.files[entries[i]].async('blob');
      pages.push({
        pageNumber: i + 1,
        url: URL.createObjectURL(blob),
        name: entries[i].split('/').pop(),
      });
    }

    return { title: file.name.replace(/\.(zip|cbz)$/i, ''), targetUrl: null, pages };
  }

  static async loadMultipleImageFiles(files) {
    const fileList = Array.from(files)
      .filter((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (fileList.length === 0) throw new Error('이미지 파일이 없습니다.');

    return {
      title: '불러온 이미지 모음',
      targetUrl: null,
      pages: fileList.map((file, i) => ({
        pageNumber: i + 1,
        url: URL.createObjectURL(file),
        name: file.name,
      })),
    };
  }
}

/* ==================================================================== */
/* 내부 헬퍼                                                             */
/* ==================================================================== */

/** 원본 주소를 프록시 경유 주소로 감싼 page 객체 배열로 만든다 */
function toPages(urls, refererUrl) {
  return urls.map((imgUrl, i) => ({
    pageNumber: i + 1,
    url: proxiedUrl(imgUrl, refererUrl),
    originalUrl: imgUrl,
    refererUrl,
    name: `Page ${i + 1}`,
  }));
}

/**
 * 이미지 호스트 상당수가 Referer 없는 요청이나 다른 오리진에서의 요청을
 * 거부하므로, 브라우저가 <img> 로 직접 못 불러온다. 서버가 중계해야 한다.
 */
function proxiedUrl(imgUrl, refererUrl) {
  let path = `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;
  if (refererUrl) path += `&ref=${encodeURIComponent(refererUrl)}`;
  return path;
}

/** 해시만 다른 자기 자신 링크(#none 등)는 이전/다음 화가 아니다 */
function findAdjacentLink(doc, pattern, origin, currentUrl) {
  const here = (currentUrl || '').split('#')[0];
  for (const a of doc.querySelectorAll('a[href]')) {
    const text = (a.textContent || '').trim();
    const rel = a.getAttribute('rel') || '';
    const title = a.getAttribute('title') || '';
    const aria = a.getAttribute('aria-label') || '';
    const cls = a.getAttribute('class') || '';

    let childMeta = '';
    for (const child of a.querySelectorAll('*')) {
      childMeta += ' ' + (child.getAttribute('title') || '') +
                   ' ' + (child.getAttribute('aria-label') || '') +
                   ' ' + (child.getAttribute('class') || '');
    }

    const targetStr = `${text} ${rel} ${title} ${aria} ${cls} ${childMeta}`;
    if (!pattern.test(targetStr)) continue;

    const raw = a.getAttribute('href');
    if (!raw) continue;
    let href = null;
    try {
      href = new URL(raw, currentUrl || origin).href;
    } catch {
      continue;
    }
    if (href.split('#')[0] === here) continue;
    return href;
  }
  return null;
}

function cleanTitle(rawTitle) {
  const title = (rawTitle || '').split(/[|>]/)[0].trim();
  return title || '불러온 만화';
}

/** 화 번호로 쓰이는 흔한 파라미터 이름. toon(시리즈ID)보다 num, ep 등 회차 파라미터를 우선 순위에 둔다 */
const EPISODE_PARAMS = ['num', 'ep', 'chapter', 'chap', 'no', 'n', 'episode', 'toon'];

/**
 * 사이트가 이전/다음 링크를 텍스트로 안 내주는 경우가 많다 (네이버 웹툰 확인).
 * 주소에 화 번호가 들어있으면 ±1 해서 인접 화 주소를 만든다.
 * 없는 화면 "이미지를 못 찾았다"로 걸러지므로 위험하지 않다.
 */
function bumpEpisodeParam(rawUrl, delta) {
  try {
    const url = new URL(rawUrl);
    for (const key of EPISODE_PARAMS) {
      const value = url.searchParams.get(key);
      if (value === null || !/^\d+$/.test(value)) continue;

      const next = parseInt(value, 10) + delta;
      if (next < 1) return null;

      url.searchParams.set(key, String(next));
      return url.href;
    }
  } catch {
    /* 주소가 이상하면 포기 */
  }
  return null;
}

export { bumpEpisodeParam, findAdjacentLink };
