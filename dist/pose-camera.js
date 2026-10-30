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
 * onFrame({ landmarks, worldLandmarks, trackingQuality, timestamp }): <= 15 callbacks/sec.
 * worldLandmarks is optional: 33 slots with facial slots 0–10 null, native
 * (unmirrored) MediaPipe hip-centered estimated meters. Missing metric estimates
 * produce [], never projected screen coordinates. trackingQuality reports only
 * observed coverage/visibility and measured inference time, not accuracy.
 * delegate: CPU (default), GPU, or AUTO (GPU with CPU fallback).
 * trackingMode is 'body' (default) or 'hand'. For body, landmarks is a fresh
 * array in MediaPipe's 33-slot index order. Slots 0–10
 * (face) are always null; slots 11–32 contain { x, y, z, visibility } for the
 * body. x is mirrored; x/y are clamped to [0, 1]. Missing shoulders, hips, or
 * ankles produce []. Consumers must check each joint's visibility >= 0.5.
 * For hand, onFrame({ landmarks: [], hands, timestamp }) contains up to two
 * hands: [{ id, landmarks, worldLandmarks }]. Each hand has 21 slots (0 wrist, 8 index fingertip).
 * Per-hand worldLandmarks, when available, use the native hand-centered estimated
 * metric axes and remain paired with the track ID when detector order changes.
 * without body or face points. Positive integer IDs identify continuously
 * observed tracks, not permanent left/right identities. Missing or ambiguous
 * hands get a fresh ID on reacquisition; IDs restart after stop/start.
 * Result-array order never determines track identity. Hand models do not return
 * per-joint visibility: finite in-frame points get 1, otherwise 0. A hand needs
 * its wrist, index MCP, and index tip in frame. Smoothing is independent per ID.
 * onStatus({ kind, message }): loading | ready | tracking | missing | error.
 * onDevices({ devices, selectedDeviceId }): video inputs after permission;
 * devices contains only { deviceId, label }. Selection stays in this session.
 * start() rejects an Error with a Korean message after emitting error status.
 * stop() is idempotent, including during pending permission or model downloads.
 *
 * Tracking frames stay in the browser. This class does not record or upload.
 * The app can separately opt into a video-only clone for the owner's logbook.
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
  const MAX_TRACK_GAP_MS = 300;
  const now = () => globalThis.performance?.now?.() ?? Date.now();

  // One Euro speed-adaptive low pass, independently reset at each occlusion.
  // Casiez et al., CHI 2012: https://gery.casiez.net/1euro/
  // These normalized-coordinate parameters are empirical tuning, not a quality benchmark.
  class AdaptivePointFilter {
    constructor() { this.last = null; }
    filter(point, timestamp) {
      const old = this.last;
      if (!old || timestamp <= old.timestamp || timestamp - old.timestamp >= MAX_TRACK_GAP_MS) {
        this.last = { raw:{...point}, value:{...point}, velocity:{x:0,y:0,z:0}, timestamp };
        return {...point};
      }
      const dt = Math.max(1/120, (timestamp-old.timestamp)/1000);
      const alpha = cutoff => 1/(1+1/(2*Math.PI*cutoff*dt));
      const derivativeAlpha = alpha(1);
      const velocity = {};
      for (const axis of ['x','y','z']) {
        const derivative=(point[axis]-old.raw[axis])/dt;
        velocity[axis]=old.velocity[axis]+derivativeAlpha*(derivative-old.velocity[axis]);
      }
      const cutoff=1.5+5*Math.hypot(velocity.x,velocity.y,velocity.z);
      const amount=alpha(cutoff);
      const value={};
      for (const axis of ['x','y','z']) value[axis]=old.value[axis]+amount*(point[axis]-old.value[axis]);
      this.last={raw:{...point},value:{...value},velocity,timestamp};
      return value;
    }
  }
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
  const isPhysicalCamera = device => device.label &&
    !isVirtualCamera(device.label) && !isInfraredCamera(device.label);
  const canTryAnotherCamera = error => [
    'NotReadableError', 'TrackStartError', 'NotFoundError', 'DevicesNotFoundError'
  ].includes(error?.name);

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
        return '카메라 영상을 시작하지 못했어요. 다른 앱의 카메라 사용 여부를 확인하거나, 목록에서 다른 카메라를 선택해 주세요.';
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
    constructor({ video, overlay, trackingMode = 'body', delegate = 'CPU', onFrame = () => {}, onStatus = () => {}, onDevices = () => {} }) {
      if (!video || !overlay) throw new Error('카메라 미리보기 요소가 필요해요.');
      if (!['hand', 'body'].includes(trackingMode)) throw new Error('손 또는 전신 인식 모드를 선택해 주세요.');
      this.video = video;
      this.overlay = overlay;
      if (!['CPU','GPU','AUTO'].includes(delegate)) throw new Error('CPU, GPU 또는 AUTO 실행 방식을 선택해 주세요.');
      this.trackingMode = trackingMode;
      this.delegate = delegate;
      this._delegate = delegate === 'AUTO' ? 'GPU' : delegate;
      this._recovering = false;
      this._cpuFallbackAttempted = false;
      this._inferenceMs = 0;
      this._frameInterval = FRAME_INTERVAL;
      this._poseFilters = [];
      this._worldFilters = [];
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
      this._handTracks = [];
      this._nextHandId = 1;
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
              width: { ideal: this.trackingMode === 'body' ? 960 : 640, max: 960 },
              height: { ideal: this.trackingMode === 'body' ? 720 : 480, max: 720 },
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
        let devices = [];
        const readDevices = async () => {
          if (!navigator.mediaDevices.enumerateDevices) return;
          try {
            const inputs = await cancellable(navigator.mediaDevices.enumerateDevices(), controller.signal);
            if (!current()) throw abortError();
            devices = inputs.filter(device => device.kind === 'videoinput' && device.deviceId)
              .map(({ deviceId, label }) => ({ deviceId, label }));
          } catch (error) {
            if (!current()) throw error;
            // Some embedded browsers allow capture but do not list devices.
          }
        };
        // An already-permitted device list can identify the real webcam before
        // opening a broken virtual default. Before permission, labels may be blank.
        if (navigator.mediaDevices.enumerateDevices) await readDevices();
        const preferred = !deviceId && devices.find(isPhysicalCamera);
        let selectedId = deviceId || preferred?.deviceId || '';
        let stream;
        const attemptedIds = new Set();
        const tryOpen = async id => {
          if (id) attemptedIds.add(id);
          return openStream(id);
        };
        try {
          try {
            stream = await tryOpen(selectedId);
          } catch (error) {
            if (!current() || deviceId || !canTryAnotherCamera(error)) throw error;
            // Permission may reveal labels even when the browser's default
            // camera cannot start. Try at most two known physical alternatives.
            await readDevices();
            const alternatives = devices.filter(device => isPhysicalCamera(device) &&
              !attemptedIds.has(device.deviceId)).slice(0, 2);
            let lastError = error;
            for (const alternative of alternatives) {
              this._emitStatus('loading', '다른 실제 카메라로 연결하고 있어요.');
              try {
                stream = await tryOpen(alternative.deviceId);
                selectedId = alternative.deviceId;
                break;
              } catch (nextError) {
                lastError = nextError;
                if (!current() || !canTryAnotherCamera(nextError)) throw nextError;
              }
            }
            if (!stream) throw lastError;
          }
          await readDevices();
          const initialTrack = stream.getVideoTracks()[0];
          selectedId = initialTrack?.getSettings?.().deviceId || selectedId;
          if (!deviceId && isVirtualCamera(initialTrack?.label)) {
            const physical = devices.find(device => device.deviceId !== selectedId &&
              !attemptedIds.has(device.deviceId) && isPhysicalCamera(device));
            if (physical) {
              // A virtual camera can supply a "camera off" image as valid frames.
              // Release it before opening the real camera it may itself depend on.
              stopTracks(stream);
              this._stream = null;
              this._emitStatus('loading', '실제 카메라로 연결하고 있어요.');
              stream = await tryOpen(physical.deviceId);
              selectedId = physical.deviceId;
            }
          }
        } catch (error) {
          if (!current()) throw error;
          // Keep manual selection available even when every open attempt fails.
          // A failed automatic choice must remain automatic on the next retry.
          if (devices.length) this.onDevices({ devices, selectedDeviceId: deviceId || '' });
          throw error;
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
          ? '카메라가 준비됐어요. 한 손 또는 양손의 손목부터 손가락 끝까지 화면 안에 보여 주세요.'
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

    async _createDetector(current, requestedDelegate = this.delegate) {
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = await loadVision();
      if (!current()) throw abortError();
      const fileset = await FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
      if (!current()) throw abortError();
      const hand = this.trackingMode === 'hand';
      const Detector = hand ? HandLandmarker : PoseLandmarker;
      const options = {
        baseOptions: { modelAssetPath: hand ? HAND_MODEL : BODY_MODEL, delegate: requestedDelegate === 'AUTO' ? 'GPU' : requestedDelegate },
        runningMode: 'VIDEO',
        minTrackingConfidence: 0.55,
        ...(hand ? {
          numHands: 2,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.55
        } : {
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          outputSegmentationMasks: false
        })
      };
      const create = async delegate => {
        options.baseOptions.delegate=delegate;
        const detector=await Detector.createFromOptions(fileset,options);
        if (current()) this._delegate=delegate;
        return detector;
      };
      try {
        return await create(options.baseOptions.delegate);
      } catch (error) {
        if (!current()) throw abortError();
        if (options.baseOptions.delegate === 'CPU') throw error;
        this._emitStatus('loading', 'CPU로 동작 인식을 준비하고 있어요.');
        return create('CPU');
      }
    }

    _clearSmoothing() {
      this._smoothed=null;
      this._poseFilters=[];
      this._worldFilters=[];
      this._handTracks=[];
      this._lastPoseTime=-Infinity;
    }

    _recoverCPU(generation) {
      if (this._delegate === 'CPU' || this._cpuFallbackAttempted || this._recovering) return false;
      this._cpuFallbackAttempted=true;
      this._recovering=true;
      closeDetector(this._detector);
      this._detector=null;
      this._clearSmoothing();
      this._draw([]);
      this._emitStatus('missing', 'CPU로 인식을 다시 연결하고 있어요. 잠시 멈춥니다.');
      if (generation === this._generation) this.onFrame(this.trackingMode === 'hand'
        ? {landmarks:[],hands:[],worldLandmarks:[],timestamp:now()} : {landmarks:[],worldLandmarks:[],timestamp:now()});
      if (generation !== this._generation) return true;
      this._createDetector(()=>generation === this._generation, 'CPU').then(detector=>{
        if (generation !== this._generation) { closeDetector(detector); return; }
        this._detector=detector;
        this._recovering=false;
        this._lastInference=-Infinity;
        this._lastVideoTime=-1;
        this._emitStatus('ready','CPU로 연결했어요. 움직임이 보이면 기록을 이어갑니다.');
        if (generation === this._generation) this._raf=requestAnimationFrame(next=>this._tick(next,generation));
      }).catch(()=>{
        if (generation !== this._generation) return;
        this.stop();
        this._emitStatus('error','동작 인식이 중단됐어요. 카메라를 다시 시작해 주세요.');
      });
      return true;
    }

    _tick(timestamp, generation) {
      if (generation !== this._generation || !this._detector) return;
      if (timestamp - this._lastInference >= this._frameInterval &&
          this.video.readyState >= 2 && this.video.currentTime !== this._lastVideoTime) {
        this._lastInference = timestamp;
        this._lastVideoTime = this.video.currentTime;
        this._stalled = false;
        let result;
        try {
          const inferenceStart=now();
          result = this._detector.detectForVideo(this.video, timestamp);
          const elapsed=Math.max(0,now()-inferenceStart);
          this._inferenceMs=this._inferenceMs ? this._inferenceMs*.8+elapsed*.2 : elapsed;
          this._frameInterval=Math.max(FRAME_INTERVAL,Math.min(250,this._inferenceMs*1.25));
          const hand = this.trackingMode === 'hand';
          const hands = hand ? this._filterHands(result.landmarks, timestamp, result.handedness, result.worldLandmarks) : null;
          const landmarks = hand ? [] : this._filterPose(result.landmarks?.[0], timestamp);
          const worldLandmarks=hand ? [] : this._filterWorld(result.worldLandmarks?.[0],landmarks,timestamp);
          const observed=(hand ? hands.flatMap(item=>item.landmarks) : landmarks).filter(point=>point && point.visibility >= MIN_VISIBILITY);
          const trackingQuality={
            delegate:this._delegate,model:hand ? 'hand_landmarker' : 'pose_landmarker_full',
            observedJoints:observed.length,expectedJoints:hand ? 21*hands.length : 22,
            meanVisibility:observed.length ? observed.reduce((sum,point)=>sum+point.visibility,0)/observed.length : 0,
            worldJoints:hand ? hands.reduce((sum,item)=>sum+(item.worldLandmarks?.filter(Boolean).length || 0),0) : worldLandmarks.filter(Boolean).length,
            inferenceMs:Math.round(this._inferenceMs*100)/100,sampleIntervalMs:Math.round(this._frameInterval*100)/100,
            worldCoordinateSystem:'mediapipe-estimated-meters-unmirrored'
          };
          this._draw(landmarks, hands);
          const detected = hand ? hands.length : landmarks.length;
          this._emitStatus(detected ? 'tracking' : 'missing',
            detected
              ? (hand ? (hands.length === 2
                ? '양손의 움직임을 보고 있어요. 두 손을 함께 자유롭게 움직여 주세요.'
                : '한 손의 움직임을 보고 있어요. 다른 손도 화면 안에 보여주면 함께 기록해요.')
                : '온몸의 움직임을 보고 있어요. 어깨부터 발끝까지 화면 안에서 자유롭게 움직여 주세요.')
              : (hand ? '손을 찾고 있어요. 한 손 또는 양손의 손목과 검지 끝이 카메라 안에 보이도록 해 주세요.'
                : '몸 전체를 찾고 있어요. 얼굴은 필요 없어요. 어깨·골반·발목이 보이도록 한 걸음 물러나 주세요.'));
          // Consumer may call stop() (e.g. after its ten-second recording).
          if (generation === this._generation) this.onFrame(hand
            ? { landmarks, hands, worldLandmarks, trackingQuality, timestamp } : { landmarks, worldLandmarks, trackingQuality, timestamp });
        } catch (_) {
          if (generation === this._generation && (result || !this._recoverCPU(generation))) {
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
        this._clearSmoothing();
        this._draw([]);
        this._emitStatus('missing', '카메라 영상을 기다리고 있어요. 다른 앱에서 카메라를 사용 중인지 확인해 주세요.');
        if (generation === this._generation) this.onFrame(this.trackingMode === 'hand'
          ? { landmarks: [], hands: [], timestamp } : { landmarks: [], timestamp });
      }
      if (generation === this._generation && !this._recovering) {
        this._raf = requestAnimationFrame(next => this._tick(next, generation));
      }
    }

    _filterPose(raw, timestamp) {
      const visible = index => raw?.[index] &&
        Number.isFinite(raw[index].x) && Number.isFinite(raw[index].y) &&
        raw[index].x >= 0 && raw[index].x <= 1 &&
        raw[index].y >= 0 && raw[index].y <= 1 &&
        (raw[index].visibility ?? 0) >= MIN_VISIBILITY &&
        (!Number.isFinite(raw[index].presence) || raw[index].presence >= MIN_VISIBILITY);
      // A dance recording needs the torso and both legs in frame. Hands may
      // cross or briefly hide during a dance; they do not gate footwork.
      // Facial landmarks are deliberately not accessed, even for validation.
      if (!raw || raw.length < 33 ||
          ![11, 12, 23, 24, 27, 28].every(visible)) {
        this._smoothed = null;
        this._poseFilters=[];
        this._worldFilters=[];
        return [];
      }
      if (timestamp-this._lastPoseTime >= MAX_TRACK_GAP_MS) this._poseFilters=[];
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
          ? Math.min(clamp(landmark.visibility),Number.isFinite(landmark.presence) ? clamp(landmark.presence) : 1) : 0;
        if (visibility < MIN_VISIBILITY) { this._poseFilters[index]=null; return {x,y,z,visibility}; }
        const filter=this._poseFilters[index] ||= new AdaptivePointFilter();
        return {...filter.filter({x,y,z},timestamp),visibility};
      });
      this._lastPoseTime = timestamp;
      this._smoothed = smoothed;
      return smoothed.map(point => point ? { ...point } : null);
    }

    _filterWorld(raw, observed, timestamp) {
      if (!raw || raw.length < 33 || !observed.length) { this._worldFilters=[]; return []; }
      // Never inspect raw[0..10], including validity checks or copied metadata.
      return Array.from({length:33},(_,index)=>{
        if(index < 11) return null;
        const point=raw[index];
        const valid=point && ['x','y','z'].every(axis=>Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 20);
        const visibility=Math.min(observed[index]?.visibility || 0,Number.isFinite(point?.visibility) ? clamp(point.visibility) : 1);
        if (!valid || visibility < MIN_VISIBILITY) { this._worldFilters[index]=null; return null; }
        const filter=this._worldFilters[index] ||= new AdaptivePointFilter();
        return {...filter.filter({x:point.x,y:point.y,z:point.z},timestamp),visibility};
      });
    }

    _filterHands(rawHands, timestamp, handedness, rawWorldHands) {
      const valid = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
      const candidates = (rawHands || []).slice(0, 2).flatMap((raw, index) => {
        if (!raw || raw.length < 21 || ![0, 5, 8].every(joint => valid(raw[joint]))) return [];
        const label = handedness?.[index]?.[0];
        // Handedness confidence describes left/right, never joint visibility.
        const identity = label?.score >= 0.75 && ['Left', 'Right'].includes(label.categoryName)
          ? label.categoryName : null;
        const palm = [0, 5, 9, 13, 17].map(joint => raw[joint]).filter(valid);
        const anchor = {
          x: 1 - palm.reduce((sum, point) => sum + point.x, 0) / palm.length,
          y: palm.reduce((sum, point) => sum + point.y, 0) / palm.length
        };
        return [{ raw, world:rawWorldHands?.[index], identity, anchor }];
      }).sort((a, b) => a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
      const previous = this._handTracks.filter(track => timestamp - track.timestamp < MAX_TRACK_GAP_MS);
      const costs = candidates.map(candidate => previous.map(track => {
        if (candidate.identity && track.identity && candidate.identity !== track.identity) return Infinity;
        const distance = Math.hypot(candidate.anchor.x - track.anchor.x, candidate.anchor.y - track.anchor.y);
        return distance <= 0.4 ? distance : Infinity;
      }));
      // With at most two hands, enumerate one-to-one assignments rather than
      // greedily claiming a track. Detector order can change on any frame.
      const assignments = [];
      const assign = (index, used, matches, cost) => {
        if (index === candidates.length) {
          assignments.push({ matches: [...matches], count: used.size, cost });
          return;
        }
        matches.push(-1);
        assign(index + 1, used, matches, cost);
        matches.pop();
        previous.forEach((_, trackIndex) => {
          if (used.has(trackIndex) || !Number.isFinite(costs[index][trackIndex])) return;
          used.add(trackIndex);
          matches.push(trackIndex);
          assign(index + 1, used, matches, cost + costs[index][trackIndex]);
          matches.pop();
          used.delete(trackIndex);
        });
      };
      assign(0, new Set(), [], 0);
      assignments.sort((a, b) => b.count - a.count || a.cost - b.cost);
      const best = assignments[0];
      // Near-equal spatial assignments happen when hands cross/overlap or one
      // vanishes between two candidates. Break only uncertain identities rather
      // than drawing a false bridge between hands.
      const ambiguous = new Set();
      for (const alternative of assignments.slice(1)) {
        if (alternative.count !== best.count || alternative.cost - best.cost > 0.06) continue;
        alternative.matches.forEach((match, index) => {
          if (match !== best.matches[index]) ambiguous.add(index);
        });
      }
      const retained = candidates.map((_, index) =>
        ambiguous.has(index) ? null : previous[best.matches[index]]);
      const usedColors = new Set(retained.filter(Boolean).map(track => track.color));
      this._handTracks = candidates.map((candidate, index) => {
        const track = retained[index];
        const color = track?.color || (usedColors.has('#a9dac4') ? '#edab8d' : '#a9dac4');
        usedColors.add(color);
        const filters=track?.filters || [];
        const smoothed = Array.from({ length: 21 }, (_, joint) => {
          const landmark = candidate.raw[joint];
          const visibility = valid(landmark) ? 1 : 0;
          const x = visibility ? 1 - landmark.x : 0.5;
          const y = visibility ? landmark.y : 0.5;
          const z = Number.isFinite(landmark?.z) ? landmark.z : 0;
          if (!visibility) { filters[joint]=null; return {x,y,z,visibility}; }
          const filter=filters[joint] ||= new AdaptivePointFilter();
          return {...filter.filter({x,y,z},timestamp),visibility};
        });
        const worldLandmarks=candidate.world?.length >= 21 ? Array.from({length:21},(_,joint)=>{
          const point=candidate.world[joint];
          return smoothed[joint].visibility && point && ['x','y','z'].every(axis=>Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 20)
            ? {x:point.x,y:point.y,z:point.z,visibility:1} : null;
        }) : [];
        return {
          id: track?.id || this._nextHandId++,
          identity: candidate.identity || track?.identity || null,
          anchor: candidate.anchor, timestamp, landmarks: smoothed, worldLandmarks, filters, color
        };
      });
      return this._handTracks.map(({ id, landmarks, worldLandmarks }) => ({
        id, landmarks: landmarks.map(point => ({ ...point })),
        worldLandmarks:worldLandmarks.map(point=>point ? {...point} : null)
      })).sort((a, b) => a.id - b.id);
    }

    _draw(landmarks, hands = []) {
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
      const hand = this.trackingMode === 'hand';
      for (const track of hand ? hands : [{ landmarks }]) {
        const points = track.landmarks;
        const color = hand
          ? this._handTracks.find(item => item.id === track.id)?.color || '#a9dac4' : '#a9dac4';
        context.strokeStyle = color;
        for (const [from, to] of hand ? HAND_CONNECTIONS : BODY_CONNECTIONS) {
          const a = points[from];
          const b = points[to];
          if (!isVisible(a) || !isVisible(b)) continue;
          context.beginPath();
          context.moveTo(a.x * width, a.y * height);
          context.lineTo(b.x * width, b.y * height);
          context.stroke();
        }
        // Hand indices start at the wrist; body mode skips all facial indices.
        for (let index = hand ? 0 : 11; index < points.length; index++) {
          const point = points[index];
          if (!isVisible(point)) continue;
          const highlighted = hand ? index === 0 || index === 8 : index === 15 || index === 16;
          context.fillStyle = highlighted ? (hand ? color : '#edab8d') : '#dcebe4';
          context.beginPath();
          context.arc(point.x * width, point.y * height, highlighted ? 6 : 3, 0, Math.PI * 2);
          context.fill();
        }
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
      this._clearSmoothing();
      this._recovering=false;
      this._cpuFallbackAttempted=false;
      this._inferenceMs=0;
      this._frameInterval=FRAME_INTERVAL;
      this._nextHandId = 1;
      if (this.context) this.context.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }
  }

  window.JansangPoseCamera = JansangPoseCamera;
})();
