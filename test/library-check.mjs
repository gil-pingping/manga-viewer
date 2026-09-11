/**
 * 서재 삭제 안전성 점검. `npm test` 로 돌린다.
 *
 * 서재에서 되돌릴 수 없는 동작은 삭제뿐이다. 여기서 잘못 판단하면 남은 챕터가
 * 조용히 구멍 난 채로 남고, 증상은 "빈 컷"으로만 보여 원인 추적이 어렵다.
 * IndexedDB 는 브라우저에만 있으니 그 판단만 순수 함수로 떼어 검사한다.
 */
import assert from 'node:assert/strict';
import { orphanPageUrls, offlinePageKeys, formatBytes } from '../src/library.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const p = (u) => ({ url: `/api/proxy-image?url=${u}` });

console.log('서재 삭제 대상 고르기');

check('혼자 쓰는 페이지는 전부 지운다', () => {
  const all = [
    { id: 'a', pages: [p('x1'), p('x2')] },
    { id: 'b', pages: [p('y1')] },
  ];
  assert.deepEqual(orphanPageUrls(all, 'a'), [p('x1').url, p('x2').url]);
});

check('다른 화가 같이 쓰는 페이지는 남긴다', () => {
  // 같은 화를 두 번 불러 id 가 둘이 된 상황. 한쪽을 지워도 나머지는 온전해야 한다
  const all = [
    { id: 'a', pages: [p('x1'), p('x2')] },
    { id: 'a-again', pages: [p('x1'), p('x2')] },
  ];
  assert.deepEqual(orphanPageUrls(all, 'a'), []);
});

check('겹치는 것만 남기고 나머지는 지운다', () => {
  const all = [
    { id: 'a', pages: [p('shared'), p('only-a')] },
    { id: 'b', pages: [p('shared')] },
  ];
  assert.deepEqual(orphanPageUrls(all, 'a'), [p('only-a').url]);
});

check('없는 id 는 아무것도 지우지 않는다', () => {
  assert.deepEqual(orphanPageUrls([{ id: 'a', pages: [p('x')] }], 'nope'), []);
});

check('pages 가 없는 기록에도 죽지 않는다', () => {
  assert.deepEqual(orphanPageUrls([{ id: 'a' }, { id: 'b', pages: null }], 'a'), []);
});

console.log('\n오프라인 조회 키 고르기');

check('재수집한 챕터도 담아둔 바이트를 읽는다', () => {
  // 키에 CDN 서명이 들어 있어서 재수집하면 메모리 쪽 url 이 전부 바뀐다.
  // 저장 행이 기준 — 아니면 전부 miss 후 온라인 폴백, 서명 만료 뒤엔 "이미지 실패"
  const chapterPages = [p('sig-new-1'), p('sig-new-2')];
  const storedPages = [p('sig-old-1'), p('sig-old-2')];
  assert.deepEqual(offlinePageKeys(chapterPages, storedPages), [
    p('sig-old-1').url,
    p('sig-old-2').url,
  ]);
});

check('장수가 다르면 저장 행을 버리고 메모리 쪽 키를 쓴다', () => {
  // 장수가 다른 것은 판본이 다른 것이다. 순번으로 짝지으면 엉뚱한 컷이 뜬다
  const chapterPages = [p('a1'), p('a2'), p('a3')];
  assert.deepEqual(offlinePageKeys(chapterPages, [p('b1'), p('b2')]), [
    p('a1').url,
    p('a2').url,
    p('a3').url,
  ]);
});

check('저장 행이 없거나 비어 있으면 메모리 쪽 키를 쓴다', () => {
  // 이 변경 전에 저장된 행, 그리고 아직 담지 않은 챕터
  const chapterPages = [p('a1')];
  const want = [p('a1').url];
  assert.deepEqual(offlinePageKeys(chapterPages, undefined), want);
  assert.deepEqual(offlinePageKeys(chapterPages, null), want);
  assert.deepEqual(offlinePageKeys(chapterPages, []), want);
});

check('페이지가 없으면 오프라인 경로를 포기한다', () => {
  assert.equal(offlinePageKeys([], [p('a1')]), null);
  assert.equal(offlinePageKeys(undefined, undefined), null);
  assert.equal(offlinePageKeys(null, []), null);
});

check('빈 키가 섞이면 성공할 수 없는 조회를 하지 않는다', () => {
  assert.equal(offlinePageKeys([p('a1'), { url: '' }], null), null);
  assert.equal(offlinePageKeys([p('a1'), {}], null), null);
  // 고른 쪽이 저장 행일 때도 같다
  assert.equal(offlinePageKeys([p('a1'), p('a2')], [p('b1'), { url: undefined }]), null);
});

console.log('\n용량 표기');

check('단위 경계', () => {
  const table = [
    [0, '0B'],
    [1024, '1KB'],
    [1024 * 1024 - 1, '1024KB'],
    [1024 * 1024, '1.0MB'],
    [1024 * 1024 * 1024, '1.00GB'],
  ];
  for (const [n, want] of table) assert.equal(formatBytes(n), want, String(n));
});

console.log(`\n${passed}개 통과`);
