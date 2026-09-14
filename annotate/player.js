/* Playback state is separate from annotation timestamps and save revisions. */
(function (root) {
  const RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
  class AnnotationPlayer {
    constructor(video, {storage, key, onChange = () => {}, onError = () => {}} = {}) {
      this.video = video; this.storage = storage; this.key = key;
      this.onChange = onChange; this.onError = onError; this.range = null;
      this.available = false; this.duration = 0; this.rate = 1; this.frame = null;
      try { const value = Number(storage?.getItem(key)); if (RATES.includes(value)) this.rate = value; } catch {}
      this.applyRate();
      video.addEventListener('loadedmetadata', () => { this.applyRate(); this.onChange(); });
      video.addEventListener('ratechange', () => {
        if (RATES.includes(video.playbackRate)) {
          this.rate = video.playbackRate;
          try { this.storage?.setItem(this.key, String(this.rate)); } catch {}
        }
        this.onChange();
      });
      video.addEventListener('play', () => { this.watchFrames(); this.onChange(); });
      video.addEventListener('pause', () => { this.cancelFrame(); this.onChange(); });
      video.addEventListener('timeupdate', () => this.checkRange());
      video.addEventListener('ended', () => {
        if (this.range?.loop && this.available) { video.currentTime = this.range.start; this.play(); }
        else { this.range = null; this.onChange(); }
      });
    }
    applyRate() { this.video.defaultPlaybackRate = this.rate; this.video.playbackRate = this.rate; }
    setRate(value) {
      value = Number(value); if (!RATES.includes(value)) return false;
      this.rate = value; this.applyRate();
      try { this.storage?.setItem(this.key, String(value)); } catch {}
      this.onChange(); return true;
    }
    stepRate(direction) { this.setRate(RATES[Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(this.rate) + direction))]); }
    reset(duration = 0, available = false) {
      this.video.pause(); this.range = null; this.cancelFrame();
      this.duration = Number.isFinite(duration) ? duration : 0;
      this.available = available; this.applyRate(); this.onChange();
    }
    async play() {
      if (!this.available) return;
      try { await this.video.play(); }
      catch (error) { if (error.name !== 'AbortError') this.onError('播放未开始：' + error.message); }
    }
    toggle() { if (!this.available) return; this.video.paused ? this.play() : this.video.pause(); }
    seek(time, {keepRange = false} = {}) {
      if (!this.available || !Number.isFinite(time)) return;
      if (!keepRange) this.clearRange();
      const duration = Math.min(this.duration || Infinity, Number.isFinite(this.video.duration) ? this.video.duration : Infinity);
      this.video.currentTime = Math.max(0, Math.min(duration, time)); this.onChange();
    }
    skip(seconds) { this.seek(this.video.currentTime + seconds); }
    playSegment(start, end, loop = false) {
      if (!this.available || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > this.duration) return;
      this.range = {start, end, loop}; this.seek(start, {keepRange:true}); this.play(); this.onChange();
    }
    clearRange() { this.range = null; this.onChange(); }
    checkRange() {
      if (!this.range || this.video.paused) return;
      const {start, end, loop} = this.range;
      if (this.video.currentTime >= end) {
        if (loop) this.video.currentTime = start;
        else { this.range = null; this.video.pause(); this.video.currentTime = end; }
        this.onChange();
      } else if (this.video.currentTime < start - 0.05) this.clearRange();
    }
    watchFrames() {
      if (!this.video.requestVideoFrameCallback || this.frame !== null) return;
      this.frame = this.video.requestVideoFrameCallback(() => {
        this.frame = null; this.checkRange();
        if (!this.video.paused) this.watchFrames();
      });
    }
    cancelFrame() {
      if (this.frame !== null) this.video.cancelVideoFrameCallback?.(this.frame);
      this.frame = null;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {AnnotationPlayer, RATES};
  else { root.AnnotationPlayer = AnnotationPlayer; root.PLAYBACK_RATES = RATES; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
