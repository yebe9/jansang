// Shared by the local Node server and the optional Cloudflare Worker.
// Only numeric movement data crosses this boundary. No video or intention text.
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MAX_BODY_BYTES = 100 * 1024;
const MAX_FRAMES = 80;
const JOINTS = new Set([
  'leftWrist', 'rightWrist', 'leftElbow', 'rightElbow',
  'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
]);
const METRICS = new Set([
  'meanSpeed', 'peakSpeed', 'stillnessRatio', 'coverage', 'spread',
  'tempoVariation', 'directionChangeRate', 'pathLength',
  'trackedDurationMs', 'validFrameRatio',
]);
const OUTPUT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    impression: { type: 'STRING', description: '움직임의 인상, 한국어 2~15자' },
    description: { type: 'STRING', description: '관측된 움직임이 주는 인상을 한국어 2~3문장으로 설명' },
    observations: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 4 },
    qualities: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 4 },
    caveat: { type: 'STRING', description: '실제 감정의 판정이 아니며 데이터의 한계를 설명하는 한국어 한 문장' },
  },
  required: ['impression', 'description', 'observations', 'qualities', 'caveat'],
};

const SYSTEM_PROMPT = `너는 미디어아트 작품 '잔상'의 움직임 감상 도우미다.
오직 제공된 숫자 좌표와 측정값을 보고 움직임이 관객에게 줄 수 있는 시각적 인상을 한국어로 묘사한다.
원본 영상, 얼굴, 음성은 제공되지 않는다. 실제 감정, 정신 상태, 의도, 성격, 건강, 정체성이나 인구통계는 추론하지 않는다.
"슬프다", "불안하다"처럼 사람의 상태를 단정하지 말고 "조심스럽게 멈추는 듯한 인상", "경쾌한 리듬으로 읽힐 수 있다"처럼 표현의 가능성을 말한다.
지표만으로 확신을 만들지 말고 좌표에서 확인되는 속도 변화, 멈춤, 방향 전환, 공간 사용, 양팔의 관계 중 실제 근거가 있는 것만 연결한다.
정규화 좌표는 왼쪽 위 (0,0), 오른쪽 아래 (1,1), t와 durationMs는 밀리초다. 웹캠 좌표는 거울처럼 반전된 화면 좌표다.
meanSpeed와 peakSpeed는 화면 대각선 길이를 1로 둔 초당 거리, pathLength는 화면 대각선 길이를 1로 둔 이동 거리다.
stillnessRatio는 관측 시간 중 느린 움직임 비율, coverage는 궤적이 사용한 정규화 경계 상자 면적,
spread는 화면 대각선 길이를 1로 둔 관절 간 퍼짐, tempoVariation은 속도의 표준편차/평균, directionChangeRate는 초당 방향 전환 횟수다.
trackedDurationMs는 유효하게 추적한 시간, validFrameRatio는 유효 관측 비율이다. 모든 지표는 휴리스틱이며 정확한 신체량이 아니다.
웹캠 sample의 segment가 바뀌면 일시정지 또는 추적 손실 후 새 기록 구간이다. t는 정지 시간을 제외하므로 다른 segment 사이를 연결하거나 그 사이의 속도·방향을 추정하지 않는다.
source가 pointer이면 손으로 그린 선만 관측한 것이므로 신체 자세나 춤을 보았다고 쓰지 않는다.
source가 example이면 사람이 한 움직임이 아니라 합성 예시임을 description에 밝힌다.
샘플 간 큰 시간 간격, 추적 손실, 짧은 기록은 해석의 불확실성으로 설명한다.
impression은 짧은 대표 인상, description은 2~3문장, observations는 근거 1~4개, qualities는 짧은 표현어 1~4개다.
caveat에는 "실제 감정이나 의도를 판정한 결과가 아닙니다."를 포함한다. 점수, 정확도, 진단, 사용자 의도와의 일치율은 만들지 않는다.
명시된 JSON 스키마의 속성만 반환한다.`;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numberIn = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const invalid = () => { throw new ApiError(400, 'INVALID_MOTION', '움직임 데이터 형식이 올바르지 않습니다. 다시 기록해 주세요.'); };

export function validateMotion(value) {
  if (!isRecord(value) || !onlyKeys(value, ['source', 'durationMs', 'sampleCount', 'metrics', 'samples'])) invalid();
  if (!['webcam', 'pointer', 'example'].includes(value.source) || !numberIn(value.durationMs, 1, 10000)) invalid();
  if (!Array.isArray(value.samples) || value.samples.length < 2 || value.samples.length > MAX_FRAMES) invalid();
  if (!Number.isInteger(value.sampleCount) || value.sampleCount < value.samples.length || value.sampleCount > 100000) invalid();
  if (!isRecord(value.metrics) || Object.keys(value.metrics).length > METRICS.size) invalid();
  const metrics = {};
  for (const [name, metric] of Object.entries(value.metrics)) {
    if (!METRICS.has(name) || !numberIn(metric, 0, 100000)) invalid();
    if (['stillnessRatio', 'coverage', 'validFrameRatio'].includes(name) && metric > 1) invalid();
    metrics[name] = metric;
  }
  let previousTime = -1;
  const samples = value.samples.map(sample => {
    if (!isRecord(sample) || !numberIn(sample.t, 0, value.durationMs) || sample.t < previousTime) invalid();
    previousTime = sample.t;
    if (value.source === 'webcam') {
      if (!onlyKeys(sample, ['t', 'joints', 'segment']) || !isRecord(sample.joints)) invalid();
      if (sample.segment !== undefined && (!Number.isInteger(sample.segment) || !numberIn(sample.segment, 0, 10000))) invalid();
      const jointEntries = Object.entries(sample.joints);
      if (jointEntries.length < 2 || jointEntries.length > JOINTS.size) invalid();
      const joints = {};
      for (const [joint, xy] of jointEntries) {
        if (!JOINTS.has(joint) || !Array.isArray(xy) || xy.length !== 2 || !xy.every(v => numberIn(v, 0, 1))) invalid();
        joints[joint] = [xy[0], xy[1]];
      }
      return sample.segment === undefined ? { t: sample.t, joints } : { t: sample.t, joints, segment: sample.segment };
    }
    if (!onlyKeys(sample, ['t', 'x', 'y', 'stroke']) ||
        !numberIn(sample.x, 0, 1) || !numberIn(sample.y, 0, 1) ||
        !Number.isInteger(sample.stroke) || !numberIn(sample.stroke, 0, 10000)) invalid();
    return { t: sample.t, x: sample.x, y: sample.y, stroke: sample.stroke };
  });
  return { source: value.source, durationMs: value.durationMs, sampleCount: value.sampleCount, metrics, samples };
}

async function readBoundedJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new ApiError(415, 'JSON_REQUIRED', 'application/json 형식으로 전송해 주세요.');
  }
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '전송할 움직임 데이터가 너무 큽니다.');
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '전송할 움직임 데이터가 너무 큽니다.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON', '움직임 데이터를 읽을 수 없습니다. 다시 기록해 주세요.'); }
}

function cleanAnalysis(value) {
  if (!isRecord(value)) throw new Error('Invalid analysis');
  const text = (item, max) => {
    if (typeof item !== 'string' || !item.trim() || item.length > max) throw new Error('Invalid analysis text');
    return item.trim();
  };
  const list = item => {
    if (!Array.isArray(item) || item.length < 1 || item.length > 4) throw new Error('Invalid analysis list');
    return item.map(entry => text(entry, 500));
  };
  return {
    impression: text(value.impression, 80),
    description: text(value.description, 1600),
    observations: list(value.observations),
    qualities: list(value.qualities),
    // A server-owned caveat remains visible even if the model omits its disclaimer.
    caveat: '움직임에서 느껴질 수 있는 시각적 인상을 설명한 것으로, 실제 감정이나 의도를 판정한 결과가 아닙니다.',
  };
}

async function analyze(motion, env, fetchImpl, timeoutMs) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) {
    throw new ApiError(503, 'MODEL_CONFIG', '서버의 AI 모델 설정을 확인해 주세요.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const generationConfig = {
      temperature: 0.5,
      maxOutputTokens: 1400,
      responseMimeType: 'application/json',
      responseSchema: OUTPUT_SCHEMA,
    };
    if (model === 'gemini-2.5-flash') generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(motion) }] }],
        generationConfig,
      }),
      signal: controller.signal,
    });
    if (response.status === 429) throw new ApiError(429, 'PROVIDER_QUOTA', 'Gemini 무료 사용량 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new ApiError(503, 'PROVIDER_CONFIG', 'AI 서버의 API 키, 모델 사용 권한 또는 지원 지역을 확인해 주세요.');
    }
    if (!response.ok) throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'AI 서비스가 잠시 응답하지 않습니다. 나중에 다시 시도해 주세요.');
    const payload = await response.json();
    const candidate = payload.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP') {
      throw new ApiError(502, 'INCOMPLETE_ANALYSIS', 'AI가 분석을 완성하지 못했습니다. 다시 시도해 주세요.');
    }
    const responseText = candidate.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
    try { return { provider: 'Gemini', model, analysis: cleanAnalysis(JSON.parse(responseText)) }; }
    catch { throw new ApiError(502, 'INVALID_ANALYSIS', 'AI 응답 형식이 올바르지 않습니다. 다시 시도해 주세요.'); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(504, 'AI_TIMEOUT', 'AI 분석 시간이 길어지고 있습니다. 잠시 후 다시 시도해 주세요.');
    throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'AI 서비스 연결에 실패했습니다. 네트워크 상태를 확인해 주세요.');
  } finally {
    clearTimeout(timer);
  }
}

export function createLocalLimiter({ limit = 12, periodMs = 60000 } = {}) {
  let resetAt = 0;
  let count = 0;
  return async () => {
    const now = Date.now();
    if (now >= resetAt) { resetAt = now + periodMs; count = 0; }
    count += 1;
    return count <= limit;
  };
}

export async function handleApi(request, {
  env = {}, fetchImpl = fetch, checkLimit = async () => true,
  allowLocal = false, requireOrigin = false, timeoutMs = 30000,
} = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const allowedOrigins = (env.ALLOWED_ORIGIN || 'https://yebe9.github.io').split(',').map(value => value.trim()).filter(Boolean);
  const sameLocalOrigin = allowLocal && /^http:\/\/(127\.0\.0\.1|localhost):4173$/.test(url.origin);
  // Same-origin browser GETs may omit Origin; POSTs must carry an allowed Origin.
  const allowed = origin ? allowedOrigins.includes(origin) || (sameLocalOrigin && origin === url.origin)
    : !requireOrigin && request.method === 'GET';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  };
  if (allowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '600';
  }
  const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
  try {
    if (!allowed) throw new ApiError(403, 'ORIGIN_DENIED', '허용된 잔상 사이트에서 요청해 주세요.');
    if (!['/api/status', '/api/analyze'].includes(url.pathname)) throw new ApiError(404, 'NOT_FOUND', 'API 경로를 찾을 수 없습니다.');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/api/status') {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'GET 요청만 가능합니다.');
      return json(200, { available: Boolean(env.GEMINI_API_KEY?.trim()), provider: 'Gemini', model: env.GEMINI_MODEL || DEFAULT_MODEL });
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'POST 요청만 가능합니다.');
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new ApiError(503, 'NOT_CONFIGURED', 'AI 서버에 Gemini API 키가 아직 연결되지 않았습니다. 움직임 기록과 특징 확인은 계속 사용할 수 있습니다.');
    }
    const motion = validateMotion(await readBoundedJson(request));
    if (!await checkLimit(request)) throw new ApiError(429, 'RATE_LIMITED', '분석 요청이 많습니다. 1분 뒤에 다시 시도해 주세요.');
    return json(200, await analyze(motion, env, fetchImpl, timeoutMs));
  } catch (error) {
    const known = error instanceof ApiError;
    const status = known ? error.status : 500;
    return json(status, { error: {
      code: known ? error.code : 'SERVER_ERROR',
      message: known ? error.message : '분석 서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    } }, status === 429 ? { 'Retry-After': '60' } : {});
  }
}
