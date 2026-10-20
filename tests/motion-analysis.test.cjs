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
  assert.deepEqual(result.payload.samples.map((sample) => sample.segment), frames.map((frame) => frame.segment));
});

test('missing or invalid webcam segments default to zero and valid values survive sampling', () => {
  const frames = poseSeries((i) => [i / 100, 0.5], 101).map((frame, i) => ({
    ...frame, segment: i < 50 ? 1 : 2
  }));
  const samples = webcam(frames, 5000).payload.samples;
  assert.equal(samples[0].segment, 1);
  assert.equal(samples.at(-1).segment, 2);
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
  assert.equal(pose.payload.samples.length, 60);
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
