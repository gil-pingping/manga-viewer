import assert from 'node:assert/strict';
import {
  base64ToBlob,
  decodeDirectImageResponse,
  decodePageBytes,
  pickCharset,
  readRangedNativeBytes,
  shouldTryDirectImage,
  noteDirectImageFailure,
  pickImageSource,
  directDisplayUrl,
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

// 직접 받은 응답 판정: 같은 CDN 이 같은 JPEG 에 content-type 을 제멋대로 붙인다 (실측 v1.4.11)
{
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const jpegBase64 = Buffer.from(jpeg).toString('base64');

  // 1. application/json → CapacitorHttp 가 본문을 이미 텍스트로 디코딩해 넘긴다. FF D8 이 U+FFFD 로
  //    뭉개져 atob 이 InvalidCharacterError 를 던졌고, 그 throw 가 중계 폴백을 건너뛰어
  //    src 도 못 넣은 컷이 "이미지 실패 · 다시 시도" 로 남았다 (실측 101·103·110·111 컷)
  const jsonText = '\uFFFD\uFFFD\uFFFD\uFFFD JFIF ;CREATOR: gd-jpeg';
  let decodedJson;
  assert.doesNotThrow(
    () => { decodedJson = decodeDirectImageResponse({ status: 200, contentType: 'application/json', data: jsonText }); },
    'Latin1 범위 밖 본문이 atob 까지 가서 throw 하면 중계 폴백을 건너뛴다'
  );
  assert.equal(decodedJson.ok, false, 'application/json 본문은 이미 깨진 바이트 — 실패한 직접 시도로 접는다');
  assert.equal(decodedJson.status, 502);
  assert.match(decodedJson.reason, /content-type/, '운영자가 회선 문제와 구분할 수 있어야 한다');

  // 2. font/woff2 → 같은 JPEG 인데 base64 문자열로 넘어온다. 실제로 렌더되던 경로니 막지 않는다
  const decodedWoff = decodeDirectImageResponse({ status: 200, contentType: 'font/woff2', data: jpegBase64 });
  assert.equal(decodedWoff.ok, true, 'content-type 이 이상해도 base64 바이트면 그대로 쓴다');
  assert.equal(decodedWoff.blob.size, jpeg.byteLength, '받은 바이트 수가 그대로여야 한다');
  assert.deepEqual(new Uint8Array(await decodedWoff.blob.arrayBuffer()), jpeg);

  // 3. text/html → 차단 페이지. 기존 가드가 회귀하면 HTML 이 이미지로 들어간다
  const decodedHtml = decodeDirectImageResponse({ status: 200, contentType: 'text/html; charset=utf-8', data: '<html>blocked' });
  assert.equal(decodedHtml.ok, false, 'text/html 차단 응답은 계속 실패로 접는다');
  assert.equal(decodedHtml.status, 502);

  // 4. content-type 은 이미지인데 본문이 base64 가 아니면 atob 이 던진다 — 밖으로 내보내면 안 된다
  let decodedBroken;
  assert.doesNotThrow(
    () => { decodedBroken = decodeDirectImageResponse({ status: 200, contentType: 'image/jpeg', data: '이건 base64 가 아니다' }); },
    'base64 디코딩 실패가 밖으로 나가면 중계 폴백이 실행되지 않는다'
  );
  assert.equal(decodedBroken.ok, false, 'base64 가 아닌 본문도 실패한 직접 시도다');

  // 5. content-type 이 틀린 건 회선 타임아웃이 아니다 — 호스트를 중계 전용으로 못 박으면
  //    회선이 멀쩡한데도 세션 내내 직접 연결을 건너뛴다
  decodeDirectImageResponse({ status: 200, contentType: 'application/json', data: jsonText });
  assert.equal(shouldTryDirectImage('json.example'), true, 'content-type 오류는 타임아웃 메모를 더럽히지 않는다');
}

// 페이지 charset 고르기 — CP949 사이트(실측 wftoon227.com)를 UTF-8 로 읽으면 제목·링크가 죽는다.
// Node 에는 CP949 인코더가 없고(TextEncoder 는 UTF-8 전용) iconv 모듈도 안 쓴다 —
// 그래서 바이트를 그대로 박아둔다. 만든 법: printf '헬퍼 2 : 킬베로스 42화' | iconv -f UTF-8 -t CP949 | xxd -p
{
  const CP949_TITLE = Uint8Array.from([
    0xc7, 0xef, 0xc6, 0xdb, 0x20, 0x32, 0x20, 0x3a, 0x20,
    0xc5, 0xb3, 0xba, 0xa3, 0xb7, 0xce, 0xbd, 0xba, 0x20, 0x34, 0x32, 0xc8, 0xad,
  ]); // '헬퍼 2 : 킬베로스 42화'
  const CP949_NEXT = Uint8Array.from([0xb4, 0xd9, 0xc0, 0xbd, 0xc8, 0xad]); // '다음화'
  const ascii = (text) => Uint8Array.from(Buffer.from(text, 'binary'));
  const bytesOf = (...parts) => Uint8Array.from(Buffer.concat(parts.map(Buffer.from)));

  // 1. 헤더가 charset 을 말하면 그게 답이다. 이 사이트는 `<title>` 이 없어 이름이 og:title 에만 있다
  const withMeta = bytesOf(ascii('<meta property="og:title" content="'), CP949_TITLE, ascii('">'));
  assert.equal(
    pickCharset('text/html; charset=euc-kr', withMeta),
    'euc-kr',
    '응답 헤더의 charset 이 최우선 — 중계 Worker 가 UTF-8 로 바꿔 보낸 본문에도 원본 meta 가 남아 있다'
  );
  assert.equal(
    decodePageBytes(CP949_TITLE, 'text/html; charset=euc-kr'),
    '헬퍼 2 : 킬베로스 42화',
    'CP949 제목이 글자 그대로 복원돼야 서재·기록에 뭉개진 이름이 안 들어간다'
  );

  // 2. 헤더에 charset 이 없으면 앞부분 meta 를 스니핑한다. cp949·windows-949 같은 별칭도 같은 디코더다
  //    (이 WebView 의 TextDecoder 는 `cp949` 라벨을 모르고 `euc-kr` 만 받는다)
  assert.equal(
    pickCharset(
      'text/html',
      bytesOf(ascii('<html><head><meta http-equiv="Content-Type" content="text/html; charset=cp949">'), CP949_TITLE)
    ),
    'euc-kr',
    'http-equiv 로 선언한 cp949 도 euc-kr 디코더로 정규화해야 한다'
  );

  // 3. 요즘 문법으로 UTF-8 을 선언한 사이트는 그대로 UTF-8 (기존 사이트들이 회귀하면 안 된다)
  assert.equal(
    pickCharset('text/html', ascii('<html><head><meta charset="utf-8"><title>x</title>')),
    'utf-8',
    '<meta charset="utf-8"> 사이트는 예전처럼 UTF-8 로 읽어야 한다'
  );

  // 4. 아무 선언도 없으면 UTF-8
  assert.equal(pickCharset('', ascii('<html><body>no declaration')), 'utf-8', '선언이 없으면 UTF-8');
  assert.equal(pickCharset(null, null), 'utf-8', '헤더도 바이트도 없어도 throw 하지 않는다');

  // 5. 모르는 라벨 — TextDecoder 생성자가 RangeError 를 던진다. 밖으로 나가면 페이지가 빈 화면이 된다
  let unknown;
  assert.doesNotThrow(
    () => { unknown = decodePageBytes(ascii('<html>hello'), 'text/html; charset=bogus-9'); },
    '모르는 charset 이 throw 하면 페이지를 아예 못 읽는다'
  );
  assert.equal(unknown, '<html>hello', '모르는 라벨은 UTF-8 로 폴백한다');

  // 6. 회귀 — 인코딩 버그가 "다음 화" 를 다른 만화로 보낸 경로 그대로:
  //    수집기는 링크의 `다음화` 글자로 다음 화를 찾는다. UTF-8 로 잘못 읽으면 그 글자가 U+FFFD 로
  //    죽어 절대 안 맞고, 쿼리 증가 추측으로 떨어져 작품 id 를 올렸다
  //    (실측: `?toon=185&num=42` 는 다음 화가 아니라 `호박장군 41화`)
  const nav = bytesOf(ascii('<a href="/view?toon=184&num=43">'), CP949_NEXT, ascii('</a>'));
  const brokenText = decodePageBytes(nav, 'text/html'); // 선언 없음 → UTF-8 로 읽힌다
  assert.ok(brokenText.includes('�'), 'CP949 바이트를 UTF-8 로 읽으면 U+FFFD 가 나온다');
  assert.equal(
    brokenText.includes('다음화'),
    false,
    '뭉개진 글자에는 `다음화` 가 없다 — 수집기가 쿼리 증가 추측으로 떨어져 작품 id 를 올렸다'
  );
  assert.ok(
    decodePageBytes(nav, 'text/html; charset=euc-kr').includes('다음화'),
    '올바른 디코더로 읽으면 `다음화` 링크를 찾는다 — 다음 화가 같은 작품의 다음 화가 된다'
  );
}

// 서재에서 꺼낸 화는 호출자가 page.url 에 blob 을 끼워 넣는다. originalUrl 이 남아 있어도
// 그 blob 을 써야 한다 — 네트워크로 나가면 서명 만료된 원본을 받으려다 전부 실패한다
// (실측: 앱을 껐다 켜면 담아둔 화가 "이미지 실패 · 다시 시도" 로 떴다).
assert.deepEqual(
  pickImageSource(
    { url: 'blob:mv/offline-1', originalUrl: 'https://cdn.example/x.webp', refererUrl: 'https://site.example/' },
    { native: true }
  ),
  { kind: 'stored', url: 'blob:mv/offline-1' },
  '서재 blob 이 원본 주소보다 우선한다'
);

// 담지 않은 화는 그대로 네이티브가 원본에서 받는다 (프록시 경로는 원본이 아니다)
assert.deepEqual(
  pickImageSource(
    { url: '/api/proxy-image?url=https%3A%2F%2Fcdn.example%2Fx.webp', originalUrl: 'https://cdn.example/x.webp' },
    { native: true }
  ),
  { kind: 'fetch', url: 'https://cdn.example/x.webp' }
);

// 웹(브라우저)에서는 네이티브 요청이 없으니 프록시 경로를 그대로 쓴다
assert.equal(
  pickImageSource({ url: '/api/proxy-image?url=x', originalUrl: 'https://cdn.example/x.webp' }, { native: false }).kind,
  'stored'
);

// 네이티브가 바이트를 못 받은 뒤 브라우저에게 맡길 주소 고르기.
// 1. `.json` 컷: CapacitorHttp 는 arraybuffer·blob·text 어느 responseType 으로도 못 받지만
//    (세 번 모두 똑같이 뭉개진 154629자), 같은 주소를 맨 new Image() 에 넣으면 600x1000 으로 렌더됐다
assert.equal(
  directDisplayUrl({
    url: '/api/proxy-image?url=https%3A%2F%2Fcdn.example%2Fcut-101.json',
    originalUrl: 'https://cdn.example/data/cut-101.json',
    refererUrl: 'https://site.example/',
  }),
  'https://cdn.example/data/cut-101.json',
  '네이티브로 못 받는 컷도 브라우저는 스니핑해서 띄운다 — 원본 주소를 그대로 넘긴다'
);

// 2. 상대 프록시 경로만 있으면 안 된다 — 앱에서는 https://localhost 로 붙어 404 가 되고
//    엔진은 "이미지 실패" 를 다시 띄운다
assert.equal(
  directDisplayUrl({ url: '/api/proxy-image?url=https%3A%2F%2Fcdn.example%2Fx.webp' }),
  null,
  '상대 경로는 앱에서 localhost 로 붙어 404 다 — 엔진에 넘기면 안 된다'
);

// 3. blob:·data: 는 pickImageSource 가 이미 'stored' 로 걸러 여기 오지 않는다
assert.equal(directDisplayUrl({ url: 'blob:mv/offline-1' }), null, 'blob: 은 직접 시도 대상이 아니다');
assert.equal(directDisplayUrl({ url: 'data:image/png;base64,AAAA' }), null, 'data: 은 직접 시도 대상이 아니다');

// 4. 주소가 아예 없는 컷 — throw 하지 말고 null 로 답해야 기존 에러 메시지가 그대로 뜬다
assert.equal(directDisplayUrl({}), null, '주소 없는 컷은 null (기존 실패 메시지 유지)');
assert.equal(directDisplayUrl(null), null, 'page 자체가 없어도 throw 하지 않는다');

console.log(
  'native HTTP 변환 2개 + 1MB bridge 분할 수신 + 직접 연결 타임아웃 메모' +
    ' + 직접 응답 content-type 판정(json/woff2/html/깨진 base64 → 중계 폴백) + 서재 blob 우선' +
    ' + 페이지 charset 고르기(헤더 > meta 스니핑 > UTF-8, cp949 별칭 → euc-kr, 모르는 라벨 → UTF-8)' +
    ' + CP949 회귀(UTF-8 로 읽으면 `다음화` 가 사라져 다음 화가 다른 만화로 갔다)' +
    ' + 네이티브 실패 뒤 브라우저 직접 표시 주소(절대 http만, 상대·blob·data·없음 → null) 통과'
);
