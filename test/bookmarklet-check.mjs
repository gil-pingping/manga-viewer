/**
 * 북마클릿 조립 점검.
 *
 * 북마클릿은 import 를 못 쓰기 때문에 core 함수들을 문자열화해서 싣는다.
 * 그 조립이 (1) 유효한 JS 인지, (2) 직렬화된 규칙이 core 와 똑같이
 * 동작하는지 확인한다.
 *
 * (2)가 이 파일의 존재 이유다. 예전엔 규칙이 복붙돼 있어서 한쪽만 고쳐도
 * 아무도 안 알려줬고, 같은 사이트가 경로에 따라 다르게 동작했다.
 */
import assert from 'node:assert/strict';
import {
  buildBookmarklet,
  buildNativeCollectorScript,
  BUNDLED,
  bundledConstants,
  serializeBundledFunctions,
} from '../src/collector.js';
import { selectContentImages } from '../src/core/imageRules.js';
import { ALL_FIXTURES } from './fixtures/site-samples.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const ORIGIN = 'http://localhost:5173';
const bookmarklet = buildBookmarklet(ORIGIN);
const decoded = decodeURIComponent(bookmarklet.replace(/^javascript:/, ''));

console.log('북마클릿 조립');

check('javascript: 로 시작한다', () => {
  assert.ok(bookmarklet.startsWith('javascript:'));
});

check('뷰어 주소가 박혀 있다', () => {
  assert.ok(decoded.includes(JSON.stringify(ORIGIN)));
});

check('조립 결과가 유효한 JS 다', () => {
  assert.doesNotThrow(() => new Function(decoded));
});

check('Android WebView 수집기도 자기완결적 JS 다', () => {
  const script = buildNativeCollectorScript();
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /\bexport\s+/);
});

check('Android WebView 수집 오류가 진단값으로 돌아온다', () => {
  const script = buildNativeCollectorScript();
  const result = new Function('document', 'location', `return ${script}`)(
    {},
    { href: 'https://reader.test/chapter/1' }
  );
  assert.match(JSON.parse(result).collectorError, /querySelectorAll/);
});

check('export 키워드가 남아있지 않다', () => {
  // 함수 소스를 그대로 쓰면 "export function ..." 이 되어 문법 오류가 난다
  assert.equal(/\bexport\s+(function|const|var|let)\b/.test(decoded), false);
});

check('core 함수가 빠짐없이 실렸다', () => {
  for (const [name] of BUNDLED) {
    assert.ok(decoded.includes(`var ${name} =`), `${name} 이 빠졌다`);
  }
});

check('번들러가 함수 이름을 바꿔도 주입 이름은 고정된다', () => {
  const renamed = function selectContentImages$1() {
    return 7;
  };
  const source = `${serializeBundledFunctions([['selectContentImages', renamed]])}\nreturn selectContentImages();`;
  assert.equal(new Function(source)(), 7);
});

check('상수도 값으로 실렸다', () => {
  const consts = bundledConstants();
  for (const name of [
    'MIN_SHORT_SIDE',
    'MIN_SERIES_LENGTH',
    'JUNK_PATTERN',
    'NOT_IMAGE_EXT',
    'IMAGE_NODE_SELECTOR',
  ]) {
    assert.ok(consts.includes(name), `${name} 상수가 빠졌다`);
  }
});

check('모듈 스코프를 참조하지 않는다', () => {
  // rules.foo / dom.foo 로 남아 있으면 페이지에서 ReferenceError 가 난다
  assert.equal(/\brules\.\w/.test(decoded), false);
  assert.equal(/\bdom\.\w/.test(decoded), false);
});

console.log('\n직렬화된 규칙 == core 규칙');

/**
 * 북마클릿에 실린 코드만 떼어내 selectContentImages 를 되살린다.
 * 실제 북마클릿이 페이지에서 겪는 것과 같은 조건(모듈 없음)이다.
 */
function reviveSelectFromBookmarklet() {
  const fns = serializeBundledFunctions();
  const src = `${bundledConstants()}\n${fns}\nreturn selectContentImages;`;
  return new Function(src)();
}

const revived = reviveSelectFromBookmarklet();

for (const fixture of ALL_FIXTURES) {
  check(`${fixture.label}: 두 경로 결과가 같다`, () => {
    const fromCore = selectContentImages(fixture.elements, fixture.pageUrl);
    const fromBookmarklet = revived(fixture.elements, fixture.pageUrl);
    assert.deepEqual(fromBookmarklet, fromCore);
    assert.ok(fromCore.length > 0, '선별 결과가 비어 있으면 비교가 무의미하다');
  });
}

check('연번 정렬도 동일하게 동작한다', () => {
  const els = [
    { src: 'https://cdn.test/x/p003.jpg', naturalWidth: 800, naturalHeight: 1200 },
    { src: 'https://cdn.test/x/p001.jpg', naturalWidth: 800, naturalHeight: 1200 },
    { src: 'https://cdn.test/x/p002.jpg', naturalWidth: 800, naturalHeight: 1200 },
  ];
  const base = 'https://cdn.test/';
  assert.deepEqual(revived(els, base), selectContentImages(els, base));
  assert.deepEqual(revived(els, base), [
    'https://cdn.test/x/p001.jpg',
    'https://cdn.test/x/p002.jpg',
    'https://cdn.test/x/p003.jpg',
  ]);
});

console.log(`\n${passed}개 통과`);
