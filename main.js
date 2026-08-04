import { SAMPLE_MANGA_SERIES } from './src/sampleData.js';
import { UrlHarvester } from './src/urlHarvester.js';
import { ReaderEngine } from './src/readerEngine.js';
import { buildBookmarklet } from './src/collector.js';

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
  })),
  currentId: null,
  settings: loadSettings(),
  chromeVisible: true,
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
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
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

function currentChapter() {
  return state.chapters.find((c) => c.id === state.currentId) || state.chapters[0];
}

function currentIndex() {
  return state.chapters.findIndex((c) => c.id === state.currentId);
}

function openChapter(chapterId, pageNumber) {
  const chapter = state.chapters.find((c) => c.id === chapterId);
  if (!chapter) return;

  state.currentId = chapter.id;

  el.title.textContent = chapter.title || '만화 뷰어';
  el.chapter.textContent = chapter.label || '';

  const idx = currentIndex();
  el.btnPrevEp.disabled = idx <= 0 && !chapter.prevUrl;
  el.btnNextEp.disabled = idx >= state.chapters.length - 1 && !chapter.nextUrl;

  const startAt = pageNumber ?? readProgress()[chapter.id] ?? 1;
  engine.loadChapter(chapter, startAt);
}

/**
 * 새로 수집한 챕터를 목록 맨 앞에 넣고 바로 연다.
 * 같은 출처를 다시 불러오면 새로 만들지 않고 갱신한다.
 */
function addChapter(harvested, idPrefix) {
  const existing = harvested.targetUrl
    ? state.chapters.find((c) => c.sourceUrl && c.sourceUrl === harvested.targetUrl)
    : null;

  const chapter = existing || {
    id: `${idPrefix}-${Date.now()}`,
    label: '불러옴',
  };

  chapter.title = harvested.title || '불러온 만화';
  chapter.pages = harvested.pages;
  chapter.sourceUrl = harvested.targetUrl || null;
  chapter.prevUrl = harvested.prevUrl || null;
  chapter.nextUrl = harvested.nextUrl || null;

  if (!existing) state.chapters.unshift(chapter);

  openChapter(chapter.id, 1);
  return chapter;
}

/**
 * 인접 화로 이동.
 *
 * 목록에 없는 화는 서버가 대신 긁어올 수 없다 (이미지가 HTML에 없는 사이트가 대부분).
 * 그래서 그 화를 새 탭으로 열어주고, 거기서 북마클릿을 한 번 더 누르게 한다.
 */
function goChapter(delta) {
  const idx = currentIndex();
  const target = state.chapters[idx + delta];

  if (target) {
    openChapter(target.id);
    return;
  }

  const url = delta > 0 ? currentChapter().nextUrl : currentChapter().prevUrl;
  if (!url) {
    toast(delta > 0 ? '다음 화가 없습니다.' : '이전 화가 없습니다.');
    return;
  }

  window.open(url, '_blank');
  toast('그 화를 새 탭에서 열었습니다. 거기서 북마클릿을 누르세요.', { duration: 5000 });
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
      const idx = currentIndex();
      const hasNext = idx < state.chapters.length - 1 || currentChapter().nextUrl;
      if (hasNext) {
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

function renderEpisodeList() {
  el.epList.replaceChildren(
    ...state.chapters.map((chapter) => {
      const isCurrent = chapter.id === state.currentId;
      const saved = readProgress()[chapter.id];

      const item = document.createElement('button');
      item.type = 'button';
      item.className = `ep-item${isCurrent ? ' is-current' : ''}`;

      const info = document.createElement('div');
      const title = document.createElement('span');
      title.className = 'ep-title';
      title.textContent = chapter.title || '제목 없음';
      const meta = document.createElement('span');
      meta.className = 'ep-meta';
      meta.textContent = `${chapter.pages.length}장` + (saved ? ` · ${saved}쪽까지 읽음` : '');
      info.append(title, meta);

      const stateTag = document.createElement('span');
      stateTag.className = 'ep-state';
      stateTag.textContent = isCurrent ? '읽는 중' : '';

      item.append(info, stateTag);
      item.addEventListener('click', () => {
        openChapter(chapter.id);
        closeModal(el.modalEpisodes);
      });
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

function submitImport() {
  const raw = el.rawInput.value.trim();

  if (!raw) {
    toast('이미지 주소를 붙여넣어 주세요.', { error: true });
    return;
  }

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

  el.bookmarkletUrl.value = buildBookmarklet(window.location.origin);
}

async function boot() {
  initEngine();
  applySettingsToUI();
  wireEvents();

  // 뷰어 탭이 이미 열려 있는 상태로 #import= 만 바뀌면 스크립트가 다시 돌지 않는다.
  // (같은 문서 내 프래그먼트 이동) 그래서 hashchange 로도 한 번 더 받는다.
  window.addEventListener('hashchange', () => {
    if (/[#&]import=/.test(window.location.hash)) consumePendingImport();
  });

  // 북마클릿으로 넘어온 게 있으면 그것을, 없으면 샘플을 연다
  const imported = await consumePendingImport();
  if (!imported) openChapter(state.chapters[0].id);

  showChrome();
}

boot();
