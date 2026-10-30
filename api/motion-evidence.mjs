// Server-owned motion evidence from every received observation, before LLM frame compaction.
// These are empirical visual-language restrictions, not an emotion classifier.
export const MOTION_EVIDENCE_VERSION = 'observed-motion-v2';
export const DYNAMIC_THRESHOLDS = Object.freeze({
  minContinuousMs:1500, minRecordRatio:0.4, minRange:0.12,
  minSpeedP75:0.12, minFastRatio:0.2, minMovingRatio:0.35,
  minTorsoRelativeRange:0.6, minTorsoRelativeSpeed:0.6, minScreenRange:0.04, minScreenSpeed:0.05,
  minTurnCount:2, minSpeedContrast:1.8, minBodyTracks:2,
});
const BODY = ['leftShoulder','rightShoulder','leftElbow','rightElbow','leftWrist','rightWrist',
  'leftHip','rightHip','leftKnee','rightKnee','leftAnkle','rightAnkle','leftFootIndex','rightFootIndex'];
const MAX_GAP_MS=250,MOVING_SPEED=.02,FAST_SPEED=.12;
const round=x=>Number.isFinite(x)?Math.round(x*1000)/1000:null;
const quantile=(values,p)=>{if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y),i=(a.length-1)*p;return a[Math.floor(i)]+(a[Math.ceil(i)]-a[Math.floor(i)])*(i%1);};
function weightedQuantile(items,p){
 const sorted=[...items].sort((a,b)=>a.speed-b.speed),total=sorted.reduce((s,a)=>s+a.dt,0);let sum=0;
 for(const a of sorted){sum+=a.dt;if(sum>=total*p)return a.speed;}return 0;
}
function points(frame,motion,aspect,diagonal){
 const project=([x,y])=>[x*aspect/diagonal,y/diagonal];
 if(motion.source==='webcam')return BODY.filter(name=>frame.joints[name]).map(name=>({name,p:project(frame.joints[name])}));
 if(motion.source==='hand')return frame.hands.map(hand=>({name:'hand:'+hand.id,p:project(hand.joints[motion.handTarget])}));
 return [{name:'trace',p:project([frame.x,frame.y])}];
}
function runs(motion,aspect,diagonal){
 const last=new Map(),all=[];
 motion.samples.forEach((frame,index)=>{
  const segment=frame.segment??frame.stroke??0;
  for(const {name,p} of points(frame,motion,aspect,diagonal)){
   const prev=last.get(name),dt=prev?frame.t-prev.t:0;
   const continuous=prev&&prev.index===index-1&&prev.segment===segment&&dt>0&&dt<=MAX_GAP_MS;
   const run=continuous?prev.run:[];if(!continuous)all.push({name,run});
   run.push({t:frame.t,p});last.set(name,{index,segment,t:frame.t,run});
  }
 });return all.filter(a=>a.run.length>=2);
}
function stats({name,run},fastSpeed=FAST_SPEED){
 const xs=run.map(a=>a.p[0]),ys=run.map(a=>a.p[1]);
 const range=Math.hypot(quantile(xs,.9)-quantile(xs,.1),quantile(ys,.9)-quantile(ys,.1));
 const intervals=run.slice(1).map((a,i)=>{const dt=(a.t-run[i].t)/1000,distance=Math.hypot(a.p[0]-run[i].p[0],a.p[1]-run[i].p[1]);return {dt,speed:distance/dt};});
 const seconds=intervals.reduce((s,a)=>s+a.dt,0),path=intervals.reduce((s,a)=>s+a.speed*a.dt,0);
 const ratio=min=>intervals.reduce((s,a)=>s+(a.speed>=min?a.dt:0),0)/seconds;
 // Direction events need actual displacement and elapsed time. Tiny alternating
 // jitter cannot become many turns simply because the camera produced more frames.
 let anchor=run[0],direction=null,turnCount=0;
 for(const point of run.slice(1)){
  const dx=point.p[0]-anchor.p[0],dy=point.p[1]-anchor.p[1],distance=Math.hypot(dx,dy);
  if(distance<.015||point.t-anchor.t<100)continue;
  if(direction){const cosine=Math.max(-1,Math.min(1,(dx*direction[0]+dy*direction[1])/(distance*Math.hypot(...direction))));if(cosine<.5){turnCount++;direction=[dx,dy];}}
  if(!direction)direction=[dx,dy];anchor=point;
 }
 const p25=weightedQuantile(intervals,.25),p75=weightedQuantile(intervals,.75);
 return {name,durationMs:seconds*1000,range,meanSpeed:path/seconds,speedP75:p75,
  speedContrast:p75/Math.max(.02,p25),movingRatio:ratio(MOVING_SPEED),fastRatio:ratio(fastSpeed),turnCount,pathLength:path};
}
export function measureMotionEvidence(motion){
 const knownAspect=Number.isFinite(motion.captureAspect),aspect=knownAspect?motion.captureAspect:1,diagonal=Math.hypot(aspect,1);
 // Use a measured torso length to reduce camera-distance bias, with a screen
 // displacement floor so a small skeleton or tiny jitter cannot magnify noise.
 const torsoLengths=motion.source==='webcam'?motion.samples.flatMap(frame=>{
  const j=frame.joints,n=['leftShoulder','rightShoulder','leftHip','rightHip'];
  if(n.some(name=>!j[name]))return [];
  const dx=((j.leftShoulder[0]+j.rightShoulder[0])-(j.leftHip[0]+j.rightHip[0]))/2*aspect;
  const dy=((j.leftShoulder[1]+j.rightShoulder[1])-(j.leftHip[1]+j.rightHip[1]))/2;
  const length=Math.hypot(dx,dy)/diagonal;return length>=.03?[length]:[];
 }):[];
 const torsoLength=torsoLengths.length>=Math.max(2,motion.samples.length*.5)?quantile(torsoLengths,.5):null;
 const minRange=torsoLength?Math.max(DYNAMIC_THRESHOLDS.minScreenRange,torsoLength*DYNAMIC_THRESHOLDS.minTorsoRelativeRange):DYNAMIC_THRESHOLDS.minRange;
 const minSpeed=torsoLength?Math.max(DYNAMIC_THRESHOLDS.minScreenSpeed,torsoLength*DYNAMIC_THRESHOLDS.minTorsoRelativeSpeed):DYNAMIC_THRESHOLDS.minSpeedP75;
 const tracks=runs(motion,aspect,diagonal).map(run=>stats(run,minSpeed));
 const strongest=[...tracks].sort((a,b)=>b.range*b.meanSpeed-a.range*a.meanSpeed)[0];
 const thresholds=DYNAMIC_THRESHOLDS;
 const substantial=tracks.filter(a=>a.durationMs>=thresholds.minContinuousMs&&a.durationMs/motion.durationMs>=thresholds.minRecordRatio&&a.range>=minRange&&a.speedP75>=minSpeed&&a.fastRatio>=thresholds.minFastRatio&&a.movingRatio>=thresholds.minMovingRatio&&(a.turnCount>=thresholds.minTurnCount||a.speedContrast>=thresholds.minSpeedContrast));
 const active=[...new Set(tracks.filter(a=>a.range>=.025&&a.meanSpeed>=.005).map(a=>a.name))];
 const substantialNames=[...new Set(substantial.map(a=>a.name))];
 const eligibleDynamic=substantialNames.length>=(motion.source==='webcam'?thresholds.minBodyTracks:1);
 const roundStats=a=>a?Object.fromEntries(Object.entries(a).map(([k,v])=>[k,typeof v==='number'?round(v):v])):null;
 const regions=motion.source==='webcam'?Object.fromEntries([
  ['upper',['Shoulder','Elbow','Wrist']],['lower',['Knee','Ankle','FootIndex']],['torso',['Hip']]
 ].map(([region,suffixes])=>[region,roundStats([...tracks].filter(a=>suffixes.some(s=>a.name.endsWith(s))).sort((a,b)=>b.range*b.meanSpeed-a.range*a.meanSpeed)[0])])):undefined;
 return {
  version:MOTION_EVIDENCE_VERSION,basis:'all received observed 2D tracks; aspect-corrected screen-diagonal units',
  receivedFrames:motion.samples.length,originalFrames:motion.sampleCount,
  scale:{validTorsoFrames:torsoLengths.length,torsoLength:round(torsoLength),minRange:round(minRange),minSpeedP75:round(minSpeed),basis:torsoLength?'measured median torso with screen noise floor':'screen diagonal (torso unavailable)'},
  medianIntervalMs:round(quantile(motion.samples.slice(1).map((a,i)=>a.t-motion.samples[i].t).filter(a=>a>0),.5)),
  dominantTrack:roundStats(strongest),activeTracks:active,substantialTracks:substantialNames,
  ...(regions?{regions}:{}),eligibleDynamic,
  limitations:['Pose size is not motion range. Client aggregate metrics are not evidence.',
   'Subsampling can miss fast oscillations; missing observations and segment breaks are never joined.',
   ...(motion.source==='webcam'?['Screen translation can include camera movement; hip-centred world coordinates do not measure travel. Torso scaling reduces but cannot eliminate camera-distance and foreshortening bias; bending can shorten the projected torso.']:[]),
   ...(!knownAspect?['Capture aspect is unknown; square projection assumed.']:[])],
 };
}
