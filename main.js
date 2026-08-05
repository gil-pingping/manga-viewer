import { SAMPLE_MANGA_SERIES } from './src/sampleData.js';
import { UrlHarvester } from './src/urlHarvester.js';
import { ReaderEngine } from './src/readerEngine.js';
import { buildBookmarklet } from './src/collector.js';
import {
  findChapter,
  indexOfChapter,
  realNeighbor as findRealNeighbor,
  hasAdjacent as canGoAdjacent,
  resolveAdjacent,
  upsertChapter,
} from './src/core/chapterNav.js';
import * as library from './src/library.js';

/* ==================================================================== */
/* 상태                                                                  */
/* ==================================================================== */

const PROGRESS_KEY = 'mangaViewer.progress';
const SETTINGS_KEY = 'mangaViewer.settings';
const CHROME_IDLE_MS = 3200;

const defaultSettings = {
  mode: 'auto',
  direction: 'RTL',
  transition: 'slide',
  speed: 5,
  brightness: 100,
  paper: 'none',
};

const state = {
  /** 읽을 수 있는 챕터 목록. 불러온 챕터가 앞에 쌓인다 */
  chapters: SAMPLE_MANGA_SERIES.episodes.map((ep) => ({
    id: ep.id,
    title: ep.title,
    label: `${ep.number}화`,
    pages: ep.pages,
    sourceUrl: null,
    prevUrl: null,
    nextUrl: null,
    isDemo: true, // 마지막 장에서 데모로 자동 진행하지 않도록 표시
  })),
  currentId: null,
  settings: loadSettings(),
  chromeVisible: true,
  /** 서재에 저장된 챕터 메타 (id → record). 목록에 "담김" 표시를 하려고 들고 있다 */
  saved: new Map(),
  /** 지금 화면이 쓰고 있는 blob 주소들. 챕터를 바꿀 때 놓아줘야 메모리가 안 샌다 */
  objectUrls: [],
};

let engine = null;
let chromeTimer = null;
let toastTimer = null;

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
/* 저장소                                                                */
/* ==================================================================== */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    // mode 는 저장하지 않는다 (아래 saveSettings 주석 참고). 예전에 저장된 값도 무시한다.
    delete saved.mode;
    return { ...defaultSettings, ...saved };
  } catch {
    return { ...defaultSettings };
  }
}

/**
 * 보기 모드(mode)는 저장하지 않는다.
 *
 * 저장했더니 함정이 됐다. 만화책 한 화를 보려고 "한 장"을 한 번 고르면
 * 그 뒤로 웹툰이 계속 페이지 넘김으로 떠서 "고장난 것"처럼 보였다.
 * auto 는 이미지 비율을 보고 옳게 고르니, 새 콘텐츠는 항상 auto 로 시작한다.
 * 수동 선택은 그 챕터를 보는 동안만 유효하다.
 */
function saveSettings() {
  try {
    const { mode, ...persisted } = state.settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  } catch {
    /* 사파리 프라이빗 모드 등에서는 저장을 포기한다 */
  }
}

function readProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveProgress(chapterId, pageNumber) {
  if (!chapterId) return;
  try {
    const all = readProgress();
    all[chapterId] = pageNumber;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* 무시 */
  }
}

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
async function openChapter(chapterId, pageNumber) {
  const chapter = state.chapters.find((c) => c.id === chapterId);
  if (!chapter) return;

  revokeObjectUrls();

  /**
   * 엔진에 넘길 판. chapter.pages 는 절대 덮지 않는다 — 그 주소가 서재의 키다.
   * blob 주소로 갈아끼워 저장해버리면 두 번째로 열 때 조회가 빗나간다.
   */
  let forEngine = chapter;

  // 로컬 파일·데이터 URL 은 프록시를 안 타므로 서재를 볼 필요가 없다
  const proxied = (chapter.pages || []).some((p) => p.url?.startsWith('/api/'));
  if (proxied && state.saved.has(chapter.id)) {
    try {
      const offline = await library.resolveOffline(chapter);
      if (offline) {
        state.objectUrls = offline;
        forEngine = {
          ...chapter,
          pages: offline.map((url, i) => ({ ...chapter.pages[i], url })),
        };
      }
    } catch (err) {
      console.warn('[서재] 저장된 이미지를 꺼내지 못했습니다', err);
    }
  }

  document.getElementById('app').classList.remove('is-empty');
  el.slider.disabled = false;
  [el.btnPrevPage, el.btnNextPage, el.btnAutoplay].forEach((b) => {
    b.disabled = false;
  });

  state.currentId = chapter.id;

  el.title.textContent = chapter.title || '만화 뷰어';
  el.chapter.textContent = chapter.label || '';

  // currentId 를 먼저 세운 뒤에 판정해야 hasAdjacent 가 올바른 위치를 본다
  el.btnPrevEp.disabled = !hasAdjacent(-1);
  el.btnNextEp.disabled = !hasAdjacent(1);

  const startAt = pageNumber ?? readProgress()[chapter.id] ?? 1;
  engine.loadChapter(forEngine, startAt);
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
    const harvested = await UrlHarvester.fetchFromUrl(move.url);
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

      // 데모로 자동 진행하면 "왜 갑자기 빈 컷이 나오지"가 된다. 불러온 것만 이어본다.
      const canAutoAdvance = (next && !next.isDemo) || currentChapter().nextUrl;

      if (canAutoAdvance) {
        toast('마지막 페이지입니다. 다음 화로 넘어갑니다.');
        setTimeout(() => goChapter(1), 900);
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

function renderEpisodeList() {
  renderLibraryBar();

  el.epList.replaceChildren(
    ...state.chapters.map((chapter) => {
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
    })
  );
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

function wireEvents() {
  /* 터치 영역 — 읽기 방향에 따라 좌우 의미가 뒤바뀐다 */
  el.tapLeft.addEventListener('click', () => {
    state.settings.direction === 'RTL' ? engine.nextPage() : engine.prevPage();
  });
  el.tapRight.addEventListener('click', () => {
    state.settings.direction === 'RTL' ? engine.prevPage() : engine.nextPage();
  });
  el.tapCenter.addEventListener('click', toggleChrome);

  /* 페이지 · 화 이동 */
  el.btnPrevPage.addEventListener('click', () => engine.prevPage());
  el.btnNextPage.addEventListener('click', () => engine.nextPage());
  el.btnPrevEp.addEventListener('click', () => goChapter(-1));
  el.btnNextEp.addEventListener('click', () => goChapter(1));

  el.slider.addEventListener('input', (e) => {
    engine.goToPage(parseInt(e.target.value, 10));
    showChrome(false);
  });
  el.slider.addEventListener('change', () => showChrome());

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

  /* 키보드 */
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;

    if (e.key === 'Escape') {
      closeAllModals();
      return;
    }
    if (document.querySelector('.modal.is-open')) return;

    const rtl = state.settings.direction === 'RTL';

    if (e.key === 'ArrowLeft') rtl ? engine.nextPage() : engine.prevPage();
    else if (e.key === 'ArrowRight') rtl ? engine.prevPage() : engine.nextPage();
    else if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      engine.nextPage();
    } else if (e.key === 'ArrowUp') engine.prevPage();
    else if (e.key.toLowerCase() === 'f') el.btnFullscreen.click();
    else if (e.key.toLowerCase() === 'm') toggleChrome();
    else return;

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
 * 서비스워커를 등록해 앱 껍데기를 오프라인에서도 열리게 한다.
 *
 * secure context 전용이라 `http://<LAN IP>:5173` 에서는 등록 자체가 안 된다.
 * 치명적이지 않다 — 서재(IndexedDB)는 그대로 돌고 껍데기만 서버가 필요해진다.
 * 조용히 실패하면 나중에 "왜 오프라인이 안 되지"로 헤매므로 이유를 남긴다.
 */
async function registerServiceWorker() {
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

/**
 * 서재에 담아둔 화를 목록에 올린다.
 *
 * 데모 앞에 꽂아 최근에 담은 것이 위로 온다. 이것이 "회차를 전체 보는" 목록의
 * 실체다 — 새로고침해도 남고, 프록시가 죽어도 읽힌다.
 */
async function loadLibraryIntoList() {
  await refreshSaved();

  const restored = [...state.saved.values()].map((row) => ({
    id: row.id,
    title: row.title,
    label: row.label || '담아둔 화',
    pages: row.pages,
    sourceUrl: row.sourceUrl,
    prevUrl: row.prevUrl,
    nextUrl: row.nextUrl,
  }));

  if (restored.length > 0) state.chapters = [...restored, ...state.chapters];
}

async function boot() {
  initEngine();
  applySettingsToUI();
  wireEvents();

  // 브라우저가 공간이 부족할 때 서재를 조용히 비우지 않도록 미리 부탁한다
  library.requestPersistence().catch(() => {});
  registerServiceWorker();
  await loadLibraryIntoList();

  // 뷰어 탭이 이미 열려 있는 상태로 #import= 만 바뀌면 스크립트가 다시 돌지 않는다.
  // (같은 문서 내 프래그먼트 이동) 그래서 hashchange 로도 한 번 더 받는다.
  window.addEventListener('hashchange', () => {
    if (/[#&]import=/.test(window.location.hash)) consumePendingImport();
  });

  // 북마클릿으로 넘어온 게 있으면 그것을 열고, 없으면 서재의 최근 화를 연다.
  // 데모를 자동으로 열면 빈 컷 프레임이 "고장난 뷰어"처럼 보인다 — 데모는 목록에서 고른다.
  const imported = await consumePendingImport();

  if (!imported) {
    // 담아둔 화가 있으면 그것으로 시작한다. 서버 없이 켰을 때 바로 읽히는 게 맞다
    const recent = state.chapters.find((c) => state.saved.has(c.id));
    if (recent) await openChapter(recent.id);
    else showEmptyState();
  }

  showChrome();
}

boot();
