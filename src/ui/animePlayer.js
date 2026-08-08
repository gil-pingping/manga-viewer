/**
 * @file animePlayer.js
 * 애니메이션 비디오 플레이어 오버레이, 0초 지연 다음화 연속 재생 및 정밀 오프닝/엔딩 스킵 엔진
 */

export class AnimePlayer {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.onNextEpisode = options.onNextEpisode || (() => {});
    this.onPrevEpisode = options.onPrevEpisode || (() => {});

    this.currentAnime = null;
    this.nextPrefetchedAnime = null;
    this.isOpeningAutoSkip = true;
    this.isEndingAutoSkip = true;
    this.hasSkippedOp = false;

    this.initUI();
  }

  initUI() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'anime-player-overlay';
    this.overlay.hidden = true;

    this.overlay.innerHTML = `
      <div class="anime-player-header">
        <button type="button" class="anime-back-btn" id="anime-back-btn">← 서재로</button>
        <h2 class="anime-player-title" id="anime-player-title">애니메이션</h2>
        <span class="anime-player-badge" id="anime-player-badge"></span>
      </div>

      <div class="anime-video-container" id="anime-video-container">
        <video id="anime-video" class="anime-video" controls playsinline></video>
        <iframe id="anime-iframe" class="anime-iframe" hidden frameborder="0" allowfullscreen></iframe>
        <div class="anime-skip-toast" id="anime-skip-toast" hidden>오프닝 스킵 적용됨 (+90s)</div>
      </div>

      <div class="anime-player-controls">
        <div class="anime-controls-row">
          <button type="button" class="btn btn-sm" id="btn-anime-prev">⏪ 이전화</button>
          <button type="button" class="btn btn-sm" id="btn-anime-seek-back">◀️ 10초</button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-anime-skip-op">⏭️ 오프닝 건너뛰기</button>
          <button type="button" class="btn btn-sm" id="btn-anime-seek-forward">10초 ▶️</button>
          <button type="button" class="btn btn-sm" id="btn-anime-next">⏩ 다음화</button>
          <select id="anime-playback-rate" class="anime-speed-select">
            <option value="1.0">1.0x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2.0">2.0x</option>
          </select>
        </div>
      </div>
    `;

    this.container.appendChild(this.overlay);

    this.videoEl = this.overlay.querySelector('#anime-video');
    this.iframeEl = this.overlay.querySelector('#anime-iframe');
    this.titleEl = this.overlay.querySelector('#anime-player-title');
    this.badgeEl = this.overlay.querySelector('#anime-player-badge');
    this.skipToastEl = this.overlay.querySelector('#anime-skip-toast');

    this.bindEvents();
  }

  bindEvents() {
    this.overlay.querySelector('#anime-back-btn').onclick = () => this.close();
    this.overlay.querySelector('#btn-anime-prev').onclick = () => this.onPrevEpisode();
    this.overlay.querySelector('#btn-anime-next').onclick = () => this.onNextEpisode();

    this.overlay.querySelector('#btn-anime-seek-back').onclick = () => {
      if (this.videoEl) this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - 10);
    };
    this.overlay.querySelector('#btn-anime-seek-forward').onclick = () => {
      if (this.videoEl) this.videoEl.currentTime += 10;
    };

    this.overlay.querySelector('#btn-anime-skip-op').onclick = () => this.triggerOpSkip();

    const speedSelect = this.overlay.querySelector('#anime-playback-rate');
    speedSelect.onchange = (e) => {
      if (this.videoEl) this.videoEl.playbackRate = parseFloat(e.target.value);
    };

    // 정밀 스킵 & 엔딩 감지 0.2초 주간 모니터링
    this.videoEl.ontimeupdate = () => this.handleTimeUpdate();
    this.videoEl.onended = () => {
      if (this.isEndingAutoSkip) this.onNextEpisode();
    };
  }

  loadAnime(animeData) {
    this.currentAnime = animeData;
    this.hasSkippedOp = false;
    this.overlay.hidden = false;

    this.titleEl.textContent = `${animeData.seriesTitle} - ${animeData.episodeNumber}화`;
    if (animeData.episodeTitle) {
      this.badgeEl.textContent = animeData.episodeTitle;
    }

    if (animeData.streamUrl) {
      this.iframeEl.hidden = true;
      this.videoEl.hidden = false;
      this.videoEl.src = animeData.streamUrl;
      this.videoEl.play().catch(() => {});
    } else if (animeData.embedUrl) {
      this.videoEl.hidden = true;
      this.iframeEl.hidden = false;
      this.iframeEl.src = animeData.embedUrl;
    }
  }

  triggerOpSkip() {
    if (!this.videoEl || !this.currentAnime) return;
    const op = this.currentAnime.timestamps?.op;
    const seekTarget = op?.endTime || (this.videoEl.currentTime + 90);
    this.videoEl.currentTime = seekTarget;
    this.showToast('오프닝 건너뛰기 완료!');
  }

  handleTimeUpdate() {
    if (!this.videoEl || !this.currentAnime) return;
    const currentTime = this.videoEl.currentTime;
    const duration = this.videoEl.duration;

    const op = this.currentAnime.timestamps?.op;
    const ed = this.currentAnime.timestamps?.ed;

    // 1. 정밀 오프닝 스킵 감지
    if (this.isOpeningAutoSkip && !this.hasSkippedOp && op && op.startTime && op.endTime) {
      if (currentTime >= op.startTime && currentTime < op.endTime) {
        this.hasSkippedOp = true;
        this.videoEl.currentTime = op.endTime;
        this.showToast('정밀 오프닝 자동 스킵 적용 (0.1s 정밀)');
      }
    }

    // 2. 정밀 엔딩 스킵 & 다음화 자동 연결 감지
    if (this.isEndingAutoSkip && ed && ed.startTime) {
      if (currentTime >= ed.startTime) {
        this.showToast('엔딩 구간 감지 -> 다음화 0초 자동 연속 전환!');
        this.onNextEpisode();
      }
    }
  }

  showToast(msg) {
    this.skipToastEl.textContent = msg;
    this.skipToastEl.hidden = false;
    setTimeout(() => {
      this.skipToastEl.hidden = true;
    }, 2000);
  }

  close() {
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.src = '';
    }
    if (this.iframeEl) this.iframeEl.src = '';
    this.overlay.hidden = true;
  }
}
