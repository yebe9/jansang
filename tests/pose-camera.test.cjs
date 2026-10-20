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

function fixture() {
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
  vm.runInContext(source, context);
  const track = new EventTarget();
  track.readyState = 'live';
  track.stopped = 0;
  track.stop = () => { track.stopped++; };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = {
    style: {}, setAttribute() {}, play: () => Promise.resolve(), pause() {},
    readyState: 4, currentTime: 0, videoWidth: 640, videoHeight: 480
  };
  const paint = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} };
  const overlay = { style: {}, width: 640, height: 480, getContext: () => paint };
  const frames = [], statuses = [];
  const camera = new context.window.JansangPoseCamera({
    video, overlay, onFrame: frame => frames.push(frame), onStatus: status => statuses.push(status)
  });
  let closed = 0, calls = 0;
  let raw = Array.from({ length: 33 }, () => ({ x: 0.25, y: 0.4, z: 0.1, visibility: 0.9 }));
  const detector = {
    detectForVideo() { calls++; return { landmarks: raw ? [raw] : [], close() {} }; },
    close() { closed++; }
  };
  camera._createDetector = () => Promise.resolve(detector);
  context.navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  function frame(timestamp) {
    const entry = scheduled.entries().next().value;
    assert.ok(entry, 'A frame callback should be scheduled');
    scheduled.delete(entry[0]);
    entry[1](timestamp);
  }
  return {
    camera, track, stream, video, frames, statuses, detector, context, scheduled, frame,
    get closed() { return closed; }, get calls() { return calls; },
    setRaw(value) { raw = value; }
  };
}

test('mirrors normalized joints, throttles inference, and releases camera resources', async () => {
  const f = fixture();
  assert.equal(await f.camera.start(), true);
  f.frame(100);
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].landmarks.length, 33);
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
  occluded[15].visibility = 0.2;
  occluded[16].visibility = 0.2;
  f.setRaw(occluded);
  f.video.currentTime = 2;
  f.frame(300);
  assert.equal(f.frames.at(-1).landmarks.length, 0);
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
