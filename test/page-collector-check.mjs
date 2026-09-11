import assert from 'node:assert/strict';
import { collectRenderedPage } from '../src/platform/pageCollector.js';

// 네이티브 PageCollector 흉내: 한 번에 하나만. 겹치면 실제 플러그인 문구로 거절한다.
let active = 0;
const calls = [];
const collect = async (options) => {
  calls.push(options.url);
  if (active > 0) throw new Error('이미 다른 페이지를 열고 있습니다.');
  active++;
  await new Promise((resolve) => setTimeout(resolve, 20));
  active--;
  return { pages: [{ url: `${options.url}#1` }] };
};

// 미리 받기와 정주행이 같은 다음 화를 같은 순간에 부른다 — 네이티브는 한 번만 열어야 한다.
const [a, b] = await Promise.all([
  collectRenderedPage('https://site.test/ch/2', { collect }),
  collectRenderedPage('https://site.test/ch/2', { collect }),
]);
assert.equal(a, b);
assert.deepEqual(calls, ['https://site.test/ch/2']);

// 다른 주소는 거절되지 않고 차례를 기다린다.
const [c, d] = await Promise.all([
  collectRenderedPage('https://site.test/ch/3', { collect }),
  collectRenderedPage('https://site.test/ch/4', { collect }),
]);
assert.equal(c.pages[0].url, 'https://site.test/ch/3#1');
assert.equal(d.pages[0].url, 'https://site.test/ch/4#1');

// 실패한 수집이 줄을 막지 않는다. 끝난 주소는 다시 열 수 있다.
await assert.rejects(
  collectRenderedPage('https://site.test/ch/5', {
    collect: async () => { throw new Error('사이트 응답 500'); },
  }),
  /500/
);
const e = await collectRenderedPage('https://site.test/ch/2', { collect });
assert.equal(e.pages.length, 1);
assert.equal(calls.filter((url) => url.endsWith('/ch/2')).length, 2);

// 제한 시간 없는 구형 APK 가 앞 페이지를 물고 있으면 사람이 할 수 있는 일을 알려준다.
let busyAttempts = 0;
await assert.rejects(
  collectRenderedPage('https://site.test/ch/6', {
    collect: async () => {
      busyAttempts++;
      throw new Error('이미 다른 페이지를 열고 있습니다.');
    },
  }),
  /앱을 완전히 닫고 다시 열어/
);
assert.equal(busyAttempts, 1); // 다시 눌러도 안 풀리는 상태 — 재시도로 시간을 쓰지 않는다

console.log('page-collector-check ok');
