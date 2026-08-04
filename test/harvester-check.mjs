/**
 * 수집기 자기 점검. 프레임워크 없이 `node test/harvester-check.mjs` 로 돌린다.
 *
 * 여기서 검증하는 것은 브라우저가 필요 없는 순수 로직뿐이다:
 *   - keepDominantDirectory : 본문 컷 묶음 골라내기
 *   - parseRawText          : 주소 목록 붙여넣기
 */
import assert from 'node:assert/strict';
import { UrlHarvester, keepDominantDirectory } from '../src/urlHarvester.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('keepDominantDirectory');

check('4장 미만이면 손대지 않는다', () => {
  const urls = ['https://a.test/x/1.jpg', 'https://a.test/y/2.jpg'];
  assert.deepEqual(keepDominantDirectory(urls), urls);
});

check('디렉터리가 하나면 그대로 둔다', () => {
  const urls = [
    'https://cdn.test/ch3/001.webp',
    'https://cdn.test/ch3/002.webp',
    'https://cdn.test/ch3/003.webp',
    'https://cdn.test/ch3/004.webp',
  ];
  assert.deepEqual(keepDominantDirectory(urls), urls);
});

check('배너에 섞인 본문 묶음만 남긴다', () => {
  const urls = [
    'https://ads.test/banner-top.png',
    'https://cdn.test/ch3/001.webp',
    'https://cdn.test/ch3/002.webp',
    'https://cdn.test/ch3/003.webp',
    'https://cdn.test/ch3/004.webp',
    'https://misc.test/profile.png',
  ];
  assert.deepEqual(keepDominantDirectory(urls), [
    'https://cdn.test/ch3/001.webp',
    'https://cdn.test/ch3/002.webp',
    'https://cdn.test/ch3/003.webp',
    'https://cdn.test/ch3/004.webp',
  ]);
});

check('본문 순서를 뒤섞지 않는다', () => {
  const urls = [
    'https://cdn.test/ch3/001.webp',
    'https://ads.test/a.png',
    'https://cdn.test/ch3/002.webp',
    'https://cdn.test/ch3/003.webp',
  ];
  assert.deepEqual(keepDominantDirectory(urls), [
    'https://cdn.test/ch3/001.webp',
    'https://cdn.test/ch3/002.webp',
    'https://cdn.test/ch3/003.webp',
  ]);
});

check('뚜렷한 다수가 없으면 전부 살린다', () => {
  const urls = [
    'https://a.test/1/x.jpg',
    'https://b.test/2/y.jpg',
    'https://c.test/3/z.jpg',
    'https://d.test/4/w.jpg',
  ];
  assert.deepEqual(keepDominantDirectory(urls), urls);
});

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

check('빈 입력은 빈 배열', () => {
  assert.deepEqual(UrlHarvester.parseRawText(''), []);
  assert.deepEqual(UrlHarvester.parseRawText('   '), []);
  assert.deepEqual(UrlHarvester.parseRawText(null), []);
});

console.log(`\n${passed}개 통과`);
