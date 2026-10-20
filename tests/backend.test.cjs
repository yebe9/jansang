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
  assert.deepEqual(await response.json(), { available: true, provider: 'Gemini', model: 'gemini-2.5-flash' });
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
  ]) {
    const bad = motion(); mutate(bad);
    const response = await handleApi(request(bad), { env, fetchImpl: noFetch });
    assert.equal(response.status, 400);
  }
  assert.throws(() => validateMotion({ ...motion(), metrics: { meanSpeed: NaN } }));
  const tooBig = await handleApi(request({ padding: 'x'.repeat(102401) }), { env, fetchImpl: noFetch });
  assert.equal(tooBig.status, 413);
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
