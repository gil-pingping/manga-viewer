/**
 * 뷰어 동작 확인용 더미 페이지.
 *
 * 실제 만화 대신 빈 컷 프레임만 그린다. 목적은 두 가지:
 *   - 네트워크 없이도 첫 화면에 뭔가 보이게 한다
 *   - 펼침 컷 짝짓기 / 세로 스크롤 판정을 눈으로 확인할 표본을 준다
 */

const PAGE_W = 1000;
const PAGE_H = 1414;

/** 세로 한 장 (일반 페이지) */
function portraitPage(label, pageNum) {
  return svgPage(
    PAGE_W,
    PAGE_H,
    label,
    pageNum,
    `
    <rect x="60" y="60" width="880" height="360" rx="3"/>
    <rect x="60" y="450" width="420" height="400" rx="3"/>
    <rect x="520" y="450" width="420" height="400" rx="3"/>
    <rect x="60" y="880" width="880" height="440" rx="3"/>
  `
  );
}

/** 가로로 넓은 펼침 컷 — 엔진이 spread 로 인식해야 한다 */
function spreadPage(label, pageNum) {
  return svgPage(
    PAGE_W * 2,
    PAGE_H,
    label,
    pageNum,
    `
    <rect x="60" y="60" width="1880" height="620" rx="3"/>
    <rect x="60" y="710" width="900" height="610" rx="3"/>
    <rect x="1000" y="710" width="940" height="610" rx="3"/>
  `
  );
}

/** 세로로 긴 웹툰 스트립 — 엔진이 strip 모드를 고르게 하는 표본 */
function stripPage(label, pageNum) {
  return svgPage(
    800,
    3200,
    label,
    pageNum,
    `
    <rect x="50" y="50" width="700" height="700" rx="3"/>
    <rect x="50" y="800" width="700" height="600" rx="3"/>
    <rect x="50" y="1450" width="700" height="800" rx="3"/>
    <rect x="50" y="2300" width="700" height="850" rx="3"/>
  `
  );
}

function svgPage(width, height, label, pageNum, panels) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#f7f7f5"/>
  <g fill="#ffffff" stroke="#14161a" stroke-width="5">${panels}</g>
  <g font-family="system-ui, sans-serif" fill="#9aa0a6" font-size="26">
    <text x="60" y="${height - 34}">${label}</text>
    <text x="${width - 60}" y="${height - 34}" text-anchor="end">${pageNum}</text>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 8번이 펼침 컷인 세로 만화 한 화 */
function pagedEpisode(id, number, title, prevId, nextId) {
  const total = 12;
  const label = `DEMO · ${title}`;

  const pages = Array.from({ length: total }, (_, i) => {
    const pageNumber = i + 1;
    const isSpread = pageNumber === 8;
    return {
      pageNumber,
      url: isSpread ? spreadPage(label, pageNumber) : portraitPage(label, pageNumber),
      isSpread,
    };
  });

  return {
    id,
    number,
    title,
    totalPages: total,
    prevEpisodeId: prevId,
    nextEpisodeId: nextId,
    pages,
  };
}

/** 세로 스크롤 웹툰 한 화 */
function stripEpisode(id, number, title, prevId, nextId) {
  const total = 5;
  const label = `DEMO · ${title}`;

  const pages = Array.from({ length: total }, (_, i) => ({
    pageNumber: i + 1,
    url: stripPage(label, i + 1),
    isSpread: false,
  }));

  return {
    id,
    number,
    title,
    totalPages: total,
    prevEpisodeId: prevId,
    nextEpisodeId: nextId,
    pages,
  };
}

export const SAMPLE_MANGA_SERIES = {
  title: '뷰어 동작 확인용 샘플',
  description: '8.4인치 태블릿 리더 테스트 페이지',
  episodes: [
    pagedEpisode('demo-paged-1', 1, '페이지 넘김 (펼침 컷 포함)', null, 'demo-paged-2'),
    pagedEpisode('demo-paged-2', 2, '페이지 넘김 2화', 'demo-paged-1', 'demo-strip-1'),
    stripEpisode('demo-strip-1', 3, '세로 스크롤 웹툰', 'demo-paged-2', null),
  ],
};
