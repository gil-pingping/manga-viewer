import JSZip from 'jszip';

/**
 * 만화 이미지 수집기
 *
 * 들어오는 경로 네 가지:
 *   1. 북마클릿   브라우저에서 이미 열어둔 페이지의 이미지 목록을 로컬 뷰어로 넘긴다 (가장 확실)
 *   2. URL 입력   로컬 프록시로 페이지 HTML을 받아 <img> 를 훑는다
 *   3. 붙여넣기   이미지 주소 목록이나 HTML 소스를 그대로 붙인다
 *   4. 로컬 파일  CBZ / ZIP / 이미지 여러 장
 *
 * 어느 경로든 최종 산출물은 동일한 page 객체 배열이다.
 */

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i;

/** 광고·아이콘·UI 부품으로 보이는 주소는 본문 컷이 아니다 */
const JUNK_PATTERN =
  /logo|icon|banner|button|avatar|thumb|captcha|loading|spinner|notice|emoji|smil|sns|ad[_-]|advert|google|facebook|twitter|kakao|naver_|profile|blank\.|1x1|pixel|copyright|wordmark|poweredby|sprite|footer|header|\/static\//i;

export class UrlHarvester {
  /* ------------------------------------------------------------------ */
  /* 1. 북마클릿이 서버에 올려둔 수집 결과 받기                           */
  /* ------------------------------------------------------------------ */

  /**
   * 북마클릿은 이미지 목록을 POST 로 먼저 올리고 뷰어를 열기 때문에,
   * 뷰어가 조금 먼저 뜨는 경우가 있다. 그래서 잠깐 폴링한다.
   * (URL 해시로 넘기던 예전 방식은 챕터가 길면 주소 길이 제한에 걸려 잘렸다.)
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

  /** URL 해시(#import=...)로 직접 넘어온 페이로드도 계속 지원한다 */
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
      targetUrl: payload.sourceUrl || null,
      prevUrl: payload.prevUrl || null,
      nextUrl: payload.nextUrl || null,
      pages: toPages(urls, payload.sourceUrl),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 2. URL 입력 → 프록시로 HTML 받아 파싱                               */
  /* ------------------------------------------------------------------ */

  static async fetchFromUrl(targetUrl) {
    const parsedUrl = new URL(targetUrl);

    const res = await fetch(`/api/fetch-page?url=${encodeURIComponent(targetUrl)}`);

    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body.error) detail = body.error;
      } catch {
        /* JSON 아니면 상태 코드만 */
      }
      throw new Error(
        `페이지를 가져오지 못했습니다 (${detail}).\n\n` +
          `사이트가 서버 접근을 막는 경우가 많습니다. ` +
          `브라우저에서 그 페이지를 직접 연 다음 북마클릿으로 넘기면 확실합니다.`
      );
    }

    const html = await res.text();
    if (!html || html.length < 200) {
      throw new Error('페이지 내용이 비어 있습니다. 로그인이나 차단 페이지일 수 있습니다.');
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imageUrls = extractImageUrls(doc, parsedUrl.origin);

    if (imageUrls.length === 0) {
      throw new Error(
        '이 페이지에서 만화 이미지를 찾지 못했습니다.\n\n' +
          '이미지를 자바스크립트로 나중에 채우는 사이트입니다. ' +
          '브라우저에서 페이지를 끝까지 스크롤한 뒤 북마클릿을 눌러주세요.'
      );
    }

    return {
      title: cleanTitle(doc.title),
      targetUrl,
      prevUrl: findAdjacentLink(doc, /이전화|이전\s*화|prev/i, parsedUrl.origin),
      nextUrl: findAdjacentLink(doc, /다음화|다음\s*화|next/i, parsedUrl.origin),
      pages: toPages(imageUrls, targetUrl),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. 붙여넣기 (주소 목록 또는 HTML 소스)                              */
  /* ------------------------------------------------------------------ */

  static parseRawText(rawText) {
    const text = (rawText || '').trim();
    if (!text) return [];

    // HTML 소스를 붙인 경우엔 DOM 으로 파싱하는 편이 정확하다
    if (/<img|<html|<body|<div/i.test(text)) {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const fromDom = extractImageUrls(doc, '');
      if (fromDom.length > 0) return toPages(fromDom, null);
    }

    const urlPattern = /https?:\/\/[^\s"'<>\\)]+/gi;
    const found = Array.from(new Set(text.match(urlPattern) || []))
      .map((u) => u.replace(/[),.]+$/, ''))
      .filter((u) => IMAGE_EXT.test(u) || /\/(image|img|photo|file)s?\//i.test(u))
      .filter((u) => !JUNK_PATTERN.test(u));

    return toPages(found, null);
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

    return {
      title: file.name.replace(/\.(zip|cbz)$/i, ''),
      targetUrl: null,
      pages,
    };
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
    name: `Page ${i + 1}`,
  }));
}

function proxiedUrl(imgUrl, refererUrl) {
  let path = `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;
  if (refererUrl) path += `&ref=${encodeURIComponent(refererUrl)}`;
  return path;
}

/**
 * 문서에서 본문 만화 이미지를 순서대로 뽑는다.
 * 정규식 대신 DOMParser 를 쓰는 이유: 속성 순서·따옴표·줄바꿈에 안 깨진다.
 * (DOMParser 는 'text/html' 파싱 시 네트워크 요청을 일으키지 않는다.)
 */
function extractImageUrls(doc, origin) {
  const seen = new Set();
  const urls = [];

  const nodes = doc.querySelectorAll('img, source, [data-src], [data-original], [data-lazy-src]');

  for (const el of nodes) {
    const raw = pickBestSource(el);
    if (!raw) continue;

    const url = normalizeUrl(raw, origin);
    if (!url || seen.has(url)) continue;
    if (JUNK_PATTERN.test(url)) continue;
    if (looksTooSmall(el)) continue;

    seen.add(url);
    urls.push(url);
  }

  return keepDominantDirectory(urls);
}

/**
 * 한 화의 컷들은 거의 항상 같은 디렉터리에 연번으로 올라간다.
 * 그래서 "같은 디렉터리에서 가장 많이 나온 묶음"만 남기면
 * 페이지 곳곳의 배너·프로필·추천 썸네일이 한 번에 걸러진다.
 * 뚜렷한 다수 묶음이 없으면 손대지 않고 그대로 둔다.
 */
export function keepDominantDirectory(urls) {
  if (urls.length < 4) return urls;

  const groups = new Map();
  for (const url of urls) {
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(url);
  }

  if (groups.size < 2) return urls;

  let best = [];
  for (const list of groups.values()) {
    if (list.length > best.length) best = list;
  }

  // 최다 묶음이 3장 이상이고 전체의 절반은 되어야 본문으로 인정한다
  const isDominant = best.length >= 3 && best.length >= urls.length * 0.5;
  return isDominant ? best : urls;
}

/** lazy-load 사이트는 진짜 주소를 data-* 에 숨겨두고 src 에는 placeholder 를 넣는다 */
function pickBestSource(el) {
  const candidates = [
    el.getAttribute('data-original'),
    el.getAttribute('data-src'),
    el.getAttribute('data-lazy-src'),
    el.getAttribute('data-echo'),
    largestFromSrcset(el.getAttribute('srcset')),
    el.getAttribute('src'),
  ];

  for (const c of candidates) {
    if (!c) continue;
    const v = c.trim();
    if (!v || v.startsWith('data:')) continue;
    return v;
  }
  return null;
}

/** srcset="a.jpg 1x, b.jpg 2x" 중 가장 큰 것을 고른다 */
function largestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestWeight = -1;

  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const weight = descriptor ? parseFloat(descriptor) || 1 : 1;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = url;
    }
  }
  return best;
}

/** width/height 속성이 명시적으로 작으면 아이콘이다 */
function looksTooSmall(el) {
  const w = parseInt(el.getAttribute('width') || '0', 10);
  const h = parseInt(el.getAttribute('height') || '0', 10);
  if (w && w < 200) return true;
  if (h && h < 200) return true;
  return false;
}

function normalizeUrl(src, origin) {
  if (!src) return null;
  const url = src.replace(/\\\//g, '/').trim();

  if (url.startsWith('//')) return 'https:' + url;
  if (/^https?:\/\//i.test(url)) return url;
  if (!origin) return null; // 상대 경로인데 기준 오리진이 없으면 버린다
  if (url.startsWith('/')) return origin + url;
  return origin + '/' + url;
}

function findAdjacentLink(doc, pattern, origin) {
  for (const a of doc.querySelectorAll('a[href]')) {
    const text = (a.textContent || '').trim();
    const rel = a.getAttribute('rel') || '';
    if (pattern.test(text) || pattern.test(rel)) {
      const href = normalizeUrl(a.getAttribute('href'), origin);
      if (href) return href;
    }
  }
  return null;
}

function cleanTitle(rawTitle) {
  const title = (rawTitle || '').split(/[|\-–—>]/)[0].trim();
  return title || '웹 만화';
}
