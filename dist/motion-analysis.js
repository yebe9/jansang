/* Browser-only movement measurements. These describe motion, not a person's inner emotions. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JansangMotion = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const JOINTS = [
    'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
    'leftWrist', 'rightWrist', 'leftPinky', 'rightPinky',
    'leftIndex', 'rightIndex', 'leftThumb', 'rightThumb',
    'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
    'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel',
    'leftFootIndex', 'rightFootIndex'
  ];
  const HAND_JOINTS = [
    'wrist', 'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
    'indexMcp', 'indexPip', 'indexDip', 'indexTip',
    'middleMcp', 'middlePip', 'middleDip', 'middleTip',
    'ringMcp', 'ringPip', 'ringDip', 'ringTip',
    'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip'
  ];
  const UPPER_GROUPS = [
    ['leftWrist', 'rightWrist'], ['leftElbow', 'rightElbow'], ['leftShoulder', 'rightShoulder']
  ];
  const LOWER_GROUPS = [
    ['leftAnkle', 'rightAnkle'], ['leftKnee', 'rightKnee'], ['leftHip', 'rightHip']
  ];
  const TORSO = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];
  const FULL_BODY = [...TORSO, 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];
  const MOTION_JOINTS = [...UPPER_GROUPS.flat(), ...LOWER_GROUPS.flat()];
  const MIN_INTERVAL_MS = 8;
  const MAX_INTERVAL_MS = 250;
  const STILL_SPEED = 0.055;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const round = (value, precision = 5) => {
    if (!Number.isFinite(value)) return 0;
    const scale = 10 ** precision;
    return Math.round(value * scale) / scale;
  };

  function coordinate(value) {
    if (!Array.isArray(value) || !finite(value[0]) || !finite(value[1])) return null;
    return [clamp(value[0], 0, 1), clamp(value[1], 0, 1)];
  }

  function sanitizePoints(input, durationMs) {
    return (Array.isArray(input) ? input : [])
      .filter((point) => point && finite(point.t) && point.t >= 0 &&
        point.t <= durationMs && finite(point.x) && finite(point.y))
      .map((point) => ({
        t: point.t,
        x: clamp(point.x, 0, 1),
        y: clamp(point.y, 0, 1),
        stroke: finite(point.stroke) ? Math.trunc(point.stroke) : 0
      }))
      .sort((a, b) => a.t - b.t);
  }

  function sanitizeFrames(input, durationMs, names = JOINTS) {
    return (Array.isArray(input) ? input : [])
      .filter((frame) => frame && finite(frame.t) && frame.t >= 0 && frame.t <= durationMs)
      .map((frame) => {
        const joints = {};
        for (const name of names) {
          const point = coordinate(frame.joints && frame.joints[name]);
          if (point) joints[name] = point;
        }
        const segment = Number.isSafeInteger(frame.segment) && frame.segment >= 0 ? frame.segment : 0;
        return { t: frame.t, joints, segment };
      })
      .sort((a, b) => a.t - b.t);
  }

  function sanitizeHandFrames(input, durationMs, target) {
    return (Array.isArray(input) ? input : [])
      .filter((frame) => frame && finite(frame.t) && frame.t >= 0 && frame.t <= durationMs)
      .map((frame) => {
        const seen = new Set();
        const hands = [];
        const observations = Array.isArray(frame.hands) ? frame.hands : [{ id: 1, joints: frame.joints }];
        for (const hand of observations) {
          if (!hand || !Number.isSafeInteger(hand.id) || hand.id <= 0 || seen.has(hand.id)) continue;
          const joints = {};
          for (const name of HAND_JOINTS) {
            const point = coordinate(hand.joints && hand.joints[name]);
            if (point) joints[name] = point;
          }
          if (!joints[target] || Object.keys(joints).length < 2) continue;
          seen.add(hand.id);
          hands.push({ id: hand.id, joints });
          if (hands.length === 2) break;
        }
        const segment = Number.isSafeInteger(frame.segment) && frame.segment >= 0 ? frame.segment : 0;
        return { t: frame.t, segment, hands };
      })
      .sort((a, b) => a.t - b.t);
  }

  // Choose actual observations near equally spaced times, retaining both ends.
  // Never interpolate a missing joint or invent a path through a recording gap.
  function sampleEvenly(frames, limit = 60) {
    if (frames.length <= limit) return frames;
    const selected = new Set([0, frames.length - 1]);
    const first = frames[0].t;
    const span = frames[frames.length - 1].t - first;
    let index = 0;
    for (let sample = 1; sample < limit - 1; sample += 1) {
      const target = first + span * sample / (limit - 1);
      while (index + 1 < frames.length && frames[index + 1].t <= target) index += 1;
      const closest = index + 1 < frames.length &&
        Math.abs(frames[index + 1].t - target) < Math.abs(frames[index].t - target) ? index + 1 : index;
      selected.add(closest);
    }
    return [...selected].sort((a, b) => a - b).map((index) => frames[index]);
  }

  function measure(source, data, aspect, handTarget = 'indexTip') {
    // Distances are fractions of the image diagonal, preserving the capture aspect.
    const diagonal = Math.hypot(aspect, 1);
    const vector = (a, b) => [(b[0] - a[0]) * aspect / diagonal, (b[1] - a[1]) / diagonal];
    const length = (v) => Math.hypot(v[0], v[1]);
    const positions = [];
    const jointBounds = new Map();
    const activeBounds = {};
    const intervals = [];
    const spreads = [];
    let previous = null;
    let directions = {};
    let weightedTurns = 0;
    let validFrames = 0;
    let fullBodyFrames = 0;
    let boundsId = 0;
    const trackedHands = source === 'hand' && data.some((frame) => Array.isArray(frame.hands));
    const frameJoints = (frame) => source === 'webcam' ? frame.joints
      : trackedHands ? Object.fromEntries(frame.hands.map((hand) => [hand.id, hand.joints[handTarget]]))
        : { pointer: [frame.x, frame.y] };

    for (const frame of data) {
      const joints = frameJoints(frame);
      const names = source === 'webcam' ? MOTION_JOINTS : trackedHands ? Object.keys(joints) : ['pointer'];
      const observed = names.filter((name) => joints[name]);
      if (observed.length) validFrames += 1;
      if (source === 'webcam' && FULL_BODY.every((name) => joints[name])) fullBodyFrames += 1;

      if (source === 'webcam') {
        const body = observed;
        if (body.length >= 2) {
          let spread = 0;
          for (let i = 0; i < body.length; i += 1) {
            for (let j = i + 1; j < body.length; j += 1) {
              spread = Math.max(spread, length(vector(joints[body[i]], joints[body[j]])));
            }
          }
          spreads.push(spread);
        }
      }

      const dt = previous ? frame.t - previous.t : 0;
      const sameSegment = previous && (source === 'webcam' || trackedHands
        ? previous.segment === frame.segment : previous.stroke === frame.stroke);
      const continuous = sameSegment && dt >= MIN_INTERVAL_MS && dt <= MAX_INTERVAL_MS;
      const previousJoints = previous ? frameJoints(previous) : {};
      // A body already occupies space while standing. Coverage measures each
      // joint's travel, never the rectangle between separate, stationary limbs.
      for (const name of observed) {
        if (source !== 'webcam' && source !== 'hand') {
          positions.push(joints[name]);
          continue;
        }
        if (!continuous || !previousJoints[name]) {
          activeBounds[name] = boundsId++;
          jointBounds.set(activeBounds[name], [...joints[name], ...joints[name]]);
        }
        const bounds = jointBounds.get(activeBounds[name]);
        bounds[0] = Math.min(bounds[0], joints[name][0]);
        bounds[1] = Math.min(bounds[1], joints[name][1]);
        bounds[2] = Math.max(bounds[2], joints[name][0]);
        bounds[3] = Math.max(bounds[3], joints[name][1]);
      }
      if (!continuous) {
        directions = {};
        previous = frame;
        continue;
      }
      const motions = {};
      const nextDirections = {};
      for (const name of observed) {
        if (!previousJoints[name]) continue;
        const delta = vector(previousJoints[name], joints[name]);
        const distance = length(delta);
        const speed = distance / (dt / 1000);
        motions[name] = { speed, distance, turn: 0 };
        if (speed >= STILL_SPEED) {
          const direction = delta.map((value) => value / distance);
          if (directions[name]) {
            const cosine = direction[0] * directions[name][0] + direction[1] * directions[name][1];
            if (cosine < 0.5) motions[name].turn = 1; // At least a 60-degree direction change.
          }
          nextDirections[name] = direction;
        }
      }
      directions = nextDirections;
      const group = (groups) => {
        const available = groups.map((names) => names.filter((name) => motions[name]))
          .filter((names) => names.length).map((selected) => ({
            speed: selected.reduce((sum, name) => sum + motions[name].speed, 0) / selected.length,
            distance: selected.reduce((sum, name) => sum + motions[name].distance, 0) / selected.length,
            turns: selected.reduce((sum, name) => sum + motions[name].turn, 0) / selected.length
          }));
        return available.length
          ? available.reduce((best, current) => current.speed > best.speed ? current : best) : null;
      };
      const upper = source === 'webcam' ? group(UPPER_GROUPS) : null;
      const lower = source === 'webcam' ? group(LOWER_GROUPS) : null;
      const torso = source === 'webcam' ? group([TORSO]) : null;
      const available = source === 'webcam'
        ? [upper, lower, torso].filter(Boolean)
        : [group([trackedHands ? names : ['pointer']])].filter(Boolean);
      if (available.length) {
        // Use the most active body region, or the mean of independently tracked
        // hand targets. Two hands share one time interval, never double activity.
        const active = available.reduce((best, current) => current.speed > best.speed ? current : best);
        weightedTurns += active.turns;
        intervals.push({
          dt,
          speed: active.speed,
          peak: Math.max(...Object.values(motions).map((entry) => entry.speed)),
          distance: active.distance,
          upper, lower, torso
        });
      }
      previous = frame;
    }

    const trackedDurationMs = intervals.reduce((sum, entry) => sum + entry.dt, 0);
    const meanSpeed = trackedDurationMs
      ? intervals.reduce((sum, entry) => sum + entry.speed * entry.dt, 0) / trackedDurationMs : 0;
    const variance = trackedDurationMs
      ? intervals.reduce((sum, entry) => sum + (entry.speed - meanSpeed) ** 2 * entry.dt, 0) / trackedDurationMs : 0;
    let width = 0;
    let height = 0;
    if (positions.length) {
      const xs = positions.map((point) => point[0]);
      const ys = positions.map((point) => point[1]);
      width = Math.max(...xs) - Math.min(...xs);
      height = Math.max(...ys) - Math.min(...ys);
    }
    const bodyCoverage = [...jointBounds.values()].reduce((area, bounds) =>
      Math.max(area, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])), 0);
    const metrics = {
      meanSpeed,
      peakSpeed: intervals.reduce((peak, entry) => Math.max(peak, entry.peak), 0),
      stillnessRatio: trackedDurationMs
        ? intervals.filter((entry) => entry.speed < STILL_SPEED).reduce((sum, entry) => sum + entry.dt, 0) / trackedDurationMs : 0,
      coverage: source === 'webcam' || source === 'hand' ? bodyCoverage : width * height,
      spread: spreads.length
        ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length
        : source === 'hand' ? [...jointBounds.values()].reduce((largest, bounds) =>
          Math.max(largest, Math.hypot((bounds[2] - bounds[0]) * aspect, bounds[3] - bounds[1]) / diagonal), 0)
          : Math.hypot(width * aspect, height) / diagonal,
      tempoVariation: meanSpeed > 0.005 ? Math.sqrt(variance) / meanSpeed : 0,
      directionChangeRate: trackedDurationMs ? weightedTurns / (trackedDurationMs / 1000) : 0,
      pathLength: intervals.reduce((sum, entry) => sum + entry.distance, 0),
      trackedDurationMs,
      validFrameRatio: data.length ? validFrames / data.length : 0
    };
    if (source === 'webcam') {
      const meanGroupSpeed = (name) => {
        const recorded = intervals.filter((entry) => entry[name]);
        const duration = recorded.reduce((sum, entry) => sum + entry.dt, 0);
        return duration ? recorded.reduce((sum, entry) => sum + entry[name].speed * entry.dt, 0) / duration : 0;
      };
      metrics.upperBodySpeed = meanGroupSpeed('upper');
      metrics.lowerBodySpeed = meanGroupSpeed('lower');
      metrics.torsoSpeed = meanGroupSpeed('torso');
      metrics.fullBodyRatio = data.length ? fullBodyFrames / data.length : 0;
    }
    for (const key of Object.keys(metrics)) metrics[key] = round(metrics[key]);
    const validData = source === 'webcam'
      ? data.filter((frame) => MOTION_JOINTS.some((name) => frame.joints[name]))
      : trackedHands ? data.filter((frame) => frame.hands.length) : data;
    const span = validData.length ? validData[validData.length - 1].t - validData[0].t : 0;
    return {
      metrics,
      sufficient: validFrames >= 8 && span >= 1000 && trackedDurationMs >= 500
    };
  }

  function describe(metrics, sufficient, source, handTarget, handCount = 1) {
    const handLabel = handTarget === 'wrist' ? '손목' : '검지 끝';
    const handsLabel = handCount > 1 ? '두 손' : '한 손';
    const caveat = (source === 'hand' ? `인식된 ${handsLabel}의 ${handLabel} 궤적만을 바탕으로, ` : '') +
      '측정한 움직임을 간단한 규칙으로 표현한 기본 인상입니다. 실제 감정이나 의도를 판단한 결과가 아닙니다.';
    if (!sufficient) {
      return {
        impression: '조금 더 긴 움직임이 필요해요',
        description: source === 'webcam'
          ? '어깨부터 발끝까지 화면에 보이도록 1초 이상 움직여 주세요. 인식된 연속 구간이 짧아 움직임의 인상을 읽기 어렵습니다.'
          : source === 'hand'
            ? `손을 화면 안에 두고 ${handLabel}을 1초 이상 움직여 주세요. 연속해서 인식된 손의 자취가 짧아 인상을 읽기 어렵습니다.`
            : '1초 이상 궤적을 그려 주세요. 기록된 연속 구간이 짧아 특징을 비교하기 어렵습니다.',
        observations: ['연속해서 측정할 수 있는 움직임이 부족합니다.'],
        qualities: [],
        caveat
      };
    }
    const observations = [];
    if (source === 'hand') observations.push(`인식된 ${handsLabel}의 ${handLabel}이 남긴 자취를 따라 읽은 인상입니다.`);
    const fast = metrics.meanSpeed >= 0.65;
    const slow = metrics.meanSpeed < 0.2;
    const turns = metrics.directionChangeRate >= 1.3;
    const contrast = metrics.tempoVariation >= 0.8 && metrics.meanSpeed >= STILL_SPEED;
    const still = metrics.stillnessRatio >= 0.7;
    const wide = metrics.coverage >= 0.18;
    const footLed = source === 'webcam' && metrics.lowerBodySpeed > metrics.upperBodySpeed * 1.5 &&
      metrics.lowerBodySpeed >= 0.2;
    const impression = still ? '차분한'
      : turns && contrast ? '초조한'
        : contrast && metrics.stillnessRatio >= 0.25 ? '머뭇거리는'
          : turns ? '날카로운'
            : fast ? '빠른'
              : footLed ? '경쾌한'
                : slow ? '차분한' : '유연한';
    const qualities = [...new Set([
      impression,
      fast ? '빠른' : slow || still ? '차분한' : '유연한',
      turns ? '날카로운' : contrast ? '머뭇거리는' : '매끄러운',
      wide ? '시원한' : footLed ? '경쾌한' : '섬세한'
    ])].slice(0, 3);
    const atmosphere = {
      '차분한': '잔잔하게 머물며 호흡을 고르는 듯한 인상을 줍니다.',
      '초조한': '툭툭 끊기고 서두르는 리듬이 초조한 장면의 표현처럼 읽힐 수 있습니다.',
      '머뭇거리는': '나아가다가 잠시 주저하는 듯한, 머뭇거리는 인상을 줍니다.',
      '날카로운': '움직임이 선명하게 꺾이며 날카로운 리듬을 만드는 듯합니다.',
      '빠른': '빠르게 흘러가는 움직임에서 추진력과 생동감이 느껴집니다.',
      '경쾌한': '하체에서 시작되는 리듬이 가볍고 경쾌한 인상을 줍니다.',
      '유연한': '끊기지 않고 이어지는 흐름이 유연하게 물결치는 듯합니다.'
    };
    const detail = still ? '작은 변화와 여백이 조용한 분위기를 만듭니다.'
      : footLed ? '팔보다 다리의 흐름이 두드러져, 하체가 장면의 리듬을 이끄는 듯합니다.'
        : wide ? '넓게 뻗어나가는 자취가 시원한 공간감을 더합니다.'
          : contrast ? '밀고 나가는 순간과 숨을 고르는 순간이 번갈아 나타납니다.'
            : '이어지는 자취가 하나의 리듬을 남깁니다.';
    const prefix = source === 'example' ? '합성 예시의 궤적을 보면, '
      : source === 'hand' ? `${handLabel}의 자취를 보면, ` : '';
    if (metrics.stillnessRatio >= 0.7) {
      observations.push('움직임 사이에 머무는 여백이 길게 보입니다.');
    } else if (fast) {
      observations.push('자취가 빠르게 이어지며 속도감이 두드러집니다.');
    } else if (slow) {
      observations.push('서두르지 않고 천천히 이어지는 흐름이 보입니다.');
    } else {
      observations.push('움직임이 무리 없이 이어지는 흐름을 보입니다.');
    }
    if (footLed) observations.push('팔의 움직임보다 하체의 흐름이 더 두드러집니다.');
    if (wide) observations.push('한곳에 모이기보다 넓게 뻗어나가는 자취가 보입니다.');
    if (turns) observations.push('방향을 바꾸는 순간이 반복되어 꺾이는 리듬을 만듭니다.');
    if (contrast) observations.push('빠르게 흐르는 순간과 머무는 순간이 대비됩니다.');
    else if (!still) observations.push('속도의 흐름이 비교적 고르게 이어집니다.');
    if (source === 'webcam' && metrics.fullBodyRatio < 0.5) {
      observations.push('화면에 잡힌 몸의 일부만으로 읽은 인상입니다.');
    }
    return {
      impression,
      description: prefix + atmosphere[impression] + ' ' + detail,
      observations: observations.slice(0, 4),
      qualities,
      caveat
    };
  }

  function analyze(input = {}) {
    const source = ['webcam', 'hand', 'example'].includes(input.source) ? input.source : 'pointer';
    const handTarget = input.handTarget === 'wrist' ? 'wrist' : 'indexTip';
    const durationMs = finite(input.durationMs) ? clamp(input.durationMs, 0, 10000) : 10000;
    const aspect = finite(input.captureAspect) ? clamp(input.captureAspect, 0.2, 5) : 1;
    const dualHandFormat = source === 'hand' && Array.isArray(input.poseFrames) &&
      input.poseFrames.some((frame) => frame && Array.isArray(frame.hands));
    const handFrames = source === 'hand' ? sanitizeHandFrames(input.poseFrames, durationMs, handTarget) : [];
    const data = source === 'webcam'
      ? sanitizeFrames(input.poseFrames, durationMs)
      : dualHandFormat ? handFrames : sanitizePoints(input.points, durationMs);
    const measured = measure(source, data, aspect, handTarget);
    const { metrics } = measured;
    let sufficient = measured.sufficient;
    let sampleData = data;
    if (source === 'hand') {
      sampleData = handFrames.filter((frame) => frame.hands.length);
      // The selected target drives the impression. Legacy single-hand recordings
      // use their trace; new recordings measure each target by stable track ID.
      // Actual hand observations are required in either case.
      sufficient = sufficient && sampleData.length >= 8 &&
        sampleData.at(-1).t - sampleData[0].t >= 1000;
      metrics.validFrameRatio = round(handFrames.length ? sampleData.length / handFrames.length : 0);
    }
    const samples = sampleEvenly(sampleData).map((frame) => {
      if (source !== 'webcam' && source !== 'hand') {
        return { t: Math.min(durationMs, round(frame.t, 3)), x: round(frame.x), y: round(frame.y), stroke: frame.stroke };
      }
      if (source === 'hand') {
        return {
          t: Math.min(durationMs, round(frame.t, 3)), segment: frame.segment,
          hands: frame.hands.map((hand) => ({
            id: hand.id,
            joints: Object.fromEntries(Object.entries(hand.joints).map(([name, point]) =>
              [name, point.map((value) => round(value))]))
          }))
        };
      }
      const joints = {};
      for (const [name, point] of Object.entries(frame.joints)) joints[name] = point.map((value) => round(value));
      return { t: Math.min(durationMs, round(frame.t, 3)), joints, segment: frame.segment };
    });
    const payload = { source, durationMs, sampleCount: sampleData.length, metrics, samples };
    if (source === 'hand') payload.handTarget = handTarget;
    return {
      payload,
      local: describe(metrics, sufficient, source, handTarget,
        source === 'hand' ? Math.max(0, ...sampleData.map((frame) => frame.hands.length)) : 0),
      sufficient
    };
  }

  return { analyze };
});
