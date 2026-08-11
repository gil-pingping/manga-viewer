const DB_NAME = 'mangaViewerState';
const DB_VERSION = 1;
const CATALOG = 'catalog';
const KV = 'kv';
const MIGRATION_V1 = 'migration.v1';

let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CATALOG)) {
        db.createObjectStore(CATALOG, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(KV)) {
        db.createObjectStore(KV, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error);
    };
  });

  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(storeNames, mode, work) {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });

  try {
    const result = await work(tx);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // 이미 실패한 트랜잭션은 브라우저가 중단했다.
    }
    await done.catch(() => {});
    throw error;
  }
}

export function putCatalogItem(item) {
  return run([CATALOG], 'readwrite', (tx) =>
    requestResult(tx.objectStore(CATALOG).put(item))
  );
}

export function putCatalogItems(items) {
  return run([CATALOG], 'readwrite', async (tx) => {
    const catalog = tx.objectStore(CATALOG);
    for (const item of items) await requestResult(catalog.put(item));
  });
}

export function deleteCatalogItem(id) {
  return run([CATALOG], 'readwrite', (tx) =>
    requestResult(tx.objectStore(CATALOG).delete(id))
  );
}

export function deleteCatalogItems(ids) {
  return run([CATALOG], 'readwrite', async (tx) => {
    const catalog = tx.objectStore(CATALOG);
    for (const id of ids) await requestResult(catalog.delete(id));
  });
}

export function getCatalogItem(id) {
  return run([CATALOG], 'readonly', (tx) =>
    requestResult(tx.objectStore(CATALOG).get(id))
  );
}

export function listCatalogItems() {
  return run([CATALOG], 'readonly', (tx) =>
    requestResult(tx.objectStore(CATALOG).getAll())
  );
}

export function putKv(key, value) {
  return run([KV], 'readwrite', (tx) =>
    requestResult(tx.objectStore(KV).put({ key, value }))
  );
}

export async function getKv(key) {
  const row = await run([KV], 'readonly', (tx) =>
    requestResult(tx.objectStore(KV).get(key))
  );
  return row?.value;
}

/** 모든 catalog 쓰기가 성공한 같은 트랜잭션에서만 완료 표식을 남긴다. */
export function writeMigrationV1(items, kv = {}) {
  return run([CATALOG, KV], 'readwrite', async (tx) => {
    const catalog = tx.objectStore(CATALOG);
    for (const item of items) await requestResult(catalog.put(item));
    const state = tx.objectStore(KV);
    for (const [key, value] of Object.entries(kv)) {
      if (key !== MIGRATION_V1) await requestResult(state.put({ key, value }));
    }
    await requestResult(state.put({ key: MIGRATION_V1, value: 'complete' }));
  });
}

export function normalizeSourceUrl(sourceUrl) {
  if (typeof sourceUrl !== 'string') return '';
  const trimmed = sourceUrl.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return trimmed.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function nonEmpty(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function recordTime(record) {
  return Math.max(Number(record.updatedAt) || 0, Number(record.savedAt) || 0);
}

function mergeGroup(records) {
  const identity = records.find((record) => nonEmpty(record.id))?.id;
  const ordered = [...records].sort((a, b) => recordTime(a) - recordTime(b));
  const merged = { ...ordered[0] };

  for (const record of ordered) {
    for (const [key, value] of Object.entries(record)) {
      if (nonEmpty(value)) merged[key] = value;
    }
  }
  if (identity !== undefined) merged.id = identity;
  return merged;
}

function mergeBy(records, keyOf) {
  const groups = [];
  const indexes = new Map();

  for (const record of records) {
    const key = keyOf(record);
    if (key === '' || key == null) {
      groups.push([record]);
    } else if (indexes.has(key)) {
      groups[indexes.get(key)].push(record);
    } else {
      indexes.set(key, groups.length);
      groups.push([record]);
    }
  }

  return groups.map(mergeGroup);
}

/** 기존 세 원본을 id 우선, 정규화 sourceUrl 차순으로 무손실 병합한다. */
export function mergeLegacyCatalog(...sources) {
  const records = sources.flat().filter((record) => record && typeof record === 'object');
  return mergeBy(
    mergeBy(records, (record) => record.id),
    (record) => normalizeSourceUrl(record.sourceUrl)
  );
}
