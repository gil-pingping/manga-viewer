import JSZip from 'jszip';

/**
 * 만화 이미지 수집기
 *
 * 들어오는 경로 세 가지:
 *   1. 북마클릿   브라우저에서 이미 열어둔 페이지의 이미지 목록을 로컬 뷰어로 넘긴다 (주력)
 *   2. 붙여넣기   이미지 주소 목록을 그대로 붙인다
 *   3. 로컬 파일  CBZ / ZIP / 이미지 여러 장
 *
 * 어느 경로든 최종 산출물은 동일한 page 객체 배열이다.
 *
 * 서버가 페이지 HTML을 받아 <img> 를 훑는 경로는 없다. 이미지를 자바스크립트로
 * 나중에 채우는 사이트에서는 HTML에 주소가 아예 없어서 헛돌기만 했다.
 * 그 경우 브라우저에서 이미 렌더된 DOM을 읽는 북마클릿이 유일하게 통한다.
 */

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i;

/** 광고·아이콘·UI 부품으로 보이는 주소는 본문 컷이 아니다 */
const JUNK_PATTERN =
  /logo|icon|banner|button|avatar|thumb|captcha|loading|spinner|notice|emoji|smil|sns|ad[_-]|advert|google|facebook|twitter|kakao|naver_|profile|blank\.|1x1|pixel|copyright|wordmark|poweredby|sprite|footer|header|\/static\//i;

export class UrlHarvester {
  /* ------------------------------------------------------------------ */
  /* 1. 북마클릿이 서버에 올려둔 수집 결과 받기                           */
  /* ------------------------------------------------------------------ */

  /**
   * 북마클릿은 이미지 목록을 POST 로 먼저 올리고 뷰어를 열기 때문에,
   * 뷰어가 조금 먼저 뜨는 경우가 있다. 그래서 잠깐 폴링한다.
   * (URL 해시로 넘기던 예전 방식은 챕터가 길면 주소 길이 제한에 걸려 잘렸다.)
   */
  static async fetchPendingImport({ attempts = 12, intervalMs = 400 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch('/api/import/latest', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.payload) return UrlHarvester.normalizeImportPayload(data.payload);
        }
      } catch {
        /* 서버가 아직 준비 안 됐으면 다음 시도 */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  /** URL 해시(#import=...)로 직접 넘어온 페이로드도 계속 지원한다 */
  static parseImportHash(hash) {
    const match = /[#&]import=([^&]+)/.exec(hash || '');
    if (!match) return null;
    if (match[1] === 'latest') return 'latest';
    try {
      return UrlHarvester.normalizeImportPayload(JSON.parse(decodeURIComponent(match[1])));
    } catch {
      return null;
    }
  }

  static normalizeImportPayload(payload) {
    const urls = (payload.pages || []).filter(
      (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
    );
    if (urls.length === 0) throw new Error('수집된 이미지가 없습니다.');

    return {
      title: payload.title || '수집한 만화',
      targetUrl: payload.sourceUrl || null,
      prevUrl: payload.prevUrl || null,
      nextUrl: payload.nextUrl || null,
      pages: toPages(urls, payload.sourceUrl),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 2. 붙여넣기 (이미지 주소 목록)                                      */
  /* ------------------------------------------------------------------ */

  static parseRawText(rawText) {
    const text = (rawText || '').trim();
    if (!text) return [];

    const urlPattern = /https?:\/\/[^\s"'<>\\)]+/gi;
    const all = Array.from(new Set(text.match(urlPattern) || []))
      .map((u) => u.replace(/[),.]+$/, ''))
      .filter((u) => !JUNK_PATTERN.test(u));

    // 확장자나 이미지다운 경로가 있으면 그것만 고른다 (섞여 붙은 링크를 걸러낸다)
    const looksLikeImage = all.filter(
      (u) => IMAGE_EXT.test(u) || /\/(image|img|photo|file)s?\//i.test(u)
    );
    if (looksLikeImage.length > 0) return toPages(looksLikeImage, null);

    // 확장자 없이 서비스하는 CDN도 흔하다 (예: /id/1011/900/1400).
    // 하나도 못 골랐으면 사용자가 이미지 목록을 붙였다고 믿고, 웹페이지 주소만 뺀다.
    const notAPage = all.filter((u) => !/\.(html?|php|aspx?|jsp)(\?|#|$)/i.test(u));
    return toPages(notAPage, null);
  }

  /* ------------------------------------------------------------------ */
  /* 3. 로컬 파일                                                        */
  /* ------------------------------------------------------------------ */

  static async loadZipOrCbzFile(file) {
    const zip = new JSZip();
    const zipContent = await zip.loadAsync(file);

    const entries = Object.keys(zipContent.files)
      // macOS 압축이 끼워넣는 리소스 포크 제거
      .filter((name) => !name.startsWith('__MACOSX') && !name.split('/').pop().startsWith('.'))
      .filter((name) => !zipContent.files[name].dir && IMAGE_EXT.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (entries.length === 0) {
      throw new Error('압축 파일 안에서 이미지를 찾을 수 없습니다.');
    }

    const pages = [];
    for (let i = 0; i < entries.length; i++) {
      const blob = await zipContent.files[entries[i]].async('blob');
      pages.push({
        pageNumber: i + 1,
        url: URL.createObjectURL(blob),
        name: entries[i].split('/').pop(),
      });
    }

    return {
      title: file.name.replace(/\.(zip|cbz)$/i, ''),
      targetUrl: null,
      pages,
    };
  }

  static async loadMultipleImageFiles(files) {
    const fileList = Array.from(files)
      .filter((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (fileList.length === 0) throw new Error('이미지 파일이 없습니다.');

    return {
      title: '불러온 이미지 모음',
      targetUrl: null,
      pages: fileList.map((file, i) => ({
        pageNumber: i + 1,
        url: URL.createObjectURL(file),
        name: file.name,
      })),
    };
  }
}

/* ==================================================================== */
/* 내부 헬퍼                                                             */
/* ==================================================================== */

/** 원본 주소를 프록시 경유 주소로 감싼 page 객체 배열로 만든다 */
function toPages(urls, refererUrl) {
  return urls.map((imgUrl, i) => ({
    pageNumber: i + 1,
    url: proxiedUrl(imgUrl, refererUrl),
    originalUrl: imgUrl,
    name: `Page ${i + 1}`,
  }));
}

/**
 * 이미지 호스트 상당수가 Referer 없는 요청이나 다른 오리진에서의 요청을
 * 거부하므로, 브라우저가 <img> 로 직접 못 불러온다. 서버가 중계해야 한다.
 */
function proxiedUrl(imgUrl, refererUrl) {
  let path = `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;
  if (refererUrl) path += `&ref=${encodeURIComponent(refererUrl)}`;
  return path;
}
