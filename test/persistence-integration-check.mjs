import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stateKeys = [
  'mangaViewer.settings',
  'mangaViewer.progress',
  'mangaViewer.lastChapterId',
];

async function stateSnapshot(page) {
  return page.evaluate(async (localKeys) => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewerState');
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['catalog', 'kv'], 'readonly');
    const request = (req) => new Promise((resolveRequest, reject) => {
      req.onsuccess = () => resolveRequest(req.result);
      req.onerror = () => reject(req.error);
    });
    const catalog = await request(tx.objectStore('catalog').getAll());
    const kv = await request(tx.objectStore('kv').getAll());
    db.close();
    return {
      catalog,
      kv: Object.fromEntries(kv.map((row) => [row.key, row.value])),
      local: Object.fromEntries(localKeys.map((key) => [key, localStorage.getItem(key)])),
    };
  }, stateKeys);
}

async function legacyCounts(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewer', 2);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = (req) => new Promise((resolveRequest, reject) => {
      req.onsuccess = () => resolveRequest(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(['chapters', 'recent_chapters'], 'readonly');
    const result = {
      chapters: await request(tx.objectStore('chapters').count()),
      recent: await request(tx.objectStore('recent_chapters').count()),
    };
    db.close();
    return result;
  });
}

const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
console.log('  vite ready');
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  console.log('  browser ready');
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('[browser]', error));
  await page.route(`${origin}/seed`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>seed</title>',
  }));
  await page.goto(`${origin}/seed`);
  console.log('  seed page ready');

  await page.evaluate(async () => {
    const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
    localStorage.setItem('mangaViewer.settings', JSON.stringify({
      mode: 'strip', direction: 'LTR', transition: 'fade', speed: 9, brightness: 88, paper: 'warm',
    }));
    localStorage.setItem('mangaViewer.progress', JSON.stringify({ 'legacy-1000': 1 }));
    localStorage.setItem('mangaViewer.lastChapterId', 'legacy-1000');
    localStorage.setItem('mangaViewer.hasInitialized', 'true');
    localStorage.setItem('mangaViewer.recentChapters', JSON.stringify([{
      id: 'local-only',
      title: '원피스 1003화',
      pages: [{ url: image }],
      sourceUrl: 'https://legacy.test/read/1003',
      savedAt: 3000,
    }]));

    await new Promise((resolveDelete, reject) => {
      const request = indexedDB.deleteDatabase('mangaViewer');
      request.onsuccess = resolveDelete;
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewer', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('chapters', { keyPath: 'id' });
        db.createObjectStore('pages', { keyPath: 'url' });
        db.createObjectStore('recent_chapters', { keyPath: 'id' });
        const tx = request.transaction;
        const chapters = tx.objectStore('chapters');
        const recent = tx.objectStore('recent_chapters');
        for (let index = 0; index < 1001; index++) {
          const row = {
            id: `legacy-${index}`,
            title: `원피스 ${index + 1}화`,
            label: `${index + 1}화`,
            pages: [{ url: image, pageNumber: 1 }],
            sourceUrl: `https://legacy.test/read/${index + 1}`,
            savedAt: index + 1,
          };
          chapters.put(row);
          if (index < 30) recent.put(row);
        }
        recent.put({
          id: 'recent-only',
          title: '원피스 1002화',
          pages: [{ url: image, pageNumber: 1 }],
          sourceUrl: 'https://legacy.test/read/1002',
          savedAt: 2000,
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolveOpen();
      };
      request.onerror = () => reject(request.error);
    });
  });
  console.log('  legacy seeded');

  await page.unroute(`${origin}/seed`);
  await page.addInitScript(() => {
    window.__idbClearCalls = [];
    const original = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear = function (...args) {
      window.__idbClearCalls.push(this.name);
      return original.apply(this, args);
    };
  });
  await page.goto(origin);
  console.log('  app loaded');
  await page.waitForFunction(
    () => document.querySelector('.shelf-count')?.textContent.includes('1003'),
    null,
    { timeout: 20000 }
  );
  console.log('  migration UI ready');

  const migrated = await stateSnapshot(page);
  assert.equal(migrated.catalog.length, 1003, '세 legacy 원본을 실제 앱 부팅에서 전부 마이그레이션');
  assert.equal(migrated.kv['migration.v1'], 'complete');
  assert.equal(migrated.kv.lastChapterId, 'legacy-1000');
  assert.equal(migrated.kv.settings.direction, 'LTR');
  // 보기 모드도 남는다. 예전엔 저장에서 mode 만 빼서 화를 넘길 때마다 auto 로 풀렸다
  assert.equal(migrated.kv.settings.mode, 'strip', '한 번 고른 보기 모드는 다시 바꿀 때까지 유지된다');
  assert.deepEqual(await legacyCounts(page), { chapters: 1001, recent: 31 }, 'legacy 원본 유지');
  assert.deepEqual(await page.evaluate(() => window.__idbClearCalls), [], '부팅 중 store.clear 금지');

  await page.click('#modal-episodes .close-modal');
  await page.click('#btn-import');
  await page.fill('#raw-input', 'https://images.test/new-1.jpg\nhttps://images.test/new-2.jpg');
  await page.click('#btn-submit-url');
  console.log('  import submitted');
  await page.waitForFunction(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewerState');
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolveCount, reject) => {
      const request = db.transaction('catalog').objectStore('catalog').count();
      request.onsuccess = () => resolveCount(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count === 1004;
  }, null, { timeout: 20000 });
  console.log('  import persisted');

  const beforeLocalRemoval = await stateSnapshot(page);
  await page.evaluate((localKeys) => localKeys.forEach((key) => localStorage.removeItem(key)), stateKeys);
  await page.reload();
  console.log('  local storage removed and reloaded');
  await page.waitForFunction(() => {
    const counts = [...document.querySelectorAll('.shelf-count')]
      .map((node) => Number(node.textContent.match(/\d+/)?.[0] || 0));
    return counts.reduce((sum, count) => sum + count, 0) === 1004;
  }, null, { timeout: 20000 });

  const restored = await stateSnapshot(page);
  assert.equal(restored.catalog.length, 1004, 'import도 reload 뒤 catalog에 유지');
  assert.deepEqual(JSON.parse(restored.local['mangaViewer.settings']), beforeLocalRemoval.kv.settings);
  assert.deepEqual(JSON.parse(restored.local['mangaViewer.progress']), restored.kv.progress);
  assert.equal(restored.local['mangaViewer.lastChapterId'], restored.kv.lastChapterId);
  assert.deepEqual(await legacyCounts(page), { chapters: 1001, recent: 31 }, 'reload 뒤 legacy 원본 유지');
  assert.deepEqual(await page.evaluate(() => window.__idbClearCalls), [], 'reload 중 store.clear 금지');

  const progressAfterStorageFailure = await page.evaluate(async () => {
    const state = await import('/src/state.js');
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === state.PROGRESS_KEY) throw new Error('forced progress read failure');
      return originalGet.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === state.PROGRESS_KEY) throw new Error('forced progress write failure');
      return originalSet.call(this, key, value);
    };
    try {
      await state.saveProgress('after-storage-failure', 7);
      const db = await new Promise((resolveOpen, reject) => {
        const request = indexedDB.open('mangaViewerState');
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise((resolveRow, reject) => {
        const request = db.transaction('kv').objectStore('kv').get('progress');
        request.onsuccess = () => resolveRow(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return row.value;
    } finally {
      Storage.prototype.getItem = originalGet;
      Storage.prototype.setItem = originalSet;
    }
  });
  assert.equal(progressAfterStorageFailure['legacy-1000'], 1, 'localStorage 실패가 기존 progress를 지우지 않음');
  assert.equal(progressAfterStorageFailure['after-storage-failure'], 7);

  /**
   * 서재 삭제. 편집 모드에서 회차 줄의 삭제 버튼을 두 번 누른다.
   * 목록·오프라인 바이트·읽은 위치가 함께 지워져야 하고, 읽던 화를 지우면 다른 화로 옮겨야 한다.
   */
  await page.locator('.shelf-card', { hasText: '원피스' }).click();
  await page.click('#btn-shelf-edit');
  const catalogBefore = (await stateSnapshot(page)).catalog.length;

  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    window.__restoreTransaction = () => { IDBDatabase.prototype.transaction = original; };
    IDBDatabase.prototype.transaction = function (stores, mode, ...args) {
      const names = typeof stores === 'string' ? [stores] : [...stores];
      if (mode === 'readwrite' && names.includes('chapters')) {
        throw new Error('forced offline delete failure');
      }
      return original.call(this, stores, mode, ...args);
    };
  });
  const savedRow = page.locator('.shelf-ep-item:not(.is-current)', { hasText: '담김' }).first();
  await savedRow.locator('.shelf-ep-del').click();
  assert.equal((await stateSnapshot(page)).catalog.length, catalogBefore, '첫 탭은 지우지 않고 확인만 묻는다');
  await savedRow.locator('.shelf-ep-del.is-armed').click();
  await page.waitForFunction(() => document.querySelector('#toast.is-error')?.textContent.includes('오프라인'));
  await page.evaluate(() => window.__restoreTransaction());
  assert.equal((await legacyCounts(page)).chapters, 1001, 'offline 삭제 실패 시 원본 바이트 유지');
  assert.equal((await stateSnapshot(page)).catalog.length, catalogBefore - 1, '목록 삭제는 끝난다');

  // 성공 경로: 담긴 화를 지우면 오프라인 바이트도 같이 빠진다
  const okRow = page.locator('.shelf-ep-item:not(.is-current)', { hasText: '담김' }).first();
  await okRow.locator('.shelf-ep-del').click();
  await okRow.locator('.shelf-ep-del.is-armed').click();
  await page.waitForFunction(async (before) => {
    const db = await new Promise((resolveOpen) => {
      const request = indexedDB.open('mangaViewerState');
      request.onsuccess = () => resolveOpen(request.result);
    });
    const count = await new Promise((resolveCount) => {
      const request = db.transaction('catalog').objectStore('catalog').count();
      request.onsuccess = () => resolveCount(request.result);
    });
    db.close();
    return count === before - 2;
  }, catalogBefore);
  // 바이트 삭제는 목록 삭제 뒤에 이어진다 — 끝날 때까지 기다린다
  for (let i = 0; i < 50 && (await legacyCounts(page)).chapters !== 1000; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await legacyCounts(page)).chapters, 1000, '지운 화의 오프라인 바이트도 지워진다');

  // 읽던 화가 든 작품을 통째로 지우면 다른 화로 옮긴다 (읽던 화 = 위에서 붙여넣은 만화)
  const currentId = await page.evaluate(async () => (await import('/src/state.js')).readLastChapterId());
  const currentTitle = await page.textContent('#manga-title');
  await page.click('.shelf-back-btn');
  await page.locator('.shelf-card', { hasText: currentTitle }).click();
  await page.locator('.shelf-episodes-header .shelf-card-delete-action').click();
  await page.locator('.shelf-episodes-header .shelf-card-delete-action.is-armed').click();
  await page.waitForFunction((title) => document.querySelector('#manga-title')?.textContent !== title, currentTitle);
  const afterCurrent = await stateSnapshot(page);
  assert.equal(afterCurrent.catalog.length, catalogBefore - 3, '읽던 화도 목록에서 지워진다');
  assert.ok(!afterCurrent.catalog.some((item) => item.id === currentId), '지운 화가 목록에 남으면 안 된다');
  assert.ok(!(currentId in afterCurrent.kv.progress), '지운 화의 읽은 위치도 지워진다');
  assert.equal(await page.locator('.shelf-episodes-view').count(), 0, '작품이 사라지면 책장으로 돌아간다');
  await page.click('#btn-shelf-edit');
  console.log('  shelf delete ok');

  for (const mode of ['malformed', 'inaccessible']) {
    const badContext = await browser.newContext();
    const badPage = await badContext.newPage();
    await badPage.route(`${origin}/seed-${mode}`, (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>seed</title>',
    }));
    await badPage.goto(`${origin}/seed-${mode}`);
    if (mode === 'malformed') {
      await badPage.evaluate(() => localStorage.setItem('mangaViewer.recentChapters', '{broken'));
    } else {
      await badPage.addInitScript(() => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (key === 'mangaViewer.recentChapters') throw new Error('forced legacy recent access failure');
          return original.call(this, key);
        };
      });
    }
    await badPage.goto(origin);
    await badPage.waitForFunction(
      () => document.querySelector('#empty-state h2')?.textContent.includes('저장소'),
      null,
      { timeout: 20000 }
    );
    const marker = await badPage.evaluate(async () => {
      const db = await new Promise((resolveOpen, reject) => {
        const request = indexedDB.open('mangaViewerState');
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise((resolveRow, reject) => {
        const request = db.transaction('kv').objectStore('kv').get('migration.v1');
        request.onsuccess = () => resolveRow(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return row?.value;
    });
    assert.equal(marker, undefined, `${mode} legacy recent 오류에서 migration marker 금지`);
    await badContext.close();
  }

  const lastIdContext = await browser.newContext();
  const lastIdPage = await lastIdContext.newPage();
  await lastIdPage.route(`${origin}/seed-last-id`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>seed</title>',
  }));
  await lastIdPage.goto(`${origin}/seed-last-id`);
  await lastIdPage.evaluate(async () => {
    const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
    await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewerState', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const catalog = db.createObjectStore('catalog', { keyPath: 'id' });
        const kv = db.createObjectStore('kv', { keyPath: 'key' });
        catalog.put({ id: 'chapter-a', title: '첫 번째 화', pages: [{ url: image }] });
        catalog.put({ id: 'chapter-b', title: '기억한 두 번째 화', pages: [{ url: image }] });
        kv.put({ key: 'lastChapterId', value: 'chapter-b' });
        kv.put({ key: 'migration.v1', value: 'complete' });
      };
      request.onsuccess = () => {
        request.result.close();
        resolveOpen();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await lastIdPage.addInitScript(() => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'mangaViewer.lastChapterId') throw new Error('forced last id read failure');
      return originalGet.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'mangaViewer.lastChapterId') throw new Error('forced last id write failure');
      return originalSet.call(this, key, value);
    };
  });
  await lastIdPage.goto(origin);
  await lastIdPage.waitForFunction(() => document.querySelector('#manga-title')?.textContent === '기억한 두 번째 화');
  assert.equal(await lastIdPage.textContent('#manga-title'), '기억한 두 번째 화');
  assert.equal(
    await lastIdPage.evaluate(async () => (await import('/src/state.js')).readLastChapterId()),
    'chapter-b',
    'localStorage 접근 실패에도 in-memory last ID 유지'
  );
  await lastIdContext.close();

  const initializedContext = await browser.newContext();
  const initializedPage = await initializedContext.newPage();
  await initializedPage.route(`${origin}/seed-initialized`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>seed</title>',
  }));
  await initializedPage.goto(`${origin}/seed-initialized`);
  await initializedPage.evaluate(async () => {
    await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewerState', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('catalog', { keyPath: 'id' });
        const kv = db.createObjectStore('kv', { keyPath: 'key' });
        kv.put({ key: 'migration.v1', value: 'complete' });
      };
      request.onsuccess = () => {
        request.result.close();
        resolveOpen();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await initializedPage.goto(origin);
  await initializedPage.waitForFunction(() => document.querySelector('#empty-state h2')?.textContent.includes('불러온'));
  const initializedCatalogCount = async () => initializedPage.evaluate(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewerState');
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolveCount, reject) => {
      const request = db.transaction('catalog').objectStore('catalog').count();
      request.onsuccess = () => resolveCount(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
  assert.equal(await initializedCatalogCount(), 0, '빈 서재로 시작하면 샘플 없이 비어 있어야 한다');

  await initializedPage.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'catalog') throw new Error('forced catalog write failure');
      return original.apply(this, args);
    };
  });
  await initializedPage.click('#empty-import');
  await initializedPage.fill('#raw-input', 'https://images.test/fail-1.jpg\nhttps://images.test/fail-2.jpg');
  await initializedPage.click('#btn-submit-url');
  await initializedPage.waitForFunction(() => document.querySelector('#toast.is-error')?.textContent.includes('forced'));
  assert.doesNotMatch(await initializedPage.textContent('#toast'), /장 불러왔습니다/);
  assert.equal(await initializedCatalogCount(), 0, 'catalog write 실패를 성공 import로 처리하지 않음');
  await initializedContext.close();

  const failureContext = await browser.newContext();
  const failurePage = await failureContext.newPage();
  await failurePage.addInitScript(() => {
    const originalOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, ...args) => {
      if (name === 'mangaViewerState') throw new Error('forced state storage failure');
      return originalOpen(name, ...args);
    };
  });
  await failurePage.goto(origin);
  await failurePage.waitForFunction(
    () => document.querySelector('#empty-state h2')?.textContent.includes('저장소'),
    null,
    { timeout: 20000 }
  );
  await failureContext.close();

  await context.close();
  console.log('persistence integration: actual app migration 1003 + import + kv fallback + failure gate 통과');
} finally {
  await browser?.close();
  await vite.close();
}
