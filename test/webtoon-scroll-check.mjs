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

async function swipeUp(cdp, point, distance = 120) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y }],
  });
  for (let step = 1; step <= 3; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y: point.y - (distance * step) / 3 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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

  const appendResult = await page.evaluate(async () => {
    document.body.replaceChildren();
    const container = document.createElement('main');
    container.className = 'manga-viewport mode-strip';
    container.style.position = 'relative';
    container.style.inset = 'auto';
    container.style.width = '800px';
    container.style.height = '220px';
    container.style.overflowY = 'auto';
    container.style.scrollBehavior = 'auto';
    document.body.appendChild(container);

    const { ReaderEngine } = await import('/src/readerEngine.js');
    const engine = new ReaderEngine({
      container,
      mode: 'strip',
      resolvePageUrl: () => new Promise(() => {}),
    });
    const originalPages = [
      { url: 'chapter-1-page-1', pageNumber: 1 },
      { url: 'chapter-1-page-2', pageNumber: 2 },
    ];
    engine.loadChapter(
      {
        id: 'chapter-1',
        sourceUrl: 'https://example.test/webtoon/1',
        title: '작품 1화',
        label: '1화',
        pages: originalPages,
      },
      1
    );
    for (const wrapper of container.querySelectorAll('.manga-strip-page')) {
      wrapper.style.height = '300px';
      wrapper.style.minHeight = '300px';
      wrapper.style.aspectRatio = 'auto';
    }
    const firstWrapper = container.firstElementChild;
    if (container.scrollHeight - container.clientHeight < 123) {
      throw new Error('append 검사 fixture에 123px scroll range가 필요합니다.');
    }
    container.scrollTop = 123;
    if (container.scrollTop !== 123) throw new Error('append 전 scrollTop=123 설정에 실패했습니다.');

    const appended = engine.appendChapter({
      id: 'chapter-2',
      sourceUrl: 'https://example.test/webtoon/2',
      title: '작품 2화',
      label: '2화',
      pages: [
        { url: 'chapter-2-page-1', pageNumber: 1 },
        { url: 'chapter-2-page-2', pageNumber: 2 },
      ],
    });
    const duplicateId = engine.appendChapter({
      id: 'chapter-2',
      sourceUrl: 'https://example.test/webtoon/other',
      pages: [{ url: 'duplicate-id' }],
    });
    const duplicateSource = engine.appendChapter({
      id: 'chapter-other',
      sourceUrl: 'https://example.test/webtoon/2',
      pages: [{ url: 'duplicate-source' }],
    });
    const appendScrollTop = container.scrollTop;

    engine.currentIndex = 2;
    const pageTwo = engine.getPageForCurrentChapter(2);
    const info = engine.getPageInfo();
    engine.goToPage(2);

    return {
      appended,
      duplicateId,
      duplicateSource,
      wrapperPreserved: firstWrapper === container.firstElementChild,
      scrollTop: appendScrollTop,
      pageCount: engine.pages.length,
      originalUntouched:
        engine.pages[0] !== originalPages[0] &&
        !Object.hasOwn(originalPages[0], 'chapterId') &&
        !Object.hasOwn(originalPages[0], 'chapterPageNumber'),
      pageTwoUrl: pageTwo?.url,
      info,
      localGoToIndex: engine.currentIndex,
    };
  });
  assert.equal(appendResult.appended, true, '다음 화를 strip 아래에 붙여야 한다');
  assert.equal(appendResult.duplicateId, false, '같은 chapter id를 중복 append하면 안 된다');
  assert.equal(appendResult.duplicateSource, false, '같은 source 주소를 중복 append하면 안 된다');
  assert.equal(appendResult.wrapperPreserved, true, '기존 strip wrapper DOM을 유지해야 한다');
  assert.equal(appendResult.scrollTop, 123, 'append 전 스크롤 위치를 유지해야 한다');
  assert.equal(appendResult.pageCount, 4, '중복을 제외한 두 화 페이지만 남아야 한다');
  assert.equal(appendResult.originalUntouched, true, 'loadChapter가 원본 page 객체를 바꾸면 안 된다');
  assert.equal(appendResult.pageTwoUrl, 'chapter-2-page-2', '현재 화 로컬 페이지를 찾아야 한다');
  assert.deepEqual(
    appendResult.info,
    {
      currentIndex: 2,
      currentPageNum: 1,
      totalPages: 2,
      effectiveMode: 'strip',
      chapterId: 'chapter-2',
      title: '작품 2화',
      label: '2화',
    },
    'append 뒤 페이지 정보는 현재 화 기준이어야 한다'
  );
  assert.equal(appendResult.localGoToIndex, 3, 'goToPage는 현재 화 안에서 이동해야 한다');

  const bottomPoint = await page.evaluate(async () => {
    document.body.replaceChildren();
    const container = document.createElement('main');
    container.className = 'manga-viewport mode-strip';
    container.style.position = 'relative';
    container.style.inset = 'auto';
    container.style.width = '800px';
    container.style.height = '400px';
    container.style.overflowY = 'auto';
    container.style.scrollBehavior = 'auto';
    document.body.appendChild(container);

    const { ReaderEngine } = await import('/src/readerEngine.js');
    let episodeEndCalls = 0;
    const engine = new ReaderEngine({
      container,
      mode: 'strip',
      resolvePageUrl: () => new Promise(() => {}),
      onEpisodeEnd: () => episodeEndCalls++,
    });
    engine.loadChapter({
      id: 'bottom-test',
      pages: [
        { url: 'bottom-page-1', pageNumber: 1 },
        { url: 'bottom-page-2', pageNumber: 2 },
      ],
    });
    for (const wrapper of container.querySelectorAll('.manga-strip-page')) {
      wrapper.style.height = '600px';
      wrapper.style.minHeight = '600px';
      wrapper.style.aspectRatio = 'auto';
    }
    const startTop = container.scrollHeight - container.clientHeight - 30;
    if (startTop < 0) throw new Error('bottom 검사 fixture에 scroll range가 필요합니다.');
    container.scrollTop = startTop;
    if (container.scrollTop !== startTop) throw new Error('bottom 직전 scrollTop 설정에 실패했습니다.');
    window.__bottomTest = {
      container,
      getEpisodeEndCalls: () => episodeEndCalls,
      resetEpisodeEndCalls: () => {
        episodeEndCalls = 0;
      },
    };

    const bounds = container.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 + 100 };
  });

  await swipeUp(cdp, bottomPoint);
  await page.waitForFunction(() => {
    const { container } = window.__bottomTest;
    return container.scrollTop + container.clientHeight >= container.scrollHeight - 8;
  });
  assert.equal(
    await page.evaluate(() => window.__bottomTest.getEpisodeEndCalls()),
    0,
    '마지막 컷에 처음 도달한 swipe는 다음 화를 열면 안 된다'
  );

  await swipeUp(cdp, bottomPoint);
  assert.equal(
    await page.evaluate(() => window.__bottomTest.getEpisodeEndCalls()),
    1,
    'bottom에서 추가 upward swipe할 때 다음 화를 정확히 한 번 열어야 한다'
  );

  const wheelArrivalResult = await page.evaluate(() => {
    const { container, getEpisodeEndCalls, resetEpisodeEndCalls } = window.__bottomTest;
    resetEpisodeEndCalls();
    const bottom = container.scrollHeight - container.clientHeight;

    container.scrollTop = bottom - 20;
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
    container.scrollTop = bottom;
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
    const arrivalBurstCalls = getEpisodeEndCalls();

    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    const upwardCalls = getEpisodeEndCalls();
    return { arrivalBurstCalls, upwardCalls };
  });
  assert.equal(
    wheelArrivalResult.arrivalBurstCalls,
    0,
    'bottom에 도착한 같은 wheel burst는 다음 화를 열면 안 된다'
  );
  assert.equal(wheelArrivalResult.upwardCalls, 0, 'bottom의 위쪽 wheel은 다음 화를 열면 안 된다');

  await page.waitForTimeout(650);
  const wheelBurstCalls = await page.evaluate(() => {
    const { container, getEpisodeEndCalls } = window.__bottomTest;
    for (let i = 0; i < 3; i++) {
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
    }
    return getEpisodeEndCalls();
  });
  assert.equal(wheelBurstCalls, 1, 'idle 뒤 bottom wheel burst는 다음 화를 한 번만 열어야 한다');

  console.log('webtoon scroll: 반복 입력 + 앵커 + 연속 화 + bottom 추가 swipe/wheel 통과');
} finally {
  await browser?.close();
  await vite.close();
}
