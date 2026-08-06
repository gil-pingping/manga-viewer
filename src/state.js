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

export function createInitialState() {
  return {
    /** @type {Chapter[]} */
    chapters: SAMPLE_MANGA_SERIES.episodes.map((ep) => ({
      id: ep.id,
      title: ep.title,
      label: `${ep.number}화`,
      pages: ep.pages,
      sourceUrl: null,
      prevUrl: null,
      nextUrl: null,
      isDemo: true,
    })),
    currentId: null,
    settings: loadSettings(),
    chromeVisible: true,
    saved: new Map(),
    objectUrls: [],
  };
}
