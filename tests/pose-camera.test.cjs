const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

// Exercise the webcam adapter's privacy/resource lifecycle without opening a
// real camera or downloading third-party models during the automated suite.
const source = fs.readFileSync(path.join(__dirname, '../dist/pose-camera.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function cameraStream(label = 'Camera', deviceId = 'camera') {
  const track = new EventTarget();
  track.readyState = 'live';
  track.label = label;
  track.getSettings = () => ({ deviceId });
  track.stopped = 0;
  track.stop = () => { track.stopped++; };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  return { track, stream };
}

function fixture({ trackingMode = 'body', delegate = 'CPU' } = {}) {
  let nextRaf = 1;
  const scheduled = new Map();
  const context = {
    window: { isSecureContext: true },
    navigator: { mediaDevices: {} },
    DOMException, AbortController, setTimeout, clearTimeout,
    requestAnimationFrame(callback) {
      const id = nextRaf++;
      scheduled.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { scheduled.delete(id); }
  };
  vm.createContext(context);
  // Keep model setup real while replacing only its external CDN import in
  // factory-specific tests. Normal frame/lifecycle tests supply a fake detector.
  vm.runInContext(source.replace('import(`${PACKAGE}/vision_bundle.mjs`)',
    'Promise.resolve(globalThis.__vision)'), context);
  const { track, stream } = cameraStream();
  const video = {
    style: {}, setAttribute() {}, play: () => Promise.resolve(), pause() {},
    readyState: 4, currentTime: 0, videoWidth: 640, videoHeight: 480
  };
  const arcs = [], strokes = [];
  const paint = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { strokes.push(this.strokeStyle); },
    arc(...args) { arcs.push(args); }, fill() {} };
  const overlay = { style: {}, width: 640, height: 480, getContext: () => paint };
  const frames = [], statuses = [], deviceReports = [];
  const camera = new context.window.JansangPoseCamera({
    video, overlay, trackingMode, delegate, onFrame: frame => frames.push(frame), onStatus: status => statuses.push(status),
    onDevices: report => deviceReports.push(report)
  });
  let closed = 0, calls = 0;
  let raw = Array.from({ length: trackingMode === 'hand' ? 21 : 33 },
    () => ({ x: 0.25, y: 0.4, z: 0.1, ...(trackingMode === 'hand' ? {} : { visibility: 0.9 }) }));
  let handedness = { categoryName: 'Right', score: 0.95 };
  let hands, world;
  const detector = {
    detectForVideo() { calls++; return {
      landmarks: hands ? hands.map(hand => hand.landmarks) : raw ? [raw] : [],
      worldLandmarks: world,
      handedness: hands ? hands.map(hand => [hand.handedness]) : [[handedness]], close() {}
    }; },
    close() { closed++; }
  };
  const createDetector = camera._createDetector;
  camera._createDetector = () => Promise.resolve(detector);
  context.navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  function frame(timestamp) {
    const entry = scheduled.entries().next().value;
    assert.ok(entry, 'A frame callback should be scheduled');
    scheduled.delete(entry[0]);
    entry[1](timestamp);
  }
  return {
    camera, track, stream, video, frames, statuses, deviceReports, detector, context, scheduled, frame, createDetector, arcs, strokes,
    get closed() { return closed; }, get calls() { return calls; },
    setRaw(value) { raw = value; hands = undefined; },
    setHandedness(value) { handedness = value; },
    setHands(value) { hands = value; },
    setWorld(value) { world = value; }
  };
}

test('mirrors normalized joints, throttles inference, and releases camera resources', async () => {
  const f = fixture();
  assert.equal(await f.camera.start(), true);
  f.frame(100);
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].landmarks.length, 33);
  assert.ok(f.frames[0].landmarks.slice(0, 11).every(point => point === null));
  assert.equal(f.frames[0].landmarks[15].x, 0.75);
  assert.equal(f.video.style.transform, 'scaleX(-1)');
  f.video.currentTime = 1;
  f.frame(110);
  assert.equal(f.calls, 1, 'Two samples less than 1/15s apart must not infer twice');
  f.frame(170);
  assert.equal(f.calls, 2);
  f.camera.stop();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.scheduled.size, 0);
  f.camera.stop();
  assert.equal(f.closed, 1, 'stop is idempotent');
});

test('lost or occluded pose emits an empty frame and breaks smoothing history', async () => {
  const f = fixture();
  await f.camera.start();
  f.frame(100);
  f.setRaw(null);
  f.video.currentTime = 1;
  f.frame(200);
  assert.equal(f.frames.at(-1).landmarks.length, 0);
  assert.equal(f.statuses.at(-1).kind, 'missing');
  assert.equal(f.camera._smoothed, null);
  const occluded = Array.from({ length: 33 }, () => ({ x: 0.25, y: 0.4, z: 0, visibility: 0.9 }));
  occluded[27].visibility = 0.2;
  occluded[28].visibility = 0.2;
  f.setRaw(occluded);
  f.video.currentTime = 2;
  f.frame(300);
  assert.equal(f.frames.at(-1).landmarks.length, 0);
  f.camera.stop();
});

test('full body stays valid with missing, malformed, or extreme facial landmarks', async () => {
  const f = fixture();
  await f.camera.start();
  const raw = Array.from({ length: 33 }, () => ({ x: 0.25, y: 0.4, z: 0, visibility: 0.9 }));
  raw[0] = null;
  raw[1] = undefined;
  raw[2] = { x: Infinity, y: NaN, z: -Infinity, visibility: 1 };
  raw[3] = { x: 10000, y: -10000, z: 1e20, visibility: 1 };
  // A face slot is never read: discarding must happen before any filtering.
  Object.defineProperty(raw, 4, { get() { throw new Error('Facial slot was accessed'); } });
  f.setRaw(raw);
  f.frame(100);
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].landmarks.length, 33);
  assert.ok(f.frames[0].landmarks.slice(0, 11).every(point => point === null));
  assert.ok(f.camera._smoothed.slice(0, 11).every(point => point === null));
  assert.equal(f.frames[0].landmarks[28].visibility, 0.9);
  assert.equal(f.statuses.at(-1).kind, 'tracking');
  f.camera.stop();
});

test('occluded wrists do not stop a full-body dance or footwork recording', async () => {
  const f = fixture();
  await f.camera.start();
  const raw = Array.from({ length: 33 }, () => ({ x: 0.25, y: 0.4, z: 0, visibility: 0.9 }));
  raw[15].visibility = 0.1;
  raw[16] = null;
  f.setRaw(raw);
  f.frame(100);
  const points = f.frames[0].landmarks;
  assert.equal(points.length, 33);
  assert.equal(points[15].visibility, 0.1);
  assert.equal(points[16].visibility, 0);
  assert.equal(points[27].visibility, 0.9);
  assert.equal(f.statuses.at(-1).kind, 'tracking');
  f.camera.stop();
});

test('missing or out-of-frame required body joints pause full-body recording', async () => {
  const f = fixture();
  await f.camera.start();
  let timestamp = 0;
  for (const index of [11, 12, 23, 24, 27, 28]) {
    for (const invalid of [null, { x: 0.5, y: 1.2, visibility: 0.9 }, { x: 0.5, y: 0.5, visibility: 0.2 }]) {
      const raw = Array.from({ length: 33 }, () => ({ x: 0.25, y: 0.4, z: 0, visibility: 0.9 }));
      raw[index] = invalid;
      f.setRaw(raw);
      f.video.currentTime++;
      f.frame(timestamp += 100);
      assert.equal(f.frames.at(-1).landmarks.length, 0, `Joint ${index} must be present and visible`);
      assert.equal(f.camera._smoothed, null);
    }
  }
  f.camera.stop();
});

test('frozen video emits a missing pose so the recording clock can pause', async () => {
  const f = fixture();
  await f.camera.start();
  f.frame(100);
  f.frame(900);
  assert.equal(f.calls, 1, 'Never rerun inference for the same decoded video frame');
  assert.equal(f.frames.at(-1).landmarks.length, 0);
  assert.equal(f.statuses.at(-1).kind, 'missing');
  const count = f.frames.length;
  f.frame(1000);
  assert.equal(f.frames.length, count, 'Do not repeatedly notify for the same stall');
  f.video.currentTime = 1;
  f.frame(1100);
  assert.equal(f.frames.at(-1).landmarks.length, 33);
  f.camera.stop();
});

test('permission accepted after cancellation still releases its late stream', async () => {
  const f = fixture();
  const permission = deferred();
  f.context.navigator.mediaDevices.getUserMedia = () => permission.promise;
  const pending = f.camera.start();
  f.camera.stop();
  assert.equal(await pending, false);
  permission.resolve(f.stream);
  await new Promise(setImmediate);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.video.srcObject, null);
});

test('model created after cancellation is closed instead of restarting capture', async () => {
  const f = fixture();
  const model = deferred();
  f.camera._createDetector = () => model.promise;
  const loading = f.camera.start();
  await new Promise(setImmediate);
  f.camera.stop();
  assert.equal(await loading, false);
  model.resolve(f.detector);
  await new Promise(setImmediate);
  assert.equal(f.closed, 1);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.scheduled.size, 0);
});

test('permission denial reports an actionable Korean error', async () => {
  const f = fixture();
  f.context.navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  await assert.rejects(f.camera.start(), /권한/);
  assert.equal(f.statuses.at(-1).kind, 'error');
  assert.equal(f.video.srcObject, null);
});

test('virtual default camera switches to a normal physical camera before playback', async () => {
  const f = fixture();
  const virtual = cameraStream('Mirametrix Virtual Camera', 'virtual');
  const physical = cameraStream('LGE Camera', 'physical');
  const requests = [];
  let enumerations = 0;
  f.context.navigator.mediaDevices.enumerateDevices = async () => ++enumerations === 1
    ? [{ kind: 'videoinput', deviceId: 'virtual', label: '' }]
    : [
      { kind: 'videoinput', deviceId: 'virtual', label: virtual.track.label },
      { kind: 'videoinput', deviceId: 'ir', label: 'LGE IR-FHD Camera' },
      { kind: 'videoinput', deviceId: 'physical', label: physical.track.label },
      { kind: 'audioinput', deviceId: 'microphone', label: 'Microphone' }
    ];
  f.context.navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints);
    if (requests.length === 1) return virtual.stream;
    assert.equal(virtual.track.stopped, 1, 'Release virtual input before opening its physical camera');
    return physical.stream;
  };
  assert.equal(await f.camera.start(), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].video.deviceId.exact, 'physical');
  assert.ok(requests.every(request => request.audio === false));
  assert.equal(f.video.srcObject, physical.stream);
  assert.equal(f.deviceReports.length, 1);
  assert.equal(f.deviceReports[0].selectedDeviceId, 'physical');
  assert.equal(f.deviceReports[0].devices.length, 3);
  f.camera.stop();
  assert.equal(physical.track.stopped, 1);
  assert.equal(virtual.track.stopped, 1);
});

test('known physical camera opens directly without touching virtual or infrared inputs', async () => {
  const f = fixture();
  const physical = cameraStream('LGE Camera', 'physical');
  const requests = [];
  f.context.navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'virtual', label: 'Mirametrix Virtual Camera' },
    { kind: 'videoinput', deviceId: 'ir', label: 'LGE IR-FHD Camera' },
    { kind: 'videoinput', deviceId: 'physical', label: physical.track.label }
  ];
  f.context.navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints);
    return physical.stream;
  };
  assert.equal(await f.camera.start(), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].video.deviceId.exact, 'physical');
  assert.equal(requests[0].audio, false);
  assert.equal(f.video.srcObject, physical.stream);
  assert.equal(f.deviceReports[0].selectedDeviceId, 'physical');
  f.camera.stop();
  assert.equal(physical.track.stopped, 1);
});

test('unreadable default recovers through physical labels revealed after the failed open', async () => {
  const f = fixture();
  const physical = cameraStream('LGE Camera', 'physical');
  const requests = [];
  let enumerations = 0;
  f.context.navigator.mediaDevices.enumerateDevices = async () => ++enumerations === 1
    ? [{ kind: 'videoinput', deviceId: 'default', label: '' }]
    : [
      { kind: 'videoinput', deviceId: 'virtual', label: 'Mirametrix Virtual Camera' },
      { kind: 'videoinput', deviceId: 'ir', label: 'LGE IR-FHD Camera' },
      { kind: 'videoinput', deviceId: 'physical', label: physical.track.label }
    ];
  f.context.navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints);
    if (!constraints.video.deviceId) throw new DOMException('Default unavailable', 'NotReadableError');
    assert.equal(constraints.video.deviceId.exact, 'physical');
    return physical.stream;
  };
  assert.equal(await f.camera.start(), true);
  assert.equal(requests.length, 2);
  assert.equal(f.video.srcObject, physical.stream);
  assert.equal(f.deviceReports[0].selectedDeviceId, 'physical');
  assert.equal(f.deviceReports[0].devices.length, 3);
  assert.equal(f.statuses.at(-1).kind, 'ready');
  f.camera.stop();
});

test('all unreadable cameras leave a manual list and automatic retries remain automatic', async () => {
  const f = fixture();
  const requests = [];
  f.context.navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'virtual', label: 'Mirametrix Virtual Camera' },
    ...Array.from({ length: 5 }, (_, index) =>
      ({ kind: 'videoinput', deviceId: `physical-${index}`, label: `USB Camera ${index}` }))
  ];
  f.context.navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints.video.deviceId.exact);
    throw new DOMException('Unavailable', 'NotReadableError');
  };
  await assert.rejects(f.camera.start(), /카메라 영상을 시작하지 못했어요/);
  assert.deepEqual(requests, ['physical-0', 'physical-1', 'physical-2'],
    'Only the preferred camera and at most two physical alternatives are attempted');
  assert.equal(f.deviceReports.length, 1);
  assert.equal(f.deviceReports[0].devices.length, 6);
  assert.equal(f.deviceReports[0].selectedDeviceId, '');
  assert.equal(f.statuses.at(-1).kind, 'error');
  assert.equal(f.video.srcObject, null);
  assert.equal(f.scheduled.size, 0);
});

test('permission or security denial never triggers a camera fallback', async () => {
  for (const name of ['NotAllowedError', 'SecurityError']) {
    const f = fixture();
    let requests = 0;
    f.context.navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'physical', label: 'LGE Camera' },
      { kind: 'videoinput', deviceId: 'other', label: 'USB Camera' }
    ];
    f.context.navigator.mediaDevices.getUserMedia = async () => {
      requests++;
      throw new DOMException('Denied', name);
    };
    await assert.rejects(f.camera.start(), /권한|차단/);
    assert.equal(requests, 1);
    assert.equal(f.statuses.at(-1).kind, 'error');
    assert.equal(f.video.srcObject, null);
  }
});

test('explicit unreadable camera stays selected without opening any substitute', async () => {
  const f = fixture();
  const requests = [];
  f.context.navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'chosen', label: 'OBS Virtual Camera' },
    { kind: 'videoinput', deviceId: 'physical', label: 'LGE Camera' }
  ];
  f.context.navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints.video.deviceId.exact);
    throw new DOMException('Unavailable', 'NotReadableError');
  };
  await assert.rejects(f.camera.start({ deviceId: 'chosen' }), /카메라 영상을 시작하지 못했어요/);
  assert.deepEqual(requests, ['chosen']);
  assert.equal(f.deviceReports[0].selectedDeviceId, 'chosen');
  assert.equal(f.deviceReports[0].devices.length, 2);
});

test('cancellation during initial enumeration never opens or reports a camera', async () => {
  const f = fixture();
  const enumeration = deferred();
  let requests = 0;
  f.context.navigator.mediaDevices.enumerateDevices = () => enumeration.promise;
  f.context.navigator.mediaDevices.getUserMedia = async () => { requests++; return f.stream; };
  const pending = f.camera.start();
  f.camera.stop();
  assert.equal(await pending, false);
  enumeration.resolve([{ kind: 'videoinput', deviceId: 'physical', label: 'LGE Camera' }]);
  await new Promise(setImmediate);
  assert.equal(requests, 0);
  assert.equal(f.deviceReports.length, 0);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.scheduled.size, 0);
});

test('cancelled fallback releases a late physical stream without starting detection', async () => {
  const f = fixture();
  const replacement = deferred();
  const physical = cameraStream('LGE Camera', 'physical');
  let enumerations = 0, requests = 0;
  f.context.navigator.mediaDevices.enumerateDevices = async () => ++enumerations === 1 ? [] : [
    { kind: 'videoinput', deviceId: 'physical', label: physical.track.label }
  ];
  f.context.navigator.mediaDevices.getUserMedia = () => ++requests === 1
    ? Promise.reject(new DOMException('Default unavailable', 'NotReadableError'))
    : replacement.promise;
  const pending = f.camera.start();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  f.camera.stop();
  assert.equal(await pending, false);
  replacement.resolve(physical.stream);
  await new Promise(setImmediate);
  assert.equal(physical.track.stopped, 1);
  assert.equal(f.deviceReports.length, 0);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.scheduled.size, 0);
});

test('explicit camera selection is exact and is never automatically replaced', async () => {
  const f = fixture();
  f.track.label = 'OBS Virtual Camera';
  f.track.getSettings = () => ({ deviceId: 'chosen' });
  const requests = [];
  f.context.navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'chosen', label: f.track.label },
    { kind: 'videoinput', deviceId: 'physical', label: 'LGE Camera' }
  ];
  f.context.navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints);
    return f.stream;
  };
  assert.equal(await f.camera.start({ deviceId: 'chosen' }), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].video.deviceId.exact, 'chosen');
  assert.equal(requests[0].audio, false);
  assert.equal(f.deviceReports[0].selectedDeviceId, 'chosen');
  assert.equal(f.video.srcObject, f.stream);
  f.camera.stop();
});

test('cancelling during physical camera replacement releases the late stream', async () => {
  const f = fixture();
  f.track.label = 'Mirametrix Virtual Camera';
  const physical = cameraStream('LGE Camera', 'physical');
  const replacement = deferred();
  let requests = 0, enumerations = 0;
  f.context.navigator.mediaDevices.enumerateDevices = async () => ++enumerations === 1 ? [] : [
    { kind: 'videoinput', deviceId: 'physical', label: physical.track.label }
  ];
  f.context.navigator.mediaDevices.getUserMedia = () =>
    ++requests === 1 ? Promise.resolve(f.stream) : replacement.promise;
  const pending = f.camera.start();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(f.track.stopped, 1);
  f.camera.stop();
  assert.equal(await pending, false);
  replacement.resolve(physical.stream);
  await new Promise(setImmediate);
  assert.equal(physical.track.stopped, 1);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.deviceReports.length, 0);
  assert.equal(f.scheduled.size, 0);
});

test('device enumeration failure still starts the permitted camera', async () => {
  const f = fixture();
  f.context.navigator.mediaDevices.enumerateDevices = async () => { throw new Error('Unavailable'); };
  assert.equal(await f.camera.start(), true);
  assert.equal(f.video.srcObject, f.stream);
  assert.equal(f.deviceReports[0].devices.length, 1);
  assert.equal(f.deviceReports[0].devices[0].deviceId, 'camera');
  assert.equal(f.deviceReports[0].devices[0].label, 'Camera');
  assert.equal(f.deviceReports[0].selectedDeviceId, 'camera');
  f.camera.stop();
});

test('disconnected camera stops capture and reports an error', async () => {
  const f = fixture();
  await f.camera.start();
  f.track.dispatchEvent(new Event('ended'));
  assert.equal(f.statuses.at(-1).kind, 'error');
  assert.equal(f.video.srcObject, null);
  assert.equal(f.closed, 1);
  assert.equal(f.scheduled.size, 0);
});

test('consumer can stop inside onFrame without leaving another frame scheduled', async () => {
  const f = fixture();
  f.camera.onFrame = () => f.camera.stop();
  await f.camera.start();
  f.frame(100);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.track.stopped, 1);
});

test('consumer cancellation during ready notification does not schedule capture', async () => {
  const f = fixture();
  f.camera.onStatus = status => { if (status.kind === 'ready') f.camera.stop(); };
  assert.equal(await f.camera.start(), false);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.closed, 1);
});

test('AUTO hand mode uses the hand model and preserves GPU-to-CPU fallback', async () => {
  const f = fixture({ trackingMode: 'hand',delegate:'AUTO' });
  const optionsSeen = [];
  const wasmPaths = [];
  f.context.__vision = {
    FilesetResolver: { async forVisionTasks(url) { wasmPaths.push(url); return 'fileset'; } },
    HandLandmarker: { async createFromOptions(fileset, options) {
      assert.equal(fileset, 'fileset');
      optionsSeen.push(JSON.parse(JSON.stringify(options)));
      if (options.baseOptions.delegate === 'GPU') throw new Error('GPU unavailable');
      return f.detector;
    } },
    PoseLandmarker: { createFromOptions() { assert.fail('Hand mode must never create a body model'); } }
  };
  f.camera._createDetector = f.createDetector;
  assert.equal(await f.camera.start(), true);
  assert.equal(wasmPaths.length, 1);
  assert.match(wasmPaths[0], /tasks-vision@0\.10\.32\/wasm$/);
  assert.equal(optionsSeen.length, 2);
  assert.equal(optionsSeen[0].baseOptions.delegate, 'GPU');
  assert.equal(optionsSeen[1].baseOptions.delegate, 'CPU');
  assert.match(optionsSeen[0].baseOptions.modelAssetPath,
    /hand_landmarker\/hand_landmarker\/float16\/1\/hand_landmarker\.task$/);
  assert.equal(optionsSeen[0].runningMode, 'VIDEO');
  assert.equal(optionsSeen[0].numHands, 2);
  assert.equal(optionsSeen[0].numPoses, undefined);
  assert.equal(optionsSeen[0].outputSegmentationMasks, undefined);
  assert.match(f.statuses.at(-1).message, /양손/);
  f.camera.stop();
  assert.equal(f.closed, 1);
});

test('default body model remains Full and never creates a hand detector', async () => {
  const f = fixture();
  let seen;
  f.context.__vision = {
    FilesetResolver: { async forVisionTasks() { return {}; } },
    PoseLandmarker: { async createFromOptions(_, options) { seen = options; return f.detector; } },
    HandLandmarker: { createFromOptions() { assert.fail('Body mode must never create a hand model'); } }
  };
  f.camera._createDetector = f.createDetector;
  await f.camera.start();
  assert.match(seen.baseOptions.modelAssetPath, /pose_landmarker_full\/float16\/1\/pose_landmarker_full\.task$/);
  assert.equal(seen.baseOptions.delegate,'CPU','A discrete GPU is never required by default');
  assert.equal(seen.numPoses, 1);
  assert.equal(seen.numHands, undefined);
  f.camera.stop();
});

test('hand mode returns 21 mirrored fresh joints without any torso or visibility inputs', async () => {
  const f = fixture({ trackingMode: 'hand' });
  await f.camera.start();
  f.frame(100);
  assert.equal(f.frames[0].landmarks.length, 0, 'Hand coordinates use only the hands contract');
  assert.equal(f.frames[0].hands.length, 1);
  assert.ok(Number.isInteger(f.frames[0].hands[0].id) && f.frames[0].hands[0].id > 0);
  const first = f.frames[0].hands[0].landmarks;
  assert.equal(first.length, 21);
  assert.equal(first[0].x, 0.75);
  assert.equal(first[8].x, 0.75);
  assert.equal(first[8].visibility, 1, 'Hand models provide no per-landmark visibility');
  assert.equal(f.arcs.length, 21, 'Draw every hand joint, including wrist and fingertip');
  assert.match(f.statuses.at(-1).message, /손의 움직임/);
  first[8].x = 0;
  f.video.currentTime++;
  f.frame(200);
  assert.equal(f.frames[1].hands[0].landmarks[8].x, 0.75, 'Consumer mutation must not corrupt smoothing history');
  f.camera.stop();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.scheduled.size, 0);
});

test('hand loss and invalid required joints emit missing frames and reset smoothing', async () => {
  const f = fixture({ trackingMode: 'hand' });
  await f.camera.start();
  f.frame(100);
  const firstId = f.frames[0].hands[0].id;
  let timestamp = 100;
  for (const index of [0, 5, 8]) {
    for (const invalid of [null, { x: NaN, y: 0.5 }, { x: 0.5, y: -0.1 }]) {
      const raw = Array.from({ length: 21 }, () => ({ x: 0.25, y: 0.4, z: 0 }));
      raw[index] = invalid;
      f.setRaw(raw);
      f.video.currentTime++;
      f.frame(timestamp += 100);
      assert.equal(f.frames.at(-1).hands.length, 0);
      assert.equal(f.camera._handTracks.length, 0);
      assert.match(f.statuses.at(-1).message, /손을 찾고/);
    }
  }
  f.setRaw(null);
  f.video.currentTime++;
  f.frame(timestamp += 100);
  assert.equal(f.frames.at(-1).hands.length, 0);
  f.setRaw(Array.from({ length: 21 }, () => ({ x: 0.1, y: 0.2, z: 0 })));
  f.video.currentTime++;
  f.frame(timestamp += 100);
  assert.equal(f.frames.at(-1).hands[0].landmarks[8].x, 0.9, 'Reappearing hand starts without old smoothing');
  assert.notEqual(f.frames.at(-1).hands[0].id, firstId, 'A missing hand cannot bridge to its former trail');
  f.camera.stop();
});

test('invalid optional hand joints are invisible while wrist and index remain usable', async () => {
  const f = fixture({ trackingMode: 'hand' });
  const raw = Array.from({ length: 21 }, () => ({ x: 0.25, y: 0.4, z: 0 }));
  raw[4] = null;
  raw[20] = { x: 1.2, y: 0.3, z: Infinity };
  f.setRaw(raw);
  await f.camera.start();
  f.frame(100);
  const points = f.frames[0].hands[0].landmarks;
  assert.equal(points.length, 21);
  assert.equal(points[4].visibility, 0);
  assert.equal(points[20].visibility, 0);
  assert.equal(points[20].z, 0);
  assert.equal(points[0].visibility, 1);
  assert.equal(points[8].visibility, 1);
  assert.equal(f.arcs.length, 19);
  f.camera.stop();
});

test('confident hand replacement gets a fresh ID instead of joining left and right trails', async () => {
  const f = fixture({ trackingMode: 'hand' });
  await f.camera.start();
  f.frame(100);
  const firstId = f.frames[0].hands[0].id;
  f.setHandedness({ categoryName: 'Left', score: 0.99 });
  f.video.currentTime++;
  f.frame(200);
  assert.equal(f.frames.at(-1).hands.length, 1);
  const replacedId = f.frames.at(-1).hands[0].id;
  assert.notEqual(replacedId, firstId);
  f.video.currentTime++;
  f.frame(300);
  assert.equal(f.frames.at(-1).hands[0].id, replacedId);
  f.setHandedness({ categoryName: 'Right', score: 0.55 });
  f.video.currentTime++;
  f.frame(400);
  assert.equal(f.frames.at(-1).hands[0].id, replacedId, 'Uncertain handedness should not interrupt a gesture');
  f.camera.stop();
});

test('large hand position discontinuity breaks the stroke even without handedness metadata', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHandedness(undefined);
  await f.camera.start();
  f.frame(100);
  const firstId = f.frames[0].hands[0].id;
  f.setRaw(Array.from({ length: 21 }, () => ({ x: 0.9, y: 0.4, z: 0 })));
  f.video.currentTime++;
  f.frame(200);
  assert.notEqual(f.frames.at(-1).hands[0].id, firstId);
  f.video.currentTime++;
  f.frame(300);
  assert.equal(f.frames.at(-1).hands[0].landmarks.length, 21);
  assert.ok(Math.abs(f.frames.at(-1).hands[0].landmarks[0].x - 0.1) < 1e-10);
  f.camera.stop();
});

test('stopping hand mode during model creation closes the late detector', async () => {
  const f = fixture({ trackingMode: 'hand' });
  const model = deferred();
  f.camera._createDetector = () => model.promise;
  const loading = f.camera.start();
  await new Promise(setImmediate);
  f.camera.stop();
  assert.equal(await loading, false);
  model.resolve(f.detector);
  await new Promise(setImmediate);
  assert.equal(f.closed, 1);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.scheduled.size, 0);
});

test('hand mode frozen video and consumer stop cannot leave stale callbacks', async () => {
  const f = fixture({ trackingMode: 'hand' });
  await f.camera.start();
  f.frame(100);
  f.frame(900);
  assert.equal(f.frames.at(-1).hands.length, 0);
  assert.equal(f.camera._handTracks.length, 0);
  f.camera.onFrame = () => f.camera.stop();
  f.video.currentTime++;
  f.frame(1000);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.track.stopped, 1);
});

function handAt(x, y = 0.4, categoryName) {
  return {
    landmarks: Array.from({ length: 21 }, () => ({ x, y, z: 0 })),
    handedness: categoryName ? { categoryName, score: 0.98 } : undefined
  };
}

test('both hands keep IDs and independent smoothing when detector array order reverses', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.2, 0.4, 'Left'), handAt(0.8, 0.6, 'Right')]);
  await f.camera.start();
  f.frame(100);
  const first = f.frames.at(-1).hands;
  const leftId = first.find(hand => hand.landmarks[0].x > 0.5).id;
  const rightId = first.find(hand => hand.landmarks[0].x < 0.5).id;
  assert.notEqual(leftId, rightId);
  assert.equal(f.frames.at(-1).landmarks.length, 0);
  assert.equal(f.arcs.length, 42, 'Draw the two 21-joint skeletons');
  assert.equal(new Set(f.strokes).size, 2, 'Each hand uses a different skeleton color');
  assert.match(f.statuses.at(-1).message, /양손/);
  f.setHands([handAt(0.78, 0.5, 'Right'), handAt(0.22, 0.3, 'Left')]);
  f.video.currentTime++;
  f.frame(200);
  const current = f.frames.at(-1).hands;
  const left = current.find(hand => hand.id === leftId);
  const right = current.find(hand => hand.id === rightId);
  assert.ok(left && right, 'Reordering must not replace identities');
  assert.ok(left.landmarks[8].x > .78 && left.landmarks[8].x < .8);
  assert.ok(right.landmarks[8].x > .2 && right.landmarks[8].x < .22);
  assert.ok(left.landmarks[8].y > .3 && left.landmarks[8].y < .4);
  assert.ok(right.landmarks[8].y > .5 && right.landmarks[8].y < .6);
  current[0].id = 999;
  current[0].landmarks[8].x = 999;
  f.video.currentTime++;
  f.frame(300);
  assert.ok(f.frames.at(-1).hands.every(hand => hand.id !== 999 && hand.landmarks[8].x <= 1),
    'Consumer mutation must not affect either stored track');
  f.camera.stop();
});

test('spatial matching preserves separated hand IDs without handedness metadata', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.2), handAt(0.8)]);
  await f.camera.start();
  f.frame(100);
  const first = f.frames.at(-1).hands.map(hand => ({ id: hand.id, x: hand.landmarks[0].x }));
  f.setHands([handAt(0.78), handAt(0.22)]);
  f.video.currentTime++;
  f.frame(200);
  for (const hand of f.frames.at(-1).hands) {
    const prior = first.find(item => item.id === hand.id);
    assert.ok(prior);
    assert.ok(Math.abs(prior.x - hand.landmarks[0].x) < 0.02);
  }
  f.camera.stop();
});

test('one missing hand does not break the other and returning hands get a new ID and color', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.2, 0.4, 'Left'), handAt(0.8, 0.4, 'Right')]);
  await f.camera.start();
  f.frame(100);
  const first = f.frames.at(-1).hands;
  const keptId = first.find(hand => hand.landmarks[0].x > 0.5).id;
  const lostId = first.find(hand => hand.landmarks[0].x < 0.5).id;
  const keptColor = f.camera._handTracks.find(hand => hand.id === keptId).color;
  f.setHands([handAt(0.22, 0.4, 'Left')]);
  f.video.currentTime++;
  f.frame(200);
  assert.equal(f.frames.at(-1).hands.length, 1);
  assert.equal(f.frames.at(-1).hands[0].id, keptId);
  assert.match(f.statuses.at(-1).message, /한 손/);
  f.setHands([handAt(0.78, 0.4, 'Right'), handAt(0.24, 0.4, 'Left')]);
  f.video.currentTime++;
  f.frame(300);
  const current = f.frames.at(-1).hands;
  assert.ok(current.some(hand => hand.id === keptId));
  assert.ok(current.every(hand => hand.id !== lostId));
  assert.ok(current.find(hand => hand.id !== keptId).id > Math.max(keptId, lostId));
  assert.equal(f.camera._handTracks.find(hand => hand.id === keptId).color, keptColor);
  assert.equal(new Set(f.camera._handTracks.map(hand => hand.color)).size, 2);
  f.camera.stop();
});

test('a malformed hand only removes its own track and at most two hands are processed', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.2, 0.4, 'Left'), handAt(0.8, 0.4, 'Right')]);
  await f.camera.start();
  f.frame(100);
  const keptId = f.frames.at(-1).hands.find(hand => hand.landmarks[0].x > 0.5).id;
  const malformed = handAt(0.8, 0.4, 'Right');
  malformed.landmarks[8] = { x: Infinity, y: 0.4 };
  f.setHands([malformed, handAt(0.22, 0.4, 'Left'), handAt(0.5)]);
  f.video.currentTime++;
  f.frame(200);
  assert.equal(f.frames.at(-1).hands.length, 1);
  assert.equal(f.frames.at(-1).hands[0].id, keptId);
  assert.equal(f.statuses.at(-1).kind, 'tracking');
  f.camera.stop();
});

test('both hands lost or an inference gap prevent reusing earlier trail IDs', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.2, 0.4, 'Left'), handAt(0.8, 0.4, 'Right')]);
  await f.camera.start();
  f.frame(100);
  const firstIds = f.frames.at(-1).hands.map(hand => hand.id);
  f.setHands([]);
  f.video.currentTime++;
  f.frame(200);
  assert.equal(f.frames.at(-1).hands.length, 0);
  assert.equal(f.camera._handTracks.length, 0);
  f.setHands([handAt(0.2, 0.4, 'Left'), handAt(0.8, 0.4, 'Right')]);
  f.video.currentTime++;
  f.frame(300);
  const returnedIds = f.frames.at(-1).hands.map(hand => hand.id);
  assert.ok(returnedIds.every(id => !firstIds.includes(id)));
  f.video.currentTime++;
  f.frame(700);
  assert.ok(f.frames.at(-1).hands.every(hand => !returnedIds.includes(hand.id)),
    'A long inference gap must not interpolate missing movement');
  f.camera.stop();
});

test('overlapping unlabeled hands reset ambiguous IDs instead of swapping their trails', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.4), handAt(0.6)]);
  await f.camera.start();
  f.frame(100);
  const ids = f.frames.at(-1).hands.map(hand => hand.id);
  f.setHands([handAt(0.49), handAt(0.51)]);
  f.video.currentTime++;
  f.frame(200);
  const current = f.frames.at(-1).hands;
  assert.equal(current.length, 2);
  assert.ok(current.every(hand => !ids.includes(hand.id)));
  assert.ok(current.every(hand => Math.abs(hand.landmarks[0].x - 0.5) < 0.011),
    'Ambiguous tracks must not inherit either hand smoothing history');
  f.camera.stop();
});

test('one ambiguous unlabeled hand between two former hands receives a fresh ID', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.4), handAt(0.6)]);
  await f.camera.start();
  f.frame(100);
  const ids = f.frames.at(-1).hands.map(hand => hand.id);
  f.setHands([handAt(0.5)]);
  f.video.currentTime++;
  f.frame(200);
  assert.equal(f.frames.at(-1).hands.length, 1);
  assert.ok(!ids.includes(f.frames.at(-1).hands[0].id));
  f.camera.stop();
});

test('confident handedness can preserve two crossing hands independently of their spatial order', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.4, 0.4, 'Left'), handAt(0.6, 0.4, 'Right')]);
  await f.camera.start();
  f.frame(100);
  const leftId = f.frames.at(-1).hands.find(hand => hand.landmarks[0].x > 0.5).id;
  const rightId = f.frames.at(-1).hands.find(hand => hand.landmarks[0].x < 0.5).id;
  f.setHands([handAt(0.4, 0.4, 'Right'), handAt(0.6, 0.4, 'Left')]);
  f.video.currentTime++;
  f.frame(200);
  const left = f.frames.at(-1).hands.find(hand => hand.id === leftId);
  const right = f.frames.at(-1).hands.find(hand => hand.id === rightId);
  assert.ok(left.landmarks[0].x < 0.5);
  assert.ok(right.landmarks[0].x > 0.5);
  f.camera.stop();
});

test('a frozen hand stream clears both identities and a fresh start resets IDs and resources', async () => {
  const f = fixture({ trackingMode: 'hand' });
  f.setHands([handAt(0.2), handAt(0.8)]);
  await f.camera.start();
  f.frame(100);
  const firstIds = f.frames.at(-1).hands.map(hand => hand.id);
  f.frame(900);
  assert.equal(f.frames.at(-1).hands.length, 0);
  assert.equal(f.camera._handTracks.length, 0);
  f.video.currentTime++;
  f.frame(1000);
  assert.ok(f.frames.at(-1).hands.every(hand => !firstIds.includes(hand.id)));
  f.camera.stop();
  assert.equal(f.camera._handTracks.length, 0);
  assert.equal(f.camera._nextHandId, 1);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.scheduled.size, 0);
  await f.camera.start();
  f.frame(1100);
  assert.deepEqual(Array.from(f.frames.at(-1).hands, hand => hand.id), [1, 2]);
  f.camera.stop();
  assert.equal(f.track.stopped, 2);
  assert.equal(f.closed, 2);
});


test('metric world coordinates preserve their native axes, never access faces, and never invent absent estimates', async()=>{
  const f=fixture();
  const world=Array.from({length:33},()=>({x:-.3,y:-.7,z:2.4,visibility:.95}));
  Object.defineProperty(world,4,{get(){throw new Error('World facial slot accessed');}});
  world[17]=null;
  f.setWorld([world]); await f.camera.start(); f.frame(100);
  const first=f.frames.at(-1);
  assert.equal(first.worldLandmarks.length,33);
  assert.ok(first.worldLandmarks.slice(0,11).every(point=>point===null));
  assert.equal(first.worldLandmarks[15].x,-.3,'World x stays unmirrored');
  assert.equal(first.worldLandmarks[15].y,-.7,'World y is not normalized to image height');
  assert.equal(first.worldLandmarks[15].z,2.4,'World estimates are meters, not image depth');
  assert.equal(first.worldLandmarks[17],null);
  assert.equal(first.trackingQuality.delegate,'CPU');
  assert.equal(first.trackingQuality.observedJoints,22);
  assert.equal(first.trackingQuality.worldJoints,21);
  assert.equal(first.trackingQuality.worldCoordinateSystem,'mediapipe-estimated-meters-unmirrored');
  first.worldLandmarks[15].x=999;
  f.video.currentTime++; f.frame(200);
  assert.equal(f.frames.at(-1).worldLandmarks[15].x,-.3);
  f.setWorld(undefined); f.video.currentTime++; f.frame(300);
  assert.equal(f.frames.at(-1).worldLandmarks.length,0);
  assert.equal(f.frames.at(-1).trackingQuality.worldJoints,0);
  f.camera.stop();
});

test('low-presence joints are not accepted as visible or interpolated through occlusion',async()=>{
  const f=fixture();await f.camera.start();f.frame(100);
  let raw=Array.from({length:33},()=>({x:.45,y:.4,z:0,visibility:.9,presence:.95}));
  raw[15].presence=.1;f.setRaw(raw);f.video.currentTime++;f.frame(200);
  assert.equal(f.frames.at(-1).landmarks[15].visibility,.1);
  assert.equal(f.camera._poseFilters[15],null);
  raw[15].presence=.95;f.video.currentTime++;f.frame(300);
  assert.equal(f.frames.at(-1).landmarks[15].x,.55,'Reacquisition must start at its observed coordinate');
  raw[27].presence=.1;f.video.currentTime++;f.frame(400);
  assert.equal(f.frames.at(-1).landmarks.length,0,'Uncertain required ankle pauses capture');
  f.camera.stop();
});

test('adaptive smoothing suppresses stationary jitter but follows large fast changes more promptly',()=>{
  const raw=x=>Array.from({length:33},()=>({x,y:.4,z:0,visibility:.9}));
  const slow=fixture(), fast=fixture(), still=fixture();
  slow.camera._filterPose(raw(.25),100);fast.camera._filterPose(raw(.25),100);
  const slowOutput=slow.camera._filterPose(raw(.252),200)[15].x;
  const fastOutput=fast.camera._filterPose(raw(.45),200)[15].x;
  const slowFraction=(.75-slowOutput)/.002, fastFraction=(.75-fastOutput)/.2;
  assert.ok(fastFraction>slowFraction+.15,'Motion-dependent cutoff should reduce fast-gesture lag');
  const outputs=[];
  for(let n=0;n<40;n++)outputs.push(still.camera._filterPose(raw(.25+(n%2?.0005:-.0005)),100+n*67)[15].x);
  const settled=outputs.slice(10),mean=settled.reduce((sum,x)=>sum+x,0)/settled.length;
  const deviation=Math.sqrt(settled.reduce((sum,x)=>sum+(x-mean)**2,0)/settled.length);
  assert.ok(deviation<.0004,'Visible stationary jitter should be lower than raw ±0.0005');
  const gap=fast.camera._filterPose(raw(.7),800)[15].x;
  assert.ok(Math.abs(gap-.3)<1e-10,'A gap must reset filtering rather than fabricate movement');
});

test('a running GPU detector failure releases that detector and resumes on CPU without reopening the webcam',async()=>{
  const f=fixture({delegate:'GPU'});let opens=0,cpuClosed=0;
  f.context.navigator.mediaDevices.getUserMedia=async()=>{opens++;return f.stream;};
  await f.camera.start();f.frame(100);
  f.detector.detectForVideo=()=>{throw new Error('Lost graphics context');};
  f.camera._createDetector=async(current,delegate)=>{
    assert.equal(delegate,'CPU');assert.equal(current(),true);f.camera._delegate='CPU';
    return {detectForVideo:()=>({landmarks:[Array.from({length:33},()=>({x:.2,y:.4,z:0,visibility:.9}))]}),close(){cpuClosed++;}};
  };
  f.video.currentTime++;f.frame(200);await new Promise(setImmediate);
  assert.equal(opens,1);assert.equal(f.track.stopped,0);assert.equal(f.closed,1);
  assert.equal(f.frames.at(-1).landmarks.length,0,'Pause before switching delegates');
  f.video.currentTime++;f.frame(300);
  assert.equal(f.frames.at(-1).trackingQuality.delegate,'CPU');
  assert.equal(f.frames.at(-1).landmarks[15].x,.8);
  f.camera.stop();assert.equal(cpuClosed,1);assert.equal(f.track.stopped,1);
});

test('a CPU inference failure stops rather than retrying forever',async()=>{
  const f=fixture();await f.camera.start();
  f.detector.detectForVideo=()=>{throw new Error('Model failed');};f.frame(100);
  assert.equal(f.track.stopped,1);assert.equal(f.closed,1);assert.equal(f.scheduled.size,0);
  assert.equal(f.statuses.at(-1).kind,'error');
});

test('slow inference reduces the next sample cadence instead of monopolizing the render loop',async()=>{
  const f=fixture();let elapsed=0;f.context.performance={now:()=>elapsed};
  const detect=f.detector.detectForVideo;
  f.detector.detectForVideo=(...args)=>{const result=detect(...args);elapsed+=120;return result;};
  await f.camera.start();f.frame(100);
  assert.equal(f.frames.at(-1).trackingQuality.inferenceMs,120);
  assert.equal(f.frames.at(-1).trackingQuality.sampleIntervalMs,150);
  f.video.currentTime++;f.frame(200);assert.equal(f.calls,1);
  f.frame(250);assert.equal(f.calls,2);f.camera.stop();
});

test('cancelled runtime fallback closes a late CPU detector without reviving capture',async()=>{
  const f=fixture({delegate:'GPU'});const cpu=deferred();let closed=0;
  await f.camera.start();
  f.detector.detectForVideo=()=>{throw new Error('Lost GPU');};
  f.camera._createDetector=()=>cpu.promise;
  f.frame(100);f.camera.stop();
  cpu.resolve({close(){closed++;}});await new Promise(setImmediate);
  assert.equal(closed,1);assert.equal(f.scheduled.size,0);assert.equal(f.video.srcObject,null);
});
