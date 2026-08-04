import JSZip from 'jszip';

/**
 * 만화 이미지 수집기
 *
 * 들어오는 경로 세 가지:
 *   1. 북마클릿   브라우저에서 이미 열어둔 페이지의 이미지 목록을 로컬 뷰어로 넘긴다 (주력)
 *   2. 붙여넣기   이미지 주소 목록을 그대로 붙인다
 *   3. 로컬 파일  CBZ / ZIP / 이미지 여러 장
 *
 * 어느 경로든 최종 산출물은 동일한 page 객체 배열이다.
 *
 * 서버가 페이지 HTML을 받아 <img> 를 훑는 경로는 없다. 이미지를 자바스크립트로
 * 나중에 채우는 사이트에서는 HTML에 주소가 아예 없어서 헛돌기만 했다.
 * 그 경우 브라우저에서 이미 렌더된 DOM을 읽는 북마클릿이 유일하게 통한다.
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
  /* 2. 페이지 주소 하나 → 서버가 HTML 받아 본문 컷 추출                  */
  /* ------------------------------------------------------------------ */

  /**
   * 네이버 웹툰처럼 본문 이미지 주소가 HTML 에 그대로 실려 오는 사이트는
   * 주소 하나만 넣으면 끝난다. 북마클릿을 설치할 필요가 없다.
   *
   * 이미지를 자바스크립트로 나중에 채우는 사이트는 여기서 아무것도 못 찾는다.
   * 그 경우에만 북마클릿을 쓴다.
   */
  static async fetchFromUrl(targetUrl) {
    const parsedUrl = new URL(targetUrl);
    const res = await fetch(`/api/fetch-page?url=${encodeURIComponent(targetUrl)}`);

    if (!res.ok) {
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
    const imageUrls = extractImageUrls(doc, parsedUrl.origin);

    if (imageUrls.length === 0) {
      // 원인이 둘 다 가능하다: 그 화가 없거나 / 이미지를 JS 로 나중에 채우거나.
      // 한쪽으로 단정하면 엉뚱한 데를 고치게 된다.
      throw new Error(
        '이미지를 찾지 못했습니다.\n' +
          '그 화가 아직 없거나, 이미지를 나중에 불러오는 사이트일 수 있습니다.'
      );
    }

    return {
      title: cleanTitle(doc.title),
      targetUrl,
      // 링크 텍스트로 못 찾으면 주소의 화 번호를 ±1 해본다
      prevUrl:
        findAdjacentLink(doc, /이전화|이전\s*화|prev/i, parsedUrl.origin, targetUrl) ||
        bumpEpisodeParam(targetUrl, -1),
      nextUrl:
        findAdjacentLink(doc, /다음화|다음\s*화|next/i, parsedUrl.origin, targetUrl) ||
        bumpEpisodeParam(targetUrl, +1),
      pages: toPages(imageUrls, targetUrl),
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
      .filter((u) => !JUNK_PATTERN.test(u));

    // 확장자나 이미지다운 경로가 있으면 그것만 고른다 (섞여 붙은 링크를 걸러낸다)
    const looksLikeImage = all.filter(
      (u) => IMAGE_EXT.test(u) || /\/(image|img|photo|file)s?\//i.test(u)
    );
    if (looksLikeImage.length > 0) return toPages(looksLikeImage, null);

    // 확장자 없이 서비스하는 CDN도 흔하다 (예: /id/1011/900/1400).
    // 하나도 못 골랐으면 사용자가 이미지 목록을 붙였다고 믿고, 웹페이지 주소만 뺀다.
    const notAPage = all.filter((u) => !/\.(html?|php|aspx?|jsp)(\?|#|$)/i.test(u));
    return toPages(notAPage, null);
  }

  /* ------------------------------------------------------------------ */
  /* 3. 로컬 파일                                                        */
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

/**
 * 이미지 호스트 상당수가 Referer 없는 요청이나 다른 오리진에서의 요청을
 * 거부하므로, 브라우저가 <img> 로 직접 못 불러온다. 서버가 중계해야 한다.
 */
function proxiedUrl(imgUrl, refererUrl) {
  let path = `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;
  if (refererUrl) path += `&ref=${encodeURIComponent(refererUrl)}`;
  return path;
}

/**
 * HTML 문서에서 본문 이미지를 문서 순서대로 뽑는다.
 * 정규식 대신 DOMParser 를 쓴다 — 속성 순서·따옴표·줄바꿈에 안 깨진다.
 * ('text/html' 파싱은 네트워크 요청을 일으키지 않는다)
 */
function extractImageUrls(doc, origin) {
  const seen = new Set();
  const urls = [];

  for (const el of doc.querySelectorAll('img, source, [data-src], [data-original], [data-lazy-src]')) {
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
 * 그 최다 묶음만 남기면 추천 썸네일·프로모가 한 번에 걸러진다.
 * 뚜렷한 다수가 없으면 손대지 않는다.
 */
function keepDominantDirectory(urls) {
  if (urls.length < 4) return urls;

  const groups = new Map();
  for (const url of urls) {
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(url);
  }
  if (groups.size < 2) return urls;

  let best = [];
  for (const list of groups.values()) if (list.length > best.length) best = list;

  return best.length >= 3 && best.length >= urls.length * 0.5 ? best : urls;
}

/** lazy-load 사이트는 진짜 주소를 data-* 에 숨기고 src 에는 placeholder 를 넣는다 */
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

/** srcset="a.jpg 1x, b.jpg 2x" 중 가장 큰 것 */
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

/**
 * HTML 만 봐서는 실제 크기를 모른다. width/height 속성이 명시적으로
 * 작을 때만 걸러낸다. 짧은 변 기준은 렌더 크기를 아는 북마클릿 쪽에서 쓴다.
 */
function looksTooSmall(el) {
  const w = parseInt(el.getAttribute('width') || '0', 10);
  const h = parseInt(el.getAttribute('height') || '0', 10);
  return (w > 0 && w < 180) || (h > 0 && h < 180);
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

/** 해시만 다른 자기 자신 링크(#none 등)는 이전/다음 화가 아니다 */
function findAdjacentLink(doc, pattern, origin, currentUrl) {
  const here = (currentUrl || '').split('#')[0];
  for (const a of doc.querySelectorAll('a[href]')) {
    const text = (a.textContent || '').trim();
    const rel = a.getAttribute('rel') || '';
    if (!pattern.test(text) && !pattern.test(rel)) continue;
    const href = normalizeUrl(a.getAttribute('href'), origin);
    if (!href || href.split('#')[0] === here) continue;
    return href;
  }
  return null;
}

function cleanTitle(rawTitle) {
  const title = (rawTitle || '').split(/[|>]/)[0].trim();
  return title || '불러온 만화';
}

/** 화 번호로 쓰이는 흔한 파라미터 이름. titleId 같은 건 절대 건드리지 않는다 */
const EPISODE_PARAMS = ['no', 'episode', 'ep', 'chapter', 'chap', 'toon'];

/**
 * 사이트가 이전/다음 링크를 텍스트로 안 내주는 경우가 많다 (네이버 웹툰 확인).
 * 주소에 화 번호가 들어있으면 그걸 ±1 해서 인접 화 주소를 만든다.
 * 없는 화면 그때 가서 "이미지를 못 찾았다"로 걸러지므로 위험하지 않다.
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
