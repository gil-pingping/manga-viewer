/**
 * @file anilifeCollector.js
 * anilife.app (애니라이프) 애니메이션 수집 및 에피소드 UUID 맵, 정밀 스킵 타임스탬프 추출기
 */

/**
 * anilife.app 주소 여부를 판별한다.
 * @param {string} url 
 * @returns {boolean}
 */
export function isAnilifeUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('anilife.app') || parsed.hostname.includes('anilife.live');
  } catch {
    return false;
  }
}

/**
 * anilife.app watch URL에서 id (UUID)를 추출한다.
 * @param {string} url 
 * @returns {string|null}
 */
export function parseAnilifeWatchId(url) {
  if (!isAnilifeUrl(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('id') || null;
  } catch {
    return null;
  }
}

/**
 * anilife HTML 또는 Next.js 페이로드에서 애니 메타데이터 및 회차 UUID 맵, 정밀 스킵 타임스탬프를 추출한다.
 * @param {string} html 
 * @param {string} sourceUrl 
 * @returns {Object|null}
 */
export function parseAnilifePage(html, sourceUrl) {
  if (!html) return null;

  let seriesTitle = '애니메이션';
  let episodeNumber = 1;
  let episodeTitle = '';
  let streamUrl = '';
  let embedUrl = '';
  let posterUrl = '';
  let episodesMap = [];
  let timestamps = { op: null, ed: null };

  // 1. HTML title tag 분석: 예) "원피스 - 945화 | 애니라이프"
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const rawTitle = titleMatch[1].replace(/\|\s*애니라이프/i, '').trim();
    const parts = rawTitle.split('-').map((s) => s.trim());
    if (parts.length >= 2) {
      seriesTitle = parts[0];
      const epMatch = parts[1].match(/(\d+)화?/);
      if (epMatch) {
        episodeNumber = parseInt(epMatch[1], 10);
      }
      episodeTitle = parts.slice(1).join(' - ');
    } else {
      seriesTitle = rawTitle;
    }
  }

  // 2. OG Meta 태그 분석
  const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["'](.*?)["']/i);
  if (ogDescMatch && ogDescMatch[1]) {
    episodeTitle = ogDescMatch[1];
  }

  const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["'](.*?)["']/i);
  if (ogImageMatch && ogImageMatch[1]) {
    posterUrl = ogImageMatch[1];
  }

  // 3. Next.js __NEXT_DATA__ JSON 페이로드 추출 시도
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (nextDataMatch && nextDataMatch[1]) {
    try {
      const json = JSON.parse(nextDataMatch[1]);
      const pageProps = json.props?.pageProps;
      if (pageProps) {
        if (pageProps.animeTitle) seriesTitle = pageProps.animeTitle;
        if (pageProps.episodeNo) episodeNumber = pageProps.episodeNo;
        if (pageProps.streamUrl) streamUrl = pageProps.streamUrl;
        if (pageProps.embedUrl) embedUrl = pageProps.embedUrl;
        if (pageProps.poster) posterUrl = pageProps.poster;

        // 회차 맵 (전체 에피소드 UUID 목록)
        if (Array.isArray(pageProps.episodes)) {
          episodesMap = pageProps.episodes.map((ep) => ({
            id: ep.id,
            episodeNo: ep.episodeNo || ep.number,
            title: ep.title || `${ep.episodeNo}화`,
            url: `https://anilife.app/watch?id=${ep.id}`,
          }));
        }

        // 정밀 오프닝/엔딩 타임스탬프 (op, ed)
        if (pageProps.skipTimes || pageProps.timestamps) {
          const rawSt = pageProps.skipTimes || pageProps.timestamps;
          if (rawSt.op) timestamps.op = { startTime: rawSt.op.start, endTime: rawSt.op.end };
          if (rawSt.ed) timestamps.ed = { startTime: rawSt.ed.start, endTime: rawSt.ed.end };
        }
      }
    } catch (e) {
      console.warn('Next.js 데이터 파싱 경고:', e);
    }
  }

  // 4. 비디오 태그 또는 iframe src 폴백 추출
  if (!streamUrl) {
    const videoSrcMatch = html.match(/<video[^>]+src=["'](.*?)["']/i) || html.match(/<source[^>]+src=["'](.*?)["']/i);
    if (videoSrcMatch) streamUrl = videoSrcMatch[1];
  }

  if (!embedUrl) {
    const iframeSrcMatch = html.match(/<iframe[^>]+src=["'](.*?)["']/i);
    if (iframeSrcMatch) embedUrl = iframeSrcMatch[1];
  }

  // 5. 정밀 스킵 타임스탬프 기본값 폴백 (전형적 OP: 85초~175초, ED: 끝 90초 전)
  if (!timestamps.op) {
    timestamps.op = { startTime: 85, endTime: 175 };
  }

  const watchId = parseAnilifeWatchId(sourceUrl);

  return {
    id: watchId || `anilife-${seriesTitle}-${episodeNumber}`,
    type: 'anime',
    sourceUrl,
    seriesTitle,
    episodeNumber,
    episodeTitle,
    posterUrl,
    streamUrl,
    embedUrl,
    episodesMap,
    timestamps,
  };
}
