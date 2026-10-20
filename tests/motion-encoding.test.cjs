const test = require('node:test');
const assert = require('node:assert/strict');

const encoding = import('../api/motion-encoding.mjs');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const handJoints = ['wrist', 'indexTip', 'thumbTip', 'middleTip', 'ringTip', 'pinkyTip', 'indexMcp'];
const bodyJoints = [
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftPinky', 'rightPinky', 'leftIndex', 'rightIndex', 'leftThumb', 'rightThumb',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
  'leftHeel', 'rightHeel', 'leftFootIndex', 'rightFootIndex',
];
const fixed = value => Math.round(value * 1000) / 1000;

// Independent decoder uses the declared column names rather than hardcoding the
// encoder's property access. It verifies the complete provider-visible meaning.
function decodeMotion(value) {
  const scale = value.coordinateScale;
  const rowObject = (columns, row) => Object.fromEntries(columns.map((name, index) => [name, row[index]]));
  const joints = positions => Object.fromEntries(value.jointNames.flatMap((name, index) =>
    positions[index] === null ? [] : [[name, positions[index].map(point => point / scale)]]
  ));
  return {
    source: value.source,
    ...(value.source === 'hand' ? {handTarget:value.handTarget} : {}),
    durationMs: value.durationMs,
    sampleCount: value.sampleCount,
    metrics: value.metrics,
    samples: value.rows.map(row => {
      const frame = rowObject(value.columns, row);
      const base = {t:frame.t, ...(frame.breakBefore ? {breakBefore:true} : {})};
      if (value.source === 'hand') {
        return {
          ...base, segment:frame.segment,
          hands:frame.hands.map(handRow => {
            const hand = rowObject(value.handColumns, handRow);
            return {
              id:hand.id, joints:joints(hand.positions),
              ...(hand.breakBefore ? {breakBefore:true} : {}),
            };
          }),
        };
      }
      if (value.source === 'webcam') return {...base, segment:frame.segment, joints:joints(frame.positions)};
      return {...base, x:frame.x / scale, y:frame.y / scale, stroke:frame.stroke};
    }),
  };
}

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function denseHandMotion() {
  return {
    source:'hand', handTarget:'indexTip', durationMs:10000, sampleCount:150,
    metrics:{meanSpeed:1.234, pathLength:8.321, directionChanges:47, stillnessRatio:0.012},
    samples:Array.from({length:24}, (_, index) => ({
      t:fixed(index * 10000 / 23),
      segment:index < 12 ? 1 : 2,
      ...(index === 12 ? {breakBefore:true} : {}),
      hands:(index % 2 ? [22,11] : [11,22]).map(id => ({
        id,
        joints:Object.fromEntries(handJoints.map((name, joint) => [name, [
          fixed((Math.sin(index * 1.13 + joint * 0.37 + id) + 1) / 2),
          fixed((Math.cos(index * 0.73 - joint * 0.19 - id) + 1) / 2),
        ]])),
      })),
    })),
  };
}

test('dense two-hand motion round-trips every frame, joint, timestamp, ID and metadata', async () => {
  const {encodeMotion, ENCODING_GUIDE} = await encoding;
  const source = frozen(denseHandMotion());
  const encoded = encodeMotion(source);
  assert.deepEqual(decodeMotion(JSON.parse(JSON.stringify(encoded))), source);
  assert.equal(encoded.rows.length, 24);
  assert.equal(encoded.sampleCount, 150, 'Original recorded count is distinct from transmitted row count');
  assert.deepEqual(encoded.jointNames, handJoints);
  assert.match(ENCODING_GUIDE, /null은 미관측/);
  assert.match(ENCODING_GUIDE, /밀리초/);
  assert.ok(encoded.rows.every(row => row[3].every(hand =>
    hand[2].every(point => point.every(axis => Number.isInteger(axis) && axis >= 0 && axis <= 1000))
  )));
});

test('independent hand loss, reacquisition, array order and both kinds of break flags are unchanged', async () => {
  const {encodeMotion} = await encoding;
  const source = {
    source:'hand', handTarget:'wrist', durationMs:1480.125, sampleCount:20, metrics:{meanSpeed:0.2},
    samples:[
      {t:0, segment:0, hands:[
        {id:17,joints:{wrist:[0,0],indexTip:[0.123,0.456]}},
        {id:29,joints:{wrist:[1,1],indexTip:[0.987,0.654]}}
      ]},
      {t:75.125, segment:0, hands:[{id:29,joints:{wrist:[0.9,0.8]}}]},
      {t:300.25, segment:0, hands:[
        {id:29,joints:{wrist:[0.85,0.75]}},
        {id:31,breakBefore:true,joints:{wrist:[0.1,0.2],thumbTip:[0.4,0.5]}}
      ]},
      {t:1480.125, segment:1, breakBefore:true, hands:[
        {id:32,breakBefore:true,joints:{wrist:[0.3,0.4],indexTip:[0.5,0.6]}}
      ]},
    ],
  };
  const encoded = encodeMotion(frozen(source));
  assert.deepEqual(decodeMotion(encoded), source);
  assert.deepEqual(encoded.rows.map(row => row[3].map(hand => hand[0])), [[17,29],[29],[29,31],[32]]);
  assert.deepEqual(encoded.rows.map(row => row[2]), [0,0,0,1]);
  assert.deepEqual(encoded.rows[2][3].map(hand => hand[1]), [0,1]);
  assert.equal(encoded.rows[3][3][0][1], 1);
  const wrist = encoded.jointNames.indexOf('wrist');
  const missingThumb = encoded.jointNames.indexOf('thumbTip');
  assert.deepEqual(encoded.rows[0][3][0][2][wrist], [0,0], 'A real zero point must not become missing');
  assert.equal(encoded.rows[0][3][0][2][missingThumb], null, 'Never copy a later or other hand observation into a gap');
});

test('all 22 body joints and changing missing joints round-trip without face points or inferred observations', async () => {
  const {encodeMotion} = await encoding;
  const source = {
    source:'webcam', durationMs:9000, sampleCount:135,
    metrics:{upperBodySpeed:2.345,lowerBodySpeed:1.456,torsoSpeed:0.021,fullBodyRatio:0.875},
    samples:Array.from({length:24}, (_, index) => ({
      t:fixed(index * 9000 / 23), segment:index > 15 ? 2 : 1,
      ...(index === 16 ? {breakBefore:true} : {}),
      joints:Object.fromEntries(bodyJoints.filter(name => index !== 8 || !name.includes('Wrist'))
        .map((name, joint) => [name,[fixed((index * 0.103 + joint * 0.037) % 1),fixed((index * 0.053 + joint * 0.043) % 1)]])),
    })),
  };
  const encoded = encodeMotion(frozen(source));
  assert.deepEqual(decodeMotion(encoded), source);
  assert.deepEqual(encoded.jointNames, bodyJoints);
  assert.equal(encoded.handColumns, undefined);
  assert.equal(encoded.jointNames.length, 22);
  assert.equal(encoded.rows[8][3][encoded.jointNames.indexOf('leftWrist')], null);
  assert.equal(encoded.rows[8][3][encoded.jointNames.indexOf('rightWrist')], null);
  assert.equal(encoded.rows.length, source.samples.length);
});

test('pointer and synthetic examples preserve strokes, actual timing, breaks and zero coordinates', async () => {
  const {encodeMotion} = await encoding;
  for (const source of ['pointer','example']) {
    const input = {
      source, durationMs:1234.567, sampleCount:17, metrics:{coverage:0.31},
      samples:[
        {t:0,x:0,y:0,stroke:7},
        {t:68.123,x:0.123,y:0.987,stroke:7},
        {t:1234.567,x:1,y:1,stroke:9,breakBefore:true},
      ],
    };
    const encoded = encodeMotion(frozen(input));
    assert.deepEqual(decodeMotion(encoded), input);
    assert.equal(encoded.jointNames, undefined);
    assert.equal(encoded.handColumns, undefined);
    assert.equal(encoded.handTarget, undefined);
    assert.deepEqual(encoded.rows[0], [0,7,0,0,0]);
  }
});

test('encoding substantially reduces serialized dense motion without removing observations', async () => {
  const {encodeMotion} = await encoding;
  const hand = denseHandMotion();
  const body = {
    source:'webcam',durationMs:10000,sampleCount:150,metrics:{meanSpeed:1.234},
    samples:hand.samples.map((frame,index) => ({
      t:frame.t, segment:frame.segment,
      ...(frame.breakBefore ? {breakBefore:true} : {}),
      joints:Object.fromEntries(bodyJoints.map((name,joint) => [name,[
        fixed((Math.sin(index * 1.13 + joint * 0.37) + 1) / 2),
        fixed((Math.cos(index * 0.73 - joint * 0.19) + 1) / 2),
      ]])),
    })),
  };
  for (const original of [hand,body]) {
    const encoded = encodeMotion(original);
    assert.ok(bytes(encoded) < bytes(original) * 0.6,
      `${original.source}: ${bytes(encoded)} encoded bytes should be <60% of ${bytes(original)} compact bytes`);
    assert.deepEqual(decodeMotion(encoded), original);
  }
});

test('empty observations remain empty and unsupported sources are not interpreted as another input mode', async () => {
  const {encodeMotion} = await encoding;
  for (const source of ['hand','webcam','pointer','example']) {
    const motion = {
      source, ...(source === 'hand' ? {handTarget:'wrist'} : {}),
      durationMs:0,sampleCount:0,metrics:{},samples:[],
    };
    assert.deepEqual(decodeMotion(encodeMotion(motion)), motion);
  }
  assert.throws(() => encodeMotion({source:'unknown',samples:[]}), /Unsupported motion source/);
});
