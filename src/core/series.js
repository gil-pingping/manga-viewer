/**
 * 만화 시리즈 파싱 및 회차 정렬 유틸리티
 *
 * 다양한 제목 형태에서 시리즈명(작품명)과 회차 번호를 정밀 추출하고,
 * 작품별 그룹핑 및 자연어 순서 정렬(Natural Sorting)을 수행한다.
 *
 * 예: "원펀맨 215화" -> series: "원펀맨", epNum: 215
 *     "[원피스] 1080화 - 루피의 대모험" -> series: "원피스", epNum: 1080
 *     "나루토 1화" -> series: "나루토", epNum: 1
 */

/** 제목에서 회차 번호 및 시리즈 이름 파싱 */
export function parseSeriesAndEpisode(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return { seriesTitle: '기타 만화', episodeNum: 0, episodeLabel: '1화' };
  }

  let title = rawTitle.trim();

  // 대괄호나 특수표기 제거 전 백업
  const original = title;

  // 1. 대괄호/중괄호 앞뒤 정리: 예) "[원피스] 1080화" -> "원피스 1080화"
  title = title.replace(/^\[([^\]]+)\]\s*/, '$1 ');

  // 회차 번호 패턴 추출 (예: 215화, 215.5화, Ep.215, #215, 215화 - 제목 등)
  const epPatterns = [
    /(?:제\s*)?(\d+(?:\.\d+)?)\s*화/i,
    /(?:ep|episode|chap|chapter|\#)\s*(\d+(?:\.\d+)?)/i,
    /\b(\d+(?:\.\d+)?)\s*화\b/i,
    /\s+(\d+(?:\.\d+)?)$/i,
  ];

  let episodeNum = 0;
  let seriesTitle = original;

  for (const pattern of epPatterns) {
    const match = title.match(pattern);
    if (match) {
      episodeNum = parseFloat(match[1]);
      // 회차 패턴 앞부분을 시리즈 제목으로 취급
      const idx = match.index;
      let head = title.substring(0, idx).trim();
      // 특수문자 마감 정리 (예: "원피스 -" -> "원피스")
      head = head.replace(/[\s\-_:|]+$/, '').trim();
      if (head) {
        seriesTitle = head;
      }
      break;
    }
  }

  // 시리즈 제목이 비어있으면 original 사용
  if (!seriesTitle) seriesTitle = original;

  // 특수 기호 제거 및 이름 다듬기
  seriesTitle = cleanSeriesName(seriesTitle);

  const episodeLabel = episodeNum > 0 ? `${episodeNum}화` : original;

  return {
    seriesTitle,
    episodeNum,
    episodeLabel,
  };
}

/** 시리즈명 정규화 (괄호, 구획 문자 정리) */
export function cleanSeriesName(name) {
  return name
    .replace(/^\[.*?\]\s*/, '')
    .replace(/\s*\(.*?\)$/, '')
    .replace(/\s*[-|_|:].*$/, '')
    .trim() || '미분류 만화';
}

/** 챕터 목록을 시리즈(작품)별로 그룹핑 */
export function groupChaptersBySeries(chapters) {
  const groups = new Map();

  const filtered = (chapters || []).filter((c) => {
    if (!c) return false;
    if (c.isDemo) return false;
    if (c.id?.startsWith('demo-')) return false;
    if (c.title?.includes('DEMO') || c.title?.includes('세로 스크롤 웹툰') || c.title?.includes('페이지 넘김')) return false;
    return true;
  });

  for (const chapter of filtered) {
    const parsed = parseSeriesAndEpisode(chapter.title || '');
    const seriesKey = parsed.seriesTitle;

    if (!groups.has(seriesKey)) {
      groups.set(seriesKey, {
        seriesTitle: seriesKey,
        coverUrl: null,
        coverPage: null,
        chapters: [],
      });
    }

    const group = groups.get(seriesKey);
    const enhancedChapter = {
      ...chapter,
      parsedSeries: parsed.seriesTitle,
      parsedEpisodeNum: parsed.episodeNum,
      parsedEpisodeLabel: parsed.episodeLabel,
    };

    group.chapters.push(enhancedChapter);
  }

  // 각 그룹 내부의 챕터들을 회차순(1화, 2화, 3화...)으로 정렬
  const result = [];
  for (const group of groups.values()) {
    group.chapters.sort((a, b) => {
      if (a.parsedEpisodeNum !== b.parsedEpisodeNum && a.parsedEpisodeNum > 0 && b.parsedEpisodeNum > 0) {
        return a.parsedEpisodeNum - b.parsedEpisodeNum;
      }
      return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });
    });

    // 회차 정렬 완료 후: 가장 첫 챕터(예: 1화)의 coverUrl 또는 첫 페이지를 시리즈 고정 대표 표지로 결정!
    // 이렇게 하면 매화 수집을 해도 매화 표지로 바뀌지 않고 1화/작품목록 표지가 고정 유지된다!
    for (const chapter of group.chapters) {
      if (chapter.coverUrl || chapter.mangaCoverUrl) {
        const rawUrl = chapter.coverUrl || chapter.mangaCoverUrl;
        group.coverUrl = rawUrl;
        group.coverPage = {
          url: rawUrl,
          originalUrl: rawUrl,
          refererUrl: chapter.sourceUrl || '',
        };
        break; // 1화(가장 앞선 챕터)의 대표 표지를 찾았으므로 루프 탈출
      }
    }

    // 만약 coverUrl이 없으면 main.js가 sourceUrl에서 진짜 대표 표지 포스터를 수집할 수 있도록 준비한다
    if (!group.coverUrl && group.chapters.length > 0) {
      const firstWithSource = group.chapters.find((c) => c.sourceUrl);
      if (firstWithSource) {
        group.coverPage = {
          url: null,
          originalUrl: null,
          refererUrl: firstWithSource.sourceUrl,
        };
      }
    }

    result.push(group);
  }

  return result.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, undefined, { numeric: true, sensitivity: 'base' }));
}
