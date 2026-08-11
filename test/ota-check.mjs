import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_VERSION, OTA_ORIGIN, validateOtaManifest } from '../src/core/otaManifest.js';
import { flushStateWrites, queueStateWrite } from '../src/state.js';

const bundleId = 'web-0123456789abcdefabcd';
const valid = {
  schemaVersion: 1,
  nativeVersion: NATIVE_VERSION,
  bundleId,
  checksum: 'a'.repeat(64),
  signature: 'YWJjZA==',
  url: `${OTA_ORIGIN}/ota/${bundleId}.zip`,
};

assert.deepEqual(validateOtaManifest(valid), {
  bundleId,
  checksum: valid.checksum,
  signature: valid.signature,
  url: valid.url,
});
assert.throws(
  () => validateOtaManifest({ ...valid, url: `https://evil.test/ota/${bundleId}.zip` }),
  /허용되지 않은/
);
assert.throws(() => validateOtaManifest({ ...valid, signature: '' }), /signature/);
assert.throws(
  () => validateOtaManifest({ ...valid, nativeVersion: NATIVE_VERSION + 1 }),
  /호환되지 않는/
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveUpdateSource = await readFile(resolve(root, 'src/platform/liveUpdate.js'), 'utf8');
assert.match(
  liveUpdateSource,
  /await beforeReload\?\.\(\);\s*await LiveUpdate\.reload\(\);/,
  'reload 직전 pending IndexedDB 쓰기를 flush'
);

const events = [];
let releaseFirst;
let releaseSecond;
let markSecondStarted;
const secondStarted = new Promise((resolve) => {
  markSecondStarted = resolve;
});
queueStateWrite(() => new Promise((resolve) => {
  releaseFirst = resolve;
}));
await Promise.resolve();
const beforeReload = flushStateWrites().then(() => events.push('reload'));
queueStateWrite(() => {
  markSecondStarted();
  return new Promise((resolve) => {
    releaseSecond = resolve;
  });
});
releaseFirst();
await secondStarted;
assert.deepEqual(events, [], 'flush 도중 추가된 두 번째 쓰기 전에는 reload 금지');
releaseSecond();
await beforeReload;
assert.deepEqual(events, ['reload']);

const writeError = new Error('forced persistence failure');
await assert.rejects(queueStateWrite(() => Promise.reject(writeError)), /forced persistence failure/);
await assert.rejects(flushStateWrites(), /forced persistence failure/);

console.log('OTA manifest 4개 + reload flush 순서/동시 enqueue/오류 전파 통과');
