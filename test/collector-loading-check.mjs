import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { buildNativeCollectorScript } from '../src/collector.js';
import { registerPlugin } from '@capacitor/core';

// 실제 페이지 구조: 먼저 뜨는 배너, 아직 비어 있는 번호별 본문 자리.
const banners = Array.from({ length: 5 }, (_, i) =>
  `<button data-banner-id="${i}"><img src="https://cdn.test/promo/p${i}.png" width="380" height="250"></button>`
).join('');
const slots = Array.from({ length: 4 }, (_, i) =>
  `<div data-theme-page="${i + 1}"><span>이미지 불러오는 중...</span></div>`
).join('');
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.route('https://cdn.test/**', (route) => route.abort());
  const collect = async () => JSON.parse(await page.evaluate(buildNativeCollectorScript()));
  await page.setContent(`<main>${banners}<div data-theme-viewer-images>${slots}</div></main>`);
  let result = await collect();
  assert.equal(result.collectorError, undefined);
  assert.equal(result.pending, true);
  assert.deepEqual(result.pages, [], '빈 본문 대신 배너를 수집하면 안 된다');

  await page.evaluate(() => {
    document.querySelector('[data-theme-page]').innerHTML = '<img data-src="https://cdn.test/comic/p1.png">';
  });
  result = await collect();
  assert.equal(result.pending, true);
  assert.deepEqual(result.pages, [], '일부 컷만 채워져도 완료로 처리하면 안 된다');

  await page.evaluate(() => {
    document.querySelectorAll('[data-theme-page]').forEach((slot, i) => {
      slot.innerHTML = `<img data-src="https://cdn.test/comic/p${i + 1}.png">`;
    });
  });
  result = await collect();
  assert.equal(result.pending, false);
  assert.deepEqual(result.pages, [1, 2, 3, 4].map((n) => `https://cdn.test/comic/p${n}.png`));

  await page.setContent(`<div data-theme-viewer-images>${[1, 2, 3, 4].map((n) =>
    `<img data-theme-page="${n}" data-src="https://cdn.test/comic/p${n}.png">`
  ).join('')}</div>`);
  result = await collect();
  assert.equal(result.pending, false, '페이지 번호가 이미지 자신에 있어도 준비 완료');
  assert.equal(result.pages.length, 4);

  await page.setContent(`<main>${banners}<div class="reading-content"><img data-src="https://cdn.test/comic/one.png"></div></main>`);
  result = await collect();
  assert.equal(result.pending, false);
  assert.deepEqual(result.pages, ['https://cdn.test/comic/one.png'], '한 장짜리 본문도 범위를 유지한다');

  await page.setContent(`<main>${banners}<img data-src="https://cdn.test/comic/one.png"></main>`);
  result = await collect();
  assert.deepEqual(result.pages, ['https://cdn.test/comic/one.png'], '본문 표식 없는 페이지도 명시적 배너 제외');

  if (process.env.MV_COLLECTOR_LIVE === '1') {
    await page.goto('https://newtoki1.org/webtoon/599/214627', { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 20_000;
    do {
      result = await collect();
      if (!result.pending && result.pages?.length) break;
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    assert.equal(result.collectorError, undefined);
    assert.equal(result.pending, false, '실제 페이지 본문 로딩 시간 초과');
    assert.ok(result.pages.length >= 4, '실제 본문 4개 자리가 모두 채워져야 한다');
    assert.match(result.title, /헬퍼 2/);
    assert.equal(new URL(result.sourceUrl).pathname, '/webtoon/599/214627');
    console.log(`실제 페이지: ${result.title}, 본문 ${result.pages.length}장 수집`);
  }
} finally {
  await browser.close();
}

// 실제 플랫폼 함수에 구형 APK의 빈 결과 실패를 주입한다.
let calls = [];
let mode = 'delayed';
registerPlugin('PageCollector', { web: () => ({
  async collect(options) {
    calls.push(options);
    if (mode === 'cancel') throw new Error('수집이 중단됐습니다.');
    if (mode === 'empty' || (mode === 'delayed' && calls.length < 3)) {
      throw new Error('이미지를 찾지 못했습니다.');
    }
    if (mode === 'auth' && options.silent) throw new Error('사이트 응답 403');
    return { pages: ['https://cdn.test/comic/p1.png'] };
  },
}) });
const { collectRenderedPage } = await import('../src/platform/pageCollector.js');
const url = 'https://newtoki1.org/webtoon/599/214627';
assert.equal((await collectRenderedPage(url)).pages.length, 1);
assert.equal(calls.length, 3);
assert.ok(calls.every((call) => call.silent && call.url === url));
mode = 'empty'; calls = [];
await assert.rejects(collectRenderedPage(url), /이미지를 찾지 못했습니다/);
assert.equal(calls.length, 3, '재시도는 제한되어야 한다');
mode = 'auth'; calls = [];
await collectRenderedPage(url);
assert.deepEqual(calls.map((call) => call.silent), [true, false]);
calls = [];
await assert.rejects(collectRenderedPage(url, { silent: true }), /403/);
assert.equal(calls.length, 1, '사전 수집에서 인증 화면을 띄우면 안 된다');
mode = 'cancel'; calls = [];
await assert.rejects(collectRenderedPage(url), /중단/);
assert.equal(calls.length, 1, '취소 후 수집 화면을 다시 열면 안 된다');
console.log('본문 지연·부분 로딩·배너 제외 및 구형 APK 자동 재시도 회귀 통과');
