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
  // 짧은 변 하나만 본다. 광고 표준 규격은 전부 한쪽이 얇다:
  //   728x90 · 970x90 (배너) -> 90,  160x600 (스카이스크래퍼) -> 160
  // 반면 만화 컷이든 사진이든 짧은 변이 이보다 두툼하다. 긴 변 조건을 같이 걸면
  // 228x295 같은 정사각형 사진이 억울하게 잘린다 (Pinterest 에서 확인).
  var MIN_SHORT_SIDE = 180;

  var JUNK =
    /logo|icon|banner|button|avatar|thumb|captcha|loading|spinner|notice|emoji|smil|sns|ad[_-]|advert|google|facebook|twitter|kakao|profile|blank\.|1x1|pixel/i;

  // 뷰어 탭을 먼저 연다. 수집이 끝난 뒤에 열면 팝업 차단에 걸린다.
  // 해시 없이 연다 — 수집이 끝나면 이 탭의 location 에 페이로드를 실어 보낸다.
  var viewerTab = window.open(viewerOrigin + '/', '_blank');

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
    if (nw > 0 && nh > 0) return Math.min(nw, nh) >= MIN_SHORT_SIDE;

    var ow = el.offsetWidth || 0;
    var oh = el.offsetHeight || 0;
    if (ow > 0 && oh > 0) return Math.min(ow, oh) >= MIN_SHORT_SIDE;

    // 아직 안 불린 lazy 이미지는 data-* 가 있으면 본문으로 본다
    return !!(el.getAttribute('data-src') || el.getAttribute('data-original'));
  }

  /**
   * 격자로 보여주는 사이트는 작은 썸네일을 심어둔다. 전체화면 뷰어에서는 뭉개진다.
   * 주소에 크기 조각이 들어있는 호스트는 큰 판으로 바꿔치기한다.
   * (같은 이미지의 다른 해상도일 뿐 — 없는 걸 만들어내는 게 아니다)
   */
  function upgradeResolution(url) {
    // Pinterest: /236x/ · /474x/ 등 -> /736x/ (736x 는 대체로 존재하고 originals 보다 안전)
    if (url.indexOf('i.pinimg.com/') !== -1) {
      return url.replace(/\/(\d{2,4}x)\//, '/736x/');
    }
    return url;
  }

  function harvest() {
    var seen = {};
    var out = [];
    var nodes = document.querySelectorAll('img, [data-src], [data-original], [data-lazy-src]');

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var url = absolutize(realSource(el));
      if (!url) continue;
      if (JUNK.test(url)) continue;
      if (el.tagName === 'IMG' && !isBigEnough(el)) continue;

      url = upgradeResolution(url);
      if (seen[url]) continue; // 승격 후에 중복 판정 (같은 핀의 여러 크기를 하나로)
      seen[url] = 1;
      out.push(url);
    }
    return keepDominantDirectory(out);
  }

  /**
   * 한 화의 컷들은 거의 항상 같은 디렉터리에 연번으로 올라간다.
   * 그 최다 묶음만 남기면 프로모·커뮤니티 이미지가 한 번에 걸러진다
   * (네이버 웹툰에서 102장 중 본문 97장 / 잡동사니 5장으로 확인).
   * 뚜렷한 다수가 없으면 손대지 않는다.
   */
  function keepDominantDirectory(urls) {
    if (urls.length < 4) return urls;

    var groups = {};
    for (var i = 0; i < urls.length; i++) {
      var dir = urls[i].slice(0, urls[i].lastIndexOf('/') + 1);
      (groups[dir] = groups[dir] || []).push(urls[i]);
    }

    var keys = Object.keys(groups);
    if (keys.length < 2) return urls;

    var best = [];
    for (var k = 0; k < keys.length; k++) {
      if (groups[keys[k]].length > best.length) best = groups[keys[k]];
    }

    return best.length >= 3 && best.length >= urls.length * 0.5 ? best : urls;
  }

  function findLink(re) {
    // 해시만 다른 자기 자신 링크(#none 등)는 "다음화"가 아니다
    var here = location.href.split('#')[0];
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var text = (a.textContent || '').trim();
      if (!re.test(text) && !re.test(a.getAttribute('rel') || '')) continue;
      if (a.href.split('#')[0] === here) continue;
      return a.href;
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
      alert('이미지를 찾지 못했습니다.\n페이지를 끝까지 스크롤한 뒤 다시 눌러주세요.');
      return;
    }

    var payload = {
      title: (document.title || '수집한 이미지').split(/[|\-–—>]/)[0].trim(),
      sourceUrl: location.href,
      prevUrl: findLink(/이전화|이전\s*화|prev/i),
      nextUrl: findLink(/다음화|다음\s*화|next/i),
      pages: pages,
    };

    /**
     * 페이로드를 **URL 해시로** 넘긴다. fetch 로 보내면 안 된다:
     * 많은 사이트가 CSP `connect-src` 로 허용 목록 밖 오리진 연결을 막는다
     * (Pinterest 확인됨). 네비게이션은 그 제한을 받지 않는다.
     *
     * 이미 열어둔 탭의 location 을 바꾸는 방식이라 팝업 차단도 안 걸린다
     * (탭은 클릭 제스처 안에서 미리 열어놨다).
     */
    var encoded = encodeURIComponent(JSON.stringify(payload));

    if (encoded.length < 30000) {
      var target = viewerOrigin + '/#import=' + encoded;
      if (viewerTab) {
        viewerTab.location = target;
        viewerTab.focus();
      } else {
        // 팝업이 막혔으면 현재 탭에서 연다 (뒤로가기로 돌아올 수 있다)
        location.href = target;
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
          '이미지가 ' + pages.length + '장이라 한 번에 넘기지 못했습니다.\n' +
            '이 사이트는 외부 연결이 차단되어 있습니다. 페이지를 나눠서 시도해주세요.'
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
