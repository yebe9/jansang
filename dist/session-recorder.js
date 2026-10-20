/* Optional video for the user's private log. Reuses an already-permitted camera
 * stream, clones video tracks only, and never opens a camera or microphone.
 * Recording pauses exclude unobserved and manually paused capture intervals.
 */
(() => {
  'use strict';
  const MAX_BYTES = 15 * 1024 * 1024;
  const MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

  class GhostingSessionRecorder {
    constructor({maxBytes = MAX_BYTES, onState = () => {}} = {}) {
      this.maxBytes = Math.min(MAX_BYTES, Math.max(1, maxBytes));
      this.onState = onState;
      this._generation = 0;
      this._recorder = null;
      this._tracks = [];
      this._chunks = [];
      this._bytes = 0;
      this._blob = null;
      this._failed = false;
      this._resolveStop = null;
      this._stopPromise = null;
      this._stopTimer = null;
    }

    _report(kind, message) {
      this.onState({kind, message, bytes:this._bytes});
    }

    _releaseTracks() {
      this._tracks.forEach(track => { try { track.stop(); } catch (_) {} });
      this._tracks = [];
    }

    start(stream) {
      this.abort();
      const Recorder = window.MediaRecorder;
      const Stream = window.MediaStream;
      if (!Recorder || !Stream || typeof Recorder.isTypeSupported !== 'function') {
        this._report('unsupported', '이 브라우저는 영상 보관을 지원하지 않아요. 움직임과 분석 결과만 저장할 수 있습니다.');
        return false;
      }
      const mimeType = MIME_TYPES.find(type => Recorder.isTypeSupported(type));
      const originals = stream?.getVideoTracks?.().filter(track => track.readyState !== 'ended') || [];
      if (!mimeType || !originals.length) {
        this._report('unsupported', mimeType
          ? '보관할 카메라 영상이 없어요. 움직임과 분석 결과만 저장할 수 있습니다.'
          : '지원되는 영상 형식을 찾지 못했어요. 움직임과 분석 결과만 저장할 수 있습니다.');
        return false;
      }
      const generation = this._generation;
      try {
        for (const track of originals) this._tracks.push(track.clone());
        const recorder = new Recorder(new Stream(this._tracks), {mimeType, videoBitsPerSecond:1200000});
        this._recorder = recorder;
        this._stopPromise = new Promise(resolve => { this._resolveStop = resolve; });
        recorder.addEventListener('dataavailable', event => {
          if (generation !== this._generation || this._failed || !event.data?.size) return;
          this._bytes += event.data.size;
          if (this._bytes > this.maxBytes) {
            this._failed = true;
            this._chunks = [];
            this._report('too-large', '영상이 15MB를 넘어 보관하지 못했어요. 움직임과 분석 결과는 저장할 수 있습니다.');
            this.stop();
            return;
          }
          this._chunks.push(event.data);
        });
        recorder.addEventListener('error', () => {
          if (generation !== this._generation) return;
          this._failed = true;
          this._chunks = [];
          this._report('error', '영상 보관 중 문제가 생겼어요. 움직임과 분석 결과는 저장할 수 있습니다.');
          this.stop();
        });
        recorder.addEventListener('stop', () => this._finish(generation));
        recorder.start(250);
        this._report('recording', '이번 움직임의 영상도 이 기기에 임시 보관 중입니다. 아직 온라인으로 보내지 않았어요.');
        return true;
      } catch (_) {
        this._failed = true;
        this._report('error', '영상을 보관할 수 없어요. 움직임과 분석 결과만 저장할 수 있습니다.');
        this._finish(generation);
        return false;
      }
    }

    pause() {
      if (this._recorder?.state !== 'recording') return;
      try {
        this._recorder.pause();
        this._report('paused', '기록이 멈춘 동안 영상 보관도 잠시 멈춥니다.');
      } catch (_) {
        this._failed = true;
        this._report('error', '영상 보관을 중단했어요. 움직임과 분석 결과는 저장할 수 있습니다.');
        this.stop();
      }
    }

    resume() {
      if (this._recorder?.state !== 'paused') return;
      try {
        this._recorder.resume();
        this._report('recording', '영상 보관을 이어갑니다. 아직 온라인으로 보내지 않았어요.');
      } catch (_) {
        this._failed = true;
        this._report('error', '영상 보관을 다시 시작하지 못했어요. 움직임과 분석 결과는 저장할 수 있습니다.');
        this.stop();
      }
    }

    stop() {
      if (!this._recorder) return Promise.resolve(this._blob);
      const pending = this._stopPromise;
      const generation = this._generation;
      if (!this._stopTimer) {
        this._stopTimer = setTimeout(() => {
          if (generation !== this._generation) return;
          this._failed = true;
          this._report('error', '영상 마무리가 지연되어 보관하지 못했어요. 움직임과 분석 결과는 저장할 수 있습니다.');
          this._finish(generation);
        }, 2000);
      }
      if (this._recorder.state !== 'inactive') {
        try { this._recorder.stop(); }
        catch (_) {
          this._failed = true;
          this._report('error', '영상을 마무리하지 못했어요. 움직임과 분석 결과는 저장할 수 있습니다.');
          this._finish(generation);
        }
      }
      return pending;
    }

    _finish(generation) {
      if (generation !== this._generation) return;
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
      if (!this._failed && this._chunks.length) {
        this._blob = new Blob(this._chunks, {type:this._recorder?.mimeType || 'video/webm'});
      }
      this._chunks = [];
      this._releaseTracks();
      this._recorder = null;
      if (!this._failed) this._report(this._blob?.size ? 'ready' : 'empty', this._blob?.size
        ? '영상이 이 기기에 준비됐어요. 비공개 로그에 저장을 누를 때만 전송합니다.'
        : '보관된 영상이 없어요. 움직임과 분석 결과만 저장할 수 있습니다.');
      this._resolveStop?.(this._blob);
      this._resolveStop = null;
    }

    abort() {
      this._generation++;
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
      const recorder = this._recorder;
      this._recorder = null;
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (_) {}
      }
      this._releaseTracks();
      this._resolveStop?.(null);
      this._resolveStop = null;
      this._stopPromise = null;
      this._chunks = [];
      this._bytes = 0;
      this._blob = null;
      this._failed = false;
    }
  }
  window.GhostingSessionRecorder = GhostingSessionRecorder;
})();
