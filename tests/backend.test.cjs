const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = import('../api/handler.mjs');
const origin = 'https://yebe9.github.io';
const env = { GEMINI_API_KEY: 'mock-server-key', ALLOWED_ORIGIN: origin };
const motion = () => ({
  source: 'webcam', durationMs: 1000, sampleCount: 20,
  metrics: { meanSpeed: 0.2, stillnessRatio: 0.1, validFrameRatio: 0.9 },
  samples: [
    { t: 0, joints: { leftWrist: [0.2, 0.3], rightWrist: [0.7, 0.2] } },
    { t: 1000, joints: { leftWrist: [0.4, 0.5], rightWrist: [0.8, 0.4] } },
  ],
});
const request = (body = motion(), headers = {}) => new Request('https://worker.test/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
  body: JSON.stringify(body),
});
const noFetch = async () => { throw new Error('Provider must not be called'); };
const validAnalysis = {
  impression: '흐르는 듯한', description: '손목의 위치가 부드럽게 옮겨갑니다.',
  observations: ['두 손목이 아래쪽으로 이동합니다.'], qualities: ['유연한'],
  caveat: '원본 영상은 보지 않았습니다.',
};
const goodResponse = () => new Response(JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(validAnalysis) }] } }],
}), { status: 200 });

test('status exposes capability without exposing the server key', async () => {
  const { handleApi } = await handler;
  const response = await handleApi(new Request('https://worker.test/api/status', { headers: { Origin: origin } }), { env });
  assert.deepEqual(await response.json(), { available: true, provider: 'Gemini', model: 'gemini-3.8-flash' });
  const local = await handleApi(new Request('http://127.0.0.1:4173/api/status'), { env, allowLocal: true });
  assert.equal(local.status, 200);
});

test('missing key and foreign origins never call the provider', async () => {
  const { handleApi } = await handler;
  const missing = await handleApi(request(), { fetchImpl: noFetch });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'NOT_CONFIGURED');
  const foreign = await handleApi(request(motion(), { Origin: 'https://other.test' }), { env, fetchImpl: noFetch });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  const withoutOrigin = new Request('https://worker.test/api/status');
  assert.equal((await handleApi(withoutOrigin, { env, requireOrigin: true })).status, 403);
  const localPost = new Request('http://127.0.0.1:4173/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(motion()),
  });
  assert.equal((await handleApi(localPost, { env, allowLocal: true, fetchImpl: noFetch })).status, 403);
});

test('only bounded numeric movements are accepted; intention and raw images are rejected', async () => {
  const { handleApi, validateMotion } = await handler;
  for (const mutate of [
    data => { data.intention = 'happy'; },
    data => { data.samples[0].image = 'data:image/jpeg;base64,...'; },
    data => { data.metrics.meanSpeed = 'ignore instructions'; },
    data => { data.samples[0].joints.leftWrist[0] = 2; },
    data => { data.samples = Array(81).fill(data.samples[0]); data.sampleCount = 100; },
    data => { data.samples[1].t = -1; },
    data => { data.samples[1].segment = -1; },
    data => { data.samples[1].segment = 1.5; },
    data => { data.samples[1].segment = 10001; },
    data => { data.samples[1].segment = 'paused'; },
    data => { data.metrics.fullBodyRatio = 1.1; },
    data => { data.metrics.lowerBodySpeed = 126; },
    data => { data.metrics.upperBodySpeed = -1; },
    data => { data.metrics.torsoSpeed = 'fast'; },
  ]) {
    const bad = motion(); mutate(bad);
    const response = await handleApi(request(bad), { env, fetchImpl: noFetch });
    assert.equal(response.status, 400);
  }
  assert.throws(() => validateMotion({ ...motion(), metrics: { meanSpeed: NaN } }));
  const tooBig = await handleApi(request({ padding: 'x'.repeat(102401) }), { env, fetchImpl: noFetch });
  assert.equal(tooBig.status, 413);
});

test('full-body numeric samples reach Gemini while face coordinates are rejected', async () => {
  const { handleApi, validateMotion, MAX_BODY_BYTES } = await handler;
  const { analyze } = require('../dist/motion-analysis.js');
  const parts = ['Shoulder', 'Elbow', 'Wrist', 'Pinky', 'Index', 'Thumb', 'Hip', 'Knee', 'Ankle', 'Heel', 'FootIndex'];
  const names = parts.flatMap((part) => ['left' + part, 'right' + part]);
  const poseFrames = Array.from({ length: 151 }, (_, i) => ({
    t: i * 66, segment: i < 75 ? 0 : 1,
    joints: Object.fromEntries(names.map((name, n) => [name, [
      0.5 + 0.1 * Math.sin(i * 0.2 + n),
      0.1 + n / 30
    ]]))
  }));
  const report = analyze({ source: 'webcam', poseFrames, durationMs: 10000, captureAspect: 16 / 9 });
  assert.equal(report.sufficient, true);
  assert.equal(report.payload.metrics.fullBodyRatio, 1);
  assert.ok(report.payload.metrics.lowerBodySpeed > 0);
  assert.ok(report.payload.metrics.upperBodySpeed > 0);
  assert.ok(report.payload.metrics.torsoSpeed > 0);
  assert.equal(Object.keys(report.payload.samples[0].joints).length, 22);
  assert.ok(Buffer.byteLength(JSON.stringify(report.payload), 'utf8') < MAX_BODY_BYTES);
  assert.deepEqual(validateMotion(report.payload), report.payload);
  const response = await handleApi(request(report.payload), { env, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), report.payload);
    assert.match(body.systemInstruction.parts[0].text, /스텝과 다리 리듬/);
    assert.match(body.systemInstruction.parts[0].text, /숫자나 지표명은 description과 observations에 절대 나열하지 않는다/);
    assert.match(body.systemInstruction.parts[0].text, /"초조한".*장면의 인상/);
    assert.equal(body.generationConfig.responseSchema.properties.qualities.minItems, 3);
    assert.equal(body.generationConfig.responseSchema.properties.qualities.maxItems, 3);
    return goodResponse();
  } });
  assert.equal(response.status, 200);
  for (const face of ['nose', 'leftEye', 'rightEye', 'leftEar', 'mouthLeft']) {
    const faceMotion = motion();
    faceMotion.samples[0].joints[face] = [0.5, 0.1];
    const rejected = await handleApi(request(faceMotion), { env, fetchImpl: noFetch });
    assert.equal(rejected.status, 400, face + ' must not reach Gemini');
    assert.equal((await rejected.json()).error.code, 'INVALID_MOTION');
  }
});

test('hand traces reach Gemini with the selected target and no unsupported whole-body claims', async () => {
  const { handleApi, validateMotion, MAX_BODY_BYTES } = await handler;
  const { analyze } = require('../dist/motion-analysis.js');
  const names = [
    'wrist', 'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
    'indexMcp', 'indexPip', 'indexDip', 'indexTip',
    'middleMcp', 'middlePip', 'middleDip', 'middleTip',
    'ringMcp', 'ringPip', 'ringDip', 'ringTip',
    'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip'
  ];
  const poseFrames = Array.from({ length: 151 }, (_, i) => ({
    t: i * 66, segment: i < 75 ? 0 : 1,
    joints: Object.fromEntries(names.map((name, n) => [name, [
      0.4 + 0.1 * Math.sin(i * 0.2 + n), 0.3 + n / 50
    ]]))
  }));
  for (const handTarget of ['indexTip', 'wrist']) {
    const points = poseFrames.map((frame) => ({
      t: frame.t, stroke: frame.segment,
      x: frame.joints[handTarget][0], y: frame.joints[handTarget][1]
    }));
    const report = analyze({ source: 'hand', handTarget, poseFrames, points, durationMs: 10000 });
    assert.equal(report.sufficient, true);
    assert.equal(report.payload.samples.length, 60);
    assert.equal(Object.keys(report.payload.samples[0].hands[0].joints).length, 21);
    assert.ok(Buffer.byteLength(JSON.stringify(report.payload), 'utf8') < MAX_BODY_BYTES);
    assert.deepEqual(validateMotion(report.payload), report.payload);
    const response = await handleApi(request(report.payload), { env, fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), report.payload);
      const prompt = body.systemInstruction.parts[0].text;
      assert.match(prompt, /source가 hand이면 웹캠으로 한 손 또는 두 손을 관측/);
      assert.match(prompt, /전신 자세, 스텝이나 춤을 보았다고 쓰지 않는다/);
      assert.match(prompt, /handTarget이 indexTip이면 선택한 검지 끝, wrist이면 선택한 손목/);
      assert.match(prompt, /전신 관절이나 fullBodyRatio가 없다는 이유로 손 기록을 불충분하다고 판단하지 않는다/);
      return goodResponse();
    } });
    assert.equal(response.status, 200);
  }
});

test('two complete observed hands fit the bounded request and reach Gemini as separate tracks', async () => {
  const { handleApi, validateMotion, MAX_BODY_BYTES } = await handler;
  const { analyze } = require('../dist/motion-analysis.js');
  const names = [
    'wrist', 'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
    'indexMcp', 'indexPip', 'indexDip', 'indexTip',
    'middleMcp', 'middlePip', 'middleDip', 'middleTip',
    'ringMcp', 'ringPip', 'ringDip', 'ringTip',
    'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip'
  ];
  const poseFrames = Array.from({ length: 151 }, (_, i) => ({
    t: i * 66.123, segment: 10000,
    hands: [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER].map((id, n) => ({
      id, joints: Object.fromEntries(names.map((name, j) => [name, [
        0.5 + (n ? -1 : 1) * 0.1 * Math.sin(i * 0.13 + j),
        0.4 + 0.1 * Math.cos(i * 0.13 + j)
      ]]))
    }))
  }));
  const report = analyze({ source: 'hand', handTarget: 'indexTip', poseFrames, durationMs: 10000 });
  assert.equal(report.sufficient, true);
  assert.equal(report.payload.samples.length, 60);
  assert.ok(report.payload.samples.every((frame) =>
    frame.hands.length === 2 && frame.hands.every((hand) => Object.keys(hand.joints).length === 21)));
  assert.ok(Buffer.byteLength(JSON.stringify(report.payload), 'utf8') < MAX_BODY_BYTES);
  // Worst-length rounded coordinates and timestamps also fit the request bound.
  const largest = structuredClone(report.payload);
  largest.samples.forEach((frame, i) => {
    frame.t = 1000.001 + i * 100;
    frame.hands.forEach((hand) => Object.keys(hand.joints).forEach((name) => {
      hand.joints[name] = [0.12345, 0.98765];
    }));
  });
  assert.ok(Buffer.byteLength(JSON.stringify(largest), 'utf8') < MAX_BODY_BYTES);
  assert.deepEqual(validateMotion(report.payload), report.payload);
  const response = await handleApi(request(report.payload), { env, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), report.payload);
    const prompt = body.systemInstruction.parts[0].text;
    assert.match(prompt, /해부학적 왼손·오른손을 뜻하지 않는다/);
    assert.match(prompt, /두 손이 동시에 보인 연속 구간에서만/);
    assert.match(prompt, /한 손씩 번갈아 관측된 기록으로 두 손의 협응을 상상하지 않는다/);
    assert.match(prompt, /같은 시간 구간을 두 번 세지 않는다/);
    assert.equal(body.generationConfig.responseSchema.properties.qualities.minItems, 3);
    assert.equal(body.generationConfig.responseSchema.properties.qualities.maxItems, 3);
    return goodResponse();
  } });
  assert.equal(response.status, 200);
});

test('legacy single-hand API clients are accepted and normalized to a single track', async () => {
  const { handleApi, validateMotion } = await handler;
  const legacy = {
    source: 'hand', handTarget: 'indexTip', durationMs: 1000, sampleCount: 20,
    metrics: { meanSpeed: 0.3, validFrameRatio: 1 },
    samples: [
      { t: 0, joints: { wrist: [0.3, 0.5], indexTip: [0.3, 0.2] } },
      { t: 1000, segment: 1, joints: { wrist: [0.3, 0.5], indexTip: [0.7, 0.2] } }
    ]
  };
  const normalized = validateMotion(legacy);
  assert.deepEqual(normalized.samples[0], {
    t: 0, hands: [{ id: 1, joints: legacy.samples[0].joints }]
  });
  assert.equal(normalized.samples[1].segment, 1);
  const response = await handleApi(request(legacy), { env, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), normalized);
    return goodResponse();
  } });
  assert.equal(response.status, 200);
});

test('dual-hand API rejects ambiguous IDs, mixed schemas, extra people and non-hand data', async () => {
  const { handleApi } = await handler;
  const dual = () => ({
    source: 'hand', handTarget: 'indexTip', durationMs: 1000, sampleCount: 60,
    metrics: { meanSpeed: 0.3, validFrameRatio: 1 },
    samples: [0, 1000].map(t => ({
      t, segment: 0,
      hands: [1, 2].map(id => ({ id, joints: { wrist: [0.3, 0.5], indexTip: [0.7, 0.2] } }))
    }))
  });
  for (const mutate of [
    data => { data.samples[0].hands[1].id = 1; },
    data => { data.samples[0].hands[1].id = 0; },
    data => { data.samples[0].hands[1].id = 1.5; },
    data => { data.samples[0].hands[1].id = Number.MAX_SAFE_INTEGER + 1; },
    data => { data.samples[0].hands[1].id = 'Right'; },
    data => { data.samples[0].hands.push({ ...data.samples[0].hands[0], id: 3 }); },
    data => { data.samples[0].hands = []; },
    data => { data.samples[0].hands[0].joints.nose = [0.5, 0.1]; },
    data => { data.samples[0].hands[0].joints.leftWrist = [0.5, 0.1]; },
    data => { delete data.samples[0].hands[1].joints.indexTip; },
    data => { data.samples[0].hands[1].joints.indexTip = [Infinity, 0.5]; },
    data => { data.samples[0].hands[0].image = 'data:image/png;base64,...'; },
    data => { data.samples[0].joints = data.samples[0].hands[0].joints; },
    data => { data.samples[1].joints = data.samples[1].hands[0].joints; delete data.samples[1].hands; },
    data => { data.samples = Array(61).fill(data.samples[0]); data.sampleCount = 61; },
    data => { data.intention = '초조한'; },
  ]) {
    const bad = dual(); mutate(bad);
    const response = await handleApi(request(bad), { env, fetchImpl: noFetch });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_MOTION');
  }
  const oneVisible = dual();
  oneVisible.samples[1].hands = [oneVisible.samples[1].hands[1]];
  assert.equal((await handleApi(request(oneVisible), { env, fetchImpl: async () => goodResponse() })).status, 200);
});

test('hand and body joint schemas stay separate and hand selection is constrained', async () => {
  const { handleApi } = await handler;
  const handMotion = () => ({
    source: 'hand', handTarget: 'indexTip', durationMs: 1000, sampleCount: 20,
    metrics: { meanSpeed: 0.3, validFrameRatio: 1 },
    samples: [
      { t: 0, segment: 0, joints: { wrist: [0.3, 0.5], indexTip: [0.3, 0.2] } },
      { t: 1000, segment: 1, joints: { wrist: [0.3, 0.5], indexTip: [0.7, 0.2] } }
    ]
  });
  for (const mutate of [
    data => { data.source = 'face'; },
    data => { delete data.handTarget; },
    data => { data.handTarget = 'nose'; },
    data => { data.handTarget = 'leftWrist'; },
    data => { data.samples[0].joints.nose = [0.5, 0.1]; },
    data => { data.samples[0].joints.leftShoulder = [0.5, 0.1]; },
    data => { data.samples[0].joints.leftWrist = [0.5, 0.1]; },
    data => { data.samples[0].joints.indexTip = [0.5, 'right']; },
    data => { delete data.samples[0].joints.indexTip; },
    data => { data.metrics.fullBodyRatio = 0; },
    data => { data.metrics.lowerBodySpeed = 0; },
    data => { data.intention = '초조한'; },
    data => { data.samples[0].image = 'data:image/png;base64,...'; },
  ]) {
    const bad = handMotion(); mutate(bad);
    const response = await handleApi(request(bad), { env, fetchImpl: noFetch });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_MOTION');
  }
  const webcamWithHand = motion();
  webcamWithHand.samples[0].joints.indexTip = [0.3, 0.2];
  assert.equal((await handleApi(request(webcamWithHand), { env, fetchImpl: noFetch })).status, 400);
  const webcamWithTarget = motion();
  webcamWithTarget.handTarget = 'wrist';
  assert.equal((await handleApi(request(webcamWithTarget), { env, fetchImpl: noFetch })).status, 400);
});

test('pause segment identifiers survive validation and reach the model', async () => {
  const { handleApi } = await handler;
  const segmented = motion();
  segmented.samples[0].segment = 1;
  segmented.samples[1].segment = 2;
  const response = await handleApi(request(segmented), { env, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), segmented);
    assert.match(body.systemInstruction.parts[0].text, /다른 segment 사이를 연결하거나/);
    assert.match(body.systemInstruction.parts[0].text, /화면 대각선 길이를 1/);
    return goodResponse();
  } });
  assert.equal(response.status, 200);
});

test('browser motion analyzer emits a payload accepted by the API after a pause', async () => {
  const { validateMotion } = await handler;
  const { analyze } = require('../dist/motion-analysis.js');
  const frames = Array.from({ length: 151 }, (_, i) => ({
    t: i * 66,
    segment: i < 75 ? 1 : 2,
    joints: {
      leftShoulder: [0.4, 0.3], rightShoulder: [0.6, 0.3],
      leftWrist: [0.2 + i / 1000, 0.5], rightWrist: [0.8 - i / 1000, 0.5],
    },
  }));
  const report = analyze({ source: 'webcam', poseFrames: frames, durationMs: 10000, captureAspect: 4 / 3 });
  assert.equal(report.sufficient, true);
  assert.ok(report.payload.samples.length <= 60);
  assert.deepEqual(validateMotion(report.payload), report.payload);
  assert.equal(report.payload.samples.at(-1).segment, 2);
});

test('successful analysis uses an env key and constrained JSON prompt, retaining no raw video', async () => {
  const { handleApi } = await handler;
  let calls = 0;
  const response = await handleApi(request(), { env, fetchImpl: async (url, init) => {
    calls += 1;
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    assert.ok(!url.includes(env.GEMINI_API_KEY));
    assert.equal(init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    const body = JSON.parse(init.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), motion());
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.match(url, /models\/gemini-3\.8-flash:generateContent$/);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.match(body.systemInstruction.parts[0].text, /실제 감정/);
    return goodResponse();
  } });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const result = await response.json();
  assert.equal(result.analysis.impression, validAnalysis.impression);
  assert.match(result.analysis.caveat, /실제 감정이나 의도를 판정한 결과가 아닙니다/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.ok(!JSON.stringify(result).includes(env.GEMINI_API_KEY));
});

test('provider quota, rejected key, outage, malformed output and timeout are actionable errors', async () => {
  const { handleApi } = await handler;
  const cases = [
    [async () => new Response('{}', { status: 429 }), 429, 'PROVIDER_QUOTA'],
    [async () => new Response('{}', { status: 403 }), 503, 'PROVIDER_CONFIG'],
    [async () => new Response('{}', { status: 404 }), 503, 'MODEL_UNAVAILABLE'],
    [async () => new Response('{}', { status: 500 }), 502, 'PROVIDER_UNAVAILABLE'],
    [async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] })), 502, 'INVALID_ANALYSIS'],
    [async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] })), 502, 'INCOMPLETE_ANALYSIS'],
    [(_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), 504, 'AI_TIMEOUT'],
  ];
  for (const [fetchImpl, status, code] of cases) {
    const response = await handleApi(request(), { env, fetchImpl, timeoutMs: 20 });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test('rate limit prevents upstream calls, with retry guidance', async () => {
  const { handleApi, createLocalLimiter } = await handler;
  const checkLimit = createLocalLimiter({ limit: 1 });
  assert.equal((await handleApi(request(), { env, checkLimit, fetchImpl: async () => goodResponse() })).status, 200);
  const blocked = await handleApi(request(), { env, checkLimit, fetchImpl: noFetch });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
});

test('worker preflight and pointer input use the same validated contract', async () => {
  const { handleApi } = await handler;
  const preflight = await handleApi(new Request('https://worker.test/api/analyze', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  }), { env, requireOrigin: true });
  assert.equal(preflight.status, 204);
  const pointer = {
    source: 'pointer', durationMs: 1000, sampleCount: 2, metrics: { meanSpeed: 0.2 },
    samples: [{ t: 0, x: 0.1, y: 0.2, stroke: 1 }, { t: 1000, x: 0.3, y: 0.4, stroke: 1 }],
  };
  assert.equal((await handleApi(request(pointer), { env, fetchImpl: async () => goodResponse() })).status, 200);
  const localPost = new Request('http://127.0.0.1:4173/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4173' },
    body: JSON.stringify(pointer),
  });
  assert.equal((await handleApi(localPost, { env, allowLocal: true, fetchImpl: async () => goodResponse() })).status, 200);
});
