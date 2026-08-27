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
    // <img> 없이 CSS 배경으로 컷을 그리는 뷰어도 있다
    el.bgImage,
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
 * 파일명을 "모양"으로 바꾼다. 숫자는 #, 16진수 뭉치는 x, 나머지는 그대로.
 *
 *   004439_45ed7219c6cc.png  ->  #_x.png
 *   075431_ee52d4c3d337.png  ->  #_x.png     (같은 모양)
 *   logo_newtoki.png         ->  logo_newtoki.png
 *   logo-full-manatoki3.png  ->  logo-full-manatoki#.png
 *
 * 업로더가 같은 규칙으로 뽑아낸 파일들은 모양이 같다. 사이트 로고·배너는
 * 사람이 붙인 이름이라 모양이 다르다. 그게 이 규칙의 근거다.
 */
export function filenameShape(url) {
  const clean = url.split('?')[0].split('#')[0];
  const file = clean.slice(clean.lastIndexOf('/') + 1);

  return (
    file
      // 16진수처럼 보이는 긴 뭉치를 먼저 접는다 (해시·UUID 조각)
      .replace(/[0-9a-f]{8,}/gi, 'x')
      // 남은 숫자 뭉치를 접는다
      .replace(/\d+/g, '#')
  );
}

/**
 * 같은 폴더 + 같은 파일명 모양의 최다 묶음을 찾는다.
 *
 * 연번이 아닌 사이트를 위한 규칙이다. 실제로 본 예: 본문 파일명이
 * `시각_해시.png` 형태로 수십 장 이어지고, 그 위에 로고 몇 개가 얹혀 있다.
 * 번호가 이어지지 않으니 findNumberedSeries 로는 못 잡지만 모양은 똑같다.
 *
 * 문서 순서를 유지한다 — 모양만 같고 번호가 없으면 정렬 근거가 없으므로
 * 페이지에 실린 순서를 믿는 것이 맞다.
 */
export function findDominantShape(urls) {
  if (urls.length < 4) return null;

  const groups = {};
  const order = [];
  for (let i = 0; i < urls.length; i++) {
    const dir = urls[i].slice(0, urls[i].lastIndexOf('/') + 1);
    const key = dir + '|' + filenameShape(urls[i]);
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(urls[i]);
  }
  if (order.length < 2) return null;

  let best = [];
  for (let i = 0; i < order.length; i++) {
    if (groups[order[i]].length > best.length) best = groups[order[i]];
  }

  // 절반까지는 요구하지 않는다. 잡동사니가 많이 섞인 페이지에서도
  // 뚜렷한 한 덩어리면 그게 본문이다.
  return best.length >= 3 && best.length > urls.length * 0.3 ? best : null;
}

/**
 * 사이트가 페이지 번호를 직접 알려준 경우 (`data-theme-page="1"` 등).
 *
 * 이게 가장 확실한 근거다 — 파일명을 추측할 필요가 없다. 뷰어가 컷을
 * 전용 컨테이너에 담고 각 칸에 번호를 매겨두는 구조에서 나온다.
 *
 * 번호가 붙은 것이 3개 이상이고 전체의 절반 이상이어야 인정한다.
 * 한두 개만 붙어 있으면 본문 표식이 아니라 우연이다.
 */
export function sortByExplicitPage(entries) {
  const numbered = entries.filter((e) => typeof e.pageIndex === 'number');
  if (numbered.length < 3) return null;
  if (numbered.length < entries.length * 0.5) return null;

  return numbered
    .slice()
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((e) => e.url);
}

/**
 * 한 화의 컷들은 같은 디렉터리에 몰려 있다.
 * 연번·모양을 못 찾았을 때 쓰는 마지막 차선책.
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
  const entries = [];

  // selectContentImages 와 같은 판정: 번호 선언 3개 이상이면 선언을 믿는다
  let declaredPages = 0;
  for (let i = 0; i < elements.length; i++) {
    if (typeof elements[i].pageIndex === 'number') declaredPages++;
  }
  const trustDeclared = declaredPages >= 3;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const label = (el.src || el.dataSrc || el.dataOriginal || el.bgImage || '(빈 요소)').slice(0, 90);

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
    const declared = trustDeclared && typeof el.pageIndex === 'number';
    const rendered = (el.naturalWidth || 0) > 0;
    if (NOT_IMAGE_EXT.test(abs) && !rendered && !declared) {
      stages['이미지아님'].push(abs);
      continue;
    }
    if (JUNK_PATTERN.test(abs) && !declared) {
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
    entries.push({ url, pageIndex: typeof el.pageIndex === 'number' ? el.pageIndex : null });
  }

  // selectContentImages 와 **같은 순서**로 판정해야 진단이 실제와 어긋나지 않는다
  const byPage = sortByExplicitPage(entries);
  const series = byPage ? null : findNumberedSeries(picked);
  const shaped = byPage || series ? null : findDominantShape(picked);
  const final = byPage || series || shaped || keepDominantDirectory(picked);

  const finalSet = {};
  for (let i = 0; i < final.length; i++) finalSet[final[i]] = 1;

  const groupedOut = picked.filter((u) => !finalSet[u]);
  const groupStage = byPage
    ? '번호없음'
    : series
      ? '연번구간밖'
      : shaped
        ? '다른모양'
        : '다른폴더';

  let method = '전부 통과';
  if (byPage) method = '사이트 페이지 번호';
  else if (series) method = '연번 구간';
  else if (shaped) method = '파일명 모양';
  else if (picked.length !== final.length) method = '디렉터리 다수결';

  return {
    total: elements.length,
    kept: final.length,
    method,
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
  const entries = [];

  /**
   * 선언된 페이지 번호가 3개 이상이면 이 문서는 번호 매긴 뷰어다.
   * 그 안에서 번호 달린 요소는 이름·확장자 휴리스틱보다 선언을 믿는다.
   *
   * 뉴토키 실측 두 가지가 근거다:
   *  - 컷을 .css/.js 위장 주소로 서빙한다 → 확장자 필터가 컷을 죽인다
   *  - 서명 URL 의 랜덤 토큰이 JUNK_PATTERN 의 짧은 조각(sns, ad- 등)에
   *    우연히 걸린다 → 회마다 다른 컷이 한두 장씩 사라진다
   * 반대로 실제로 그려진 이미지(naturalWidth>0)도 확장자 필터보다 우선한다.
   */
  let declaredPages = 0;
  for (let i = 0; i < elements.length; i++) {
    if (typeof elements[i].pageIndex === 'number') declaredPages++;
  }
  const trustDeclared = declaredPages >= 3;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    const raw = pickSource(el);
    if (!raw) continue;

    const abs = absolutize(raw, baseUrl);
    if (!abs) continue;

    const declared = trustDeclared && typeof el.pageIndex === 'number';
    const rendered = (el.naturalWidth || 0) > 0;

    // mp3 등이 <source> 로 섞여 들어온다 (위 주석의 예외 두 가지 제외)
    if (NOT_IMAGE_EXT.test(abs) && !rendered && !declared) continue;
    if (JUNK_PATTERN.test(abs) && !declared) continue;
    if (!isBigEnough(el)) continue;

    const url = upgradeResolution(abs);
    if (seen[url]) continue; // 해상도 승격 후에 중복을 판정한다
    seen[url] = 1;
    entries.push({ url, pageIndex: typeof el.pageIndex === 'number' ? el.pageIndex : null });
  }

  const picked = entries.map((e) => e.url);

  // 확실한 순서대로 시도한다:
  //  0) 사이트가 준 페이지 번호   data-theme-page="1" — 추측이 아니라 선언이다
  //  1) 연번                    p001.jpg (페이지 순서까지 얻는다)
  //  2) 파일명 모양              시각_해시.png (같은 규칙으로 뽑힌 덩어리)
  //  3) 디렉터리                 그냥 같은 폴더에 몰려 있다
  return (
    sortByExplicitPage(entries) ||
    findNumberedSeries(picked) ||
    findDominantShape(picked) ||
    keepDominantDirectory(picked)
  );
}
