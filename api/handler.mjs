// Shared by the local Node server and the optional Cloudflare Worker.
// Only numeric movement data crosses this boundary. No video or intention text.
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const MAX_BODY_BYTES = 100 * 1024;
const MAX_FRAMES = 80;
const JOINTS = new Set([
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist', 'leftPinky', 'rightPinky',
  'leftIndex', 'rightIndex', 'leftThumb', 'rightThumb',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
  'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel',
  'leftFootIndex', 'rightFootIndex',
]);
const HAND_JOINTS = new Set([
  'wrist', 'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
  'indexMcp', 'indexPip', 'indexDip', 'indexTip',
  'middleMcp', 'middlePip', 'middleDip', 'middleTip',
  'ringMcp', 'ringPip', 'ringDip', 'ringTip',
  'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip',
]);
const BODY_METRICS = ['upperBodySpeed', 'lowerBodySpeed', 'torsoSpeed', 'fullBodyRatio'];
const METRICS = new Set([
  'meanSpeed', 'peakSpeed', 'stillnessRatio', 'coverage', 'spread',
  'tempoVariation', 'directionChangeRate', 'pathLength',
  'trackedDurationMs', 'validFrameRatio',
  'upperBodySpeed', 'lowerBodySpeed', 'torsoSpeed', 'fullBodyRatio',
]);
const OUTPUT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    impression: { type: 'STRING', description: '유연한, 빠른, 경쾌한, 초조한 등의 대표 인상 형용사 하나, 한국어 2~10자' },
    description: { type: 'STRING', description: '움직임이 주는 분위기와 리듬을 감상하듯 설명하는 한국어 두 문장. 숫자나 기술 용어 금지' },
    observations: { type: 'ARRAY', items: { type: 'STRING', description: '인상을 뒷받침하는 눈에 보이는 움직임. 숫자와 지표명 대신 일상적인 한국어로 표현' }, minItems: 1, maxItems: 4 },
    qualities: { type: 'ARRAY', items: { type: 'STRING', description: '짧은 인상 형용사. 예: 유연한, 빠른, 초조한' }, minItems: 3, maxItems: 3 },
    caveat: { type: 'STRING', description: '실제 감정의 판정이 아니며 데이터의 한계를 설명하는 한국어 한 문장' },
  },
  required: ['impression', 'description', 'observations', 'qualities', 'caveat'],
};

const SYSTEM_PROMPT = `너는 미디어아트 작품 '잔상'의 움직임 감상 도우미다.
오직 제공된 숫자 좌표와 측정값을 보고 춤과 움직임이 관객에게 줄 수 있는 시각적 인상을 한국어로 묘사한다.
주인공은 객관적인 사실의 나열이 아니라 움직임에서 느껴지는 질감, 리듬, 분위기다.
대표 표현은 반드시 "유연한", "빠른", "경쾌한", "차분한", "날카로운", "머뭇거리는", "초조한" 같은 짧은 형용사 하나로 쓴다.
관측 근거에 맞는 표현을 자유롭게 고르되 특정 단어를 반드시 사용할 필요는 없다.
원본 영상, 얼굴, 음성은 제공되지 않는다. 실제 감정, 정신 상태, 의도, 성격, 건강, 정체성이나 인구통계는 추론하지 않는다.
"초조한"은 짧고 급한 반복이나 멈칫하는 리듬이 만드는 장면의 인상으로 사용할 수 있다.
"이 사람은 초조하다", "불안한 성격이다"처럼 마음 상태를 단정하지 말고 "초조한 장면의 표현처럼 읽힐 수 있다"처럼 움직임 표현으로만 서술한다.
description은 감상하듯 자연스러운 두 문장으로 쓴다. "평균 속도 0.3", "방향 전환율", "정지 비율" 같은 숫자나 지표명은 description과 observations에 절대 나열하지 않는다.
예를 들어 "잔잔하게 이어지는 팔의 흐름에 가벼운 스텝이 더해져 유연하고 경쾌한 인상을 줍니다. 짧게 머무는 순간이 다음 움직임을 기대하게 합니다."와 같은 방식이다. 이 예시의 동작을 데이터에 없는 채로 복사하지 않는다.
지표만으로 확신을 만들지 말고 좌표에서 확인되는 속도 변화, 멈춤, 방향 전환, 공간 사용, 양팔·다리·몸통의 관계 중 실제 근거가 있는 것만 연결한다.
아래에서 "웹캠"이라고 설명하는 전신 지표와 관절은 source가 webcam일 때만 적용된다.
source가 webcam이면 얼굴을 제외한 어깨, 팔꿈치, 손목, 손끝, 골반, 무릎, 발목, 뒤꿈치, 발끝이 최대 22개 제공된다.
없는 관절이나 가려진 신체 부위의 움직임을 상상하지 않는다. 발이 관측되면 스텝과 다리 리듬도 읽고, 손목만 보고 전신 춤의 인상을 대신하지 않는다.
정규화 좌표는 왼쪽 위 (0,0), 오른쪽 아래 (1,1), t와 durationMs는 밀리초다. 웹캠 좌표는 거울처럼 반전된 화면 좌표다.
meanSpeed와 peakSpeed는 화면 대각선 길이를 1로 둔 초당 거리, pathLength는 화면 대각선 길이를 1로 둔 이동 거리다.
웹캠 meanSpeed와 pathLength는 매 순간 가장 활발한 상체·하체·몸통 부위의 움직임을 따른다. 움직이지 않는 팔 때문에 스텝이 묻히지 않도록 한 휴리스틱이다.
upperBodySpeed는 관측된 양손목·양팔꿈치·양어깨 쌍 중 가장 활발한 쌍의 평균 이동 속도다.
lowerBodySpeed는 관측된 양발목·양무릎·양골반 쌍 중 가장 활발한 쌍의 평균 이동 속도다. 두 지표 모두 매 순간 활발한 쌍을 선택한 뒤 시간 평균을 낸 값이다.
torsoSpeed는 관측된 어깨·골반의 평균 이동 속도다. 해당 관절 관측이 없을 때도 0이므로, 값 0만으로 정지했다고 단정하지 않는다.
stillnessRatio는 관측 시간 중 느린 움직임 비율, coverage는 궤적이 사용한 정규화 경계 상자 면적이다.
웹캠 coverage는 각 관절이 연속 구간에서 실제 이동한 범위 중 최대 면적이며, 서 있는 몸이 차지하는 면적이 아니다.
spread는 화면 대각선 길이를 1로 둔 관측 관절 간 퍼짐이다. 큰 spread만으로 역동적인 춤이라 부르지 않는다.
tempoVariation은 속도의 표준편차/평균, directionChangeRate는 초당 방향 전환 횟수다.
trackedDurationMs는 유효하게 추적한 시간, validFrameRatio는 유효 관측 비율, fullBodyRatio는 양어깨·골반·무릎·발목을 모두 관측한 프레임 비율이다.
fullBodyRatio가 낮으면 보이는 부분만으로 읽었다고 짧게 밝힌다. 모든 지표는 휴리스틱이며 정확한 신체량이 아니다.
source가 webcam 또는 hand인 sample의 segment가 바뀌면 일시정지 또는 추적 손실 후 새 기록 구간이다. t는 정지 시간을 제외하므로 다른 segment 사이를 연결하거나 그 사이의 속도·방향을 추정하지 않는다.
source가 hand이면 웹캠으로 한 손의 21개 관절만 관측한 기록이다. 손목과 다섯 손가락 이외의 신체는 제공되지 않으므로 팔, 다리, 머리, 몸통, 전신 자세, 스텝이나 춤을 보았다고 쓰지 않는다.
handTarget이 indexTip이면 선택한 검지 끝, wrist이면 선택한 손목의 궤적을 우선 감상한다. hand의 meanSpeed, peakSpeed, stillnessRatio, coverage, spread, tempoVariation, directionChangeRate, pathLength, trackedDurationMs는 오직 이 선택한 자취에서 계산한 값이다.
hand의 coverage와 spread는 선택한 자취가 연속해서 움직인 범위이며 손 자체의 크기나 손가락 간 벌어짐이 아니다. 다른 손가락의 움직임은 실제 관절 좌표에서 관측되는 경우에만 보조 근거로 쓴다. 손목이 가만히 있어도 검지 끝은 움직일 수 있으며 그 반대도 가능하다.
hand의 validFrameRatio는 선택한 지점을 포함하여 손 관절이 인식된 프레임 비율이다. 전신 관절이나 fullBodyRatio가 없다는 이유로 손 기록을 불충분하다고 판단하지 않는다. "검지 끝이 완만하게 이어져 유연한 자취를 남깁니다."처럼 실제 선택한 손의 자취를 설명한다.
source가 pointer이면 손으로 그린 선만 관측한 것이므로 신체 자세나 춤을 보았다고 쓰지 않는다.
source가 example이면 사람이 한 움직임이 아니라 합성 예시임을 description에 밝힌다.
샘플 간 큰 시간 간격, 추적 손실, 짧은 기록은 해석의 불확실성으로 설명한다.
impression은 짧은 대표 형용사 하나, description은 두 문장, observations는 일상 언어로 쓴 근거 1~4개, qualities는 서로 다른 짧은 형용사 정확히 3개다.
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
  if (!isRecord(value) || !onlyKeys(value, ['source', 'handTarget', 'durationMs', 'sampleCount', 'metrics', 'samples'])) invalid();
  if (!['webcam', 'hand', 'pointer', 'example'].includes(value.source) || !numberIn(value.durationMs, 1, 10000)) invalid();
  if (value.source === 'hand' ? !['indexTip', 'wrist'].includes(value.handTarget) : 'handTarget' in value) invalid();
  if (!Array.isArray(value.samples) || value.samples.length < 2 || value.samples.length > MAX_FRAMES) invalid();
  if (!Number.isInteger(value.sampleCount) || value.sampleCount < value.samples.length || value.sampleCount > 100000) invalid();
  if (!isRecord(value.metrics) || Object.keys(value.metrics).length > METRICS.size) invalid();
  const metrics = {};
  for (const [name, metric] of Object.entries(value.metrics)) {
    if (!METRICS.has(name) || !numberIn(metric, 0, 100000)) invalid();
    if (value.source === 'hand' && BODY_METRICS.includes(name)) invalid();
    if (['stillnessRatio', 'coverage', 'validFrameRatio', 'fullBodyRatio'].includes(name) && metric > 1) invalid();
    if (['upperBodySpeed', 'lowerBodySpeed', 'torsoSpeed'].includes(name) && metric > 125) invalid();
    metrics[name] = metric;
  }
  let previousTime = -1;
  const samples = value.samples.map(sample => {
    if (!isRecord(sample) || !numberIn(sample.t, 0, value.durationMs) || sample.t < previousTime) invalid();
    previousTime = sample.t;
    if (value.source === 'webcam' || value.source === 'hand') {
      const allowedJoints = value.source === 'hand' ? HAND_JOINTS : JOINTS;
      if (!onlyKeys(sample, ['t', 'joints', 'segment']) || !isRecord(sample.joints)) invalid();
      if (sample.segment !== undefined && (!Number.isInteger(sample.segment) || !numberIn(sample.segment, 0, 10000))) invalid();
      const jointEntries = Object.entries(sample.joints);
      if (jointEntries.length < 2 || jointEntries.length > allowedJoints.size) invalid();
      if (value.source === 'hand' && !Object.hasOwn(sample.joints, value.handTarget)) invalid();
      const joints = {};
      for (const [joint, xy] of jointEntries) {
        if (!allowedJoints.has(joint) || !Array.isArray(xy) || xy.length !== 2 || !xy.every(v => numberIn(v, 0, 1))) invalid();
        joints[joint] = [xy[0], xy[1]];
      }
      return sample.segment === undefined ? { t: sample.t, joints } : { t: sample.t, joints, segment: sample.segment };
    }
    if (!onlyKeys(sample, ['t', 'x', 'y', 'stroke']) ||
        !numberIn(sample.x, 0, 1) || !numberIn(sample.y, 0, 1) ||
        !Number.isInteger(sample.stroke) || !numberIn(sample.stroke, 0, 10000)) invalid();
    return { t: sample.t, x: sample.x, y: sample.y, stroke: sample.stroke };
  });
  const result = { source: value.source, durationMs: value.durationMs, sampleCount: value.sampleCount, metrics, samples };
  if (value.source === 'hand') result.handTarget = value.handTarget;
  return result;
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
      maxOutputTokens: 2400,
      responseMimeType: 'application/json',
      responseSchema: OUTPUT_SCHEMA,
    };
    if (model === 'gemini-2.5-flash') generationConfig.thinkingConfig = { thinkingBudget: 0 };
    if (model === 'gemini-3.8-flash') {
      generationConfig.temperature = 1;
      generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    }
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
    if (response.status === 404) {
      throw new ApiError(503, 'MODEL_UNAVAILABLE', '현재 AI 모델을 이 계정에서 사용할 수 없습니다. 서버의 모델 설정을 확인해 주세요.');
    }
    if ([400, 401, 403].includes(response.status)) {
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
  allowLocal = false, requireOrigin = false, timeoutMs = 90000,
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
