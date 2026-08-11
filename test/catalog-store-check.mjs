import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { mergeLegacyCatalog, normalizeSourceUrl } from '../src/catalogStore.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

assert.equal(
  normalizeSourceUrl(' HTTPS://Example.COM/reader/42/#page-3 '),
  'https://example.com/reader/42'
);

const oldPages = [{ url: 'old-page' }];
const merged = mergeLegacyCatalog(
  [
    {
      id: 'chapter-1',
      title: '예전 제목',
      pages: oldPages,
      coverUrl: 'old-cover',
      sourceUrl: 'https://example.com/read/1/',
      savedAt: 1,
      oldOnly: '보존',
    },
    { id: 'no-url', title: 'URL 없음' },
  ],
  [
    {
      id: 'chapter-1',
      title: '새 제목',
      pages: [],
      coverUrl: '',
      sourceUrl: 'https://example.com/read/1',
      updatedAt: 3,
      newOnly: '추가',
    },
    {
      id: 'different-id',
      label: '같은 URL',
      sourceUrl: 'https://EXAMPLE.com/read/1/#ignored',
      updatedAt: 4,
    },
  ]
);

assert.equal(merged.length, 2, 'id 병합 뒤 정규화 URL로 다시 중복 제거');
assert.deepEqual(merged[0].pages, oldPages, '빈 최신 pages가 기존 pages를 지우지 않음');
assert.equal(merged[0].coverUrl, 'old-cover', '빈 최신 cover가 기존 cover를 지우지 않음');
assert.equal(merged[0].title, '새 제목', '최신 비어 있지 않은 필드 사용');
assert.equal(merged[0].label, '같은 URL');
assert.equal(merged[0].oldOnly, '보존', '알 수 없는 기존 필드도 보존');
assert.equal(merged[0].newOnly, '추가', '알 수 없는 최신 필드도 보존');
assert.equal(merged[0].id, 'chapter-1', 'sourceUrl 중복 병합에서도 기존 id 유지');
assert.deepEqual(
  mergeLegacyCatalog([{ id: 'x', pages: oldPages }]),
  [{ id: 'x', pages: oldPages }],
  '입력을 변경하지 않고 값도 손실하지 않음'
);

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/src/catalogStore.js')) {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(await readFile(resolve(root, 'src/catalogStore.js')));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>catalog store check</title>');
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const { port } = server.address();
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);

  const migrationFailure = await page.evaluate(async () => {
    await new Promise((resolveDelete, reject) => {
      const request = indexedDB.deleteDatabase('mangaViewerState');
      request.onsuccess = resolveDelete;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('test database delete blocked'));
    });

    const store = await import('/src/catalogStore.js');
    const exact = {
      id: 'exact',
      kind: 'comic',
      title: '원본',
      label: '1화',
      pages: [{ url: 'page', custom: { untouched: true } }],
      coverUrl: null,
      sourceUrl: 'https://example.com/1',
      prevUrl: null,
      nextUrl: 'https://example.com/2',
      savedAt: 10,
      updatedAt: 20,
      unknown: ['그대로'],
    };
    await store.putCatalogItem(exact);
    const read = await store.getCatalogItem(exact.id);
    if (JSON.stringify(read) !== JSON.stringify(exact)) throw new Error('catalog get is lossy');

    await store.putCatalogItem({ id: 'delete-me', value: 1 });
    await store.putCatalogItem({ id: 'keep-me', value: 2 });
    await store.deleteCatalogItem('delete-me');
    if (await store.getCatalogItem('delete-me')) throw new Error('item delete failed');
    if ((await store.getCatalogItem('keep-me'))?.value !== 2) {
      throw new Error('item delete affected another record');
    }

    await store.putCatalogItems([{ id: 'batch-delete' }, { id: 'batch-keep' }]);
    await store.deleteCatalogItems(['batch-delete']);
    if (await store.getCatalogItem('batch-delete')) throw new Error('batch delete failed');
    if (!(await store.getCatalogItem('batch-keep'))) throw new Error('batch delete affected another record');

    await store.putKv('progress', { exact: 7 });
    await store.putKv('settings', { direction: 'RTL' });
    await store.putKv('lastChapterId', 'bulk-1000');

    let failed = false;
    try {
      await store.writeMigrationV1([
        { id: 'rolled-back', title: '쓰이면 안 됨' },
        { title: 'id 없음' },
      ]);
    } catch {
      failed = true;
    }
    const afterFailure = {
      failed,
      row: await store.getCatalogItem('rolled-back'),
      marker: await store.getKv('migration.v1'),
    };

    const many = Array.from({ length: 1001 }, (_, index) => ({
      id: `bulk-${String(index).padStart(4, '0')}`,
      title: `${index}화`,
      pages: [{ url: `page-${index}` }],
    }));
    await store.writeMigrationV1(many);
    return afterFailure;
  });
  assert.deepEqual(migrationFailure, { failed: true, row: undefined, marker: undefined });

  await page.reload();
  const afterReload = await page.evaluate(async () => {
    const store = await import('/src/catalogStore.js');
    const rows = await store.listCatalogItems();
    return {
      bulkCount: rows.filter((row) => row.id.startsWith('bulk-')).length,
      bulkLast: await store.getCatalogItem('bulk-1000'),
      progress: await store.getKv('progress'),
      settings: await store.getKv('settings'),
      lastChapterId: await store.getKv('lastChapterId'),
      marker: await store.getKv('migration.v1'),
    };
  });
  assert.equal(afterReload.bulkCount, 1001);
  assert.equal(afterReload.bulkLast.title, '1000화');
  assert.deepEqual(afterReload.progress, { exact: 7 });
  assert.deepEqual(afterReload.settings, { direction: 'RTL' });
  assert.equal(afterReload.lastChapterId, 'bulk-1000');
  assert.equal(afterReload.marker, 'complete');

  const schema = await page.evaluate(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('mangaViewerState');
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      version: db.version,
      stores: [...db.objectStoreNames],
      catalogKeyPath: db.transaction('catalog').objectStore('catalog').keyPath,
      kvKeyPath: db.transaction('kv').objectStore('kv').keyPath,
    };
    db.close();
    return result;
  });
  assert.deepEqual(schema, {
    version: 1,
    stores: ['catalog', 'kv'],
    catalogKeyPath: 'id',
    kvKeyPath: 'key',
  });

  const source = await readFile(resolve(root, 'src/catalogStore.js'), 'utf8');
  assert.doesNotMatch(source, /\.clear\s*\(/, 'catalog store에서 전체 삭제 금지');
  console.log('catalog store: pure merge + real IndexedDB reload 1001개 통과');
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
