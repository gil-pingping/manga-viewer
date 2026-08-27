/**
 * 회차 링크 선별 규칙 점검.
 *
 * 목록 페이지에는 그 작품의 회차만 있는 게 아니다. 다른 작품 추천, 공지,
 * 페이지 번호가 같이 박혀 있고 그것들도 "12화" 같은 텍스트를 달고 있다.
 * 여기서 고정하는 것은 "무엇을 회차로 인정하지 않는가" 다.
 */
import assert from 'node:assert/strict';
import { selectEpisodeLinks, MIN_EPISODE_LINKS, findListPageUrls } from '../src/core/series.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('회차 링크 선별');

check('목록 페이지에서 회차만 뽑아 번호순으로 세운다', () => {
  const links = [
    { href: 'https://ex.test/', text: '홈' },
    { href: 'https://ex.test/manhwa/2', text: '작품 목록' },
    { href: 'https://ex.test/manhwa/2/1003', text: '3화' },
    { href: 'https://ex.test/manhwa/2/1001', text: '1화' },
    { href: 'https://ex.test/manhwa/2/1002', text: '2화' },
    { href: 'https://ex.test/manhwa/2/1004', text: '4화' },
  ];
  const got = selectEpisodeLinks(links);
  assert.deepEqual(
    got.map((e) => e.episodeNum),
    [1, 2, 3, 4]
  );
  assert.equal(got[0].url, 'https://ex.test/manhwa/2/1001');
  assert.equal(got[0].label, '1화');
});

check('다른 작품 추천은 최다 디렉터리 규칙으로 빠진다', () => {
  const links = [
    { href: 'https://ex.test/manhwa/2/1001', text: '1화' },
    { href: 'https://ex.test/manhwa/2/1002', text: '2화' },
    { href: 'https://ex.test/manhwa/2/1003', text: '3화' },
    { href: 'https://ex.test/manhwa/2/1004', text: '4화' },
    // 사이드바 "인기작" — 회차 번호는 있지만 다른 작품이다
    { href: 'https://ex.test/manhwa/99/5501', text: '350화' },
    { href: 'https://ex.test/manhwa/77/2201', text: '12화' },
  ];
  const got = selectEpisodeLinks(links);
  assert.equal(got.length, 4);
  assert.ok(got.every((e) => e.url.includes('/manhwa/2/')));
});

check('회차 링크가 2개뿐이면 목록으로 인정하지 않는다', () => {
  // 네이버를 헤드리스로 열면 이전화·다음화 2개만 잡혔다.
  // 그걸 "전체 목록"이라고 보여주면 거짓말이다 → 빈 배열
  const links = [
    { href: 'https://ex.test/webtoon/detail?titleId=7&no=248', text: '248화' },
    { href: 'https://ex.test/webtoon/detail?titleId=7&no=250', text: '250화' },
  ];
  assert.deepEqual(selectEpisodeLinks(links), []);
  assert.equal(MIN_EPISODE_LINKS, 3);
});

check('한 회차가 썸네일·제목 두 줄로 걸려도 한 줄만 남는다', () => {
  const links = [
    { href: 'https://ex.test/manhwa/2/1001', text: '1화' },
    { href: 'https://ex.test/manhwa/2/1001', text: '1화 썸네일' }, // 같은 주소
    { href: 'https://ex.test/manhwa/2/1002', text: '2화' },
    { href: 'https://ex.test/manhwa/2/1003', text: '3화' },
  ];
  const got = selectEpisodeLinks(links);
  assert.deepEqual(
    got.map((e) => e.episodeNum),
    [1, 2, 3]
  );
});

check('같은 회차 번호가 다른 주소로 두 번 와도 한 줄이다', () => {
  const links = [
    { href: 'https://ex.test/manhwa/2/1001', text: '1화' },
    { href: 'https://ex.test/manhwa/2/9001', text: '1화 재업' },
    { href: 'https://ex.test/manhwa/2/1002', text: '2화' },
    { href: 'https://ex.test/manhwa/2/1003', text: '3화' },
  ];
  assert.equal(selectEpisodeLinks(links).filter((e) => e.episodeNum === 1).length, 1);
});

check('번호 없는 링크는 회차가 아니다', () => {
  const links = [
    { href: 'https://ex.test/manhwa/2/1001', text: '1화' },
    { href: 'https://ex.test/manhwa/2/1002', text: '2화' },
    { href: 'https://ex.test/manhwa/2/1003', text: '3화' },
    { href: 'https://ex.test/manhwa/2/notice', text: '공지사항' },
    { href: 'https://ex.test/manhwa/2/best', text: '베스트' },
  ];
  const got = selectEpisodeLinks(links);
  assert.equal(got.length, 3);
  assert.ok(!got.some((e) => /notice|best/.test(e.url)));
});

check('주소에서 회차 번호를 읽지 않는다 — 게시물 번호를 회차로 착각하면 안 된다', () => {
  // 텍스트에 번호가 없으면 주소의 29315 를 29315화로 보면 안 된다
  const links = [
    { href: 'https://ex.test/manhwa/2/29315', text: '보러가기' },
    { href: 'https://ex.test/manhwa/2/29316', text: '보러가기' },
    { href: 'https://ex.test/manhwa/2/29317', text: '보러가기' },
  ];
  assert.deepEqual(selectEpisodeLinks(links), []);
});

check('http(s) 아닌 주소는 버린다', () => {
  const links = [
    { href: 'javascript:void(0)', text: '1화' },
    { href: 'https://ex.test/manhwa/2/1001', text: '1화' },
    { href: 'https://ex.test/manhwa/2/1002', text: '2화' },
    { href: 'https://ex.test/manhwa/2/1003', text: '3화' },
  ];
  const got = selectEpisodeLinks(links);
  assert.equal(got.length, 3);
  assert.ok(got.every((e) => e.url.startsWith('https://')));
});

check('소수점 회차(12.5화)도 순서를 지킨다', () => {
  const links = [
    { href: 'https://ex.test/manhwa/2/1013', text: '13화' },
    { href: 'https://ex.test/manhwa/2/1012', text: '12화' },
    { href: 'https://ex.test/manhwa/2/1012b', text: '12.5화' },
  ];
  assert.deepEqual(
    selectEpisodeLinks(links).map((e) => e.episodeNum),
    [12, 12.5, 13]
  );
});

check('에필로그 N화가 본편 N화를 지우지 않는다 (뉴토키 실측)', () => {
  // "헬퍼 에필로그 1화"와 "헬퍼 1화"는 번호가 같아도 다른 회차다.
  // 예전엔 번호 키 중복 제거로 본편 1~6화가 통째로 사라졌다.
  const links = [
    { href: 'https://ex.test/webtoon/2058/81190', text: '헬퍼 에필로그 2화' },
    { href: 'https://ex.test/webtoon/2058/81189', text: '헬퍼 에필로그 1화' },
    { href: 'https://ex.test/webtoon/2058/81003', text: '헬퍼 3화 - 시작' },
    { href: 'https://ex.test/webtoon/2058/81002', text: '헬퍼 2화 - 만남' },
    { href: 'https://ex.test/webtoon/2058/81001', text: '헬퍼 1화 - 죽음' },
  ];
  const got = selectEpisodeLinks(links);
  assert.equal(got.length, 5);
  // 본편이 먼저, 에필로그는 뒤에 — 라벨로 구별된다
  assert.deepEqual(
    got.map((e) => e.label),
    ['1화', '2화', '3화', '에필로그 1화', '에필로그 2화']
  );
  assert.equal(got[0].url, 'https://ex.test/webtoon/2058/81001');
});

check('번호 없는 제목에 댓글 수가 붙어도 본편 회차를 가리지 않는다', () => {
  // "헬퍼 후기" + 댓글수 "1" → "헬퍼 후기 1" 이 1화로 오인되던 사례.
  // head 가 달라서 본편 1화와 다른 줄로 남는다 — 본편 1화가 사라지면 안 된다.
  const links = [
    { href: 'https://ex.test/webtoon/2058/81196', text: '헬퍼 후기 1' },
    { href: 'https://ex.test/webtoon/2058/81001', text: '헬퍼 1화 - 죽음' },
    { href: 'https://ex.test/webtoon/2058/81002', text: '헬퍼 2화 - 만남' },
    { href: 'https://ex.test/webtoon/2058/81003', text: '헬퍼 3화 - 시작' },
  ];
  const got = selectEpisodeLinks(links);
  const first = got.find((e) => e.episodeNum === 1 && e.label === '1화');
  assert.ok(first, '본편 1화가 살아 있어야 한다');
  assert.equal(first.url, 'https://ex.test/webtoon/2058/81001');
});

check('같은 목록의 다음 쪽 주소를 찾는다 (?epage=2)', () => {
  const listUrl = 'https://ex.test/webtoon/2058';
  const links = [
    { href: 'https://ex.test/webtoon/2058/81001', text: '1화' }, // 회차 — 쪽이 아니다
    { href: 'https://ex.test/webtoon/2058?epage=2', text: '2' },
    { href: 'https://ex.test/webtoon/2058?epage=2', text: '다음' }, // 중복은 한 번만
    { href: 'https://ex.test/webtoon/9999?epage=2', text: '2' }, // 다른 작품 목록
    { href: 'https://other.test/webtoon/2058?epage=2', text: '2' }, // 다른 사이트
    { href: 'https://ex.test/webtoon/2058?epage=1', text: '1' }, // 1쪽은 지금 문서다
  ];
  assert.deepEqual(findListPageUrls(links, listUrl), ['https://ex.test/webtoon/2058?epage=2']);
});

check('페이지 파라미터가 없으면 다음 쪽도 없다', () => {
  const links = [
    { href: 'https://ex.test/webtoon/2058/81001', text: '1화' },
    { href: 'https://ex.test/webtoon/2058#comment', text: '댓글' },
  ];
  assert.deepEqual(findListPageUrls(links, 'https://ex.test/webtoon/2058'), []);
  assert.deepEqual(findListPageUrls(null, 'https://ex.test/webtoon/2058'), []);
  assert.deepEqual(findListPageUrls([], '::잘못된주소::'), []);
});

check('빈 입력·잘못된 입력에 죽지 않는다', () => {
  assert.deepEqual(selectEpisodeLinks([]), []);
  assert.deepEqual(selectEpisodeLinks(null), []);
  assert.deepEqual(selectEpisodeLinks([null, undefined, {}, { href: 5 }]), []);
});

console.log(`\n회차 링크 선별 ${passed}개 통과`);
