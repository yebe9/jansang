const {test}=require('node:test');const assert=require('node:assert/strict');
const provider=import('../api/motiongpt-provider.mjs');const api=import('../api/handler.mjs');
const names=['leftShoulder','rightShoulder','leftElbow','rightElbow','leftWrist','rightWrist','leftHip','rightHip','leftKnee','rightKnee','leftAnkle','rightAnkle','leftFootIndex','rightFootIndex'];
const world=()=>Object.fromEntries(names.map((name,i)=>[name,[i/100,-0.4,0.05]]));
const motion=()=>({source:'webcam',durationMs:1000,sampleCount:8,metrics:{meanSpeed:.2},samples:[{t:0,joints:{leftWrist:[.3,.4],rightWrist:[.7,.4]},worldJoints:world()},{t:1000,joints:{leftWrist:[.4,.4],rightWrist:[.6,.4]},worldJoints:world()}]});
test('3D input validation preserves real measured body coordinates and rejects facial or unbounded fields',async()=>{
 const {validateMotion}=await api;assert.deepEqual(validateMotion(motion()).samples[0].worldJoints.leftAnkle,[.1,-.4,.05]);
 for(const extra of [{nose:[0,0,0]},{head:[0,0,0]},{leftAnkle:[99,0,0]},{leftAnkle:[0,0]}]){const sample=motion();Object.assign(sample.samples[0].worldJoints,extra);assert.throws(()=>validateMotion(sample));}
});
test('the CPU provider is optional and never mislabels hand trajectories as full-body MotionGPT',async()=>{
 const {requestMotionCaption}=await provider;const noFetch=()=>{throw new Error('not called');};assert.equal(await requestMotionCaption(motion(),{},{fetchImpl:noFetch}),null);assert.equal(await requestMotionCaption({...motion(),source:'hand'},{MOTIONGPT_URL:'http://127.0.0.1:8765'},{fetchImpl:noFetch}),null);
});
test('MotionGPT URL cannot point to a public or credential-bearing destination',async()=>{
 const {requestMotionCaption}=await provider;for(const url of ['https://remote.example','http://remote.example','http://user:pass@127.0.0.1:8765','http://127.0.0.1:8765?token=x'])await assert.rejects(requestMotionCaption(motion(),{MOTIONGPT_URL:url}),e=>e.code==='MOTIONGPT_CONFIG');
});
test('caption calls contain only genuine body 3D coordinates and preserve retargeting provenance',async()=>{
 const {requestMotionCaption}=await provider;let input;const result=await requestMotionCaption(motion(),{MOTIONGPT_URL:'http://127.0.0.1:8765'},{fetchImpl:async(url,options)=>{assert.equal(url.pathname,'/caption');input=JSON.parse(options.body);return Response.json({provider:'MotionGPT',caption:'A person raises their arms.',model:'MotionGPT-base',frames:20,provenance:{inferredJoints:['head'],rootTranslationAvailable:false}});}});
 assert.equal(input.samples[0].joints,undefined);assert.equal(input.intention,undefined);assert.equal(result.retargeting.rootTranslationAvailable,false);assert.equal(result.caption,'A person raises their arms.');
});
test('missing real world joints do not silently turn a 2D stream into a motion caption',async()=>{
 const {requestMotionCaption}=await provider;const data=motion();for(const sample of data.samples)delete sample.worldJoints;await assert.rejects(requestMotionCaption(data,{MOTIONGPT_URL:'http://127.0.0.1:8765'}),e=>e.code==='MOTIONGPT_COORDINATES');
});
test('actual CPU service failure remains actionable instead of producing a fake caption',async()=>{
 const {requestMotionCaption}=await provider;await assert.rejects(requestMotionCaption(motion(),{MOTIONGPT_URL:'http://127.0.0.1:8765'},{fetchImpl:async()=>Response.json({error:{code:'MOTIONGPT_NOT_CONFIGURED',message:'Install model'}},{status:503})}),e=>e.code==='MOTIONGPT_NOT_CONFIGURED');
 await assert.rejects(requestMotionCaption(motion(),{MOTIONGPT_URL:'http://127.0.0.1:8765'},{fetchImpl:async()=>Response.json({provider:'Gemini',caption:'pretend'})}),e=>e.code==='MOTIONGPT_RESPONSE');
});
test('API chains an actual CPU caption into Korean impression generation and keeps the model provenance',async()=>{
 const {handleApi}=await api;const calls=[];
 const analysis={impression:'매끄러운',description:'차분한 흐름이 이어집니다.',observations:['손을 들어 올립니다.'],qualities:['매끄러운'],caveat:'',candidates:[{label:'매끄러운',score:90,evidence:'흐름'}]};
 const fetchImpl=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return calls.length===1?Response.json({provider:'MotionGPT',caption:'A person raises hands.',model:'MotionGPT-base',provenance:{rootTranslationAvailable:false}}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(analysis)}]}}]});};
 const request=new Request('http://127.0.0.1:4173/api/analyze',{method:'POST',headers:{Origin:'http://127.0.0.1:4173','Content-Type':'application/json'},body:JSON.stringify(motion())});
 const response=await handleApi(request,{allowLocal:true,env:{GEMINI_API_KEY:'test-not-a-real-key',MOTIONGPT_URL:'http://127.0.0.1:8765'},fetchImpl});
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.provider,'MotionGPT + Gemini');assert.equal(result.motionCaption.caption,'A person raises hands.');assert.equal(result.motionCaption.retargeting.rootTranslationAvailable,false);
 const prompt=JSON.parse(calls[1].body.contents[0].parts[0].text);assert.equal(prompt.motionCaption.caption,'A person raises hands.');assert.equal(prompt.motionCaption.retargeting.rootTranslationAvailable,false);assert.match(prompt.motionCaption.note,/보조 캡션/);assert.ok(prompt.motionEvidence);assert.deepEqual(prompt.metrics,{});assert.equal(JSON.stringify(calls[1].body).includes('worldJoints'),false);assert.equal(calls[1].body.generationConfig.responseSchema.properties.candidates.minItems,5);
});
