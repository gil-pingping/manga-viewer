/**
 * 본문 이미지 선별 규칙 점검. `npm test` 로 돌린다.
 *
 * 여기가 진짜 회귀 방어선이다. 지금까지 이 판단에 버그가 날 때마다
 * 브라우저를 스무 번씩 열어 확인했는데, 규칙이 순수 함수가 되면서
 * 픽스처만으로 1초에 검증된다.
 */
import assert from 'node:assert/strict';
import {
  selectContentImages,
  findNumberedSeries,
  keepDominantDirectory,
  isBigEnough,
  pickSource,
  upgradeResolution,
  MIN_SHORT_SIDE,
  explainSelection,
  sortByExplicitPage,
  filenameShape,
  findDominantShape,
} from '../src/core/imageRules.js';
import {
  NAVER_WEBTOON,
  PINTEREST_GRID,
  AD_SHAPES,
  SHAPED_GALLERY,
  CONTAINER_VIEWER,
} from './fixtures/site-samples.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** 픽스처의 want 표와 실제 선별 결과를 맞춰본다 */
function auditFixture(fixture) {
  const got = selectContentImages(fixture.elements, fixture.pageUrl);
  const gotSet = new Set(got);

  const wanted = fixture.elements.filter((e) => e.want);
  const missing = wanted.filter((e) => {
    const src = pickSource(e);
    if (!src) return true;
    return !gotSet.has(src) && !gotSet.has(upgradeResolution(src));
  });
  const leaked = got.filter((url) => {
    const owner = fixture.elements.find((e) => {
      const s = pickSource(e);
      return s && (s === url || upgradeResolution(s) === url);
    });
    return owner && !owner.want;
  });

  return { got, missing, leaked };
}

console.log('선별 규칙 · 사이트 픽스처');

check('네이버 웹툰: 본문 8장만 남고 나머지는 걸러진다', () => {
  const r = auditFixture(NAVER_WEBTOON);
  assert.deepEqual(r.missing.map((e) => e.note), [], '본문인데 빠진 것이 있다');
  assert.deepEqual(r.leaked.map((u) => u.split('/').pop()), [], '본문이 아닌데 섞인 것이 있다');
  assert.equal(r.got.length, 8);
});

check('네이버: source 태그로 온 mp3 는 이미지가 아니다', () => {
  const got = selectContentImages(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl);
  assert.equal(got.filter((u) => u.endsWith('.mp3')).length, 0);
});

check('네이버: 같은 폴더에 섞인 썸네일도 빠진다', () => {
  const got = selectContentImages(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl);
  assert.equal(got.filter((u) => /thumbnail/i.test(u)).length, 0);
});

check('네이버: 이름·크기로 못 잡는 광고도 연번 규칙이 걸러낸다', () => {
  // melona 크리에이티브는 600x600 이고 이름에 광고 단서가 없다.
  // 연번(_IMAG01_1..8)이 아니라서 본문 구간에서 빠진다.
  const got = selectContentImages(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl);
  assert.equal(got.filter((u) => u.includes('melona')).length, 0);
});

check('네이버: 페이지 순서가 번호순으로 정렬된다', () => {
  const got = selectContentImages(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl);
  const nums = got.map((u) => Number(/_IMAG01_(\d+)\.jpg$/.exec(u)[1]));
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8]);
});

check('Pinterest: 핀 전부 살고 UI 일러스트만 빠진다', () => {
  const r = auditFixture(PINTEREST_GRID);
  assert.deepEqual(r.missing.map((e) => e.note), []);
  assert.deepEqual(r.leaked, []);
  assert.equal(r.got.length, 7); // 로드된 핀 6 + lazy 핀 1
});

check('Pinterest: 정사각형 핀이 잘리지 않는다', () => {
  // 예전 조건(min>=200 && max>=300)이 228x295 · 237x229 를 죽였다
  const got = selectContentImages(PINTEREST_GRID.elements, PINTEREST_GRID.pageUrl);
  assert.ok(got.some((u) => u.includes('74547460')));
  assert.ok(got.some((u) => u.includes('5486082c')));
});

check('Pinterest: 썸네일 해상도를 큰 판으로 올린다', () => {
  const got = selectContentImages(PINTEREST_GRID.elements, PINTEREST_GRID.pageUrl);
  assert.equal(got.filter((u) => u.includes('/236x/')).length, 0);
  assert.ok(got.every((u) => u.includes('/736x/')));
});

check('광고 표준 규격은 전부 걸러지고 컷만 남는다', () => {
  const r = auditFixture(AD_SHAPES);
  assert.deepEqual(r.missing.map((e) => e.note), []);
  assert.deepEqual(r.leaked, []);
  assert.equal(r.got.length, 3);
});

console.log('\n연번 구간 찾기');

check('p001.jpg 부터가 본문 — 앞의 잡동사니는 구간에 안 들어간다', () => {
  const urls = [
    'https://cdn.test/x/header-logo.jpg',
    'https://cdn.test/x/promo-top.jpg',
    'https://cdn.test/x/p001.jpg',
    'https://cdn.test/x/p002.jpg',
    'https://cdn.test/x/p003.jpg',
    'https://cdn.test/x/p004.jpg',
  ];
  assert.deepEqual(findNumberedSeries(urls), [
    'https://cdn.test/x/p001.jpg',
    'https://cdn.test/x/p002.jpg',
    'https://cdn.test/x/p003.jpg',
    'https://cdn.test/x/p004.jpg',
  ]);
});

check('DOM 순서가 어긋나도 번호순으로 세운다', () => {
  const urls = [
    'https://cdn.test/x/p003.jpg',
    'https://cdn.test/x/p001.jpg',
    'https://cdn.test/x/p002.jpg',
  ];
  assert.deepEqual(findNumberedSeries(urls), [
    'https://cdn.test/x/p001.jpg',
    'https://cdn.test/x/p002.jpg',
    'https://cdn.test/x/p003.jpg',
  ]);
});

check('해시 파일명은 연번이 아니다', () => {
  const urls = [
    'https://cdn.test/a/409c7001512da067.jpg',
    'https://cdn.test/b/eca9b94d79e6c956.jpg',
    'https://cdn.test/c/1979256b98d47620.jpg',
  ];
  assert.equal(findNumberedSeries(urls), null);
});

check('3장 미만은 연번으로 인정하지 않는다', () => {
  assert.equal(
    findNumberedSeries(['https://cdn.test/x/p001.jpg', 'https://cdn.test/x/p002.jpg']),
    null
  );
});

check('폴더가 다르면 같은 연번이라도 다른 묶음이다', () => {
  const urls = [
    'https://cdn.test/ch1/p001.jpg',
    'https://cdn.test/ch1/p002.jpg',
    'https://cdn.test/ch1/p003.jpg',
    'https://cdn.test/ch2/p001.jpg',
  ];
  assert.deepEqual(findNumberedSeries(urls), [
    'https://cdn.test/ch1/p001.jpg',
    'https://cdn.test/ch1/p002.jpg',
    'https://cdn.test/ch1/p003.jpg',
  ]);
});

console.log('\n크기 규칙');

check('짧은 변 하나로 광고 규격을 가린다', () => {
  const table = [
    [728, 90, false],
    [970, 90, false],
    [160, 600, false],
    [234, 60, false],
    [690, 1600, true],
    [228, 295, true],
    [237, 229, true],
    [2000, 1414, true],
  ];
  for (const [w, h, want] of table) {
    assert.equal(isBigEnough({ naturalWidth: w, naturalHeight: h }), want, `${w}x${h}`);
  }
});

check('크기를 모르면 명시된 속성이 작을 때만 버린다', () => {
  assert.equal(isBigEnough({ width: '100', height: '100' }), false);
  assert.equal(isBigEnough({ width: '800', height: '1200' }), true);
  assert.equal(isBigEnough({}), true); // 아무 단서 없으면 살린다
});

check('MIN_SHORT_SIDE 경계', () => {
  assert.equal(isBigEnough({ naturalWidth: MIN_SHORT_SIDE, naturalHeight: 999 }), true);
  assert.equal(isBigEnough({ naturalWidth: MIN_SHORT_SIDE - 1, naturalHeight: 999 }), false);
});

console.log('\n디렉터리 다수결 (연번 없을 때의 차선책)');

check('항목마다 폴더가 다르면 아무것도 하지 않는다', () => {
  const urls = [
    'https://a.test/1/x.jpg',
    'https://b.test/2/y.jpg',
    'https://c.test/3/z.jpg',
    'https://d.test/4/w.jpg',
  ];
  assert.deepEqual(keepDominantDirectory(urls), urls);
});

check('배너에 섞인 본문 묶음만 남긴다', () => {
  const urls = [
    'https://ads.test/b.png',
    'https://cdn.test/ch3/aaa.webp',
    'https://cdn.test/ch3/bbb.webp',
    'https://cdn.test/ch3/ccc.webp',
    'https://cdn.test/ch3/ddd.webp',
    'https://misc.test/p.png',
  ];
  assert.equal(keepDominantDirectory(urls).length, 4);
});

console.log('\nlazy 속성 우선순위');

check('data-src 가 src placeholder 를 이긴다', () => {
  assert.equal(
    pickSource({ src: 'data:image/gif;base64,AAA', dataSrc: 'https://cdn.test/real.jpg' }),
    'https://cdn.test/real.jpg'
  );
});

check('srcset 에서 가장 큰 것을 고른다', () => {
  assert.equal(
    pickSource({
      srcset: 'https://cdn.test/s.jpg 1x, https://cdn.test/l.jpg 3x',
      src: 'https://cdn.test/f.jpg',
    }),
    'https://cdn.test/l.jpg'
  );
});


console.log('\n진단 (explainSelection)');

check('통과한 경우 방법과 장수를 알려준다', () => {
  const d = explainSelection(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl);
  assert.equal(d.kept, 8);
  assert.equal(d.method, '연번 구간');
  assert.equal(d.total, NAVER_WEBTOON.elements.length);
});

check('어느 단계가 걸렀는지 집계한다', () => {
  const d = explainSelection(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl);
  const names = d.stages.map((s) => s.name);
  assert.ok(names.includes('이름걸림'), '썸네일·프로필이 이름으로 걸려야 한다');
  assert.ok(names.includes('크기미달'), '얇은 배너가 크기로 걸려야 한다');
  assert.ok(names.includes('이미지아님'), 'mp3 가 걸려야 한다');
  // 각 단계는 예시 주소를 들고 있어야 원인을 알 수 있다
  for (const s of d.stages) assert.ok(s.samples.length > 0);
});

check('0장일 때도 이유가 남는다', () => {
  const d = explainSelection(
    [{ tag: 'IMG', src: 'https://x.test/logo.png', naturalWidth: 40, naturalHeight: 40 }],
    'https://x.test/'
  );
  assert.equal(d.kept, 0);
  assert.ok(d.stages.length > 0);
});

console.log('\n파일명 모양 덩어리 (연번이 아닌 사이트)');

check('로고가 위에 얹혀도 본문 덩어리만 남는다', () => {
  const r = auditFixture(SHAPED_GALLERY);
  assert.deepEqual(r.missing.map((e) => e.note), [], '본문인데 빠진 것이 있다');
  assert.deepEqual(r.leaked, [], '본문이 아닌데 섞인 것이 있다');
  assert.equal(r.got.length, 8);
});

check('선별 방법으로 "파일명 모양"이 보고된다', () => {
  const d = explainSelection(SHAPED_GALLERY.elements, SHAPED_GALLERY.pageUrl);
  assert.equal(d.method, '파일명 모양');
  assert.equal(d.kept, 8);
});

check('숫자와 해시를 접어 같은 모양으로 본다', () => {
  const a = filenameShape('https://x.test/d/004439_45ed7219c6cc.png');
  const b = filenameShape('https://x.test/d/075431_ee52d4c3d337.png');
  assert.equal(a, b);
  assert.notEqual(a, filenameShape('https://x.test/d/logo_site.png'));
});

check('모양이 제각각이면 null (규칙이 개입하지 않는다)', () => {
  assert.equal(
    findDominantShape([
      'https://x.test/a/logo.png',
      'https://x.test/a/banner-top.jpg',
      'https://x.test/a/photo.webp',
      'https://x.test/a/hero.gif',
    ]),
    null
  );
});

check('연번이 있으면 연번이 우선한다 (모양 규칙보다)', () => {
  // p001~p004 는 모양도 같지만, 번호가 있으면 정렬까지 얻으므로 연번을 쓴다
  const els = [
    { src: 'https://x.test/c/p003.jpg', naturalWidth: 800, naturalHeight: 1200 },
    { src: 'https://x.test/c/p001.jpg', naturalWidth: 800, naturalHeight: 1200 },
    { src: 'https://x.test/c/p004.jpg', naturalWidth: 800, naturalHeight: 1200 },
    { src: 'https://x.test/c/p002.jpg', naturalWidth: 800, naturalHeight: 1200 },
  ];
  const d = explainSelection(els, 'https://x.test/');
  assert.equal(d.method, '연번 구간');
  assert.deepEqual(d.urls.map((u) => u.split('/').pop()), ['p001.jpg', 'p002.jpg', 'p003.jpg', 'p004.jpg']);
});

check('모양 규칙이 네이버·Pinterest 결과를 바꾸지 않는다', () => {
  assert.equal(selectContentImages(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl).length, 8);
  assert.equal(selectContentImages(PINTEREST_GRID.elements, PINTEREST_GRID.pageUrl).length, 7);
  assert.equal(explainSelection(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl).method, '연번 구간');
});

console.log('\n컨테이너형 뷰어 (사이트가 페이지 번호를 준다)');

check('본문 전부 살고 pageIndex 순으로 세워진다', () => {
  const r = auditFixture(CONTAINER_VIEWER);
  assert.deepEqual(r.missing.map((e) => e.note), []);
  assert.deepEqual(r.leaked, []);
  assert.equal(r.got.length, 6);
  const nums = r.got.map((u) => parseInt(u.split('/').pop(), 10));
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6], '문서 순서가 뒤섞여도 번호순이어야 한다');
});

check('background-image 로 그린 컷도 잡는다', () => {
  const got = selectContentImages(CONTAINER_VIEWER.elements, CONTAINER_VIEWER.pageUrl);
  // 짝수 페이지가 배경 이미지로 그려진 것들이다
  for (const n of [2, 4, 6]) {
    assert.ok(got.some((u) => u.endsWith(`00${n}.svg`)), `${n}번이 빠졌다`);
  }
});

check('선별 방법으로 "사이트 페이지 번호"가 보고된다', () => {
  const d = explainSelection(CONTAINER_VIEWER.elements, CONTAINER_VIEWER.pageUrl);
  assert.equal(d.method, '사이트 페이지 번호');
  assert.equal(d.kept, 6);
});

check('번호가 3개 미만이면 인정하지 않는다', () => {
  const entries = [
    { url: 'https://x.test/a.jpg', pageIndex: 1 },
    { url: 'https://x.test/b.jpg', pageIndex: 2 },
  ];
  assert.equal(sortByExplicitPage(entries), null);
});

check('번호가 절반 미만이면 인정하지 않는다 (우연 방지)', () => {
  const entries = [
    { url: 'https://x.test/a.jpg', pageIndex: 1 },
    { url: 'https://x.test/b.jpg', pageIndex: 2 },
    { url: 'https://x.test/c.jpg', pageIndex: 3 },
    { url: 'https://x.test/d.jpg', pageIndex: null },
    { url: 'https://x.test/e.jpg', pageIndex: null },
    { url: 'https://x.test/f.jpg', pageIndex: null },
    { url: 'https://x.test/g.jpg', pageIndex: null },
  ];
  assert.equal(sortByExplicitPage(entries), null);
});

check('페이지 번호가 연번·모양 규칙보다 우선한다', () => {
  // 파일명은 연번(p001..)이지만 번호가 반대로 붙어 있다 -> 번호를 따라야 한다
  const els = [
    { src: 'https://x.test/c/p001.jpg', naturalWidth: 800, naturalHeight: 1200, pageIndex: 3 },
    { src: 'https://x.test/c/p002.jpg', naturalWidth: 800, naturalHeight: 1200, pageIndex: 2 },
    { src: 'https://x.test/c/p003.jpg', naturalWidth: 800, naturalHeight: 1200, pageIndex: 1 },
  ];
  const got = selectContentImages(els, 'https://x.test/');
  assert.deepEqual(got.map((u) => u.split('/').pop()), ['p003.jpg', 'p002.jpg', 'p001.jpg']);
});

check('기존 사이트 결과가 바뀌지 않는다', () => {
  assert.equal(selectContentImages(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl).length, 8);
  assert.equal(selectContentImages(PINTEREST_GRID.elements, PINTEREST_GRID.pageUrl).length, 7);
  assert.equal(selectContentImages(SHAPED_GALLERY.elements, SHAPED_GALLERY.pageUrl).length, 8);
  assert.equal(explainSelection(NAVER_WEBTOON.elements, NAVER_WEBTOON.pageUrl).method, '연번 구간');
});

console.log(`\n${passed}개 통과`);
