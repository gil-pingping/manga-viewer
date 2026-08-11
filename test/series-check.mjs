import assert from 'node:assert/strict';
import { parseSeriesAndEpisode, groupChaptersBySeries } from '../src/core/series.js';

console.log('=== 시리즈 파싱 및 그룹핑 테스트 ===');

// 1. 회차 파싱 테스트
const p1 = parseSeriesAndEpisode('원펀맨 215화');
assert.equal(p1.seriesTitle, '원펀맨');
assert.equal(p1.episodeNum, 215);

const p2 = parseSeriesAndEpisode('[원피스] 1080화 - 루피의 신기술');
assert.equal(p2.seriesTitle, '원피스');
assert.equal(p2.episodeNum, 1080);

const p3 = parseSeriesAndEpisode('나루토 5화');
assert.equal(p3.seriesTitle, '나루토');
assert.equal(p3.episodeNum, 5);

console.log('✔ 단일 회차 제목 파싱 성공');

// 2. 그룹핑 및 자연어 순서 정렬 테스트
const chapters = [
  { id: '1', title: '원펀맨 215화', pages: [{ url: 'http://img/opm215_1.jpg' }] },
  { id: '2', title: '원펀맨 2화', pages: [{ url: 'http://img/opm2_1.jpg' }] },
  { id: '3', title: '원펀맨 1화', pages: [{ url: 'http://img/opm1_1.jpg' }] },
  { id: '4', title: '원피스 1080화', pages: [{ url: 'http://img/op1080_1.jpg' }] },
  { id: '5', title: '원피스 2화', pages: [{ url: 'http://img/op2_1.jpg' }] },
];

const groups = groupChaptersBySeries(chapters);

// 2개 시리즈 그룹 생성 확인
assert.equal(groups.length, 2);

const opmGroup = groups.find((g) => g.seriesTitle === '원펀맨');
assert.ok(opmGroup);
assert.equal(opmGroup.chapters.length, 3);
// 자연 순서 정렬 확인 (1화 -> 2화 -> 215화)
assert.equal(opmGroup.chapters[0].parsedEpisodeNum, 1);
assert.equal(opmGroup.chapters[1].parsedEpisodeNum, 2);
assert.equal(opmGroup.chapters[2].parsedEpisodeNum, 215);

console.log('✔ 원펀맨 / 원피스 시리즈별 그룹핑 및 회차 자연어 순서 정렬 성공!');

// 3. 대표 coverUrl 추출 및 설정 테스트
const chaptersWithCover = [
  { id: '10', title: '원피스 1화', coverUrl: 'http://img/onepiece_cover.jpg', pages: [{ url: 'http://img/op1_1.jpg' }] }
];
const groupsWithCover = groupChaptersBySeries(chaptersWithCover);
assert.equal(groupsWithCover[0].coverUrl, 'http://img/onepiece_cover.jpg');
console.log('✔ 대표 표지 이미지(coverUrl) 그룹핑 및 설정 성공!');

// 4. 늑대닷컴 / wfwf 등 사이트 브랜딩 제거 및 URL 시리즈 키 기반 합치기 테스트
const w1 = parseSeriesAndEpisode('원피스 961 - 늑대닷컴');
assert.equal(w1.seriesTitle, '원피스');
assert.equal(w1.episodeNum, 961);

const w2 = parseSeriesAndEpisode('[늑대닷컴] 원피스 962화 > 늑대닷컴');
assert.equal(w2.seriesTitle, '원피스');
assert.equal(w2.episodeNum, 962);

const wfwfChapters = [
  { id: 'w1', title: '원피스 961 - 늑대닷컴', sourceUrl: 'https://wfwf436.com/cv?toon=10042&num=961' },
  { id: 'w2', title: '원피스 962화 > 늑대닷컴', sourceUrl: 'https://wfwf436.com/cv?toon=10042&num=962' },
];
const wfwfGroups = groupChaptersBySeries(wfwfChapters);
assert.equal(wfwfGroups.length, 1);
assert.equal(wfwfGroups[0].seriesTitle, '원피스');
assert.equal(wfwfGroups[0].chapters.length, 2);
assert.equal(wfwfGroups[0].chapters[0].parsedEpisodeNum, 961);
assert.equal(wfwfGroups[0].chapters[1].parsedEpisodeNum, 962);

console.log('✔ 늑대닷컴 / wfwf 사이트 브랜딩 제거 및 URL 시리즈 키 그룹핑 성공!');

// 5. 깨진 텍스트(æ...) 자가 치유 및 단정한 episodeLabel (953화) 테스트
const brokenParse = parseSeriesAndEpisode('◆◆◆æ◆(ONE PIECE) 953 - ◆◆◆◆');
assert.equal(brokenParse.seriesTitle, 'ONE PIECE');
assert.equal(brokenParse.episodeNum, 953);
assert.equal(brokenParse.episodeLabel, '953화');

const brokenChapters = [
  { id: 'b1', title: '◆◆◆æ◆(ONE PIECE) 953 - ◆◆◆◆', sourceUrl: 'https://wfwf436.com/cv?toon=10042&num=953' },
];
const brokenGroups = groupChaptersBySeries(brokenChapters);
assert.equal(brokenGroups[0].chapters[0].parsedEpisodeLabel, '953화');
assert.equal(brokenGroups[0].chapters[0].title, 'ONE PIECE 953화');

console.log('✔ 깨진 제목 챕터 자가 치유(Self-healing) 및 깔끔한 목차 라벨(953화) 정제 성공!');

// 6. formatEpisodeDisplayLabel 및 '회차' 단어 방지 검증
import { formatEpisodeDisplayLabel } from '../src/core/series.js';

assert.equal(formatEpisodeDisplayLabel({ title: '회차' }, 0), '1화');
assert.equal(formatEpisodeDisplayLabel({ title: '◆◆◆æ◆' }, 2), '3화');
assert.notEqual(formatEpisodeDisplayLabel({ title: 'ONE PIECE 953' }, 0), '회차');
assert.equal(formatEpisodeDisplayLabel({ title: 'ONE PIECE 953' }, 0), '953화');

console.log('✔ 목차 내 "회차" 단어 발생 완전 봉쇄 및 N화 정제 검증 성공!');



