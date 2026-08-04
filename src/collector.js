/**
 * 북마클릿 수집기
 *
 * 왜 북마클릿인가: 이미지를 자바스크립트로 나중에 채우는 사이트에서는
 * 서버가 HTML 만 받아봐도 이미지 주소가 없다. 브라우저에서 이미 열어둔
 * 그 페이지에서 훑는 것이 가장 확실하다.
 *
 * collectManga 는 통째로 문자열화되어 `javascript:` 북마클릿이 되므로
 * **모듈 스코프의 어떤 것도 참조하면 안 된다.** 완전히 자기완결적이어야 한다.
 * (script src 주입은 https 페이지에서 mixed content 로 차단되므로 못 쓴다.)
 */
function collectManga(viewerOrigin) {
  var MIN_SIDE = 300; // 긴 변
  var MIN_SHORT_SIDE = 200; // 짧은 변 — 배너·스카이스크래퍼 광고를 걸러낸다

  var JUNK =
    /logo|icon|banner|button|avatar|thumb|captcha|loading|spinner|notice|emoji|smil|sns|ad[_-]|advert|google|facebook|twitter|kakao|profile|blank\.|1x1|pixel/i;

  // 뷰어 탭을 먼저 연다. 수집이 끝난 뒤에 열면 팝업 차단에 걸린다.
  var viewerTab = window.open(viewerOrigin + '/#import=latest', '_blank');

  function absolutize(src) {
    if (!src) return null;
    var v = String(src).replace(/\\\//g, '/').trim();
    if (!v || v.indexOf('data:') === 0 || v.indexOf('blob:') === 0) return null;
    try {
      return new URL(v, location.href).href;
    } catch (e) {
      return null;
    }
  }

  function biggestInSrcset(srcset) {
    if (!srcset) return null;
    var best = null;
    var bestW = -1;
    srcset.split(',').forEach(function (part) {
      var bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      var w = bits[1] ? parseFloat(bits[1]) || 1 : 1;
      if (w > bestW) {
        bestW = w;
        best = bits[0];
      }
    });
    return best;
  }

  function realSource(el) {
    return (
      el.getAttribute('data-original') ||
      el.getAttribute('data-src') ||
      el.getAttribute('data-lazy-src') ||
      el.getAttribute('data-echo') ||
      biggestInSrcset(el.getAttribute('srcset')) ||
      el.getAttribute('src')
    );
  }

  /**
   * 렌더된 크기로 본문 컷을 가린다. 주소 패턴보다 훨씬 정확하다.
   *
   * 긴 변만 보면 안 된다: 광고 표준 규격(728x90, 970x90, 160x600)은
   * 긴 변이 300을 훌쩍 넘으므로 그대로 통과한다.
   * 만화 한 컷은 **양쪽 변이 다** 두툼하다 → 짧은 변도 같이 본다.
   */
  function isBigEnough(el) {
    var nw = el.naturalWidth || 0;
    var nh = el.naturalHeight || 0;
    if (nw > 0 && nh > 0) {
      return Math.min(nw, nh) >= MIN_SHORT_SIDE && Math.max(nw, nh) >= MIN_SIDE;
    }

    var ow = el.offsetWidth || 0;
    var oh = el.offsetHeight || 0;
    if (ow > 0 && oh > 0) {
      return Math.min(ow, oh) >= MIN_SHORT_SIDE && Math.max(ow, oh) >= MIN_SIDE;
    }

    // 아직 안 불린 lazy 이미지는 data-* 가 있으면 본문으로 본다
    return !!(el.getAttribute('data-src') || el.getAttribute('data-original'));
  }

  function harvest() {
    var seen = {};
    var out = [];
    var nodes = document.querySelectorAll('img, [data-src], [data-original], [data-lazy-src]');

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var url = absolutize(realSource(el));
      if (!url || seen[url]) continue;
      if (JUNK.test(url)) continue;
      if (el.tagName === 'IMG' && !isBigEnough(el)) continue;
      seen[url] = 1;
      out.push(url);
    }
    return out;
  }

  function findLink(re) {
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var text = (anchors[i].textContent || '').trim();
      if (re.test(text) || re.test(anchors[i].getAttribute('rel') || '')) {
        return anchors[i].href;
      }
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
    var pages = harvest();

    if (pages.length === 0) {
      alert('만화 이미지를 찾지 못했습니다.\n페이지를 끝까지 스크롤한 뒤 다시 눌러주세요.');
      return;
    }

    var payload = {
      title: (document.title || '수집한 만화').split(/[|\-–—>]/)[0].trim(),
      sourceUrl: location.href,
      prevUrl: findLink(/이전화|이전\s*화|prev/i),
      nextUrl: findLink(/다음화|다음\s*화|next/i),
      pages: pages,
    };

    fetch(viewerOrigin + '/api/import', {
      method: 'POST',
      // text/plain 이면 CORS 프리플라이트를 타지 않는다
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      mode: 'cors',
      keepalive: true,
    })
      .then(function () {
        if (viewerTab) viewerTab.focus();
      })
      .catch(function (err) {
        alert(
          '뷰어에 보내지 못했습니다: ' +
            err.message +
            '\n\n뷰어 개발 서버(' +
            viewerOrigin +
            ')가 켜져 있는지 확인해주세요.'
        );
      });
  });
}

/**
 * 위 함수를 그대로 직렬화해 북마클릿 문자열을 만든다.
 * 수집 로직을 문자열로 따로 관리하지 않으므로 코드가 갈라지지 않는다.
 */
export function buildBookmarklet(viewerOrigin) {
  const origin = viewerOrigin || window.location.origin;
  const source = `(${collectManga.toString()})(${JSON.stringify(origin)})`;
  return 'javascript:' + encodeURIComponent(source);
}

export { collectManga };
