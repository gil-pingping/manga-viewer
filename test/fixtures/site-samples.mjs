/**
 * 실제 사이트에서 관찰한 이미지 구성을 종류별로 압축한 픽스처.
 *
 * 페이지 마크업을 통째로 저장하지 않는다. 규칙 판단에 필요한 것만 담는다:
 * 주소 형태 · 크기 · lazy 속성. 그래서 작고, 읽을 수 있고, DOM 없이 테스트된다.
 *
 * 각 항목의 `want` 는 "본문 컷으로 뽑혀야 하는가"다. 규칙을 바꿀 때
 * 이 표가 무엇을 깨뜨리는지 바로 알려준다.
 */

/** 이미지 서술자 하나 */
function img(src, naturalWidth, naturalHeight, want, note, extra = {}) {
  return {
    tag: 'IMG',
    src,
    dataSrc: null,
    dataOriginal: null,
    srcset: null,
    width: null,
    height: null,
    naturalWidth,
    naturalHeight,
    offsetWidth: naturalWidth,
    offsetHeight: naturalHeight,
    want,
    note,
    ...extra,
  };
}

/* ==================================================================== */
/* 네이버 웹툰 — 세로 스트립, 서버 렌더                                  */
/* 관찰: 본문이 한 디렉터리에 몰려 있고, 그 안에 썸네일 1장이 섞여 있다.  */
/*       다른 화 썸네일은 각자 디렉터리, 광고·커뮤니티는 딴 호스트.        */
/* ==================================================================== */

const PANEL_DIR = 'https://image-comic.pstatic.net/webtoon/783053/249/';

export const NAVER_WEBTOON = {
  label: '네이버 웹툰 249화',
  pageUrl: 'https://comic.naver.com/webtoon/detail?titleId=783053&no=249&week=tue',
  origin: 'https://comic.naver.com',
  elements: [
    // 본문 컷 — 세로로 긴 스트립
    ...Array.from({ length: 8 }, (_, i) =>
      img(`${PANEL_DIR}20260706201835_abc_IMAG01_${i + 1}.jpg`, 690, 1600, true, '본문 컷')
    ),

    // 같은 디렉터리의 이 화 썸네일 — 다수결로는 안 걸린다. 이름으로 걸러야 한다
    img(`${PANEL_DIR}thumbnail_202x120_e00e3d06.jpg`, 202, 120, false, '같은 폴더의 썸네일'),

    // 다른 화 썸네일 — 각자 디렉터리
    img('https://image-comic.pstatic.net/webtoon/783053/244/thumbnail_202x120_aaa.jpg', 202, 120, false, '이전 화 썸네일'),
    img('https://image-comic.pstatic.net/webtoon/783053/250/thumbnail_202x120_bbb.jpg', 202, 120, false, '다음 화 썸네일'),
    img('https://image-comic.pstatic.net/webtoon/783053/thumbnail/titledescimage/frontImage_6b8.jpg', 436, 348, false, '작품 소개 이미지'),

    // 사이트 UI · 광고 · 커뮤니티
    img('https://ssl.pstatic.net/static/common/gnb/banner/promo_npay_2309.png', 265, 47, false, 'GNB 프로모 배너'),
    img('https://ssl.pstatic.net/melona/libs/1575/1575519/aadaea65_20260730.png', 600, 600, false, '광고 크리에이티브'),
    img('https://kw-wcommunity-phinf.pstatic.net/20250311_293/1741670110725_PNG/profile.png', 449, 449, false, '커뮤니티 프로필'),
    img('https://naverwebtoon-phinf.pstatic.net/20230302_284/1677735347817_JPEG/upload_427.JPEG', 300, 130, false, '작가 배너'),

    // 오디오가 <source> 로 섞여 들어온다 — 이미지가 아니다
    {
      tag: 'SOURCE',
      src: 'https://image-comic.pstatic.net/bgsound/bgm_697bf5f2.mp3',
      dataSrc: null,
      dataOriginal: null,
      srcset: null,
      width: null,
      height: null,
      naturalWidth: 0,
      naturalHeight: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      want: false,
      note: '배경음 mp3 (source 태그)',
    },

    // 아직 안 불린 placeholder
    img('data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 1, 1, false, 'data: placeholder'),
  ],
};

/* ==================================================================== */
/* Pinterest — 격자, lazy 로드                                          */
/* 관찰: 핀마다 디렉터리가 다르다 → 디렉터리 다수결이 작동하지 않는다.    */
/*       그래도 전부 살아야 맞다. 그 성질을 명시적으로 고정한다.          */
/* ==================================================================== */

export const PINTEREST_GRID = {
  label: 'Pinterest 격자',
  pageUrl: 'https://kr.pinterest.com/search/pins/?q=%EA%B3%A0%EC%96%91%EC%9D%B4',
  origin: 'https://kr.pinterest.com',
  elements: [
    // 핀 사진 — 비율이 제각각. 정사각형도 살아야 한다 (전에 max>=300 조건이 죽였다)
    img('https://i.pinimg.com/236x/40/9c/70/409c7001.jpg', 202, 360, true, '세로 핀'),
    img('https://i.pinimg.com/236x/ec/a9/b9/eca9b94d.jpg', 236, 351, true, '세로 핀'),
    img('https://i.pinimg.com/236x/19/79/25/1979256b.jpg', 236, 237, true, '정사각 핀'),
    img('https://i.pinimg.com/236x/74/54/74/74547460.jpg', 228, 295, true, '정사각에 가까운 핀'),
    img('https://i.pinimg.com/236x/54/86/08/5486082c.jpg', 237, 229, true, '정사각 핀'),
    img('https://i.pinimg.com/236x/cf/8b/9c/cf8b9ca4.jpg', 237, 421, true, '세로 핀'),

    // Pinterest UI 일러스트 — 크기로는 통과한다. 이름으로 걸러야 한다
    img('https://s.pinimg.com/gestalt/illustrations/v1/ill.gumball.spot.light.svg.webp', 220, 220, false, 'UI 일러스트'),

    // 아직 안 불린 lazy 핀 — 진짜 주소는 data-src 에 있다
    {
      tag: 'IMG',
      src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      dataSrc: 'https://i.pinimg.com/236x/aa/bb/cc/aabbccdd.jpg',
      dataOriginal: null,
      srcset: null,
      width: null,
      height: null,
      naturalWidth: 0,
      naturalHeight: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      want: true,
      note: 'lazy 핀 (data-src 로 살려야 함)',
    },
  ],
};

/* ==================================================================== */
/* 광고 표준 규격 — 어떤 사이트에서든 걸러져야 한다                       */
/* 공통점은 짧은 변이 얇다는 것이다.                                      */
/* ==================================================================== */

export const AD_SHAPES = {
  label: '광고 표준 규격',
  pageUrl: 'https://example.test/article',
  origin: 'https://example.test',
  elements: [
    img('https://ads.example.test/creative/leaderboard.png', 728, 90, false, '728x90 leaderboard'),
    img('https://ads.example.test/creative/superbanner.png', 970, 90, false, '970x90'),
    img('https://ads.example.test/creative/skyscraper.png', 160, 600, false, '160x600 skyscraper'),
    img('https://ads.example.test/creative/halfbanner.png', 234, 60, false, '234x60 half banner'),

    // 대비군: 진짜 컷은 양쪽이 두툼하다
    img('https://cdn.example.test/ch1/001.jpg', 690, 1600, true, '세로 스트립 컷'),
    img('https://cdn.example.test/ch1/002.jpg', 1000, 1414, true, '만화책 한 장'),
    img('https://cdn.example.test/ch1/003.jpg', 2000, 1414, true, '펼침 컷'),
  ],
};

export const ALL_FIXTURES = [NAVER_WEBTOON, PINTEREST_GRID, AD_SHAPES];
