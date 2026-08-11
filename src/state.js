/**
 * @typedef {Object} Page
 * @property {number} pageNumber
 * @property {string} url
 * @property {string} [name]
 * @property {boolean} [isSpread]
 */

/**
 * @typedef {Object} Chapter
 * @property {string} id
 * @property {string} title
 * @property {string} label
 * @property {Page[]} pages
 * @property {string|null} sourceUrl
 * @property {string|null} prevUrl
 * @property {string|null} nextUrl
 * @property {boolean} [isDemo]
 */

/**
 * @typedef {Object} ViewerSettings
 * @property {'auto'|'strip'|'single'|'double'} mode
 * @property {'RTL'|'LTR'} direction
 * @property {'slide'|'fade'|'none'} transition
 * @property {number} speed
 * @property {number} brightness
 * @property {'none'|'warm'|'sepia'|'dark'} paper
 */

import { SAMPLE_MANGA_SERIES } from './sampleData.js';
import { getKv, putKv } from './catalogStore.js';

export const PROGRESS_KEY = 'mangaViewer.progress';
export const SETTINGS_KEY = 'mangaViewer.settings';
export const LAST_CHAPTER_KEY = 'mangaViewer.lastChapterId';
export const RECENT_CHAPTERS_KEY = 'mangaViewer.recentChapters';
export const INITIALIZED_KEY = 'mangaViewer.hasInitialized';
export const CHROME_IDLE_MS = 3200;

let writeTail = Promise.resolve();
let writeFailure = null;
let progressState = null;
let lastChapterIdState = null;

/** IndexedDB 쓰기를 호출 순서대로 직렬화한다. unload 완료 여부에는 기대지 않는다. */
export function queueStateWrite(work) {
  const result = writeTail.then(work);
  writeTail = result
    .catch((error) => {
      writeFailure ||= error;
      console.warn('[상태 저장] 영구 저장 실패', error);
    });
  return result;
}

export async function flushStateWrites() {
  while (true) {
    const pending = writeTail;
    await pending;
    if (pending === writeTail) break;
  }
  if (writeFailure) throw writeFailure;
}

export const defaultSettings = {
  mode: 'auto',
  direction: 'RTL',
  transition: 'slide',
  speed: 5,
  brightness: 100,
  paper: 'none',
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    delete saved.mode;
    return { ...defaultSettings, ...saved };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings) {
  const { mode, ...persisted } = settings;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  } catch {
    /* 사파리 프라이빗 모드 등 대응 */
  }
  return queueStateWrite(() => putKv('settings', persisted));
}

export function readProgress() {
  if (progressState) return { ...progressState };
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    progressState = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return { ...progressState };
  } catch {
    return progressState ? { ...progressState } : {};
  }
}

export function saveProgress(chapterId, pageNumber) {
  if (!chapterId) return;
  const all = readProgress();
  all[chapterId] = pageNumber;
  progressState = all;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* 무시 */
  }
  return queueStateWrite(() => putKv('progress', all));
}

export function readLastChapterId() {
  if (lastChapterIdState) return lastChapterIdState;
  try {
    lastChapterIdState = localStorage.getItem(LAST_CHAPTER_KEY) || null;
    return lastChapterIdState;
  } catch {
    return lastChapterIdState;
  }
}

export function saveLastChapterId(id) {
  if (!id) return;
  lastChapterIdState = id;
  try {
    localStorage.setItem(LAST_CHAPTER_KEY, id);
  } catch {
    /* 무시 */
  }
  return queueStateWrite(() => putKv('lastChapterId', id));
}

export function saveInitialized(initialized = true) {
  try {
    localStorage.setItem(INITIALIZED_KEY, String(initialized));
  } catch {
    /* 무시 */
  }
  return queueStateWrite(() => putKv('initialized', Boolean(initialized)));
}

export function readRecentChapters() {
  try {
    const raw = localStorage.getItem(RECENT_CHAPTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return parsed.filter((c) => !c.isDemo && !c.id?.startsWith('demo-'));
  } catch {
    return [];
  }
}

/** migration은 손실을 숨기면 안 된다. 접근/JSON/type 오류를 호출자에게 전파한다. */
export function readRecentChaptersForMigration() {
  const raw = localStorage.getItem(RECENT_CHAPTERS_KEY);
  if (raw == null) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new TypeError('legacy recent chapters가 배열이 아닙니다.');
  return parsed.filter((c) => c && !c.isDemo && !c.id?.startsWith('demo-'));
}

export function saveRecentChapters(chapters) {
  try {
    // 최근 수집 및 열람한 챕터 최대 30개 보관 (데모 제외)
    const filtered = (chapters || [])
      .filter((c) => !c.isDemo && !c.id?.startsWith('demo-'))
      .slice(0, 30)
      .map((c) => ({
        id: c.id,
        title: c.title,
        label: c.label,
        pages: c.pages,
        coverUrl: c.coverUrl || null,
        sourceUrl: c.sourceUrl || null,
        prevUrl: c.prevUrl || null,
        nextUrl: c.nextUrl || null,
        kind: c.kind || 'comic',
        type: c.type || null,
        episodeNumber: c.episodeNumber || null,
        episodeTitle: c.episodeTitle || null,
        savedAt: c.savedAt || Date.now(),
      }));
    try {
      localStorage.setItem(RECENT_CHAPTERS_KEY, JSON.stringify(filtered));
    } catch {
      // 용량 초과 시 줄여서 재시도
      const reduced = filtered.slice(0, 10);
      try {
        localStorage.setItem(RECENT_CHAPTERS_KEY, JSON.stringify(reduced));
      } catch {
        // 그래도 안 되면 포기
        localStorage.removeItem(RECENT_CHAPTERS_KEY);
      }
    }

  } catch {
    /* 무시 */
  }
}

function localValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocalValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* IndexedDB가 복구 원본이므로 localStorage 실패는 치명적이지 않다. */
  }
}

function parsedObject(raw) {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** localStorage가 없거나 깨졌으면 kv를 복구 원본으로 쓰고, 있으면 kv에 즉시 반영한다. */
export async function restoreStateFromKv(state) {
  const [kvSettings, kvProgress, kvLastChapterId, kvInitialized] = await Promise.all([
    getKv('settings'),
    getKv('progress'),
    getKv('lastChapterId'),
    getKv('initialized'),
  ]);

  const localSettings = parsedObject(localValue(SETTINGS_KEY));
  if (localSettings) {
    delete localSettings.mode;
    state.settings = { ...defaultSettings, ...localSettings };
    await putKv('settings', localSettings);
  } else if (kvSettings && typeof kvSettings === 'object') {
    state.settings = { ...defaultSettings, ...kvSettings };
    setLocalValue(SETTINGS_KEY, JSON.stringify(kvSettings));
  } else {
    const { mode, ...settings } = state.settings;
    setLocalValue(SETTINGS_KEY, JSON.stringify(settings));
    await putKv('settings', settings);
  }

  const localProgress = parsedObject(localValue(PROGRESS_KEY));
  if (localProgress) {
    progressState = localProgress;
    await putKv('progress', localProgress);
  } else if (kvProgress && typeof kvProgress === 'object') {
    progressState = { ...kvProgress };
    setLocalValue(PROGRESS_KEY, JSON.stringify(kvProgress));
  } else {
    progressState = {};
    setLocalValue(PROGRESS_KEY, '{}');
    await putKv('progress', {});
  }

  const localLastChapterId = localValue(LAST_CHAPTER_KEY);
  if (localLastChapterId) {
    lastChapterIdState = localLastChapterId;
    await putKv('lastChapterId', localLastChapterId);
  } else if (typeof kvLastChapterId === 'string' && kvLastChapterId) {
    lastChapterIdState = kvLastChapterId;
    setLocalValue(LAST_CHAPTER_KEY, kvLastChapterId);
  } else {
    lastChapterIdState = null;
  }

  const localInitialized = localValue(INITIALIZED_KEY);
  if (localInitialized != null) {
    state.initialized = localInitialized === 'true';
    await putKv('initialized', state.initialized);
  } else if (typeof kvInitialized === 'boolean') {
    state.initialized = kvInitialized;
    setLocalValue(INITIALIZED_KEY, String(kvInitialized));
  } else {
    state.initialized = false;
  }
}

export function createInitialState() {
  return {
    /** @type {Chapter[]} */
    chapters: [],
    currentId: null,
    currentShelfTab: 'comic',
    initialized: false,
    settings: loadSettings(),
    chromeVisible: true,
    saved: new Map(),
    objectUrls: [],
  };
}
