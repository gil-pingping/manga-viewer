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
  ['findContentRoot', dom.findContentRoot],
  ['inheritedPageIndex', dom.inheritedPageIndex], // collectDescriptors 가 쓴다
  ['toDescriptor', dom.toDescriptor],
  ['collectDescriptors', dom.collectDescriptors],
  ['extractSeriesCover', dom.extractSeriesCover],
  ['findSeriesListUrl', dom.findSeriesListUrl],
];

/** 번들러가 함수 이름을 바꿔도 페이지에서 쓸 이름은 고정한다. */
function serializeBundledFunctions(entries = BUNDLED) {
  return entries
    .map(([name, fn]) => `var ${name} = (${fn.toString().replace(/^export\s+/, '')});`)
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
 * 페이지에서 실행되는 본체.
 *
 * 이 함수도 통째로 문자열화되므로 모듈 스코프의 어떤 것도 참조하면 안 된다.
 * 위에서 함께 실어주는 함수·상수만 쓴다.
 */
function runCollector(viewerOrigin) {
  // 뷰어 탭을 먼저 연다. 수집이 끝난 뒤에 열면 팝업 차단에 걸린다.
  // 해시 없이 열고, 수집이 끝나면 이 탭의 location 에 페이로드를 실어 보낸다.
  var viewerTab = window.open(viewerOrigin + '/', '_blank');

  function findLink(re) {
    // 해시만 다른 자기 자신 링크(#none 등)는 인접 화가 아니다
    var here = location.href.split('#')[0];
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var text = (a.textContent || '').trim();
      var rel = a.getAttribute('rel') || '';
      var title = a.getAttribute('title') || '';
      var aria = a.getAttribute('aria-label') || '';
      var cls = a.getAttribute('class') || '';

      var childMeta = '';
      var children = a.querySelectorAll('*');
      for (var j = 0; j < children.length; j++) {
        var ch = children[j];
        childMeta += ' ' + (ch.getAttribute('title') || '') +
                     ' ' + (ch.getAttribute('aria-label') || '') +
                     ' ' + (ch.getAttribute('class') || '');
      }

      var targetStr = text + ' ' + rel + ' ' + title + ' ' + aria + ' ' + cls + ' ' + childMeta;
      if (!re.test(targetStr)) continue;

      var raw = a.getAttribute('href');
      if (!raw) continue;
      var href;
      try {
        href = new URL(raw, location.href).href;
      } catch (e) {
        continue;
      }
      if (href.split('#')[0] === here) continue;
      return href;
    }
    return null;
  }

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
      prevUrl: findLink(/이전화|이전\s*화|prev/i),
      nextUrl: findLink(/다음화|다음\s*화|next/i),
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
function collectForNative() {
  function findLink(re) {
    var here = location.href.split('#')[0];
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var text = (a.textContent || '').trim();
      var rel = a.getAttribute('rel') || '';
      var title = a.getAttribute('title') || '';
      var aria = a.getAttribute('aria-label') || '';
      var cls = a.getAttribute('class') || '';

      var childMeta = '';
      var children = a.querySelectorAll('*');
      for (var j = 0; j < children.length; j++) {
        var ch = children[j];
        childMeta += ' ' + (ch.getAttribute('title') || '') +
                     ' ' + (ch.getAttribute('aria-label') || '') +
                     ' ' + (ch.getAttribute('class') || '');
      }

      var targetStr = text + ' ' + rel + ' ' + title + ' ' + aria + ' ' + cls + ' ' + childMeta;
      if (!re.test(targetStr)) continue;

      var raw = a.getAttribute('href');
      if (!raw) continue;
      var href;
      try {
        href = new URL(raw, location.href).href;
      } catch (e) {
        continue;
      }
      if (href.split('#')[0] === here) continue;
      return href;
    }
    return null;
  }

  var pages = selectContentImages(collectDescriptors(document), location.href);
  return JSON.stringify({
    title: (document.title || '수집한 이미지').split(/[|>]/)[0].trim(),
    coverUrl: extractSeriesCover(document, location.href),
    sourceUrl: location.href,
    prevUrl: findLink(/이전화|이전\s*화|prev/i),
    nextUrl: findLink(/다음화|다음\s*화|next/i),
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
export function buildNativeCollectorScript() {
  const fns = serializeBundledFunctions();
  const body = `${bundledConstants()}\n${fns}\nreturn (${collectForNative.toString()})();`;
  return `(function(){try{${body}}catch(e){return JSON.stringify({collectorError:String(e&&e.stack||e)})}})();`;
}

export { runCollector, collectForNative, BUNDLED, bundledConstants, serializeBundledFunctions };
