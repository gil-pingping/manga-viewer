import { readFile, readdir } from 'node:fs/promises';

const assets = new URL('../dist/assets/', import.meta.url);
const files = (await readdir(assets)).filter((name) => name.endsWith('.js'));
const source = (
  await Promise.all(files.map((name) => readFile(new URL(name, assets), 'utf8')))
).join('\n');

for (const name of ['selectContentImages', 'collectDescriptors']) {
  if (!new RegExp(`["']${name}["']`).test(source)) {
    throw new Error(`프로덕션 빌드에 수집 함수의 고정 이름이 없습니다: ${name}`);
  }
}

/**
 * 번들 리네임(`이름$1`) 자체는 여기서 막지 않는다 — 정의부 리네임은 무해하고
 * (rollup 이 동명 충돌 시 정상적으로 하는 일), 위험한 것은 직렬화된 본문의
 * 호출부뿐이다. 그건 collector.js 의 serializeBundledFunctions 가 직렬화
 * 시점에 고정 이름으로 되돌리고, bookmarklet-check 가 그 복원을 검증한다.
 * (v1.4.2 실사고: keepDominantDirectory$1 ReferenceError 로 기기 수집 전멸)
 */

console.log('프로덕션 수집 함수 고정 이름 검증 통과');
