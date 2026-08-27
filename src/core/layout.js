/**
 * 화면 배치 판정 — 순수 함수.
 *
 * 왜 뽑아냈나: 이 판단들이 엔진 메서드 안에서 `this` 를 읽고 있었다.
 * 그래서 브라우저를 띄워야만 확인할 수 있었고, 실제로 여기 살던 버그 세 개를
 * 찾느라 브라우저를 스무 번 넘게 열었다:
 *
 *   1. 펼침 컷 바로 다음 페이지에 착지하면 펼침이 옆에 붙었다
 *      (짝 후보 중 뒤쪽만 검사했다)
 *   2. 한 장만 띄웠는데 두 장씩 넘겨서 중간 페이지가 조용히 사라졌다
 *   3. 웹툰인데 페이지 넘김으로 떴다 (모드 판정)
 *
 * 이제 다 순수 함수라 픽스처로 검증된다.
 */

/** 폭이 높이보다 이만큼 크면 펼침(양면) 컷 */
export const SPREAD_RATIO = 1.15;

/** 높이가 폭보다 이만큼 크면 세로 스크롤 웹툰 */
export const STRIP_RATIO = 1.8;

/** 두 장 펼침을 쓸 최소 가로폭 (8.4인치 기준) */
export const DOUBLE_MIN_WIDTH = 900;

/**
 * 주소만 봐도 웹툰인 출처 표식.
 *
 * 컷 비율로는 못 가른다 — 뉴토키 실측: 웹툰 한 화를 600x900(3:4) 조각으로
 * 잘라 서빙해서 h/w 가 1.5, STRIP_RATIO(1.8)에 못 미쳐 페이지 넘김으로 떴다.
 * 만화 스캔본도 비슷한 비율이라 비율 기준을 낮추면 반대로 오판한다.
 * 출처 주소의 /webtoon/ 같은 표식이 비율보다 먼저다.
 */
export const WEBTOON_URL_HINT = /\/webtoon|webtoons\.com|\/manhwa/i;

/** 이미지 실측 비율로 펼침 컷인지 판단한다 */
export function isSpreadRatio(width, height) {
  if (!width || !height) return false;
  return width / height >= SPREAD_RATIO;
}

/**
 * 실제로 쓸 모드를 정한다.
 *
 * mode 가 'auto' 가 아니면 사용자 선택을 그대로 따른다.
 * auto 면 출처 주소를 먼저 본다 — /webtoon/ 이면 컷 비율과 무관하게 웹툰이다.
 * 다음으로 측정된 이미지 비율 — 세로로 길면 웹툰이므로 연속 스크롤.
 * 비율 정보가 없으면 화면 크기로 정한다. 8.4인치에서 두 장 펼침은
 * 가로로 충분히 넓을 때만 읽을 만하다.
 */
export function resolveMode({ mode, ratios = [], viewportWidth, viewportHeight, sourceUrl }) {
  if (mode && mode !== 'auto') return mode;

  if (sourceUrl && WEBTOON_URL_HINT.test(sourceUrl)) return 'strip';

  if (ratios.length > 0) {
    const tall = ratios.filter((r) => r.w > 0 && r.h / r.w >= STRIP_RATIO).length;
    if (tall / ratios.length >= 0.5) return 'strip';
  }

  const wideEnough =
    viewportWidth >= DOUBLE_MIN_WIDTH && viewportHeight > 0 && viewportWidth / viewportHeight > 1.1;
  return wideEnough ? 'double' : 'single';
}

/**
 * 지금 화면에 놓을 페이지들.
 *
 * 두 장 펼침에서 첫 장은 홀로 둔다(표지). 그래야 이후 짝이 원본과 맞게 떨어진다.
 * 펼침 컷은 절대 다른 페이지와 나란히 놓지 않는다 — 짝 후보 어느 쪽이든
 * 펼침이면 지금 페이지를 홀로 띄운다. 뒤쪽만 검사하면 펼침 바로 다음 장에
 * 착지할 때 펼침이 옆에 붙는다.
 *
 * 반환 순서가 곧 DOM 순서다. RTL(일본 만화)은 오른쪽이 먼저이므로 뒤집는다.
 */
export function resolveVisiblePages({ pages, index, mode, direction }) {
  const current = pages[index];
  if (!current) return [];

  const alone = [{ page: current, index }];

  if (mode !== 'double') return alone;
  if (current.isSpread || index === 0) return alone;

  const firstOfPair = index % 2 === 1 ? index : index - 1;
  const a = pages[firstOfPair];
  const b = pages[firstOfPair + 1];
  if (!a || !b) return alone;
  if (a.isSpread || b.isSpread) return alone;

  const pair = [
    { page: a, index: firstOfPair },
    { page: b, index: firstOfPair + 1 },
  ];
  return direction === 'RTL' ? pair.reverse() : pair;
}

/**
 * 넘김 단위.
 *
 * 방금 실제로 띄운 장수와 같아야 한다. 한 장만 띄웠는데 두 장씩 넘기면
 * 중간 페이지가 조용히 건너뛰어진다. 그래서 visibleCount 를 받는다.
 */
export function pageStep({ mode, visibleCount }) {
  if (mode !== 'double') return 1;
  return visibleCount > 0 ? visibleCount : 1;
}

/**
 * 다음 페이지 인덱스. 끝에 닿으면 null.
 * 엔진은 null 을 받으면 "화 끝" 처리를 한다.
 */
export function nextIndex({ pages, index, mode, visibleCount }) {
  const step = pageStep({ mode, visibleCount });
  const target = index + step;
  return target < pages.length ? target : null;
}

/** 이전 페이지 인덱스. 처음이면 null */
export function prevIndex({ index, mode, visibleCount }) {
  if (index <= 0) return null;
  const step = pageStep({ mode, visibleCount });
  return Math.max(0, index - step);
}
