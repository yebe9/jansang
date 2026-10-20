// Lossless transport encoding for compactMotion()'s already-rounded samples.
// This changes representation only: no frame selection, interpolation, hand
// identity inference, or additional coordinate smoothing happens here.
export const ENCODING_GUIDE = 'rows는 columns 순서, 각 손은 handColumns 순서다. positions는 jointNames 순서의 [x,y]이며 null은 미관측이다. 좌표는 coordinateScale로 나누고 t·durationMs는 밀리초로 읽는다. breakBefore=1은 이전 관측과 연결하지 말라는 뜻이며 0은 새 끊김 표시가 없다는 뜻이다. 손 id·segment·stroke가 다르거나 관측이 없어진 구간도 서로 연결하지 않는다.';

const COORDINATE_SCALE = 1000;
const flag = value => value === true ? 1 : 0;
// compactMotion has already rounded coordinates to three decimals. Integer
// conversion removes JSON decimal punctuation without discarding more precision.
const coordinate = value => Math.round(value * COORDINATE_SCALE);

export function encodeMotion(motion) {
  const hand = motion.source === 'hand';
  const body = motion.source === 'webcam';
  if (!hand && !body && !['pointer', 'example'].includes(motion.source)) {
    throw new TypeError('Unsupported motion source');
  }
  const encoded = {
    encoding: 'motion-rows-v1',
    coordinateScale: COORDINATE_SCALE,
    source: motion.source,
    ...(hand ? { handTarget: motion.handTarget } : {}),
    durationMs: motion.durationMs,
    sampleCount: motion.sampleCount,
    metrics: { ...motion.metrics },
  };

  if (!hand && !body) {
    return {
      ...encoded,
      columns: ['t', 'stroke', 'breakBefore', 'x', 'y'],
      rows: motion.samples.map(frame => [
        frame.t, frame.stroke, flag(frame.breakBefore), coordinate(frame.x), coordinate(frame.y)
      ]),
    };
  }

  // A name appears once, in first-observed order. Never add a joint that was
  // absent from every sample, or borrow one hand's missing point from the other.
  const jointNames = [...new Set(motion.samples.flatMap(frame =>
    (hand ? frame.hands : [frame]).flatMap(observation => Object.keys(observation.joints))
  ))];
  const positions = joints => jointNames.map(name => Object.hasOwn(joints, name)
    ? joints[name].map(coordinate) : null);
  return {
    ...encoded,
    columns: ['t', 'segment', 'breakBefore', hand ? 'hands' : 'positions'],
    ...(hand ? { handColumns: ['id', 'breakBefore', 'positions'] } : {}),
    jointNames,
    rows: motion.samples.map(frame => [
      frame.t,
      frame.segment,
      flag(frame.breakBefore),
      hand ? frame.hands.map(observation => [
        observation.id, flag(observation.breakBefore), positions(observation.joints)
      ]) : positions(frame.joints),
    ]),
  };
}
