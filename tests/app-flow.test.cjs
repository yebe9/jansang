const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dist = path.join(__dirname, '..', 'dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
const motionSource = fs.readFileSync(path.join(dist, 'motion-analysis.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// A deliberately small event surface: rendering and camera hardware are mocked,
// while app.js, motion measurements, event handlers and request bodies are real.
function createApp({ fetchResponse, cameraStart } = {}) {
  let now = 0;
  let animation;
  const timers = new Map();
  let timerId = 0;
  const reports = [];
  const calls = [];
  const cameras = [];
  const failures = [];
  const noop = () => {};
  const gl = new Proxy({}, {
    get(_target, key) {
      if (['getShaderParameter', 'getProgramParameter'].includes(key)) return () => true;
      if (key === 'getAttribLocation') return () => 1;
      if (['createShader', 'createProgram', 'createBuffer'].includes(key)) return () => ({});
      return /^[A-Z_]+$/.test(key) ? 1 : noop;
    },
  });

  class Element {
    constructor(tagName = 'div', attributes = '') {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.events = new Map();
      this.dataset = {};
      this.children = [];
      this.style = {};
      this.hidden = /\bhidden(?:\s|=|$)/.test(attributes);
      this.checked = /\bchecked(?:\s|=|$)/.test(attributes);
      this.disabled = /\bdisabled(?:\s|=|$)/.test(attributes);
      this.open = false;
      this.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
      this.textContent = '';
      this.firstChild = { textContent: '' };
      this.clientWidth = 800;
      this.clientHeight = 600;
      this.videoWidth = 640;
      this.videoHeight = 480;
      this.classList = { toggle: noop };
      for (const [, key, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
        this.attributes.set(key, value);
        if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
      }
    }
    addEventListener(name, callback) {
      if (!this.events.has(name)) this.events.set(name, []);
      this.events.get(name).push(callback);
    }
    dispatch(name, properties = {}) {
      const event = { target: this, preventDefault: noop, ...properties };
      return Promise.all((this.events.get(name) || []).map(callback => callback(event)));
    }
    click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    append(...children) { this.children.push(...children); }
    after() {}
    replaceChildren(...children) { this.children = children; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    getContext() { return gl; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    hasPointerCapture() { return false; }
    setPointerCapture() {}
    releasePointerCapture() {}
  }

  const elements = new Map();
  for (const [, tag, attributes, id] of html.matchAll(/<([a-z][\w:-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    elements.set(id, new Element(tag, attributes));
  }
  const feelings = [...html.matchAll(/<button\b([^>]*\bdata-feeling="([^"]+)"[^>]*)>/g)]
    .map(match => new Element('button', match[1]));
  const document = new Element();
  document.body = new Element('body');
  document.getElementById = id => {
    assert.ok(elements.has(id), `App references existing HTML element #${id}`);
    return elements.get(id);
  };
  document.querySelectorAll = selector => selector === '.feelings button' ? feelings : [];
  document.createElement = tag => new Element(tag);

  class Camera {
    constructor(options) {
      this.options = options;
      this.stopped = false;
      cameras.push(this);
    }
    async start({ deviceId = '' } = {}) {
      this.requestedDeviceId = deviceId;
      this.options.onDevices({
        devices: [
          { deviceId: 'built-in', label: 'Built-in camera' },
          { deviceId: 'usb-camera', label: 'USB camera' },
        ],
        selectedDeviceId: deviceId || 'built-in',
      });
      if (cameraStart) {
        const ready = await cameraStart(this);
        if (ready !== undefined) return ready;
      }
      this.options.onStatus({ kind: 'ready', message: 'Mock camera ready' });
      return true;
    }
    stop() { this.stopped = true; }
    tracking() { this.options.onStatus({ kind: 'tracking', message: 'Mock body tracked' }); }
    emit(timestamp, landmarks) {
      now = timestamp;
      this.options.onFrame({ timestamp, landmarks });
      if (animation) animation(timestamp);
    }
  }

  const window = new Element('window');
  window.devicePixelRatio = 1;
  window.scrollTo = noop;
  window.JansangPoseCamera = Camera;
  window.JANSANG_CONFIG = { apiBase: '' };
  const context = vm.createContext({
    window, document, location: { hostname: '127.0.0.1' },
    performance: { now: () => now }, URL, AbortController, Map, Set, Float32Array,
    ResizeObserver: class { observe() {} },
    requestAnimationFrame(callback) { animation = callback; return 1; },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { error: (...args) => failures.push(args) },
    fetch: async (url, options) => {
      const call = { url, options, payload: JSON.parse(options.body) };
      calls.push(call);
      if (!fetchResponse) throw new Error('Unexpected network request in test');
      return fetchResponse(call);
    },
  });
  vm.runInContext(motionSource, context, { filename: 'motion-analysis.js' });
  const analyze = window.JansangMotion.analyze;
  window.JansangMotion.analyze = input => {
    const report = analyze(input);
    reports.push({ input: copy(input), report: copy(report) });
    return report;
  };
  vm.runInContext(appSource, context, { filename: 'app.js' });
  assert.equal(failures.length, 0, 'WebGL initialization succeeded with the mock');
  return {
    elements, document, cameras, reports, calls, timers,
    get: id => elements.get(id),
    click: id => elements.get(id).click(),
    setTime: value => { now = value; },
    async startWebcam() {
      await elements.get('input-webcam').click();
      await elements.get('start').click();
      await flush();
      const camera = cameras.at(-1);
      camera.tracking();
      await elements.get('camera-record').click();
      return camera;
    },
  };
}

function landmarks(left = 0.25, right = 0.75) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  for (const [index, x, y] of [
    [11, 0.4, 0.3], [12, 0.6, 0.3], [13, 0.3, 0.4], [14, 0.7, 0.4],
    [15, left, 0.5], [16, right, 0.5], [23, 0.45, 0.7], [24, 0.55, 0.7],
  ]) points[index] = { x, y, z: 0, visibility: 0.9 };
  return points;
}

function record(camera, start = 1000, count = 21, left = 0.2) {
  for (let i = 0; i < count; i++) camera.emit(start + i * 65, landmarks(left + i * 0.003, 0.8 - i * 0.003));
}

const aiResult = {
  provider: 'Gemini', model: 'test-model',
  analysis: {
    impression: '흐르는 듯한', description: '두 손이 서서히 가까워지는 인상입니다.',
    observations: ['손목의 거리가 줄어듭니다.'], qualities: ['부드러운'],
    caveat: '실제 감정을 판정한 결과가 아닙니다.',
  },
};
const ok = body => ({ ok: true, json: async () => body });

test('webcam recording pauses without joining movements across the gap and finishes into local analysis', async () => {
  const app = createApp();
  assert.equal(app.get('start-dialog').open, true);
  const camera = await app.startWebcam();
  assert.equal(app.document.body.dataset.view, 'drawing');
  record(camera);
  await app.click('pause');
  const pausedCount = app.get('point-count').textContent;
  camera.emit(4000, landmarks(0.95, 0.05));
  assert.equal(app.get('point-count').textContent, pausedCount, 'Paused motion is not recorded');
  await app.click('pause');
  record(camera, 5000, 11, 0.7);
  await app.click('finish');
  assert.equal(camera.stopped, true);
  assert.equal(app.document.body.dataset.view, 'result');
  assert.equal(app.get('result-dialog').open, true);
  const { input, report } = app.reports.at(-1);
  assert.equal(input.source, 'webcam');
  assert.equal(input.durationMs, 1950, 'Paused wall-clock time is excluded');
  assert.deepEqual([...new Set(report.payload.samples.map(sample => sample.segment))], [1, 2]);
  assert.equal(report.sufficient, true);
  assert.ok(report.payload.metrics.pathLength < 0.15, 'Jump during pause is not counted in traveled distance');
  assert.equal(app.get('analysis-badge').textContent, '기본 수치 분석');
  assert.equal(app.calls.length, 0);
  assert.equal(app.get('analyze-button').disabled, false);
});

test('tracking loss also opens a new recording segment, and finishing stops camera access', async () => {
  const app = createApp();
  const camera = await app.startWebcam();
  record(camera);
  camera.emit(2400, []);
  record(camera, 4000, 11, 0.7);
  await app.click('finish');
  const { input, report } = app.reports.at(-1);
  assert.equal(input.durationMs, 2050);
  assert.deepEqual([...new Set(report.payload.samples.map(sample => sample.segment))], [1, 2]);
  assert.equal(camera.stopped, true);
  assert.ok(report.payload.metrics.pathLength < 0.15);
});

test('choosing a camera replaces the stream and ignores old callbacks, then locks selection after recording begins', async () => {
  const app = createApp();
  await app.click('input-webcam');
  await app.click('start');
  await flush();
  const original = app.cameras[0];
  const select = app.get('camera-select');
  assert.equal(original.requestedDeviceId, '');
  assert.deepEqual(select.children.map(option => [option.value, option.textContent]), [
    ['', '자동 선택'], ['built-in', 'Built-in camera'], ['usb-camera', 'USB camera'],
  ]);
  assert.equal(select.value, 'built-in');
  assert.equal(select.disabled, false);

  select.value = 'usb-camera';
  await select.dispatch('change');
  await flush();
  const replacement = app.cameras[1];
  assert.equal(app.cameras.length, 2);
  assert.equal(original.stopped, true);
  assert.equal(replacement.requestedDeviceId, 'usb-camera');
  assert.equal(select.value, 'usb-camera');
  replacement.tracking();
  await app.click('camera-record');
  const countBefore = app.get('point-count').textContent;
  original.options.onDevices({
    devices: [{ deviceId: 'old-device', label: 'Stale device' }], selectedDeviceId: 'old-device',
  });
  original.options.onStatus({ kind: 'error', message: 'Stale camera failure' });
  original.emit(500, landmarks());
  assert.equal(select.value, 'usb-camera');
  assert.equal(select.children.length, 3);
  assert.equal(app.get('camera-status').textContent, 'Mock body tracked');
  assert.equal(app.get('camera-retry').hidden, true);
  assert.equal(app.get('point-count').textContent, countBefore, 'Replaced camera cannot append a pose');

  record(replacement);
  assert.equal(select.disabled, true);
  select.value = 'built-in';
  await select.dispatch('change');
  await flush();
  assert.equal(app.cameras.length, 2, 'Even a synthetic change cannot switch a recorded take');
  assert.equal(replacement.stopped, false);
  await app.click('finish');
  assert.equal(app.reports.at(-1).report.sufficient, true);
});

test('a failed initial camera connection can be retried without leaving the recording screen', async () => {
  let starts = 0;
  const app = createApp({
    cameraStart() {
      if (++starts === 1) throw new Error('Camera is busy');
    },
  });
  await app.click('input-webcam');
  await app.click('start');
  await flush();
  assert.equal(app.document.body.dataset.view, 'drawing');
  assert.equal(app.get('camera-status').textContent, 'Camera is busy');
  assert.equal(app.get('camera-retry').hidden, false);
  assert.equal(app.get('camera-record').disabled, true);

  await app.click('camera-retry');
  await flush();
  assert.equal(app.cameras[0].stopped, true);
  const replacement = app.cameras[1];
  assert.equal(replacement.requestedDeviceId, 'built-in');
  assert.equal(app.get('camera-retry').hidden, true);
  assert.equal(app.get('camera-record').disabled, true, 'A connected camera still waits for body tracking');
  replacement.tracking();
  assert.equal(app.get('camera-record').disabled, false);
  await app.click('camera-record');
  record(replacement);
  await app.click('finish');
  assert.equal(app.reports.at(-1).input.source, 'webcam');
  assert.equal(app.reports.at(-1).report.sufficient, true);
});

test('retrying after a camera error preserves the recorded segment and resumes only when requested', async () => {
  const app = createApp();
  const original = await app.startWebcam();
  record(original);
  const countBefore = app.get('point-count').textContent;
  original.options.onStatus({ kind: 'error', message: 'Camera disconnected' });
  assert.equal(app.get('camera-retry').hidden, false);
  assert.match(app.get('stage-status').textContent, /PAUSE/);

  await app.click('camera-retry');
  await flush();
  const replacement = app.cameras[1];
  assert.equal(original.stopped, true);
  assert.equal(replacement.requestedDeviceId, 'built-in');
  assert.equal(app.get('point-count').textContent, countBefore);
  assert.equal(app.get('camera-select').disabled, true);
  assert.equal(app.get('camera-record').hidden, true);
  replacement.tracking();
  replacement.emit(4000, landmarks(0.95, 0.05));
  assert.equal(app.get('point-count').textContent, countBefore, 'Reconnecting does not silently resume recording');
  await app.click('pause');
  record(replacement, 5000, 11, 0.7);
  await app.click('finish');

  const { input, report } = app.reports.at(-1);
  assert.equal(input.durationMs, 1950, 'Reconnection time is excluded');
  assert.deepEqual([...new Set(report.payload.samples.map(sample => sample.segment))], [1, 2]);
  assert.equal(input.poseFrames[0].joints.leftWrist[0], 0.2, 'The first take remains in the result');
  assert.ok(report.payload.metrics.pathLength < 0.15, 'Reconnection does not draw a jump between takes');
  assert.equal(replacement.stopped, true);
});

test('synthetic example retains its source and never auto-sends even when automatic AI is checked', async () => {
  const app = createApp();
  app.get('ai-consent').checked = true;
  await app.click('example');
  assert.equal(app.reports.at(-1).report.payload.source, 'example');
  assert.equal(app.get('analysis-badge').textContent, '합성 예시 · 수치 분석');
  assert.equal(app.calls.length, 0);
});

test('automatic AI sends only movement data and renders a successful interpretation beside private intent', async () => {
  const app = createApp({ fetchResponse: async () => ok(aiResult) });
  app.get('ai-consent').checked = true;
  const camera = await app.startWebcam();
  app.get('intent-detail').value = '개인적인 의도는 외부에 보내지 않기';
  await app.get('intent-detail').dispatch('input');
  record(camera);
  await app.click('finish');
  await flush();
  assert.equal(app.calls.length, 1);
  const { payload, options } = app.calls[0];
  assert.deepEqual(Object.keys(payload).sort(), ['durationMs', 'metrics', 'sampleCount', 'samples', 'source']);
  assert.ok(!options.body.includes('개인적인'));
  assert.ok(!options.body.includes('data:image'));
  assert.equal(payload.source, 'webcam');
  assert.equal(options.credentials, 'omit');
  assert.equal(app.get('ai-word').textContent, aiResult.analysis.impression);
  assert.equal(app.get('analysis-badge').textContent, 'Gemini 해석');
  assert.equal(app.get('analysis-observations').children[0].textContent, aiResult.analysis.observations[0]);
  assert.equal(app.get('analyze-button').disabled, false);
});

test('a fresh take aborts an in-flight request and ignores its delayed success', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const app = createApp({ fetchResponse: () => response });
  app.get('ai-consent').checked = true;
  const camera = await app.startWebcam();
  record(camera);
  await app.click('finish');
  await flush();
  assert.equal(app.calls.length, 1);
  const signal = app.calls[0].options.signal;
  assert.equal(signal.aborted, false);
  await app.click('restart');
  await app.click('input-pointer');
  await app.click('start');
  assert.equal(signal.aborted, true);
  assert.equal(app.document.body.dataset.view, 'drawing');
  resolve(ok(aiResult));
  await flush();
  assert.equal(app.get('ai-word').textContent, '기록 전');
  assert.equal(app.get('analysis-badge').textContent, '기본 수치 분석');
  assert.equal(app.timers.size, 0, 'Completed stale request clears its timeout');
});

test('an AI error keeps measured local results and shows the server guidance', async () => {
  const app = createApp({ fetchResponse: async () => ({
    ok: false, json: async () => ({ error: { code: 'PROVIDER_QUOTA', message: '무료 사용량 한도에 도달했습니다.' } }),
  }) });
  app.get('ai-consent').checked = true;
  const camera = await app.startWebcam();
  record(camera);
  await app.click('finish');
  await flush();
  assert.equal(app.get('analysis-badge').textContent, '기본 수치 분석');
  assert.equal(app.get('ai-word').textContent, app.reports.at(-1).report.local.impression);
  assert.match(app.get('analysis-status').textContent, /무료 사용량 한도/);
  assert.match(app.get('analysis-status').textContent, /기본 수치 분석/);
  assert.equal(app.get('analyze-button').disabled, false);
});
