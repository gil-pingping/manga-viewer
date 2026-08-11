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

/** 사이트 브랜딩 명칭 및 불필요 태그 제거용 정규식 */
const SITE_BRANDING = /\s*[-|_|:|\||>]*\s*(?:늑대닷컴|wfwf\d*|뉴토끼|마나토끼|moatokki|모아토끼|망가쇼미|툰코|일루미|넷코믹스|애니라이프)\s*$/i;
const PRE_BRANDING = /^\s*\[?(?:늑대닷컴|wfwf\d*|뉴토끼|마나토끼|moatokki|모아토끼|망가쇼미|툰코|일루미|넷코믹스|애니라이프|웹툰|만화|고화질)\]?\s*/i;

/** sourceUrl 에서 회차 파라미터를 삭제하고 시리즈 대표 URL 키를 뽑는다 */
export function getSeriesUrlKey(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    const EPISODE_PARAM_NAMES = ['num', 'no', 'episode', 'ep', 'chapter', 'chap', 'n'];
    for (const key of EPISODE_PARAM_NAMES) {
      url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/\d+\/?$/, '/');
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** 깨진 문자열 및 인코딩 노이즈 감지 정규식 */
const BROKEN_CHARS = /[\uFFFD\u00C6\u00E6\u00F5\u25C6]|[\uFFFD◆]{2,}/;

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 챕터에서 회차 목차 표기용 라벨을 100% 깔끔하게 보장 생성하는 함수 */
export function formatEpisodeDisplayLabel(chapter, index = 0) {
  if (!chapter) return `${index + 1}화`;

  const parsed = parseSeriesAndEpisode(chapter.title || '');
  const epNum = chapter.parsedEpisodeNum || parsed.episodeNum;

  if (epNum > 0) {
    return `${epNum}화`;
  }

  let text = (chapter.parsedEpisodeLabel || chapter.title || '').trim();
  text = text.replace(BROKEN_CHARS, '').trim();
  text = text.replace(PRE_BRANDING, '').replace(SITE_BRANDING, '').trim();
  text = text.replace(/^(회차|episode|ep|chapter|chap)$/i, '').trim();

  if (parsed.seriesTitle) {
    text = text.replace(new RegExp(`^${escapeRegExp(parsed.seriesTitle)}\\s*`, 'i'), '').trim();
  }

  if (!text || text === '회차' || text === '미분류' || BROKEN_CHARS.test(text)) {
    return `${index + 1}화`;
  }

  return text;
}

/** 제목에서 회차 번호 및 시리즈 이름 파싱 */
export function parseSeriesAndEpisode(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return { seriesTitle: '기타 만화', episodeNum: 0, episodeLabel: '1화' };
  }

  let title = rawTitle.trim();
  const original = title;

  // 사이트 브랜딩 접두사 제거
  title = title.replace(PRE_BRANDING, '');
  title = title.replace(SITE_BRANDING, '');
  title = title.replace(/^\[([^\]]+)\]\s*/, '$1 ');

  // 1차: 명시적 회차 패턴
  const explicitPatterns = [
    /(?:제\s*)?(\d+(?:\.\d+)?)\s*(?:화|회|개|화차|강)/i,
    /(?:ep|episode|chap|chapter|\#)\s*(\d+(?:\.\d+)?)/i,
    /\b(\d+(?:\.\d+)?)\s*(?:화|회|개|화차|강)\b/i,
  ];

  let episodeNum = 0;
  let seriesTitle = '';

  for (const pattern of explicitPatterns) {
    const match = title.match(pattern);
    if (match) {
      episodeNum = parseFloat(match[1]);
      const idx = match.index;
      let head = title.substring(0, idx).trim();
      head = head.replace(/[\s\-_:||>]+$/, '').trim();
      if (head) seriesTitle = head;
      break;
    }
  }

  // 2차: 회차 번호를 못 찾은 경우 전체 문자열에서 숫자 전수 검색 (노이즈/깨진 텍스트 대응)
  if (episodeNum === 0) {
    const numMatches = Array.from(original.matchAll(/(\d+(?:\.\d+)?)/g));
    for (const m of numMatches) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 5000 && !(val >= 1990 && val <= 2035)) {
        episodeNum = val;
        if (!seriesTitle) {
          let head = original.substring(0, m.index).trim();
          head = head.replace(/[\s\-_:||>]+$/, '').trim();
          if (head) seriesTitle = head;
        }
        break;
      }
    }
  }

  if (!seriesTitle || BROKEN_CHARS.test(seriesTitle)) {
    seriesTitle = cleanSeriesName(seriesTitle || original);
  } else {
    seriesTitle = cleanSeriesName(seriesTitle);
  }

  // 3차: 회차 목차 표기용 라벨 - 회차 번호가 있으면 무조건 "${episodeNum}화"
  let episodeLabel = '';
  if (episodeNum > 0) {
    episodeLabel = `${episodeNum}화`;
  } else {
    const cleanedOriginal = original.replace(BROKEN_CHARS, '').trim();
    episodeLabel = cleanedOriginal && cleanedOriginal !== '회차' ? cleanedOriginal : '1화';
  }

  return {
    seriesTitle,
    episodeNum,
    episodeLabel,
  };
}

/** 시리즈명 정규화 (괄호, 브랜딩, 구획 문자 정리 및 깨진 문자 복구) */
export function cleanSeriesName(name) {
  if (!name || typeof name !== 'string') return '미분류 만화';
  let cleaned = name.trim();

  cleaned = cleaned.replace(PRE_BRANDING, '');
  cleaned = cleaned.replace(SITE_BRANDING, '');

  // 괄호 안에 유효한 한글/영문 제목이 포함되어 있는지 확인 (예: "◆◆◆æ◆(ONE PIECE)")
  const parenMatch = /\(([^)]*[a-zA-Z가-힣0-9]{2,}[^)]*)\)/.exec(cleaned);
  const innerTitle = parenMatch ? parenMatch[1].trim() : null;

  cleaned = cleaned
    .replace(/^\[.*?\]\s*/, '')
    .replace(/\s*\(.*?\)$/, '')
    .replace(/\s*\[.*?\]$/, '')
    .replace(/\s*[-|_|:|\||>].*$/, '')
    .trim();

  if (BROKEN_CHARS.test(cleaned) || !cleaned || /^[^a-zA-Z가-힣0-9]+$/.test(cleaned)) {
    if (innerTitle && !BROKEN_CHARS.test(innerTitle)) {
      cleaned = innerTitle;
    } else {
      cleaned = cleaned.replace(BROKEN_CHARS, '').trim();
    }
  }

  return cleaned || innerTitle || '미분류 만화';
}

/** 챕터 목록을 시리즈(작품)별로 그룹핑 */
export function groupChaptersBySeries(chapters) {
  const groups = new Map();
  const urlKeyToSeriesKey = new Map();

  const filtered = (chapters || []).filter((c) => {
    if (!c) return false;
    if (c.isDemo) return false;
    if (c.id?.startsWith('demo-')) return false;
    if (c.title?.includes('DEMO') || c.title?.includes('세로 스크롤 웹툰') || c.title?.includes('페이지 넘김')) return false;
    return true;
  });

  for (const chapter of filtered) {
    const parsed = parseSeriesAndEpisode(chapter.title || '');
    const urlKey = getSeriesUrlKey(chapter.sourceUrl);

    let seriesKey = null;

    if (urlKey && urlKeyToSeriesKey.has(urlKey)) {
      seriesKey = urlKeyToSeriesKey.get(urlKey);
    } else {
      seriesKey = parsed.seriesTitle;
      if (urlKey) {
        urlKeyToSeriesKey.set(urlKey, seriesKey);
      }
    }

    // 이전에 깨진 채 저장되어 있던 챕터 제목 자가 치유 (Self-healing)
    if (BROKEN_CHARS.test(chapter.title || '') && parsed.episodeNum > 0) {
      chapter.title = `${seriesKey} ${parsed.episodeNum}화`;
    }

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

    // 각 챕터의 parsedEpisodeLabel 을 formatEpisodeDisplayLabel 로 최종 보장 정제 ('회차' 문자열 무조건 소멸)
    group.chapters.forEach((c, idx) => {
      c.parsedEpisodeLabel = formatEpisodeDisplayLabel(c, idx);
      if ((!c.title || BROKEN_CHARS.test(c.title) || c.title === '회차') && c.parsedEpisodeLabel) {
        c.title = `${group.seriesTitle} ${c.parsedEpisodeLabel}`;
      }
    });

    // 회차 정렬 완료 후: 가장 첫 챕터(예: 1화)의 coverUrl 또는 첫 페이지를 시리즈 고정 대표 표지로 결정!
    for (const chapter of group.chapters) {
      if (chapter.coverUrl || chapter.mangaCoverUrl) {
        const rawUrl = chapter.coverUrl || chapter.mangaCoverUrl;
        group.coverUrl = rawUrl;
        group.coverPage = {
          url: rawUrl,
          originalUrl: rawUrl,
          refererUrl: chapter.sourceUrl || '',
        };
        break;
      }
    }

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

