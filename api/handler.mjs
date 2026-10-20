// Shared by the local Node server and the optional Cloudflare Worker.
// Only numeric movement data crosses this boundary. No video or intention text.
import { DANCE_VOCABULARY } from './dance-vocabulary.mjs';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const MAX_BODY_BYTES = 100 * 1024;
export const ANALYSIS_DEADLINE_MS = 29000;
const MAX_FRAMES = 80;
const PROVIDER_FRAME_LIMIT = 24;
const DANCE_LABELS = DANCE_VOCABULARY.map(item => item.label);
const LABEL_SET = new Set(DANCE_LABELS);
const LABEL_BY_SPACING = new Map(DANCE_LABELS.map(label => [label.replace(/\s/g, ''), label]));
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RETRY_DELAY_MS = 250;
const MIN_RETRY_BUDGET_MS = 2000;
const HAND_SUMMARY_JOINTS = ['wrist', 'indexMcp', 'thumbTip', 'indexTip', 'middleTip', 'ringTip', 'pinkyTip'];
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
    impression: { type: 'STRING', enum: DANCE_LABELS, description: '제공된 50개 표현 중 대표 인상 하나' },
    description: { type: 'STRING', description: '한국어 감상 두 문장, 합계 140자 이내. 숫자나 기술 용어 금지' },
    observations: { type: 'ARRAY', items: { type: 'STRING', description: '관측 근거를 일상 언어로 짧게, 40자 이내' }, minItems: 1, maxItems: 2 },
    qualities: { type: 'ARRAY', items: { type: 'STRING', enum: DANCE_LABELS }, minItems: 3, maxItems: 3 },
  },
  required: ['impression', 'description', 'observations', 'qualities'],
};

const SYSTEM_PROMPT = `너는 미디어아트 '잔상(Ghosting)'의 움직임 감상 도우미다. 숫자 좌표를 보고 시각적 질감·리듬·분위기를 한국어로 감상한다.
대표 impression과 qualities는 아래 50개 표현의 정확한 표기만 사용한다. qualities는 서로 다른 세 표현이며 첫 항목은 impression이다.
description은 짧은 두 문장, observations는 짧은 근거 1~2개다. 숫자나 지표명은 description과 observations에 절대 나열하지 않는다. JSON만 반환한다.
원본 영상·얼굴·음성·사용자 의도는 제공되지 않는다. 실제 감정·정신 상태·의도·성격·건강·정체성·인구통계는 추론하지 않는다. 감정 관련 표현은 장면의 비유적 인상일 뿐이다. 어휘 풀이에 나와도 음악과 박자의 일치, 실제 근력·기술·완벽함·속마음을 확인했다고 쓰지 않는다. 점수·정확도·일치율·진단도 금지한다.
좌표는 좌상단(0,0), 우하단(1,1), 웹캠은 거울 화면, t/durationMs는 ms다. 실제 관측을 요약한 최대 24프레임이며 없는 관절·가려진 동작을 상상하지 않는다.
다른 segment 사이를 연결하거나 속도·방향을 추정하지 않는다. breakBefore:true도 앞 샘플과 단절이다. t는 일시정지 시간을 뺀 값이며 큰 시간 공백도 연결하지 않는다.
source가 webcam이면 얼굴을 제외한 전신 최대22관절이다. 발이 보일 때 스텝과 다리 리듬도 읽는다. fullBodyRatio가 낮으면 보인 부위만 감상한다.
source가 hand이면 웹캠으로 한 손 또는 두 손을 관측한 기록이다. hands 배열의 각 id/joints는 그 순간 보인 손이다. 손목과 손가락만 제공되므로 전신 자세, 스텝이나 춤을 보았다고 쓰지 않는다.
손 id는 해부학적 왼손·오른손을 뜻하지 않는다. ID가 바뀌거나 손이 사라지면 자취를 잇지 않는다. 손별 breakBefore:true도 단절이다. 두 손의 나란함·반대 방향·가까워짐·리듬 대비는 두 손이 동시에 보인 연속 구간에서만 읽는다. 한 손씩 번갈아 관측된 기록으로 두 손의 협응을 상상하지 않는다.
두 손이 교차했다고 쓰려면 선택 지점들의 상대 위치가 실제로 교차한 근거가 있어야 한다. 회전도 연속 좌표의 명확한 근거 없이 만들지 않는다. 화면의 겹침만으로 실제 접촉을 단정할 수 없다. 누락된 구간을 채워 전체 모양·교차·접촉·회전을 상상하지 않는다.
handTarget이 indexTip이면 선택한 검지 끝, wrist이면 선택한 손목을 우선 감상한다. hand joints는 손목·검지관절·다섯 손끝 중 실제 관측된 점만 요약했다. 전신 관절이나 fullBodyRatio가 없다는 이유로 손 기록을 불충분하다고 판단하지 않는다.
source가 pointer이면 선의 궤적만 보았으며 신체·춤을 보았다고 쓰지 않는다. source가 example이면 합성 예시임을 description에 밝힌다.
지표는 휴리스틱이다. meanSpeed/peakSpeed는 화면 대각선 길이를 1로 둔 초당 거리, pathLength는 이동거리다. webcam은 가장 활발한 상체/하체/몸통을, hand는 같은 구간에서 추적된 각 손의 선택지점 평균을 따른다. peakSpeed는 가장 빠른 점이며 trackedDurationMs는 같은 시간 구간을 두 번 세지 않는다. 한 손만 움직여도 전체 평균만으로 모두 정지했다고 하지 않는다.
stillnessRatio=느린 시간비율, coverage=각 점이 연속 구간에서 이동한 최대 면적, spread=몸 관절의 퍼짐 또는 선택한 손 자취의 범위, tempoVariation=속도 변화, directionChangeRate=방향 전환, validFrameRatio=인식 비율이다. 큰 몸/손 자체를 역동성으로 착각하지 않는다. 누락·짧은 기록에는 확신을 낮춘다.
표현과 뜻(어휘의 비유만 참고하며 실제 사람에 대한 단정은 금지):
${DANCE_VOCABULARY.map(item => item.label + ': ' + item.description).join('\n')}`;

class ApiError extends Error {
  constructor(status, code, message, diagnosticCode = code) {
    super(message);
    this.status = status;
    this.code = code;
    this.diagnosticCode = diagnosticCode;
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
  if (!Array.isArray(value.samples) || value.samples.length < 2 ||
      value.samples.length > (value.source === 'hand' ? 60 : MAX_FRAMES)) invalid();
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
  // Accept already-open single-hand clients while normalizing the provider
  // contract to explicit tracks. Do not mix both formats within one recording.
  const handFormat = value.source === 'hand' && isRecord(value.samples[0]) && Object.hasOwn(value.samples[0], 'hands')
    ? 'hands' : 'joints';
  const validateJoints = (value, allowed, requiredTarget) => {
    if (!isRecord(value)) invalid();
    const entries = Object.entries(value);
    if (entries.length < 2 || entries.length > allowed.size || (requiredTarget && !Object.hasOwn(value, requiredTarget))) invalid();
    const joints = {};
    for (const [name, xy] of entries) {
      if (!allowed.has(name) || !Array.isArray(xy) || xy.length !== 2 || !xy.every(v => numberIn(v, 0, 1))) invalid();
      joints[name] = [xy[0], xy[1]];
    }
    return joints;
  };
  const samples = value.samples.map(sample => {
    if (!isRecord(sample) || !numberIn(sample.t, 0, value.durationMs) || sample.t < previousTime) invalid();
    previousTime = sample.t;
    if (value.source === 'webcam' || value.source === 'hand') {
      if (sample.segment !== undefined && (!Number.isInteger(sample.segment) || !numberIn(sample.segment, 0, 10000))) invalid();
      if (value.source === 'hand') {
        if (!onlyKeys(sample, ['t', handFormat, 'segment'])) invalid();
        const observations = handFormat === 'hands' ? sample.hands : [{ id: 1, joints: sample.joints }];
        if (!Array.isArray(observations) || observations.length < 1 || observations.length > 2) invalid();
        const ids = new Set();
        const hands = observations.map(hand => {
          if (!isRecord(hand) || !onlyKeys(hand, ['id', 'joints']) ||
              !Number.isSafeInteger(hand.id) || hand.id < 1 || ids.has(hand.id)) invalid();
          ids.add(hand.id);
          return { id: hand.id, joints: validateJoints(hand.joints, HAND_JOINTS, value.handTarget) };
        });
        return sample.segment === undefined ? { t: sample.t, hands } : { t: sample.t, hands, segment: sample.segment };
      }
      if (!onlyKeys(sample, ['t', 'joints', 'segment'])) invalid();
      const joints = validateJoints(sample.joints, JOINTS);
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

// Keep actual observations together in time. Never interpolate or flatten the
// two hands into one path. Important boundaries are preferred over smooth spans.
export function compactMotion(motion) {
  const frames = motion.samples;
  const signature = frame => motion.source === 'hand'
    ? `${frame.segment ?? 0}:${frame.hands.map(hand => hand.id).sort((a, b) => a - b).join(',')}`
    : motion.source === 'webcam' ? `${frame.segment ?? 0}:${Object.keys(frame.joints).sort().join(',')}` : frame.stroke;
  const boundary = (a, b) => signature(a) !== signature(b) || b.t - a.t > 250;
  const important = new Set([0, frames.length - 1]);
  for (let i = 1; i < frames.length; i++) {
    if (boundary(frames[i - 1], frames[i])) { important.add(i - 1); important.add(i); }
  }
  let selected = [...important].sort((a, b) => a - b);
  if (selected.length > PROVIDER_FRAME_LIMIT) {
    selected = Array.from({ length: PROVIDER_FRAME_LIMIT }, (_, i) =>
      selected[Math.round(i * (selected.length - 1) / (PROVIDER_FRAME_LIMIT - 1))]);
  }
  while (selected.length < Math.min(PROVIDER_FRAME_LIMIT, frames.length)) {
    let best = -1;
    let gap = -1;
    for (let i = 1; i < selected.length; i++) {
      if (selected[i] - selected[i - 1] < 2) continue;
      const span = frames[selected[i]].t - frames[selected[i - 1]].t || selected[i] - selected[i - 1];
      if (span > gap) { best = i; gap = span; }
    }
    if (best < 0) break;
    selected.splice(best, 0, Math.floor((selected[best - 1] + selected[best]) / 2));
  }
  const round = value => Math.round(value * 1000) / 1000;
  const joints = (value, names = Object.keys(value)) => Object.fromEntries(names
    .filter(name => Object.hasOwn(value, name)).map(name => [name, value[name].map(round)]));
  const samples = selected.map((index, selectedIndex) => {
    const frame = frames[index];
    const previousIndex = selectedIndex ? selected[selectedIndex - 1] : null;
    const between = previousIndex === null ? [] : frames.slice(previousIndex, index + 1);
    const broken = between.some((item, i) => i > 0 && (
      item.t - between[i - 1].t > 250 ||
      (motion.source === 'pointer' || motion.source === 'example'
        ? item.stroke !== between[i - 1].stroke : item.segment !== between[i - 1].segment) ||
      (motion.source === 'webcam' && signature(item) !== signature(between[i - 1]))
    ));
    const base = { t: Math.min(motion.durationMs, round(frame.t)) };
    if (broken) base.breakBefore = true;
    if (motion.source === 'hand') {
      return {
        ...base, segment: frame.segment ?? 0,
        hands: frame.hands.map(hand => ({
          id: hand.id,
          joints: joints(hand.joints, HAND_SUMMARY_JOINTS),
          ...(between.some(item => !item.hands.some(other => other.id === hand.id)) ? { breakBefore: true } : {})
        }))
      };
    }
    if (motion.source === 'webcam') return { ...base, segment: frame.segment ?? 0, joints: joints(frame.joints) };
    return { ...base, x: round(frame.x), y: round(frame.y), stroke: frame.stroke };
  });
  return { ...motion, metrics: Object.fromEntries(Object.entries(motion.metrics).map(([key, value]) => [key, round(value)])), samples };
}

const timedOut = () => new ApiError(504, 'AI_TIMEOUT', 'AI가 제한 시간 안에 해석을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.');
function assertActive(signal) {
  if (signal.aborted) throw timedOut();
}

async function withDeadline(operation, requestedMs) {
  const timeoutMs = Number.isFinite(requestedMs)
    ? Math.min(ANALYSIS_DEADLINE_MS, Math.max(1, requestedMs)) : ANALYSIS_DEADLINE_MS;
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Race resolves even if a transport ignores AbortSignal or stalls after
      // headers. Reject before aborting so cleanup cannot mask the timeout.
      reject(timedOut());
      controller.abort();
    }, timeoutMs);
  });
  try { return await Promise.race([
    Promise.resolve().then(() => operation(controller.signal, () => Math.max(0, deadlineAt - Date.now()))), expiry
  ]); }
  finally { clearTimeout(timer); }
}

async function readBoundedJson(request, signal) {
  assertActive(signal);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new ApiError(415, 'JSON_REQUIRED', 'application/json 형식으로 전송해 주세요.');
  }
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '전송할 움직임 데이터가 너무 큽니다.');
  if (!request.body) invalid();
  const reader = request.body.getReader();
  // Releasing the reader rejects a pending read without destroying the local
  // Node request socket before the server can return its timeout response.
  const stopReading = () => { try { reader.releaseLock(); } catch {} };
  signal.addEventListener('abort', stopReading, { once: true });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      assertActive(signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '전송할 움직임 데이터가 너무 큽니다.');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', stopReading);
    stopReading();
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
  const label = item => {
    if (typeof item !== 'string' || item.length > 80) return null;
    const plain = item.normalize('NFC').trim()
      .replace(/^(?:\*\*|__)([\s\S]+?)(?:\*\*|__)$/, '$1')
      .replace(/^["'“‘]|["'”’]$/g, '').trim();
    return LABEL_SET.has(plain) ? plain : LABEL_BY_SPACING.get(plain.replace(/\s/g, '')) || null;
  };
  const impression = label(value.impression);
  if (!impression) throw new Error('Invalid vocabulary');
  const selected = Array.isArray(value.qualities) ? value.qualities
    : typeof value.qualities === 'string' ? value.qualities.split(/[,·|;]/) : [];
  // Keep only expressions the AI actually supplied. A duplicate/missing tag
  // must never trigger a fabricated third choice or discard valid prose.
  const qualities = [...new Set([impression, ...selected.map(label).filter(Boolean)])].slice(0, 3);
  const evidence = typeof value.observations === 'string' ? [value.observations] : value.observations;
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 10) throw new Error('Invalid observations');
  const observations = evidence.filter(item => typeof item === 'string' && item.trim())
    .map(item => text(item, 400)).slice(0, 2);
  if (!observations.length) throw new Error('Invalid observations');
  return {
    impression,
    description: text(value.description, 1200),
    observations,
    qualities,
    // A server-owned caveat remains visible even if the model omits its disclaimer.
    caveat: '움직임에서 느껴질 수 있는 시각적 인상을 설명한 것으로, 실제 감정이나 의도를 판정한 결과가 아닙니다.',
  };
}

function readAnalysis(text) {
  if (typeof text !== 'string') throw new Error('Missing analysis');
  const raw = text.trim();
  // Strip a single formatting wrapper only. Never repair truncated JSON,
  // extract an arbitrary substring, or invent missing response fields.
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return cleanAnalysis(JSON.parse(fenced ? fenced[1] : raw));
}

function waitForRetry(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(timedOut()); return; }
    const aborted = () => { clearTimeout(timer); reject(timedOut()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, RETRY_DELAY_MS);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function providerConfigError(response, signal) {
  let error = {};
  try { error = (await response.json())?.error || {}; } catch {}
  assertActive(signal);
  // Read provider wording only to choose a fixed public code. Never return or
  // log the message, details, API key, request data, or response body.
  const message = typeof error.message === 'string' ? error.message.slice(0, 4000) : '';
  const reasons = Array.isArray(error.details) ? error.details.slice(0, 20).map(item => item?.reason) : [];
  const region = /\b(?:location|region|country)\b.*(?:not supported|unsupported|not available|unavailable)|(?:not supported|unsupported|not available|unavailable).*\b(?:location|region|country)\b/i.test(message);
  if (region) return new ApiError(503, 'PROVIDER_REGION',
    'AI 서비스가 현재 분석 서버의 접속 지역을 지원하지 않습니다. 서버의 연결 지역 설정을 확인해야 합니다.',
    `PROVIDER_REGION_HTTP_${response.status}`);
  const key = response.status === 401 || reasons.some(reason =>
    typeof reason === 'string' && /^API_KEY_(?:INVALID|EXPIRED|LEAKED|REVOKED|BLOCKED|NOT_FOUND|SERVICE_BLOCKED|IP_ADDRESS_BLOCKED|HTTP_REFERRER_BLOCKED|PROJECT_INVALID)$/.test(reason)
  ) || /\bapi[_ -]?key\b.*(?:invalid|not valid|not found|expired|leaked|revoked|blocked)|(?:invalid|expired|leaked|revoked).*\bapi[_ -]?key\b/i.test(message);
  if (key) return new ApiError(503, 'PROVIDER_KEY',
    'AI 서버의 API 키가 유효하지 않거나 사용이 제한되었습니다. 서버의 키 설정을 확인해야 합니다.',
    `PROVIDER_KEY_HTTP_${response.status}`);
  return new ApiError(503, 'PROVIDER_CONFIG',
    'AI 서버의 모델 사용 권한 또는 API 설정을 확인해 주세요.', `PROVIDER_HTTP_${response.status}`);
}

async function analyze(motion, env, fetchImpl, signal, remainingMs, onAttempt) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) {
    throw new ApiError(503, 'MODEL_CONFIG', '서버의 AI 모델 설정을 확인해 주세요.');
  }
  try {
    assertActive(signal);
    const generationConfig = {
      temperature: 1,
      maxOutputTokens: 1200,
      responseMimeType: 'application/json',
      responseSchema: OUTPUT_SCHEMA,
    };
    if (model === 'gemini-2.5-flash') generationConfig.thinkingConfig = { thinkingBudget: 0 };
    if (model === DEFAULT_MODEL) generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
    else if (model.startsWith('gemini-3.')) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(compactMotion(motion)) }] }],
        generationConfig,
      }),
      signal,
    };
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      assertActive(signal);
      onAttempt();
      try { response = await fetchImpl(url, options); }
      catch (error) {
        assertActive(signal);
        if (attempt === 0 && error instanceof TypeError && remainingMs() >= MIN_RETRY_BUDGET_MS) {
          await waitForRetry(signal);
          continue;
        }
        throw error;
      }
      assertActive(signal);
      if (attempt === 0 && RETRYABLE_STATUS.has(response.status) && remainingMs() >= MIN_RETRY_BUDGET_MS) {
        // Release the failed response without waiting on an error-body stream.
        Promise.resolve(response.body?.cancel()).catch(() => {});
        await waitForRetry(signal);
        continue;
      }
      break;
    }
    assertActive(signal);
    if (response.status === 429) throw new ApiError(429, 'PROVIDER_QUOTA', 'Gemini 무료 사용량 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
    if (response.status === 404) {
      throw new ApiError(503, 'MODEL_UNAVAILABLE', '현재 AI 모델을 이 계정에서 사용할 수 없습니다. 서버의 모델 설정을 확인해 주세요.');
    }
    if ([400, 401, 403].includes(response.status)) {
      throw await providerConfigError(response, signal);
    }
    if (!response.ok) throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'AI 서비스가 잠시 응답하지 않습니다. 나중에 다시 시도해 주세요.',
      `PROVIDER_HTTP_${response.status}`);
    const payload = await response.json();
    assertActive(signal);
    const candidate = payload.candidates?.[0];
    if (!candidate || !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
      throw new ApiError(502, 'INCOMPLETE_ANALYSIS', 'AI가 분석을 완성하지 못했습니다. 다시 시도해 주세요.');
    }
    const responseText = candidate.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
    try { return { provider: 'Gemini', model, analysis: readAnalysis(responseText) }; }
    catch {
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new ApiError(502, 'INCOMPLETE_ANALYSIS', 'AI 응답이 중간에 끝났습니다. 다시 시도해 주세요.');
      }
      throw new ApiError(502, 'INVALID_ANALYSIS', 'AI 응답 형식이 올바르지 않습니다. 다시 시도해 주세요.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal.aborted) throw timedOut();
    throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'AI 서비스 연결에 실패했습니다. 네트워크 상태를 확인해 주세요.');
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
  allowLocal = false, requireOrigin = false, timeoutMs = ANALYSIS_DEADLINE_MS,
  onDiagnostic,
} = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let diagnosticCode = 'OK';
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
      throw new ApiError(503, 'NOT_CONFIGURED', 'AI 서버에 Gemini API 키가 아직 연결되지 않았습니다. 움직임 기록과 재생은 계속 사용할 수 있습니다.');
    }
    const result = await withDeadline(async (signal, remainingMs) => {
      const motion = validateMotion(await readBoundedJson(request, signal));
      assertActive(signal);
      const permitted = await checkLimit(request);
      assertActive(signal);
      if (!permitted) throw new ApiError(429, 'RATE_LIMITED', '분석 요청이 많습니다. 1분 뒤에 다시 시도해 주세요.');
      return analyze(motion, env, fetchImpl, signal, remainingMs, () => { attempts++; });
    }, timeoutMs);
    return json(200, result);
  } catch (error) {
    const known = error instanceof ApiError;
    const status = known ? error.status : 500;
    diagnosticCode = known ? error.diagnosticCode : 'SERVER_ERROR';
    return json(status, { error: {
      code: known ? error.code : 'SERVER_ERROR',
      message: known ? error.message : '분석 서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    } }, status === 429 ? { 'Retry-After': '60' } : {});
  } finally {
    if (url.pathname === '/api/analyze' && request.method === 'POST' && typeof onDiagnostic === 'function') {
      try {
        Promise.resolve(onDiagnostic({
          code: diagnosticCode, elapsedMs: Math.max(0, Date.now() - startedAt), attempts
        })).catch(() => {});
      } catch {}
    }
  }
}
