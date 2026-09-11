import assert from 'node:assert/strict';
import {
  base64ToBlob,
  readRangedNativeBytes,
  shouldTryDirectImage,
  noteDirectImageFailure,
} from '../src/platform/nativeHttp.js';

const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
const blob = base64ToBlob(Buffer.from(bytes).toString('base64'), 'image/webp');

assert.equal(blob.type, 'image/webp');
assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
assert.throws(() => base64ToBlob(null), /base64/);

const streamBytes = Uint8Array.from({ length: 769296 }, (_, index) => index % 251);
const ranges = [];
const ranged = await readRangedNativeBytes(async (options) => {
  const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
  const start = Number(startText);
  const end = Math.min(Number(endText), streamBytes.byteLength - 1);
  const part = streamBytes.slice(start, end + 1);
  ranges.push(options.headers.Range);
  return {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${streamBytes.byteLength}` },
    data: Buffer.from(part).toString('base64'),
  };
}, {
  url: 'https://edge-02.gcdn.app/v1/media/example/segment.m4s',
  headers: { Origin: 'https://anilife.app' },
});

assert.deepEqual(new Uint8Array(ranged.data), streamBytes);
assert.deepEqual(ranges, [
  'bytes=0-262143',
  'bytes=262144-524287',
  'bytes=524288-786431',
]);

// 직접 연결 타임아웃 호스트 메모: 타임아웃만 막고, 다른 실패·다른 호스트는 그대로 시도한다
assert.equal(shouldTryDirectImage('cdn.example'), true);
noteDirectImageFailure('cdn.example', new Error('connection refused'));
assert.equal(shouldTryDirectImage('cdn.example'), true, '타임아웃이 아닌 실패는 호스트를 막지 않는다');
noteDirectImageFailure('cdn.example', Object.assign(new Error('timeout'), { code: 'SocketTimeoutException' }));
assert.equal(shouldTryDirectImage('cdn.example'), false, '타임아웃 뒤엔 같은 호스트를 바로 중계로 보낸다');
assert.equal(shouldTryDirectImage('other.example'), true, '다른 호스트는 영향받지 않는다');

console.log('native HTTP 변환 2개 + 1MB bridge 분할 수신 + 직접 연결 타임아웃 메모 통과');
