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
 * 북마클릿은 이 함수도 문자열화해서 싣는다 → 모듈 밖 참조 금지.
 */

/** 이미지가 될 수 있는 노드를 훑는 선택자 */
export const IMAGE_NODE_SELECTOR = 'img, source, [data-src], [data-original], [data-lazy-src]';

/**
 * DOM 엘리먼트 하나를 서술자로 옮긴다.
 *
 * naturalWidth/offsetWidth 는 실제 브라우저에서만 값이 있다.
 * 파싱한 HTML 에서는 0 이므로 imageRules 가 width/height 속성으로 물러난다.
 */
export function toDescriptor(el) {
  return {
    tag: el.tagName,
    src: el.getAttribute('src'),
    dataSrc: el.getAttribute('data-src'),
    dataOriginal: el.getAttribute('data-original'),
    dataLazySrc: el.getAttribute('data-lazy-src'),
    dataEcho: el.getAttribute('data-echo'),
    srcset: el.getAttribute('srcset'),
    width: el.getAttribute('width'),
    height: el.getAttribute('height'),
    naturalWidth: el.naturalWidth || 0,
    naturalHeight: el.naturalHeight || 0,
    offsetWidth: el.offsetWidth || 0,
    offsetHeight: el.offsetHeight || 0,
  };
}

/** Document(또는 임의의 루트) → 서술자 배열. 문서 순서를 유지한다 */
export function collectDescriptors(root) {
  const nodes = root.querySelectorAll(IMAGE_NODE_SELECTOR);
  const out = [];
  for (let i = 0; i < nodes.length; i++) out.push(toDescriptor(nodes[i]));
  return out;
}
