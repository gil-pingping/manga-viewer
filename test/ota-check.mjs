import assert from 'node:assert/strict';
import { NATIVE_VERSION, OTA_ORIGIN, validateOtaManifest } from '../src/core/otaManifest.js';

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

console.log('OTA manifest 4개 통과');
