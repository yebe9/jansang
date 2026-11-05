'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create,WIDTH,HEIGHT}=require('../dist/trace-image.js');

const point=(x=.2,y=.4,t=0,stroke=0)=>({x,y,t,speed:.5,stroke});
const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<1e-6,`${label}: ${actual} != ${expected}`);
const coordinateKey=values=>values.map(value=>Number(value.toFixed(6))).join(',');
const uniqueLines=lines=>[...new Map(lines.map(line=>[coordinateKey(line.flat()),line])).values()];

// A Canvas boundary, not a renderer imitation: collect the geometry actually painted.
function canvasFixture({contextError,missingContext=false,blobError,blobValue}={}){
 const output=blobValue===undefined?new Blob(['synthetic PNG bytes'],{type:'image/png'}):blobValue;
 const calls={lines:[],dots:[],fills:[],encodings:[],text:[],images:[]};
 let current=[],arc;
 const ctx={
  fillRect(...rect){calls.fills.push(rect);},
  beginPath(){current=[];arc=undefined;},
  moveTo(x,y){current.push([x,y]);},
  lineTo(x,y){current.push([x,y]);},
  stroke(){for(let i=1;i<current.length;i++)calls.lines.push([current[i-1],current[i]]);},
  arc(x,y,r){arc={x,y,r};},
  fill(){if(arc)calls.dots.push({...arc});},
  createLinearGradient(){return {addColorStop(){}};},
  fillText(...args){calls.text.push(args);throw new Error('Text must not enter the trace image');},
  strokeText(...args){calls.text.push(args);throw new Error('Text must not enter the trace image');},
  drawImage(...args){calls.images.push(args);throw new Error('Camera or other images must not enter the trace image');},
 };
 const canvas={width:0,height:0,getContext(kind){assert.equal(kind,'2d');if(contextError)throw contextError;return missingContext?null:ctx;},toBlob(callback,type){calls.encodings.push(type);if(blobError)throw blobError;callback(output);}};
 return {canvas,calls,output,createCanvas:()=>canvas};
}

function render(points,extra={}){
 const fixture=canvasFixture();
 return {fixture,pending:create({points,...extra},{createCanvas:fixture.createCanvas})};
}

function segmentKey(line){return coordinateKey(line.flat());}

test('PNG export retains the complete recording, including early and late adjacent samples',async()=>{
 // More than a summary or recent-window sample cap. Every pair must survive.
 const count=1200;
 const points=Array.from({length:count},(_,i)=>point(.05+.9*i/(count-1),.5,i*10));
 const {fixture,pending}=render(points);
 assert.equal(await pending,fixture.output);
 const lines=uniqueLines(fixture.calls.lines);
 assert.equal(lines.length,count-1,'no earlier samples may be discarded or replaced by summary chords');
 const left=Math.min(...lines.flatMap(line=>line.map(p=>p[0])));
 const right=Math.max(...lines.flatMap(line=>line.map(p=>p[0])));
 const step=(right-left)/(count-1),seen=new Set();
 for(const [a,b]of lines){
  const start=(a[0]-left)/step,end=(b[0]-left)/step;
  close(start,Math.round(start),'sample projection');
  close(end,start+1,'only adjacent samples are joined');
  close(a[1],b[1],'horizontal input remains horizontal');
  seen.add(Math.round(start));
 }
 assert.equal(seen.size,count-1);assert.ok(seen.has(0));assert.ok(seen.has(count-2));
});

test('interleaved strokes, tracking gaps and backwards time never acquire connecting chords',async()=>{
 const a=point(.1,.2,0,0),b=point(.1,.8,0,1),c=point(.2,.2,100,0),d=point(.2,.8,100,1);
 const e=point(.3,.2,500,0),f=point(.4,.2,600,0),g=point(.5,.2,550,0),h=point(.6,.2,650,0);
 const {fixture,pending}=render([a,b,c,d,e,f,g,h]);await pending;
 const lines=uniqueLines(fixture.calls.lines);
 assert.equal(lines.length,4);
 // Infer the viewport transform from the first valid pair rather than fixing layout padding.
 const [start,end]=lines[0],scale=(end[0]-start[0])/(c.x-a.x);
 const tx=start[0]-a.x*scale,ty=start[1]-a.y*scale;
 const xy=p=>[p.x*scale+tx,p.y*scale+ty];
 const actual=new Set(lines.map(segmentKey));
 const expected=new Set([[a,c],[b,d],[e,f],[g,h]].map(pair=>segmentKey(pair.map(xy))));
 assert.deepEqual(actual,expected,'no line may bridge hands, a lost-track interval or a timestamp reversal');
});

test('fixed portrait export preserves captured aspect ratio and keeps valid traces inside the image',async()=>{
 assert.equal(WIDTH,1080);assert.equal(HEIGHT,1350);
 for(const captureAspect of [1,16/9,9/16,.2,5]){
  const points=[point(0,.5,0,0),point(1,.5,100,0),point(.5,0,0,1),point(.5,1,100,1)];
  const {fixture,pending}=render(points,{captureAspect});await pending;
  assert.equal(fixture.canvas.width,1080);assert.equal(fixture.canvas.height,1350);
  const lines=uniqueLines(fixture.calls.lines);
  const horizontal=lines.find(([a,b])=>Math.abs(a[1]-b[1])<1e-8);
  const vertical=lines.find(([a,b])=>Math.abs(a[0]-b[0])<1e-8);
  assert.ok(horizontal);assert.ok(vertical);
  close(Math.abs(horizontal[1][0]-horizontal[0][0])/Math.abs(vertical[1][1]-vertical[0][1]),captureAspect,'the camera shape must not stretch');
  for(const line of lines)for(const [x,y]of line){assert.ok(x>=0&&x<=1080);assert.ok(y>=0&&y<=1350);}
  assert.deepEqual(fixture.calls.encodings,['image/png']);
 }
});

test('single-point recordings retain a visible observed mark without inventing movement',async()=>{
 const {fixture,pending}=render([point(.25,.75,0)]);await pending;
 assert.equal(fixture.calls.lines.length,0);
 assert.ok(fixture.calls.dots.some(dot=>Number.isFinite(dot.x)&&Number.isFinite(dot.y)&&dot.r>0));
});

test('only trace coordinates are read and only an image Blob leaves the renderer',async()=>{
 let privateReads=0;
 const preventRead=object=>{for(const name of ['video','videoBlob','intent','aiResult','name','sessionId','privateLog'])Object.defineProperty(object,name,{get(){privateReads++;throw new Error('Private field was inspected');}});return Object.freeze(object);};
 const points=Object.freeze([preventRead(point(.1,.1,0)),preventRead(point(.8,.7,100))]);
 const input=preventRead({points,captureAspect:16/9,strokeWidth:3.5});
 const fixture=canvasFixture();
 const result=await create(input,{createCanvas:fixture.createCanvas});
 assert.equal(result,fixture.output);assert.ok(result instanceof Blob);assert.equal(result.type,'image/png');
 assert.equal(privateReads,0);assert.deepEqual(fixture.calls.text,[]);assert.deepEqual(fixture.calls.images,[]);
 assert.deepEqual(Object.keys(result),[],'no metadata is attached to the shareable image');
 assert.equal(points[0].x,.1,'export must not alter recorded coordinates');
});

test('invalid sample lists, aspect ratios and widths fail before allocating a canvas',async()=>{
 const p=point();
 const cases=[{}, {points:null},{points:{}},{points:[]},{points:Array(50001).fill(p)}];
 for(const captureAspect of [0,-1,.199,5.001,NaN,Infinity,'1',null])cases.push({points:[p],captureAspect});
 for(const strokeWidth of [0,-1,10.001,NaN,Infinity,'3.5',null])cases.push({points:[p],strokeWidth});
 for(const input of cases){
  let allocated=false;
  await assert.rejects(async()=>create(input,{createCanvas(){allocated=true;return canvasFixture().canvas;}}));
  assert.equal(allocated,false,'invalid image input must fail before drawing');
 }
});

test('non-finite, out-of-frame or malformed coordinates never reach Canvas',async()=>{
 const invalid=[null,undefined,{},
  ...['x','y','t','speed','stroke'].flatMap(field=>[NaN,Infinity,-Infinity,undefined,'0'].map(value=>({...point(),[field]:value}))),
  {...point(),x:-.01},{...point(),x:1.01},{...point(),y:-.01},{...point(),y:1.01},
  {...point(),t:-1},{...point(),speed:-1},{...point(),stroke:-1},{...point(),stroke:.5},
 ];
 for(const sample of invalid){
  let allocated=false;
  await assert.rejects(async()=>create({points:[sample]},{createCanvas(){allocated=true;return canvasFixture().canvas;}}));
  assert.equal(allocated,false);
 }
});

test('Canvas allocation and drawing failures surface as failures instead of an image',async()=>{
 const input={points:[point(),point(.8,.8,100)]};
 const allocationError=new Error('allocation failed');
 await assert.rejects(async()=>create(input,{createCanvas(){throw allocationError;}}),error=>error===allocationError);
 for(const settings of [{missingContext:true},{contextError:new Error('context unavailable')}]){
  const fixture=canvasFixture(settings);
  await assert.rejects(async()=>create(input,{createCanvas:fixture.createCanvas}));
  assert.deepEqual(fixture.calls.encodings,[],'no export after a failed Canvas context');
 }
 const fixture=canvasFixture();fixture.canvas.getContext=()=>({fillRect(){throw new Error('drawing failed');}});
 await assert.rejects(async()=>create(input,{createCanvas:fixture.createCanvas}));
 assert.deepEqual(fixture.calls.encodings,[]);
});

test('PNG encoder exceptions, a null result and an empty Blob never become a successful share image',async()=>{
 for(const settings of [{blobError:new Error('encoder failed')},{blobValue:null},{blobValue:new Blob([],{type:'image/png'})}]){
  const fixture=canvasFixture(settings);
  await assert.rejects(async()=>create({points:[point()]},{createCanvas:fixture.createCanvas}));
  assert.deepEqual(fixture.calls.encodings,['image/png']);
 }
});
