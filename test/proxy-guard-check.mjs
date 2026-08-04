/**
 * 프록시 접근 가드 점검.
 *
 * 이 프록시는 `host: true` 로 LAN 에 열려 있다. 즉 같은 와이파이의 누구든
 * 공용 프록시로 악용해 사설망(공유기 관리 페이지 등)을 찔러볼 수 있다.
 * 그래서 사설 대역을 막는데, 로컬 테스트 사이트를 보려면 열어줘야 한다.
 *
 * 가른 기준: 요청자가 루프백인가. 기기 앞의 사람은 허용, LAN 의 남은 차단.
 * 보안 분기라 실측(LAN 경유 요청)이 어려운 환경에서도 규칙은 고정해둔다.
 */
import assert from 'node:assert/strict';
import { assertFetchableUrl, isLoopbackRequester } from '../vite-proxy-plugin.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const LOOPBACK = true;
const FROM_LAN = false;

console.log('요청자 판별');

check('루프백 주소를 알아본다', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRequester({ socket: { remoteAddress: addr } }), true, addr);
  }
});

check('LAN·외부 주소는 루프백이 아니다', () => {
  for (const addr of ['192.168.219.50', '10.0.0.7', '172.16.4.4', '203.0.113.9', '']) {
    assert.equal(isLoopbackRequester({ socket: { remoteAddress: addr } }), false, addr);
  }
});

check('socket 이 없어도 터지지 않는다', () => {
  assert.equal(isLoopbackRequester({}), false);
});

console.log('\n스킴 제한 (요청자와 무관하게)');

check('http/https 만 통과한다', () => {
  for (const allow of [LOOPBACK, FROM_LAN]) {
    assert.doesNotThrow(() => assertFetchableUrl('https://example.test/a', allow));
    assert.doesNotThrow(() => assertFetchableUrl('http://example.test/a', allow));
    for (const bad of ['file:///etc/passwd', 'gopher://x/', 'data:text/html,x', 'ftp://x/']) {
      assert.throws(() => assertFetchableUrl(bad, allow), /http\/https/, `${bad} (allow=${allow})`);
    }
  }
});

check('망가진 주소는 거부한다', () => {
  assert.throws(() => assertFetchableUrl('not a url', LOOPBACK), /올바른 URL/);
});

console.log('\n사설 대역 — LAN 에서 온 요청은 막는다');

const PRIVATE = [
  'http://localhost:8901/',
  'http://x.localhost/',
  'http://127.0.0.1:8901/',
  'http://10.1.2.3/',
  'http://192.168.1.1/',
  'http://172.16.0.1/',
  'http://172.31.255.254/',
  'http://169.254.169.254/', // 클라우드 메타데이터
  'http://0.0.0.0/',
  'http://svc.internal/',
  'http://[::1]/',
  'http://[fc00::1]/',
  'http://[fe80::1]/',
];

check('LAN 요청자는 사설 대역에 못 간다', () => {
  for (const url of PRIVATE) {
    assert.throws(() => assertFetchableUrl(url, FROM_LAN), /사설망/, url);
  }
});

check('공유기 관리 페이지도 막힌다', () => {
  assert.throws(() => assertFetchableUrl('http://192.168.0.1/admin', FROM_LAN), /사설망/);
});

console.log('\n사설 대역 — 기기 앞의 사람은 허용한다 (로컬 테스트용)');

check('루프백 요청자는 로컬 목업을 볼 수 있다', () => {
  for (const url of PRIVATE) {
    assert.doesNotThrow(() => assertFetchableUrl(url, LOOPBACK), url);
  }
});

check('공개 주소는 어느 경로에서나 통과한다', () => {
  for (const allow of [LOOPBACK, FROM_LAN]) {
    assert.doesNotThrow(() => assertFetchableUrl('https://comic.naver.com/webtoon/detail?no=1', allow));
    assert.doesNotThrow(() => assertFetchableUrl('https://i.pinimg.com/736x/a/b/c.jpg', allow));
  }
});

console.log(`\n${passed}개 통과`);
