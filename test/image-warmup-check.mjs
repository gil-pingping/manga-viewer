/**
 * 다음 화 첫 컷 미리 받기 점검.
 *
 * 한 장·두 장 모드는 다음 화를 새로 열 때 첫 컷을 그제서야 받아서 화 경계마다 로딩이
 * 보였다. 미리 받은 결과를 엔진이 그대로 쓰는지, 안 쓰인 blob 은 놓는지 확인한다.
 */
import assert from 'node:assert/strict';
import { createImageWarmup } from '../src/platform/imageWarmup.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const revoked = [];
URL.revokeObjectURL = (url) => revoked.push(url);

function fakeResolver() {
  const calls = [];
  const resolve = (page) => {
    calls.push(page.url);
    return Promise.resolve({ url: `blob:${page.url}#${calls.length}`, owned: true });
  };
  return { resolve, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const page = (n) => ({ url: `/api/proxy-image?url=${n}`, pageNumber: n });

console.log('다음 화 첫 컷 미리 받기');

await check('미리 받은 컷은 다시 받지 않고 그대로 넘긴다', async () => {
  const { resolve, calls } = fakeResolver();
  const warmup = createImageWarmup(resolve);
  warmup.warm([page(1), page(2)]);
  await tick();
  assert.equal(calls.length, 2, '미리 받기가 곧바로 시작돼야 한다');
  const got = await warmup.resolve(page(1));
  assert.equal(got.url, 'blob:/api/proxy-image?url=1#1');
  assert.equal(calls.length, 2, '엔진 요청 때 네트워크를 다시 타면 안 된다');
  assert.equal(warmup.size, 1, '넘긴 컷은 캐시에서 빠진다 (엔진 소유)');
});

await check('미리 받지 않은 컷은 평소대로 받는다', async () => {
  const { resolve, calls } = fakeResolver();
  const warmup = createImageWarmup(resolve);
  await warmup.resolve(page(9));
  assert.deepEqual(calls, ['/api/proxy-image?url=9']);
});

await check('같은 컷을 두 번 예약해도 한 번만 받는다', async () => {
  const { resolve, calls } = fakeResolver();
  const warmup = createImageWarmup(resolve);
  warmup.warm([page(1)]);
  warmup.warm([page(1)]);
  await tick();
  assert.equal(calls.length, 1);
});

await check('다음 화 예측이 바뀌면 안 쓰인 blob 을 놓는다', async () => {
  revoked.length = 0;
  const { resolve } = fakeResolver();
  const warmup = createImageWarmup(resolve);
  warmup.warm([page(1), page(2)]);
  warmup.warm([page(2), page(3)]);
  await tick();
  assert.deepEqual(revoked, ['blob:/api/proxy-image?url=1#1']);
  assert.equal(warmup.size, 2);
});

await check('clear 는 대기분을 전부 놓는다', async () => {
  revoked.length = 0;
  const { resolve } = fakeResolver();
  const warmup = createImageWarmup(resolve);
  warmup.warm([page(1), page(2)]);
  warmup.clear();
  await tick();
  assert.equal(revoked.length, 2);
  assert.equal(warmup.size, 0);
});

await check('미리 받기가 실패했으면 엔진 요청 때 다시 받는다', async () => {
  let attempt = 0;
  const warmup = createImageWarmup((p) => {
    attempt++;
    return attempt === 1 ? Promise.reject(new Error('회선 끊김')) : Promise.resolve({ url: `blob:${p.url}`, owned: true });
  });
  warmup.warm([page(1)]);
  await tick();
  const got = await warmup.resolve(page(1));
  assert.equal(got.url, 'blob:/api/proxy-image?url=1');
  assert.equal(attempt, 2);
});

await check('상한을 넘겨 쌓지 않는다', async () => {
  const { resolve } = fakeResolver();
  const warmup = createImageWarmup(resolve, { limit: 3 });
  warmup.warm([page(1), page(2), page(3), page(4), page(5)]);
  assert.equal(warmup.size, 3);
});

console.log(`\n${passed}개 통과`);
