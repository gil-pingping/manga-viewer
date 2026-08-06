import assert from 'node:assert/strict';
import { base64ToBlob } from '../src/platform/nativeHttp.js';

const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
const blob = base64ToBlob(Buffer.from(bytes).toString('base64'), 'image/webp');

assert.equal(blob.type, 'image/webp');
assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
assert.throws(() => base64ToBlob(null), /base64/);

console.log('native HTTP 변환 2개 통과');
