import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

async function firstRatioAnchorCalls(page, cdp, drag) {
  const point = await page.evaluate(async () => {
    document.body.replaceChildren();
    const container = document.createElement('main');
    container.className = 'manga-viewport mode-strip';
    container.style.height = '100vh';
    container.style.overflowY = 'auto';
    document.body.appendChild(container);

    const { ReaderEngine } = await import('/src/readerEngine.js');
    const engine = new ReaderEngine({
      container,
      mode: 'strip',
      resolvePageUrl: () => new Promise(() => {}),
    });
    const pages = Array.from({ length: 20 }, (_, index) => ({
      url: `deferred-${index}`,
      pageNumber: index + 1,
    }));
    engine.loadChapter({ pages }, 8);

    const calls = [];
    engine.scrollStripToIndex = (index) => calls.push(index);
    window.__anchorTest = { calls, engine };

    const bounds = container.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  });

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y + 40 }],
  });
  if (drag) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y: point.y }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  return page.evaluate(() => {
    window.__anchorTest.engine.recordRatio(0, 720, 1600);
    return window.__anchorTest.calls;
  });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
});
await vite.listen();

let browser;
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 }, hasTouch: true });
  const page = await context.newPage();
  const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
  await page.goto(origin);
  await page.locator('#modal-episodes .close-modal').click();

  await page.evaluate(() => {
    document.getElementById('app').classList.remove('is-empty');
    const viewport = document.getElementById('manga-container');
    viewport.className = 'manga-viewport mode-strip';
    const strip = document.createElement('div');
    strip.className = 'manga-strip-page';
    strip.style.height = '4000px';
    viewport.replaceChildren(strip);
  });

  const bounds = await page.locator('#manga-container').boundingBox();
  assert.ok(bounds, '웹툰 스크롤 영역이 보여야 한다');
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  assert.equal(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#manga-container') !== null, center),
    true,
    '중앙 투명 버튼이 웹툰 스크롤 영역을 가리면 안 된다'
  );

  const cdp = await context.newCDPSession(page);
  for (let i = 0; i < 3; i++) {
    const before = await page.locator('#manga-container').evaluate((node) => node.scrollTop);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: center.x, y: center.y + 200 }],
    });
    for (let step = 1; step <= 4; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: center.x, y: center.y + 200 - step * 100 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction((top) => document.getElementById('manga-container').scrollTop > top, before);
  }

  assert.deepEqual(
    await firstRatioAnchorCalls(page, cdp, false),
    [7],
    '단순 탭은 첫 이미지 비율 확정 뒤 저장 페이지 앵커를 유지해야 한다'
  );
  assert.deepEqual(
    await firstRatioAnchorCalls(page, cdp, true),
    [],
    '실제 세로 drag는 첫 이미지 비율의 과거 위치 복원을 취소해야 한다'
  );

  console.log('webtoon scroll: 중앙 반복 입력 + 첫 비율 앵커 통과');
} finally {
  await browser?.close();
  await vite.close();
}
