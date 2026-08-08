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

export const PROGRESS_KEY = 'mangaViewer.progress';
export const SETTINGS_KEY = 'mangaViewer.settings';
export const LAST_CHAPTER_KEY = 'mangaViewer.lastChapterId';
export const RECENT_CHAPTERS_KEY = 'mangaViewer.recentChapters';
export const CHROME_IDLE_MS = 3200;

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
  try {
    const { mode, ...persisted } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  } catch {
    /* 사파리 프라이빗 모드 등 대응 */
  }
}

export function readProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveProgress(chapterId, pageNumber) {
  if (!chapterId) return;
  try {
    const all = readProgress();
    all[chapterId] = pageNumber;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* 무시 */
  }
}

export function readLastChapterId() {
  try {
    return localStorage.getItem(LAST_CHAPTER_KEY) || null;
  } catch {
    return null;
  }
}

export function saveLastChapterId(id) {
  if (!id) return;
  try {
    localStorage.setItem(LAST_CHAPTER_KEY, id);
  } catch {
    /* 무시 */
  }
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

    // IndexedDB 에도 이중 저장 (Capacitor live-update 등으로 localStorage 가 리셋되는 것에 대비)
    import('./library.js').then((lib) => {
      lib.saveRecentChaptersToDb(chapters);
    }).catch(() => {});
  } catch {
    /* 무시 */
  }
}

export function createInitialState() {
  return {
    /** @type {Chapter[]} */
    chapters: [],
    currentId: null,
    currentShelfTab: 'comic',
    settings: loadSettings(),
    chromeVisible: true,
    saved: new Map(),
    objectUrls: [],
  };
}
