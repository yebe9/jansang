// Shared by the local Node server and the optional Cloudflare Worker.
// Only numeric movement data crosses this boundary. No video or intention text.
import { requestMotionCaption, MotionCaptionError } from './motiongpt-provider.mjs';
import { DANCE_VOCABULARY } from './dance-vocabulary.mjs';
import { encodeMotion, ENCODING_GUIDE } from './motion-encoding.mjs';
import { evaluateExpressionRubric, VISUAL_DEFINITIONS } from './expression-rubric.mjs';
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
    description: { type: 'STRING', description: '한국어 감상 1~2문장, 합계 100자 이내. 숫자나 기술 용어 금지' },
    observations: { type: 'ARRAY', items: { type: 'STRING', description: '관측 근거 한 문장, 40자 이내' }, minItems: 1, maxItems: 1 },
    qualities: { type: 'ARRAY', items: { type: 'STRING', enum: DANCE_LABELS }, minItems: 1, maxItems: 3 },
    candidates: {
      type: 'ARRAY', minItems: 5, maxItems: 5,
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', enum: DANCE_LABELS },
          score: { type: 'NUMBER', minimum: 0, maximum: 100 },
          evidence: { type: 'STRING', description: '관측 근거 25자 이내' },
        },
        required: ['label', 'score', 'evidence'],
      },
    },
  },
  required: ['impression', 'description', 'observations', 'qualities', 'candidates'],
};

const SYSTEM_PROMPT = `너는 '잔상(Ghosting)'의 움직임 감상 도우미다. 좌표의 질감·리듬·분위기를 한국어 JSON으로 답한다. impression과 qualities는 스키마 enum의 정확한 표현만 쓰고 qualities는 대표부터 근거 있는 1~3개만 고른다. 감상 1~2문장과 근거 1개를 짧게 쓴다. 감상에 숫자·지표명·점수·진단은 쓰지 않는다.
50개 정의를 모두 비교하되 다양성을 위해 억지로 바꾸거나 늘 고르는 익숙한 표현으로 채우지 않는다. candidates는 근거가 있는 상위 후보 정확히 5개이며 대표를 포함한다. 사용자 의도는 받지 않으며 움직임만 보고 후보를 선정한다. score는 네가 제시하는 비보정 적합도 0~100이다; 확률·내부 logprob·감정 확률이 아니며 합계 100일 필요도 없다. 동점 가능, 대표를 최고점으로 하고 근거는 후보당 25자 이내다. 미보고 후보는 0점이 아니다.
expressionRubric은 경험적 선택 제한이다. eligible=false인 유연한·유려한은 후보·대표·태그·감상에 쓰지 않는다. 유연한은 전신 관절 굽힘과 펴짐 근거가 필수이고 단순한 곡선·이동·속도만으로 불가하다. 유려한은 장시간의 안정된 속도·방향 연결이 모두 필요하다. eligible=true여도 자동 선택하지 않는다.
영상·얼굴·음성·사용자 의도는 없다. 실제 감정·정신 상태·의도·성격·건강·정체성은 추론하지 않는다. 감정 어휘는 시각적 비유이며 음악·실력도 단정하지 않는다.
${ENCODING_GUIDE}
좌표 원점은 좌상단이고 웹캠은 거울 화면이다. 최대 24프레임의 실제 관측만 읽는다. 큰 시간 공백·가림·누락을 채우지 말고 짧거나 불완전하면 확신을 낮춘다.
webcam은 얼굴 없는 전신으로 보인 부위만, 발이 보이면 스텝도 읽는다. hand는 손만 읽으며 handTarget=indexTip은 검지 끝, wrist는 손목을 우선한다. 전신 관절이 없어도 손 감상은 가능하다. 손 id는 왼손·오른손이 아니다. 두 손 관계는 동시에 보인 연속 구간에서만 읽고 상대 좌표 근거 없이 교차·회전을 만들거나 화면 겹침을 접촉으로 단정하지 않는다.
pointer는 선만 읽고 example은 합성 예시임을 감상에 밝힌다. 지표는 보조값이다. 속도는 화면 대각선 기준 초당 거리, hand 평균은 관측된 선택점의 평균이므로 한 손의 움직임을 전체 정지로 오해하지 않는다. 몸·손 자체의 크기를 역동성으로 보지 않는다.
시각적 정의(감정 단어도 비유일 뿐이다):
${DANCE_LABELS.map(label => `${label}:${VISUAL_DEFINITIONS[label]}`).join('\n')}`;

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
  if (!isRecord(value) || !onlyKeys(value, ['source', 'handTarget', 'captureAspect', 'durationMs', 'sampleCount', 'metrics', 'samples'])) invalid();
  if (!['webcam', 'hand', 'pointer', 'example'].includes(value.source) || !numberIn(value.durationMs, 1, 10000)) invalid();
  if (value.source === 'hand' ? !['indexTip', 'wrist'].includes(value.handTarget) : 'handTarget' in value) invalid();
  if (value.captureAspect !== undefined && !numberIn(value.captureAspect, 0.2, 5)) invalid();
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
      if (!onlyKeys(sample, ['t', 'joints', 'segment', 'worldJoints'])) invalid();
      const joints = validateJoints(sample.joints, JOINTS);
      const frame = sample.segment === undefined ? {t:sample.t,joints} : {t:sample.t,joints,segment:sample.segment};
      if(sample.worldJoints!==undefined){
        if(!isRecord(sample.worldJoints)||Object.keys(sample.worldJoints).length>JOINTS.size)invalid();
        frame.worldJoints={};
        for(const [name,xyz] of Object.entries(sample.worldJoints)){
          if(!JOINTS.has(name)||!Array.isArray(xyz)||xyz.length!==3||!xyz.every(v=>numberIn(v,-20,20)))invalid();
          frame.worldJoints[name]=[...xyz];
        }
      }
      return frame;
    }
    if (!onlyKeys(sample, ['t', 'x', 'y', 'stroke']) ||
        !numberIn(sample.x, 0, 1) || !numberIn(sample.y, 0, 1) ||
        !Number.isInteger(sample.stroke) || !numberIn(sample.stroke, 0, 10000)) invalid();
    return { t: sample.t, x: sample.x, y: sample.y, stroke: sample.stroke };
  });
  const result = { source: value.source, durationMs: value.durationMs, sampleCount: value.sampleCount, metrics, samples };
  if (value.source === 'hand') result.handTarget = value.handTarget;
  if (value.captureAspect !== undefined) result.captureAspect = value.captureAspect;
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

function cleanAnalysis(value, rubric) {
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
  const allowedLabel = item => {
    const normalized = label(item);
    return normalized && rubric.eligible[normalized] !== false ? normalized : null;
  };
  const impression = allowedLabel(value.impression);
  if (!impression) throw new Error('Invalid vocabulary');
  const selected = Array.isArray(value.qualities) ? value.qualities
    : typeof value.qualities === 'string' ? value.qualities.split(/[,·|;]/) : [];
  // Keep only expressions the AI actually supplied. A duplicate/missing tag
  // must never trigger a fabricated third choice or discard valid prose.
  const qualities = [...new Set([impression, ...selected.map(allowedLabel).filter(Boolean)])].slice(0, 3);
  const evidence = typeof value.observations === 'string' ? [value.observations] : value.observations;
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 10) throw new Error('Invalid observations');
  const observations = evidence.filter(item => typeof item === 'string' && item.trim())
    .map(item => text(item, 400)).slice(0, 2);
  if (!observations.length) throw new Error('Invalid observations');
  const result = {
    impression,
    description: text(value.description, 1200),
    observations,
    qualities,
    // A server-owned caveat remains visible even if the model omits its disclaimer.
    caveat: '움직임에서 느껴질 수 있는 시각적 인상을 설명한 것으로, 실제 감정이나 의도를 판정한 결과가 아닙니다.',
  };
  if (Array.isArray(value.candidates)) {
    const seen = new Set();
    result.candidates = [];
    for (const candidate of value.candidates.slice(0, 20)) {
      if (!isRecord(candidate)) continue;
      const name = allowedLabel(candidate.label);
      if (!name || seen.has(name) || !numberIn(candidate.score, 0, 100) ||
          typeof candidate.evidence !== 'string' || !candidate.evidence.trim() || candidate.evidence.length > 400) continue;
      seen.add(name);
      result.candidates.push({ label: name, score: candidate.score, evidence: candidate.evidence.trim() });
      if (result.candidates.length === 5) break;
    }
  }
  const representative = result.candidates?.find(candidate => candidate.label === impression);
  result.rubric = {
    ...rubric,
    // Never change the AI's selected impression or rewrite a score to make
    // them agree. Missing/unreported candidates have no implied score.
    candidateRankingConsistent: representative
      ? result.candidates.every(candidate => candidate.score <= representative.score) : null,
  };
  return result;
}

function readAnalysis(text, rubric) {
  if (typeof text !== 'string') throw new Error('Missing analysis');
  const raw = text.trim();
  // Strip a single formatting wrapper only. Never repair truncated JSON,
  // extract an arbitrary substring, or invent missing response fields.
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return cleanAnalysis(JSON.parse(fenced ? fenced[1] : raw), rubric);
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

// Accepts validated motion. Shared by live requests and offline size checks;
// credentials are deliberately supplied only at the HTTP transport boundary.
export function buildAnalysisRequest(motion, model = DEFAULT_MODEL) {
  return analysisRequest(motion, model, evaluateExpressionRubric(motion));
}

function analysisRequest(motion, model, rubric, motionCaption = null) {
  if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) {
    throw new ApiError(503, 'MODEL_CONFIG', '서버의 AI 모델 설정을 확인해 주세요.');
  }
  const labels = DANCE_LABELS.filter(label => rubric.eligible[label] !== false);
  const schema = {
    ...OUTPUT_SCHEMA,
    properties: {
      ...OUTPUT_SCHEMA.properties,
      impression: { ...OUTPUT_SCHEMA.properties.impression, enum: labels },
      qualities: { ...OUTPUT_SCHEMA.properties.qualities, items: { type: 'STRING', enum: labels } },
      candidates: {
        ...OUTPUT_SCHEMA.properties.candidates,
        items: {
          ...OUTPUT_SCHEMA.properties.candidates.items,
          properties: {
            ...OUTPUT_SCHEMA.properties.candidates.items.properties,
            label: { type: 'STRING', enum: labels },
          },
        },
      },
    },
  };
  const generationConfig = {
    temperature: 1,
    maxOutputTokens: 1200,
    responseMimeType: 'application/json',
    responseSchema: schema,
  };
  if (model === 'gemini-2.5-flash') generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (model === DEFAULT_MODEL) generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  else if (model.startsWith('gemini-3.')) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({
      ...encodeMotion(compactMotion(motion)),
      expressionRubric: { version: rubric.version, eligible: rubric.eligible, metrics: rubric.metrics },
      ...(motionCaption ? {motionCaption:{caption:motionCaption.caption,provider:'MotionGPT',note:'이 실제 MotionGPT 동작 설명을 우선 근거로 인상을 한국어로 표현하되, 관절 재타기팅과 루트 이동 추정의 한계가 있다.'}} : {}),
    }) }] }],
    generationConfig,
  };
}

async function analyze(motion, env, fetchImpl, signal, remainingMs, diagnostic) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  try {
    assertActive(signal);
    diagnostic.stage = 'prepare';
    const rubric = evaluateExpressionRubric(motion);
    const motionCaption = await requestMotionCaption(motion, env, {fetchImpl,signal});
    const body = JSON.stringify(analysisRequest(motion, model, rubric, motionCaption));
    diagnostic.requestBytes = new TextEncoder().encode(body).byteLength;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body,
      signal,
    };
    let response;
    diagnostic.providerStartedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      assertActive(signal);
      diagnostic.stage = 'provider_headers';
      diagnostic.attempts++;
      try { response = await fetchImpl(url, options); }
      catch (error) {
        assertActive(signal);
        if (attempt === 0 && error instanceof TypeError && remainingMs() >= MIN_RETRY_BUDGET_MS) {
          diagnostic.stage = 'retry_wait';
          await waitForRetry(signal);
          continue;
        }
        throw error;
      }
      assertActive(signal);
      if (attempt === 0 && RETRYABLE_STATUS.has(response.status) && remainingMs() >= MIN_RETRY_BUDGET_MS) {
        // Release the failed response without waiting on an error-body stream.
        Promise.resolve(response.body?.cancel()).catch(() => {});
        diagnostic.stage = 'retry_wait';
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
      diagnostic.stage = 'provider_body';
      throw await providerConfigError(response, signal);
    }
    if (!response.ok) throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'AI 서비스가 잠시 응답하지 않습니다. 나중에 다시 시도해 주세요.',
      `PROVIDER_HTTP_${response.status}`);
    diagnostic.stage = 'provider_body';
    const payload = await response.json();
    assertActive(signal);
    diagnostic.providerEndedAt = Date.now();
    // Only provider-supplied numeric counts enter diagnostics. Missing usage
    // never becomes an invented zero, estimate, or copy of response content.
    for (const [field, providerField] of [
      ['inputTokens', 'promptTokenCount'],
      ['outputTokens', 'candidatesTokenCount'],
      ['thoughtTokens', 'thoughtsTokenCount'],
    ]) {
      const count = payload?.usageMetadata?.[providerField];
      if (Number.isSafeInteger(count) && count >= 0) diagnostic[field] = count;
    }
    diagnostic.stage = 'parse';
    const candidate = payload.candidates?.[0];
    if (!candidate || !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
      throw new ApiError(502, 'INCOMPLETE_ANALYSIS', 'AI가 분석을 완성하지 못했습니다. 다시 시도해 주세요.');
    }
    const responseText = candidate.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
    try { return { provider: motionCaption ? 'MotionGPT + Gemini' : 'Gemini', model, analysis: readAnalysis(responseText, rubric), ...(motionCaption?{motionCaption}: {}) }; }
    catch {
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new ApiError(502, 'INCOMPLETE_ANALYSIS', 'AI 응답이 중간에 끝났습니다. 다시 시도해 주세요.');
      }
      throw new ApiError(502, 'INVALID_ANALYSIS', 'AI 응답 형식이 올바르지 않습니다. 다시 시도해 주세요.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof MotionCaptionError) throw new ApiError(error.status,error.code,error.message);
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
  allowLocal = false, requireOrigin = false, timeoutMs = env.MOTIONGPT_URL ? 180000 : ANALYSIS_DEADLINE_MS,
  onDiagnostic,
} = {}) {
  const startedAt = Date.now();
  const diagnostic = { attempts: 0, stage: 'request' };
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
      return json(200, { available: Boolean(env.GEMINI_API_KEY?.trim()), provider: env.MOTIONGPT_URL ? 'MotionGPT + Gemini' : 'Gemini', model: env.GEMINI_MODEL || DEFAULT_MODEL });
    }
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'POST 요청만 가능합니다.');
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new ApiError(503, 'NOT_CONFIGURED', 'AI 서버에 Gemini API 키가 아직 연결되지 않았습니다. 움직임 기록과 재생은 계속 사용할 수 있습니다.');
    }
    const result = await withDeadline(async (signal, remainingMs) => {
      diagnostic.stage = 'input';
      const motion = validateMotion(await readBoundedJson(request, signal));
      assertActive(signal);
      diagnostic.stage = 'rate_limit';
      const permitted = await checkLimit(request);
      assertActive(signal);
      if (!permitted) throw new ApiError(429, 'RATE_LIMITED', '분석 요청이 많습니다. 1분 뒤에 다시 시도해 주세요.');
      return analyze(motion, env, fetchImpl, signal, remainingMs, diagnostic);
    }, timeoutMs);
    diagnostic.stage = 'complete';
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
        const event = {
          code: diagnosticCode, elapsedMs: Math.max(0, Date.now() - startedAt),
          attempts: diagnostic.attempts, stage: diagnostic.stage,
        };
        if (diagnostic.providerStartedAt !== undefined) {
          event.providerMs = Math.max(0, (diagnostic.providerEndedAt ?? Date.now()) - diagnostic.providerStartedAt);
        }
        for (const field of ['requestBytes', 'inputTokens', 'outputTokens', 'thoughtTokens']) {
          if (diagnostic[field] !== undefined) event[field] = diagnostic[field];
        }
        Promise.resolve(onDiagnostic(event)).catch(() => {});
      } catch {}
    }
  }
}
