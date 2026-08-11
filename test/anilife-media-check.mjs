import assert from 'node:assert/strict';
import LZString from 'lz-string';
import { stringify } from 'zipson';
import { buildAnilifePlayback, decryptAnilifeMedia } from '../src/collect/anilifeMedia.js';
import {
  anilifeMediaRequestHeaders,
  assertAnilifeStreamUrl,
  assertAnilifeWatchId,
  parseAnilifeBuildVersion,
} from '../src/shared/anilifeRules.js';

const ID = '26050e24-2175-4e15-855d-d864120abc30';
const NEXT_ID = '7cfafaa1-cfcb-4720-8d1a-facc088ba2ef';
const AES_KEY = '5f1d6b5cf2b6e5a236aa6352c5e688bc86c257a9b61b183c9926613a90356a48';
const HMAC_KEY = '3f8d7b6a4c2e1d9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f';

const hex = (value) => Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
const base64 = (value) => Buffer.from(value).toString('base64');
const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

async function makeEnvelope(data) {
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
  const aes = await crypto.subtle.importKey('raw', hex(AES_KEY), { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aes,
    new TextEncoder().encode(JSON.stringify(data))
  ));
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  const timestamp = String(Date.now());
  const hmac = await crypto.subtle.importKey(
    'raw',
    hex(HMAC_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = Buffer.from(await crypto.subtle.sign(
    'HMAC',
    hmac,
    concat(ciphertext, iv, tag, new TextEncoder().encode(timestamp))
  )).toString('hex');
  return LZString.compressToUTF16(stringify([
    base64(ciphertext),
    base64(iv),
    base64(tag),
    base64(timestamp),
    signature,
  ]));
}

assert.equal(assertAnilifeWatchId(ID), ID);
assert.throws(() => assertAnilifeWatchId('../etc/passwd'));
assert.equal(parseAnilifeBuildVersion('<script src="/_nuxt/1781855145877/app.js">'), '1781855145877');
assert.equal(anilifeMediaRequestHeaders(ID, '1781855145877')['X-Anilife-Referer'], encodeURIComponent(`/watch?id=${ID}`));
assert.equal(assertAnilifeStreamUrl('https://edge-02.gcdn.app/v1/media/token/part.m4s').hostname, 'edge-02.gcdn.app');
assert.throws(() => assertAnilifeStreamUrl('https://evil.example/v1/media/token/part.m4s'));

const rawData = {
  access: 'signed_token/path/episode/1786467585',
  media: { name: { kr: '테스트 애니' }, image: 'https://image.example/cover.jpg' },
  episode: {
    episode_num: '6',
    subject: '불꽃놀이 갈래',
    thumbnail: 'https://image.example/thumb.jpg',
    op_start: 10,
    op_end: 100,
    ed_start: 1300,
    ed_end: 1400,
  },
  navigation: {
    prev: null,
    next: { uniqueId: NEXT_ID, episode_num: '7', subject: '다음 화' },
  },
};
const decrypted = await decryptAnilifeMedia(await makeEnvelope(rawData));
assert.deepEqual(decrypted, rawData);

const playback = buildAnilifePlayback(decrypted, ID);
assert.equal(playback.seriesTitle, '테스트 애니');
assert.equal(playback.streamUrl, 'https://api.gcdn.app/v1/manifest/a/signed_token/path/episode/1786467585/master.m3u8');
assert.deepEqual(playback.timestamps.op, { startTime: 10, endTime: 100 });
assert.equal(playback.navigation.next.id, NEXT_ID);
assert.throws(() => buildAnilifePlayback({ ...rawData, access: 'https://evil.example/video' }, ID));

console.log('anilife media: 서명·복호화·HLS 주소 검증 통과');
