/**
 * 서재 삭제 안전성 점검. `npm test` 로 돌린다.
 *
 * 서재에서 되돌릴 수 없는 동작은 삭제뿐이다. 여기서 잘못 판단하면 남은 챕터가
 * 조용히 구멍 난 채로 남고, 증상은 "빈 컷"으로만 보여 원인 추적이 어렵다.
 * IndexedDB 는 브라우저에만 있으니 그 판단만 순수 함수로 떼어 검사한다.
 */
import assert from 'node:assert/strict';
import { orphanPageUrls, formatBytes } from '../src/library.js';

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
