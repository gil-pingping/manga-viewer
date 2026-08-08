/**
 * 뷰어 동작 확인용 더미 페이지. 빈 컷 프레임만 그린다.
 *
 * 두 화를 남겨둔 이유는 리더의 두 갈래를 눈으로 확인할 표본이 필요해서다:
 *   1화 = 페이지 넘김 + 펼침 컷 짝짓기 / 2화 = 세로 스크롤 판정
 */

/** 크기에 맞춰 컷을 대충 나눠 그린 SVG 한 장 */
function page(width, height, label, pageNum) {
  const rows = height > width * 1.8 ? 4 : 3; // 세로로 길면 컷을 더 쌓는다
  const pad = Math.round(width * 0.06);
  const gap = Math.round(height * 0.02);
  const rowH = (height - pad * 2 - gap * (rows - 1)) / rows;

  let panels = '';
  for (let r = 0; r < rows; r++) {
    const y = pad + r * (rowH + gap);
    // 가운데 줄만 좌우로 쪼개 변화를 준다
    if (r === 1 && rows === 3) {
      const half = (width - pad * 2 - gap) / 2;
      panels += `<rect x="${pad}" y="${y}" width="${half}" height="${rowH}" rx="3"/>`;
      panels += `<rect x="${pad + half + gap}" y="${y}" width="${half}" height="${rowH}" rx="3"/>`;
    } else {
      panels += `<rect x="${pad}" y="${y}" width="${width - pad * 2}" height="${rowH}" rx="3"/>`;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#f7f7f5"/>
  <g fill="#ffffff" stroke="#14161a" stroke-width="5">${panels}</g>
  <g font-family="system-ui, sans-serif" fill="#9aa0a6" font-size="26">
    <text x="${pad}" y="${height - 12}">${label}</text>
    <text x="${width - pad}" y="${height - 12}" text-anchor="end">${pageNum}</text>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 8번이 가로로 넓은 펼침 컷 → 엔진이 단독 표시해야 한다 */
function pagedEpisode() {
  const label = 'DEMO · 페이지 넘김';
  const pages = Array.from({ length: 12 }, (_, i) => {
    const pageNumber = i + 1;
    const isSpread = pageNumber === 8;
    return {
      pageNumber,
      url: isSpread ? page(2000, 1414, label, pageNumber) : page(1000, 1414, label, pageNumber),
      isSpread,
    };
  });

  return { id: 'demo-paged', number: 1, title: '페이지 넘김 (펼침 컷 포함)', totalPages: 12, pages };
}

/** 세로로 긴 컷 → auto 모드가 strip 을 골라야 한다 */
function stripEpisode() {
  const label = 'DEMO · 세로 스크롤';
  const pages = Array.from({ length: 5 }, (_, i) => ({
    pageNumber: i + 1,
    url: page(800, 3200, label, i + 1),
    isSpread: false,
  }));

  return { id: 'demo-strip', number: 2, title: '세로 스크롤 웹툰', totalPages: 5, pages };
}

import { ONE_PIECE_COVER_DATA } from './sampleCoverData.js';

function onepieceEpisode() {
  const coverUrl = ONE_PIECE_COVER_DATA;
  const sourceUrl = 'https://newtoki1.org/manhwa/2/44358';
  return {
    id: 'sample-onepiece-909',
    number: 909,
    title: '원피스(ONE PIECE) 909화',
    label: '909화',
    coverUrl,
    sourceUrl,
    pages: [
      { pageNumber: 1, url: coverUrl, originalUrl: coverUrl, refererUrl: sourceUrl }
    ]
  };
}

export const SAMPLE_MANGA_SERIES = {
  title: '뷰어 동작 확인용 샘플',
  episodes: [onepieceEpisode(), pagedEpisode(), stripEpisode()],
};
