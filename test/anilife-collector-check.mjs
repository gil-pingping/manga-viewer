import test from 'node:test';
import assert from 'node:assert/strict';
import { isAnilifeUrl, parseAnilifeWatchId, parseAnilifePage } from '../src/collect/anilifeCollector.js';

test('anilifeCollector: URL 판별 및 UUID 추출', () => {
  assert.equal(isAnilifeUrl('https://anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), true);
  assert.equal(isAnilifeUrl('https://evil-anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), false);
  assert.equal(isAnilifeUrl('http://anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), false);
  assert.equal(isAnilifeUrl('https://naver.com'), false);
  assert.equal(parseAnilifeWatchId('https://anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), '32bd6d4c-e5bb-4124-a890-e389a30007ea');
  assert.equal(parseAnilifeWatchId('https://anilife.app/watch?id=not-a-uuid'), null);
  assert.equal(parseAnilifeWatchId('https://anilife.app/content?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), null);
});

test('anilifeCollector: 현재 Nuxt SSR payload를 서재 메타데이터로 변환', () => {
  const payload = [
    ['ShallowReactive', 1],
    { data: 2 },
    ['ShallowReactive', 3],
    { current: 4 },
    { subject: 5, episodeNum: 6, thumbnail: 7, media: 8 },
    '불꽃놀이 갈래',
    '6',
    'https://image.anilife.life/thumb.png',
    { id: 9, title: 10 },
    1371,
    '내가 인기 없는 것은 아무리 생각해도 너희들이 나빠!',
  ];
  const html = `
    <title>옛 제목 - 6화 | 애니라이프</title>
    <script type="application/json" id="__NUXT_DATA__">${JSON.stringify(payload)}</script>
  `;
  const parsed = parseAnilifePage(
    html,
    'https://anilife.app/watch?id=26050e24-2175-4e15-855d-d864120abc30'
  );

  assert.equal(parsed.id, '26050e24-2175-4e15-855d-d864120abc30');
  assert.equal(parsed.kind, 'anime');
  assert.equal(parsed.seriesTitle, '내가 인기 없는 것은 아무리 생각해도 너희들이 나빠!');
  assert.equal(parsed.episodeNumber, 6);
  assert.equal(parsed.episodeTitle, '불꽃놀이 갈래');
  assert.equal(parsed.posterUrl, 'https://image.anilife.life/thumb.png');
  assert.equal(parsed.timestamps.op, null);
});

test('anilifeCollector: 2단계 HTML/Next.js 데이터 및 타임스탬프 파싱 검증', () => {
  const mockHtml = `
    <html>
      <head>
        <title>원피스 - 945화 | 애니라이프</title>
        <meta property="og:description" content="원념의 단팥죽" />
        <meta property="og:image" content="https://anilife.app/poster/onepiece.jpg" />
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "animeTitle": "원피스",
                "episodeNo": 945,
                "streamUrl": "https://stream.anilife.app/onepiece/945.m3u8",
                "episodes": [
                  { "id": "32bd6d4c-e5bb-4124-a890-e389a30007ea", "episodeNo": 945, "title": "945화" },
                  { "id": "99aa88bb-77cc-4124-a890-e389a30007eb", "episodeNo": 946, "title": "946화" }
                ],
                "skipTimes": {
                  "op": { "start": 85.5, "end": 175.5 },
                  "ed": { "start": 1320.0, "end": 1410.0 }
                }
              }
            }
          }
        </script>
      </head>
      <body></body>
    </html>
  `;

  const parsed = parseAnilifePage(mockHtml, 'https://anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea');
  assert.notEqual(parsed, null);
  assert.equal(parsed.seriesTitle, '원피스');
  assert.equal(parsed.episodeNumber, 945);
  assert.equal(parsed.streamUrl, 'https://stream.anilife.app/onepiece/945.m3u8');
  assert.equal(parsed.episodesMap.length, 2);
  assert.equal(parsed.episodesMap[1].id, '99aa88bb-77cc-4124-a890-e389a30007eb');
  assert.equal(parsed.timestamps.op.startTime, 85.5);
  assert.equal(parsed.timestamps.op.endTime, 175.5);
  assert.equal(parsed.timestamps.ed.startTime, 1320.0);
  console.log('✔ Phase 1 anilifeCollector 2회 검증 통과!');
});
