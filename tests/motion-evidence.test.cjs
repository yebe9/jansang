const {test}=require('node:test');
const assert=require('node:assert/strict');
const {payload,makeCase}=require('../scripts/motion-fixtures.cjs');
const modulePromise=import('../api/motion-evidence.mjs');
const api=import('../api/handler.mjs');
const raw=(name,options)=>{const input=makeCase(name,options);return {source:input.source,captureAspect:input.captureAspect,durationMs:input.durationMs,sampleCount:input.poseFrames.length,metrics:{},samples:input.poseFrames};};
test('static wide poses, tiny jitter and slow broad motion are not default dynamism',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 for(const name of ['stationary','jitter','slow_broad','small_footwork','translation']){
  const evidence=measureMotionEvidence(raw(name));assert.equal(evidence.eligibleDynamic,false,name);
 }
 const jitter=measureMotionEvidence(raw('jitter'));
 assert.ok(jitter.dominantTrack.meanSpeed>.03,'jitter can look fast without genuine displacement');
 assert.ok(jitter.dominantTrack.range<.02);
 assert.equal(jitter.dominantTrack.turnCount,0,'tiny position noise cannot create direction events');
 const staticEvidence=measureMotionEvidence(raw('stationary'));
 assert.equal(staticEvidence.dominantTrack.range,0);assert.deepEqual(staticEvidence.activeTracks,[]);
});
test('sustained broad fast gestures qualify without banning a legitimately fitting label',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 const e=measureMotionEvidence(raw('fast_broad'));
 assert.equal(e.eligibleDynamic,true);assert.ok(e.substantialTracks.includes('leftWrist'));
 assert.ok(e.substantialTracks.includes('rightWrist'));assert.ok(e.dominantTrack.range>.12);
 assert.ok(e.dominantTrack.fastRatio>.2);assert.ok(e.dominantTrack.turnCount>=2);
 const {buildAnalysisRequest}=await api;
 assert.ok(buildAnalysisRequest(payload('fast_broad')).generationConfig.responseSchema.properties.impression.enum.includes('역동적인'));
});
test('dynamic gates remain stable across ordinary sampling rates and capture aspect correction',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 for(const fps of [6,8,12,15,30])for(const name of ['stationary','jitter','slow_broad','fast_broad','small_footwork']){
  const motion=raw(name,{fps}),e=measureMotionEvidence(motion);
  assert.equal(e.eligibleDynamic,name==='fast_broad',name+' fps='+fps);
 }
 const wide=raw('fast_broad');wide.captureAspect=16/9;
 wide.samples.forEach(f=>Object.values(f.joints).forEach(p=>{p[0]=.5+(p[0]-.5)/wide.captureAspect;}));
 const standard=measureMotionEvidence(raw('fast_broad'));
 const corrected=measureMotionEvidence(wide);
 assert.equal(corrected.eligibleDynamic,true);
 // Diagonal is different for the camera, but x/y physical proportions agree.
 assert.ok(Math.abs(corrected.dominantTrack.range/standard.dominantTrack.range-Math.SQRT2/Math.hypot(16/9,1))<.01);
});
test('pauses, missing frames and replacement tracks cannot manufacture sustained activity',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 for(const mutate of [
  m=>m.samples.forEach((f,i)=>{f.segment=Math.floor(i/5);}),
  m=>m.samples.forEach((f,i)=>{if(i%5===0){delete f.joints.leftWrist;delete f.joints.rightWrist;delete f.joints.leftElbow;delete f.joints.rightElbow;}}),
  m=>m.samples.forEach((f,i)=>{f.t=i*300;}),
 ]){const m=raw('fast_broad');mutate(m);assert.equal(measureMotionEvidence(m).eligibleDynamic,false);}
});
test('horizontal travel is measurable even when the old bounding rectangle area is zero',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 const m=raw('translation');const e=measureMotionEvidence(m);
 assert.ok(e.dominantTrack.range>.08);assert.ok(e.activeTracks.includes('leftHip'));
 assert.equal(e.eligibleDynamic,false,'slow one-way displacement is not dynamic by default');
});
test('hand identities are kept separate and hand speed is not full-body evidence',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 const body=raw('fast_broad');
 const hand={...body,source:'hand',handTarget:'wrist',samples:body.samples.map(f=>({t:f.t,segment:0,hands:[{id:1,joints:{wrist:f.joints.leftWrist}},{id:2,joints:{wrist:[.5,.5]}}]}))};
 const e=measureMotionEvidence(hand);assert.equal(e.eligibleDynamic,true);
 assert.deepEqual(e.activeTracks,['hand:1']);assert.equal(e.regions,undefined);
 hand.samples.forEach((f,i)=>{f.hands[0].id=10+Math.floor(i/5);});
 assert.equal(measureMotionEvidence(hand).eligibleDynamic,false);
});
test('AI receives server observations rather than client peak-region or static spread claims',async()=>{
 const {buildAnalysisRequest}=await api;const m=payload('stationary');
 m.metrics={meanSpeed:100,peakSpeed:100,spread:100,directionChangeRate:100};
 const request=buildAnalysisRequest(m),data=JSON.parse(request.contents[0].parts[0].text);
 assert.deepEqual(data.metrics,{});assert.equal(data.motionEvidence.dominantTrack.meanSpeed,0);
 assert.equal(data.expressionRubric.eligible['역동적인'],false);
 for(const field of [request.generationConfig.responseSchema.properties.impression,request.generationConfig.responseSchema.properties.qualities.items,request.generationConfig.responseSchema.properties.candidates.items.properties.label])assert.equal(field.enum.includes('역동적인'),false);
 assert.match(request.systemInstruction.parts[0].text,/높은 순서로 배열하고 첫 번째가 대표/);
});

test('two separated runs of one wrist never count as two body tracks',async()=>{
 const {measureMotionEvidence}=await modulePromise;const m=raw('stationary',{durationMs:10000});
 m.samples.forEach((f,i)=>{f.segment=i<40?0:1;f.joints.leftWrist=[.4+.2*Math.sin(f.t/1000*2*Math.PI),.5+.2*Math.cos(f.t/1000*2*Math.PI)];});
 const e=measureMotionEvidence(m);assert.deepEqual(e.substantialTracks,['leftWrist']);assert.equal(e.eligibleDynamic,false);
});

test('measured torso scaling preserves broad gestures at different camera distances without magnifying jitter',async()=>{
 const {measureMotionEvidence}=await modulePromise;
 for(const scale of [.3,.5,.75,1])for(const name of ['fast_broad','slow_broad','jitter','stationary','small_footwork']){
  const m=raw(name);m.samples.forEach(f=>Object.values(f.joints).forEach(p=>{p[0]=.5+(p[0]-.5)*scale;p[1]=.5+(p[1]-.5)*scale;}));
  const e=measureMotionEvidence(m);assert.equal(e.eligibleDynamic,name==='fast_broad',name+' scale='+scale);
  assert.match(e.scale.basis,/torso/);assert.ok(e.scale.minRange>=.04);
 }
});

test('foot-tip steps remain observed when ankles stay fixed',async()=>{
 const {measureMotionEvidence}=await modulePromise;const m=raw('stationary');
 m.samples.forEach(f=>{for(const side of ['left','right'])f.joints[side+'FootIndex'][0]+=.04*Math.sin(f.t/1000*Math.PI*2);});
 const e=measureMotionEvidence(m);assert.ok(e.activeTracks.includes('leftFootIndex'));assert.equal(e.regions.lower.name.endsWith('FootIndex'),true);assert.equal(e.eligibleDynamic,false);
});
