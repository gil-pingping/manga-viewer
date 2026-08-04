/**
 * 본문 이미지를 골라내는 규칙 — 단일 진실.
 *
 * 왜 여기 모았나: 예전에는 이 판단이 collector.js(북마클릿)와
 * urlHarvester.js(서버 HTML 파싱)에 각각 복붙돼 있었다. 한쪽에서 크기
 * 조건을 고치고 다른 쪽을 안 고쳐서 같은 사이트가 경로에 따라 다르게
 * 동작했다. 규칙은 한 번만 쓴다.
 *
 * 설계 제약 두 가지:
 *  1) 순수 함수만. DOM 도 fetch 도 안 쓴다 → 브라우저 없이 테스트된다.
 *  2) 이 파일의 함수는 문자열화되어 북마클릿에 실린다 → 모듈 밖의 것을
 *     참조하면 안 된다. 각 함수가 자기완결적이어야 한다.
 *
 * 입력은 "이미지 서술자". DOM 엘리먼트를 그대로 받지 않는다:
 *   { tag, src, dataSrc, dataOriginal, srcset, width, height,
 *     naturalWidth, naturalHeight, offsetWidth, offsetHeight }
 * 덕분에 실제 DOM 이든 파싱한 HTML 이든 같은 규칙을 쓴다.
 */

/** 짧은 변이 이보다 얇으면 본문 컷이 아니다 */
export const MIN_SHORT_SIDE = 180;

/** 연번으로 인정할 최소 장수 */
export const MIN_SERIES_LENGTH = 3;

/**
 * 이름만 보고 걸러낼 것들.
 * 크기 조건만으로는 못 잡고, 이름만으로도 못 잡는다(CDN 은 해시 파일명을 쓴다).
 * 둘을 같이 쓴다.
 */
export const JUNK_PATTERN =
  // `ad[_-]` 앞의 (?<![a-z]) 가 중요하다. 없으면 upload_ · download_ · road- 를
  // 광고로 오인한다 (네이버 작가 배너 upload_427.JPEG 가 그렇게 잘못 걸렸다).
  /logo|icon|banner|button|avatar|thumb|captcha|loading|spinner|notice|emoji|smil|sns|(?<![a-z])ad[_-]|advert|google|facebook|twitter|kakao|naver_|profile|blank\.|1x1|pixel|copyright|wordmark|poweredby|sprite|footer|header|gestalt|illustration|\/static\//i;

/** 이미지가 아닌 게 확실한 확장자. <source> 태그로 오디오·비디오가 섞여 들어온다 */
export const NOT_IMAGE_EXT = /\.(mp3|mp4|m4a|webm|ogg|wav|avi|mov|js|css|json|xml)(\?|#|$)/i;

/**
 * lazy-load 사이트는 진짜 주소를 data-* 에 숨기고 src 에는 placeholder 를 넣는다.
 * 그래서 src 를 마지막에 본다.
 */
export function pickSource(el) {
  const candidates = [
    el.dataOriginal,
    el.dataSrc,
    el.dataLazySrc,
    el.dataEcho,
    largestFromSrcset(el.srcset),
    el.src,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    const v = String(c).trim();
    if (!v) continue;
    if (v.indexOf('data:') === 0 || v.indexOf('blob:') === 0) continue;
    return v;
  }
  return null;
}

/** srcset="a.jpg 1x, b.jpg 2x" 중 가장 큰 것 */
export function largestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestWeight = -1;
  const parts = String(srcset).split(',');
  for (let i = 0; i < parts.length; i++) {
    const bits = parts[i].trim().split(/\s+/);
    if (!bits[0]) continue;
    const weight = bits[1] ? parseFloat(bits[1]) || 1 : 1;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = bits[0];
    }
  }
  return best;
}

/** 상대 주소를 절대 주소로. 기준이 없으면 포기한다 */
export function absolutize(src, baseUrl) {
  if (!src) return null;
  const v = String(src).replace(/\\\//g, '/').trim();
  if (!v) return null;

  if (/^https?:\/\//i.test(v)) return v;
  if (v.indexOf('//') === 0) return 'https:' + v;
  if (!baseUrl) return null;

  try {
    return new URL(v, baseUrl).href;
  } catch (e) {
    return null;
  }
}

/**
 * 크기로 본문 컷을 가린다.
 *
 * 짧은 변 하나만 본다. 광고 표준 규격은 전부 한쪽이 얇다
 * (728x90 · 970x90 → 90, 160x600 → 160, 234x60 → 60).
 * 만화 컷이든 사진이든 짧은 변이 두툼하다. 긴 변 조건을 같이 걸면
 * 228x295 같은 정사각형 사진이 억울하게 잘린다 (Pinterest 에서 확인).
 */
export function isBigEnough(el) {
  const nw = el.naturalWidth || 0;
  const nh = el.naturalHeight || 0;
  if (nw > 0 && nh > 0) return Math.min(nw, nh) >= MIN_SHORT_SIDE;

  const ow = el.offsetWidth || 0;
  const oh = el.offsetHeight || 0;
  if (ow > 0 && oh > 0) return Math.min(ow, oh) >= MIN_SHORT_SIDE;

  // HTML 만 파싱했으면 실제 크기를 모른다. 명시된 속성이 작을 때만 버린다
  const aw = parseInt(el.width || '0', 10);
  const ah = parseInt(el.height || '0', 10);
  if ((aw > 0 && aw < MIN_SHORT_SIDE) || (ah > 0 && ah < MIN_SHORT_SIDE)) return false;

  return true;
}

/**
 * 격자로 보여주는 사이트는 작은 썸네일을 심어둔다. 전체화면에서는 뭉개진다.
 * 주소에 크기 조각이 있으면 큰 판으로 바꿔치기한다.
 * 같은 이미지의 다른 해상도일 뿐 — 없는 걸 만들어내지 않는다.
 */
export function upgradeResolution(url) {
  if (!url) return url;
  if (url.indexOf('i.pinimg.com/') !== -1) {
    return url.replace(/\/(\d{2,4}x)\//, '/736x/');
  }
  return url;
}

/* ==================================================================== */
/* 본문 구간 찾기                                                        */
/* ==================================================================== */

/**
 * 주소를 (디렉터리, 파일명 골격, 번호) 로 쪼갠다.
 *
 * "골격"은 파일명에서 마지막 숫자 덩어리를 자리표시자로 바꾼 것이다.
 *   p001.jpg                  -> dir + "p#.jpg"        번호 1
 *   20260706_abc_IMAG01_7.jpg -> dir + "…_IMAG01_#.jpg" 번호 7
 *   a1b2c3d4.jpg              -> 번호 없음 (해시 파일명)
 */
export function parseSeriesKey(url) {
  const clean = url.split('?')[0].split('#')[0];
  const slash = clean.lastIndexOf('/');
  const dir = clean.slice(0, slash + 1);
  const file = clean.slice(slash + 1);

  // 마지막 숫자 덩어리를 찾는다
  const m = /^(.*?)(\d+)(\D*)$/.exec(file);
  if (!m) return null;

  const digits = m[2];
  // 해시 파일명(16자 이상 숫자)이나 날짜 뭉치는 연번이 아니다
  if (digits.length > 6) return null;

  return { skeleton: dir + m[1] + '#' + m[3], number: parseInt(digits, 10) };
}

/**
 * 연번으로 이어지는 최장 묶음을 찾는다.
 *
 * 사용자 관찰: 만화 본문은 p001.jpg 부터 시작하고 그 위(앞)의 이미지들은
 * 배너·썸네일이다. 네이버 웹툰도 썸네일 다음부터 _IMAG01_1..97 이 이어진다.
 * 즉 "같은 폴더 + 같은 파일명 골격 + 이어지는 번호" 가 본문의 지문이다.
 *
 * 디렉터리 다수결보다 정확하다. 같은 폴더에 섞인 썸네일은 골격이 달라서
 * (연번이 아니라서) 자동으로 빠진다.
 *
 * 연번을 못 찾으면 null. Pinterest 처럼 파일명이 해시인 사이트가 그렇다.
 */
export function findNumberedSeries(urls) {
  const groups = {};
  const order = [];

  for (let i = 0; i < urls.length; i++) {
    const parsed = parseSeriesKey(urls[i]);
    if (!parsed) continue;
    if (!groups[parsed.skeleton]) {
      groups[parsed.skeleton] = [];
      order.push(parsed.skeleton);
    }
    groups[parsed.skeleton].push({ url: urls[i], number: parsed.number });
  }

  let best = null;
  for (let i = 0; i < order.length; i++) {
    const list = groups[order[i]];
    if (list.length < MIN_SERIES_LENGTH) continue;
    if (!best || list.length > best.length) best = list;
  }
  if (!best) return null;

  // 번호 순으로 정렬한다 — DOM 순서가 어긋난 사이트에서도 페이지 순서가 맞는다
  best.sort((a, b) => a.number - b.number);
  return best.map((x) => x.url);
}

/**
 * 한 화의 컷들은 같은 디렉터리에 몰려 있다.
 * 연번을 못 찾았을 때 쓰는 차선책.
 *
 * 뚜렷한 다수가 없으면 손대지 않는다. Pinterest 처럼 항목마다 디렉터리가
 * 다른 사이트에서는 이 규칙이 아무것도 하지 않아야 한다.
 */
export function keepDominantDirectory(urls) {
  if (urls.length < 4) return urls;

  const groups = {};
  const order = [];
  for (let i = 0; i < urls.length; i++) {
    const dir = urls[i].slice(0, urls[i].lastIndexOf('/') + 1);
    if (!groups[dir]) {
      groups[dir] = [];
      order.push(dir);
    }
    groups[dir].push(urls[i]);
  }
  if (order.length < 2) return urls;

  let best = [];
  for (let i = 0; i < order.length; i++) {
    if (groups[order[i]].length > best.length) best = groups[order[i]];
  }

  return best.length >= 3 && best.length >= urls.length * 0.5 ? best : urls;
}

/**
 * 왜 이 이미지가 빠졌는지 설명한다.
 *
 * 사이트가 안 잡힐 때 개발자도구를 열지 않고 원인을 찾기 위한 것이다.
 * selectContentImages 와 같은 순서로 판정하며 단계별로 몇 개가 빠졌는지 센다.
 * 규칙을 두 번 구현하지 않으려고 같은 함수들을 쓴다.
 */
export function explainSelection(elements, baseUrl) {
  const stages = {
    노소스: [],
    주소불가: [],
    이미지아님: [],
    이름걸림: [],
    크기미달: [],
    중복: [],
  };
  const seen = {};
  const picked = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const label = (el.src || el.dataSrc || el.dataOriginal || '(빈 요소)').slice(0, 90);

    const raw = pickSource(el);
    if (!raw) {
      stages['노소스'].push(label);
      continue;
    }
    const abs = absolutize(raw, baseUrl);
    if (!abs) {
      stages['주소불가'].push(label);
      continue;
    }
    if (NOT_IMAGE_EXT.test(abs)) {
      stages['이미지아님'].push(abs);
      continue;
    }
    if (JUNK_PATTERN.test(abs)) {
      stages['이름걸림'].push(abs);
      continue;
    }
    if (!isBigEnough(el)) {
      const w = el.naturalWidth || el.offsetWidth || el.width || '?';
      const h = el.naturalHeight || el.offsetHeight || el.height || '?';
      stages['크기미달'].push(`${abs}  (${w}x${h})`);
      continue;
    }
    const url = upgradeResolution(abs);
    if (seen[url]) {
      stages['중복'].push(url);
      continue;
    }
    seen[url] = 1;
    picked.push(url);
  }

  const series = findNumberedSeries(picked);
  const final = series || keepDominantDirectory(picked);
  const finalSet = {};
  for (let i = 0; i < final.length; i++) finalSet[final[i]] = 1;

  const groupedOut = picked.filter((u) => !finalSet[u]);
  const groupStage = series ? '연번구간밖' : '다른폴더';

  return {
    total: elements.length,
    kept: final.length,
    method: series ? '연번 구간' : picked.length === final.length ? '전부 통과' : '디렉터리 다수결',
    stages: [
      ...Object.keys(stages)
        .filter((k) => stages[k].length > 0)
        .map((k) => ({ name: k, dropped: stages[k].length, samples: stages[k].slice(0, 4) })),
      ...(groupedOut.length
        ? [{ name: groupStage, dropped: groupedOut.length, samples: groupedOut.slice(0, 4) }]
        : []),
    ],
    urls: final,
  };
}

/**
 * 서술자 목록 → 본문 이미지 주소 목록.
 * 수집 경로들이 공유하는 단 하나의 진입점이다.
 */
export function selectContentImages(elements, baseUrl) {
  const seen = {};
  const picked = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    const raw = pickSource(el);
    if (!raw) continue;

    const abs = absolutize(raw, baseUrl);
    if (!abs) continue;

    if (NOT_IMAGE_EXT.test(abs)) continue; // mp3 등이 <source> 로 섞여 들어온다
    if (JUNK_PATTERN.test(abs)) continue;
    if (!isBigEnough(el)) continue;

    const url = upgradeResolution(abs);
    if (seen[url]) continue; // 해상도 승격 후에 중복을 판정한다
    seen[url] = 1;
    picked.push(url);
  }

  // 연번이 본문의 가장 확실한 지문이다. 없으면 디렉터리 다수결로 물러난다.
  return findNumberedSeries(picked) || keepDominantDirectory(picked);
}
