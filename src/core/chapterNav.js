/**
 * 챕터 목록 탐색 — 순수 함수.
 *
 * 왜 뽑아냈나: 이 판단이 main.js 에서 모듈 전역 state 를 읽고 있었다.
 * 그래서 브라우저 없이는 확인할 수 없었고, 실제로 버그가 났다:
 *
 *   불러온 챕터는 목록 맨 앞에 꽂힌다. 그래서 단순히 idx+1 을 쓰면
 *   "다음 화"가 데모 챕터로 새어나갔다. 실제로 웹툰 249화를 보다가
 *   다음화를 누르면 빈 컷 프레임 데모가 떴다.
 *
 * 목록 구조 전제:
 *  - chapters[0] 이 가장 최근에 불러온 것 (앞에 쌓는다)
 *  - isDemo 챕터는 사용자가 명시적으로 고를 때만 열려야 한다
 *  - prevUrl/nextUrl 은 사이트에서 파싱한 인접 화 주소
 */

/** id 로 챕터 찾기. 없으면 첫 챕터 (목록이 비면 null) */
export function findChapter(chapters, id) {
  return chapters.find((c) => c.id === id) || chapters[0] || null;
}

/** 현재 위치. 못 찾으면 -1 */
export function indexOfChapter(chapters, id) {
  return chapters.findIndex((c) => c.id === id);
}

/**
 * 목록에서 데모가 아닌 이웃 챕터.
 * 데모를 건너뛰며 찾는다 — 그냥 idx+delta 를 쓰면 데모로 새어나간다.
 */
export function realNeighbor(chapters, currentId, delta) {
  const from = indexOfChapter(chapters, currentId);
  if (from < 0) return null;

  for (let i = from + delta; i >= 0 && i < chapters.length; i += delta) {
    if (!chapters[i].isDemo) return chapters[i];
  }
  return null;
}

/** 그 방향으로 갈 곳이 있는가 (버튼 활성 판정) */
export function hasAdjacent(chapters, currentId, delta) {
  const current = findChapter(chapters, currentId);
  if (!current) return false;

  const url = delta > 0 ? current.nextUrl : current.prevUrl;
  return !!url || !!realNeighbor(chapters, currentId, delta);
}

/**
 * 인접 화로 갈 방법을 정한다. 실제 이동은 호출자가 한다.
 *
 * 우선순위: 사이트가 준 인접 화 주소 > 이미 불러둔 이웃 챕터 > 없음.
 * 주소가 있으면 그게 진짜 다음 화다 (목록 순서는 불러온 순서일 뿐이다).
 *
 *   { kind: 'fetch', url }      서버가 받아와야 한다
 *   { kind: 'open', chapter }   이미 목록에 있다
 *   { kind: 'none' }            갈 곳이 없다
 */
export function resolveAdjacent(chapters, currentId, delta) {
  const current = findChapter(chapters, currentId);
  if (!current) return { kind: 'none' };

  const url = delta > 0 ? current.nextUrl : current.prevUrl;
  if (url) {
    const loaded = chapters.find((chapter) => (
      chapter !== current
      && !chapter.isDemo
      && chapter.sourceUrl === url
    ));
    return loaded ? { kind: 'open', chapter: loaded } : { kind: 'fetch', url };
  }

  const neighbor = realNeighbor(chapters, currentId, delta);
  if (neighbor) return { kind: 'open', chapter: neighbor };

  return { kind: 'none' };
}

/** 현재 화의 다음 주소를 미리 받은 결과만 쓴다. 이전 화·오래된 비동기 결과는 제외. */
export function findAdjacentPrefetch(prefetch, currentId, delta, url) {
  if (delta <= 0 || prefetch?.sourceId !== currentId || prefetch.url !== url) return null;
  return prefetch.promise;
}

/**
 * 수집 결과를 챕터 목록에 반영한다. 새 목록과 대상 챕터를 돌려준다.
 * 같은 출처를 다시 불러오면 새로 만들지 않고 그 자리에서 갱신한다
 * (같은 화를 두 번 불러도 목록이 늘어나지 않아야 한다).
 */
export function upsertChapter(chapters, harvested, id) {
  const existing = harvested.targetUrl
    ? chapters.find((c) => c.sourceUrl && c.sourceUrl === harvested.targetUrl)
    : null;

  const chapter = existing || { id, label: '불러옴' };

  chapter.title = harvested.title || '불러온 만화';
  chapter.pages = harvested.pages;
  // 표지는 회차 페이지에 없을 때가 있다. 한 번 찾은 값은 덮어쓰지 않고 남긴다
  chapter.coverUrl = harvested.coverUrl || chapter.coverUrl || null;
  chapter.sourceUrl = harvested.targetUrl || null;
  chapter.prevUrl = harvested.prevUrl || null;
  chapter.nextUrl = harvested.nextUrl || null;

  // 새 챕터는 맨 앞에 쌓는다 (최근에 본 것이 위)
  const next = existing ? chapters : [chapter, ...chapters];
  return { chapters: next, chapter, isNew: !existing };
}
