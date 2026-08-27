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
    return { seriesTitle: '기타 만화', episodeNum: 0, episodeLabel: '1화', episodeHead: '' };
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
  let episodeHead = '';

  for (const pattern of epPatterns) {
    const match = title.match(pattern);
    if (match) {
      episodeNum = parseFloat(match[1]);
      // 회차 패턴 앞부분을 시리즈 제목으로 취급
      const idx = match.index;
      let head = title.substring(0, idx).trim();
      // 특수문자 마감 정리 (예: "원피스 -" -> "원피스")
      head = head.replace(/[\s\-_:|]+$/, '').trim();
      episodeHead = head;
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
    // 번호 앞의 원문 텍스트. "에필로그 1화"와 본편 "1화"를 구별하는 근거다
    episodeHead,
  };
}

/**
 * 회차 링크로 인정하는 최소 개수.
 *
 * 2개 이하는 목록이 아니라 이전/다음 버튼일 가능성이 크다. 네이버 웹툰을
 * 헤드리스로 열었을 때 회차 링크가 딱 2개였다 — 그런 결과를 "전체 목록"이라고
 * 보여주면 거짓말이 된다. 그런 사이트는 기존 다음화 추적으로 충분하다.
 */
export const MIN_EPISODE_LINKS = 3;

/** 링크의 상위 디렉터리. 같은 작품의 회차들은 여기가 같다 */
function linkDirectory(href) {
  try {
    const url = new URL(href);
    const segments = url.pathname.split('/').filter(Boolean);
    segments.pop();
    return `${url.origin}/${segments.join('/')}`;
  } catch {
    return null;
  }
}

/**
 * 최다 디렉터리만 남긴다. 목록 페이지에는 다른 작품 추천 링크가 섞여 있고
 * 그것들도 "12화" 같은 텍스트를 달고 있다.
 */
function keepDominantDirectory(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (!entry.dir) continue;
    counts.set(entry.dir, (counts.get(entry.dir) || 0) + 1);
  }
  if (counts.size <= 1) return entries;

  let best = null;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return entries.filter((entry) => entry.dir === best);
}

/**
 * 링크 서술자 목록에서 그 작품의 회차 링크만 골라 번호순으로 세운다.
 *
 * 순수 함수다 — DOM 을 만지지 않고 `{href, text}` 만 받는다. 그래서
 * 픽스처로 테스트되고, 어떤 문서(회차 페이지든 목록 페이지든)에서 긁어온
 * 링크에도 같은 규칙이 적용된다.
 *
 * 회차 번호는 **링크 텍스트**에서만 읽는다. 주소에서 읽으려 하면
 * `/manhwa/2/29315` 같은 불투명한 게시물 번호를 회차로 착각한다.
 *
 * @param {Array<{href: string, text: string}>} links
 * @returns {Array<{url: string, label: string, episodeNum: number}>}
 *   회차 목록으로 볼 수 없으면 빈 배열
 */
export function selectEpisodeLinks(links) {
  const seenHref = new Set();
  const candidates = [];

  for (const link of links || []) {
    const href = link?.href;
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) continue;
    if (seenHref.has(href)) continue;

    const parsed = parseSeriesAndEpisode(link.text || '');
    if (!(parsed.episodeNum > 0)) continue;

    seenHref.add(href);
    candidates.push({
      url: href,
      label: parsed.episodeLabel,
      episodeNum: parsed.episodeNum,
      head: parsed.episodeHead,
      dir: linkDirectory(href),
    });
  }

  const sameSeries = keepDominantDirectory(candidates);

  /**
   * 한 회차가 두 주소(재업 등)로 걸려도 한 줄만 남긴다.
   * 번호만 보면 안 된다 — 뉴토키 실측: "에필로그 1화"와 본편 "1화"는 번호가
   * 같아도 다른 회차인데, 번호 키로 합치면 본편 1~6화가 통째로 사라졌다.
   * 번호 앞 텍스트(head)까지 같을 때만 같은 회차로 본다.
   */
  const byKey = new Map();
  for (const entry of sameSeries) {
    const key = `${entry.head}|${entry.episodeNum}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }

  if (byKey.size < MIN_EPISODE_LINKS) return [];

  const entries = [...byKey.values()];

  // 가장 흔한 head 가 본편이다. 에필로그·프롤로그·외전은 뒤로 보내고
  // 라벨에 구분 텍스트를 남긴다 — "1화" 두 줄이 나란히 뜨면 구별이 안 된다.
  const headCounts = new Map();
  for (const entry of entries) {
    headCounts.set(entry.head, (headCounts.get(entry.head) || 0) + 1);
  }
  let mainHead = '';
  let mainCount = -1;
  for (const [head, count] of headCounts) {
    if (count > mainCount) {
      mainHead = head;
      mainCount = count;
    }
  }

  return entries
    .sort((a, b) => {
      const aMain = a.head === mainHead ? 0 : 1;
      const bMain = b.head === mainHead ? 0 : 1;
      if (aMain !== bMain) return aMain - bMain;
      if (a.head !== b.head) return a.head < b.head ? -1 : 1;
      return a.episodeNum - b.episodeNum;
    })
    .map(({ url, label, episodeNum, head }) => ({
      url,
      label: head === mainHead ? label : `${stripHeadPrefix(head, mainHead)} ${label}`.trim(),
      episodeNum,
    }));
}

/** "헬퍼 에필로그" 에서 본편 head "헬퍼" 를 떼면 구분 텍스트 "에필로그"만 남는다 */
function stripHeadPrefix(head, mainHead) {
  if (mainHead && head.startsWith(mainHead)) return head.slice(mainHead.length).trim();
  return head;
}

/** 목록 페이지 나눔에 쓰이는 흔한 파라미터 이름 */
export const LIST_PAGE_PARAMS = ['epage', 'page', 'pg', 'spage', 'p'];

/**
 * 목록 페이지 안에서 "같은 목록의 다음 쪽" 주소를 찾는다.
 *
 * 뉴토키 실측: 한 쪽에 100화까지만 실리고 나머지는 ?epage=2 에 있다.
 * 첫 쪽만 읽으면 중간 회차가 통째로 빠진다. 같은 경로(origin+pathname)에
 * 페이지 파라미터가 2 이상 붙은 링크만 다음 쪽으로 인정한다 — 다른 게시판·
 * 다른 작품으로 새지 않는다.
 *
 * 순수 함수: 링크 서술자만 받는다. 실제 fetch 는 urlHarvester 가 한다.
 */
export function findListPageUrls(links, listUrl) {
  let base;
  try {
    base = new URL(listUrl);
  } catch {
    return [];
  }

  const out = new Set();
  for (const link of links || []) {
    let url;
    try {
      url = new URL(link?.href);
    } catch {
      continue;
    }
    if (url.origin !== base.origin || url.pathname !== base.pathname) continue;

    for (const name of LIST_PAGE_PARAMS) {
      const value = url.searchParams.get(name);
      if (value && /^\d+$/.test(value) && parseInt(value, 10) >= 2) {
        out.add(url.href);
        break;
      }
    }
  }
  return [...out];
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
