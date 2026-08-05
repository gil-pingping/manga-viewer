/**
 * 챕터 목록 탐색 점검.
 *
 * 여기 살던 버그: 불러온 챕터가 목록 맨 앞에 꽂히는데 idx+1 로 다음 화를
 * 찾아서, 웹툰을 보다 "다음화"를 누르면 데모 챕터가 떴다.
 * 그 케이스를 맨 아래 시나리오로 고정해뒀다.
 */
import assert from 'node:assert/strict';
import {
  findChapter,
  indexOfChapter,
  realNeighbor,
  hasAdjacent,
  resolveAdjacent,
  upsertChapter,
} from '../src/core/chapterNav.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const demo = (id) => ({
  id,
  isDemo: true,
  pages: [],
  prevUrl: null,
  nextUrl: null,
  sourceUrl: null,
});
const loaded = (id, extra = {}) => ({
  id,
  isDemo: false,
  pages: [],
  prevUrl: null,
  nextUrl: null,
  sourceUrl: null,
  ...extra,
});

console.log('찾기');

check('id 로 찾는다', () => {
  assert.equal(findChapter([loaded('a'), demo('d')], 'd').id, 'd');
});

check('없는 id 면 첫 챕터', () => {
  assert.equal(findChapter([loaded('a'), demo('d')], 'nope').id, 'a');
});

check('빈 목록은 null', () => {
  assert.equal(findChapter([], 'a'), null);
  assert.equal(indexOfChapter([], 'a'), -1);
});

console.log('\n이웃 찾기 — 데모는 건너뛴다');

check('데모만 남았으면 이웃이 없다', () => {
  const list = [loaded('import-1'), demo('demo-paged'), demo('demo-strip')];
  assert.equal(realNeighbor(list, 'import-1', 1), null);
});

check('데모를 건너뛰고 진짜 챕터를 찾는다', () => {
  const list = [loaded('new'), demo('demo'), loaded('old')];
  assert.equal(realNeighbor(list, 'new', 1).id, 'old');
});

check('뒤로도 데모를 건너뛴다', () => {
  const list = [loaded('new'), demo('demo'), loaded('old')];
  assert.equal(realNeighbor(list, 'old', -1).id, 'new');
});

check('목록 끝을 넘어가지 않는다', () => {
  const list = [loaded('a'), loaded('b')];
  assert.equal(realNeighbor(list, 'b', 1), null);
  assert.equal(realNeighbor(list, 'a', -1), null);
});

console.log('\n버튼 활성 판정');

check('사이트 주소가 있으면 활성', () => {
  const list = [loaded('a', { nextUrl: 'https://x.test/ep/2' }), demo('d')];
  assert.equal(hasAdjacent(list, 'a', 1), true);
});

check('주소도 없고 데모만 있으면 비활성', () => {
  const list = [loaded('a'), demo('d')];
  assert.equal(hasAdjacent(list, 'a', 1), false);
  assert.equal(hasAdjacent(list, 'a', -1), false);
});

check('불러둔 이웃이 있으면 활성', () => {
  assert.equal(hasAdjacent([loaded('a'), loaded('b')], 'a', 1), true);
});

console.log('\n이동 방법 결정');

check('사이트 주소가 목록 순서를 이긴다', () => {
  // 목록에 이웃이 있어도, 사이트가 준 주소가 진짜 다음 화다
  const list = [loaded('a', { nextUrl: 'https://x.test/ep/250' }), loaded('b')];
  assert.deepEqual(resolveAdjacent(list, 'a', 1), {
    kind: 'fetch',
    url: 'https://x.test/ep/250',
  });
});

check('주소가 없으면 불러둔 이웃을 연다', () => {
  const r = resolveAdjacent([loaded('a'), loaded('b')], 'a', 1);
  assert.equal(r.kind, 'open');
  assert.equal(r.chapter.id, 'b');
});

check('갈 곳이 없으면 none', () => {
  assert.deepEqual(resolveAdjacent([loaded('a'), demo('d')], 'a', 1), { kind: 'none' });
});

check('빈 목록도 none', () => {
  assert.deepEqual(resolveAdjacent([], 'a', 1), { kind: 'none' });
});

console.log('\n목록에 넣기');

check('새 챕터는 맨 앞에 쌓인다', () => {
  const r = upsertChapter(
    [demo('demo')],
    { title: '3화', targetUrl: 'https://x.test/3', pages: [1, 2] },
    'import-1'
  );
  assert.equal(r.isNew, true);
  assert.equal(r.chapters[0].id, 'import-1');
  assert.equal(r.chapters.length, 2);
});

check('같은 출처를 다시 불러오면 목록이 늘지 않는다', () => {
  const first = upsertChapter([], { title: '3화', targetUrl: 'https://x.test/3', pages: [1] }, 'a');
  const second = upsertChapter(
    first.chapters,
    { title: '3화 (갱신)', targetUrl: 'https://x.test/3', pages: [1, 2, 3] },
    'b'
  );
  assert.equal(second.isNew, false);
  assert.equal(second.chapters.length, 1);
  assert.equal(second.chapter.title, '3화 (갱신)');
  assert.equal(second.chapter.pages.length, 3);
  assert.equal(second.chapter.id, 'a', '기존 id 를 유지해야 진행률이 이어진다');
});

check('출처가 없으면(붙여넣기·파일) 항상 새 챕터', () => {
  const first = upsertChapter([], { title: '붙여넣음', targetUrl: null, pages: [1] }, 'a');
  const second = upsertChapter(
    first.chapters,
    { title: '붙여넣음', targetUrl: null, pages: [1] },
    'b'
  );
  assert.equal(second.isNew, true);
  assert.equal(second.chapters.length, 2);
});

check('인접 화 주소를 챕터에 실어둔다', () => {
  const r = upsertChapter(
    [],
    {
      title: '249화',
      targetUrl: 'https://x.test/249',
      prevUrl: 'https://x.test/248',
      nextUrl: 'https://x.test/250',
      pages: [1],
    },
    'a'
  );
  assert.equal(r.chapter.prevUrl, 'https://x.test/248');
  assert.equal(r.chapter.nextUrl, 'https://x.test/250');
});

console.log('\n되돌아온 버그: 웹툰 보다 다음화 누르면 데모가 떴다');

check('불러온 챕터 + 데모 2개 상태에서 데모로 새지 않는다', () => {
  // 앱 초기 상태는 데모 2개. 웹툰을 불러오면 맨 앞에 꽂힌다.
  const r = upsertChapter(
    [demo('demo-paged'), demo('demo-strip')],
    { title: '헬 로그인 1화', targetUrl: 'https://comic.test/1', pages: [1, 2, 3] },
    'import-1'
  );
  const chapters = r.chapters;

  // 목록은 [웹툰, 데모, 데모] — idx+1 은 데모다. 그게 예전 버그였다.
  assert.equal(chapters[1].isDemo, true, '전제 확인: 바로 뒤가 데모');

  // 사이트 주소가 없으니 갈 곳이 없어야 한다 (데모로 가면 안 된다)
  assert.deepEqual(resolveAdjacent(chapters, 'import-1', 1), { kind: 'none' });
  assert.equal(hasAdjacent(chapters, 'import-1', 1), false, '버튼도 비활성이어야 한다');
});

check('사이트 주소가 있으면 그걸로 간다 (데모 아님)', () => {
  const r = upsertChapter(
    [demo('demo-paged'), demo('demo-strip')],
    {
      title: '헬 로그인 1화',
      targetUrl: 'https://comic.test/1',
      nextUrl: 'https://comic.test/2',
      pages: [1],
    },
    'import-1'
  );
  assert.deepEqual(resolveAdjacent(r.chapters, 'import-1', 1), {
    kind: 'fetch',
    url: 'https://comic.test/2',
  });
});

console.log(`\n${passed}개 통과`);
