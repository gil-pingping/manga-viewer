/**
 * 화면 배치 · 넘김 판정 점검.
 *
 * 이 파일의 케이스는 전부 실제로 났던 버그에서 나왔다. 그때는 브라우저를
 * 스무 번 넘게 열어 확인했는데, 이제 순수 함수라 1초에 끝난다.
 */
import assert from 'node:assert/strict';
import {
  resolveMode,
  resolveVisiblePages,
  pageStep,
  nextIndex,
  prevIndex,
  isSpreadRatio,
  DOUBLE_MIN_WIDTH,
} from '../src/core/layout.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** 만화책 한 화: 12장, 8번이 펼침 컷 */
const BOOK = Array.from({ length: 12 }, (_, i) => ({
  pageNumber: i + 1,
  isSpread: i + 1 === 8,
}));

const shown = (pages, index, mode, direction) =>
  resolveVisiblePages({ pages, index, mode, direction }).map((v) => v.page.pageNumber);

console.log('모드 판정');

check('사용자가 고른 모드는 그대로 따른다', () => {
  for (const mode of ['strip', 'single', 'double']) {
    assert.equal(resolveMode({ mode, viewportWidth: 800, viewportHeight: 1280 }), mode);
  }
});

check('세로로 긴 이미지가 많으면 strip (웹툰)', () => {
  const ratios = Array.from({ length: 6 }, () => ({ w: 690, h: 1600 })); // h/w = 2.3
  assert.equal(
    resolveMode({ mode: 'auto', ratios, viewportWidth: 1280, viewportHeight: 800 }),
    'strip'
  );
});

check('만화책 비율이면 strip 이 아니다', () => {
  const ratios = Array.from({ length: 6 }, () => ({ w: 1000, h: 1414 })); // h/w = 1.41
  assert.notEqual(
    resolveMode({ mode: 'auto', ratios, viewportWidth: 1280, viewportHeight: 800 }),
    'strip'
  );
});

check('절반 미만만 세로로 길면 strip 이 아니다', () => {
  const ratios = [
    { w: 690, h: 1600 },
    { w: 690, h: 1600 },
    { w: 1000, h: 1414 },
    { w: 1000, h: 1414 },
    { w: 1000, h: 1414 },
  ];
  assert.notEqual(
    resolveMode({ mode: 'auto', ratios, viewportWidth: 1280, viewportHeight: 800 }),
    'strip'
  );
});

check('세로 태블릿은 한 장 (8.4인치 세로에서 펼침은 못 읽는다)', () => {
  assert.equal(resolveMode({ mode: 'auto', viewportWidth: 800, viewportHeight: 1280 }), 'single');
});

check('가로로 충분히 넓으면 두 장 펼침', () => {
  assert.equal(resolveMode({ mode: 'auto', viewportWidth: 1280, viewportHeight: 800 }), 'double');
});

check('넓이 경계', () => {
  const h = 700;
  assert.equal(
    resolveMode({ mode: 'auto', viewportWidth: DOUBLE_MIN_WIDTH, viewportHeight: h }),
    'double'
  );
  assert.equal(
    resolveMode({ mode: 'auto', viewportWidth: DOUBLE_MIN_WIDTH - 1, viewportHeight: h }),
    'single'
  );
});

check('가로가 넓어도 정사각에 가까우면 한 장', () => {
  // 1.1 배를 넘지 않으면 두 장을 나란히 놓기 좁다
  assert.equal(resolveMode({ mode: 'auto', viewportWidth: 1000, viewportHeight: 950 }), 'single');
});

console.log('\n펼침 컷 판정');

check('폭이 높이보다 넓으면 펼침', () => {
  assert.equal(isSpreadRatio(2000, 1414), true);
  assert.equal(isSpreadRatio(1000, 1414), false);
  assert.equal(isSpreadRatio(690, 1600), false);
  assert.equal(isSpreadRatio(0, 0), false);
});

console.log('\n페이지 배치');

check('한 장 모드는 항상 한 장', () => {
  for (const i of [0, 1, 7, 8, 11]) {
    assert.deepEqual(shown(BOOK, i, 'single', 'RTL'), [BOOK[i].pageNumber]);
  }
});

check('첫 장은 홀로 (표지)', () => {
  assert.deepEqual(shown(BOOK, 0, 'double', 'RTL'), [1]);
});

check('RTL 은 오른쪽이 먼저 — DOM 순서가 뒤집힌다', () => {
  // 화면 왼쪽에 3, 오른쪽에 2 가 놓인다
  assert.deepEqual(shown(BOOK, 1, 'double', 'RTL'), [3, 2]);
  assert.deepEqual(shown(BOOK, 1, 'double', 'LTR'), [2, 3]);
});

check('짝 안의 어느 쪽에 착지해도 같은 짝을 보여준다', () => {
  assert.deepEqual(shown(BOOK, 1, 'double', 'RTL'), shown(BOOK, 2, 'double', 'RTL'));
});

check('펼침 컷은 홀로 놓인다', () => {
  assert.deepEqual(shown(BOOK, 7, 'double', 'RTL'), [8]);
});

// 실제 버그: 짝 후보 중 뒤쪽만 검사해서, 펼침 바로 다음 장에 착지하면
// 펼침이 옆에 붙었다
check('펼침 바로 다음 장도 홀로 놓인다 (되돌아온 버그)', () => {
  assert.deepEqual(shown(BOOK, 8, 'double', 'RTL'), [9]);
});

check('펼침이 지나가면 짝짓기가 다시 맞는다', () => {
  assert.deepEqual(shown(BOOK, 9, 'double', 'RTL'), [11, 10]);
});

console.log('\n넘김 단위');

check('한 장·연속 모드는 한 장씩', () => {
  assert.equal(pageStep({ mode: 'single', visibleCount: 1 }), 1);
  assert.equal(pageStep({ mode: 'strip', visibleCount: 3 }), 1);
});

// 실제 버그: 한 장만 띄웠는데 두 장씩 넘겨서 중간 페이지가 사라졌다
check('띄운 장수만큼만 넘긴다 (되돌아온 버그)', () => {
  assert.equal(pageStep({ mode: 'double', visibleCount: 2 }), 2);
  assert.equal(pageStep({ mode: 'double', visibleCount: 1 }), 1);
  assert.equal(pageStep({ mode: 'double', visibleCount: 0 }), 1);
});

console.log('\n전수 스윕 (브라우저로 하던 검증)');

/** 첫 장부터 "다음"만 눌러 끝까지 간다. 배치와 넘김을 실제 순서대로 엮는다 */
function sweep(pages, mode, direction) {
  const screens = [];
  let index = 0;
  let guard = 0;

  while (guard++ < pages.length * 2 + 5) {
    const visible = resolveVisiblePages({ pages, index, mode, direction });
    screens.push(visible.map((v) => v.page.pageNumber));

    const next = nextIndex({ pages, index, mode, visibleCount: visible.length });
    if (next === null) break;
    index = next;
  }
  return screens;
}

check('12장(8번 펼침) 전수 스윕: 누락·중복 없고 펼침 단독', () => {
  const screens = sweep(BOOK, 'double', 'RTL');

  const seen = screens.flat();
  const missing = BOOK.map((p) => p.pageNumber).filter((n) => !seen.includes(n));
  assert.deepEqual(missing, [], '건너뛴 페이지가 있다');

  const dupes = seen.filter((n, i) => seen.indexOf(n) !== i);
  assert.deepEqual([...new Set(dupes)], [], '두 번 보인 페이지가 있다');

  // 펼침(8번)은 언제나 혼자
  for (const s of screens) {
    if (s.includes(8)) assert.deepEqual(s, [8], '펼침이 다른 장과 같이 놓였다');
  }

  // 브라우저에서 확인했던 것과 같은 순서
  assert.deepEqual(screens, [[1], [3, 2], [5, 4], [7, 6], [8], [9], [11, 10], [12]]);
});

check('한 장 모드 스윕: 1..12 순서대로', () => {
  assert.deepEqual(sweep(BOOK, 'single', 'RTL').flat(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

check('펼침이 없는 화도 스윕이 맞는다', () => {
  const plain = Array.from({ length: 6 }, (_, i) => ({ pageNumber: i + 1, isSpread: false }));
  assert.deepEqual(sweep(plain, 'double', 'RTL'), [[1], [3, 2], [5, 4], [6]]);
});

check('한 장뿐인 화', () => {
  const one = [{ pageNumber: 1, isSpread: false }];
  assert.deepEqual(sweep(one, 'double', 'RTL'), [[1]]);
});

console.log('\n경계');

check('마지막 장에서 다음은 null (화 끝)', () => {
  assert.equal(nextIndex({ pages: BOOK, index: 11, mode: 'single', visibleCount: 1 }), null);
});

check('첫 장에서 이전은 null', () => {
  assert.equal(prevIndex({ index: 0, mode: 'single', visibleCount: 1 }), null);
});

check('이전으로 되돌아가면 앞 짝에 착지한다', () => {
  assert.equal(prevIndex({ index: 9, mode: 'double', visibleCount: 2 }), 7);
});

check('빈 페이지 목록은 빈 배치', () => {
  assert.deepEqual(
    resolveVisiblePages({ pages: [], index: 0, mode: 'double', direction: 'RTL' }),
    []
  );
});

check('범위를 벗어난 인덱스는 빈 배치', () => {
  assert.deepEqual(
    resolveVisiblePages({ pages: BOOK, index: 99, mode: 'double', direction: 'RTL' }),
    []
  );
});

console.log(`\n${passed}개 통과`);
