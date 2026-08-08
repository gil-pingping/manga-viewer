import test from 'node:test';
import assert from 'node:assert/strict';
import { isAnilifeUrl, parseAnilifeWatchId, parseAnilifePage } from '../src/collect/anilifeCollector.js';

test('anilifeCollector: URL 판별 및 UUID 추출', () => {
  assert.equal(isAnilifeUrl('https://anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), true);
  assert.equal(isAnilifeUrl('https://naver.com'), false);
  assert.equal(parseAnilifeWatchId('https://anilife.app/watch?id=32bd6d4c-e5bb-4124-a890-e389a30007ea'), '32bd6d4c-e5bb-4124-a890-e389a30007ea');
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
