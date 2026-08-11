/**
 * @file anilifeCollector.js
 * anilife.app watch 주소에서 서재용 메타데이터를 추출한다.
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
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (
      host === 'anilife.app' ||
      host.endsWith('.anilife.app') ||
      host === 'anilife.live' ||
      host.endsWith('.anilife.live')
    );
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
    if (parsed.pathname !== '/watch') return null;
    const id = parsed.searchParams.get('id') || '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

/**
 * anilife HTML의 title/meta와 구·신 SSR 페이로드에서 애니 메타데이터를 추출한다.
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

  // 4. 현재 Nuxt SSR payload. 값이 배열 인덱스로 압축돼 있어 한 단계 역참조한다.
  const nuxtDataMatch = html.match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nuxtDataMatch?.[1]) {
    try {
      const payload = JSON.parse(nuxtDataMatch[1]);
      const value = (candidate) =>
        Number.isInteger(candidate) && candidate >= 0 && candidate < payload.length
          ? payload[candidate]
          : candidate;
      const summary = payload.find((item) =>
        item && typeof item === 'object' && !Array.isArray(item) &&
        Object.hasOwn(item, 'episodeNum') && Object.hasOwn(item, 'media')
      );
      if (summary) {
        episodeNumber = Number(value(summary.episodeNum)) || episodeNumber;
        episodeTitle = value(summary.subject) || episodeTitle;
        posterUrl = value(summary.thumbnail) || posterUrl;
        const media = value(summary.media);
        if (media && typeof media === 'object') {
          seriesTitle = value(media.title) || seriesTitle;
        }
      }
    } catch (error) {
      console.warn('Nuxt 데이터 파싱 경고:', error);
    }
  }

  // 5. 구조화된 구형 페이지에 직접 실린 재생 주소만 보존한다.
  if (!streamUrl) {
    const videoSrcMatch = html.match(/<video[^>]+src=["'](.*?)["']/i) || html.match(/<source[^>]+src=["'](.*?)["']/i);
    if (videoSrcMatch) streamUrl = videoSrcMatch[1];
  }

  if (!embedUrl) {
    const iframeSrcMatch = html.match(/<iframe[^>]+src=["'](.*?)["']/i);
    if (iframeSrcMatch) embedUrl = iframeSrcMatch[1];
  }

  const watchId = parseAnilifeWatchId(sourceUrl);
  if (!watchId) return null;

  return {
    id: watchId,
    kind: 'anime',
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
