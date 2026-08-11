/**
 * 수집기 자기 점검. 프레임워크 없이 `npm test` 로 돌린다.
 *
 * 브라우저가 필요 없는 순수 로직만 검증한다: parseRawText (주소 목록 붙여넣기).
 * 북마클릿 수집(collector.js)은 DOM 이 있어야 하므로 실제 페이지에서 확인한다.
 */
import assert from 'node:assert/strict';
import { UrlHarvester, bumpEpisodeParam } from '../src/urlHarvester.js';

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

console.log('\nbumpEpisodeParam');

check('toon과 num이 함께 있으면 num을 증감시킨다', () => {
  const target = 'https://wfwf436.com/cv?toon=10042&num=961';
  assert.equal(
    bumpEpisodeParam(target, +1),
    'https://wfwf436.com/cv?toon=10042&num=962'
  );
  assert.equal(
    bumpEpisodeParam(target, -1),
    'https://wfwf436.com/cv?toon=10042&num=960'
  );
});

check('일반적인 ep/no/chapter 파라미터 증감도 작동한다', () => {
  assert.equal(
    bumpEpisodeParam('https://example.com/view?no=10', +1),
    'https://example.com/view?no=11'
  );
  assert.equal(
    bumpEpisodeParam('https://example.com/view?episode=5', -1),
    'https://example.com/view?episode=4'
  );
});

console.log(`\n${passed}개 통과`);


