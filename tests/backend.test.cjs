const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = import('../api/handler.mjs');
const providerMotion = async value => (await handler).compactMotion(value);
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
  impression: '유려한', description: '손목의 자취가 부드럽게 흘러갑니다. 이어지는 선이 우아한 인상을 줍니다.',
  observations: ['두 손목이 아래쪽으로 이동합니다.'], qualities: ['유려한', '매끄러운', '우아한'],
  caveat: '원본 영상은 보지 않았습니다.',
};
const goodResponse = () => new Response(JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(validAnalysis) }] } }],
}), { status: 200 });

test('status exposes capability without exposing the server key', async () => {
  const { handleApi } = await handler;
  const response = await handleApi(new Request('https://worker.test/api/status', { headers: { Origin: origin } }), { env });
  assert.deepEqual(await response.json(), { available: true, provider: 'Gemini', model: 'gemini-3.5-flash-lite' });
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
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), await providerMotion(report.payload));
    assert.match(body.systemInstruction.parts[0].text, /스텝과 다리 리듬/);
    assert.match(body.systemInstruction.parts[0].text, /숫자나 지표명은 description과 observations에 절대 나열하지 않는다/);
    assert.match(body.systemInstruction.parts[0].text, /감정 관련 표현은 장면의 비유적 인상/);
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
      assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), await providerMotion(report.payload));
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
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), await providerMotion(report.payload));
    const prompt = body.systemInstruction.parts[0].text;
    assert.match(prompt, /해부학적 왼손·오른손을 뜻하지 않는다/);
    assert.match(prompt, /두 손이 동시에 보인 연속 구간에서만/);
    assert.match(prompt, /한 손씩 번갈아 관측된 기록으로 두 손의 협응을 상상하지 않는다/);
    assert.match(prompt, /같은 시간 구간을 두 번 세지 않는다/);
    assert.match(prompt, /두 손이 교차했다고 쓰려면 선택 지점들의 상대 위치가 실제로 교차한 근거/);
    assert.match(prompt, /화면의 겹침만으로 실제 접촉을 단정할 수 없다/);
    assert.match(prompt, /누락된 구간을 채워 전체 모양·교차·접촉·회전을 상상하지 않는다/);
    assert.match(prompt, /잔상\(Ghosting\)/);
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
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), await providerMotion(normalized));
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
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), await providerMotion(segmented));
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
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), await providerMotion(motion()));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.match(url, /models\/gemini-3\.5-flash-lite:generateContent$/);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
    assert.equal(body.generationConfig.maxOutputTokens, 1200);
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

test('output schema keeps the supplied vocabulary and rejects missing prose or an invented main label', async () => {
  const { handleApi } = await handler;
  const { DANCE_VOCABULARY } = await import('../api/dance-vocabulary.mjs');
  const labels = DANCE_VOCABULARY.map(item => item.label);
  assert.equal(labels.length, 50);
  assert.equal(new Set(labels).size, 50);
  assert.equal(new Set(DANCE_VOCABULARY.map(item => item.category)).size, 6);
  assert.ok(DANCE_VOCABULARY.every(item => item.description && item.category));
  assert.ok(labels.includes('나비 같은') && labels.includes('호소력 짙은'));
  assert.ok(!labels.includes('빠른'), 'Generic old fallback terms are not silently added to the user’s vocabulary');
  const response = await handleApi(request(), { env, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    const schema = body.generationConfig.responseSchema.properties;
    assert.deepEqual(schema.impression.enum, labels);
    assert.deepEqual(schema.qualities.items.enum, labels);
    assert.equal(schema.observations.maxItems, 2);
    assert.ok(DANCE_VOCABULARY.every(item => body.systemInstruction.parts[0].text.includes(item.label + ': ' + item.description)));
    return goodResponse();
  } });
  assert.equal(response.status, 200);
  for (const patch of [
    { impression: '빠른' },
    { impression: '' },
    { description: '' },
    { observations: [] },
    { observations: ' ' },
  ]) {
    let calls = 0;
    const invalid = await handleApi(request(), { env, fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ candidates: [{
        finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ ...validAnalysis, ...patch }) }] }
      }] }));
    } });
    assert.equal(invalid.status, 502);
    const result = await invalid.json();
    assert.equal(result.error.code, 'INVALID_ANALYSIS');
    assert.equal(result.analysis, undefined, 'Invalid AI output must not become a local substitute result');
    assert.equal(calls, 1, 'No hidden retries');
  }
});

test('provider summary retains both targets, actual timing and identity boundaries within 24 frames', async () => {
  const { compactMotion } = await handler;
  const data = {
    source: 'hand', handTarget: 'wrist', durationMs: 9900, sampleCount: 150,
    metrics: { meanSpeed: 0.234567, trackedDurationMs: 9000 },
    samples: Array.from({ length: 60 }, (_, i) => ({
      t: i * 165, segment: i < 30 ? 1 : 2,
      hands: (i < 20 || i >= 25 ? [1, 2] : [1]).map(id => ({
        id, joints: {
          wrist: [0.123456 + i / 200, id / 3],
          indexMcp: [0.345678, 0.4], indexTip: [0.456789, 0.5],
          thumbTip: [0.567891, 0.6], middleTip: [0.678912, 0.7],
          ringTip: [0.789123, 0.8], pinkyTip: [0.891234, 0.9],
          thumbCmc: [0.2, 0.3], indexPip: [0.4, 0.5]
        }
      }))
    }))
  };
  const untouched = structuredClone(data);
  const summary = compactMotion(data);
  assert.equal(summary.samples.length, 24);
  assert.equal(summary.samples[0].t, data.samples[0].t);
  assert.equal(summary.samples.at(-1).t, data.samples.at(-1).t);
  assert.deepEqual(data, untouched, 'Provider compaction must not mutate a stored recording');
  for (const index of [19, 20, 24, 25, 29, 30]) {
    assert.ok(summary.samples.some(frame => frame.t === data.samples[index].t), 'Preserve the boundary at ' + index);
  }
  for (const frame of summary.samples) {
    const observed = data.samples.find(item => item.t === frame.t);
    assert.deepEqual(frame.hands.map(hand => hand.id), observed.hands.map(hand => hand.id));
    assert.equal(frame.segment, observed.segment);
    for (const hand of frame.hands) {
      assert.equal(Object.keys(hand.joints).length, 7);
      assert.ok(hand.joints.wrist && hand.joints.indexTip);
      assert.equal(hand.joints.indexPip, undefined);
      assert.equal(hand.joints.wrist[0], Math.round(observed.hands.find(item => item.id === hand.id).joints.wrist[0] * 1000) / 1000);
    }
  }
  assert.equal(summary.samples.find(frame => frame.t === data.samples[25].t).hands.find(hand => hand.id === 2).breakBefore, true);
  assert.equal(summary.samples.find(frame => frame.t === data.samples[30].t).breakBefore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < Buffer.byteLength(JSON.stringify(data)) / 2);
});

test('dense omitted boundaries and missing body joints cannot imply continuous movement', async () => {
  const { compactMotion } = await handler;
  const data = {
    source: 'hand', handTarget: 'indexTip', durationMs: 10000, sampleCount: 60, metrics: {},
    samples: Array.from({ length: 60 }, (_, i) => ({
      t: i * 150, segment: i,
      hands: [{ id: 1, joints: { wrist: [0.3, 0.4], indexTip: [i / 60, 0.5] } }]
    }))
  };
  const summary = compactMotion(data);
  assert.equal(summary.samples.length, 24);
  assert.ok(summary.samples.slice(1).every(frame => frame.breakBefore));
  const body = {
    ...data, source: 'webcam',
    samples: data.samples.map((frame, i) => ({
      t: frame.t, segment: 0,
      joints: { leftWrist: [0.2, 0.3], rightWrist: [0.7, 0.3], ...(i % 2 ? {} : { leftKnee: [0.3, 0.7] }) }
    }))
  };
  delete body.handTarget;
  assert.ok(compactMotion(body).samples.slice(1).every(frame => frame.breakBefore));
});

test('a real deadline ends abort-ignoring fetches and stalled provider response bodies', async () => {
  const { handleApi } = await handler;
  for (const stall of ['headers', 'body']) {
    let seenSignal;
    let calls = 0;
    const start = performance.now();
    const response = await handleApi(request(), {
      env, timeoutMs: 25,
      fetchImpl: async (_url, init) => {
        calls += 1;
        seenSignal = init.signal;
        if (stall === 'headers') return new Promise(() => {});
        return { status: 200, ok: true, json: () => new Promise(() => {}) };
      }
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'AI_TIMEOUT');
    assert.ok(performance.now() - start < 500, 'Timeout must not wait for the stalled transport');
    assert.equal(seenSignal.aborted, true);
    assert.equal(calls, 1);
  }
});

test('the same deadline covers a stalled incoming body and rate limiter before any provider call', async () => {
  const { handleApi } = await handler;
  const slowBody = new Request('https://worker.test/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })
  });
  const started = performance.now();
  const bodyResponse = await handleApi(slowBody, { env, timeoutMs: 25, fetchImpl: noFetch });
  assert.equal(bodyResponse.status, 504);
  assert.equal((await bodyResponse.json()).error.code, 'AI_TIMEOUT');
  assert.equal(slowBody.body.locked, false);
  assert.ok(performance.now() - started < 500);
  let releaseLimit;
  let providerCalls = 0;
  const response = await handleApi(request(), {
    env, timeoutMs: 25,
    checkLimit: () => new Promise(resolve => { releaseLimit = resolve; }),
    fetchImpl: async () => { providerCalls++; return goodResponse(); }
  });
  assert.equal(response.status, 504);
  releaseLimit(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerCalls, 0, 'A late limiter must not dispatch an AI request after timeout');
});

test('the timeout cannot be configured past the 19-second server budget', async t => {
  const { handleApi, ANALYSIS_DEADLINE_MS } = await handler;
  assert.equal(ANALYSIS_DEADLINE_MS, 19000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = handleApi(request(), {
    env, timeoutMs: 90000, fetchImpl: () => new Promise(() => {})
  }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(18999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'AI_TIMEOUT');
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

test('provider region, key and permission failures are classified without exposing provider wording', async () => {
  const { handleApi } = await handler;
  for (const [status, error, code] of [
    [400, { message: 'User location is not supported for the API use.' }, 'PROVIDER_REGION'],
    [403, { message: 'This service is not available in your country.' }, 'PROVIDER_REGION'],
    [400, { message: 'API key not valid. Please pass a valid API key.' }, 'PROVIDER_KEY'],
    [403, { message: 'Your API key was reported as leaked.' }, 'PROVIDER_KEY'],
    [400, { message: 'Credential problem', details: [{ reason: 'API_KEY_EXPIRED' }] }, 'PROVIDER_KEY'],
    [401, { message: 'Unauthenticated' }, 'PROVIDER_KEY'],
    [403, { message: 'The model is not enabled in this project.' }, 'PROVIDER_CONFIG'],
    [400, { message: 'Invalid request field' }, 'PROVIDER_CONFIG'],
  ]) {
    let calls = 0;
    const diagnostics = [];
    const response = await handleApi(request(), {
      env, onDiagnostic: item => diagnostics.push(item),
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error }), { status }); }
    });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error.code, code);
    assert.equal(calls, 1, 'Configuration errors must not be retried');
    assert.ok(!JSON.stringify(result).includes(error.message));
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(Object.keys(diagnostics[0]).sort(), ['attempts', 'code', 'elapsedMs']);
    assert.equal(diagnostics[0].attempts, 1);
    assert.ok(diagnostics[0].code.endsWith('HTTP_' + status));
    assert.ok(!JSON.stringify(diagnostics).includes(error.message));
    assert.ok(!JSON.stringify(diagnostics).includes(env.GEMINI_API_KEY));
  }
});

test('format-only variations preserve actual AI prose and never invent additional vocabulary', async () => {
  const { handleApi } = await handler;
  const cases = [
    [{ ...validAnalysis, impression: '  **절도있는**  ', qualities: [' 절도 있는 ', '날카로운', '날카로운', '빠른'] },
      ['절도 있는', '날카로운']],
    [{ ...validAnalysis, qualities: ['유려한', '유려한'] }, ['유려한']],
    [{ ...validAnalysis, qualities: undefined }, ['유려한']],
    [{ ...validAnalysis, qualities: '유려한 · 매끄러운 · 우아한' }, ['유려한', '매끄러운', '우아한']],
    [{ ...validAnalysis, qualities: ['매끄러운', '우아한', '미니멀한'], observations: '한 줄의 실제 AI 관측입니다.' },
      ['유려한', '매끄러운', '우아한']],
    [{ ...validAnalysis, observations: ['관측 하나', '관측 둘', '관측 셋'] }, validAnalysis.qualities]
  ];
  for (const [analysis, expected] of cases) {
    let calls = 0;
    const result = await handleApi(request(), { env, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: {
        parts: [{ text: '```json\n' + JSON.stringify(analysis) + '\n```' }]
      } }] }));
    } });
    assert.equal(result.status, 200);
    const output = (await result.json()).analysis;
    assert.deepEqual(output.qualities, expected);
    assert.equal(output.description, analysis.description);
    assert.ok(output.observations.length >= 1 && output.observations.length <= 2);
    assert.equal(calls, 1);
  }
});

test('complete capped output is usable but truncation and safety-blocked output are never repaired or retried', async () => {
  const { handleApi } = await handler;
  for (const [finishReason, text, expectedStatus] of [
    ['MAX_TOKENS', JSON.stringify(validAnalysis), 200],
    ['MAX_TOKENS', JSON.stringify(validAnalysis).slice(0, -5), 502],
    ['SAFETY', JSON.stringify(validAnalysis), 502],
    ['BLOCKLIST', JSON.stringify(validAnalysis), 502],
    ['STOP', 'Here is your analysis: ' + JSON.stringify(validAnalysis), 502],
  ]) {
    let calls = 0;
    const response = await handleApi(request(), { env, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text }] } }] }));
    } });
    assert.equal(response.status, expectedStatus);
    assert.equal(calls, 1);
    if (expectedStatus !== 200) assert.equal((await response.json()).analysis, undefined);
  }
});

test('transient 5xx and transport TypeError get at most one retry with one sanitized diagnostic', async () => {
  const { handleApi } = await handler;
  for (const first of [500, 502, 503, 504, 'network']) {
    let calls = 0;
    const diagnostics = [];
    const response = await handleApi(request(), {
      env, onDiagnostic: event => diagnostics.push(event),
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          if (first === 'network') throw new TypeError('Sensitive transport details must stay private');
          return new Response('{}', { status: first });
        }
        return goodResponse();
      }
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'OK');
    assert.equal(diagnostics[0].attempts, 2);
    assert.deepEqual(Object.keys(diagnostics[0]).sort(), ['attempts', 'code', 'elapsedMs']);
  }
  let calls = 0;
  const response = await handleApi(request(), { env, fetchImpl: async () => {
    calls++;
    return new Response('{}', { status: 503 });
  } });
  assert.equal(response.status, 502);
  assert.equal(calls, 2, 'A persistent outage must not create a retry loop');
});

test('quota, non-transient errors and insufficient remaining time never spend another provider call', async () => {
  const { handleApi } = await handler;
  for (const [status, timeoutMs] of [[429, 19000], [401, 19000], [403, 19000], [404, 19000], [501, 19000], [503, 1000]]) {
    let calls = 0;
    const response = await handleApi(request(), { env, timeoutMs, fetchImpl: async () => {
      calls++;
      return new Response('{}', { status });
    } });
    assert.ok(response.status >= 400);
    assert.equal(calls, 1, status + ' must not be retried');
  }
});

test('a retry shares the original deadline and the diagnostic cannot break request handling', async t => {
  const { handleApi } = await handler;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  let settled = false;
  const pending = handleApi(request(), {
    env, timeoutMs: 2100,
    onDiagnostic: () => { throw new Error('Logging is optional'); },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 503 });
      return new Promise(() => {});
    }
  }).then(response => { settled = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(250);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  t.mock.timers.tick(1849);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'AI_TIMEOUT');
  assert.equal(calls, 2);
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
