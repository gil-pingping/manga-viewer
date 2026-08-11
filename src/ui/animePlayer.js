import Hls, { LoadStats } from 'hls.js';

function createResourceLoader(loadResource) {
  return class ResourceLoader {
    constructor() {
      this.stats = new LoadStats();
      this.controller = new AbortController();
      this.callbacks = null;
      this.context = null;
      this.terminal = false;
    }

    load(context, config, callbacks) {
      this.context = context;
      this.callbacks = callbacks;
      this.stats.loading.start = performance.now();
      const configuredTimeout = config.loadPolicy.maxLoadTimeMs || config.timeout;
      const timeoutMs = Number.isFinite(configuredTimeout) ? configuredTimeout : 20000;
      this.timeout = setTimeout(() => {
        if (this.terminal) return;
        this.terminal = true;
        this.stats.aborted = true;
        this.controller.abort();
        callbacks.onTimeout(this.stats, context, null);
      }, timeoutMs);
      const range = context.rangeEnd
        ? `bytes=${context.rangeStart}-${context.rangeEnd - 1}`
        : '';
      loadResource(context.url, {
        responseType: context.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
        range,
        signal: this.controller.signal,
      }).then(({ data, status }) => {
        if (this.terminal) return;
        this.terminal = true;
        clearTimeout(this.timeout);
        const end = performance.now();
        this.stats.loading.first = end;
        this.stats.loading.end = end;
        this.stats.loaded = this.stats.total = data.byteLength ?? data.length;
        callbacks.onProgress?.(this.stats, context, data, null);
        callbacks.onSuccess({ url: context.url, data, code: status }, this.stats, context, null);
      }).catch((error) => {
        if (this.terminal) return;
        this.terminal = true;
        clearTimeout(this.timeout);
        callbacks.onError(
          { code: error.status || 0, text: error.message },
          context,
          null,
          this.stats
        );
      });
    }

    abort() {
      if (this.terminal) return;
      this.terminal = true;
      this.stats.aborted = true;
      clearTimeout(this.timeout);
      this.controller.abort();
      this.callbacks?.onAbort?.(this.stats, this.context, null);
    }

    destroy() {
      this.abort();
      this.callbacks = null;
      this.context = null;
    }

    getCacheAge() {
      return null;
    }

    getResponseHeader() {
      return null;
    }
  };
}

export class AnimePlayer {
  constructor({ container = document.body, loadResource, onNext, onPrev, onClose, onError } = {}) {
    this.loadResource = loadResource;
    this.onNext = onNext || (() => {});
    this.onPrev = onPrev || (() => {});
    this.onClose = onClose || (() => {});
    this.onError = onError || (() => {});
    this.currentAnime = null;
    this.hls = null;
    this.hasSkippedOpening = false;

    this.overlay = document.createElement('div');
    this.overlay.className = 'anime-player-overlay';
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', '애니 플레이어');
    this.overlay.innerHTML = `
      <header class="anime-player-header">
        <button type="button" class="anime-back-btn">← 서재</button>
        <div class="anime-player-heading">
          <strong class="anime-player-title">애니메이션</strong>
          <span class="anime-player-badge"></span>
        </div>
      </header>
      <div class="anime-video-container">
        <video class="anime-video" controls playsinline preload="metadata"></video>
        <div class="anime-player-status" role="status">영상 준비 중…</div>
        <div class="anime-skip-toast" hidden></div>
      </div>
      <footer class="anime-player-controls">
        <button type="button" class="btn btn-sm anime-prev">⏮ 이전화</button>
        <button type="button" class="btn btn-sm anime-seek-back">−10초</button>
        <button type="button" class="btn btn-sm btn-primary anime-skip-op">오프닝 스킵</button>
        <button type="button" class="btn btn-sm anime-seek-forward">+10초</button>
        <button type="button" class="btn btn-sm anime-next">다음화 ⏭</button>
        <select class="anime-speed-select" aria-label="재생 속도">
          <option value="1">1.0×</option>
          <option value="1.25">1.25×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2.0×</option>
        </select>
      </footer>
    `;
    container.appendChild(this.overlay);

    this.video = this.overlay.querySelector('.anime-video');
    this.title = this.overlay.querySelector('.anime-player-title');
    this.badge = this.overlay.querySelector('.anime-player-badge');
    this.status = this.overlay.querySelector('.anime-player-status');
    this.skipToast = this.overlay.querySelector('.anime-skip-toast');
    this.prevButton = this.overlay.querySelector('.anime-prev');
    this.nextButton = this.overlay.querySelector('.anime-next');

    this.overlay.querySelector('.anime-back-btn').addEventListener('click', () => this.close());
    this.prevButton.addEventListener('click', () => this.navigate('prev'));
    this.nextButton.addEventListener('click', () => this.navigate('next'));
    this.overlay.querySelector('.anime-seek-back').addEventListener('click', () => {
      this.video.currentTime = Math.max(0, this.video.currentTime - 10);
    });
    this.overlay.querySelector('.anime-seek-forward').addEventListener('click', () => {
      this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10);
    });
    this.overlay.querySelector('.anime-skip-op').addEventListener('click', () => this.skipOpening());
    this.overlay.querySelector('.anime-speed-select').addEventListener('change', (event) => {
      this.video.playbackRate = Number(event.target.value) || 1;
    });
    this.video.addEventListener('loadedmetadata', () => {
      this.status.hidden = true;
      this.video.play().catch(() => {});
    });
    this.video.addEventListener('timeupdate', () => this.autoSkipOpening());
    this.video.addEventListener('ended', () => this.navigate('next'));
  }

  destroyStream() {
    this.hls?.destroy();
    this.hls = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  load(anime) {
    this.destroyStream();
    this.currentAnime = anime;
    this.hasSkippedOpening = false;
    this.title.textContent = anime.seriesTitle;
    this.badge.textContent = `${anime.episodeNumber}화${anime.episodeTitle ? ` · ${anime.episodeTitle}` : ''}`;
    this.prevButton.disabled = !anime.navigation?.prev;
    this.nextButton.disabled = !anime.navigation?.next;
    this.status.hidden = false;
    this.status.textContent = '영상 준비 중…';
    this.overlay.hidden = false;

    if (Hls.isSupported()) {
      const config = { enableWorker: true };
      if (this.loadResource) config.loader = createResourceLoader(this.loadResource);
      else {
        config.xhrSetup = (xhr, url) => {
          xhr.open('GET', `/api/anilife-stream?url=${encodeURIComponent(url)}`, true);
        };
      }
      this.hls = new Hls(config);
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) this.fail(new Error(`영상 스트림 오류: ${data.details}`));
      });
      this.hls.loadSource(anime.streamUrl);
      this.hls.attachMedia(this.video);
      return;
    }
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = anime.streamUrl;
      return;
    }
    this.fail(new Error('이 브라우저는 HLS 영상을 재생할 수 없습니다.'));
  }

  fail(error) {
    this.status.hidden = false;
    this.status.textContent = error.message;
    this.onError(error);
  }

  navigate(direction) {
    const target = this.currentAnime?.navigation?.[direction];
    if (!target) return;
    (direction === 'next' ? this.onNext : this.onPrev)(target);
  }

  skipOpening() {
    const end = this.currentAnime?.timestamps?.op?.endTime;
    this.video.currentTime = end || Math.min(this.video.duration || Infinity, this.video.currentTime + 90);
    this.showSkipToast('오프닝 스킵');
  }

  autoSkipOpening() {
    const opening = this.currentAnime?.timestamps?.op;
    if (
      this.hasSkippedOpening ||
      !opening ||
      this.video.currentTime < opening.startTime ||
      this.video.currentTime >= opening.endTime
    ) return;
    this.hasSkippedOpening = true;
    this.video.currentTime = opening.endTime;
    this.showSkipToast('오프닝 자동 스킵');
  }

  showSkipToast(message) {
    this.skipToast.textContent = message;
    this.skipToast.hidden = false;
    clearTimeout(this.skipToastTimer);
    this.skipToastTimer = setTimeout(() => {
      this.skipToast.hidden = true;
    }, 1800);
  }

  close() {
    this.destroyStream();
    this.overlay.hidden = true;
    this.currentAnime = null;
    this.onClose();
  }
}
