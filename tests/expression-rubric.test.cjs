const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../api/expression-rubric.mjs');
const handlerPromise = import('../api/handler.mjs');

function handArc({ durationMs = 3000, id = 1 } = {}) {
  const samples = Array.from({ length: 31 }, (_, i) => ({
    t: i * durationMs / 30, segment: 0,
    hands: [{ id, joints: {
      wrist: [0.5 + 0.4 * Math.cos(i / 30 * Math.PI / 2), 0.5 + 0.4 * Math.sin(i / 30 * Math.PI / 2)],
      indexTip: [0.5, 0.5],
    } }],
  }));
  return { source: 'hand', handTarget: 'wrist', durationMs, sampleCount: 31, metrics: {}, samples };
}

function bodyBend({ low = 90, high = 175, durationMs = 4000, count = 41, cycles = 1 } = {}) {
  return {
    source: 'webcam', captureAspect: 1, durationMs, sampleCount: count, metrics: {},
    samples: Array.from({ length: count }, (_, i) => {
      const angle = (low + high) / 2 + (high - low) / 2 * Math.cos(i / (count - 1) * Math.PI * 2 * cycles);
      const theta = (180 - angle) * Math.PI / 180;
      return { t: i * durationMs / (count - 1), segment: 0, joints: {
        leftShoulder: [0.3, 0.4], leftElbow: [0.5, 0.4],
        leftWrist: [0.5 + 0.2 * Math.cos(theta), 0.4 + 0.2 * Math.sin(theta)],
      } };
    }),
  };
}

test('all 50 allowed expressions have distinct concise visual definitions without forced diversity', async () => {
  const { VISUAL_DEFINITIONS, evaluateExpressionRubric } = await modulePromise;
  const { DANCE_VOCABULARY } = await import('../api/dance-vocabulary.mjs');
  assert.deepEqual(Object.keys(VISUAL_DEFINITIONS).sort(), DANCE_VOCABULARY.map(item => item.label).sort());
  assert.equal(new Set(Object.values(VISUAL_DEFINITIONS)).size, 50);
  assert.ok(Object.values(VISUAL_DEFINITIONS).every(text => text.length > 4 && text.length < 50));
  assert.deepEqual(evaluateExpressionRubric(handArc()), evaluateExpressionRubric(handArc()));
});

test('a smooth hand curve is never evidence of bodily flexibility, even with fabricated client metrics', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  for (const source of ['hand', 'pointer', 'example']) {
    const data = handArc();
    if (source !== 'hand') {
      data.samples = data.samples.map(frame => ({
        t: frame.t, x: frame.hands[0].joints.wrist[0], y: frame.hands[0].joints.wrist[1], stroke: 0,
      }));
      data.source = source;
      delete data.handTarget;
    }
    data.metrics = { meanSpeed: 0.12, directionChangeRate: 0, fullBodyRatio: 1 };
    const rubric = evaluateExpressionRubric(data);
    assert.equal(rubric.eligible['유연한'], false);
    assert.equal(rubric.eligible['유려한'], true);
    assert.equal(rubric.metrics.flexAngleRangeDeg, null);
  }
});

test('flow requires sufficient continuous duration, movement and speed stability', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  assert.equal(evaluateExpressionRubric(handArc({ durationMs: 2500 })).eligible['유려한'], true);
  assert.equal(evaluateExpressionRubric(handArc({ durationMs: 2499 })).eligible['유려한'], false);
  for (const change of [
    data => data.samples.forEach(frame => { frame.hands[0].joints.wrist = [0.5, 0.5]; }),
    data => data.samples.forEach((frame, i) => { frame.hands[0].joints.wrist = [0.2 + i * 0.001, 0.5]; }),
    data => data.samples.forEach((frame, i) => { frame.hands[0].joints.wrist = [0.2 + Math.floor(i / 2) * 0.03 + i % 2 * 0.005, 0.5]; }),
    data => data.samples.forEach((frame, i) => { if (i < 16) frame.hands[0].joints.wrist = [0.5, 0.5]; }),
    data => { data.durationMs = 10000; },
  ]) {
    const data = handArc();
    change(data);
    assert.equal(evaluateExpressionRubric(data).eligible['유려한'], false);
  }
});

test('the tightened direction gate separates small turns from sharp turns at the same speed', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  for (const [halfTurn, expected] of [[12, true], [13, false]]) {
    const data = handArc();
    let x = 0.2, y = 0.5;
    data.samples.forEach((frame, i) => {
      if (i) {
        const angle = (i % 2 ? halfTurn : -halfTurn) * Math.PI / 180;
        x += Math.cos(angle) * Math.SQRT2 * 0.01;
        y += Math.sin(angle) * Math.SQRT2 * 0.01;
      }
      frame.hands[0].joints.wrist = [x, y];
    });
    const result = evaluateExpressionRubric(data);
    assert.equal(result.eligible['유려한'], expected);
    assert.ok(Math.abs(result.metrics.maxTurnDeg - halfTurn * 2) < 0.001);
  }
});

test('hand loss, ID changes, pauses and time gaps never create a long smooth run', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  for (const change of [
    data => data.samples.forEach((frame, i) => { if (i > 15) frame.segment = 1; }),
    data => data.samples.forEach((frame, i) => { if (i > 15) frame.hands[0].id = 2; }),
    data => { data.samples[15].hands[0].id = 2; },
    data => { data.samples.forEach((frame, i) => { if (i > 15) frame.t += 300; }); data.durationMs += 300; },
  ]) {
    const data = handArc();
    change(data);
    assert.equal(evaluateExpressionRubric(data).eligible['유려한'], false);
  }
});

test('flexibility requires directly observed smooth bending and extension, not whole-body translation', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  const observed = evaluateExpressionRubric(bodyBend());
  assert.equal(observed.eligible['유연한'], true);
  assert.ok(observed.metrics.flexAngleRangeDeg >= 80);
  assert.ok(observed.metrics.flexBendTravelDeg >= 80);
  assert.ok(observed.metrics.flexExtendTravelDeg >= 80);
  assert.equal(evaluateExpressionRubric(bodyBend({ low: 115, high: 160 })).eligible['유연한'], true);
  assert.equal(evaluateExpressionRubric(bodyBend({ low: 115.1, high: 160 })).eligible['유연한'], false);
  const translating = bodyBend({ low: 100, high: 100 });
  translating.samples.forEach((frame, i) => {
    Object.values(frame.joints).forEach(point => { point[0] += 0.1 * Math.sin(i / 10); point[1] += i / 300; });
  });
  assert.equal(evaluateExpressionRubric(translating).eligible['유연한'], false);
});

test('missing joints, abrupt angle changes and isolated pose snapshots do not qualify as flexibility', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  for (const change of [
    data => data.samples.forEach(frame => { delete frame.joints.leftElbow; }),
    data => data.samples.forEach((frame, i) => { frame.segment = Math.floor(i / 10); }),
    data => data.samples.forEach((frame, i) => {
      const theta = (i % 2 ? 90 : 5) * Math.PI / 180;
      frame.joints.leftWrist = [0.5 + 0.2 * Math.cos(theta), 0.4 + 0.2 * Math.sin(theta)];
    }),
    data => { data.samples = [data.samples[0], data.samples[20], data.samples[40]]; },
    data => data.samples.forEach(frame => { frame.joints.leftElbow = [...frame.joints.leftShoulder]; }),
  ]) {
    const data = bodyBend();
    change(data);
    const result = evaluateExpressionRubric(data);
    assert.equal(result.eligible['유연한'], false);
    assert.ok(Object.values(result.metrics).every(value => value === null || Number.isFinite(value)));
  }
});

test('camera aspect correction preserves observed joint angles for widescreen and portrait recordings', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  const reference = evaluateExpressionRubric(bodyBend());
  for (const captureAspect of [16 / 9, 9 / 16]) {
    const data = bodyBend();
    data.captureAspect = captureAspect;
    data.samples.forEach(frame => Object.values(frame.joints).forEach(point => {
      point[0] = 0.5 + (point[0] - 0.5) / captureAspect;
    }));
    const actual = evaluateExpressionRubric(data);
    assert.equal(actual.eligible['유연한'], true);
    assert.equal(actual.metrics.flexAngleRangeDeg, reference.metrics.flexAngleRangeDeg);
    assert.equal(actual.metrics.flexMinAngleDeg, reference.metrics.flexMinAngleDeg);
    assert.equal(actual.metrics.flexMaxAngleDeg, reference.metrics.flexMaxAngleDeg);
    assert.ok(data.samples.every(frame => Object.values(frame.joints).every(point => point[0] >= 0 && point[0] <= 1)));
  }
  const legacy = bodyBend();
  delete legacy.captureAspect;
  const unknown = evaluateExpressionRubric(legacy);
  assert.equal(unknown.eligible['유연한'], false);
  assert.equal(unknown.metrics.captureAspect, null);
  assert.equal(unknown.metrics.flexAngleRangeDeg, null);
  assert.match(unknown.note, /영상 비율이 없어/);
});

test('normal 60-frame recordings remain continuous while pause boundaries split bending evidence', async () => {
  const { evaluateExpressionRubric } = await modulePromise;
  const data = bodyBend({ count: 60, durationMs: 10000, cycles: 2 });
  assert.equal(evaluateExpressionRubric(data).eligible['유연한'], true);
  data.samples.forEach((frame, i) => { frame.segment = Math.floor(i / 6); });
  assert.equal(evaluateExpressionRubric(data).eligible['유연한'], false);
});

test('request schemas enforce the same gates across representative, qualities and candidates', async () => {
  const { buildAnalysisRequest } = await handlerPromise;
  for (const [motion, eligibleFlex, eligibleFlow] of [
    [handArc(), false, true], [bodyBend(), true, false], [handArc({ durationMs: 1000 }), false, false],
  ]) {
    const request = buildAnalysisRequest(motion);
    const properties = request.generationConfig.responseSchema.properties;
    for (const labels of [properties.impression.enum, properties.qualities.items.enum, properties.candidates.items.properties.label.enum]) {
      assert.equal(labels.includes('유연한'), eligibleFlex);
      assert.equal(labels.includes('유려한'), eligibleFlow);
      assert.equal(labels.length, 47 + Number(eligibleFlex) + Number(eligibleFlow) + Number(properties.impression.enum.includes('역동적인')));
    }
  }
});
