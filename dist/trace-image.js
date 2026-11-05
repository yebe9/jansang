/* Full-recording PNG export. Only observed traces are painted; no video, intent or AI text. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GhostingImage=api;})(typeof window!=='undefined'?window:null,function(){
 'use strict';
 const WIDTH=1080,HEIGHT=1350;
 const palette=[[.56,.52,.95],[.40,.83,.77],[.95,.80,.51],[1,.42,.34]];
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 function color(speed){const value=clamp(speed/1.7,0,1)*3,low=Math.min(2,Math.floor(value)),f=value-low;return 'rgb('+palette[low].map((n,i)=>Math.round((n+(palette[low+1][i]-n)*f)*255)).join(',')+')';}
 function create({points,captureAspect=1,strokeWidth=3.5},{createCanvas=()=>document.createElement('canvas')}={}){
  if(!Array.isArray(points)||!points.length||points.length>50000)return Promise.reject(new Error('저장할 잔상이 없어요.'));
  if(!Number.isFinite(captureAspect)||captureAspect<.2||captureAspect>5)return Promise.reject(new Error('잔상의 화면 비율을 확인해 주세요.'));
  if(!Number.isFinite(strokeWidth)||strokeWidth<=0||strokeWidth>10)return Promise.reject(new Error('잔상의 굵기를 확인해 주세요.'));
  const observed=points.map(p=>{
   if(!p||!['x','y','t','speed','stroke'].every(k=>Number.isFinite(p[k]))||p.x<0||p.x>1||p.y<0||p.y>1||p.t<0||p.speed<0||!Number.isInteger(p.stroke)||p.stroke<0)throw new Error('잔상 좌표를 확인해 주세요.');
   return {x:p.x,y:p.y,t:p.t,speed:p.speed,stroke:p.stroke};
  });
  const canvas=createCanvas();canvas.width=WIDTH;canvas.height=HEIGHT;
  const ctx=canvas.getContext('2d');if(!ctx)return Promise.reject(new Error('이미지를 만들지 못했어요.'));
  ctx.fillStyle='#111b20';ctx.fillRect(0,0,WIDTH,HEIGHT);
  const scale=Math.min(WIDTH*.88/captureAspect,HEIGHT*.88);
  const xy=p=>[WIDTH/2+(p.x-.5)*scale*captureAspect,HEIGHT/2+(p.y-.5)*scale];
  ctx.globalCompositeOperation='lighter';ctx.lineCap='round';ctx.lineJoin='round';
  for(const [factor,alpha] of [[5,.055],[2,.12],[.75,.74]]){
   const previous=new Map();ctx.globalAlpha=alpha;
   for(const p of observed){
    const a=previous.get(p.stroke);previous.set(p.stroke,p);
    if(!a||p.t<a.t||p.t-a.t>350)continue;
    const [x1,y1]=xy(a),[x2,y2]=xy(p);if(Math.hypot(x2-x1,y2-y1)<.05)continue;
    const gradient=ctx.createLinearGradient(x1,y1,x2,y2);gradient.addColorStop(0,color(a.speed));gradient.addColorStop(1,color(p.speed));
    ctx.strokeStyle=gradient;ctx.lineWidth=2*strokeWidth*factor*(1.2-Math.min(p.speed/3,.5));
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
   }
  }
  const ends=new Map();for(const p of observed)ends.set(p.stroke,p);
  ctx.globalAlpha=.8;
  for(const p of ends.values()){const [x,y]=xy(p);ctx.fillStyle=color(p.speed);ctx.beginPath();ctx.arc(x,y,Math.max(1.5,strokeWidth*.5),0,Math.PI*2);ctx.fill();}
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob&&blob.size?resolve(blob):reject(new Error('이미지 저장에 실패했어요.')),'image/png'));
 }
 return {WIDTH,HEIGHT,create};
});
