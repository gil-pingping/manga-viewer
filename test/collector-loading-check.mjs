import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { buildNativeCollectorScript } from '../src/collector.js';
import { registerPlugin } from '@capacitor/core';
import { imageRequestHeaders } from '../src/shared/proxyRules.js';

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
  const collect = async (targetUrl = null) => JSON.parse(await page.evaluate(buildNativeCollectorScript(targetUrl)));
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

  const expectedUrl = 'https://newtoki1.org/webtoon/599/214627';
  await page.route('https://newtoki1.org/**', (route) => route.fulfill({
    contentType: 'text/html', body: `<title>광고</title><main>${banners}</main>`,
  }));
  await page.goto('https://newtoki1.org/promotion');
  result = JSON.parse(await page.evaluate(buildNativeCollectorScript(expectedUrl)));
  assert.match(result.collectorError || '', /COLLECTOR_WRONG_PAGE/, '다른 페이지를 요청한 회차로 받아들이면 안 된다');
  await page.goto(expectedUrl);
  result = JSON.parse(await page.evaluate(buildNativeCollectorScript(expectedUrl)));
  assert.equal(result.pending, true, '같은 URL이어도 본문 표식 없는 응답은 기다린다');
  assert.deepEqual(result.pages, []);
  await page.unroute('https://newtoki1.org/**');

  if (process.env.MV_COLLECTOR_LIVE === '1') {
    await page.goto('https://newtoki1.org/webtoon/599/214627', { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 20_000;
    do {
      result = await collect(expectedUrl);
      if (!result.pending && result.pages?.length) break;
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    assert.equal(result.collectorError, undefined);
    assert.equal(result.pending, false, '실제 페이지 본문 로딩 시간 초과');
    assert.ok(result.pages.length >= 4, '실제 본문 4개 자리가 모두 채워져야 한다');
    assert.match(result.title, /헬퍼 2/);
    assert.equal(new URL(result.sourceUrl).pathname, '/webtoon/599/214627');
    // URL 개수만 확인하지 않는다. 앱과 같은 요청 헤더로 실제 컷을 받아 디코딩한다.
    for (const [index, imageUrl] of result.pages.entries()) {
      const response = await fetch(imageUrl, {
        headers: { ...imageRequestHeaders(expectedUrl),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const dimensions = await page.evaluate(async (base64) => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]));
        const size = { width: image.width, height: image.height };
        image.close();
        return size;
      }, bytes.toString('base64'));
      assert.ok(dimensions.width >= 500 && dimensions.height >= 1000, '해당 화의 세로 본문 컷이어야 한다');
      console.log(`  실제 컷 ${index + 1}: ${dimensions.width}×${dimensions.height}, ${bytes.length} bytes`);
    }
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
    if (mode === 'redirect' && calls.length === 1) throw new Error('Error: COLLECTOR_WRONG_PAGE');
    if (mode === 'redirect-always') throw new Error('Error: COLLECTOR_WRONG_PAGE');
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
assert.ok(calls.every((call) => call.script.includes(JSON.stringify(url))), '주입 수집기에 요청한 회차를 고정한다');
mode = 'redirect'; calls = [];
await collectRenderedPage(url);
assert.equal(calls.length, 2, '다른 페이지로 이동했으면 원본 회차를 다시 연다');
mode = 'redirect-always'; calls = [];
await assert.rejects(collectRenderedPage(url), /다른 페이지/);
assert.equal(calls.length, 3);
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

// 정적 HTTP 경로도 본문 없는 200 응답의 광고를 성공으로 확정하면 안 된다.
const { UrlHarvester } = await import('../src/urlHarvester.js');
const previousFetch = globalThis.fetch;
const previousParser = globalThis.DOMParser;
const requests = [];
try {
  globalThis.DOMParser = class {
    parseFromString() {
      return { querySelector: () => null, querySelectorAll: () => {
        throw new Error('본문 없는 응답에서 광고 이미지 선별을 시작했습니다');
      } };
    }
  };
  globalThis.fetch = async (request) => {
    requests.push(request);
    if (request.startsWith('/api/fetch-page?')) return new Response(`<main>${banners}</main>`);
    assert.ok(request.startsWith('/api/render-page?'));
    return Response.json({ ok: true, sourceUrl: url, pages: ['https://cdn.test/comic/p1.png'] });
  };
  const harvested = await UrlHarvester.fetchFromUrl(url);
  assert.equal(requests.length, 2);
  assert.equal(harvested.pages[0].originalUrl, 'https://cdn.test/comic/p1.png');
} finally {
  globalThis.fetch = previousFetch;
  if (previousParser === undefined) delete globalThis.DOMParser;
  else globalThis.DOMParser = previousParser;
}
console.log('본문 지연·부분 로딩·배너 제외 및 구형 APK 자동 재시도 회귀 통과');
