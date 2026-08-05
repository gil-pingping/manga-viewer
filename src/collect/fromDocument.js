/**
 * DOM → 이미지 서술자 → core/imageRules
 *
 * 여기가 DOM 을 아는 유일한 수집 코드다. 규칙 판단은 하지 않고
 * 엘리먼트를 서술자로 옮기는 것만 한다. 덕분에 규칙은 imageRules 한 곳에만 있다.
 *
 * 두 곳에서 쓴다:
 *  - 서버가 받아온 HTML 을 DOMParser 로 파싱한 Document (urlHarvester)
 *  - 브라우저에 이미 렌더된 실제 document (북마클릿)
 *
 * 북마클릿은 이 함수들도 문자열화해서 싣는다 → 모듈 밖 참조 금지.
 */

/** 이미지가 될 수 있는 노드 */
export const IMAGE_NODE_SELECTOR = 'img, source, [data-src], [data-original], [data-lazy-src]';

/**
 * 본문 컨테이너 후보.
 *
 * 많은 뷰어가 컷을 전용 컨테이너에 담고 그 밖은 머리말·내비·추천으로 채운다.
 * 컨테이너를 찾아내면 파일명·크기 추측이 아예 필요 없다 — 그 안이 본문이다.
 * 앞쪽이 더 구체적인 선택자다.
 */
export const CONTENT_ROOT_SELECTORS = [
  '[data-theme-viewer-images]',
  '.theme-viewer-images',
  '#comic_view_area',
  '.wt_viewer',
  '#readerarea',
  '.reading-content',
  '.chapter-content',
  '.entry-content',
  '.view-content',
  '.viewer-images',
  '[class*="viewer-image"]',
  '[class*="viewer_image"]',
  '[id*="viewer"]',
  '[class*="viewer"]',
  'article',
  'main',
];

/**
 * "이건 본문 컨테이너다"라고 거의 확실히 말해주는 선택자들.
 *
 * CONTENT_ROOT_SELECTORS 의 앞부분과 같지만 `article`·`main`·`[class*="viewer"]`
 * 같은 광범위한 것은 뺐다. 이 목록에 걸리는 컨테이너가 **비어 있으면**
 * 페이지가 JS 로 컷을 채운다는 뜻이다.
 */
export const SPECIFIC_CONTENT_SELECTORS = [
  '[data-theme-viewer-images]',
  '.theme-viewer-images',
  '#comic_view_area',
  '.wt_viewer',
  '#readerarea',
  '.reading-content',
  '.chapter-content',
  '.viewer-images',
];

/**
 * 서버가 받은 HTML 이 JS 렌더링 뷰어인지 판단한다.
 *
 * 왜 필요한가: 본문 컨테이너가 HTML 에 있는데 그 안이 비어 있으면 컷은
 * 브라우저가 나중에 채운다. 이때 문서 전체로 물러나면 머리말·추천 썸네일이
 * 본문으로 뽑혀 엉뚱한 이미지 몇 장을 성공이라고 보고한다.
 * 실측: 추천 3장이 "같은 파일명 모양"이라 본문으로 선택됐다.
 *
 * 실패로 처리하고 북마클릿을 안내하는 편이 정직하다.
 */
export function looksJsRendered(root) {
  for (let i = 0; i < SPECIFIC_CONTENT_SELECTORS.length; i++) {
    let nodes;
    try {
      nodes = root.querySelectorAll(SPECIFIC_CONTENT_SELECTORS[i]);
    } catch (e) {
      continue;
    }
    for (let j = 0; j < nodes.length; j++) {
      // 확실한 본문 컨테이너를 찾았다 → 그 안이 비면 JS 가 채우는 것이다
      if (countImageish(nodes[j]) < 3) return true;
    }
  }
  return false;
}

/** 사이트가 순서를 직접 알려주는 속성들 */
export const PAGE_INDEX_ATTRS = ['data-theme-page', 'data-page', 'data-index', 'data-idx', 'data-no'];

/** inline style 의 background-image 주소를 뽑는다 */
export function backgroundImageUrl(styleText) {
  if (!styleText) return null;
  const m = /background(?:-image)?\s*:\s*[^;]*url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(styleText);
  return m ? m[2].trim() : null;
}

/** 컨테이너 안의 "이미지다운" 자손 수 */
export function countImageish(el) {
  let n = el.querySelectorAll(IMAGE_NODE_SELECTOR).length;
  if (n > 0) return n;

  // <img> 가 없고 배경 이미지로 그리는 뷰어도 있다
  const styled = el.querySelectorAll('[style]');
  for (let i = 0; i < styled.length; i++) {
    if (backgroundImageUrl(styled[i].getAttribute('style'))) n++;
  }
  return n;
}

/**
 * 본문 컨테이너를 찾는다.
 *
 * 후보 중 이미지가 가장 많이 들어있는 것을 고른다. 선택자만 믿으면
 * `article`·`main` 처럼 넓은 것이 잡혀 잡동사니가 섞인다.
 * 3장 미만이면 컨테이너로 인정하지 않고 null (문서 전체를 훑는다).
 */
export function findContentRoot(root) {
  let best = null;
  let bestCount = 0;

  for (let i = 0; i < CONTENT_ROOT_SELECTORS.length; i++) {
    let nodes;
    try {
      nodes = root.querySelectorAll(CONTENT_ROOT_SELECTORS[i]);
    } catch (e) {
      continue; // 지원 안 되는 선택자는 넘어간다
    }

    for (let j = 0; j < nodes.length; j++) {
      const count = countImageish(nodes[j]);
      // 같은 수면 먼저 나온(더 구체적인) 선택자를 유지한다
      if (count > bestCount) {
        bestCount = count;
        best = nodes[j];
      }
    }
    // 구체적인 선택자에서 충분히 찾았으면 더 넓은 후보는 보지 않는다
    if (bestCount >= 3) break;
  }

  return bestCount >= 3 ? best : null;
}

/** 조상 중 페이지 번호를 들고 있는 것을 찾는다 (최대 4단계) */
export function inheritedPageIndex(el, stopAt) {
  let node = el.parentElement;
  let depth = 0;
  while (node && node !== stopAt && depth < 4) {
    for (let i = 0; i < PAGE_INDEX_ATTRS.length; i++) {
      const raw = node.getAttribute && node.getAttribute(PAGE_INDEX_ATTRS[i]);
      if (raw !== null && raw !== undefined && /^\d+$/.test(String(raw).trim())) {
        return parseInt(String(raw).trim(), 10);
      }
    }
    node = node.parentElement;
    depth++;
  }
  return null;
}

/**
 * DOM 엘리먼트 하나를 서술자로 옮긴다.
 *
 * naturalWidth/offsetWidth 는 실제 브라우저에서만 값이 있다.
 * 파싱한 HTML 에서는 0 이므로 imageRules 가 width/height 속성으로 물러난다.
 */
export function toDescriptor(el) {
  let pageIndex = null;
  for (let i = 0; i < PAGE_INDEX_ATTRS.length; i++) {
    const raw = el.getAttribute(PAGE_INDEX_ATTRS[i]);
    if (raw !== null && /^\d+$/.test(String(raw).trim())) {
      pageIndex = parseInt(String(raw).trim(), 10);
      break;
    }
  }

  return {
    tag: el.tagName,
    src: el.getAttribute('src'),
    dataSrc: el.getAttribute('data-src'),
    dataOriginal: el.getAttribute('data-original'),
    dataLazySrc: el.getAttribute('data-lazy-src'),
    dataEcho: el.getAttribute('data-echo'),
    srcset: el.getAttribute('srcset'),
    bgImage: backgroundImageUrl(el.getAttribute('style')),
    width: el.getAttribute('width'),
    height: el.getAttribute('height'),
    naturalWidth: el.naturalWidth || 0,
    naturalHeight: el.naturalHeight || 0,
    offsetWidth: el.offsetWidth || 0,
    offsetHeight: el.offsetHeight || 0,
    pageIndex,
  };
}

/**
 * Document(또는 루트) → 서술자 배열. 문서 순서를 유지한다.
 *
 * 본문 컨테이너가 있으면 그 안만 훑는다. 없으면 문서 전체를 훑고
 * imageRules 의 3단 규칙(연번·파일명 모양·디렉터리)이 걸러낸다.
 */
export function collectDescriptors(root) {
  const scope = findContentRoot(root) || root;

  // 이미지 노드 + 배경 이미지를 가진 노드
  const seen = [];
  const push = (el) => {
    if (seen.indexOf(el) === -1) seen.push(el);
  };

  const imgs = scope.querySelectorAll(IMAGE_NODE_SELECTOR);
  for (let i = 0; i < imgs.length; i++) push(imgs[i]);

  const styled = scope.querySelectorAll('[style]');
  for (let i = 0; i < styled.length; i++) {
    if (backgroundImageUrl(styled[i].getAttribute('style'))) push(styled[i]);
  }

  const out = [];
  for (let i = 0; i < seen.length; i++) {
    const d = toDescriptor(seen[i]);
    // 자기 자신에 페이지 번호가 없으면 조상에서 물려받는다
    // (theme-viewer-image[data-theme-page] > img 구조)
    if (d.pageIndex === null) d.pageIndex = inheritedPageIndex(seen[i], scope);
    out.push(d);
  }
  return out;
}
