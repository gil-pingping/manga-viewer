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

const MAX_CACHED_IMAGES = 40;
const PRELOAD_AHEAD = 8;
const PRELOAD_BEHIND = 3;
const MAX_ZOOM = 4;
const SWIPE_THRESHOLD_PX = 55;
const STRIP_END_WHEEL_COOLDOWN_MS = 600;

export class ReaderEngine {
  constructor(options = {}) {
    this.container = options.container;
    this.pages = [];
    this.segments = [];
    this.currentIndex = 0;
    this.episode = null;

    this.mode = options.mode || 'auto';
    this.direction = options.direction || 'RTL';
    this.transitionType = options.transitionType || 'slide';
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
    this.onImageFailure = options.onImageFailure || (() => {});
    this.resolvePageUrl = options.resolvePageUrl || ((page) => ({ url: page.url, owned: false }));

    this.handleResize = debounce(() => this.onViewportResize(), 150);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleResize);

    this.setupGestures();
    this.setupStripTracking();
  }

  /**
   * 리사이즈. 태블릿은 시스템 바가 들고 나며 높이만 바뀌는 resize 가 잦다.
   * strip 은 DOM 을 갈아엎지 않는다 — 재렌더는 가상화한 컷의 실측 높이를 잃어
   * 같은 scrollTop 이 다른 컷을 가리키게 되고(실측: 정주행 중 다음 화 중간으로 튐),
   * 가로폭이 바뀌었을 때만 읽던 컷 머리로 다시 앵커한다.
   */
  onViewportResize() {
    if (this.__lastRenderMode !== 'strip' || this.getEffectiveMode() !== 'strip') {
      this.render();
      return;
    }
    const width = this.container.clientWidth;
    if (width === this.__stripWidth) return;
    this.__stripWidth = width;
    this.scrollStripToIndex(this.currentIndex);
  }

  /** strip 재렌더 전후로 "몇 번째 컷의 몇 px 아래" 를 기억한다. px 만 저장하면 자리 예약 높이가 바뀔 때 어긋난다. */
  captureStripAnchor() {
    const el = this.container.querySelector(`[data-index="${this.currentIndex}"]`);
    const offset = el ? Math.max(0, this.container.scrollTop - el.offsetTop) : 0;
    return { index: this.currentIndex, offset };
  }

  restoreStripAnchor({ index, offset }) {
    const el = this.container.querySelector(`[data-index="${index}"]`);
    if (!el) return;
    const top = el.offsetTop + Math.min(offset, Math.max(0, el.offsetHeight - 1));
    this.container.scrollTo({ top, behavior: 'instant' });
  }

  /* ------------------------------------------------------------------ */
  /* 챕터 로드                                                           */
  /* ------------------------------------------------------------------ */

  loadChapter(episodeData, initialPageNum = 1) {
    this.episode = episodeData;
    const segment = this.createSegment(episodeData, 0);
    this.segments = [segment];
    this.pages = this.cloneChapterPages(episodeData, segment);
    this.currentIndex = clamp(initialPageNum - 1, 0, Math.max(0, this.pages.length - 1));

    this.releaseImageCache();
    this.measuredRatios = [];
    this.__lastRenderMode = null; // 새 화는 저장된 페이지로 앵커한다 (스크롤 보존 아님)
    this.container?.style.removeProperty('--strip-cut-ratio'); // 화마다 컷 크기가 다르다
    this.resetZoom();
    this.render();
    this.probeLeadingImages();
  }

  createSegment(episodeData, startIndex) {
    const pageCount = Array.isArray(episodeData?.pages) ? episodeData.pages.length : 0;
    return {
      chapterId: episodeData?.id ?? null,
      sourceUrl: episodeData?.sourceUrl || episodeData?.targetUrl || null,
      title: episodeData?.title || '',
      label: episodeData?.label || '',
      startIndex,
      pageCount,
    };
  }

  cloneChapterPages(episodeData, segment) {
    return (Array.isArray(episodeData?.pages) ? episodeData.pages : []).map((page, index) => ({
      ...page,
      chapterId: segment.chapterId,
      chapterSourceUrl: segment.sourceUrl,
      chapterTitle: segment.title,
      chapterLabel: segment.label,
      chapterPageNumber: index + 1,
    }));
  }

  /** strip 정주행: 현재 DOM을 갈아엎지 않고 다음 화를 아래에 붙인다. */
  appendChapter(episodeData) {
    if (this.getEffectiveMode() !== 'strip') return false;

    const segment = this.createSegment(episodeData, this.pages.length);
    if (!segment.pageCount) return false;
    if (
      this.segments.some(
        (existing) =>
          (segment.chapterId != null && existing.chapterId === segment.chapterId) ||
          (segment.sourceUrl && existing.sourceUrl === segment.sourceUrl)
      )
    ) {
      return false;
    }

    const pages = this.cloneChapterPages(episodeData, segment);
    const savedScrollTop = this.container.scrollTop;
    this.segments.push(segment);
    this.pages.push(...pages);
    const frag = document.createDocumentFragment();
    pages.forEach((page, offset) => {
      const wrapper = this.createStripPage(page, segment.startIndex + offset);
      if (wrapper) frag.appendChild(wrapper);
    });

    this.container.appendChild(frag);
    this.observeStripPages();
    this.container.scrollTop = savedScrollTop;
    return true;
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
      // 출처 주소의 /webtoon/ 표식 — 3:4 조각 웹툰(뉴토키)은 비율로 못 가른다
      sourceUrl: this.episode?.sourceUrl || this.episode?.targetUrl || null,
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

  getImageElement(index, { defer = false } = {}) {
    const page = this.pages[index];
    if (!page || !page.url) return null;

    const cached = this.imageCache.get(page.url);
    if (cached) {
      if (!defer) this.loadImageElement(cached, page, index);
      return cached;
    }

    const img = document.createElement('img');
    img.className = 'manga-img is-loading';
    img.alt = page.name || `Page ${page.pageNumber}`;
    img.decoding = 'async';
    img.draggable = false;

    img.addEventListener('load', () => {
      img.__retries = 0;
      img.classList.remove('is-loading');
      img.classList.remove('is-error');
      const holder = img.closest('.manga-page-wrapper, .manga-strip-page');
      holder?.classList.remove('load-failed');
      holder?.classList.add('is-loaded'); // 자리 예약(min-height) 해제
      holder?.style.removeProperty('min-height'); // 가상화 때 박아둔 높이도 — 남으면 컷 아래 검은 띠
      // 브라우저는 이미 바이트를 읽었다. URL 매핑만 즉시 놓아 원본 Blob을 붙들지 않는다.
      this.releaseOwnedUrl(img);
      this.recordRatio(index, img.naturalWidth, img.naturalHeight);
    });

    img.addEventListener('error', () => {
      // 일시적 네트워크 오류가 종종 있다 — 실패 표시 전에 캐시를 우회해 두 번 더 받아본다
      const retries = img.__retries || 0;
      if (retries < 2) {
        img.__retries = retries + 1;
        setTimeout(() => {
          if (this.imageCache.get(page.url) !== img) return; // 그 사이 화가 바뀌었으면 포기
          this.loadImageElement(img, page, index, { reload: true });
        }, 700 * (retries + 1));
        return;
      }
      this.markImageFailed(img, page);
    });

    this.imageCache.set(page.url, img);
    if (!defer) this.loadImageElement(img, page, index);
    this.evictDistantImages();
    return img;
  }

  loadImageElement(img, page, index, { reload = false } = {}) {
    if (!img || (img.__loadStarted && !reload)) return;

    if (reload) this.releaseOwnedUrl(img);
    img.__loadStarted = true;
    img.classList.add('is-loading');
    img.classList.remove('is-error');
    const loadToken = (img.__loadToken || 0) + 1;
    img.__loadToken = loadToken;

    Promise.resolve(this.resolvePageUrl(page))
      .then((resolved) => {
        const value = typeof resolved === 'string' ? { url: resolved, owned: false } : resolved;
        if (!value?.url) throw new Error('표시할 이미지 주소가 없습니다.');

        // 비동기 네이티브 요청 동안 화가 바뀌거나 캐시에서 밀렸으면 바이트를 즉시 놓는다.
        if (img.__loadToken !== loadToken || this.imageCache.get(page.url) !== img) {
          if (value.owned && value.url.startsWith('blob:')) URL.revokeObjectURL(value.url);
          return;
        }

        img.__ownedObjectUrl = value.owned ? value.url : null;
        // blob:·data: 에 캐시 우회 쿼리를 붙이면 주소 자체가 깨진다 (서재에서 꺼낸 컷)
        const cacheable = !value.owned && !/^(blob:|data:)/i.test(value.url);
        img.src = reload && cacheable ? bust(value.url) : value.url;
      })
      .catch((err) => {
        if (img.__loadToken !== loadToken) return;
        console.warn(`[이미지 ${index + 1}]`, err);
        this.markImageFailed(img, page);
      });
  }

  markImageFailed(img, page) {
    img.classList.remove('is-loading');
    img.classList.add('is-error');
    img.closest('.manga-page-wrapper, .manga-strip-page')?.classList.add('load-failed');
    // 재시도까지 다 쓴 진짜 실패다. 어느 화의 컷인지 알려주면 바깥에서 복구할 수 있다
    this.onImageFailure(page?.chapterId ?? null);
  }

  releaseOwnedUrl(img) {
    if (img?.__ownedObjectUrl) URL.revokeObjectURL(img.__ownedObjectUrl);
    if (img) img.__ownedObjectUrl = null;
  }

  releaseImageElement(img) {
    if (!img) return;
    img.__loadToken = (img.__loadToken || 0) + 1;
    this.releaseOwnedUrl(img);
    img.remove();
  }

  /**
   * 비율을 기록하고, 그 결과가 지금 배치를 바꿔야 하면 한 번만 다시 그린다.
   * (측정 → 재렌더 → 측정 무한 루프를 막기 위해 page.__measured 로 한 번만 처리한다)
   */
  recordRatio(index, w, h) {
    const page = this.pages[index];
    if (!page || !w || !h) return;

    // 웹툰 컷은 크기가 균일하다 — 첫 실측 비율을 미로드 자리 예약에 적용하면
    // 로드 때 높이 차이가 거의 없어 스크롤이 출렁이지 않는다.
    if (this.container && !this.container.style.getPropertyValue('--strip-cut-ratio')) {
      this.container.style.setProperty('--strip-cut-ratio', `${w} / ${h}`);
      // 자리 예약 높이가 방금 확정됐다 — 렌더 때 잡아둔 컷으로 다시 앵커한다
      if (this.__stripAnchorIndex != null && this.getEffectiveMode() === 'strip') {
        this.scrollStripToIndex(this.__stripAnchorIndex);
        this.__stripAnchorIndex = null;
      }
    }

    // 비율 추가가 auto 판정을 실제로 바꿀 때만 다시 그린다.
    // 예전엔 auto 모드에서 이미지가 로드될 때마다 전체 재렌더를 돌려서
    // 연속 스크롤이 읽는 중에 계속 튀었다 (재렌더가 스크롤 위치를 앵커로 되돌린다).
    const modeBefore = this.getEffectiveMode();

    if (this.measuredRatios.length < 12) this.measuredRatios.push({ w, h });

    if (page.__measured) return;
    page.__measured = true;

    const wasSpread = page.isSpread === true;
    const isSpread = isSpreadRatio(w, h);
    page.isSpread = isSpread;

    const modeChanged = this.getEffectiveMode() !== modeBefore;
    const spreadChanged = isSpread !== wasSpread && this.isNearVisible(index);
    // strip 은 펼침 개념이 없다 — 여기서 재렌더하면 읽던 위치가 튄다
    if (modeChanged || (spreadChanged && this.getEffectiveMode() !== 'strip')) this.render();
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
      // fragment 안(아직 붙이기 전)의 img 도 wrapper 가 들고 있다 — 빼면 컷 자리가 비어 검게 뜬다
      if (el.isConnected || el.parentNode) continue;
      this.imageCache.delete(url);
      this.releaseImageElement(el);
    }
  }

  releaseImageCache() {
    for (const el of this.imageCache.values()) this.releaseImageElement(el);
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
    const page = this.getPageForCurrentChapter(pageNumber);
    if (!page) return;
    const target = this.pages.indexOf(page);

    if (this.getEffectiveMode() === 'strip') {
      this.currentIndex = target;
      this.__stripAnchorIndex = null; // 사용자가 직접 이동했다 — 늦은 재앵커로 되돌리지 않는다
      this.scrollStripToIndex(target);
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
      this.onEpisodeEnd();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 렌더                                                                */
  /* ------------------------------------------------------------------ */

  render() {
    if (!this.container || !this.pages.length) return;

    const mode = this.getEffectiveMode();
    // 이미 연속 스크롤을 읽는 중에 다시 그리면(리사이즈 등) 위치를 지켜야 한다.
    // 매번 앵커로 점프하면 읽던 자리를 잃는다.
    const keepScroll = mode === 'strip' && this.__lastRenderMode === 'strip';
    this.__lastRenderMode = mode;

    this.container.className = `manga-viewport mode-${mode} dir-${this.direction.toLowerCase()}`;

    if (mode === 'strip') this.renderStrip({ keepScroll });
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
  renderStrip({ keepScroll = false } = {}) {
    const anchor = keepScroll ? this.captureStripAnchor() : null;
    const frag = document.createDocumentFragment();

    this.pages.forEach((page, index) => {
      const wrapper = this.createStripPage(page, index);
      if (wrapper) frag.appendChild(wrapper);
    });

    this.container.replaceChildren(frag);
    this.observeStripPages();
    this.__stripWidth = this.container.clientWidth;

    if (anchor) {
      // 읽던 컷 유지 (모드·방향 변경으로 인한 재렌더). 새 DOM 의 자리 예약 높이는 이전과 다르다
      this.restoreStripAnchor(anchor);
      return;
    }
    // 자리 예약 높이가 아직 추정치다 — 첫 실측 비율이 잡히면 recordRatio 가
    // 이 인덱스로 다시 앵커한다 (안 그러면 위쪽이 자라며 읽던 페이지가 밀린다)
    this.__stripAnchorIndex = this.currentIndex;
    this.scrollStripToIndex(this.currentIndex);
  }

  createStripPage(page, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'manga-strip-page';
    wrapper.dataset.index = String(index);

    const img = this.getImageElement(index, { defer: index >= 3 && !!this.stripLoadObserver });
    if (!img) return null;
    img.loading = index < 3 ? 'eager' : 'lazy';
    if (img.complete && img.naturalWidth > 0) wrapper.classList.add('is-loaded');

    const retry = document.createElement('button');
    retry.className = 'page-retry';
    retry.type = 'button';
    retry.textContent = '이미지 실패 · 다시 시도';
    retry.addEventListener('click', (e) => {
      e.stopPropagation();
      this.retryPage(index);
    });

    wrapper.append(img, retry);
    return wrapper;
  }

  /** 연속 스크롤에서 특정 컷의 머리로 즉시 이동 (CSS smooth 를 타지 않는다) */
  scrollStripToIndex(index) {
    const target = this.container.querySelector(`[data-index="${index}"]`);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' });
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
    this.releaseImageElement(this.imageCache.get(page.url));
    this.imageCache.delete(page.url);
    const fresh = this.getImageElement(index);
    if (!fresh) return;
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

  getPageInfo() {
    const segment = this.getCurrentSegment();
    const currentPageNum = segment ? this.currentIndex - segment.startIndex + 1 : 0;
    return {
      currentIndex: this.currentIndex,
      currentPageNum,
      totalPages: segment?.pageCount || 0,
      effectiveMode: this.getEffectiveMode(),
      chapterId: segment?.chapterId ?? null,
      title: segment?.title || '',
      label: segment?.label || '',
    };
  }

  getCurrentSegment() {
    return (
      this.segments.find(
        (segment) =>
          this.currentIndex >= segment.startIndex &&
          this.currentIndex < segment.startIndex + segment.pageCount
      ) || null
    );
  }

  getPageForCurrentChapter(pageNumber) {
    const segment = this.getCurrentSegment();
    if (!segment) return null;
    const localIndex = clamp(Number(pageNumber) - 1 || 0, 0, segment.pageCount - 1);
    return this.pages[segment.startIndex + localIndex] || null;
  }

  emitPageChange() {
    this.onPageChange(this.getPageInfo());
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

    this.stripLoadObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.index);
          if (!Number.isFinite(index)) continue;

          if (entry.isIntersecting) {
            const img = this.getImageElement(index);
            if (img && !entry.target.contains(img)) {
              entry.target.prepend(img);
              if (img.complete && img.naturalWidth > 0) {
                entry.target.classList.add('is-loaded');
                entry.target.style.removeProperty('min-height');
              }
            }
            entry.target.classList.remove('is-virtualized');
          } else {
            // 화면 밖으로 멀어진 이미지 노드는 DOM에서 떼어 OOM을 방지한다 (높이는 유지)
            const img = entry.target.querySelector('img.manga-img');
            if (img && Math.abs(index - this.currentIndex) > 4) {
              if (entry.target.offsetHeight > 0) {
                entry.target.style.minHeight = `${entry.target.offsetHeight}px`;
              }
              img.remove();
              entry.target.classList.add('is-virtualized');
            }
          }
        }
      },
      { root: this.container, threshold: 0, rootMargin: '200% 0px 200% 0px' }
    );
  }

  observeStripPages() {
    if (!this.stripObserver) return;
    this.stripObserver.disconnect();
    this.stripLoadObserver?.disconnect();
    for (const el of this.container.querySelectorAll('.manga-strip-page')) {
      this.stripObserver.observe(el);
      this.stripLoadObserver?.observe(el);
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
    let stripStartedAtBottom = false;
    let lastStripWheelAt = -Infinity;
    let lastTapAt = 0;

    const touchStart = (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        isDragging = false;
        stripStartedAtBottom = false;
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
        stripStartedAtBottom =
          this.getEffectiveMode() === 'strip' &&
          this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 8;
      }
    };

    const touchMove = (e) => {
      if (isDragging && this.getEffectiveMode() === 'strip' && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - dragStartX;
        const dy = t.clientY - dragStartY;
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) this.__stripAnchorIndex = null;
      }

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

        if (
          this.getEffectiveMode() === 'strip' &&
          stripStartedAtBottom &&
          -dy >= SWIPE_THRESHOLD_PX &&
          -dy > Math.abs(dx)
        ) {
          stripStartedAtBottom = false;
          this.onEpisodeEnd();
        }

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
      stripStartedAtBottom = false;

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

    const wheel = (e) => {
      if (this.getEffectiveMode() !== 'strip' || e.deltaY <= 0) return;
      const startedAtBottom =
        this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 8;
      const now = performance.now();
      const startsNewGesture = now - lastStripWheelAt >= STRIP_END_WHEEL_COOLDOWN_MS;
      lastStripWheelAt = now;
      if (!startedAtBottom || !startsNewGesture) return;
      this.onEpisodeEnd();
    };

    this.container.addEventListener('touchstart', touchStart, { passive: true });
    this.container.addEventListener('touchmove', touchMove, { passive: true });
    this.container.addEventListener('touchend', touchEnd, { passive: true });
    this.container.addEventListener('wheel', wheel, { passive: true });
    this.__stripWheelHandler = wheel;

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

  destroy() {
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    this.container?.removeEventListener('wheel', this.__stripWheelHandler);
    if (this.stripObserver) this.stripObserver.disconnect();
    if (this.stripLoadObserver) this.stripLoadObserver.disconnect();
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
