/**
 * 만화 링크 정리 및 도메인 업데이트 유틸리티
 *
 * 만화 사이트의 도메인이 변경되거나 URL 주소 구조가 달라진 경우,
 * 기존에 저장되거나 수집된 챕터들의 sourceUrl, prevUrl, nextUrl 등을 일괄 업데이트한다.
 */

/** 챕터 목록 내의 도메인/주소 변경 일괄 치환 */
export function updateChapterDomain(chapters, oldDomainPattern, newDomain) {
  if (!chapters || !Array.isArray(chapters)) return chapters;

  const replaceUrl = (url) => {
    if (!url || typeof url !== 'string') return url;
    try {
      if (typeof oldDomainPattern === 'string') {
        return url.replace(oldDomainPattern, newDomain);
      } else if (oldDomainPattern instanceof RegExp) {
        return url.replace(oldDomainPattern, newDomain);
      }
    } catch {
      /* 무시 */
    }
    return url;
  };

  return chapters.map((chapter) => ({
    ...chapter,
    sourceUrl: replaceUrl(chapter.sourceUrl),
    prevUrl: replaceUrl(chapter.prevUrl),
    nextUrl: replaceUrl(chapter.nextUrl),
    pages: (chapter.pages || []).map((page) => ({
      ...page,
      url: replaceUrl(page.url),
      originalUrl: replaceUrl(page.originalUrl),
      refererUrl: replaceUrl(page.refererUrl),
    })),
  }));
}

/** 깨지거나 무효한 챕터 정리 (페이지가 없거나 유효하지 않은 항목) */
export function cleanInvalidChapters(chapters) {
  if (!chapters || !Array.isArray(chapters)) return [];
  return chapters.filter((c) => c && c.id && (c.pages?.length > 0 || c.isDemo));
}
