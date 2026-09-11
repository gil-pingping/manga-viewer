import { UrlHarvester } from './src/urlHarvester.js';
import {
  isAnilifeUrl,
  parseAnilifePage,
  parseAnilifeWatchId,
} from './src/collect/anilifeCollector.js';
import { buildAnilifePlayback, decryptAnilifeMedia } from './src/collect/anilifeMedia.js';
import { AnimePlayer } from './src/ui/animePlayer.js';
import { ReaderEngine } from './src/readerEngine.js';
import { buildBookmarklet } from './src/collector.js';
import {
  findChapter,
  indexOfChapter,
  realNeighbor as findRealNeighbor,
  hasAdjacent as canGoAdjacent,
  resolveAdjacent,
  findAdjacentPrefetch,
  upsertChapter,
} from './src/core/chapterNav.js';
import { groupChaptersBySeries, parseSeriesAndEpisode } from './src/core/series.js';
import { updateChapterDomain } from './src/core/linkManager.js';
import { preloadChapterImages } from './src/core/cacheManager.js';
import * as library from './src/library.js';
import {
  deleteCatalogItems,
  getKv,
  listCatalogItems,
  mergeLegacyCatalog,
  putCatalogItem,
  putCatalogItems,
  writeMigrationV1,
} from './src/catalogStore.js';
import {
  isNativeApp,
  fetchAnilifeMediaEnvelope,
  fetchAnilifeStreamResource,
  fetchPageDocument,
  resolvePageImageUrl,
  fetchPageImage,
} from './src/platform/nativeHttp.js';
import {
  confirmBundleReady,
  finishStartupAndApplyUpdate,
  getCurrentBundleId,
} from './src/platform/liveUpdate.js';
import { APP_VERSION, BUILD_TIME } from './src/version.js';
import { ONE_PIECE_COVER_DATA } from './src/sampleCoverData.js';
import { SAMPLE_MANGA_SERIES } from './src/sampleData.js';
import {
  createInitialState,
  saveSettings as persistSettings,
  saveProgress as persistProgress,
  readProgress,
  saveLastChapterId,
  readLastChapterId,
  saveRecentChapters,
  readRecentChaptersForMigration,
  restoreStateFromKv,
  saveInitialized,
  queueStateWrite,
  flushStateWrites,
  CHROME_IDLE_MS,
} from './src/state.js';

/* ==================================================================== */
/* 상태                                                                  */
/* ==================================================================== */

const state = createInitialState();

function catalogItem(item, touch = false) {
  const now = Date.now();
  return {
    ...item,
    kind: item.kind || 'comic',
    pages: item.pages || [],
    coverUrl: item.coverUrl || null,
    sourceUrl: item.sourceUrl || null,
    prevUrl: item.prevUrl || null,
    nextUrl: item.nextUrl || null,
    savedAt: item.savedAt || now,
    updatedAt: touch ? now : (item.updatedAt || item.savedAt || now),
  };
}

function persistCatalogItem(item) {
  if (!item?.id || item.isDemo || item.id.startsWith('demo-')) return Promise.resolve();
  return queueStateWrite(() => putCatalogItem(catalogItem(item, true)));
}

function persistCatalogItems(items) {
  const records = items
    .filter((item) => item?.id && !item.isDemo && !item.id.startsWith('demo-'))
    .map((item) => catalogItem(item, true));
  return records.length > 0
    ? queueStateWrite(() => putCatalogItems(records))
    : Promise.resolve();
}

// 9494f8b 리팩토링 때 실수로 지워졌던 선언들 — 없으면 strict mode에서
// initEngine()의 `engine = ...` 대입이 ReferenceError로 부팅을 즉사시킨다.
// APK 의 loggingBehavior=production 은 "항상 로그" 다 — 네이티브 호출마다 요청·응답 전문을
// console.dir 로 찍는다 (이미지 base64 본문 포함). 콘솔 버퍼가 수십 MB 로 부풀어 태블릿이 느려진다.
// 브릿지 로그만 끈다. APK 를 다시 빌드할 때 capacitor.config.json 도 'none' 으로 바꿀 것.
if (window.Capacitor) {
  window.Capacitor.isLoggingEnabled = false;
  window.Capacitor.DEBUG = false;
}

let engine = null;
let chromeTimer = null;
let toastTimer = null;
let nextChapterPrefetch = null;
let bingeEnabled = false;
let bingeGeneration = 0;
let bingeTailId = null;
let bingePromise = null;
let chapterNavigationBusy = false;
let animePlayer = null;
let animePlaySequence = 0;

function saveSettings() {
  persistSettings(state.settings);
}

function saveProgress(chapterId, pageNumber) {
  persistProgress(chapterId, pageNumber);
}

/* ==================================================================== */
/* DOM                                                                   */
/* ==================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  viewport: $('manga-container'),
  chrome: $('chrome'),
  title: $('manga-title'),
  chapter: $('chapter-badge'),
  indicator: $('page-indicator'),
  slider: $('page-slider'),
  sliderPreview: $('slider-preview'),
  sliderPreviewImg: $('slider-preview-img'),
  sliderPreviewNum: $('slider-preview-num'),
  toast: $('toast'),
  busy: $('busy'),
  busyText: $('busy-text'),

  tapLeft: $('tap-left'),
  tapCenter: $('tap-center'),
  tapRight: $('tap-right'),

  btnEpList: $('btn-ep-list'),
  btnImport: $('btn-import'),
  btnReload: $('btn-reload'),
  btnFiles: $('btn-files'),
  btnDisplay: $('btn-display'),
  btnSettings: $('btn-settings'),

  btnPrevEp: $('btn-prev-ep'),
  btnNextEp: $('btn-next-ep'),
  btnPrevPage: $('btn-prev-page'),
  btnNextPage: $('btn-next-page'),
  btnAutoplay: $('btn-autoplay'),
  autoplayLabel: $('autoplay-label'),
  btnZoomReset: $('btn-zoom-reset'),
  btnFullscreen: $('btn-fullscreen'),

  modalImport: $('modal-import'),
  modalFiles: $('modal-files'),
  modalEpisodes: $('modal-episodes'),
  modalDisplay: $('modal-display'),
  modalSettings: $('modal-settings'),
  modalLinkManage: $('modal-link-manage'),

  epList: $('episode-list'),
  btnShelfEdit: $('btn-shelf-edit'),
  tabComicShelf: $('tab-comic-shelf'),
  tabAnimeShelf: $('tab-anime-shelf'),
  libUsage: $('lib-usage'),
  btnManageLinks: $('btn-manage-links'),
  btnApplyLinkFix: $('btn-apply-link-fix'),
  oldDomainInput: $('old-domain-input'),
  newDomainInput: $('new-domain-input'),
  btnSave1: $('btn-save-1'),
  btnSave10: $('btn-save-10'),
  rawInput: $('raw-input'),
  btnSubmitUrl: $('btn-submit-url'),
  bookmarkletUrl: $('bookmarklet-url'),
  btnCopyBookmarklet: $('btn-copy-bookmarklet'),

  dropZone: $('drop-zone'),
  fileInput: $('file-input'),

  modeGroup: $('mode-group'),
  paperGroup: $('paper-group'),
  dirGroup: $('dir-group'),
  brightness: $('filter-brightness'),
  brightnessOut: $('brightness-out'),
  transition: $('setting-transition'),
  proxyToken: $('setting-proxy-token'),
};

/* ==================================================================== */
/* 알림 · 로딩                                                           */
/* ==================================================================== */

function toast(text, { error = false, duration } = {}) {
  clearTimeout(toastTimer);
  el.toast.textContent = text;
  el.toast.classList.toggle('is-error', error);
  el.toast.classList.add('show');
  toastTimer = setTimeout(
    () => el.toast.classList.remove('show'),
    duration ?? (error ? 7000 : 2600)
  );
}

function setBusy(on, text = '불러오는 중…') {
  el.busyText.textContent = text;
  el.busy.hidden = !on;
}

/* ==================================================================== */
/* 챕터                                                                  */
/* ==================================================================== */

/* 목록 탐색 판단은 core/chapterNav 에 있다 (순수 함수라 테스트된다) */
function currentChapter() {
  return findChapter(state.chapters, state.currentId);
}

function isAnimeItem(item) {
  return item?.kind === 'anime' || item?.type === 'anime';
}

function initAnimePlayer() {
  if (animePlayer) return animePlayer;
  const move = (target) => playAnimeEpisode(target.id);
  animePlayer = new AnimePlayer({
    loadResource: isNativeApp() ? fetchAnilifeStreamResource : null,
    onPrev: move,
    onNext: move,
    onClose: () => {
      animePlaySequence++;
      setBusy(false);
      state.currentShelfTab = 'anime';
      renderEpisodeList();
      openModal(el.modalEpisodes);
    },
    onError: (error) => toast(error.message, { error: true, duration: 10000 }),
  });
  return animePlayer;
}

async function playAnimeEpisode(id) {
  const sequence = ++animePlaySequence;
  const isCurrentRequest = () => sequence === animePlaySequence;
  try {
    setBusy(true, '영상 주소 준비 중…');
    const response = await fetchAnilifeMediaEnvelope(id);
    if (!isCurrentRequest()) return;
    if (!response.ok) throw new Error(`애니 재생 정보를 받지 못했습니다 (${response.status}).`);
    const rawMedia = await response.text();
    if (!isCurrentRequest()) return;
    const playback = buildAnilifePlayback(await decryptAnilifeMedia(rawMedia), id);
    if (!isCurrentRequest()) return;
    const item = catalogItem({
      id: `anime-${id}`,
      kind: 'anime',
      type: 'anime',
      title: `${playback.seriesTitle} ${playback.episodeNumber}화`,
      label: `${playback.episodeNumber}화`,
      episodeNumber: playback.episodeNumber,
      episodeTitle: playback.episodeTitle,
      coverUrl: playback.posterUrl || null,
      sourceUrl: playback.sourceUrl,
      pages: [],
    }, true);
    await persistCatalogItem(item);
    if (!isCurrentRequest()) return;
    state.chapters = [item, ...state.chapters.filter((chapter) => chapter.id !== item.id)];
    saveRecentChapters(state.chapters);
    closeAllModals();
    hideChrome();
    initAnimePlayer().load(playback);
  } catch (error) {
    if (isCurrentRequest()) {
      toast(`애니 재생 실패: ${error.message}`, { error: true, duration: 10000 });
    }
  } finally {
    if (isCurrentRequest()) setBusy(false);
  }
}

function openAnimeEpisode(item) {
  const id = isAnimeItem(item) ? parseAnilifeWatchId(item.sourceUrl) : null;
  if (!id) {
    toast('애니 재생 주소가 올바르지 않습니다.', { error: true });
    return;
  }
  playAnimeEpisode(id);
}

function openCatalogItem(item) {
  if (isAnimeItem(item)) openAnimeEpisode(item);
  else openChapter(item.id);
}

function currentIndex() {
  return indexOfChapter(state.chapters, state.currentId);
}

/** 불러온 게 없을 때. 빈 컷 프레임을 그리면 고장으로 보이니 아예 안 그린다 */
function showEmptyState() {
  state.currentId = null;
  document.getElementById('app').classList.add('is-empty');

  el.title.textContent = '만화 뷰어';
  el.chapter.textContent = '';
  el.indicator.textContent = '– / –';
  el.slider.max = '1';
  el.slider.value = '1';
  el.slider.disabled = true;

  [el.btnPrevPage, el.btnNextPage, el.btnPrevEp, el.btnNextEp, el.btnAutoplay].forEach((b) => {
    b.disabled = true;
  });
}

/** 앞 챕터가 쓰던 blob 주소를 놓아준다 */
function revokeObjectUrls() {
  state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
  state.objectUrls = [];
}

/**
 * 챕터를 연다.
 *
 * 서재에 저장돼 있으면 이미지 바이트를 꺼내 blob 주소로 갈아끼운다. 그래야
 * 프록시(=맥북 서버)가 죽어 있어도 읽힌다. 태블릿 단독 사용의 핵심 지점이 여기다.
 * 한 장이라도 빠진 부분 저장이면 resolveOffline 이 null 을 주고 온라인 경로를 쓴다.
 */
let openToken = 0;

async function openChapter(chapterId, pageNumber) {
  const chapter = state.chapters.find((c) => c.id === chapterId);
  if (!chapter) return;

  /**
   * 서재 조회에 await 가 있어서 두 화를 연달아 누르면 호출이 겹친다.
   * 늦게 시작한 쪽이 먼저 시작한 쪽의 blob 주소를 놓아버리면 빈 컷이 되고,
   * 그건 "고장난 앱"으로 보인다. 마지막 호출만 화면을 만지게 한다.
   */
  const token = ++openToken;

  /**
   * 엔진에 넘길 판. chapter.pages 는 절대 덮지 않는다 — 그 주소가 서재의 키다.
   * blob 주소로 갈아끼워 저장해버리면 두 번째로 열 때 조회가 빗나간다.
   */
  let offline = null;

  // 로컬 파일·데이터 URL 은 프록시를 안 타므로 서재를 볼 필요가 없다
  const proxied = (chapter.pages || []).some((p) => p.url?.startsWith('/api/'));
  if (proxied && state.saved.has(chapter.id)) {
    try {
      offline = await library.resolveOffline(chapter);
    } catch (err) {
      console.warn('[서재] 저장된 이미지를 꺼내지 못했습니다', err);
    }
  }

  // 기다리는 동안 다른 화를 눌렀으면 이 호출은 물러난다. 자기가 만든 주소만 치운다
  if (token !== openToken) {
    offline?.forEach((u) => URL.revokeObjectURL(u));
    return;
  }

  // 이긴 호출만 화면 상태를 만진다. 앞 챕터 주소를 놓아주는 것도 여기서
  revokeObjectUrls();
  let forEngine = chapter;
  if (offline) {
    state.objectUrls = offline;
    forEngine = { ...chapter, pages: offline.map((url, i) => ({ ...chapter.pages[i], url })) };
  }

  document.getElementById('app').classList.remove('is-empty');
  el.slider.disabled = false;
  [el.btnPrevPage, el.btnNextPage, el.btnAutoplay].forEach((b) => {
    b.disabled = false;
  });

  state.currentId = chapter.id;
  saveLastChapterId(chapter.id);
  saveRecentChapters(state.chapters);

  el.title.textContent = chapter.title || '만화 뷰어';
  el.chapter.textContent = chapter.label || '';

  // currentId 를 먼저 세운 뒤에 판정해야 hasAdjacent 가 올바른 위치를 본다
  el.btnPrevEp.disabled = !hasAdjacent(-1);
  el.btnNextEp.disabled = !hasAdjacent(1);

  const startAt = pageNumber ?? readProgress()[chapter.id] ?? 1;
  bingeGeneration++;
  bingePromise = null;
  bingeTailId = chapter.id;
  // 다음 화 미리 받기를 먼저 건다. loadChapter 가 동기적으로 onPageChange 를 부르고 정주행이
  // 그 안에서 미리 받기를 찾는다 — 뒤에 걸면 같은 화를 두 번 수집하고 한쪽이 거절당한다.
  prefetchNextChapter(chapter);
  engine.loadChapter(forEngine, startAt);
  preloadChapterImages(forEngine);
  if (bingeEnabled) ensureBingeAhead();
}

/** 다음 화 HTML/컷 목록만 조용히 미리 수집하여 다음 화 전환 속도를 극대화한다. */
function prefetchNextChapter(chapter) {
  if (!chapter?.nextUrl) {
    nextChapterPrefetch = null;
    return;
  }
  if (
    nextChapterPrefetch?.sourceId === chapter.id &&
    nextChapterPrefetch.url === chapter.nextUrl
  ) return;

  const promise = UrlHarvester.fetchFromUrl(chapter.nextUrl, { silentRenderedFallback: true })
    .then((harvested) => harvested?.pages?.length
      ? storeHarvestedChapter(harvested, 'prefetch')
      : null)
    .catch((err) => {
      console.debug('[다음 화 미리 받기] 클릭할 때 다시 시도합니다.', err.message);
      return null;
    });
  nextChapterPrefetch = { sourceId: chapter.id, url: chapter.nextUrl, promise };
}

/**
 * 사이트가 알려준 전 회차 목록. 작품 이름으로 찾는다.
 *
 * 일부러 저장하지 않는다. 두 가지 이유가 있다:
 *  1. 새 화를 불러오려면 어차피 네트워크가 필요하다 — 온라인이면 같은 작품의
 *     아무 화를 열 때 목록이 공짜로 다시 채워진다.
 *  2. 챕터 레코드에 실으면 `saveRecentChapters` 의 필드 화이트리스트에서
 *     조용히 사라지고(v1.5.x 가 물린 함정), 회차 수백 개가 챕터마다 중복돼
 *     localStorage 용량을 넘긴다.
 */
const seriesEpisodeLinks = new Map();

function rememberEpisodeLinks(harvested, chapter) {
  const links = harvested?.episodeLinks;
  if (!Array.isArray(links) || links.length === 0) return;
  const { seriesTitle } = parseSeriesAndEpisode(chapter.title || '');
  seriesEpisodeLinks.set(seriesTitle, links);
}

/** 회차 목록에서 아직 안 불러온 화를 눌렀을 때 */
async function loadEpisodeUrl(url) {
  try {
    setBusy(true, '회차 불러오는 중…');
    const harvested = await UrlHarvester.fetchFromUrl(url);
    await addChapter(harvested, 'import');
    toast(`${harvested.pages.length}장 불러왔습니다.`);
  } catch (err) {
    toast(err.message + formatDiagnosis(err.diagnosis), { error: true, duration: 20000 });
  } finally {
    setBusy(false);
  }
}

/**
 * 지금 보는 화를 원본 주소에서 통째로 다시 수집한다.
 *
 * 왜 필요한가: 뉴토키류는 컷 주소에 서명이 붙어 시간이 지나면 만료된다.
 * 만료된 화는 컷이 군데군데 안 뜨는데, 저장된 주소로는 복구가 안 된다 —
 * 원본 페이지에서 새 서명 주소를 받아와야 한다. 읽던 페이지는 유지한다.
 */
/**
 * 컷이 계속 실패하면 스스로 원본에서 다시 수집한다.
 *
 * 왜 필요한가: 컷 주소에는 서명이 붙어 시간이 지나면 만료된다. 앱을 껐다 켜면
 * WebView 캐시도 비어 있어 담아두지 않은 화는 전부 "이미지 실패 · 다시 시도" 로 뜬다.
 * 그 버튼은 같은 만료 주소를 다시 요청하므로 눌러도 안 된다 — 새 서명을 받아야 한다.
 *
 * 서재에 담아둔 화는 이 길로 오지 않는다 (바이트가 기기에 있어 실패하지 않는다).
 */
const imageFailures = new Map();
const autoReloaded = new Set();
const IMAGE_FAILURES_BEFORE_RELOAD = 3;

function autoReloadChapter(chapterId) {
  if (autoReloaded.has(chapterId) || chapterNavigationBusy) return;
  const chapter = state.chapters.find((c) => c.id === chapterId);
  if (!chapter?.sourceUrl) return; // 로컬 파일·데모는 되받을 원본이 없다
  autoReloaded.add(chapterId); // 한 화에 한 번만 — 실패가 네트워크 탓이면 반복해도 같다
  toast('컷 주소가 만료된 것 같습니다. 원본에서 다시 받아옵니다…');
  reloadCurrentChapter().catch((err) => console.warn('[자동 재수집] 실패', err));
}

async function reloadCurrentChapter() {
  const chapter = state.chapters.find((c) => c.id === state.currentId);
  if (!chapter) {
    toast('열려 있는 화가 없습니다.', { error: true });
    return;
  }
  if (!chapter.sourceUrl) {
    toast('원본 주소가 없는 화라 다시 수집할 수 없습니다 (로컬 파일 등).', { error: true });
    return;
  }

  const keepPage = engine?.getPageInfo()?.currentPageNum ?? 1;
  try {
    setBusy(true, '이 화를 다시 수집하는 중…');
    const harvested = await UrlHarvester.fetchFromUrl(chapter.sourceUrl);
    const { chapters, chapter: updated } = upsertChapter(state.chapters, harvested, `reload-${Date.now()}`);
    state.chapters = chapters;
    rememberEpisodeLinks(harvested, updated);
    saveRecentChapters(chapters);
    await persistCatalogItem(updated);
    await openChapter(updated.id, Math.min(keepPage, harvested.pages.length));
    toast(`이미지 ${harvested.pages.length}장을 새로 받아왔습니다.`);
  } catch (err) {
    toast(err.message + formatDiagnosis(err.diagnosis), { error: true, duration: 20000 });
  } finally {
    setBusy(false);
  }
}

/**
 * 새로 수집한 챕터를 목록 맨 앞에 넣고 바로 연다.
 * 같은 출처를 다시 불러오면 새로 만들지 않고 갱신한다.
 */
async function storeHarvestedChapter(harvested, idPrefix) {
  const { chapters, chapter } = upsertChapter(
    state.chapters,
    harvested,
    `${idPrefix}-${Date.now()}`
  );
  state.chapters = chapters;
  rememberEpisodeLinks(harvested, chapter);
  saveRecentChapters(chapters);
  await persistCatalogItem(chapter);
  return chapter;
}

async function addChapter(harvested, idPrefix) {
  const chapter = await storeHarvestedChapter(harvested, idPrefix);

  // 새로 불러온 콘텐츠는 항상 auto 로 본다. 앞 챕터에서 고른 모드를 물려받으면
  // 웹툰이 페이지 넘김으로 뜨는 식으로 깨진다.
  resetModeToAuto();

  await openChapter(chapter.id, 1);
  return chapter;
}

function updateBingeButton() {
  el.btnAutoplay.classList.toggle('is-active', bingeEnabled);
  el.btnAutoplay.setAttribute('aria-pressed', String(bingeEnabled));
  el.autoplayLabel.textContent = bingeEnabled ? '정주행 끄기' : '정주행';
  el.btnAutoplay
    .querySelector('use')
    .setAttribute('href', bingeEnabled ? '#i-pause' : '#i-play');
}

async function toggleBingeMode() {
  if (!bingeEnabled) {
    if (!el.viewport.classList.contains('mode-strip')) {
      toast('정주행은 세로 스크롤 웹툰에서만 쓸 수 있습니다.');
      return;
    }

    const info = engine?.getPageInfo();
    if (!info?.chapterId) return;

    bingeEnabled = true;
    bingeGeneration++;
    bingePromise = null;
    bingeTailId = info.chapterId;
    updateBingeButton();
    prefetchNextChapter(state.chapters.find((chapter) => chapter.id === info.chapterId));
    ensureBingeAhead();
    toast('정주행 시작');
    return;
  }

  bingeEnabled = false;
  bingeGeneration++;
  bingePromise = null;
  bingeTailId = null;
  updateBingeButton();
  toast('정주행 종료');
}

async function canLoadFirstPage(chapter) {
  if (!navigator.onLine || !chapter?.pages?.[0]) return false;
  const controller = new AbortController();
  let timer;
  let resolved = null;
  const resolving = resolvePageImageUrl(chapter.pages[0]);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, 5000);
  });
  try {
    resolved = await Promise.race([resolving, timeout]);
    if (!resolved) {
      resolving
        .then((late) => {
          if (late?.owned) URL.revokeObjectURL(late.url);
        })
        .catch(() => {});
      return false;
    }
    const response = await fetch(resolved.url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    return response.ok && !contentType.includes('text/html');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (resolved?.owned) URL.revokeObjectURL(resolved.url);
  }
}

function ensureBingeAhead() {
  if (
    !bingeEnabled
    || !bingeTailId
    || !el.viewport.classList.contains('mode-strip')
  ) return Promise.resolve(null);
  if (bingePromise) return bingePromise;

  const generation = bingeGeneration;
  const tailId = bingeTailId;
  const task = (async () => {
    const tail = state.chapters.find((chapter) => chapter.id === tailId);
    const move = resolveAdjacent(state.chapters, tailId, 1);
    if (!tail || move.kind === 'none') return null;

    let next = move.kind === 'open' ? move.chapter : null;
    if (!next) {
      const prepared = findAdjacentPrefetch(nextChapterPrefetch, tailId, 1, move.url);
      next = prepared ? await prepared : null;
      if (!next) {
        const harvested = await UrlHarvester.fetchFromUrl(move.url, {
          silentRenderedFallback: true,
        });
        if (!harvested?.pages?.length) return null;
        if (!bingeEnabled || generation !== bingeGeneration || tailId !== bingeTailId) return null;
        next = await storeHarvestedChapter(harvested, 'binge');
      }
    }

    if (!bingeEnabled || generation !== bingeGeneration || tailId !== bingeTailId) return null;

    let offline = null;
    const proxied = (next.pages || []).some((page) => page.url?.startsWith('/api/'));
    if (proxied && state.saved.has(next.id) && !(await canLoadFirstPage(next))) {
      try {
        offline = await library.resolveOffline(next);
      } catch (err) {
        console.warn('[정주행] 저장된 다음 화를 꺼내지 못했습니다', err);
      }
    }

    if (!bingeEnabled || generation !== bingeGeneration || tailId !== bingeTailId) {
      offline?.forEach((url) => URL.revokeObjectURL(url));
      return null;
    }

    const forEngine = offline
      ? { ...next, pages: offline.map((url, i) => ({ ...next.pages[i], url })) }
      : next;
    if (!engine.appendChapter(forEngine)) {
      offline?.forEach((url) => URL.revokeObjectURL(url));
      return null;
    }

    if (offline) state.objectUrls.push(...offline);
    preloadChapterImages(forEngine);

    // Offline Blob URLs retain backing bytes until revoked. Keep one seamless
    // handoff only; normal next-episode navigation then releases prior URLs.
    if (offline) {
      bingeEnabled = false;
      bingeGeneration++;
      bingePromise = null;
      bingeTailId = null;
      updateBingeButton();
      toast('오프라인 정주행은 메모리 보호를 위해 다음 1화까지만 이어집니다.');
      return next;
    }

    bingeTailId = next.id;
    prefetchNextChapter(next);
    return next;
  })().catch((err) => {
    console.debug('[정주행] 다음 화는 경계에서 다시 시도합니다.', err.message);
    return null;
  });

  bingePromise = task;
  task.finally(() => {
    if (bingePromise === task) bingePromise = null;
  });
  return task;
}

function realNeighbor(delta) {
  return findRealNeighbor(state.chapters, state.currentId, delta);
}

function hasAdjacent(delta) {
  return canGoAdjacent(state.chapters, state.currentId, delta);
}

/**
 * 인접 화로 이동.
 * 사이트의 이전/다음 링크가 있으면 그게 진짜 인접 화다 — 서버가 받아온다.
 * 없으면 이미 불러둔 챕터 중에서 찾는다.
 */
async function goChapter(delta) {
  if (chapterNavigationBusy) return;
  chapterNavigationBusy = true;
  let busy = false;
  try {
    const move = resolveAdjacent(state.chapters, state.currentId, delta);
    if (move.kind === 'none') {
      toast(delta > 0 ? '다음 화가 없습니다.' : '이전 화가 없습니다.');
      return;
    }

    if (move.kind === 'open') {
      resetModeToAuto();
      // 다음/이전 화 버튼은 1쪽부터. 예전에 훑은 화의 저장 위치로 열리면 "다음 화가 중간부터 시작" 으로 보였다
      await openChapter(move.chapter.id, 1);
      return;
    }

    // kind === 'fetch' — 사이트가 준 인접 화 주소를 서버가 받아온다
    busy = true;
    setBusy(true, delta > 0 ? '다음 화 불러오는 중…' : '이전 화 불러오는 중…');
    const prepared = findAdjacentPrefetch(nextChapterPrefetch, state.currentId, delta, move.url);
    const prefetched = prepared ? await prepared : null;
    if (prefetched) {
      resetModeToAuto();
      await openChapter(prefetched.id, 1);
      toast(`${prefetched.pages.length}장 불러왔습니다.`);
      return;
    }

    const harvested = await UrlHarvester.fetchFromUrl(move.url);
    await addChapter(harvested, 'import');
    toast(`${harvested.pages.length}장 불러왔습니다.`);
  } catch (err) {
    toast(err.message + formatDiagnosis(err.diagnosis), { error: true, duration: 20000 });
  } finally {
    if (busy) setBusy(false);
    chapterNavigationBusy = false;
  }
}

/* ==================================================================== */
/* 서재 (오프라인 저장)                                                   */
/* ==================================================================== */

/**
 * 서재에 담기 = 이미지 바이트를 태블릿에 내려받기.
 *
 * 왜 지금 받아둬야 하나: 이미지 호스트가 Referer 를 본다(실측 403/200).
 * 브라우저는 다른 오리진의 Referer 를 위조할 수 없으므로 프록시가 필수다.
 * 담아두면 그 뒤로는 프록시가 없어도 읽힌다 — 태블릿 단독 사용의 답.
 */
async function refreshSaved() {
  try {
    const rows = await library.listChapters();
    state.saved = new Map(rows.map((r) => [r.id, r]));
  } catch (err) {
    console.warn('[서재] 목록을 읽지 못했습니다', err);
  }
}

/** 담을 수 없는 챕터(데모·로컬 파일)는 버튼을 내린다 */
function canSave(chapter) {
  return !!chapter && !chapter.isDemo && (chapter.pages || []).some((p) => p.url?.startsWith('/api/'));
}

async function saveOne(chapter, prefix = '') {
  await library.saveChapter(chapter, {
    onProgress: (i, total) => setBusy(true, `${prefix}${i}/${total}장 담는 중…`),
  });
  await persistCatalogItem(chapter);
}

/**
 * 지금 화부터 다음 화 방향으로 연달아 담는다.
 *
 * 회차 목록 페이지를 긁지 않는다 — 사이트마다 목록이 JS 데이터로만 있거나
 * 구조가 달라서 범용 규칙이 안 선다(네이버는 헤드리스로도 회차 링크가 2개뿐이었다).
 * 대신 이미 검증된 "다음 화 주소"를 그대로 따라간다. 번호가 매겨진 사이트면 다 된다.
 */
async function batchSave(count) {
  let chapter = currentChapter();
  if (!canSave(chapter)) {
    toast('이 챕터는 담을 수 없습니다 (불러온 만화만 담깁니다).', { error: true });
    return;
  }

  let done = 0;
  let stopReason = null;

  try {
    for (let n = 0; n < count; n++) {
      await saveOne(chapter, `${done + 1}/${count}화 · `);
      done++;

      if (n === count - 1) break;

      if (!chapter.nextUrl) {
        stopReason = '다음 화 주소가 없어 여기서 멈췄습니다.';
        break;
      }

      setBusy(true, `${done + 1}/${count}화 불러오는 중…`);
      const harvested = await UrlHarvester.fetchFromUrl(chapter.nextUrl);
      const next = upsertChapter(state.chapters, harvested, `import-${Date.now()}-${n}`);
      state.chapters = next.chapters;
      chapter = next.chapter;
      await persistCatalogItem(chapter);
    }
  } catch (err) {
    stopReason = err.message;
  } finally {
    await refreshSaved();
    setBusy(false);
  }

  const bytes = [...state.saved.values()].reduce((sum, r) => sum + (r.bytes || 0), 0);
  const head = done > 0 ? `${done}화 담았습니다 (서재 ${library.formatBytes(bytes)}).` : '담지 못했습니다.';
  toast(stopReason ? `${head}\n${stopReason}` : head, {
    error: Boolean(stopReason) || done === 0,
    duration: stopReason ? 8000 : 3000,
  });

  if (el.modalEpisodes.classList.contains('is-open')) renderEpisodeList();
}

/* ==================================================================== */
/* 엔진                                                                  */
/* ==================================================================== */

function initEngine() {
  engine = new ReaderEngine({
    container: el.viewport,
    mode: state.settings.mode,
    direction: state.settings.direction,
    transitionType: state.settings.transition,
    resolvePageUrl: resolvePageImageUrl,

    onPageChange: (info) => {
      const ownerId = info.chapterId || state.currentId;
      if (ownerId && ownerId !== state.currentId) {
        const chapter = state.chapters.find((item) => item.id === ownerId);
        state.currentId = ownerId;
        el.title.textContent = info.title || chapter?.title || '만화 뷰어';
        el.chapter.textContent = info.label || chapter?.label || '';
        el.btnPrevEp.disabled = !hasAdjacent(-1);
        el.btnNextEp.disabled = !hasAdjacent(1);
      }

      el.slider.max = String(Math.max(1, info.totalPages));
      el.slider.value = String(info.currentPageNum);
      el.indicator.textContent = `${info.currentPageNum} / ${info.totalPages}`;
      if (ownerId) {
        saveProgress(ownerId, info.currentPageNum);
        saveLastChapterId(ownerId);
      }

      if (bingeEnabled && ownerId === bingeTailId) ensureBingeAhead();
    },

    onZoomChange: (zoomed) => {
      el.btnZoomReset.classList.toggle('is-hidden', !zoomed);
    },

    onImageFailure: (chapterId) => {
      if (!chapterId || chapterId !== state.currentId) return;
      const failures = (imageFailures.get(chapterId) || 0) + 1;
      imageFailures.set(chapterId, failures);
      if (failures >= IMAGE_FAILURES_BEFORE_RELOAD) autoReloadChapter(chapterId);
    },

    onEpisodeEnd: () => {
      if (bingeEnabled) {
        const move = resolveAdjacent(state.chapters, bingeTailId, 1);
        if (move.kind === 'none') toast('마지막 화입니다.');
        else ensureBingeAhead();
        return;
      }

      if (hasAdjacent(1)) {
        toast('다음 화로 이동합니다…');
        goChapter(1);
      } else {
        toast('마지막 화입니다.');
      }
    },
  });
}

/* ==================================================================== */
/* 컨트롤 바 자동 숨김                                                   */
/* ==================================================================== */

// 'is-collapsed' 를 쓴다. 'is-hidden' 은 display:none 유틸리티라서
// 그 이름을 쓰면 바가 사라지고 슬라이드 전환이 돌지 않는다.
function showChrome(autoHide = true) {
  state.chromeVisible = true;
  el.chrome.classList.remove('is-collapsed');
  clearTimeout(chromeTimer);
  if (autoHide) chromeTimer = setTimeout(hideChrome, CHROME_IDLE_MS);
}

function hideChrome() {
  state.chromeVisible = false;
  el.chrome.classList.add('is-collapsed');
  clearTimeout(chromeTimer);
}

function toggleChrome() {
  state.chromeVisible ? hideChrome() : showChrome();
}

/* ==================================================================== */
/* 모달                                                                  */
/* ==================================================================== */

function openModal(modal) {
  modal.classList.add('is-open');
  showChrome(false);
}

function closeModal(modal) {
  modal.classList.remove('is-open');
  showChrome();
}

function closeAllModals() {
  document.querySelectorAll('.modal.is-open').forEach((m) => m.classList.remove('is-open'));
}

/** 서재 막대의 용량·안내 문구를 현황에 맞춘다 */
function renderLibraryBar() {
  const rows = [...state.saved.values()];
  const bytes = rows.reduce((sum, r) => sum + (r.bytes || 0), 0);

  el.libUsage.textContent =
    rows.length === 0
      ? '서재 비어 있음'
      : `서재 ${rows.length}화 · ${library.formatBytes(bytes)}`;

  /**
   * 앱 껍데기 오프라인은 서비스워커가 필요하고, 그건 secure context 전용이다.
   * LAN 주소로 붙었으면 담아둔 화는 읽히지만 앱을 여는 순간엔 서버가 필요하다.
   * 조용히 다르게 동작하면 "왜 어제는 됐는데" 가 되므로 화면에 적어둔다.
   */
  const note = el.libUsage.nextElementSibling;
  if (note) {
    note.textContent = window.isSecureContext
      ? '담아두면 서버 없이 이 태블릿에서만 읽힙니다.'
      : '담아둔 화는 읽힙니다. 앱을 여는 것까지 서버 없이 하려면 localhost 나 https 로 접속해야 합니다.';
  }

  const savable = state.currentShelfTab !== 'anime' && canSave(currentChapter());
  el.btnSave1.disabled = !savable;
  el.btnSave10.disabled = !savable;
  el.btnManageLinks.disabled = state.currentShelfTab === 'anime';
}

/**
 * sourceUrl 에서 시리즈 키를 뽑는다.
 * 같은 사이트 + 같은 작품 경로를 공유하는 챕터를 한 묶음으로 보기 위한 것.
 * 에피소드 번호 파라미터(no, episode, ep, chapter 등)를 제거하면 시리즈 키가 된다.
 */
const EPISODE_PARAM_NAMES = ['no', 'episode', 'ep', 'chapter', 'chap', 'toon'];

function seriesKeyFromUrl(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    for (const key of EPISODE_PARAM_NAMES) {
      url.searchParams.delete(key);
    }
    // 경로 끝의 숫자도 제거 (예: /webtoon/12345 → /webtoon/)
    url.pathname = url.pathname.replace(/\/\d+\/?$/, '/');
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * 챕터 제목에서 시리즈명을 추출한다.
 * "작품명 123화", "작품명 - 제12화" 같은 패턴에서 작품명 부분만 뽑는다.
 */
function seriesNameFromTitle(title) {
  if (!title) return '기타';
  // 흔한 패턴: "제목 123화", "제목 - 제12화", "제목 #12", "제목 ep.12"
  const cleaned = title
    .replace(/\s*[-–]\s*(제?\s*\d+화|제?\s*\d+[화회]?|ep\.?\s*\d+|#\s*\d+|chapter\s*\d+)\s*$/i, '')
    .replace(/\s+\d+화?\s*$/, '')
    .trim();
  return cleaned || title;
}

function renderEpisodeList(selectedSeriesTitle = null) {
  renderLibraryBar();

  const animeTab = state.currentShelfTab === 'anime';
  el.tabComicShelf.classList.toggle('btn-primary', !animeTab);
  el.tabAnimeShelf.classList.toggle('btn-primary', animeTab);
  el.tabComicShelf.setAttribute('aria-pressed', String(!animeTab));
  el.tabAnimeShelf.setAttribute('aria-pressed', String(animeTab));
  el.tabComicShelf.onclick = () => {
    state.currentShelfTab = 'comic';
    renderEpisodeList();
  };
  el.tabAnimeShelf.onclick = () => {
    state.currentShelfTab = 'anime';
    renderEpisodeList();
  };

  if (el.btnShelfEdit) {
    el.btnShelfEdit.textContent = state.isShelfEditMode ? '✅ 편집 완료' : '✏️ 서재 편집';
    el.btnShelfEdit.className = state.isShelfEditMode ? 'btn btn-sm btn-primary' : 'btn btn-sm';
    el.btnShelfEdit.onclick = () => {
      state.isShelfEditMode = !state.isShelfEditMode;
      renderEpisodeList();
    };
  }

  const filteredChapters = state.chapters.filter((chapter) =>
    animeTab ? isAnimeItem(chapter) : !isAnimeItem(chapter)
  );
  const seriesGroups = groupChaptersBySeries(filteredChapters);

  // 특정 시리즈가 선택되었을 때는 회차 텍스트 목록 뷰 렌더링
  if (selectedSeriesTitle) {
    const targetGroup = seriesGroups.find((g) => g.seriesTitle === selectedSeriesTitle);
    if (targetGroup) {
      renderSeriesChaptersView(targetGroup);
      return;
    }
  }

  // 기본 상태: E-Book 책장 그리드 렌더링
  const elements = [];

  // 맨 위에 "이어보기" — 마지막으로 읽던 화로 바로 간다 (부팅 때 자동으로 열려 있으면 모달만 닫는다)
  const continueCard = buildContinueCard(filteredChapters);
  if (continueCard) elements.push(continueCard);

  for (const group of seriesGroups) {
    const card = document.createElement('div');
    card.className = 'shelf-card';

    const coverWrapper = document.createElement('div');
    coverWrapper.className = 'shelf-cover-wrapper';

    /**
     * 표지 한 장을 건다. 순서가 곧 우선순위다.
     *   1) 시리즈 대표 표지  2) 서재에 담아둔 첫 컷(네트워크 없어도 보인다)
     *   3) 원본 페이지를 다시 열어 표지 재추출
     */
    const loadCoverImage = async () => {
      const placeholder = document.createElement('div');
      placeholder.className = 'shelf-cover-placeholder';
      const placeholderTitle = document.createElement('span');
      placeholderTitle.className = 'shelf-placeholder-title';
      placeholderTitle.textContent = group.seriesTitle;
      placeholder.appendChild(placeholderTitle);
      coverWrapper.appendChild(placeholder);

      const referer = group.chapters.find((c) => c.sourceUrl)?.sourceUrl || '';
      let srcUrl = null;
      let ownedBlob = false;

      /** 원본 주소를 리더가 쓰는 page 객체 모양으로 맞춘다 */
      const asPage = (raw) => {
        if (!raw) return null;
        const normalized = raw.startsWith('./') ? raw.slice(1) : raw;
        return { url: normalized, originalUrl: raw, refererUrl: referer };
      };

      const tryLoad = async (raw) => {
        if (!raw) return false;
        if (animeTab && /^https?:\/\//i.test(raw) && !isNativeApp()) {
          srcUrl = `/api/proxy-image?url=${encodeURIComponent(raw)}&ref=${encodeURIComponent(referer)}`;
          ownedBlob = false;
          return true;
        }
        // 1. 로컬 정적 파일 주소면 바로 지정
        if (/^(blob:|data:|\.\/|\/|[a-zA-Z0-9_\-]+\.(jpg|png|webp|svg))/i.test(raw)) {
          srcUrl = raw.startsWith('./') ? raw.slice(2) : raw;
          ownedBlob = false;
          return true;
        }

        const page = { url: raw, originalUrl: raw, refererUrl: referer || 'https://newtoki1.org/' };
        try {
          // Native App / Web 공통으로 이미지 바이트를 Blob으로 로드하여 403 차단 우회
          const response = await fetchPageImage(page).catch(() => null);
          if (response?.ok && response?.blob) {
            srcUrl = URL.createObjectURL(response.blob);
            ownedBlob = true;
          } else {
            srcUrl = raw;
            ownedBlob = false;
          }
        } catch (err) {
          srcUrl = raw;
          ownedBlob = false;
        }
        return Boolean(srcUrl);
      };

      // 1. 작품 목록 페이지에서 수집된 시리즈 원본 대표 표지(group.coverUrl 및 group.coverPage) 1순위 적용
      await tryLoad(group.coverUrl || group.coverPage?.originalUrl || group.coverPage?.url);

      // 원피스 샘플 카드이고 온라인 표지 로드가 실패했을 때만 인라인 딜리버리
      if (!srcUrl && /원피스|one\s*piece/i.test(group.seriesTitle)) {
        srcUrl = ONE_PIECE_COVER_DATA;
      }

      // 2. 서재에 담아둔 챕터면 저장된 바이트로 — 네트워크가 없어도 책장이 채워진다
      if (!srcUrl) {
        const savedKey = group.chapters.find((c) => c.pages?.[0]?.url)?.pages[0].url;
        const blobUrl = await library.pageBlobUrl(savedKey);
        if (blobUrl) {
          srcUrl = blobUrl;
          ownedBlob = true;
        }
      }

      // 3. 표지가 아예 없고 사용자가 수동 새로고침을 요구했을 때만 원본 페이지 재추출
      if (!srcUrl && referer && group.forceRefreshCover && !animeTab) {
        try {
          const fetched = await UrlHarvester.fetchFromUrl(referer, { silentRenderedFallback: true });
          if (fetched?.coverUrl) {
            group.coverUrl = fetched.coverUrl;
            const ids = new Set(group.chapters.map((c) => c.id));
            for (const chapter of state.chapters) {
              if (ids.has(chapter.id)) chapter.coverUrl = fetched.coverUrl;
            }
            saveRecentChapters(state.chapters);
            await persistCatalogItems(state.chapters.filter((chapter) => ids.has(chapter.id)));
            await tryLoad(fetched.coverUrl);
          }
        } catch (err) {
          console.warn('온라인 표지 자동 추출 복구 실패:', err);
          throw err;
        }
      }

      if (!srcUrl) return;

      const img = document.createElement('img');
      img.className = 'shelf-cover';
      img.alt = group.seriesTitle;
      img.onload = () => {
        if (placeholder && placeholder.parentNode) {
          placeholder.remove();
        }
      };
      img.onerror = () => {
        console.warn('표지 로딩 최종 실패:', srcUrl);
        if (ownedBlob && srcUrl.startsWith('blob:')) URL.revokeObjectURL(srcUrl);
      };
      img.src = srcUrl;

      // loading="lazy" 제거 및 즉시 DOM 주입으로 WebView 레이지 로딩 블락 완전 해결
      coverWrapper.insertBefore(img, coverWrapper.firstChild);
    };

    loadCoverImage().catch((error) => console.warn('표지 로드 실패:', error));

    const badge = document.createElement('span');
    badge.className = 'shelf-badge';
    badge.textContent = `${group.chapters.length}화`;
    coverWrapper.appendChild(badge);

    // 편집 모드일 때만 표지 수동 새로고침(🔄) 버튼 노출
    if (state.isShelfEditMode && referer && !animeTab) {
      const refreshCoverBtn = document.createElement('button');
      refreshCoverBtn.type = 'button';
      refreshCoverBtn.className = 'shelf-refresh-btn';
      refreshCoverBtn.title = '작품 표지 새로고침';
      refreshCoverBtn.innerHTML = '🔄';
      refreshCoverBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        group.forceRefreshCover = true;
        try {
          await loadCoverImage();
          toast(`'${group.seriesTitle}' 작품 표지를 새로고침했습니다.`);
        } catch (error) {
          toast(`표지 저장 실패: ${error.message}`, { error: true });
        }
      });
      coverWrapper.appendChild(refreshCoverBtn);
    }

    const info = document.createElement('div');
    info.className = 'shelf-info';

    const infoTextWrapper = document.createElement('div');
    infoTextWrapper.className = 'shelf-info-text';

    const title = document.createElement('span');
    title.className = 'shelf-title';
    title.textContent = group.seriesTitle;

    const count = document.createElement('span');
    count.className = 'shelf-count';
    count.textContent = `총 ${group.chapters.length}개 회차`;

    infoTextWrapper.append(title, count);

    coverWrapper.style.cursor = 'pointer';
    coverWrapper.addEventListener('click', () => {
      renderEpisodeList(group.seriesTitle);
    });

    infoTextWrapper.style.cursor = 'pointer';
    infoTextWrapper.addEventListener('click', () => {
      renderEpisodeList(group.seriesTitle);
    });

    info.append(infoTextWrapper);

    // 편집 모드(isShelfEditMode)일 때만 서재 카드에 🗑️ 삭제 버튼 표시!
    if (state.isShelfEditMode) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'shelf-card-delete-action';
      deleteBtn.title = '서재에서 삭제';
      deleteBtn.innerHTML = '🗑️ 삭제';

      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const deleteIds = new Set(group.chapters.map((c) => c.id));
        try {
          await queueStateWrite(() => deleteCatalogItems([...deleteIds]));
        } catch (error) {
          toast(`서재 삭제 실패: ${error.message}`, { error: true });
          return;
        }

        card.remove();
        state.chapters = state.chapters.filter((c) => !deleteIds.has(c.id));
        saveRecentChapters(state.chapters);

        let offlineDeleteFailed = false;
        if (!animeTab) {
          for (const id of deleteIds) {
            try {
              await library.deleteChapter(id);
              state.saved.delete(id);
            } catch (error) {
              offlineDeleteFailed = true;
              console.warn(`[서재] ${id} 오프라인 파일 삭제 실패`, error);
            }
          }
        }
        renderLibraryBar();
        if (offlineDeleteFailed) {
          toast('목록은 삭제됐지만 일부 오프라인 파일을 지우지 못했습니다.', { error: true });
        }

        renderEpisodeList();
      });

      info.append(deleteBtn);
    }

    card.append(coverWrapper, info);

    elements.push(card);
  }

  if (elements.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'shelf-empty-notice';
    empty.textContent = animeTab
      ? '🎬 애니라이프 watch 주소를 불러오면 여기에 저장됩니다.'
      : '📚 저장된 만화가 없습니다.';
    elements.push(empty);
  }

  el.epList.className = 'ep-list ebook-shelf';
  el.epList.replaceChildren(...elements);
}

/** 마지막으로 읽던 화 카드. 읽던 화가 목록에 없으면 null */
function buildContinueCard(chapters) {
  const lastId = readLastChapterId();
  const last = chapters.find((chapter) => chapter.id === lastId && !isAnimeItem(chapter));
  if (!last) return null;

  const total = last.pages?.length || 0;
  const readTo = Math.min(readProgress()[last.id] || 1, Math.max(total, 1));
  const { seriesTitle, episodeLabel } = parseSeriesAndEpisode(last.title || '');

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'shelf-continue';

  const kicker = document.createElement('span');
  kicker.className = 'shelf-continue-kicker';
  kicker.textContent = '▶ 이어보기';

  const title = document.createElement('span');
  title.className = 'shelf-continue-title';
  title.textContent = seriesTitle;

  const meta = document.createElement('span');
  meta.className = 'shelf-continue-meta';
  meta.textContent = `${last.parsedEpisodeLabel || episodeLabel} · ${readTo} / ${total}쪽`;

  card.append(kicker, title, meta);
  card.addEventListener('click', () => {
    closeModal(el.modalEpisodes);
    if (state.currentId !== last.id) openChapter(last.id);
  });
  return card;
}

/** 선택한 시리즈의 회차 텍스트 목록 전용 뷰 렌더링 */
function renderSeriesChaptersView(group) {
  const container = document.createElement('div');
  container.className = 'shelf-episodes-view';

  const header = document.createElement('div');
  header.className = 'shelf-episodes-header';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'shelf-back-btn';
  backBtn.innerHTML = `← 책장으로`;
  backBtn.addEventListener('click', () => {
    renderEpisodeList();
  });

  const title = document.createElement('h3');
  title.style.margin = '0';
  title.style.fontSize = '15px';
  title.style.fontWeight = '700';
  title.textContent = `${group.seriesTitle} (${group.chapters.length}화)`;

  header.append(backBtn, title);

  const list = document.createElement('div');
  list.className = 'shelf-ep-list';

  for (const chapter of group.chapters) {
    const isCurrent = chapter.id === state.currentId;
    const anime = isAnimeItem(chapter);
    const readTo = readProgress()[chapter.id];
    const savedRow = state.saved.get(chapter.id);

    const item = document.createElement('div');
    item.className = `shelf-ep-item${isCurrent ? ' is-current' : ''}`;

    const info = document.createElement('div');
    const epTitle = document.createElement('span');
    epTitle.className = 'shelf-ep-title';
    epTitle.textContent = chapter.parsedEpisodeLabel || chapter.title || '회차';

    const epMeta = document.createElement('span');
    epMeta.className = 'shelf-ep-meta';
    epMeta.textContent = anime
      ? chapter.episodeTitle || '애니라이프에서 재생'
      : `${chapter.pages.length}장` + (readTo ? ` · ${readTo}쪽 읽음` : '') + (savedRow ? ` · 담김` : '');

    info.append(epTitle, epMeta);

    item.append(info);

    if (savedRow && !anime) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ep-del';
      delBtn.style.height = '100%';
      delBtn.style.padding = '0 12px';
      delBtn.style.borderRadius = 'var(--r-sm)';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await library.deleteChapter(chapter.id);
          await refreshSaved();
          renderEpisodeList(group.seriesTitle);
          toast('서재에서 지웠습니다.');
        } catch (error) {
          console.warn('[서재] 오프라인 파일 삭제 실패', error);
          toast(`오프라인 삭제 실패: ${error.message}`, { error: true });
        }
      });
      item.append(delBtn);
    }

    item.addEventListener('click', () => {
      openCatalogItem(chapter);
      closeModal(el.modalEpisodes);
    });

    list.appendChild(item);
  }

  container.append(header, list);

  /**
   * 사이트가 준 전 회차 목록.
   *
   * 여기가 없을 때는 "다음화"로만 진도를 낼 수 있었다 — 87화로 바로 가려면
   * 주소를 직접 붙여넣는 수밖에 없었다. 사이트가 목록을 안 주면(회차 링크가
   * 2개 이하) 이 구역은 아예 그리지 않는다. 없는 걸 있는 척하지 않는다.
   */
  const siteLinks = seriesEpisodeLinks.get(group.seriesTitle) || [];
  if (siteLinks.length > 0) {
    const loadedByUrl = new Map(
      group.chapters.filter((c) => c.sourceUrl).map((c) => [c.sourceUrl, c])
    );

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'shelf-ep-section';
    sectionTitle.textContent = `사이트 전체 회차 ${siteLinks.length}화 · 불러옴 ${loadedByUrl.size}`;

    const siteList = document.createElement('div');
    siteList.className = 'shelf-ep-list';

    for (const link of siteLinks) {
      const loaded = loadedByUrl.get(link.url);

      const row = document.createElement('div');
      row.className = `shelf-ep-item${loaded ? '' : ' is-remote'}`;

      const info = document.createElement('div');
      const rowTitle = document.createElement('span');
      rowTitle.className = 'shelf-ep-title';
      rowTitle.textContent = link.label;

      const rowMeta = document.createElement('span');
      rowMeta.className = 'shelf-ep-meta';
      rowMeta.textContent = loaded ? '불러옴' : '누르면 불러오기';

      info.append(rowTitle, rowMeta);
      row.append(info);

      row.addEventListener('click', async () => {
        closeModal(el.modalEpisodes);
        if (loaded) {
          openCatalogItem(loaded);
          return;
        }
        await loadEpisodeUrl(link.url);
      });

      siteList.appendChild(row);
    }

    container.append(sectionTitle, siteList);
  }

  el.epList.className = 'ep-list';
  el.epList.replaceChildren(container);
}

function buildEpisodeItem(chapter) {
  const isCurrent = chapter.id === state.currentId;
  const readTo = readProgress()[chapter.id];
  const savedRow = state.saved.get(chapter.id);

  const item = document.createElement('div');
  item.className = `ep-item${isCurrent ? ' is-current' : ''}`;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ep-open';

  const info = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'ep-title';
  title.textContent = chapter.title || '제목 없음';
  const meta = document.createElement('span');
  meta.className = 'ep-meta';
  meta.textContent =
    `${chapter.pages.length}장` +
    (readTo ? ` · ${readTo}쪽까지 읽음` : '') +
    (chapter.isDemo ? ' · 데모' : '');
  info.append(title, meta);

  const tags = document.createElement('span');
  tags.style.display = 'flex';
  tags.style.gap = '6px';
  tags.style.alignItems = 'center';
  tags.style.flex = 'none';

  // "담김" 딱지는 곧 "서버 없이 읽힘" 이라는 뜻이다 — 가장 중요한 정보라 크게 붙인다
  if (savedRow) {
    const badge = document.createElement('span');
    badge.className = 'ep-badge';
    badge.textContent = `담김 ${library.formatBytes(savedRow.bytes)}`;
    tags.append(badge);
  }
  if (isCurrent) {
    const stateTag = document.createElement('span');
    stateTag.className = 'ep-state';
    stateTag.textContent = '읽는 중';
    tags.append(stateTag);
  }

  open.append(info, tags);
  open.addEventListener('click', () => {
    openChapter(chapter.id);
    closeModal(el.modalEpisodes);
  });
  item.append(open);

  if (savedRow) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ep-del';
    del.title = '서재에서 지우기';
    del.setAttribute('aria-label', `${chapter.title || '이 화'} 서재에서 지우기`);
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      try {
        await library.deleteChapter(chapter.id);
        await refreshSaved();
        renderEpisodeList();
        toast('서재에서 지웠습니다.');
      } catch (error) {
        console.warn('[서재] 오프라인 파일 삭제 실패', error);
        toast(`오프라인 삭제 실패: ${error.message}`, { error: true });
      }
    });
    item.append(del);
  }

  return item;
}

/* ==================================================================== */
/* 세그먼트 컨트롤                                                       */
/* ==================================================================== */

function wireSegmented(group, attr, onPick) {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset[attr]) return;
    group.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    onPick(btn.dataset[attr]);
  });
}

function markSegmented(group, attr, value) {
  group.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset[attr] === value);
  });
}

/** 보기 모드를 auto 로 되돌리고 세그먼트 표시도 맞춘다 */
function resetModeToAuto() {
  if (state.settings.mode === 'auto') return;
  state.settings.mode = 'auto';
  markSegmented(el.modeGroup, 'mode', 'auto');
  if (engine) engine.setMode('auto');
}

function applyPaper(paper) {
  el.viewport.classList.remove('filter-sepia', 'filter-contrast', 'filter-night');
  if (paper && paper !== 'none') el.viewport.classList.add(`filter-${paper}`);
}

function applyBrightness(value) {
  el.viewport.style.filter = Number(value) === 100 ? '' : `brightness(${value}%)`;
  el.brightnessOut.textContent = `${value}%`;
}

/* ==================================================================== */
/* 불러오기                                                              */
/* ==================================================================== */

/**
 * 선별 진단을 사람이 읽을 한 덩어리로 만든다.
 * 예: "이미지 140개 중 0장 남음 — 크기미달 118, 이름걸림 22"
 */
function formatDiagnosis(diagnosis) {
  if (!diagnosis) return '';

  const summary = `\n\n이미지 ${diagnosis.total}개 중 ${diagnosis.kept}장 남음`;
  if (diagnosis.stages.length === 0) return summary;

  const breakdown = diagnosis.stages.map((s) => `${s.name} ${s.dropped}`).join(' · ');
  return `${summary}\n제외: ${breakdown}`;
}

/** 붙여넣은 게 "페이지 주소 하나"인지 "이미지 주소 목록"인지 스스로 판단한다 */
function looksLikeSinglePageUrl(text) {
  const lines = text.split(/\s+/).filter(Boolean);
  if (lines.length !== 1) return false;
  if (!/^https?:\/\//i.test(lines[0])) return false;
  // 확장자가 이미지면 그건 페이지가 아니라 이미지 한 장이다
  return !/\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i.test(lines[0]);
}

async function submitImport() {
  const raw = el.rawInput.value.trim();

  if (!raw) {
    toast('주소를 붙여넣어 주세요.', { error: true });
    return;
  }

  if (isAnilifeUrl(raw)) {
    try {
      setBusy(true, '애니 정보 불러오는 중…');
      const response = await fetchPageDocument(raw);
      if (!response.ok) throw new Error(`애니 페이지를 가져오지 못했습니다 (${response.status}).`);
      const parsed = parseAnilifePage(await response.text(), raw);
      if (!parsed) throw new Error('올바른 애니라이프 watch 주소가 아닙니다.');

      const item = catalogItem({
        id: `anime-${parsed.id}`,
        kind: 'anime',
        type: 'anime',
        title: `${parsed.seriesTitle} ${parsed.episodeNumber}화`,
        label: `${parsed.episodeNumber}화`,
        episodeNumber: parsed.episodeNumber,
        episodeTitle: parsed.episodeTitle,
        coverUrl: parsed.posterUrl || null,
        sourceUrl: raw,
        pages: [],
      }, true);
      const previousChapters = state.chapters;
      state.chapters = [item, ...state.chapters.filter((chapter) => chapter.id !== item.id)];
      try {
        await persistCatalogItem(item);
      } catch (error) {
        state.chapters = previousChapters;
        throw error;
      }
      saveRecentChapters(state.chapters);
      state.currentShelfTab = 'anime';
      el.rawInput.value = '';
      closeModal(el.modalImport);
      renderEpisodeList();
      openModal(el.modalEpisodes);
      toast(`${item.title} 저장됨. 회차를 누르면 재생됩니다.`);
    } catch (error) {
      toast(error.message, { error: true, duration: 10000 });
    } finally {
      setBusy(false);
    }
    return;
  }

  // 페이지 주소 하나 → 서버가 HTML 받아 컷을 찾아온다 (북마클릿 불필요)
  if (looksLikeSinglePageUrl(raw)) {
    try {
      setBusy(true, '페이지에서 만화 찾는 중…');
      const harvested = await UrlHarvester.fetchFromUrl(raw);
      await addChapter(harvested, 'import');
      el.rawInput.value = '';
      closeModal(el.modalImport);
      toast(`${harvested.pages.length}장 불러왔습니다.`);
    } catch (err) {
      // 진단이 실려 왔으면 어느 필터가 걸렀는지 같이 보여준다.
      // 이게 있으면 사이트가 안 잡힐 때 개발자도구를 열 필요가 없다.
      toast(err.message + formatDiagnosis(err.diagnosis), { error: true, duration: 20000 });
      if (err.diagnosis) console.table?.(err.diagnosis.stages);
    } finally {
      setBusy(false);
    }
    return;
  }

  // 그 밖에는 이미지 주소 목록으로 본다
  const pages = UrlHarvester.parseRawText(raw);
  if (pages.length === 0) {
    toast('붙여넣은 내용에서 이미지 주소를 찾지 못했습니다.', { error: true });
    return;
  }

  try {
    await addChapter({ title: '붙여넣은 만화', targetUrl: null, pages }, 'paste');
    el.rawInput.value = '';
    closeModal(el.modalImport);
    toast(`${pages.length}장 불러왔습니다.`);
  } catch (error) {
    toast(`저장 실패: ${error.message}`, { error: true });
  }
}

async function handleFiles(files) {
  if (!files || files.length === 0) return;

  try {
    setBusy(true, '파일 읽는 중…');

    const isArchive = files.length === 1 && /\.(zip|cbz)$/i.test(files[0].name);
    const result = isArchive
      ? await UrlHarvester.loadZipOrCbzFile(files[0])
      : await UrlHarvester.loadMultipleImageFiles(files);

    await addChapter(result, 'local');
    closeModal(el.modalFiles);
    toast(`${result.pages.length}장 불러왔습니다.`);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    setBusy(false);
    el.fileInput.value = '';
  }
}

/** 북마클릿이 서버에 올려둔 수집 결과를 받아온다 */
async function consumePendingImport() {
  const fromHash = UrlHarvester.parseImportHash(window.location.hash);
  if (!fromHash) return false;

  // 해시는 한 번만 쓰고 지운다 (새로고침 때 다시 불러오지 않도록)
  history.replaceState(null, '', window.location.pathname + window.location.search);

  try {
    setBusy(true, '수집한 만화 받는 중…');

    const harvested = fromHash === 'latest' ? await UrlHarvester.fetchPendingImport() : fromHash;

    if (!harvested) {
      toast('넘어온 이미지를 찾지 못했습니다. 북마클릿을 다시 눌러주세요.', { error: true });
      return false;
    }

    await addChapter(harvested, 'import');
    toast(`${harvested.pages.length}장 불러왔습니다.`);
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  } finally {
    setBusy(false);
  }
}

/* ==================================================================== */
/* 이벤트                                                                */
/* ==================================================================== */

function showTouchPulse(e) {
  if (!e || !e.clientX) return;
  const pulse = document.createElement('div');
  pulse.className = 'touch-pulse';
  pulse.style.left = `${e.clientX}px`;
  pulse.style.top = `${e.clientY}px`;
  document.body.appendChild(pulse);
  setTimeout(() => pulse.remove(), 400);
}

let autoNextTimer = null;

function showAutoNextCard() {
  if (!canGoAdjacent(1)) return;
  const existing = document.querySelector('.auto-next-card');
  if (existing) return;

  const nextCh = findRealNeighbor(state.chapters, state.currentId, 1);
  const nextLabel = nextCh ? nextCh.label : '다음 화';

  const card = document.createElement('div');
  card.className = 'auto-next-card';

  let countdown = 3;
  card.innerHTML = `
    <div class="card-text"><b>${nextLabel}</b>로 이동합니다 (<span id="auto-next-sec">${countdown}</span>초)</div>
    <div class="card-btns">
      <button type="button" class="btn-card btn-confirm" id="btn-auto-now">지금 이동</button>
      <button type="button" class="btn-card btn-cancel" id="btn-auto-cancel">취소</button>
    </div>
  `;
  document.body.appendChild(card);

  const secSpan = card.querySelector('#auto-next-sec');

  autoNextTimer = setInterval(() => {
    countdown--;
    if (secSpan) secSpan.textContent = String(countdown);
    if (countdown <= 0) {
      clearInterval(autoNextTimer);
      card.remove();
      goChapter(1);
    }
  }, 1000);

  card.querySelector('#btn-auto-now').addEventListener('click', () => {
    clearInterval(autoNextTimer);
    card.remove();
    goChapter(1);
  });

  card.querySelector('#btn-auto-cancel').addEventListener('click', () => {
    clearInterval(autoNextTimer);
    card.remove();
  });
}

function wireEvents() {
  /* 터치 영역 — 읽기 방향에 따라 좌우 의미가 뒤바뀐다 */
  el.tapLeft.addEventListener('click', (e) => {
    showTouchPulse(e);
    state.settings.direction === 'RTL' ? engine.nextPage() : engine.prevPage();
  });
  el.tapRight.addEventListener('click', (e) => {
    showTouchPulse(e);
    state.settings.direction === 'RTL' ? engine.prevPage() : engine.nextPage();
  });
  el.tapCenter.addEventListener('click', (e) => {
    showTouchPulse(e);
    toggleChrome();
  });
  el.viewport.addEventListener('click', (e) => {
    if (!el.viewport.classList.contains('mode-strip') || e.target.closest?.('button, a')) return;
    const bounds = el.viewport.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    if (x < bounds.width * 0.26 || x > bounds.width * 0.74) return;
    showTouchPulse(e);
    toggleChrome();
  });

  /* 페이지 · 화 이동 */
  el.btnPrevPage.addEventListener('click', () => engine.prevPage());
  el.btnNextPage.addEventListener('click', () => engine.nextPage());
  el.btnPrevEp.addEventListener('click', () => goChapter(-1));
  el.btnNextEp.addEventListener('click', () => goChapter(1));

  /* 슬라이더 미리보기 툴팁 */
  let sliderPreviewOwnedUrl = null;
  let sliderPreviewRequest = 0;
  const clearSliderPreview = () => {
    sliderPreviewRequest++;
    if (sliderPreviewOwnedUrl) URL.revokeObjectURL(sliderPreviewOwnedUrl);
    sliderPreviewOwnedUrl = null;
    el.sliderPreviewImg.removeAttribute('src');
    el.sliderPreview.classList.remove('show');
  };
  const updateSliderPreview = async (val) => {
    const request = ++sliderPreviewRequest;
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (request !== sliderPreviewRequest) return;
    const pageNum = parseInt(val, 10);
    if (!engine || pageNum < 1) return;
    const page = engine.getPageForCurrentChapter(pageNum);
    if (page && page.url && el.sliderPreviewImg) {
      let resolved;
      try {
        resolved = await resolvePageImageUrl(page);
      } catch {
        return;
      }
      if (request !== sliderPreviewRequest) {
        if (resolved.owned) URL.revokeObjectURL(resolved.url);
        return;
      }
      if (sliderPreviewOwnedUrl) URL.revokeObjectURL(sliderPreviewOwnedUrl);
      sliderPreviewOwnedUrl = resolved.owned ? resolved.url : null;
      el.sliderPreviewImg.src = resolved.url;
      el.sliderPreviewNum.textContent = `${pageNum}p`;
      el.sliderPreview.classList.add('show');
    }
  };

  el.slider.addEventListener('input', (e) => {
    updateSliderPreview(e.target.value);
    engine.goToPage(parseInt(e.target.value, 10));
    showChrome(false);
  });

  ['pointerdown', 'touchstart'].forEach((evt) => {
    el.slider.addEventListener(evt, () => updateSliderPreview(el.slider.value));
  });

  ['pointerup', 'touchend', 'change'].forEach((evt) => {
    el.slider.addEventListener(evt, () => {
      clearSliderPreview();
      showChrome();
    });
  });

  el.btnAutoplay.addEventListener('click', toggleBingeMode);

  el.btnZoomReset.addEventListener('click', () => engine.resetZoom());

  el.btnFullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast('이 브라우저에서는 전체화면을 쓸 수 없습니다.');
    }
  });

  /* 모달 열기 */
  el.btnEpList.addEventListener('click', () => {
    renderEpisodeList();
    openModal(el.modalEpisodes);
  });
  el.btnImport.addEventListener('click', () => openModal(el.modalImport));
  el.btnReload.addEventListener('click', () => reloadCurrentChapter());
  el.btnFiles.addEventListener('click', () => openModal(el.modalFiles));
  el.btnDisplay.addEventListener('click', () => openModal(el.modalDisplay));
  el.btnSettings.addEventListener('click', () => openModal(el.modalSettings));

  /* 모달 닫기 */
  document.querySelectorAll('.close-modal').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) closeModal(modal);
    });
  });
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  /* 빈 상태에서 바로 시작 */
  document.getElementById('empty-files').addEventListener('click', () => openModal(el.modalFiles));
  document.getElementById('empty-import').addEventListener('click', () => openModal(el.modalImport));

  /* 서재에 담기 & 링크 정리 */
  el.btnSave1.addEventListener('click', () => batchSave(1));
  el.btnSave10.addEventListener('click', () => batchSave(10));

  el.btnManageLinks.addEventListener('click', () => {
    closeModal(el.modalEpisodes);
    openModal(el.modalLinkManage);
  });

  el.btnApplyLinkFix.addEventListener('click', async () => {
    const oldDomain = el.oldDomainInput.value.trim();
    const newDomain = el.newDomainInput.value.trim();

    if (!oldDomain || !newDomain) {
      toast('기존 도메인과 새 도메인을 모두 입력해 주세요.', { error: true });
      return;
    }

    const previous = state.chapters;
    state.chapters = updateChapterDomain(state.chapters, oldDomain, newDomain);
    try {
      await persistCatalogItems(state.chapters);
      saveRecentChapters(state.chapters);
      toast('주소를 성공적으로 일괄 업데이트하였습니다.');
      closeModal(el.modalLinkManage);
      renderEpisodeList();
    } catch (error) {
      state.chapters = previous;
      toast(`주소 저장 실패: ${error.message}`, { error: true });
    }
  });

  /* 불러오기 */
  el.btnSubmitUrl.addEventListener('click', submitImport);

  el.btnCopyBookmarklet.addEventListener('click', async () => {
    const code = el.bookmarkletUrl.value;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // 클립보드 권한이 없으면 선택 상태로 만들어 직접 복사하게 한다
      el.bookmarkletUrl.select();
    }
    const label = el.btnCopyBookmarklet.querySelector('span');
    const icon = el.btnCopyBookmarklet.querySelector('use');
    label.textContent = '복사됨';
    icon.setAttribute('href', '#i-check');
    el.btnCopyBookmarklet.classList.add('is-done');
    setTimeout(() => {
      label.textContent = '주소 복사';
      icon.setAttribute('href', '#i-copy');
      el.btnCopyBookmarklet.classList.remove('is-done');
    }, 1800);
  });

  /* 파일 */
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  ['dragenter', 'dragover'].forEach((evt) =>
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.add('is-dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((evt) =>
    el.dropZone.addEventListener(evt, () => el.dropZone.classList.remove('is-dragover'))
  );
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('is-dragover');
    handleFiles(e.dataTransfer.files);
  });

  /* 화면 · 설정 */
  wireSegmented(el.modeGroup, 'mode', (mode) => {
    state.settings.mode = mode;
    saveSettings();
    engine.setMode(mode);
    if (bingeEnabled && !el.viewport.classList.contains('mode-strip')) {
      bingeEnabled = false;
      bingeGeneration++;
      bingePromise = null;
      bingeTailId = null;
      updateBingeButton();
      toast('정주행은 세로 스크롤에서만 유지됩니다.');
    }
  });

  wireSegmented(el.paperGroup, 'paper', (paper) => {
    state.settings.paper = paper;
    saveSettings();
    applyPaper(paper);
  });

  wireSegmented(el.dirGroup, 'dir', (dir) => {
    state.settings.direction = dir;
    saveSettings();
    engine.setDirection(dir);
  });

  el.brightness.addEventListener('input', (e) => {
    state.settings.brightness = Number(e.target.value);
    applyBrightness(e.target.value);
  });
  el.brightness.addEventListener('change', saveSettings);

  el.transition.addEventListener('change', (e) => {
    state.settings.transition = e.target.value;
    saveSettings();
    engine.setTransitionType(e.target.value);
  });

  // 통신사 차단 회선에서 Worker 중계로 받아올 때 쓰는 토큰. 값은 기기에만 남는다.
  el.proxyToken.addEventListener('change', (e) => {
    const token = e.target.value.trim();
    try {
      if (token) localStorage.setItem('mv:proxyToken', token);
      else localStorage.removeItem('mv:proxyToken');
      toast(token ? '중계 서버 토큰을 저장했습니다.' : '중계 서버 토큰을 지웠습니다.');
    } catch {
      toast('토큰을 저장하지 못했습니다.', { error: true });
    }
  });

  /* 키보드 및 태블릿 물리 볼륨버튼 */
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;

    if (e.key === 'Escape') {
      closeAllModals();
      return;
    }
    if (document.querySelector('.modal.is-open')) return;

    const rtl = state.settings.direction === 'RTL';

    if (e.key === 'VolumeDown' || e.key === 'PageDown') {
      e.preventDefault();
      engine.nextPage();
    } else if (e.key === 'VolumeUp' || e.key === 'PageUp') {
      e.preventDefault();
      engine.prevPage();
    } else if (e.key === 'ArrowLeft') {
      rtl ? engine.nextPage() : engine.prevPage();
    } else if (e.key === 'ArrowRight') {
      rtl ? engine.prevPage() : engine.nextPage();
    } else if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      engine.nextPage();
    } else if (e.key === 'ArrowUp') {
      engine.prevPage();
    } else if (e.key.toLowerCase() === 'f') {
      el.btnFullscreen.click();
    } else if (e.key.toLowerCase() === 'm') {
      toggleChrome();
    } else {
      return;
    }

    showChrome();
  });

  /* 앱 백그라운드 전환 및 강제 종료 시 영구 저장 확정 */
  const syncStateOnLeave = () => {
    const info = engine?.getPageInfo();
    if (info?.chapterId) {
      saveLastChapterId(info.chapterId);
      saveProgress(info.chapterId, info.currentPageNum);
    }
    saveRecentChapters(state.chapters);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncStateOnLeave();
  });
  window.addEventListener('pagehide', syncStateOnLeave);
  window.addEventListener('beforeunload', syncStateOnLeave);
}

/* ==================================================================== */
/* 시작                                                                  */
/* ==================================================================== */

function applySettingsToUI() {
  markSegmented(el.modeGroup, 'mode', state.settings.mode);
  markSegmented(el.paperGroup, 'paper', state.settings.paper);
  markSegmented(el.dirGroup, 'dir', state.settings.direction);

  el.transition.value = state.settings.transition;
  el.brightness.value = String(state.settings.brightness);
  try {
    el.proxyToken.value = localStorage.getItem('mv:proxyToken') || '';
  } catch {
    /* 저장소가 막힌 환경이면 빈 칸으로 둔다 */
  }

  applyPaper(state.settings.paper);
  applyBrightness(state.settings.brightness);

  // 북마크바로 끌어다 놓는 앵커와, 안 될 때 쓰는 복사용 입력칸 둘 다 채운다
  const bookmarklet = buildBookmarklet(window.location.origin);
  el.bookmarkletUrl.value = bookmarklet;

  const dragChip = document.getElementById('bookmarklet-drag');
  dragChip.setAttribute('href', bookmarklet);
  // 딱지를 그냥 클릭하면 지금 보고 있는 뷰어에서 수집이 돌아버린다 — 끌어다 놓으라고 알려준다
  dragChip.addEventListener('click', (e) => {
    e.preventDefault();
    toast('클릭이 아니라 북마크바로 끌어다 놓으세요 (⌘⇧B 로 북마크바 표시).', { duration: 5000 });
  });
}

/**
 * 주소에 붙어 온 토큰을 쿠키로 바꿔 넣고 주소에서 지운다.
 *
 * Cloudflare 에 올리면 이 주소는 인터넷에 공개된다. 인증이 없으면 누구나 쓰는
 * 오픈 프록시가 되므로 토큰을 받는다. 처음 한 번 `?t=...` 가 붙은 주소로 열면
 * 그 뒤로는 쿠키가 알아서 붙는다 — 홈 화면에 추가한 뒤엔 신경 쓸 일이 없다.
 *
 * 왜 쿠키인가: `<img src>` 는 헤더를 붙일 수 없다. 토큰을 이미지 주소에 넣으면
 * **그 주소가 서재의 키**라서, 토큰을 바꾸는 순간 담아둔 화를 못 찾게 된다.
 * 쿠키는 주소를 건드리지 않으므로 키가 그대로 유지된다.
 */
async function consumeAuthToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('t');
  if (!token) return;

  // 주소에서 즉시 지운다 (새로고침·공유로 토큰이 남아 돌지 않게)
  params.delete('t');
  const query = params.toString();
  history.replaceState(
    null,
    '',
    window.location.pathname + (query ? `?${query}` : '') + window.location.hash
  );

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    // 로컬 Node 서버에는 이 라우트가 없다(404) — 인증이 필요 없으니 조용히 넘어간다
    if (res.status === 401) toast('토큰이 맞지 않습니다.', { error: true, duration: 8000 });
  } catch {
    /* 오프라인으로 열었으면 인증할 것도 없다 */
  }
}

/**
 * 서비스워커를 등록해 앱 껍데기를 오프라인에서도 열리게 한다.
 *
 * secure context 전용이라 `http://<LAN IP>:5173` 에서는 등록 자체가 안 된다.
 * 치명적이지 않다 — 서재(IndexedDB)는 그대로 돌고 껍데기만 서버가 필요해진다.
 * 조용히 실패하면 나중에 "왜 오프라인이 안 되지"로 헤매므로 이유를 남긴다.
 */
async function registerServiceWorker() {
  // APK는 번들·OTA 플러그인이 오프라인 껍데기를 관리한다. 서비스워커까지 겹치면
  // 새 OTA 위에 예전 JS/CSS 캐시가 올라오는 두 번째 버전 관리자가 생긴다.
  if (isNativeApp()) return;
  if (!('serviceWorker' in navigator)) return;

  if (!window.isSecureContext) {
    console.info(
      '[만화 뷰어] 오프라인 앱 껍데기는 https 또는 localhost 에서만 됩니다 ' +
        `(지금: ${location.origin}). 담아둔 화는 그대로 읽힙니다.`
    );
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    reg.update().catch(() => {});
  } catch (err) {
    console.warn('[만화 뷰어] 서비스워커 등록 실패', err);
  }
}

async function loadCatalogIntoList() {
  const savedRows = await library.listChapters();
  state.saved = new Map(savedRows.map((row) => [row.id, row]));

  if (await getKv('migration.v1') !== 'complete') {
    const [existing, recentDbList] = await Promise.all([
      listCatalogItems(),
      library.readRecentChaptersFromDb(),
    ]);
    const merged = mergeLegacyCatalog(
      existing,
      savedRows,
      recentDbList,
      readRecentChaptersForMigration()
    ).map((item) => catalogItem(item));
    await writeMigrationV1(merged);
  }

  state.chapters = (await listCatalogItems()).filter(
    (item) => item?.id && Array.isArray(item.pages) && !item.isDemo
  );
}

function showStorageFailure(error) {
  console.error('[저장소] 카탈로그를 복구하지 못했습니다', error);
  document.getElementById('app').classList.add('is-empty');
  const title = document.querySelector('#empty-state h2');
  const hint = document.querySelector('#empty-state .hint');
  if (title) title.textContent = '저장소를 읽지 못했습니다';
  if (hint) hint.textContent = '앱을 업데이트하거나 데이터를 지우지 말고 다시 실행해 주세요.';
  document.querySelectorAll('#empty-state button').forEach((button) => {
    button.disabled = true;
  });
}

async function boot() {
  // 데이터와 무관하게 즉시 시작한다. 적용은 ready + 저장 flush 성공 뒤에만 한다.
  const ready = confirmBundleReady();

  try {
    await bootApp();
  } catch (err) {
    showStorageFailure(err);
    await ready.catch((readyError) => console.warn('[OTA] ready 신고 실패', readyError));
    return;
  }

  try {
    await ready;
    await flushStateWrites();
    await finishStartupAndApplyUpdate({ beforeReload: flushStateWrites });
  } catch (err) {
    console.warn('[OTA] 업데이트 적용 중단', err);
  }
}

async function bootApp() {
  await restoreStateFromKv(state);
  await loadCatalogIntoList();

  initEngine();
  applySettingsToUI();
  wireEvents();

  try {
    await consumeAuthToken();
  } catch (err) {
    console.warn('[부팅] consumeAuthToken 실패:', err);
  }

  library.requestPersistence().catch(() => {});
  registerServiceWorker();

  window.addEventListener('hashchange', () => {
    if (/[#&]import=/.test(window.location.hash)) consumePendingImport();
  });

  const imported = await consumePendingImport().catch(() => null);

  if (!imported && !state.initialized && state.chapters.length === 0) {
    const onepiece = SAMPLE_MANGA_SERIES.episodes.find((e) => e.id === 'sample-onepiece-909');
    if (onepiece) {
      state.chapters = [onepiece];
      await putCatalogItem(catalogItem(onepiece, true));
      saveRecentChapters(state.chapters);
    }
  }
  state.initialized = true;
  saveInitialized(true);

  const lastId = readLastChapterId();
  const readableChapters = state.chapters.filter((chapter) => !isAnimeItem(chapter));
  const targetChapter =
    readableChapters.find((c) => c.id === lastId) ||
    readableChapters.find((c) => state.saved.has(c.id)) ||
    readableChapters[0];

  if (targetChapter) {
    try {
      await openChapter(targetChapter.id);
    } catch (e) {
      console.warn('openChapter 초기 실행 오류:', e);
    }
  } else {
    showEmptyState();
  }

  if (state.chapters.length > 0) {
    renderEpisodeList();
    openModal(el.modalEpisodes);
  }

  showChrome();

  const updateVersionTags = (bundleId = '') => {
    const otaText = bundleId ? ` [${bundleId.replace(/^web-/, '').slice(0, 8)}]` : '';
    const label = `${APP_VERSION}${otaText}`;
    ['ota-tag', 'ep-modal-ota-tag', 'empty-ota-tag'].forEach((id) => {
      const tagEl = document.getElementById(id);
      if (tagEl) tagEl.textContent = label;
    });
  };

  updateVersionTags();

  try {
    const bundleId = await getCurrentBundleId();
    updateVersionTags(bundleId);
  } catch {
    /* 무시 */
  }
}

boot();
