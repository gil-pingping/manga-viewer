import { UrlHarvester } from './src/urlHarvester.js';
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
import * as library from './src/library.js';
import { isNativeApp, resolvePageImageUrl } from './src/platform/nativeHttp.js';
import { finishStartupAndApplyUpdate } from './src/platform/liveUpdate.js';
import {
  createInitialState,
  saveSettings as persistSettings,
  saveProgress as persistProgress,
  readProgress,
  saveLastChapterId,
  readLastChapterId,
  saveRecentChapters,
  readRecentChapters,
  CHROME_IDLE_MS,
} from './src/state.js';

/* ==================================================================== */
/* 상태                                                                  */
/* ==================================================================== */

const state = createInitialState();

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

  epList: $('episode-list'),
  libUsage: $('lib-usage'),
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
  speed: $('setting-speed'),
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
  engine.loadChapter(forEngine, startAt);
  prefetchNextChapter(chapter);
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
    .then((harvested) => {
      if (harvested && harvested.pages?.length > 0) {
        const { chapters } = upsertChapter(
          state.chapters,
          harvested,
          `prefetch-${Date.now()}`
        );
        state.chapters = chapters;
        saveRecentChapters(state.chapters);

        // 2화 연속 사전 수집: 다음 화의 다음 화도 백그라운드로 수집
        if (harvested.nextUrl) {
          UrlHarvester.fetchFromUrl(harvested.nextUrl, { silentRenderedFallback: true })
            .then((h2) => {
              if (h2 && h2.pages?.length > 0) {
                const res = upsertChapter(state.chapters, h2, `prefetch2-${Date.now()}`);
                state.chapters = res.chapters;
                saveRecentChapters(state.chapters);
              }
            })
            .catch(() => {});
        }
      }
      return harvested;
    })
    .catch((err) => {
      console.debug('[다음 화 미리 받기] 클릭할 때 다시 시도합니다.', err.message);
      return null;
    });
  nextChapterPrefetch = { sourceId: chapter.id, url: chapter.nextUrl, promise };
}

/**
 * 새로 수집한 챕터를 목록 맨 앞에 넣고 바로 연다.
 * 같은 출처를 다시 불러오면 새로 만들지 않고 갱신한다.
 */
function addChapter(harvested, idPrefix) {
  const { chapters, chapter } = upsertChapter(
    state.chapters,
    harvested,
    `${idPrefix}-${Date.now()}`
  );
  state.chapters = chapters;
  saveRecentChapters(chapters);

  // 새로 불러온 콘텐츠는 항상 auto 로 본다. 앞 챕터에서 고른 모드를 물려받으면
  // 웹툰이 페이지 넘김으로 뜨는 식으로 깨진다.
  resetModeToAuto();

  openChapter(chapter.id, 1);
  return chapter;
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
  const move = resolveAdjacent(state.chapters, state.currentId, delta);

  if (move.kind === 'open') {
    openChapter(move.chapter.id);
    return;
  }

  if (move.kind === 'none') {
    toast(delta > 0 ? '다음 화가 없습니다.' : '이전 화가 없습니다.');
    return;
  }

  // kind === 'fetch' — 사이트가 준 인접 화 주소를 서버가 받아온다
  try {
    setBusy(true, delta > 0 ? '다음 화 불러오는 중…' : '이전 화 불러오는 중…');
    const prepared = findAdjacentPrefetch(nextChapterPrefetch, state.currentId, delta, move.url);
    const harvested = (prepared && await prepared) || await UrlHarvester.fetchFromUrl(move.url);
    addChapter(harvested, 'import');
    toast(`${harvested.pages.length}장 불러왔습니다.`);
  } catch (err) {
    toast(err.message + formatDiagnosis(err.diagnosis), { error: true, duration: 20000 });
  } finally {
    setBusy(false);
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
    error: done === 0,
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
    autoPlaySpeed: state.settings.speed,
    resolvePageUrl: resolvePageImageUrl,

    onPageChange: (info) => {
      el.slider.max = String(Math.max(1, info.totalPages));
      el.slider.value = String(info.currentPageNum);
      el.indicator.textContent = `${info.currentPageNum} / ${info.totalPages}`;
      saveProgress(state.currentId, info.currentPageNum);

      el.btnAutoplay.classList.toggle('is-active', info.isAutoPlaying);
      el.autoplayLabel.textContent = info.isAutoPlaying ? '멈춤' : '정주행';
      el.btnAutoplay
        .querySelector('use')
        .setAttribute('href', info.isAutoPlaying ? '#i-pause' : '#i-play');
    },

    onZoomChange: (zoomed) => {
      el.btnZoomReset.classList.toggle('is-hidden', !zoomed);
    },

    onEpisodeEnd: () => {
      const next = state.chapters[currentIndex() + 1];
      const canAutoAdvance = (next && !next.isDemo) || currentChapter()?.nextUrl;

      if (canAutoAdvance) {
        showAutoNextCard();
      } else {
        toast('마지막 페이지입니다.');
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

  const savable = canSave(currentChapter());
  el.btnSave1.disabled = !savable;
  el.btnSave10.disabled = !savable;
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

function renderEpisodeList() {
  renderLibraryBar();

  // 시리즈 키로 챕터 그룹화
  const groups = new Map(); // key → { name, chapters[] }
  const groupOrder = [];    // 순서 보존

  for (const chapter of state.chapters) {
    let key;
    let seriesName;

    if (chapter.isDemo) {
      key = '__demo__';
      seriesName = '데모';
    } else {
      const urlKey = seriesKeyFromUrl(chapter.sourceUrl);
      if (urlKey) {
        key = urlKey;
        seriesName = seriesNameFromTitle(chapter.title);
      } else {
        // sourceUrl이 없는 경우 (파일, 붙여넣기) — 제목 기반 그룹화
        key = `__local__${seriesNameFromTitle(chapter.title)}`;
        seriesName = seriesNameFromTitle(chapter.title);
      }
    }

    if (!groups.has(key)) {
      const group = { name: seriesName, chapters: [] };
      groups.set(key, group);
      groupOrder.push(key);
    }
    groups.get(key).chapters.push(chapter);
  }

  const elements = [];

  for (const key of groupOrder) {
    const group = groups.get(key);
    const isSingleItem = group.chapters.length === 1;

    // 1화짜리 그룹은 그룹 감싸기 없이 바로 표시
    if (isSingleItem) {
      elements.push(buildEpisodeItem(group.chapters[0]));
      continue;
    }

    // 여러 화 묶음: 접기/펼치기 그룹
    const wrapper = document.createElement('div');
    wrapper.className = 'ep-group';

    // 현재 읽고 있는 화가 이 그룹에 있으면 펼쳐둔다
    const hasCurrentChapter = group.chapters.some((c) => c.id === state.currentId);
    if (!hasCurrentChapter) wrapper.classList.add('is-collapsed');

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'ep-group-header';
    header.innerHTML = `
      <span class="group-title">${group.name}</span>
      <span class="group-count">${group.chapters.length}화</span>
      <svg class="group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    `;
    header.addEventListener('click', () => {
      wrapper.classList.toggle('is-collapsed');
    });

    const body = document.createElement('div');
    body.className = 'ep-group-body';
    for (const chapter of group.chapters) {
      body.appendChild(buildEpisodeItem(chapter));
    }

    wrapper.append(header, body);
    elements.push(wrapper);
  }

  el.epList.replaceChildren(...elements);
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
      await library.deleteChapter(chapter.id);
      await refreshSaved();
      renderEpisodeList();
      toast('서재에서 지웠습니다.');
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

  // 페이지 주소 하나 → 서버가 HTML 받아 컷을 찾아온다 (북마클릿 불필요)
  if (looksLikeSinglePageUrl(raw)) {
    try {
      setBusy(true, '페이지에서 만화 찾는 중…');
      const harvested = await UrlHarvester.fetchFromUrl(raw);
      addChapter(harvested, 'import');
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

  addChapter({ title: '붙여넣은 만화', targetUrl: null, pages }, 'paste');
  el.rawInput.value = '';
  closeModal(el.modalImport);
  toast(`${pages.length}장 불러왔습니다.`);
}

async function handleFiles(files) {
  if (!files || files.length === 0) return;

  try {
    setBusy(true, '파일 읽는 중…');

    const isArchive = files.length === 1 && /\.(zip|cbz)$/i.test(files[0].name);
    const result = isArchive
      ? await UrlHarvester.loadZipOrCbzFile(files[0])
      : await UrlHarvester.loadMultipleImageFiles(files);

    addChapter(result, 'local');
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

    addChapter(harvested, 'import');
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

  /* 페이지 · 화 이동 */
  el.btnPrevPage.addEventListener('click', () => engine.prevPage());
  el.btnNextPage.addEventListener('click', () => engine.nextPage());
  el.btnPrevEp.addEventListener('click', () => goChapter(-1));
  el.btnNextEp.addEventListener('click', () => goChapter(1));

  /* 슬라이더 미리보기 툴팁 */
  const updateSliderPreview = (val) => {
    const pageNum = parseInt(val, 10);
    if (!engine || !engine.pages || pageNum < 1 || pageNum > engine.pages.length) return;
    const page = engine.pages[pageNum - 1];
    if (page && page.url && el.sliderPreviewImg) {
      el.sliderPreviewImg.src = resolvePageImageUrl(page);
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
      el.sliderPreview.classList.remove('show');
      showChrome();
    });
  });

  el.btnAutoplay.addEventListener('click', () => {
    const playing = engine.toggleAutoPlay();
    toast(playing ? '정주행 시작' : '정주행 멈춤');
  });

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
  document.getElementById('empty-demo').addEventListener('click', () => {
    openChapter(state.chapters[0].id, 1);
    toast('데모 페이지입니다. 실제 만화는 위 버튼으로 불러오세요.', { duration: 4000 });
  });

  /* 서재에 담기 */
  el.btnSave1.addEventListener('click', () => batchSave(1));
  el.btnSave10.addEventListener('click', () => batchSave(10));

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

  el.speed.addEventListener('change', (e) => {
    const seconds = Math.min(60, Math.max(1, parseInt(e.target.value, 10) || 5));
    e.target.value = String(seconds);
    state.settings.speed = seconds;
    saveSettings();
    engine.setAutoPlaySpeed(seconds);
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
}

/* ==================================================================== */
/* 시작                                                                  */
/* ==================================================================== */

function applySettingsToUI() {
  markSegmented(el.modeGroup, 'mode', state.settings.mode);
  markSegmented(el.paperGroup, 'paper', state.settings.paper);
  markSegmented(el.dirGroup, 'dir', state.settings.direction);

  el.transition.value = state.settings.transition;
  el.speed.value = String(state.settings.speed);
  el.brightness.value = String(state.settings.brightness);

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
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('[만화 뷰어] 서비스워커 등록 실패', err);
  }
}

async function loadLibraryIntoList() {
  await refreshSaved();

  const restoredSaved = [...state.saved.values()].map((row) => ({
    id: row.id,
    title: row.title,
    label: row.label || '담아둔 화',
    pages: row.pages,
    sourceUrl: row.sourceUrl,
    prevUrl: row.prevUrl,
    nextUrl: row.nextUrl,
  }));

  const recentList = readRecentChapters();

  // 복원된 챕터를 목록에 병합 (id와 sourceUrl 보존)
  for (const item of [...restoredSaved, ...recentList]) {
    if (!item?.pages || item.pages.length === 0) continue;

    // upsertChapter는 harvested.targetUrl로 기존 챕터를 찾으므로
    // sourceUrl을 targetUrl로도 설정해줘야 중복 방지가 작동한다
    item.targetUrl = item.sourceUrl;

    // 이미 같은 id가 목록에 있으면 건너뛴다 (데모와 겹치지 않는 한)
    const alreadyExists = state.chapters.some((c) => c.id === item.id && !c.isDemo);
    if (alreadyExists) continue;

    const { chapters } = upsertChapter(state.chapters, item, item.id);
    state.chapters = chapters;
  }
}

async function boot() {
  initEngine();
  applySettingsToUI();
  wireEvents();

  // 인증이 제일 먼저다. 서재 복원이나 수집이 먼저 돌면 401 을 맞는다
  await consumeAuthToken();

  // 브라우저가 공간이 부족할 때 서재를 조용히 비우지 않도록 미리 부탁한다
  library.requestPersistence().catch(() => {});
  registerServiceWorker();
  await loadLibraryIntoList();

  // 뷰어 탭이 이미 열려 있는 상태로 #import= 만 바뀌면 스크립트가 다시 돌지 않는다.
  // (같은 문서 내 프래그먼트 이동) 그래서 hashchange 로도 한 번 더 받는다.
  window.addEventListener('hashchange', () => {
    if (/[#&]import=/.test(window.location.hash)) consumePendingImport();
  });

  // 북마클릿으로 넘어온 게 있으면 그것을 열고, 없으면 마지막으로 읽던 화나 저장된 화를 연다.
  const imported = await consumePendingImport();

  if (!imported) {
    const lastId = readLastChapterId();
    const targetChapter =
      state.chapters.find((c) => c.id === lastId) ||
      state.chapters.find((c) => state.saved.has(c.id)) ||
      state.chapters.find((c) => !c.isDemo);

    if (targetChapter) {
      await openChapter(targetChapter.id);
      // 복원된 목록이 있으면 첫 화면에서 화수 목록을 바로 보여준다
      const hasRealChapters = state.chapters.some((c) => !c.isDemo);
      if (hasRealChapters) {
        renderEpisodeList();
        openModal(el.modalEpisodes);
      }
    } else {
      showEmptyState();
    }
  }

  showChrome();

  // 실패해도 현재 번들은 정상 사용한다. 성공하면 서명된 새 번들로 한 번 재시작한다.
  finishStartupAndApplyUpdate().catch((err) => console.warn('[OTA] 업데이트 확인 실패', err));
}

boot();
