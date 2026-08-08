/**
 * 이미지를 다시 로드할 때 고속으로 렌더링되도록 돕는 브라우저 메모리/이미지 캐시 매니저
 */

const preloadedUrls = new Set();
const maxPreloadCount = 100;

/** 단일 이미지 주소를 백그라운드로 사전 로딩 */
export function preloadImage(url) {
  if (!url || preloadedUrls.has(url)) return;

  if (preloadedUrls.size >= maxPreloadCount) {
    const firstKey = preloadedUrls.values().next().value;
    if (firstKey) preloadedUrls.delete(firstKey);
  }

  preloadedUrls.add(url);

  const img = new Image();
  img.src = url;
}

/** 챕터의 주요 이미지들(첫 3~5장)을 백그라운드로 사전 로딩 */
export function preloadChapterImages(chapter, limit = 5) {
  if (!chapter || !chapter.pages || !Array.isArray(chapter.pages)) return;

  const count = Math.min(limit, chapter.pages.length);
  for (let i = 0; i < count; i++) {
    const page = chapter.pages[i];
    if (page?.url) {
      preloadImage(page.url);
    }
  }
}
