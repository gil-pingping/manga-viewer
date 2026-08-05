/**
 * 만화 리더 엔진
 *
 * 모드 네 가지
 *   strip   연속 세로 스크롤 — 한국 웹툰(세로로 긴 컷) 용
 *   single  한 장씩 페이지 넘김
 *   double  두 장 펼침 (일본 만화 단행본)
 *   auto    이미지 비율을 보고 strip / single / double 을 스스로 고른다
 *
 * 8.4인치 태블릿을 전제로 한다. 화면이 작아서 두 장 펼침은 가로 모드에서만 쓸모가 있고,
 * 세로로 긴 웹툰을 페이지로 쪼개면 읽기가 불편하므로 strip 을 자동으로 택한다.
 */

import {
  resolveMode,
  resolveVisiblePages as resolveVisible,
  pageStep as computePageStep,
  nextIndex,
  prevIndex,
  isSpreadRatio,
} from './core/layout.js';

const MAX_CACHED_IMAGES = 28;
const PRELOAD_AHEAD = 4;
const PRELOAD_BEHIND = 2;
const MAX_ZOOM = 4;
const SWIPE_THRESHOLD_PX = 55;

export class ReaderEngine {
  constructor(options = {}) {
    this.container = options.container;
    this.pages = [];
    this.currentIndex = 0;
    this.episode = null;

    this.mode = options.mode || 'auto';
    this.direction = options.direction || 'RTL';
    this.transitionType = options.transitionType || 'slide';
    this.autoPlaySpeed = options.autoPlaySpeed || 5;
    this.isAutoPlaying = false;
    this.autoPlayTimer = null;

    this.zoomScale = 1;
    this.panX = 0;
    this.panY = 0;
    this.isZoomed = false;

    /** url -> HTMLImageElement. 같은 엘리먼트를 재사용하면 페이지를 되돌려도 다시 안 받는다 */
    this.imageCache = new Map();
    /** 이미지 비율을 측정해 strip/spread 판단에 쓴다 */
    this.measuredRatios = [];

    this.onPageChange = options.onPageChange || (() => {});
    this.onEpisodeEnd = options.onEpisodeEnd || (() => {});
    this.onZoomChange = options.onZoomChange || (() => {});

    this.handleResize = debounce(() => this.render(), 150);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleResize);

    this.setupGestures();
    this.setupStripTracking();
  }

  /* ------------------------------------------------------------------ */
  /* 챕터 로드                                                           */
  /* ------------------------------------------------------------------ */

  loadChapter(episodeData, initialPageNum = 1) {
    this.episode = episodeData;
    this.pages = episodeData.pages || [];
    this.currentIndex = clamp(initialPageNum - 1, 0, Math.max(0, this.pages.length - 1));

    this.releaseImageCache();
    this.measuredRatios = [];
    this.resetZoom();
    this.render();
    this.probeLeadingImages();
  }

  /**
   * 앞쪽 몇 장의 실제 비율을 먼저 재둔다.
   * auto 모드가 strip 인지 페이지 넘김인지 판단할 근거가 필요하고,
   * 펼침 컷 짝짓기도 미리 알아야 어긋나지 않는다.
   */
  probeLeadingImages() {
    const probeCount = Math.min(3, this.pages.length);
    for (let i = 0; i < probeCount; i++) this.getImageElement(i);
  }

  /* ------------------------------------------------------------------ */
  /* 모드 판정                                                           */
  /* ------------------------------------------------------------------ */

  /** 배치 판정은 core/layout 에 있다 (순수 함수라 테스트된다) */
  getEffectiveMode() {
    return resolveMode({
      mode: this.mode,
      ratios: this.measuredRatios,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }

  setMode(newMode) {
    this.mode = newMode;
    this.resetZoom();
    this.render();
  }

  setDirection(newDirection) {
    this.direction = newDirection;
    this.render();
  }

  setTransitionType(type) {
    this.transitionType = type;
  }

  /* ------------------------------------------------------------------ */
  /* 이미지 엘리먼트 캐시                                                */
  /* ------------------------------------------------------------------ */

  getImageElement(index) {
    const page = this.pages[index];
    if (!page || !page.url) return null;

    const cached = this.imageCache.get(page.url);
    if (cached) return cached;

    const img = document.createElement('img');
    img.className = 'manga-img is-loading';
    img.alt = page.name || `Page ${page.pageNumber}`;
    img.decoding = 'async';
    img.draggable = false;

    img.addEventListener('load', () => {
      img.classList.remove('is-loading');
      this.recordRatio(index, img.naturalWidth, img.naturalHeight);
    });

    img.addEventListener('error', () => {
      img.classList.remove('is-loading');
      img.classList.add('is-error');
      const wrapper = img.closest('.manga-page-wrapper');
      if (wrapper) wrapper.classList.add('load-failed');
    });

    img.src = page.url;
    this.imageCache.set(page.url, img);
    this.evictDistantImages();
    return img;
  }

  /**
   * 비율을 기록하고, 그 결과가 지금 배치를 바꿔야 하면 한 번만 다시 그린다.
   * (측정 → 재렌더 → 측정 무한 루프를 막기 위해 page.__measured 로 한 번만 처리한다)
   */
  recordRatio(index, w, h) {
    const page = this.pages[index];
    if (!page || !w || !h) return;

    if (this.measuredRatios.length < 12) this.measuredRatios.push({ w, h });

    if (page.__measured) return;
    page.__measured = true;

    const wasSpread = page.isSpread === true;
    const isSpread = isSpreadRatio(w, h);
    page.isSpread = isSpread;

    // 화면에 걸린 페이지의 펼침 여부가 바뀌었거나 auto 모드 판정이 흔들리면 다시 그린다
    const affectsLayout = isSpread !== wasSpread || this.mode === 'auto';
    if (affectsLayout && this.isNearVisible(index)) this.render();
  }

  isNearVisible(index) {
    return Math.abs(index - this.currentIndex) <= 2;
  }

  evictDistantImages() {
    if (this.imageCache.size <= MAX_CACHED_IMAGES) return;

    const keepUrls = new Set();
    const from = Math.max(0, this.currentIndex - PRELOAD_BEHIND - 2);
    const to = Math.min(this.pages.length - 1, this.currentIndex + PRELOAD_AHEAD + 2);
    for (let i = from; i <= to; i++) {
      if (this.pages[i]) keepUrls.add(this.pages[i].url);
    }

    for (const [url, el] of this.imageCache) {
      if (this.imageCache.size <= MAX_CACHED_IMAGES) break;
      if (keepUrls.has(url)) continue;
      if (el.isConnected) continue;
      this.imageCache.delete(url);
    }
  }

  releaseImageCache() {
    for (const el of this.imageCache.values()) el.remove();
    this.imageCache.clear();
  }

  preloadSurrounding() {
    const from = Math.max(0, this.currentIndex - PRELOAD_BEHIND);
    const to = Math.min(this.pages.length - 1, this.currentIndex + PRELOAD_AHEAD);
    for (let i = from; i <= to; i++) this.getImageElement(i);
  }

  /* ------------------------------------------------------------------ */
  /* 페이지 이동                                                         */
  /* ------------------------------------------------------------------ */

  nextPage() {
    if (this.isZoomed) {
      this.resetZoom();
      return;
    }

    if (this.getEffectiveMode() === 'strip') {
      this.scrollStrip(1);
      return;
    }

    const target = nextIndex({
      pages: this.pages,
      index: this.currentIndex,
      mode: this.getEffectiveMode(),
      visibleCount: this.visibleCount,
    });

    if (target === null) {
      this.stopAutoPlay();
      this.onEpisodeEnd();
      return;
    }
    this.currentIndex = target;
    this.triggerAnimation('next');
    this.render();
  }

  prevPage() {
    if (this.isZoomed) {
      this.resetZoom();
      return;
    }

    if (this.getEffectiveMode() === 'strip') {
      this.scrollStrip(-1);
      return;
    }

    const target = prevIndex({
      index: this.currentIndex,
      mode: this.getEffectiveMode(),
      visibleCount: this.visibleCount,
    });
    if (target === null) return;

    this.currentIndex = target;
    this.triggerAnimation('prev');
    this.render();
  }

  /**
   * 넘김 단위는 "방금 실제로 띄운 장수"와 같아야 한다.
   * 한 장만 띄웠는데 두 장씩 넘기면 중간 페이지가 조용히 건너뛰어진다.
   */
  pageStep() {
    return computePageStep({ mode: this.getEffectiveMode(), visibleCount: this.visibleCount });
  }

  goToPage(pageNumber) {
    const target = clamp(pageNumber - 1, 0, Math.max(0, this.pages.length - 1));

    if (this.getEffectiveMode() === 'strip') {
      this.currentIndex = target;
      const wrapper = this.container.querySelector(`[data-index="${target}"]`);
      if (wrapper) wrapper.scrollIntoView({ block: 'start', behavior: 'auto' });
      this.emitPageChange();
      return;
    }

    this.resetZoom();
    this.currentIndex = target;
    this.render();
  }

  scrollStrip(dir) {
    const amount = this.container.clientHeight * 0.9 * dir;
    this.container.scrollBy({ top: amount, behavior: 'smooth' });

    const atBottom =
      this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 8;
    if (dir > 0 && atBottom) {
      this.stopAutoPlay();
      this.onEpisodeEnd();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 렌더                                                                */
  /* ------------------------------------------------------------------ */

  render() {
    if (!this.container || !this.pages.length) return;

    const mode = this.getEffectiveMode();
    this.container.className = `manga-viewport mode-${mode} dir-${this.direction.toLowerCase()}`;

    if (mode === 'strip') this.renderStrip();
    else this.renderPaged(mode);

    this.preloadSurrounding();
    this.emitPageChange();
  }

  renderPaged(mode) {
    const visible = this.resolveVisiblePages(mode);
    // pageStep() 이 이 값을 읽는다 — 띄운 장수와 넘김 단위를 붙여둔다
    this.visibleCount = visible.length;

    const stage = document.createElement('div');
    stage.className = 'manga-page-stage';

    for (const { page, index } of visible) {
      const wrapper = document.createElement('div');
      wrapper.className = 'manga-page-wrapper';
      wrapper.dataset.index = String(index);
      wrapper.dataset.page = String(page.pageNumber);

      const img = this.getImageElement(index);
      if (img) wrapper.appendChild(img);

      const badge = document.createElement('div');
      badge.className = 'page-num-badge';
      badge.textContent = String(page.pageNumber);
      wrapper.appendChild(badge);

      const retry = document.createElement('button');
      retry.className = 'page-retry';
      retry.type = 'button';
      retry.textContent = '이미지 실패 · 다시 시도';
      retry.addEventListener('click', (e) => {
        e.stopPropagation();
        this.retryPage(index);
      });
      wrapper.appendChild(retry);

      stage.appendChild(wrapper);
    }

    this.container.replaceChildren(stage);
    this.applyZoomTransform();
  }

  /** 연속 스크롤: 전부 배치하고 브라우저의 lazy 로딩에 맡긴다 */
  renderStrip() {
    const frag = document.createDocumentFragment();

    this.pages.forEach((page, index) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'manga-strip-page';
      wrapper.dataset.index = String(index);

      const img = document.createElement('img');
      img.className = 'manga-img';
      img.src = page.url;
      img.alt = page.name || `Page ${page.pageNumber}`;
      img.loading = index < 3 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('load', () =>
        this.recordRatio(index, img.naturalWidth, img.naturalHeight)
      );
      img.addEventListener('error', () => wrapper.classList.add('load-failed'));

      const retry = document.createElement('button');
      retry.className = 'page-retry';
      retry.type = 'button';
      retry.textContent = '이미지 실패 · 다시 시도';
      retry.addEventListener('click', (e) => {
        e.stopPropagation();
        wrapper.classList.remove('load-failed');
        img.src = bust(this.pages[index].url);
      });

      wrapper.append(img, retry);
      frag.appendChild(wrapper);
    });

    this.container.replaceChildren(frag);
    this.observeStripPages();

    const target = this.container.querySelector(`[data-index="${this.currentIndex}"]`);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  /**
   * 지금 보여줄 페이지들을 고른다.
   * 두 장 펼침에서는 첫 장을 홀로 두어(표지) 이후 짝이 원본과 맞게 떨어지도록 한다.
   */
  resolveVisiblePages(mode) {
    return resolveVisible({
      pages: this.pages,
      index: this.currentIndex,
      mode,
      direction: this.direction,
    });
  }

  retryPage(index) {
    const page = this.pages[index];
    if (!page) return;
    this.imageCache.delete(page.url);
    const fresh = this.getImageElement(index);
    if (!fresh) return;
    fresh.src = bust(page.url);
    this.render();
  }

  triggerAnimation(direction) {
    if (this.transitionType === 'none') return;
    const stage = this.container.querySelector('.manga-page-stage');
    if (!stage) return;

    stage.classList.remove('anim-slide-next', 'anim-slide-prev', 'anim-fade');
    void stage.offsetWidth;

    if (this.transitionType === 'slide') {
      stage.classList.add(direction === 'next' ? 'anim-slide-next' : 'anim-slide-prev');
    } else if (this.transitionType === 'fade') {
      stage.classList.add('anim-fade');
    }
  }

  emitPageChange() {
    this.onPageChange({
      currentIndex: this.currentIndex,
      currentPageNum: this.currentIndex + 1,
      totalPages: this.pages.length,
      effectiveMode: this.getEffectiveMode(),
      isAutoPlaying: this.isAutoPlaying,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 연속 스크롤 위치 추적                                               */
  /* ------------------------------------------------------------------ */

  setupStripTracking() {
    if (!('IntersectionObserver' in window)) return;

    this.stripObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number(entry.target.dataset.index);
          if (Number.isFinite(index) && index !== this.currentIndex) {
            this.currentIndex = index;
            this.emitPageChange();
          }
        }
      },
      { root: this.container, threshold: 0.01, rootMargin: '-45% 0px -45% 0px' }
    );
  }

  observeStripPages() {
    if (!this.stripObserver) return;
    this.stripObserver.disconnect();
    for (const el of this.container.querySelectorAll('.manga-strip-page')) {
      this.stripObserver.observe(el);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 제스처: 핀치 줌 / 드래그 팬 / 스와이프 / 더블탭                      */
  /* ------------------------------------------------------------------ */

  setupGestures() {
    if (!this.container) return;

    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let isPinching = false;

    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartPanX = 0;
    let dragStartPanY = 0;
    let isDragging = false;
    let lastTapAt = 0;

    const touchStart = (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        isDragging = false;
        pinchStartDist = touchDistance(e.touches);
        pinchStartScale = this.zoomScale;
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        dragStartX = t.clientX;
        dragStartY = t.clientY;
        dragStartPanX = this.panX;
        dragStartPanY = this.panY;
        isDragging = true;
      }
    };

    const touchMove = (e) => {
      if (isPinching && e.touches.length === 2) {
        const dist = touchDistance(e.touches);
        if (pinchStartDist > 0) {
          this.zoomScale = clamp(pinchStartScale * (dist / pinchStartDist), 1, MAX_ZOOM);
          if (this.zoomScale === 1) {
            this.panX = 0;
            this.panY = 0;
          }
          this.applyZoomTransform();
        }
        return;
      }

      // 확대 상태에서 한 손가락 드래그 = 팬
      if (isDragging && this.isZoomed && e.touches.length === 1) {
        const t = e.touches[0];
        this.panX = dragStartPanX + (t.clientX - dragStartX);
        this.panY = dragStartPanY + (t.clientY - dragStartY);
        this.clampPan();
        this.applyZoomTransform();
      }
    };

    const touchEnd = (e) => {
      if (e.touches.length < 2) isPinching = false;

      // 확대 안 한 상태에서 좌우로 충분히 밀었으면 페이지 넘김 (연속 스크롤 모드는 제외)
      if (isDragging && !this.isZoomed && e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const dx = t.clientX - dragStartX;
        const dy = t.clientY - dragStartY;

        const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
        if (
          isHorizontal &&
          Math.abs(dx) > SWIPE_THRESHOLD_PX &&
          this.getEffectiveMode() !== 'strip'
        ) {
          // RTL 이면 왼쪽으로 밀 때 다음 장
          const goNext = this.direction === 'RTL' ? dx < 0 : dx > 0;
          goNext ? this.nextPage() : this.prevPage();
        }
      }
      isDragging = false;

      // 더블탭 줌 토글
      if (e.changedTouches.length === 1 && this.getEffectiveMode() !== 'strip') {
        const now = performance.now();
        const moved =
          Math.abs(e.changedTouches[0].clientX - dragStartX) > 12 ||
          Math.abs(e.changedTouches[0].clientY - dragStartY) > 12;

        if (!moved && now - lastTapAt < 300) {
          this.isZoomed ? this.resetZoom() : this.setZoom(2.2);
          lastTapAt = 0;
        } else if (!moved) {
          lastTapAt = now;
        }
      }
    };

    this.container.addEventListener('touchstart', touchStart, { passive: true });
    this.container.addEventListener('touchmove', touchMove, { passive: true });
    this.container.addEventListener('touchend', touchEnd, { passive: true });

    // 데스크톱 확인용: 더블클릭 줌
    this.container.addEventListener('dblclick', () => {
      if (this.getEffectiveMode() === 'strip') return;
      this.isZoomed ? this.resetZoom() : this.setZoom(2.2);
    });
  }

  setZoom(scale) {
    this.zoomScale = clamp(scale, 1, MAX_ZOOM);
    this.panX = 0;
    this.panY = 0;
    this.applyZoomTransform();
  }

  clampPan() {
    const stage = this.container.querySelector('.manga-page-stage');
    if (!stage) return;
    const maxX = (stage.clientWidth * (this.zoomScale - 1)) / 2;
    const maxY = (stage.clientHeight * (this.zoomScale - 1)) / 2;
    this.panX = clamp(this.panX, -maxX, maxX);
    this.panY = clamp(this.panY, -maxY, maxY);
  }

  applyZoomTransform() {
    const stage = this.container.querySelector('.manga-page-stage');
    const nowZoomed = this.zoomScale > 1.02;

    if (stage) {
      stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomScale})`;
      stage.classList.toggle('is-zoomed', nowZoomed);
    }

    if (nowZoomed !== this.isZoomed) {
      this.isZoomed = nowZoomed;
      this.onZoomChange(nowZoomed);
    }
  }

  resetZoom() {
    this.zoomScale = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyZoomTransform();
  }

  /* ------------------------------------------------------------------ */
  /* 정주행 자동 넘김                                                    */
  /* ------------------------------------------------------------------ */

  toggleAutoPlay() {
    this.isAutoPlaying ? this.stopAutoPlay() : this.startAutoPlay();
    this.emitPageChange();
    return this.isAutoPlaying;
  }

  startAutoPlay() {
    this.stopAutoPlay();
    this.isAutoPlaying = true;
    this.autoPlayTimer = setInterval(() => this.nextPage(), this.autoPlaySpeed * 1000);
  }

  stopAutoPlay() {
    this.isAutoPlaying = false;
    if (this.autoPlayTimer) {
      clearInterval(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
  }

  setAutoPlaySpeed(seconds) {
    this.autoPlaySpeed = clamp(seconds, 1, 60);
    if (this.isAutoPlaying) this.startAutoPlay();
  }

  destroy() {
    this.stopAutoPlay();
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    if (this.stripObserver) this.stripObserver.disconnect();
    this.releaseImageCache();
  }
}

/* ==================================================================== */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function touchDistance(touches) {
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY
  );
}

/** 재시도 시 브라우저·프록시 캐시를 건너뛰게 한다 */
function bust(url) {
  return url + (url.includes('?') ? '&' : '?') + '_r=' + Math.random().toString(36).slice(2);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
