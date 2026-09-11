/**
 * 수집기 자기 점검. 프레임워크 없이 `npm test` 로 돌린다.
 *
 * 브라우저가 필요 없는 순수 로직만 검증한다: parseRawText (주소 목록 붙여넣기),
 * findAdjacentLink (이전/다음 화 링크 찾기 — 최소 DOM 스텁으로).
 * 북마클릿 수집(collector.js)은 DOM 이 있어야 하므로 실제 페이지에서 확인한다.
 */
import assert from 'node:assert/strict';
import { UrlHarvester, findAdjacentLink } from '../src/urlHarvester.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('parseRawText');

check('주소 목록을 페이지로 바꾼다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/ch1/001.webp
    https://cdn.test/ch1/002.webp
    https://cdn.test/ch1/003.jpg
  `);
  assert.equal(pages.length, 3);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages[0].originalUrl, 'https://cdn.test/ch1/001.webp');
  // 브라우저가 직접 못 받는 경우가 많아 프록시를 경유해야 한다
  assert.match(pages[0].url, /^\/api\/proxy-image\?url=/);
});

check('붙여넣은 순서를 유지한다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/ch1/003.webp
    https://cdn.test/ch1/001.webp
    https://cdn.test/ch1/002.webp
  `);
  assert.deepEqual(
    pages.map((p) => p.originalUrl),
    [
      'https://cdn.test/ch1/003.webp',
      'https://cdn.test/ch1/001.webp',
      'https://cdn.test/ch1/002.webp',
    ]
  );
});

check('아이콘·배너 주소는 걸러낸다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/ch1/001.webp
    https://cdn.test/assets/logo.png
    https://cdn.test/ch1/002.webp
    https://ads.test/banner.jpg
  `);
  assert.deepEqual(
    pages.map((p) => p.originalUrl),
    ['https://cdn.test/ch1/001.webp', 'https://cdn.test/ch1/002.webp']
  );
});

check('중복 주소는 한 번만 담는다', () => {
  const pages = UrlHarvester.parseRawText(
    'https://cdn.test/ch1/001.webp https://cdn.test/ch1/001.webp'
  );
  assert.equal(pages.length, 1);
});

check('이미지가 아닌 주소는 무시한다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/ch1/001.webp
    https://example.test/about.html
  `);
  assert.equal(pages.length, 1);
});

check('빈 입력은 빈 배열', () => {
  assert.deepEqual(UrlHarvester.parseRawText(''), []);
  assert.deepEqual(UrlHarvester.parseRawText('   '), []);
  assert.deepEqual(UrlHarvester.parseRawText(null), []);
});

// 확장자 없이 이미지를 주는 CDN 이 흔하다. 확장자를 요구하면 목록 전체가 버려진다.
check('확장자 없는 CDN 주소도 받는다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/id/1011/900/1400
    https://cdn.test/id/1015/900/1400
  `);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].originalUrl, 'https://cdn.test/id/1011/900/1400');
});

check('확장자 없는 목록에서도 웹페이지 주소는 뺀다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/id/1011/900/1400
    https://example.test/viewer.php?id=3
  `);
  assert.deepEqual(
    pages.map((p) => p.originalUrl),
    ['https://cdn.test/id/1011/900/1400']
  );
});

check('확장자 있는 주소가 섞이면 그것만 고른다', () => {
  const pages = UrlHarvester.parseRawText(`
    https://cdn.test/ch1/001.webp
    https://cdn.test/some/other/thing
  `);
  assert.deepEqual(
    pages.map((p) => p.originalUrl),
    ['https://cdn.test/ch1/001.webp']
  );
});

console.log('\nparseImportHash');

check('latest 센티널을 알아본다', () => {
  assert.equal(UrlHarvester.parseImportHash('#import=latest'), 'latest');
});

check('import 해시가 없으면 null', () => {
  assert.equal(UrlHarvester.parseImportHash(''), null);
  assert.equal(UrlHarvester.parseImportHash('#other=1'), null);
});

check('인라인 페이로드를 페이지로 바꾼다', () => {
  const payload = { title: '3화', pages: ['https://cdn.test/ch3/001.webp'] };
  const out = UrlHarvester.parseImportHash('#import=' + encodeURIComponent(JSON.stringify(payload)));
  assert.equal(out.title, '3화');
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].originalUrl, 'https://cdn.test/ch3/001.webp');
});

/* ==================================================================== */
/* 이전/다음 화 링크 찾기                                                 */
/* ==================================================================== */

/**
 * 최소 DOM 스텁. Node 에는 DOMParser 가 없고, 이 몇 가지 판정 때문에
 * 크로미움을 띄우는 건 과하다. findAdjacentLink 가 실제로 쓰는 표면만 흉내
 * 낸다: querySelectorAll('a[href]') / getAttribute / textContent /
 * parentElement / tagName.
 */
function node(tagName, attrs = {}, kids = []) {
  const el = {
    tagName,
    parentElement: null,
    children: typeof kids === 'string' ? [] : kids,
    text: typeof kids === 'string' ? kids : '',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    get textContent() {
      return el.text + el.children.map((kid) => kid.textContent).join('');
    },
  };
  for (const kid of el.children) kid.parentElement = el;
  return el;
}

function docOf(...roots) {
  const anchors = [];
  const walk = (el) => {
    if (el.tagName === 'A' && el.getAttribute('href') !== null) anchors.push(el);
    el.children.forEach(walk);
  };
  roots.forEach(walk);
  return { querySelectorAll: () => anchors };
}

// 실측 사이트(wftoon227.com)의 실제 주소 구조. toon = 작품, num = 회차 위치
const HERE = 'https://wftoon227.com/view?toon=184&num=42';
const ORIGIN = 'https://wftoon227.com';
const NEXT_PATTERN = /다음화|다음\s*화|next/i;
const PREV_PATTERN = /이전화|이전\s*화|prev/i;

const findNext = (doc) => findAdjacentLink(doc, NEXT_PATTERN, ORIGIN, HERE);
const findPrev = (doc) => findAdjacentLink(doc, PREV_PATTERN, ORIGIN, HERE);

console.log('\nfindAdjacentLink');

check('아래쪽 바의 다음화 링크를 찾는다', () => {
  const doc = docOf(
    node('UL', {}, [
      node('LI', { class: 'next' }, [node('A', { href: '/view?toon=184&num=43' }, '다음화')]),
    ])
  );
  assert.equal(findNext(doc), 'https://wftoon227.com/view?toon=184&num=43');
});

check('아래쪽 바의 이전화 링크를 찾는다', () => {
  const doc = docOf(
    node('UL', {}, [
      node('LI', { class: 'prev' }, [node('A', { href: '/view?toon=184&num=41' }, '이전화')]),
    ])
  );
  assert.equal(findPrev(doc), 'https://wftoon227.com/view?toon=184&num=41');
});

// 이걸 놓치면 링크가 없다고 판단해 주소 추측(toon +1)으로 내려가고,
// "다음 화"가 다른 작품으로 열린다 — 실제로 났던 사고다.
check('아이콘만 든 화살표도 title 로 찾아낸다', () => {
  const doc = docOf(
    node('DIV', { class: 'nextpage' }, [
      node('A', { href: '/view?toon=184&num=43', title: '다음화' }, [
        node('I', { class: 'fa fa-chevron-right' }, ''),
      ]),
    ])
  );
  assert.equal(
    findNext(doc),
    'https://wftoon227.com/view?toon=184&num=43',
    '아이콘 화살표를 놓치면 주소 추측으로 내려가 다른 작품이 열린다'
  );
});

check('글자도 title 도 없는 화살표는 감싼 class 로 찾아낸다', () => {
  const doc = docOf(
    node('DIV', { class: 'nextpage' }, [
      node('A', { href: '/view?toon=184&num=43' }, [node('I', { class: 'fa' }, '')]),
    ])
  );
  assert.equal(findNext(doc), 'https://wftoon227.com/view?toon=184&num=43');
});

check('글자가 있는 링크가 class 만 맞은 링크보다 우선한다', () => {
  const doc = docOf(
    // 문서상 먼저 나오지만 class 만 맞은 링크다
    node('DIV', { class: 'nextpage' }, [node('A', { href: '/view?toon=999&num=1' }, '')]),
    node('LI', { class: 'next' }, [node('A', { href: '/view?toon=184&num=43' }, '다음화')])
  );
  assert.equal(findNext(doc), 'https://wftoon227.com/view?toon=184&num=43');
});

// 사이트는 작품 경계에서 404 를 주지 않는다 — alert 를 띄우는 링크를 준다
check('경계의 javascript:alert 링크를 회차 주소로 돌려주지 않는다', () => {
  const doc = docOf(
    node('UL', {}, [
      node('LI', { class: 'prev' }, [
        node('A', { href: "javascript:alert('이전화가없습니다.');" }, '이전화'),
      ]),
    ])
  );
  assert.equal(findPrev(doc), null, '이 href 를 이전 화로 돌려주면 경계에서 이동이 깨진다');
});

check('회차 주소가 아닌 href(#·mailto·빈 값)는 다음 화가 아니다', () => {
  assert.equal(findNext(docOf(node('A', { href: '#none' }, '다음화'))), null);
  assert.equal(findNext(docOf(node('A', { href: '#' }, '다음화'))), null);
  assert.equal(findNext(docOf(node('A', { href: 'mailto:admin@wftoon227.com' }, '다음화'))), null);
  assert.equal(findNext(docOf(node('A', { href: '' }, '다음화'))), null);
});

check('지금 보고 있는 페이지를 가리키는 링크는 건너뛴다', () => {
  const doc = docOf(
    node('A', { href: '/view?toon=184&num=42#top' }, '다음화'),
    node('LI', { class: 'next' }, [node('A', { href: '/view?toon=184&num=43' }, '다음화')])
  );
  assert.equal(findNext(doc), 'https://wftoon227.com/view?toon=184&num=43');
});

check('preview·preload 처럼 비슷한 class 는 이전화로 오인하지 않는다', () => {
  const doc = docOf(
    node('DIV', { class: 'preview-list' }, [node('A', { href: '/view?toon=900&num=1' }, '')])
  );
  assert.equal(findPrev(doc), null);
});

console.log(`\n${passed}개 통과`);
