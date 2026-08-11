import assert from 'node:assert/strict';
import { decodeHtmlBuffer } from '../src/shared/charsetDecoder.js';

console.log('=== Charset Decoder 테스트 ===');

// 1. UTF-8 디코딩 테스트
const utf8Text = '<html><head><title>원피스 1080화</title></head></html>';
const utf8Bytes = new TextEncoder().encode(utf8Text);
const decodedUtf8 = decodeHtmlBuffer(utf8Bytes.buffer, 'text/html; charset=utf-8');
assert.equal(decodedUtf8, utf8Text);
console.log('✔ UTF-8 HTML 디코딩 성공');

// 2. EUC-KR 디코딩 테스트
const eucKrBytes = new Uint8Array([
  0xbf, 0xf8, 0xc7, 0xc7, 0xbd, 0xba, 0x20, 0x31, 0x30, 0x38, 0x30, 0x20, 0xc8, 0xad
]);
const decodedEucKr = decodeHtmlBuffer(eucKrBytes.buffer, 'text/html; charset=euc-kr');
assert.equal(decodedEucKr, '원피스 1080 화');
console.log('✔ EUC-KR Content-Type 헤더 디코딩 성공');

// 3. Header 없이 meta 태그에 charset=euc-kr 이 있는 경우
const metaEucKrHtmlHeader = new TextEncoder().encode('<html><head><meta charset="euc-kr"><title>');
const combinedBytes = new Uint8Array(metaEucKrHtmlHeader.length + eucKrBytes.length + 22);
combinedBytes.set(metaEucKrHtmlHeader, 0);
combinedBytes.set(eucKrBytes, metaEucKrHtmlHeader.length);
combinedBytes.set(new TextEncoder().encode('</title></head></html>'), metaEucKrHtmlHeader.length + eucKrBytes.length);

const decodedMeta = decodeHtmlBuffer(combinedBytes.buffer, 'text/html');
assert.ok(decodedMeta.includes('원피스 1080 화'));
console.log('✔ Meta 태그 기반 EUC-KR 자동 감지 및 디코딩 성공');

// 4. Header/Meta 모두 없지만 utf-8 로 디코딩했을 때 깨짐 발생 시 euc-kr 자동 회복
const decodedFallback = decodeHtmlBuffer(eucKrBytes.buffer, 'text/html');
assert.equal(decodedFallback, '원피스 1080 화');
console.log('✔ Charset 미지정 EUC-KR 바이트 자동 회복 성공!');
