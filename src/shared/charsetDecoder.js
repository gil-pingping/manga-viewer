/**
 * HTML 문서의 ArrayBuffer 및 Content-Type 헤더에서 charset을 감지하여
 * 한글 깨짐(EUC-KR/CP949 vs UTF-8) 없이 정확한 UTF-8 문자열로 디코딩한다.
 */
export function decodeHtmlBuffer(arrayBuffer, contentTypeHeader = '') {
  if (!arrayBuffer) return '';
  const bytes = new Uint8Array(arrayBuffer);

  let charset = null;

  // 1. Content-Type 헤더에서 charset 추출
  const headerMatch = /charset=([a-z0-9_-]+)/i.exec(contentTypeHeader || '');
  if (headerMatch) {
    charset = headerMatch[1].toLowerCase();
  }

  // 2. 헤더에 charset 정보가 없으면, 앞쪽 2000 바이트를 latin1로 읽어 <meta> 태그의 charset을 훑는다
  if (!charset) {
    try {
      const preview = new TextDecoder('latin1').decode(bytes.subarray(0, 2000));
      const metaMatch =
        /<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i.exec(preview) ||
        /<meta[^>]+content=["'][^"']*charset=\s*([a-z0-9_-]+)/i.exec(preview);
      if (metaMatch) {
        charset = metaMatch[1].toLowerCase();
      }
    } catch {
      /* ignore */
    }
  }

  // 3. 한국어 윈도우/legacy 인코딩 별칭 정리
  if (
    charset === 'ks_c_5601-1987' ||
    charset === 'euckr' ||
    charset === 'euc-kr' ||
    charset === 'cp949' ||
    charset === 'x-windows-949' ||
    charset === 'uhc'
  ) {
    charset = 'euc-kr';
  } else if (charset === 'utf8') {
    charset = 'utf-8';
  }

  // 4. 지정된 charset으로 디코딩 시도. 만약 utf-8로 디코딩했는데 깨짐(\uFFFD)이 발생하면 euc-kr 재시도
  try {
    const decoder = new TextDecoder(charset || 'utf-8');
    const text = decoder.decode(bytes);

    if (text.includes('\uFFFD') && (!charset || charset === 'utf-8')) {
      try {
        const fallbackText = new TextDecoder('euc-kr').decode(bytes);
        if (!fallbackText.includes('\uFFFD')) {
          return fallbackText;
        }
      } catch {
        /* ignore fallback */
      }
    }
    return text;
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return '';
    }
  }
}
