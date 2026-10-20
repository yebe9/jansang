/* Webcam hand / full-body input for JANSANG.
 *
 * Usage:
 *   const camera = new JansangPoseCamera({ video, overlay, trackingMode: 'hand', onFrame, onStatus, onDevices });
 *   await camera.start({ deviceId }); // optional exact camera; true when ready
 *   camera.stop();        // releases webcam tracks and the detector immediately
 *
 * video: HTMLVideoElement; overlay: HTMLCanvasElement laid over that video.
 * Both should fill the same box. This module uses object-fit: contain, mirrors
 * the video, and paints the matching mirrored skeleton into the overlay.
 * onFrame({ landmarks, timestamp }): <= 15 callbacks/sec, performance.now() in ms;
 * trackingMode is 'body' (default) or 'hand'. For body, landmarks is a fresh
 * array in MediaPipe's 33-slot index order. Slots 0–10
 * (face) are always null; slots 11–32 contain { x, y, z, visibility } for the
 * body. x is mirrored; x/y are clamped to [0, 1]. Missing shoulders, hips, or
 * ankles produce []. Consumers must check each joint's visibility >= 0.5.
 * For hand, landmarks uses 21 hand slots (0 wrist, 8 index fingertip), without
 * any body or face points. Hand models do not return per-joint visibility:
 * this adapter sets visibility to 1 for finite in-frame points, otherwise 0.
 * Missing wrist/index MCP/index tip, a confident handedness switch, or a large
 * wrist discontinuity produces [] so consumers can start a separate stroke.
 * onStatus({ kind, message }): loading | ready | tracking | missing | error.
 * onDevices({ devices, selectedDeviceId }): video inputs after permission;
 * devices contains only { deviceId, label }. Selection stays in this session.
 * start() rejects an Error with a Korean message after emitting error status.
 * stop() is idempotent, including during pending permission or model downloads.
 *
 * Frames stay in the browser. No video recording, audio, upload, or storage.
 * In body mode MediaPipe internally estimates 33 landmarks, including the face. Facial
 * coordinates are discarded before smoothing, drawing, or onFrame callbacks.
 * This module only downloads the public library/WASM/model assets below.
 * MediaPipe Tasks Vision is Apache-2.0:
 * https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
 * API: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js
 * API: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
 * Synchronous inference is throttled on the main thread, using the Full pose model
 * and a small camera frame. A worker is a future performance improvement.
 */
(() => {
  'use strict';

  const PACKAGE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
  const BODY_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
  const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const FRAME_INTERVAL = 1000 / 15;
  const MIN_VISIBILITY = 0.5;
  const BODY_CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [15, 17], [15, 19], [15, 21], [17, 19],
    [16, 18], [16, 20], [16, 22], [18, 20],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
    [24, 26], [26, 28], [27, 29], [29, 31], [27, 31],
    [28, 30], [30, 32], [28, 32]
  ];
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
  ];
  const clamp = value => Math.max(0, Math.min(1, value));
  let visionPromise;

  function loadVision() {
    if (!visionPromise) {
      visionPromise = import(`${PACKAGE}/vision_bundle.mjs`).catch(error => {
        visionPromise = null;
        throw error;
      });
    }
    return visionPromise;
  }

  function abortError() {
    return new DOMException('Camera start cancelled', 'AbortError');
  }

  // Promise.race alone leaves listeners behind. Clean up after every outcome.
  function cancellable(promise, signal, timeout, timeoutMessage) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      let timer;
      const finish = (fn, result) => {
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        fn(result);
      };
      const onAbort = () => finish(reject, abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      if (timeout) timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), timeout);
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach(track => track.stop());
  }

  const isVirtualCamera = label => /mirametrix|virtual|\bobs\b/i.test(label || '');
  const isInfraredCamera = label => /\bir\b|infrared|depth/i.test(label || '');

  function closeDetector(detector) {
    if (detector) {
      try { detector.close(); } catch (_) { /* Already released by the browser. */ }
    }
  }

  function friendlyError(error) {
    switch (error && error.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return '카메라 권한이 꺼져 있어요. 브라우저의 카메라 권한을 허용한 뒤 다시 시작해 주세요.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '연결된 카메라를 찾지 못했어요. 카메라 연결을 확인한 뒤 다시 시작해 주세요.';
      case 'NotReadableError':
      case 'TrackStartError':
        return '카메라를 열지 못했어요. 카메라를 사용 중인 다른 앱을 닫고 다시 시작해 주세요.';
      case 'OverconstrainedError':
        return '이 카메라에서는 요청한 영상 설정을 사용할 수 없어요. 다른 카메라나 브라우저를 사용해 주세요.';
      case 'SecurityError':
        return '현재 브라우저에서 카메라 접근이 차단되어 있어요. HTTPS 페이지에서 다시 열어 주세요.';
      default:
        return error && /[가-힣]/.test(error.message)
          ? error.message
          : '동작 인식 모델을 불러오지 못했어요. 인터넷 연결을 확인하고 최신 Chrome 또는 Edge에서 다시 시작해 주세요.';
    }
  }

  class JansangPoseCamera {
    constructor({ video, overlay, trackingMode = 'body', onFrame = () => {}, onStatus = () => {}, onDevices = () => {} }) {
      if (!video || !overlay) throw new Error('카메라 미리보기 요소가 필요해요.');
      if (!['hand', 'body'].includes(trackingMode)) throw new Error('손 또는 전신 인식 모드를 선택해 주세요.');
      this.video = video;
      this.overlay = overlay;
      this.trackingMode = trackingMode;
      this.context = overlay.getContext('2d');
      this.onFrame = onFrame;
      this.onStatus = onStatus;
      this.onDevices = onDevices;
      this._generation = 0;
      this._raf = 0;
      this._stream = null;
      this._detector = null;
      this._controller = null;
      this._trackListeners = [];
      this._smoothed = null;
      this._handIdentity = null;
      this._status = '';
      this._lastPoseTime = -Infinity;
      this._lastInference = -Infinity;
      this._lastVideoTime = -1;
      this._stalled = false;
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('muted', '');
      this.video.style.transform = 'scaleX(-1)';
      this.video.style.objectFit = 'contain';
      this.overlay.style.objectFit = 'contain';
      this.overlay.style.transform = 'none';
    }

    _emitStatus(kind, message) {
      const key = `${kind}:${message}`;
      if (this._status === key) return;
      this._status = key;
      this.onStatus({ kind, message });
    }

    async start({ deviceId } = {}) {
      this.stop();
      const generation = this._generation;
      const controller = new AbortController();
      const current = () => generation === this._generation && !controller.signal.aborted;
      this._controller = controller;
      this._status = '';
      this._emitStatus('loading', '카메라 권한을 확인하고 있어요.');
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('이 브라우저에서는 카메라를 사용할 수 없어요. HTTPS 주소 또는 localhost에서 열어 주세요.');
        }

        const openStream = async selectedId => {
          if (!current()) throw abortError();
          const streamPromise = navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              ...(selectedId ? { deviceId: { exact: selectedId } } : { facingMode: 'user' }),
              width: { ideal: 640, max: 960 },
              height: { ideal: 480, max: 720 },
              frameRate: { ideal: 15, max: 30 }
            }
          });
          // getUserMedia cannot be aborted, including a camera replacement.
          streamPromise.then(stream => { if (!current()) stopTracks(stream); }, () => {});
          const stream = await cancellable(streamPromise, controller.signal);
          if (!current()) { stopTracks(stream); throw abortError(); }
          this._stream = stream;
          return stream;
        };
        let stream = await openStream(deviceId);
        let devices = [];
        if (navigator.mediaDevices.enumerateDevices) {
          try {
            const inputs = await cancellable(navigator.mediaDevices.enumerateDevices(), controller.signal);
            devices = inputs.filter(device => device.kind === 'videoinput' && device.deviceId)
              .map(({ deviceId, label }) => ({ deviceId, label }));
          } catch (error) {
            if (!current()) throw error;
            // Some embedded browsers allow capture but do not list devices.
          }
        }
        const initialTrack = stream.getVideoTracks()[0];
        let selectedId = deviceId || initialTrack?.getSettings?.().deviceId || '';
        if (!deviceId && isVirtualCamera(initialTrack?.label)) {
          const physical = devices.find(device => device.label && device.deviceId !== selectedId &&
            !isVirtualCamera(device.label) && !isInfraredCamera(device.label));
          if (physical) {
            // A virtual camera can supply a "camera off" image as valid frames.
            // Release it before opening the real camera it may itself depend on.
            stopTracks(stream);
            this._stream = null;
            this._emitStatus('loading', '실제 카메라로 연결하고 있어요.');
            stream = await openStream(physical.deviceId);
            selectedId = physical.deviceId;
          }
        }
        const selectedTrack = stream.getVideoTracks()[0];
        selectedId = selectedTrack?.getSettings?.().deviceId || selectedId ||
          devices.find(device => device.label === selectedTrack?.label)?.deviceId || '';
        if (selectedId && !devices.some(device => device.deviceId === selectedId)) {
          devices.push({ deviceId: selectedId, label: selectedTrack?.label || '현재 카메라' });
        }
        this.onDevices({ devices, selectedDeviceId: selectedId });
        if (!current()) return false;
        for (const track of stream.getVideoTracks()) {
          const ended = () => {
            if (!current()) return;
            this.stop();
            this._emitStatus('error', '카메라 연결이 끊어졌어요. 연결을 확인한 뒤 다시 시작해 주세요.');
          };
          track.addEventListener('ended', ended);
          this._trackListeners.push([track, ended]);
          if (track.readyState === 'ended') throw new Error('카메라 연결이 끊어졌어요. 다시 시작해 주세요.');
        }
        this.video.srcObject = stream;
        await cancellable(this.video.play(), controller.signal, 15000,
          '카메라 영상을 재생하지 못했어요. 브라우저의 카메라 권한을 확인한 뒤 다시 시작해 주세요.');
        if (!current()) return false;

        this._emitStatus('loading', `${this.trackingMode === 'hand' ? '손' : '동작'} 인식 모델을 불러오는 중이에요. 처음에는 잠시 걸릴 수 있어요.`);
        const detectorPromise = this._createDetector(current);
        detectorPromise.then(detector => { if (!current()) closeDetector(detector); }, () => {});
        const detector = await cancellable(detectorPromise, controller.signal, 90000,
          '동작 인식 모델 다운로드가 지연되고 있어요. 인터넷 연결을 확인한 뒤 다시 시작해 주세요.');
        if (!current()) { closeDetector(detector); return false; }
        this._detector = detector;
        this._lastInference = -Infinity;
        this._lastVideoTime = -1;
        this._stalled = false;
        this._emitStatus('ready', this.trackingMode === 'hand'
          ? '카메라가 준비됐어요. 한 손의 손목부터 손가락 끝까지 화면 안에 보여 주세요.'
          : '카메라가 준비됐어요. 얼굴은 포함하지 않아도 돼요. 어깨부터 발끝까지 화면 안에 들어오도록 서 주세요.');
        if (!current()) return false;
        this._raf = requestAnimationFrame(timestamp => this._tick(timestamp, generation));
        return true;
      } catch (error) {
        if (!current()) return false;
        const message = friendlyError(error);
        this.stop();
        this._emitStatus('error', message);
        throw new Error(message);
      }
    }

    async _createDetector(current) {
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = await loadVision();
      if (!current()) throw abortError();
      const fileset = await FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
      if (!current()) throw abortError();
      const hand = this.trackingMode === 'hand';
      const Detector = hand ? HandLandmarker : PoseLandmarker;
      const options = {
        baseOptions: { modelAssetPath: hand ? HAND_MODEL : BODY_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        minTrackingConfidence: 0.55,
        ...(hand ? {
          numHands: 1,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.55
        } : {
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          outputSegmentationMasks: false
        })
      };
      try {
        return await Detector.createFromOptions(fileset, options);
      } catch (error) {
        if (!current()) throw abortError();
        // Some devices cannot create a second GPU context alongside WebGL art.
        options.baseOptions.delegate = 'CPU';
        return Detector.createFromOptions(fileset, options);
      }
    }

    _tick(timestamp, generation) {
      if (generation !== this._generation || !this._detector) return;
      if (timestamp - this._lastInference >= FRAME_INTERVAL &&
          this.video.readyState >= 2 && this.video.currentTime !== this._lastVideoTime) {
        this._lastInference = timestamp;
        this._lastVideoTime = this.video.currentTime;
        this._stalled = false;
        let result;
        try {
          result = this._detector.detectForVideo(this.video, timestamp);
          const hand = this.trackingMode === 'hand';
          const landmarks = hand
            ? this._filterHand(result.landmarks?.[0], timestamp, result.handedness?.[0]?.[0])
            : this._filterPose(result.landmarks?.[0], timestamp);
          this._draw(landmarks);
          this._emitStatus(landmarks.length ? 'tracking' : 'missing',
            landmarks.length
              ? (hand ? '손의 움직임을 보고 있어요. 한 손의 손가락과 손목을 자유롭게 움직여 주세요.'
                : '온몸의 움직임을 보고 있어요. 어깨부터 발끝까지 화면 안에서 자유롭게 움직여 주세요.')
              : (hand ? '손을 찾고 있어요. 한 손의 손목과 검지 끝이 카메라 안에 보이도록 해 주세요.'
                : '몸 전체를 찾고 있어요. 얼굴은 필요 없어요. 어깨·골반·발목이 보이도록 한 걸음 물러나 주세요.'));
          // Consumer may call stop() (e.g. after its ten-second recording).
          if (generation === this._generation) this.onFrame({ landmarks, timestamp });
        } catch (_) {
          if (generation === this._generation) {
            this.stop();
            this._emitStatus('error', '동작 인식이 중단됐어요. 카메라를 다시 시작해 주세요.');
          }
        } finally {
          if (result?.close) result.close();
        }
      } else if (!this._stalled && timestamp - this._lastInference > 750) {
        // A camera can stop delivering frames without ending its track (e.g.
        // another app temporarily takes it). Pause the consumer's recording
        // clock rather than counting frozen video as observed movement.
        this._stalled = true;
        this._smoothed = null;
        this._handIdentity = null;
        this._draw([]);
        this._emitStatus('missing', '카메라 영상을 기다리고 있어요. 다른 앱에서 카메라를 사용 중인지 확인해 주세요.');
        if (generation === this._generation) this.onFrame({ landmarks: [], timestamp });
      }
      if (generation === this._generation) {
        this._raf = requestAnimationFrame(next => this._tick(next, generation));
      }
    }

    _filterPose(raw, timestamp) {
      const visible = index => raw?.[index] &&
        Number.isFinite(raw[index].x) && Number.isFinite(raw[index].y) &&
        raw[index].x >= 0 && raw[index].x <= 1 &&
        raw[index].y >= 0 && raw[index].y <= 1 &&
        (raw[index].visibility ?? 0) >= MIN_VISIBILITY;
      // A dance recording needs the torso and both legs in frame. Hands may
      // cross or briefly hide during a dance; they do not gate footwork.
      // Facial landmarks are deliberately not accessed, even for validation.
      if (!raw || raw.length < 33 ||
          ![11, 12, 23, 24, 27, 28].every(visible)) {
        this._smoothed = null;
        return [];
      }
      const previous = timestamp - this._lastPoseTime < 300 ? this._smoothed : null;
      const smoothed = Array.from({ length: 33 }, (_, index) => {
        if (index < 11) return null;
        const landmark = raw[index] || {};
        const finite = Number.isFinite(landmark.x) && Number.isFinite(landmark.y);
        const x = finite ? clamp(1 - landmark.x) : 0.5;
        const y = finite ? clamp(landmark.y) : 0.5;
        const z = Number.isFinite(landmark.z) ? landmark.z : 0;
        const inFrame = finite && landmark.x >= 0 && landmark.x <= 1 &&
          landmark.y >= 0 && landmark.y <= 1;
        const visibility = inFrame && Number.isFinite(landmark.visibility)
          ? clamp(landmark.visibility) : 0;
        const last = previous?.[index];
        // Modest smoothing suppresses jitter without hiding sharp gestures.
        const alpha = last && last.visibility >= MIN_VISIBILITY &&
          visibility >= MIN_VISIBILITY ? 0.65 : 1;
        return {
          x: last ? last.x + alpha * (x - last.x) : x,
          y: last ? last.y + alpha * (y - last.y) : y,
          z: last ? last.z + alpha * (z - last.z) : z,
          visibility
        };
      });
      this._lastPoseTime = timestamp;
      this._smoothed = smoothed;
      return smoothed.map(point => point ? { ...point } : null);
    }

    _filterHand(raw, timestamp, handedness) {
      const valid = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
      if (!raw || raw.length < 21 || ![0, 5, 8].every(index => valid(raw[index]))) {
        this._smoothed = null;
        this._handIdentity = null;
        return [];
      }
      // Handedness confidence describes left/right, not point visibility. It is
      // useful only for detecting a likely hand swap, never as joint confidence.
      const identity = handedness?.score >= 0.75 &&
        ['Left', 'Right'].includes(handedness.categoryName) ? handedness.categoryName : null;
      const previous = timestamp - this._lastPoseTime < 300 ? this._smoothed : null;
      const swapped = previous && identity && this._handIdentity && identity !== this._handIdentity;
      const jumped = previous && Math.hypot(1 - raw[0].x - previous[0].x, raw[0].y - previous[0].y) > 0.4;
      if (identity) this._handIdentity = identity;
      if (swapped || jumped) {
        this._smoothed = null;
        return [];
      }
      const smoothed = Array.from({ length: 21 }, (_, index) => {
        const landmark = raw[index];
        const visibility = valid(landmark) ? 1 : 0;
        const x = visibility ? 1 - landmark.x : 0.5;
        const y = visibility ? landmark.y : 0.5;
        const z = Number.isFinite(landmark?.z) ? landmark.z : 0;
        const last = previous?.[index];
        const alpha = last && last.visibility && visibility ? 0.65 : 1;
        return {
          x: last ? last.x + alpha * (x - last.x) : x,
          y: last ? last.y + alpha * (y - last.y) : y,
          z: last ? last.z + alpha * (z - last.z) : z,
          visibility
        };
      });
      this._lastPoseTime = timestamp;
      this._smoothed = smoothed;
      return smoothed.map(point => ({ ...point }));
    }

    _draw(landmarks) {
      const context = this.context;
      if (!context) return;
      const width = this.video.videoWidth || 640;
      const height = this.video.videoHeight || 480;
      if (this.overlay.width !== width || this.overlay.height !== height) {
        this.overlay.width = width;
        this.overlay.height = height;
      }
      context.clearRect(0, 0, width, height);
      const isVisible = point => point && point.visibility >= MIN_VISIBILITY;
      context.lineWidth = Math.max(2, width / 250);
      context.lineCap = 'round';
      context.strokeStyle = 'rgba(169, 218, 196, 0.85)';
      const hand = this.trackingMode === 'hand';
      for (const [from, to] of hand ? HAND_CONNECTIONS : BODY_CONNECTIONS) {
        const a = landmarks[from];
        const b = landmarks[to];
        if (!isVisible(a) || !isVisible(b)) continue;
        context.beginPath();
        context.moveTo(a.x * width, a.y * height);
        context.lineTo(b.x * width, b.y * height);
        context.stroke();
      }
      // Hand indices start at the wrist; body mode skips all facial indices.
      for (let index = hand ? 0 : 11; index < landmarks.length; index++) {
        const point = landmarks[index];
        if (!isVisible(point)) continue;
        const highlighted = hand ? index === 0 || index === 8 : index === 15 || index === 16;
        context.fillStyle = highlighted ? '#edab8d' : '#dcebe4';
        context.beginPath();
        context.arc(point.x * width, point.y * height, highlighted ? 6 : 3, 0, Math.PI * 2);
        context.fill();
      }
    }

    stop() {
      this._generation++;
      if (this._controller) this._controller.abort();
      this._controller = null;
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      for (const [track, ended] of this._trackListeners) {
        track.removeEventListener('ended', ended);
      }
      this._trackListeners = [];
      stopTracks(this._stream);
      this._stream = null;
      this.video.pause();
      this.video.srcObject = null;
      closeDetector(this._detector);
      this._detector = null;
      this._smoothed = null;
      this._handIdentity = null;
      this._lastPoseTime = -Infinity;
      if (this.context) this.context.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }
  }

  window.JansangPoseCamera = JansangPoseCamera;
})();
