import { readFile, readdir } from 'node:fs/promises';

const assets = new URL('../dist/assets/', import.meta.url);
const files = (await readdir(assets)).filter((name) => name.endsWith('.js'));
const source = (
  await Promise.all(files.map((name) => readFile(new URL(name, assets), 'utf8')))
).join('\n');

for (const name of ['selectContentImages', 'collectDescriptors']) {
  if (!source.includes(`function ${name}`)) {
    throw new Error(`프로덕션 빌드가 수집 함수 이름을 변경했습니다: ${name}`);
  }
}

console.log('프로덕션 수집 함수 이름 검증 통과');
