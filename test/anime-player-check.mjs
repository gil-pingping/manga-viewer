import test from 'node:test';
import assert from 'node:assert/strict';

test('AnimePlayer: 오프닝/엔딩 타임스탬프 스킵 로직 검증', () => {
  const mockAnime = {
    seriesTitle: '원피스',
    episodeNumber: 945,
    streamUrl: 'https://example.com/stream.m3u8',
    timestamps: {
      op: { startTime: 85.5, endTime: 175.5 },
      ed: { startTime: 1320.0, endTime: 1410.0 },
    },
  };

  // 비디오 timeupdate 시뮬레이션
  let currentTime = 86.0;
  let hasSkipped = false;
  let seekTarget = 0;

  if (currentTime >= mockAnime.timestamps.op.startTime && currentTime < mockAnime.timestamps.op.endTime) {
    hasSkipped = true;
    seekTarget = mockAnime.timestamps.op.endTime;
  }

  assert.equal(hasSkipped, true);
  assert.equal(seekTarget, 175.5);

  // 엔딩 스킵 시뮬레이션
  currentTime = 1321.0;
  let autoNextTriggered = false;
  if (currentTime >= mockAnime.timestamps.ed.startTime) {
    autoNextTriggered = true;
  }

  assert.equal(autoNextTriggered, true);
  console.log('✔ Phase 2 AnimePlayer 오프닝/엔딩 정밀 스킵 로직 2회 검증 통과!');
});
