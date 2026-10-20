/* Browser-only movement measurements. These describe motion, not a person's inner emotions. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JansangMotion = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const JOINTS = [
    'leftWrist', 'rightWrist', 'leftElbow', 'rightElbow',
    'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'
  ];
  const WRISTS = ['leftWrist', 'rightWrist'];
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

  function sanitizeFrames(input, durationMs) {
    return (Array.isArray(input) ? input : [])
      .filter((frame) => frame && finite(frame.t) && frame.t >= 0 && frame.t <= durationMs)
      .map((frame) => {
        const joints = {};
        for (const name of JOINTS) {
          const point = coordinate(frame.joints && frame.joints[name]);
          if (point) joints[name] = point;
        }
        const segment = Number.isSafeInteger(frame.segment) && frame.segment >= 0 ? frame.segment : 0;
        return { t: frame.t, joints, segment };
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

  function measure(source, data, aspect) {
    // Distances are fractions of the image diagonal, preserving the capture aspect.
    const diagonal = Math.hypot(aspect, 1);
    const vector = (a, b) => [(b[0] - a[0]) * aspect / diagonal, (b[1] - a[1]) / diagonal];
    const length = (v) => Math.hypot(v[0], v[1]);
    const positions = [];
    const intervals = [];
    const spreads = [];
    let previous = null;
    let directions = {};
    let turnCount = 0;
    let turnOpportunities = 0;
    let validFrames = 0;

    for (const frame of data) {
      const joints = source === 'webcam' ? frame.joints : { pointer: [frame.x, frame.y] };
      const names = source === 'webcam' ? WRISTS : ['pointer'];
      const observed = names.filter((name) => joints[name]);
      if (observed.length) validFrames += 1;
      for (const name of observed) positions.push(joints[name]);

      if (source === 'webcam') {
        const upperBody = JOINTS.filter((name) => !name.endsWith('Hip') && joints[name]);
        if (upperBody.length >= 2) {
          let spread = 0;
          for (let i = 0; i < upperBody.length; i += 1) {
            for (let j = i + 1; j < upperBody.length; j += 1) {
              spread = Math.max(spread, length(vector(joints[upperBody[i]], joints[upperBody[j]])));
            }
          }
          spreads.push(spread);
        }
      }

      const dt = previous ? frame.t - previous.t : 0;
      const sameSegment = previous && (source === 'webcam'
        ? previous.segment === frame.segment : previous.stroke === frame.stroke);
      if (!previous || !sameSegment || dt < MIN_INTERVAL_MS || dt > MAX_INTERVAL_MS) {
        directions = {};
        previous = frame;
        continue;
      }
      const previousJoints = source === 'webcam' ? previous.joints : { pointer: [previous.x, previous.y] };
      const speeds = [];
      const distances = [];
      const nextDirections = {};
      for (const name of observed) {
        if (!previousJoints[name]) continue;
        const delta = vector(previousJoints[name], joints[name]);
        const distance = length(delta);
        const speed = distance / (dt / 1000);
        speeds.push(speed);
        distances.push(distance);
        if (speed >= STILL_SPEED) {
          const direction = delta.map((value) => value / distance);
          if (directions[name]) {
            const cosine = direction[0] * directions[name][0] + direction[1] * directions[name][1];
            turnOpportunities += 1;
            if (cosine < 0.5) turnCount += 1; // At least a 60-degree direction change.
          }
          nextDirections[name] = direction;
        }
      }
      directions = nextDirections;
      if (speeds.length) {
        // Average simultaneously observed wrists so two hands do not double the speed or time.
        intervals.push({
          dt,
          speed: speeds.reduce((sum, value) => sum + value, 0) / speeds.length,
          peak: Math.max(...speeds),
          distance: distances.reduce((sum, value) => sum + value, 0) / distances.length,
          joints: speeds.length
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
    const meanJointCount = intervals.length
      ? intervals.reduce((sum, entry) => sum + entry.joints, 0) / intervals.length : 1;
    const metrics = {
      meanSpeed,
      peakSpeed: intervals.reduce((peak, entry) => Math.max(peak, entry.peak), 0),
      stillnessRatio: trackedDurationMs
        ? intervals.filter((entry) => entry.speed < STILL_SPEED).reduce((sum, entry) => sum + entry.dt, 0) / trackedDurationMs : 0,
      coverage: width * height,
      spread: spreads.length
        ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length
        : Math.hypot(width * aspect, height) / diagonal,
      tempoVariation: meanSpeed > 0.005 ? Math.sqrt(variance) / meanSpeed : 0,
      directionChangeRate: trackedDurationMs && turnOpportunities
        ? turnCount / meanJointCount / (trackedDurationMs / 1000) : 0,
      pathLength: intervals.reduce((sum, entry) => sum + entry.distance, 0),
      trackedDurationMs,
      validFrameRatio: data.length ? validFrames / data.length : 0
    };
    for (const key of Object.keys(metrics)) metrics[key] = round(metrics[key]);
    const validData = source === 'webcam'
      ? data.filter((frame) => WRISTS.some((name) => frame.joints[name])) : data;
    const span = validData.length ? validData[validData.length - 1].t - validData[0].t : 0;
    return {
      metrics,
      sufficient: validFrames >= 8 && span >= 1000 && trackedDurationMs >= 500
    };
  }

  function describe(metrics, sufficient, source) {
    const caveat = '속도·범위·방향 변화로 정리한 움직임의 특징입니다. 실제 감정이나 의도를 판단한 결과가 아닙니다.';
    if (!sufficient) {
      return {
        impression: '조금 더 긴 움직임이 필요해요',
        description: source === 'webcam'
          ? '손목이 화면에 보이도록 1초 이상 움직여 주세요. 인식된 연속 구간이 짧아 특징을 비교하기 어렵습니다.'
          : '1초 이상 궤적을 그려 주세요. 기록된 연속 구간이 짧아 특징을 비교하기 어렵습니다.',
        observations: ['연속해서 측정할 수 있는 움직임이 부족합니다.'],
        qualities: [],
        caveat
      };
    }
    const observations = [];
    const qualities = [];
    if (metrics.stillnessRatio >= 0.7) {
      qualities.push('작은 움직임');
      observations.push('측정한 시간의 대부분에서 움직임의 변화가 작았습니다.');
    } else if (metrics.meanSpeed >= 0.65) {
      qualities.push('빠른 움직임');
      observations.push('화면 크기에 비해 손 또는 궤적이 빠르게 이동했습니다.');
    } else if (metrics.meanSpeed < 0.2) {
      qualities.push('느린 움직임');
      observations.push('화면 안에서 비교적 천천히 이동했습니다.');
    } else {
      qualities.push('꾸준한 움직임');
      observations.push('화면 안에서 중간 정도의 속도로 이동했습니다.');
    }
    if (metrics.spread >= 0.5 || metrics.coverage >= 0.3) {
      qualities.push('넓은 범위');
      observations.push(source === 'webcam'
        ? '팔과 손이 비교적 넓게 펼쳐지거나 넓은 영역을 오갔습니다.'
        : '궤적이 화면의 넓은 범위까지 뻗었습니다.');
    } else if (metrics.spread < 0.2 && metrics.coverage < 0.08) {
      qualities.push('좁은 범위');
      observations.push('움직임이 화면의 작은 영역에 모였습니다.');
    }
    if (metrics.directionChangeRate >= 1.3) {
      qualities.push('잦은 방향 전환');
      observations.push('진행 방향이 반복해서 바뀌었습니다.');
    }
    if (metrics.tempoVariation >= 0.8 && metrics.meanSpeed >= 0.055) {
      qualities.push('속도의 대비');
      observations.push('빠른 구간과 느린 구간의 차이가 나타났습니다.');
    } else if (metrics.stillnessRatio < 0.7) {
      qualities.push('고른 속도');
      observations.push('기록한 구간의 속도가 비교적 고르게 이어졌습니다.');
    }
    const impression = metrics.stillnessRatio >= 0.7 ? '작게 머무르는'
      : metrics.meanSpeed >= 0.65 && metrics.directionChangeRate >= 1.3 ? '빠르게 전환되는'
        : metrics.spread >= 0.5 || metrics.coverage >= 0.3 ? '크게 펼쳐지는'
          : metrics.tempoVariation >= 0.8 ? '속도가 달라지는'
            : metrics.meanSpeed >= 0.65 ? '빠르게 흐르는'
              : metrics.meanSpeed < 0.2 ? '차분히 이어지는' : '고르게 이어지는';
    return {
      impression,
      description: observations.slice(0, 2).join(' '),
      observations,
      qualities,
      caveat
    };
  }

  function analyze(input = {}) {
    const source = input.source === 'webcam' || input.source === 'example' ? input.source : 'pointer';
    const durationMs = finite(input.durationMs) ? clamp(input.durationMs, 0, 10000) : 10000;
    const aspect = finite(input.captureAspect) ? clamp(input.captureAspect, 0.2, 5) : 1;
    const data = source === 'webcam'
      ? sanitizeFrames(input.poseFrames, durationMs)
      : sanitizePoints(input.points, durationMs);
    const { metrics, sufficient } = measure(source, data, aspect);
    const samples = sampleEvenly(data).map((frame) => {
      if (source !== 'webcam') {
        return { t: Math.min(durationMs, round(frame.t, 3)), x: round(frame.x), y: round(frame.y), stroke: frame.stroke };
      }
      const joints = {};
      for (const [name, point] of Object.entries(frame.joints)) joints[name] = point.map((value) => round(value));
      return { t: Math.min(durationMs, round(frame.t, 3)), joints, segment: frame.segment };
    });
    return {
      payload: { source, durationMs, sampleCount: data.length, metrics, samples },
      local: describe(metrics, sufficient, source),
      sufficient
    };
  }

  return { analyze };
});
