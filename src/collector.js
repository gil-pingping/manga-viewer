import * as rules from './core/imageRules.js';
import * as dom from './collect/fromDocument.js';

/**
 * 북마클릿 수집기
 *
 * 왜 북마클릿이 필요한가: 이미지를 자바스크립트로 나중에 채우는 사이트는
 * 서버가 HTML 만 받아봐도 주소가 없다. 브라우저에 이미 렌더된 DOM 에서
 * 훑는 것이 그 경우 유일한 방법이다.
 *
 * 왜 이렇게 조립하나: 북마클릿은 `javascript:` URL 이라 import 를 쓸 수 없다.
 * 예전에는 그래서 선별 규칙을 이 파일에 복붙해뒀는데, 한쪽만 고쳐서
 * 같은 사이트가 경로에 따라 다르게 동작하는 버그가 났다.
 * 지금은 core 의 함수들을 문자열화해서 함께 싣는다. 규칙은 한 곳에만 있다.
 */

/** 북마클릿에 함께 실어야 하는 순수 함수들 (의존 순서대로) */
const BUNDLED = [
  ['largestFromSrcset', rules.largestFromSrcset],
  ['pickSource', rules.pickSource],
  ['absolutize', rules.absolutize],
  ['isBigEnough', rules.isBigEnough],
  ['upgradeResolution', rules.upgradeResolution],
  ['parseSeriesKey', rules.parseSeriesKey], // findNumberedSeries 가 쓴다 — 빠지면 페이지에서 ReferenceError
  ['findNumberedSeries', rules.findNumberedSeries],
  ['filenameShape', rules.filenameShape], // findDominantShape 가 쓴다
  ['findDominantShape', rules.findDominantShape],
  ['sortByExplicitPage', rules.sortByExplicitPage],
  ['keepDominantDirectory', rules.keepDominantDirectory],
  ['selectContentImages', rules.selectContentImages],
  ['backgroundImageUrl', dom.backgroundImageUrl], // findContentRoot·toDescriptor 가 쓴다
  ['countImageish', dom.countImageish], // findContentRoot 가 쓴다
  ['looksJsRendered', dom.looksJsRendered],
  ['isNewtokiChapterUrl', dom.isNewtokiChapterUrl],
  ['findContentRoot', dom.findContentRoot],
  ['inheritedPageIndex', dom.inheritedPageIndex], // collectDescriptors 가 쓴다
  ['toDescriptor', dom.toDescriptor],
  ['collectDescriptors', dom.collectDescriptors],
  ['extractSeriesCover', dom.extractSeriesCover],
  ['findSeriesListUrl', dom.findSeriesListUrl],
  // 이 파일 아래에 정의. runCollector·collectForNative 두 본체가 같이 쓴다 —
  // 예전엔 본체마다 findLink 복붙이 하나씩 있었고, urlHarvester 만 고치면
  // 기기 경로는 옛 규칙으로 남았다
  ['findAdjacentChapterLink', findAdjacentChapterLink],
];

/**
 * 번들러가 함수 이름을 바꿔도 페이지에서 쓸 이름은 고정한다.
 *
 * 여기에 함정이 하나 더 있다: 다른 모듈에 동명 함수가 있으면 rollup 이
 * 이쪽 심볼을 `이름$1` 로 리네임하고, 그러면 **직렬화된 함수 본문 안의
 * 호출부도** `이름$1(...)` 이 된다. 주입 스코프에는 고정 이름만 있으므로
 * 기기에서 ReferenceError 로 수집이 전멸한다 (v1.4.2 실사고:
 * series.js 의 private keepDominantDirectory 와 충돌).
 * 그래서 직렬화할 때 리네임된 참조를 고정 이름으로 되돌린다.
 */
function serializeBundledFunctions(entries = BUNDLED) {
  const restoreRenames = (src) =>
    entries.reduce(
      (out, [fixed]) => out.replace(new RegExp(`\\b${fixed}\\$\\d+\\b`, 'g'), fixed),
      src
    );

  return entries
    .map(([name, fn]) => `var ${name} = (${restoreRenames(fn.toString().replace(/^export\s+/, ''))});`)
    .join('\n');
}

/** 위 함수들이 참조하는 모듈 상수. 값으로 박아넣는다 */
function bundledConstants() {
  return [
    `var MIN_SHORT_SIDE = ${rules.MIN_SHORT_SIDE};`,
    `var MIN_SERIES_LENGTH = ${rules.MIN_SERIES_LENGTH};`,
    `var JUNK_PATTERN = ${rules.JUNK_PATTERN.toString()};`,
    `var NOT_IMAGE_EXT = ${rules.NOT_IMAGE_EXT.toString()};`,
    `var IMAGE_NODE_SELECTOR = ${JSON.stringify(dom.IMAGE_NODE_SELECTOR)};`,
    `var CONTENT_ROOT_SELECTORS = ${JSON.stringify(dom.CONTENT_ROOT_SELECTORS)};`,
    `var SPECIFIC_CONTENT_SELECTORS = ${JSON.stringify(dom.SPECIFIC_CONTENT_SELECTORS)};`,
    `var PAGE_INDEX_ATTRS = ${JSON.stringify(dom.PAGE_INDEX_ATTRS)};`,
  ].join('\n');
}

/**
 * 사이트가 준 이전/다음 화 링크를 찾는다. 방향은 호출자가 준 패턴에서 읽는다.
 *
 * urlHarvester.findAdjacentLink 와 같은 규칙이다. 왜 사본이 여기 또 있나:
 * 저쪽은 정적 HTTP 경로(DOMParser)의 모듈 함수라 주입 스코프에서 못 쓴다.
 * 이쪽은 BUNDLED 로 실려 북마클릿·네이티브 WebView 두 본체가 같은 정의를
 * 쓴다 (본체 안 복붙 두 개를 여기 하나로 합쳤다). 규칙을 고치면 양쪽 —
 * 이 함수와 urlHarvester.findAdjacentLink — 을 같이 고쳐야 한다.
 *
 * 실측(wftoon227.com): 아래쪽 바는 `<li class="next"><a>다음화</a></li>` 로
 * 글자를 갖지만, 옆 화살표는 `<a title="다음화">` 안에 아이콘 폰트
 * (`<i class="fa fa-chevron-right">`)뿐이라 textContent 가 빈 문자열이다.
 * title 과 감싼 요소의 class 까지 봐야 찾는다.
 *
 * 여기서 못 찾으면 앱이 주소의 숫자를 ±1 해서 추측한다. 그 추측이
 * `?toon=184&num=42` 의 toon(= 작품 id)을 올려서 "다음 화"가 다른 작품
 * (호박장군 41화)으로 튄 실사고가 있었다 — 진짜 링크를 찾는 게 1차 방어다.
 *
 * 이 함수도 문자열화되므로 모듈 스코프의 어떤 것도 참조하면 안 된다.
 * 정규식을 상수로 빼지 않고 안에 둔 이유다.
 */
function findAdjacentChapterLink(doc, re, currentUrl) {
  // 인수를 늘리지 않는다. 호출자가 주는 패턴 자체가 방향을 말해준다
  var forward = re.test('다음화') || re.test('next');
  /**
   * class 는 부분 일치로 보면 안 된다 — `preload`·`preview` 같은 이름이
   * "이전화"로 잡힌다. 토큰 경계(`next-page`, `prev_page`, `nextpage`)까지만.
   */
  var NEXT_CLASS = /(?:^|[\s_-])(?:next|nextpage)(?:[\s_-]|$)/i;
  var PREV_CLASS = /(?:^|[\s_-])(?:prev|previous|prevpage|prepage|pre)(?:[\s_-]|$)/i;
  var want = forward ? NEXT_CLASS : PREV_CLASS;
  var avoid = forward ? PREV_CLASS : NEXT_CLASS;
  // 해시만 다른 자기 자신 링크(#none 등)는 인접 화가 아니다
  var here = (currentUrl || '').split('#')[0];
  // class 만 맞은 링크는 글자/title 이 맞은 링크에 밀린다 (문서 순서로 뒤집히면 안 된다)
  var byClassOnly = null;
  var anchors = doc.querySelectorAll('a[href]');

  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var labelled =
      re.test((a.textContent || '').trim()) ||
      re.test(a.getAttribute('title') || '') ||
      re.test(a.getAttribute('rel') || '');

    /**
     * 링크 자신 + 감싼 li/div 까지만 class 를 본다. 더 올라가면 페이지 전체
     * 래퍼를 먹는다. 한 요소에 양방향 class 가 같이 붙어 있으면
     * (`class="prev next"` 처럼 한 줄에 두 화살표가 든 바) 방향을 단정할 수 없다.
     */
    var byClass = false;
    for (var el = a, depth = 0; el && depth < 4; depth++) {
      var cls = el.getAttribute('class') || '';
      if (cls && want.test(cls) && !avoid.test(cls)) {
        byClass = true;
        break;
      }
      el = el.parentElement;
      if (el && el.tagName && !/^(LI|DIV)$/i.test(el.tagName)) break;
    }
    if (!labelled && !byClass) continue;

    var raw = a.getAttribute('href');
    if (!raw) continue;
    var href;
    try {
      href = new URL(raw, currentUrl).href;
    } catch (e) {
      continue;
    }
    /**
     * 경계에서 사이트가 404 를 주지 않는다. 실측: 1화에서 이전화 링크가
     * `javascript:alert('이전화가없습니다.');` 다. 이걸 회차 주소로 돌려주면
     * 경계가 "깨진 이동"이 된다. mailto:·# 같은 것도 회차 주소가 아니다.
     */
    if (!/^https?:\/\//i.test(href)) continue;
    if (href.split('#')[0] === here) continue;

    if (labelled) return href;
    if (!byClassOnly) byClassOnly = href;
  }
  return byClassOnly;
}

/**
 * 페이지에서 실행되는 본체.
 *
 * 이 함수도 통째로 문자열화되므로 모듈 스코프의 어떤 것도 참조하면 안 된다.
 * 위에서 함께 실어주는 함수·상수만 쓴다.
 */
function runCollector(viewerOrigin) {
  // 뷰어 탭을 먼저 연다. 수집이 끝난 뒤에 열면 팝업 차단에 걸린다.
  // 해시 없이 열고, 수집이 끝나면 이 탭의 location 에 페이로드를 실어 보낸다.
  var viewerTab = window.open(viewerOrigin + '/', '_blank');

  /** lazy 이미지를 깨우기 위해 페이지를 훑어 내린다 (최대 약 3초) */
  function wakeLazyImages(done) {
    var startY = window.scrollY;
    var step = Math.max(window.innerHeight, 600);
    var y = 0;
    var ticks = 0;

    var timer = setInterval(function () {
      window.scrollTo(0, y);
      y += step;
      ticks++;
      if (y > document.body.scrollHeight || ticks > 30) {
        clearInterval(timer);
        window.scrollTo(0, startY);
        setTimeout(done, 350);
      }
    }, 90);
  }

  wakeLazyImages(function () {
    // 서술자 추출과 선별 모두 core 규칙을 쓴다 (여기 복사본은 없다)
    var pages = selectContentImages(collectDescriptors(document), location.href);

    if (pages.length === 0) {
      alert('이미지를 찾지 못했습니다.\n페이지를 끝까지 스크롤한 뒤 다시 눌러주세요.');
      return;
    }

    var payload = {
      title: (document.title || '수집한 이미지').split(/[|>]/)[0].trim(),
      coverUrl: extractSeriesCover(document, location.href),
      sourceUrl: location.href,
      prevUrl: findAdjacentChapterLink(document, /이전화|이전\s*화|prev/i, location.href),
      nextUrl: findAdjacentChapterLink(document, /다음화|다음\s*화|next/i, location.href),
      pages: pages,
    };

    /**
     * 페이로드를 URL 해시로 넘긴다. fetch 로 보내면 안 된다:
     * 많은 사이트가 CSP connect-src 로 허용 목록 밖 오리진 연결을 막는다
     * (Pinterest 확인됨). 네비게이션은 그 제한을 받지 않는다.
     */
    var encoded = encodeURIComponent(JSON.stringify(payload));

    if (encoded.length < 30000) {
      var target = viewerOrigin + '/#import=' + encoded;
      if (viewerTab) {
        viewerTab.location = target;
        viewerTab.focus();
      } else {
        location.href = target; // 팝업이 막혔으면 현재 탭에서 (뒤로가기로 복귀)
      }
      return;
    }

    // 주소에 담기 힘든 분량이면 서버에 올려본다 (CSP 가 허용하는 사이트에서만 통한다)
    fetch(viewerOrigin + '/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      mode: 'cors',
      keepalive: true,
    })
      .then(function () {
        if (viewerTab) {
          viewerTab.location = viewerOrigin + '/#import=latest';
          viewerTab.focus();
        }
      })
      .catch(function () {
        alert(
          '이미지가 ' +
            pages.length +
            '장이라 한 번에 넘기지 못했습니다.\n이 사이트는 외부 연결이 차단되어 있습니다.'
        );
      });
  });
}

/** Android 보조 WebView가 현재 DOM을 읽고 네이티브 쪽으로 돌려줄 값. */
function collectForNative(targetUrl) {
  if (targetUrl) {
    var expected = new URL(targetUrl);
    var current = new URL(location.href);
    // 팝업·광고 리다이렉트의 이미지를 원래 회차 이름으로 저장하지 않는다.
    if (current.hostname !== expected.hostname ||
        current.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '') ||
        Array.from(expected.searchParams).some(function (entry) {
          return current.searchParams.get(entry[0]) !== entry[1];
        })) {
      throw new Error('COLLECTOR_WRONG_PAGE');
    }
    // 뉴토끼 회차는 본문 표식이 필수다. 아예 없는 응답도 광고로 대신 채우지 않는다.
    if (isNewtokiChapterUrl(targetUrl) &&
        !document.querySelector('[data-theme-viewer-images], .theme-viewer-images')) {
      return JSON.stringify({ pending: true, sourceUrl: location.href, pages: [] });
    }
  }

  var pages = selectContentImages(collectDescriptors(document), location.href);
  return JSON.stringify({
    pending: looksJsRendered(document),
    title: (document.title || '수집한 이미지').split(/[|>]/)[0].trim(),
    coverUrl: extractSeriesCover(document, location.href),
    sourceUrl: location.href,
    prevUrl: findAdjacentChapterLink(document, /이전화|이전\s*화|prev/i, location.href),
    nextUrl: findAdjacentChapterLink(document, /다음화|다음\s*화|next/i, location.href),
    pages: pages,
  });
}

/**
 * core 함수들 + 본체를 하나의 자기완결적 `javascript:` 로 조립한다.
 *
 * export 키워드를 떼야 한다 — 함수 소스를 그대로 쓰면 `export function ...`
 * 이 되어 스크립트 문맥에서 문법 오류가 난다.
 */
export function buildBookmarklet(viewerOrigin) {
  const origin = viewerOrigin || window.location.origin;

  const fns = serializeBundledFunctions();
  const body = `${bundledConstants()}\n${fns}\n(${runCollector.toString()})(${JSON.stringify(origin)});`;

  return 'javascript:' + encodeURIComponent(`(function(){${body}})();`);
}

/** 외부 페이지의 DOM에서 동기적으로 결과를 반환하는 Android WebView용 스크립트. */
export function buildNativeCollectorScript(targetUrl = null) {
  const fns = serializeBundledFunctions();
  const body = `${bundledConstants()}\n${fns}\nreturn (${collectForNative.toString()})(${JSON.stringify(targetUrl)});`;
  return `(function(){try{${body}}catch(e){return JSON.stringify({collectorError:String(e&&e.stack||e)})}})();`;
}

export { runCollector, collectForNative, BUNDLED, bundledConstants, serializeBundledFunctions };
