'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../dist/motion-analysis.js');

function pointSeries(position, count = 61, step = 50) {
  return Array.from({ length: count }, (_, i) => ({
    t: i * step, ...position(i), stroke: 1
  }));
}
function poseSeries(position, count = 61, step = 50) {
  return Array.from({ length: count }, (_, i) => ({
    t: i * step,
    segment: 0,
    joints: {
      leftShoulder: [0.4, 0.4], rightShoulder: [0.6, 0.4],
      leftWrist: position(i),
      rightWrist: [1 - position(i)[0], position(i)[1]]
    }
  }));
}
function pointer(points, durationMs = 3000) {
  return analyze({ source: 'pointer', points, durationMs, captureAspect: 1 });
}
function webcam(poseFrames, durationMs = 3000) {
  return analyze({ source: 'webcam', poseFrames, durationMs, captureAspect: 1 });
}
function fullBodySeries(change = () => ({}), count = 61, step = 50) {
  const body = {
    leftShoulder: [0.4, 0.2], rightShoulder: [0.6, 0.2],
    leftElbow: [0.3, 0.35], rightElbow: [0.7, 0.35],
    leftWrist: [0.25, 0.5], rightWrist: [0.75, 0.5],
    leftPinky: [0.24, 0.53], rightPinky: [0.76, 0.53],
    leftIndex: [0.25, 0.54], rightIndex: [0.75, 0.54],
    leftThumb: [0.26, 0.52], rightThumb: [0.74, 0.52],
    leftHip: [0.43, 0.5], rightHip: [0.57, 0.5],
    leftKnee: [0.43, 0.7], rightKnee: [0.57, 0.7],
    leftAnkle: [0.43, 0.9], rightAnkle: [0.57, 0.9],
    leftHeel: [0.43, 0.92], rightHeel: [0.57, 0.92],
    leftFootIndex: [0.4, 0.95], rightFootIndex: [0.6, 0.95]
  };
  return Array.from({ length: count }, (_, i) => ({
    t: i * step, segment: 0, joints: { ...body, ...change(i) }
  }));
}
const handNames = [
  'wrist', 'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
  'indexMcp', 'indexPip', 'indexDip', 'indexTip',
  'middleMcp', 'middlePip', 'middleDip', 'middleTip',
  'ringMcp', 'ringPip', 'ringDip', 'ringTip',
  'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip'
];
function handRecording(handTarget = 'indexTip', count = 61, step = 50) {
  const poseFrames = Array.from({ length: count }, (_, i) => ({
    t: i * step, segment: 0,
    joints: {
      ...Object.fromEntries(handNames.map((name, n) => [name, [0.3 + n * 0.01, 0.4]])),
      indexTip: [0.5 + 0.25 * Math.sin(i * 0.3), 0.5 + 0.25 * Math.cos(i * 0.3)]
    }
  }));
  return {
    source: 'hand', handTarget, poseFrames, durationMs: (count - 1) * step, captureAspect: 1,
    points: poseFrames.map((frame) => ({
      t: frame.t, x: frame.joints[handTarget][0], y: frame.joints[handTarget][1], stroke: frame.segment
    }))
  };
}

test('hand impressions follow the selected fingertip or wrist without a full-body gate', () => {
  const finger = analyze(handRecording());
  const wrist = analyze(handRecording('wrist'));
  assert.equal(finger.sufficient, true);
  assert.equal(wrist.sufficient, true);
  assert.equal(finger.payload.source, 'hand');
  assert.equal(finger.payload.handTarget, 'indexTip');
  assert.equal(wrist.payload.handTarget, 'wrist');
  assert.ok(finger.payload.metrics.meanSpeed > 1);
  assert.equal(wrist.payload.metrics.meanSpeed, 0);
  assert.equal(wrist.payload.metrics.stillnessRatio, 1);
  assert.notEqual(finger.local.impression, wrist.local.impression);
  for (const name of ['fullBodyRatio', 'upperBodySpeed', 'lowerBodySpeed', 'torsoSpeed']) {
    assert.equal(finger.payload.metrics[name], undefined);
  }
  assert.match(finger.local.description, /검지 끝/);
  assert.match(wrist.local.description, /손목/);
  assert.match(finger.local.observations[0], /한 손의 검지 끝/);
  assert.match(finger.local.caveat, /한 손의 검지 끝 궤적만/);
  assert.doesNotMatch(JSON.stringify(finger.local), /어깨|하체|전신|발목|다리/);
});

test('hand payload keeps 21 observed joints and at most 60 samples without face or body data', () => {
  const input = handRecording('indexTip', 151, 66);
  for (const frame of input.poseFrames) {
    frame.joints.nose = [0.5, 0.1];
    frame.joints.leftShoulder = [0.4, 0.3];
  }
  delete input.poseFrames[0].joints.pinkyTip;
  const result = analyze(input);
  assert.equal(result.sufficient, true);
  assert.equal(result.payload.sampleCount, 151);
  assert.equal(result.payload.samples.length, 60);
  assert.equal(Object.keys(result.payload.samples.at(-1).hands[0].joints).length, 21);
  assert.equal(result.payload.samples[0].hands[0].joints.pinkyTip, undefined);
  assert.deepEqual(result.payload.samples.at(-1).hands[0].joints.indexTip,
    input.poseFrames.at(-1).joints.indexTip.map((v) => Math.round(v * 1e5) / 1e5));
  assert.ok(result.payload.samples.every((frame) =>
    !('nose' in frame.hands[0].joints) && !('leftShoulder' in frame.hands[0].joints)));
  assert.ok(Buffer.byteLength(JSON.stringify(result.payload), 'utf8') < 100 * 1024);
});

test('hand tracking gaps cannot create distance or coverage across separate strokes', () => {
  const input = handRecording();
  input.points = input.points.map((point, i) => ({
    ...point, x: i < 30 ? 0.1 : 0.9, y: i < 30 ? 0.1 : 0.9, stroke: i < 30 ? 1 : 2
  }));
  input.poseFrames = input.poseFrames.map((frame, i) => ({ ...frame, segment: i < 30 ? 1 : 2 }));
  const result = analyze(input);
  assert.equal(result.sufficient, true);
  assert.equal(result.payload.metrics.meanSpeed, 0);
  assert.equal(result.payload.metrics.pathLength, 0);
  assert.equal(result.payload.metrics.coverage, 0);
  assert.equal(result.payload.metrics.spread, 0);
  assert.equal(result.payload.metrics.directionChangeRate, 0);
  assert.equal(result.payload.metrics.trackedDurationMs, 2950);
  assert.equal(result.payload.samples[0].segment, 1);
  assert.equal(result.payload.samples.at(-1).segment, 2);
});

test('hand analysis needs actual hand observations and a continuous selected trace', () => {
  const input = handRecording();
  assert.equal(analyze({ ...input, poseFrames: [] }).sufficient, false);
  assert.equal(analyze({ ...input, points: [] }).sufficient, false);
  const invisible = input.poseFrames.map((frame) => {
    const { indexTip, ...joints } = frame.joints;
    return { ...frame, joints };
  });
  const result = analyze({ ...input, poseFrames: invisible });
  assert.equal(result.sufficient, false);
  assert.equal(result.payload.metrics.validFrameRatio, 0);
  assert.equal(result.payload.samples.length, 0);
  assert.match(result.local.description, /손을 화면 안에/);
  assert.doesNotMatch(result.local.description, /어깨|발끝|전신/);
  const defaultTarget = analyze({ ...input, handTarget: undefined });
  assert.equal(defaultTarget.payload.handTarget, 'indexTip');
});

function twoHands(position = (i) => [[0.2 + i * 0.005, 0.3], [0.6 + i * 0.005, 0.7]]) {
  const input = handRecording();
  input.poseFrames = input.poseFrames.map((frame, i) => ({
    t: frame.t, segment: 0,
    hands: position(i).map((point, n) => ({
      id: n + 1, joints: { ...frame.joints, indexTip: point }
    }))
  }));
  // New recordings use the actual selected joint of each observed hand; a
  // flattened array of alternating hand points must never be a velocity path.
  input.points = input.poseFrames.flatMap((frame) => frame.hands.map((hand) => ({
    t: frame.t, handId: hand.id, stroke: hand.id,
    x: hand.joints.indexTip[0], y: hand.joints.indexTip[1]
  })));
  return input;
}

test('two equally moving hands share elapsed time and retain independently sampled trails', () => {
  const input = twoHands();
  const both = analyze(input);
  const single = analyze({
    ...input, poseFrames: input.poseFrames.map((frame) => ({ ...frame, hands: frame.hands.slice(0, 1) }))
  });
  assert.equal(both.sufficient, true);
  assert.equal(single.sufficient, true);
  for (const name of ['meanSpeed', 'pathLength', 'trackedDurationMs', 'directionChangeRate']) {
    assert.equal(both.payload.metrics[name], single.payload.metrics[name], name);
  }
  assert.equal(both.payload.metrics.trackedDurationMs, 3000);
  assert.equal(both.payload.samples.length, 60);
  assert.deepEqual(both.payload.samples[0].hands.map((hand) => hand.id), [1, 2]);
  assert.match(both.local.caveat, /두 손의 검지 끝/);
  assert.match(single.local.caveat, /한 손의 검지 끝/);
});

test('opposite directions retain their relationship without cancellation or false speed spikes', () => {
  const parallel = analyze(twoHands());
  const opposed = analyze(twoHands((i) => [[0.2 + i * 0.005, 0.3], [0.8 - i * 0.005, 0.7]]));
  assert.equal(opposed.sufficient, true);
  assert.ok(opposed.payload.metrics.meanSpeed > 0);
  assert.equal(opposed.payload.metrics.meanSpeed, parallel.payload.metrics.meanSpeed);
  assert.equal(opposed.payload.metrics.directionChangeRate, 0);
  const first = opposed.payload.samples[0].hands;
  const last = opposed.payload.samples.at(-1).hands;
  assert.ok(last[0].joints.indexTip[0] > first[0].joints.indexTip[0]);
  assert.ok(last[1].joints.indexTip[0] < first[1].joints.indexTip[0]);
});

test('both-hand recordings measure the selected wrists instead of moving fingertips', () => {
  const input = twoHands();
  const fingertips = analyze(input);
  const wrists = analyze({ ...input, handTarget: 'wrist' });
  assert.equal(wrists.sufficient, true);
  assert.ok(fingertips.payload.metrics.meanSpeed > 0);
  assert.equal(wrists.payload.metrics.meanSpeed, 0);
  assert.equal(wrists.payload.metrics.stillnessRatio, 1);
  assert.match(wrists.local.caveat, /두 손의 손목/);
  assert.ok(wrists.payload.samples.every((frame) =>
    frame.hands.every((hand) => hand.joints.wrist && hand.joints.indexTip)));
});

test('one moving hand remains measurable beside a stationary hand', () => {
  const moving = analyze(twoHands((i) => [[0.1 + i * 0.01, 0.3]]));
  const contrast = analyze(twoHands((i) => [[0.1 + i * 0.01, 0.3], [0.8, 0.7]]));
  assert.ok(contrast.payload.metrics.meanSpeed > 0);
  assert.ok(Math.abs(contrast.payload.metrics.meanSpeed * 2 - moving.payload.metrics.meanSpeed) < 0.00002);
  assert.equal(contrast.payload.metrics.peakSpeed, moving.payload.metrics.peakSpeed);
  assert.equal(contrast.payload.metrics.trackedDurationMs, moving.payload.metrics.trackedDurationMs);
  assert.equal(contrast.payload.metrics.stillnessRatio, 0);
});

test('array order, lost hands and new IDs never connect one hand to another', () => {
  const input = twoHands(() => [[0.1, 0.1], [0.9, 0.9]]);
  input.poseFrames = input.poseFrames.map((frame, i) => ({
    ...frame,
    hands: i === 30 ? [frame.hands[1]] : frame.hands.map((hand) => (
      hand.id === 1 && i > 30 ? { ...hand, id: 3, joints: { ...hand.joints, indexTip: [0.3, 0.3] } } : hand
    )).sort((a, b) => i % 2 ? b.id - a.id : a.id - b.id)
  }));
  const result = analyze(input);
  assert.equal(result.sufficient, true);
  for (const name of ['meanSpeed', 'peakSpeed', 'pathLength', 'coverage', 'spread', 'directionChangeRate']) {
    assert.equal(result.payload.metrics[name], 0, name);
  }
  assert.equal(result.payload.metrics.trackedDurationMs, 3000, 'the remaining visible hand stays continuous');
  assert.ok(result.payload.samples.some((frame) => frame.hands.some((hand) => hand.id === 3)));
});

test('missing-hand frames and pause segments break only valid hand continuity', () => {
  const input = twoHands(() => [[0.1, 0.1]]);
  input.poseFrames = input.poseFrames.map((frame, i) => ({
    ...frame,
    segment: i < 45 ? 0 : 1,
    hands: i === 30 ? [] : frame.hands.map((hand) => ({
      ...hand, joints: { ...hand.joints, indexTip: i > 45 ? [0.9, 0.9] : i > 30 ? [0.5, 0.5] : [0.1, 0.1] }
    }))
  }));
  // Relocate at the segment boundary itself, never one sample after it.
  input.poseFrames[45].hands[0].joints.indexTip = [0.9, 0.9];
  const result = analyze(input);
  assert.equal(result.sufficient, true);
  assert.equal(result.payload.metrics.meanSpeed, 0);
  assert.equal(result.payload.metrics.coverage, 0);
  assert.equal(result.payload.metrics.trackedDurationMs, 2850);
  assert.equal(result.payload.metrics.validFrameRatio, 0.98361);
  assert.equal(result.payload.sampleCount, 60);
  assert.ok(result.payload.samples.every((frame) => frame.hands.length === 1));
});

test('new hand frames require enough actual observations and reject invalid or duplicated tracks', () => {
  const input = twoHands();
  const missingTarget = input.poseFrames.map((frame) => ({
    ...frame, hands: frame.hands.map((hand) => {
      const { indexTip, ...joints } = hand.joints;
      return { ...hand, joints };
    })
  }));
  assert.equal(analyze({ ...input, poseFrames: missingTarget }).sufficient, false);
  const neverContinuous = input.poseFrames.map((frame, i) => ({
    ...frame, hands: frame.hands.map((hand) => ({ ...hand, id: i * 2 + hand.id }))
  }));
  assert.equal(analyze({ ...input, poseFrames: neverContinuous }).sufficient, false);
  const duplicated = input.poseFrames.map((frame) => ({
    ...frame, hands: [
      { ...frame.hands[0], id: -1 },
      frame.hands[0], frame.hands[0],
      { ...frame.hands[1], joints: { ...frame.hands[1].joints, nose: [0.4, 0.2] } }
    ]
  }));
  const sanitized = analyze({ ...input, poseFrames: duplicated }).payload;
  assert.ok(sanitized.samples.every((frame) =>
    frame.hands.length === 2 && frame.hands[0].id !== frame.hands[1].id &&
    frame.hands.every((hand) => !('nose' in hand.joints))));
});

test('footwork changes the impression when the upper body stays still', () => {
  const still = webcam(fullBodySeries());
  const steps = webcam(fullBodySeries((i) => ({
    leftAnkle: [0.43 + 0.14 * Math.sin(i * 0.8), 0.86],
    rightAnkle: [0.57 - 0.14 * Math.sin(i * 0.8), 0.86]
  })));
  assert.equal(still.sufficient, true);
  assert.equal(still.payload.metrics.fullBodyRatio, 1);
  assert.equal(still.payload.metrics.coverage, 0, 'standing height is not motion coverage');
  assert.equal(steps.payload.metrics.upperBodySpeed, 0);
  assert.ok(steps.payload.metrics.lowerBodySpeed > 0.8);
  assert.equal(steps.payload.metrics.meanSpeed, steps.payload.metrics.lowerBodySpeed);
  assert.ok(steps.payload.metrics.pathLength > 2);
  assert.ok(steps.payload.metrics.stillnessRatio < 0.1);
  assert.notEqual(steps.local.impression, still.local.impression);
  assert.ok(steps.local.observations.some((item) => /하체/.test(item)));
  assert.equal(steps.local.qualities.length, 3);
  assert.ok(!/[0-9%]|방향 전환율|평균 속도|정지 비율/.test(steps.local.description));
});

test('knees and elbows remain measurable when wrists and ankles are stationary', () => {
  const knee = webcam(fullBodySeries((i) => ({
    leftKnee: [0.43 + 0.1 * Math.sin(i * 0.5), 0.7],
    rightKnee: [0.57 - 0.1 * Math.sin(i * 0.5), 0.7]
  })));
  const elbow = webcam(fullBodySeries((i) => ({
    leftElbow: [0.3, 0.35 + 0.1 * Math.sin(i * 0.5)],
    rightElbow: [0.7, 0.35 - 0.1 * Math.sin(i * 0.5)]
  })));
  assert.ok(knee.payload.metrics.lowerBodySpeed > 0.4);
  assert.equal(knee.payload.metrics.upperBodySpeed, 0);
  assert.ok(elbow.payload.metrics.upperBodySpeed > 0.4);
  assert.equal(elbow.payload.metrics.lowerBodySpeed, 0);
});

test('22 non-face body joints survive sampling; faces and inferred joints never enter the payload', () => {
  const frames = fullBodySeries((i) => ({
    nose: [0.5, 0.1], leftEye: [0.48, 0.08],
    leftAnkle: [0.43 + 0.05 * Math.sin(i), 0.9]
  }), 151, 66);
  delete frames[0].joints.leftHeel;
  const report = webcam(frames, 10000);
  assert.equal(report.payload.samples[0].joints.leftHeel, undefined);
  assert.equal(Object.keys(report.payload.samples.at(-1).joints).length, 22);
  assert.ok(report.payload.samples.every((sample) => !('nose' in sample.joints) && !('leftEye' in sample.joints)));
  assert.ok(Buffer.byteLength(JSON.stringify(report.payload), 'utf8') < 100 * 1024);
});

test('full-body tracking gaps do not create foot speed, travel area, or turns', () => {
  const frames = fullBodySeries(() => ({}), 21);
  const relocated = fullBodySeries(() => ({
    leftAnkle: [0.1, 0.1], rightAnkle: [0.9, 0.1]
  }), 21).map((frame) => ({ ...frame, t: frame.t + 1050, segment: 1 }));
  const result = webcam([...frames, ...relocated], 2050);
  assert.equal(result.payload.metrics.meanSpeed, 0);
  assert.equal(result.payload.metrics.lowerBodySpeed, 0);
  assert.equal(result.payload.metrics.coverage, 0);
  assert.equal(result.payload.metrics.directionChangeRate, 0);
  assert.equal(result.payload.metrics.trackedDurationMs, 2000);
});

test('missing lower-body joints are not invented and reduce full-body coverage', () => {
  const frames = fullBodySeries().map((frame, i) => {
    const { leftAnkle, rightAnkle, ...partial } = frame.joints;
    return i < 30 ? frame : { ...frame, joints: partial };
  });
  const report = webcam(frames);
  assert.equal(report.payload.metrics.fullBodyRatio, 0.4918);
  assert.equal(report.payload.samples.at(-1).joints.leftAnkle, undefined);
  assert.equal(report.payload.metrics.meanSpeed, 0);
  assert.ok(report.local.observations.some((item) => /일부만/.test(item)));
});

test('local impressions use expressive adjectives while synthetic examples stay identified', () => {
  const result = analyze({
    source: 'example', durationMs: 3000,
    points: pointSeries((i) => ({ x: 0.5 + 0.3 * Math.sin(i * 0.1), y: 0.5 + 0.3 * Math.cos(i * 0.1) }))
  });
  assert.match(result.local.description, /합성 예시/);
  assert.ok(['유연한', '빠른', '차분한', '경쾌한', '날카로운', '머뭇거리는', '초조한'].includes(result.local.impression));
  assert.equal(result.local.qualities.length, 3);
  assert.match(result.local.caveat, /간단한 규칙/);
});

test('distinguishes stationary wrists from energetic motion using measured features', () => {
  const still = webcam(poseSeries(() => [0.3, 0.5]));
  const energetic = webcam(poseSeries((i) => [
    0.5 + 0.4 * Math.sin(i * 0.65), 0.5 + 0.35 * Math.cos(i * 0.65)
  ]));
  assert.equal(still.sufficient, true);
  assert.equal(energetic.sufficient, true);
  assert.equal(still.payload.metrics.meanSpeed, 0);
  assert.equal(still.payload.metrics.stillnessRatio, 1);
  assert.ok(energetic.payload.metrics.meanSpeed > 1);
  assert.ok(energetic.payload.metrics.coverage > 0.4);
  assert.ok(energetic.payload.metrics.stillnessRatio < 0.1);
  assert.notEqual(still.local.impression, energetic.local.impression);
  assert.match(energetic.local.caveat, /실제 감정이나 의도를 판단한 결과가 아닙니다/);
});

test('does not create movement across new strokes or unobserved pauses', () => {
  const points = [
    ...pointSeries(() => ({ x: 0.1, y: 0.1 }), 21),
    ...pointSeries(() => ({ x: 0.9, y: 0.9 }), 21).map((point) => ({ ...point, t: point.t + 1100, stroke: 2 })),
    { x: 0, y: 1, t: 2900, stroke: 2 },
    { x: 0, y: 1, t: 2950, stroke: 2 }
  ];
  const result = pointer(points);
  assert.equal(result.payload.metrics.meanSpeed, 0);
  assert.equal(result.payload.metrics.peakSpeed, 0);
  assert.equal(result.payload.metrics.pathLength, 0);
  assert.equal(result.payload.metrics.directionChangeRate, 0);
  assert.equal(result.payload.metrics.trackedDurationMs, 2050);
});

test('missing webcam joints break that joint’s velocity chain and long gaps are excluded', () => {
  const frames = [
    { t: 0, joints: { leftWrist: [0, 0] } },
    { t: 50, joints: { leftWrist: [0, 0] } },
    { t: 100, joints: {} },
    { t: 150, joints: { leftWrist: [1, 1] } },
    { t: 200, joints: { leftWrist: [1, 1] } },
    { t: 800, joints: { leftWrist: [0, 0] } },
    { t: 850, joints: { leftWrist: [0, 0] } }
  ];
  const result = webcam(frames);
  assert.equal(result.payload.metrics.meanSpeed, 0);
  assert.equal(result.payload.metrics.pathLength, 0);
  assert.equal(result.payload.metrics.trackedDurationMs, 150);
  assert.equal(result.sufficient, false);
});

test('webcam pauses break continuity even when paused time is removed from timestamps', () => {
  const frames = [
    ...poseSeries(() => [0.1, 0.1], 21).map((frame) => ({ ...frame, segment: 1 })),
    ...poseSeries(() => [0.9, 0.9], 21).map((frame) => ({ ...frame, t: frame.t + 1050, segment: 2 }))
  ];
  const result = webcam(frames, 2050);
  assert.equal(result.sufficient, true);
  assert.equal(result.payload.metrics.meanSpeed, 0);
  assert.equal(result.payload.metrics.peakSpeed, 0);
  assert.equal(result.payload.metrics.pathLength, 0);
  assert.equal(result.payload.metrics.directionChangeRate, 0);
  assert.equal(result.payload.metrics.trackedDurationMs, 2000);
  assert.deepEqual(result.payload.samples.map((sample) => sample.segment), frames.map((frame) => frame.segment - 1));
  assert.equal(frames[0].segment, 1); // Transport IDs never mutate recording IDs.
});

test('missing or invalid webcam segments default to zero and valid boundaries survive sampling', () => {
  const frames = poseSeries((i) => [i / 100, 0.5], 101).map((frame, i) => ({
    ...frame, segment: i < 50 ? 1 : 2
  }));
  const samples = webcam(frames, 5000).payload.samples;
  assert.equal(samples[0].segment, 0);
  assert.equal(samples.at(-1).segment, 1);
  const malformed = webcam([
    { t: 0, joints: {}, segment: -1 },
    { t: 50, joints: {}, segment: 1.5 },
    { t: 100, joints: {} }
  ]);
  assert.deepEqual(malformed.payload.samples.map((sample) => sample.segment), [0, 0, 0]);
});

test('adding a second hand with the same speed does not double speed or tracked time', () => {
  const frames = poseSeries((i) => [0.1 + i * 0.005, 0.5]);
  const oneHand = frames.map((frame) => ({ t: frame.t, joints: { leftWrist: frame.joints.leftWrist } }));
  const both = webcam(frames).payload.metrics;
  const one = webcam(oneHand).payload.metrics;
  assert.equal(both.meanSpeed, one.meanSpeed);
  assert.equal(both.pathLength, one.pathLength);
  assert.equal(both.trackedDurationMs, one.trackedDurationMs);
});

test('rejects insufficient duration, frame count, or disconnected samples', () => {
  assert.equal(pointer(pointSeries(() => ({ x: 0.5, y: 0.5 }), 19)).sufficient, false);
  assert.equal(pointer(pointSeries(() => ({ x: 0.5, y: 0.5 }), 7, 200)).sufficient, false);
  assert.equal(pointer(pointSeries(() => ({ x: 0.5, y: 0.5 }), 8, 400)).sufficient, false);
  assert.equal(pointer(pointSeries(() => ({ x: 0.5, y: 0.5 }), 21)).sufficient, true);
});

test('keeps time-distributed original samples, endpoints, joints, and stroke boundaries', () => {
  const points = pointSeries((i) => ({ x: (i % 101) / 100, y: 0.5 }), 1001, 10)
    .map((point, i) => ({ ...point, stroke: i < 500 ? 1 : 2 }));
  const result = pointer(points, 10000);
  assert.equal(result.payload.sampleCount, 1001);
  assert.equal(result.payload.samples.length, 60);
  assert.deepEqual(result.payload.samples[0], points[0]);
  assert.deepEqual(result.payload.samples.at(-1), points.at(-1));
  for (const sample of result.payload.samples) assert.deepEqual(sample, points[sample.t / 10]);
  assert.ok(result.payload.samples.some((sample) => sample.stroke === 1));
  assert.ok(result.payload.samples.some((sample) => sample.stroke === 2));
  const frames = poseSeries((i) => [i / 100, 0.5], 101);
  const pose = webcam(frames, 5000);
  assert.equal(pose.payload.samples.length, 80);
  assert.deepEqual(pose.payload.samples.at(-1), frames.at(-1));
});

test('malformed input never leaks non-finite metrics or unbounded normalized coordinates', () => {
  const malformed = analyze({
    source: 'webcam',
    durationMs: 20000,
    captureAspect: Infinity,
    poseFrames: [
      { t: -1, joints: { leftWrist: [0, 0] } },
      { t: 0, joints: { leftWrist: [-1, 2], rightWrist: [NaN, Infinity] } },
      { t: 50, joints: { leftWrist: [NaN, 0.5] } },
      { t: 10000, joints: { leftWrist: [1, 1] } },
      { t: 10001, joints: { leftWrist: [1, 1] } },
      { t: Infinity, joints: {} },
      null
    ]
  });
  assert.equal(malformed.payload.durationMs, 10000);
  assert.equal(malformed.payload.sampleCount, 3);
  assert.deepEqual(malformed.payload.samples[0].joints, { leftWrist: [0, 1] });
  for (const value of Object.values(malformed.payload.metrics)) assert.ok(Number.isFinite(value));
  assert.doesNotThrow(() => JSON.stringify(malformed));
  assert.equal(analyze().sufficient, false);
  assert.equal(analyze({ points: 'invalid' }).sufficient, false);
});

test('sampling follows time even with dense duplicate timestamps and preserves duration bounds', () => {
  const dense = [
    ...pointSeries(() => ({ x: 0.1, y: 0.1 }), 100, 0),
    ...pointSeries(() => ({ x: 0.9, y: 0.9 }), 101, 100)
  ];
  const samples = pointer(dense, 10000).payload.samples;
  assert.ok(samples.length >= 58);
  assert.ok(samples.some((sample) => sample.t >= 4900 && sample.t <= 5100));
  const durationMs = 1000.0006;
  const bounded = pointer([{ t: durationMs, x: 0.5, y: 0.5, stroke: 1 }], durationMs);
  assert.ok(bounded.payload.samples[0].t <= durationMs);
});

test('turns and tempo changes are measured independently of path coverage', () => {
  const steady = pointer(pointSeries((i) => ({ x: 0.2 + i * 0.005, y: 0.5 })));
  const switching = pointer(pointSeries((i) => ({
    x: 0.5 + (i % 4 < 2 ? -0.1 : 0.1), y: 0.5
  })));
  assert.equal(steady.payload.metrics.directionChangeRate, 0);
  assert.equal(steady.payload.metrics.tempoVariation, 0);
  assert.ok(switching.payload.metrics.tempoVariation > 0.8);
  const zigzag = pointer(pointSeries((i) => ({ x: i % 2 ? 0.7 : 0.3, y: 0.5 })));
  assert.ok(zigzag.payload.metrics.directionChangeRate > 10);
});


test('body sampling retains up to 80 measured frames while hand sampling stays at 60', () => {
  const frames = fullBodySeries(() => ({}), 151, 66);
  const body = webcam(frames, 10000);
  assert.equal(body.payload.samples.length, 80);
  assert.deepEqual(body.payload.samples[0], frames[0]);
  assert.deepEqual(body.payload.samples.at(-1), frames.at(-1));
  assert.equal(analyze(handRecording('indexTip', 151, 66)).payload.samples.length, 60);
});

test('full 22-joint world recordings fit the 100 KiB API cap without losing coordinates or segments', () => {
  const frames = fullBodySeries(() => ({}), 151, 66).map((frame, i) => {
    const joints = Object.fromEntries(Object.keys(frame.joints).map(name => [name, [0.12345, 0.67891]]));
    const worldJoints = Object.fromEntries(Object.keys(joints).map(name =>
      [name, [-19.12345, -18.23456, -17.34567]]));
    return { ...frame, joints, worldJoints, segment: i < 75 ? 0 : 1 };
  });
  // A deliberately large, fully populated transport fixture; never a recording.
  delete frames[0].joints.leftHeel;
  delete frames[0].worldJoints.leftHeel;
  const report = webcam(frames, 10000);
  const { samples } = report.payload;
  assert.ok(samples.length > 40 && samples.length < 80);
  assert.ok(Buffer.byteLength(JSON.stringify(report.payload), 'utf8') <= 100 * 1024);
  assert.equal(report.payload.sampleCount, frames.length);
  assert.deepEqual(samples[0], frames[0]);
  assert.deepEqual({ ...samples.at(-1), segment: frames.at(-1).segment }, frames.at(-1));
  assert.ok(samples.some(frame => frame.segment === 0));
  assert.ok(samples.some(frame => frame.segment === 1));
  for (const sample of samples) {
    const original = frames.find(frame => frame.t === sample.t);
    assert.deepEqual({ ...sample, segment: original.segment }, original);
  }
});


test('body thinning preserves an occlusion or pause even when that exact frame is skipped', () => {
  for (const kind of ['screen', 'world', 'pause']) {
    const frames = fullBodySeries(() => ({}), 151, 66).map(frame => ({
      ...frame, worldJoints: { leftAnkle: [0.1, 0.8, 0.1] }
    }));
    if (kind === 'screen') delete frames[75].joints.leftAnkle;
    if (kind === 'world') delete frames[75].worldJoints.leftAnkle;
    if (kind === 'pause') frames[75].segment = 1;
    const samples = webcam(frames, 10000).payload.samples;
    assert.equal(samples.length, 80);
    assert.ok(!samples.some(frame => frame.t === frames[75].t));
    const before = samples.filter(frame => frame.t < frames[75].t).at(-1);
    const after = samples.find(frame => frame.t > frames[75].t);
    assert.notEqual(before.segment, after.segment, kind);
    assert.equal(frames.at(-1).segment, 0);
    assert.ok(samples.every(frame => frame.segment <= 10000));
  }
});

test('body transport retains long gaps as separate measured runs', () => {
  const frames = fullBodySeries(() => ({}), 121, 75).map((frame, i) => ({
    ...frame, t: frame.t + (i >= 60 ? 500 : 0)
  }));
  const samples = webcam(frames, 10000).payload.samples;
  const before = samples.filter(frame => frame.t < frames[60].t).at(-1);
  const after = samples.find(frame => frame.t >= frames[60].t);
  assert.notEqual(before.segment, after.segment);
  assert.equal(frames[60].segment, 0);
});


test('optional finger and heel visibility does not fragment a valid full-body run', () => {
  const frames = fullBodySeries(() => ({}), 151, 66).map(frame => ({
    ...frame, worldJoints: Object.fromEntries(Object.keys(frame.joints).map(name => [name, [0.1, 0.2, 0.3]]))
  }));
  for (const name of ['leftPinky', 'leftHeel']) {
    delete frames[76].joints[name];
    delete frames[76].worldJoints[name];
  }
  const samples = webcam(frames, 10000).payload.samples;
  const missing = samples.find(frame => frame.t === frames[76].t);
  assert.ok(missing);
  assert.equal(missing.joints.leftPinky, undefined);
  assert.equal(missing.worldJoints.leftHeel, undefined);
  assert.ok(samples.every(frame => frame.segment === 0));
  assert.equal(samples[0].joints.leftPinky.length, 2);
  assert.equal(samples.at(-1).worldJoints.leftHeel.length, 3);
});
