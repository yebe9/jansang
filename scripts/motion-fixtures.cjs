'use strict';
const {analyze}=require('../dist/motion-analysis.js');
const BASE={leftShoulder:[.42,.25],rightShoulder:[.58,.25],leftElbow:[.32,.38],rightElbow:[.68,.38],leftWrist:[.22,.5],rightWrist:[.78,.5],leftPinky:[.21,.52],rightPinky:[.79,.52],leftIndex:[.22,.53],rightIndex:[.78,.53],leftThumb:[.23,.51],rightThumb:[.77,.51],leftHip:[.45,.53],rightHip:[.55,.53],leftKnee:[.44,.72],rightKnee:[.56,.72],leftAnkle:[.43,.9],rightAnkle:[.57,.9],leftHeel:[.42,.91],rightHeel:[.58,.91],leftFootIndex:[.4,.93],rightFootIndex:[.6,.93]};
function makeCase(name,{fps=8,durationMs=8000}={}){
 const count=Math.round(durationMs/1000*fps)+1;
 const poseFrames=Array.from({length:count},(_,i)=>{
  const t=i*durationMs/(count-1),s=t/1000,joints=structuredClone(BASE);
  if(name==='jitter'){joints.leftWrist[0]+=(i%2?1:-1)*.006;joints.leftWrist[1]+=(i%3-1)*.003;}
  if(name==='slow_broad'||name==='fast_broad'){
   const frequency=name==='slow_broad'?.08:1.2,phase=2*Math.PI*frequency*s;
   for(const side of ['left','right']){const sign=side==='left'?-1:1;joints[side+'Wrist']=[.5+sign*(.18+.15*Math.sin(phase)),.48+.17*Math.cos(phase)];joints[side+'Elbow']=[.5+sign*(.13+.06*Math.sin(phase)),.36+.08*Math.cos(phase)];}
  }
  if(name==='small_footwork'){for(const side of ['left','right']){const sign=side==='left'?-1:1;for(const part of ['Ankle','Heel','FootIndex']){joints[side+part][0]+=.025*Math.sin(2*Math.PI*1.5*s+sign);joints[side+part][1]-=.03*Math.max(0,Math.sin(2*Math.PI*1.5*s+sign));}}}
  if(name==='translation'){Object.values(joints).forEach(p=>{p[0]+=.16*(s/8-.5);});}
  return {t,segment:0,joints};
 });
 return {source:'webcam',captureAspect:1,durationMs,poseFrames};
}
function payload(name,options){return analyze(makeCase(name,options)).payload;}
module.exports={BASE,makeCase,payload};
