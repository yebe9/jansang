import { measureMotionEvidence, DYNAMIC_THRESHOLDS } from './motion-evidence.mjs';
// Empirical visual-language gates, not a validated measure of bodily flexibility.
// Angles below are 2D projected angles corrected by the capture aspect ratio.
// Missing legacy aspect ratios never count as joint-flexibility evidence.
export const RUBRIC_VERSION = 'visual-rubric-v2';
export const RUBRIC_THRESHOLDS = Object.freeze({
  dynamic: DYNAMIC_THRESHOLDS,
  maxGapMs: 250,
  movingSpeed: 0.02,
  flow: Object.freeze({
    minDurationMs: 2500, minRecordRatio: 0.8, minMovingRatio: 0.9, minPathLength: 0.18,
    minMeanSpeed: 0.06, maxMeanSpeed: 0.45, maxSpeedCv: 0.3, maxTurnDeg: 25,
  }),
  flex: Object.freeze({
    minDurationMs: 2000, minAngleRangeDeg: 45, maxBentAngleDeg: 115,
    minExtendedAngleDeg: 155, minBendTravelDeg: 35, minExtendTravelDeg: 35,
    maxAngularSpeed: 100, minMovingRatio: 0.75,
    minMeanSpeed: 0.04, maxMeanSpeed: 0.5, maxSpeedCv: 0.65, maxTurnDeg: 25,
  }),
});

// Short visual distinctions for all 50 user-supplied labels. These intentionally
// avoid claims about emotions, muscle strength, music, or a person's skill.
export const VISUAL_DEFINITIONS = Object.freeze({
  '우아한': '절제된 폭과 균형 있는 선',
  '유려한': '속도와 방향이 안정적으로 이어지는 긴 흐름; 허용 게이트 필수',
  '감미로운': '완만하게 다가오고 물러나는 부드러운 흐름',
  '나비 같은': '가벼운 상승·하강과 섬세한 펼침',
  '연연한': '작고 가는 선이 느리게 이어짐',
  '미려한': '정돈된 윤곽과 균형 있는 곡선',
  '매끄러운': '연결에서 갑작스러운 튐이 적음',
  '사뿐한': '짧고 가벼운 이동과 조심스러운 내려놓음',
  '나풀거리는': '가볍게 흔들리는 작은 왕복 곡선',
  '역동적인': '지속되는 크고 빠른 이동과 속도·방향 변화; 게이트 필수',
  '폭발적인': '멈춤이나 작은 동작 뒤 급격히 커지는 이동',
  '절도 있는': '분명한 멈춤과 구분되는 방향 전환',
  '파워풀한': '넓은 범위를 빠르고 강하게 가로지르는 인상',
  '격정적인': '크기와 속도가 거세게 변하는 인상',
  '거침없는': '멈춤이 적고 크게 뻗어나감',
  '저돌적인': '한 방향으로 빠르고 반복적으로 밀고 나감',
  '직선적인': '굽은 선보다 곧은 이동이 우세함',
  '압도적인': '여러 부위가 넓은 이동 폭으로 연속 전개됨; 정적 자세 크기는 불가',
  '몽환적인': '느리고 흐릿하게 이어지는 완만한 궤적',
  '신비로운': '규칙이 쉽게 드러나지 않는 느린 변화',
  '의식적인': '같은 형태를 느리고 엄정하게 반복함',
  '홀린 듯한': '같은 패턴에 오래 머무는 반복의 인상',
  '환상적인': '크게 달라지는 독특한 형태들의 연결',
  '정령 같은': '가벼운 부유와 방향을 바꾸는 작은 흔들림',
  '매혹적인': '시선을 끄는 곡선과 머무름의 대비',
  '몽롱한': '작은 속도 변화로 느슨하게 이어지는 선',
  '경쾌한': '짧은 이동과 가벼운 멈춤이 빠르게 교대함',
  '재치 있는': '반복을 깨는 작은 방향·크기 반전',
  '그루비한': '왕복 흔들림에 주기적인 속도 변화가 있음',
  '분주한': '작은 이동과 방향 전환이 빈번함',
  '자유분방한': '방향과 범위가 다양하고 불규칙함',
  '익살스러운': '과장된 크기 변화와 갑작스러운 반전',
  '리드미컬한': '이동과 멈춤 또는 속도 변화가 주기적임',
  '통통 튀는': '짧은 상승·하강이나 튕기는 왕복이 반복됨',
  '애절한': '느린 뻗음과 내려앉음이 길게 머무는 인상',
  '서정적인': '작은 변화가 차분한 긴 흐름을 만듦',
  '처연한': '작고 느린 하강과 정지의 인상',
  '격앙된': '이동 폭과 속도가 점차 커지는 인상',
  '절제된': '좁은 범위와 적은 동작으로 제한됨',
  '묵직한': '천천히 이동하며 한 위치에 오래 머묾',
  '호소력 짙은': '크게 뻗는 동작과 긴 멈춤의 대비',
  '처절한': '큰 뻗음과 급격한 수축이 반복되는 인상',
  '정교한': '작은 차이의 위치와 방향을 반복적으로 구분함',
  '감각적인': '곡선·직선·정지의 뚜렷한 형태 대비',
  '기하학적인': '직선·각·원호 등 알아볼 수 있는 도형',
  '날카로운': '급격한 방향 전환이나 짧게 끊긴 선',
  '유연한': '전신의 관절 굽힘·펴짐이 직접 보임; 곡선 이동만으로 불가',
  '아크로바틱한': '전신의 큰 자세 전환이나 뒤집힘이 실제 보일 때만',
  '미니멀한': '아주 적은 동작과 넓은 여백',
  '유기적인': '부분들이 순차적으로 펼쳐지고 모이는 형태',
});

const clamp = value => Math.max(-1, Math.min(1, value));
const degrees = radians => radians * 180 / Math.PI;
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;

function collectRuns(frames, extract) {
  const last = new Map();
  const runs = [];
  frames.forEach((frame, index) => {
    for (const point of extract(frame)) {
      const previous = last.get(point.key);
      const delta = previous ? frame.t - previous.t : 0;
      const continuous = previous && previous.index === index - 1 &&
        previous.segment === point.segment && delta > 0 && delta <= RUBRIC_THRESHOLDS.maxGapMs;
      const run = continuous ? previous.run : [];
      if (!continuous) runs.push(run);
      run.push({ ...point, t: frame.t });
      last.set(point.key, { t: frame.t, index, segment: point.segment, run });
    }
  });
  return runs.filter(run => run.length >= 2);
}

function traceStats(run, aspect) {
  const intervals = run.slice(1).map((point, i) => {
    const dt = (point.t - run[i].t) / 1000;
    const dx = (point.x - run[i].x) * aspect;
    const dy = point.y - run[i].y;
    return { dt, dx, dy, speed: Math.hypot(dx, dy) / Math.hypot(aspect, 1) / dt };
  });
  const seconds = intervals.reduce((sum, item) => sum + item.dt, 0);
  const pathLength = intervals.reduce((sum, item) => sum + item.speed * item.dt, 0);
  const meanSpeed = pathLength / seconds;
  const movingRatio = intervals.reduce((sum, item) =>
    sum + (item.speed >= RUBRIC_THRESHOLDS.movingSpeed ? item.dt : 0), 0) / seconds;
  const speedCv = meanSpeed > 0
    ? Math.sqrt(intervals.reduce((sum, item) => sum + (item.speed - meanSpeed) ** 2 * item.dt, 0) / seconds) / meanSpeed : null;
  const turns = [];
  intervals.slice(1).forEach((item, i) => {
    const previous = intervals[i];
    if (item.speed < RUBRIC_THRESHOLDS.movingSpeed || previous.speed < RUBRIC_THRESHOLDS.movingSpeed) return;
    turns.push(degrees(Math.acos(clamp((item.dx * previous.dx + item.dy * previous.dy) /
      (Math.hypot(item.dx, item.dy) * Math.hypot(previous.dx, previous.dy))))));
  });
  return {
    durationMs: seconds * 1000, pathLength, meanSpeed, movingRatio, speedCv,
    maxTurnDeg: turns.length ? Math.max(...turns) : null,
  };
}

function stableTrace(stats, thresholds) {
  return stats.durationMs >= thresholds.minDurationMs &&
    stats.movingRatio >= thresholds.minMovingRatio &&
    stats.meanSpeed >= thresholds.minMeanSpeed && stats.meanSpeed <= thresholds.maxMeanSpeed &&
    stats.speedCv !== null && stats.speedCv <= thresholds.maxSpeedCv &&
    stats.maxTurnDeg !== null && stats.maxTurnDeg <= thresholds.maxTurnDeg;
}

const BODY_ANCHORS = ['leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle'];
const LIMBS = [
  ['leftShoulder', 'leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow', 'rightWrist'],
  ['leftHip', 'leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee', 'rightAnkle'],
];

function jointAngle(joints, names, aspect) {
  const points = names.map(name => joints[name]);
  if (points.some(point => !point)) return null;
  const [a, b, c] = points;
  const u = [(a[0] - b[0]) * aspect, a[1] - b[1]];
  const v = [(c[0] - b[0]) * aspect, c[1] - b[1]];
  const lengths = [Math.hypot(...u), Math.hypot(...v)];
  // Near-collapsed projected bones make angles unstable; do not treat them as
  // evidence that an actual joint can bend or stretch unusually far.
  if (lengths.some(length => length < 0.025)) return null;
  return degrees(Math.acos(clamp((u[0] * v[0] + u[1] * v[1]) / (lengths[0] * lengths[1]))));
}

export function evaluateExpressionRubric(motion) {
  const motionEvidence = measureMotionEvidence(motion);
  const knownAspect = Number.isFinite(motion.captureAspect) && motion.captureAspect >= 0.2 && motion.captureAspect <= 5;
  const aspect = knownAspect ? motion.captureAspect : 1;
  const runs = collectRuns(motion.samples, frame => {
    const segment = frame.segment ?? frame.stroke ?? 0;
    if (motion.source === 'hand') return frame.hands.map(hand => ({
      key: 'hand:' + hand.id, segment,
      x: hand.joints[motion.handTarget][0], y: hand.joints[motion.handTarget][1],
    }));
    if (motion.source === 'webcam') return BODY_ANCHORS.filter(name => frame.joints[name]).map(name => ({
      key: name, segment, x: frame.joints[name][0], y: frame.joints[name][1],
    }));
    return [{ key: 'pointer', segment, x: frame.x, y: frame.y }];
  });
  // Use the most travelled observed trace, not a static limb or a tiny smooth
  // fragment chosen to hide the dominant motion's abrupt changes.
  const strongest = runs.map(run => traceStats(run, aspect)).sort((a, b) => b.pathLength - a.pathLength)[0];
  const flow = Boolean(strongest && stableTrace(strongest, RUBRIC_THRESHOLDS.flow) &&
    strongest.durationMs / motion.durationMs >= RUBRIC_THRESHOLDS.flow.minRecordRatio &&
    strongest.pathLength >= RUBRIC_THRESHOLDS.flow.minPathLength);
  let bestFlex = null;
  let flexible = false;
  if (motion.source === 'webcam' && knownAspect) {
    const limbRuns = collectRuns(motion.samples, frame => LIMBS.flatMap(names => {
      const angle = jointAngle(frame.joints, names, aspect);
      if (angle === null) return [];
      const point = frame.joints[names[2]];
      return [{ key: names[1], segment: frame.segment ?? 0, x: point[0], y: point[1], angle }];
    }));
    for (const run of limbRuns) {
      const stats = traceStats(run, aspect);
      const angles = run.map(point => point.angle);
      const differences = run.slice(1).map((point, i) => point.angle - run[i].angle);
      const minAngle = Math.min(...angles);
      const maxAngle = Math.max(...angles);
      const angularSpeed = Math.max(...differences.map((delta, i) => Math.abs(delta) / ((run[i + 1].t - run[i].t) / 1000)));
      const bendTravel = differences.reduce((sum, delta) => sum + Math.max(0, -delta), 0);
      const extendTravel = differences.reduce((sum, delta) => sum + Math.max(0, delta), 0);
      const thresholds = RUBRIC_THRESHOLDS.flex;
      const eligible = stableTrace(stats, thresholds) && maxAngle - minAngle >= thresholds.minAngleRangeDeg &&
        minAngle <= thresholds.maxBentAngleDeg && maxAngle >= thresholds.minExtendedAngleDeg &&
        bendTravel >= thresholds.minBendTravelDeg && extendTravel >= thresholds.minExtendTravelDeg &&
        angularSpeed <= thresholds.maxAngularSpeed;
      const evidence = { range: maxAngle - minAngle, minAngle, maxAngle, angularSpeed, bendTravel, extendTravel };
      if (!bestFlex || eligible || (!flexible && evidence.range > bestFlex.range)) bestFlex = evidence;
      flexible ||= eligible;
    }
  }
  return {
    version: RUBRIC_VERSION,
    kind: 'heuristic',
    note: knownAspect
      ? '영상 비율을 보정한 2D 관측의 경험적 표현 기준이며 신체 유연성·실제 감정의 측정이 아닙니다.'
      : '영상 비율이 없어 유연한은 제외했습니다. 흐름은 정사각 투영의 경험 기준이며 신체 유연성·실제 감정의 측정이 아닙니다.',
    eligible: { '유연한': flexible, '유려한': flow, '역동적인': motionEvidence.eligibleDynamic },
    motionEvidence,
    metrics: {
      captureAspect: knownAspect ? round(aspect) : null,
      continuousMs: round(strongest?.durationMs), meanSpeed: round(strongest?.meanSpeed),
      movingRatio: round(strongest?.movingRatio), speedCv: round(strongest?.speedCv),
      maxTurnDeg: round(strongest?.maxTurnDeg), pathLength: round(strongest?.pathLength),
      flexAngleRangeDeg: round(bestFlex?.range), flexMinAngleDeg: round(bestFlex?.minAngle),
      flexMaxAngleDeg: round(bestFlex?.maxAngle), flexMaxAngularSpeed: round(bestFlex?.angularSpeed),
      flexBendTravelDeg: round(bestFlex?.bendTravel), flexExtendTravelDeg: round(bestFlex?.extendTravel),
    },
  };
}
