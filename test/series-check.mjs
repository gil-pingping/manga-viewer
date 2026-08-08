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
