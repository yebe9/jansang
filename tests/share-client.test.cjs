const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),crypto=require('node:crypto');
const {createClient,drawQR,DEADLINE_MS}=require('../dist/share-client.js');
const BASE='https://ghosting-image-share.jansang.workers.dev',URL_VALUE=BASE+'/s/'+'a'.repeat(64);
const NOW=Date.parse('2026-11-05T12:00:00.000Z');
const png=(width=1080,height=1350)=>{const data=new Uint8Array(33);data.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);const view=new DataView(data.buffer);view.setUint32(16,width);view.setUint32(20,height);return new Blob([data],{type:'image/png'});};
const answer=extra=>({url:URL_VALUE,expiresAt:new Date(NOW+86400000).toISOString(),...extra});
const client=(fetchImpl,extra={})=>createClient({fetchImpl,now:()=>NOW,...extra});
const rejection=code=>error=>error.code===code;

test('an explicit share sends only a validated PNG with no private cookie or referrer',async()=>{
 let call;const blob=png();const api=client(async(url,options)=>{call={url,options};return Response.json(answer());});
 assert.deepEqual(await api.create(blob,{apiBase:BASE}),answer());
 assert.equal(call.url,BASE+'/api/shares');assert.equal(call.options.method,'POST');assert.deepEqual(call.options.headers,{'Content-Type':'image/png'});
 assert.equal(call.options.body,blob);assert.equal(call.options.credentials,'omit');assert.equal(call.options.referrerPolicy,'no-referrer');assert.equal(call.options.cache,'no-store');assert.equal(call.options.signal.aborted,false);
});

test('API configuration accepts HTTPS origins and cannot carry credentials, query data or another path',async()=>{
 for(const base of ['',undefined,'http://localhost:4173','javascript:alert(1)','https://user:secret@share.example','https://share.example/path','https://share.example/?private=1','https://share.example/#fragment']){
  let called=false;const api=client(async()=>{called=true;});await assert.rejects(api.create(png(),{apiBase:base}),rejection('SHARE_CONFIG'));assert.equal(called,false);
 }
 const api=client(async()=>Response.json(answer()));assert.deepEqual(await api.create(png(),{apiBase:BASE+'/'}),answer());
});

test('wrong media, empty/large images and wrong-size or false PNG headers never reach the network',async()=>{
 const fake=new Uint8Array(33),items=[
  [new Blob(['image'],{type:'video/webm'}),'INVALID_SHARE_IMAGE'],[new Blob([],{type:'image/png'}),'SHARE_IMAGE_SIZE'],
  [new Blob([new Uint8Array(1024*1024+1)],{type:'image/png'}),'SHARE_IMAGE_SIZE'],[new Blob([fake],{type:'image/png'}),'INVALID_SHARE_IMAGE'],
  [png(1080,1349),'SHARE_IMAGE_DIMENSIONS'],[png(1920,1080),'SHARE_IMAGE_DIMENSIONS'],[{},'INVALID_SHARE_IMAGE'],
 ];
 let calls=0;const api=client(async()=>{calls++;return Response.json(answer());});
 for(const [image,code]of items)await assert.rejects(api.create(image,{apiBase:BASE}),rejection(code));assert.equal(calls,0);
});

test('share responses must stay on the expected HTTPS origin with a complete opaque image token',async()=>{
 for(const url of ['https://elsewhere.example/s/'+'a'.repeat(64),BASE+'/s/'+'a'.repeat(63),BASE+'/s/'+'g'.repeat(64),URL_VALUE+'/',URL_VALUE+'?key=1',URL_VALUE+'#x','http://'+BASE.slice(8)+'/s/'+'a'.repeat(64),'https://user:password@'+BASE.slice(8)+'/s/'+'a'.repeat(64)]){
  const api=client(async()=>Response.json(answer({url})));await assert.rejects(api.create(png(),{apiBase:BASE}),rejection('INVALID_SHARE_RESPONSE'));
 }
});

test('expired, excessively long, missing or invalid expiration dates are never turned into usable links',async()=>{
 for(const expiresAt of [new Date(NOW).toISOString(),new Date(NOW-1).toISOString(),new Date(NOW+86460001).toISOString(),'not a time',undefined,123]){
  const api=client(async()=>Response.json(answer({expiresAt})));await assert.rejects(api.create(png(),{apiBase:BASE}),rejection('INVALID_SHARE_RESPONSE'));
 }
 const api=client(async()=>Response.json(answer({expiresAt:new Date(NOW+1000).toISOString()})));assert.equal((await api.create(png(),{apiBase:BASE})).expiresAt,new Date(NOW+1000).toISOString());
});

test('malformed, incomplete or oversized successful server responses do not invent a share URL',async()=>{
 const responses=[()=>new Response('{"url":'),()=>Response.json(null),()=>Response.json([]),()=>Response.json({expiresAt:answer().expiresAt}),()=>new Response('x'.repeat(9000)),()=>new Response('{}',{headers:{'Content-Length':'9000'}})];
 for(const response of responses){const api=client(async()=>response());await assert.rejects(api.create(png(),{apiBase:BASE}),rejection('INVALID_SHARE_RESPONSE'));}
});

test('failure status guidance is bounded and does not expose arbitrary server body text',async()=>{
 for(const [status,code]of [[429,'SHARE_RATE_LIMITED'],[413,'SHARE_IMAGE_SIZE'],[400,'INVALID_SHARE_IMAGE'],[415,'INVALID_SHARE_IMAGE'],[500,'SHARE_UNAVAILABLE'],[503,'SHARE_UNAVAILABLE']]){
  const api=client(async()=>Response.json({error:{message:'private diagnostic secret'}},{status}));await assert.rejects(api.create(png(),{apiBase:BASE}),error=>error.code===code&&!error.message.includes('secret'));
 }
 const api=client(async()=>{throw new TypeError('transport diagnostic');});await assert.rejects(api.create(png(),{apiBase:BASE}),rejection('SHARE_NETWORK'));
});

test('an already cancelled share never reads or uploads an image, and later cancellation interrupts an ignoring transport',async()=>{
 const cancelled=new AbortController();cancelled.abort();let called=false;const api=client(async()=>{called=true;});await assert.rejects(api.create(png(),{apiBase:BASE,signal:cancelled.signal}),e=>e.name==='AbortError');assert.equal(called,false);
 const controller=new AbortController();let pendingSignal,resolveEntered;const entered=new Promise(r=>{resolveEntered=r;});
 const ignoring=client(async(_url,options)=>{pendingSignal=options.signal;resolveEntered();return new Promise(()=>{});});
 const pending=ignoring.create(png(),{apiBase:BASE,signal:controller.signal});await entered;controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(pendingSignal.aborted,true);
});

test('the deadline ends stalled uploads and response reads even when the transport ignores AbortSignal',async()=>{
 assert.equal(DEADLINE_MS,20000);
 for(const fetchImpl of [async()=>new Promise(()=>{}),async()=>({ok:true,headers:new Headers(),text:()=>new Promise(()=>{})})]){
  const api=client(fetchImpl,{timeoutMs:15}),start=performance.now();await assert.rejects(api.create(png(),{apiBase:BASE}),rejection('SHARE_TIMEOUT'));assert.ok(performance.now()-start<500);
 }
 class SlowBlob extends Blob{slice(){return {arrayBuffer:()=>new Promise(()=>{})};}}
 let called=false;const api=client(async()=>{called=true;},{timeoutMs:15});await assert.rejects(api.create(new SlowBlob([new Uint8Array(33)],{type:'image/png'}),{apiBase:BASE}),rejection('SHARE_TIMEOUT'));assert.equal(called,false);
});

function svgContainer(){
 const doc={createElementNS(ns,name){return {ns,name,attributes:{},children:[],setAttribute(k,v){this.attributes[k]=String(v);},append(...nodes){this.children.push(...nodes);}};}};
 return {ownerDocument:doc,children:[],replaceChildren(...nodes){this.children=nodes;}};
}
test('the shipped MIT QR encoder remains byte-identical to the verified official release',()=>{
 const source=fs.readFileSync(require.resolve('../dist/vendor/qrcode-generator-2.0.4.js'));
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c');
 assert.match(fs.readFileSync(require.resolve('../dist/vendor/qrcode-generator-LICENSE.txt'),'utf8'),/Permission is hereby granted/);
});
test('actual QR modules have four quiet cells and high-contrast mint SVG output without HTML or a network image',()=>{
 const container=svgContainer(),svg=drawQR(container,URL_VALUE);assert.equal(container.children[0],svg);assert.equal(svg.name,'svg');assert.equal(svg.attributes.role,'img');assert.match(svg.attributes['aria-label'],/QR/);
 const [background,path]=svg.children;assert.equal(background.attributes.fill,'#e2eadf');assert.equal(path.attributes.fill,'#102024');
 const size=Number(svg.attributes.viewBox.split(' ')[2]);assert.ok(size>=29&&size<=185);assert.equal(Number(svg.attributes.width),size*6);
 const runs=[...path.attributes.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];assert.ok(runs.length>100);
 for(const match of runs){const [x,y,width]=match.slice(1).map(Number);assert.ok(x>=4&&y>=4&&x+width<=size-4&&y<size-4);}
 const qr=require('../dist/vendor/qrcode-generator-2.0.4.js')(0,'M');qr.addData(URL_VALUE,'Byte');qr.make();let dark=0;for(let y=0;y<qr.getModuleCount();y++)for(let x=0;x<qr.getModuleCount();x++)dark+=Number(qr.isDark(y,x));
 assert.equal(runs.reduce((sum,m)=>sum+Number(m[3]),0),dark);assert.equal(size,qr.getModuleCount()+8);
 const cells=new Set();for(const m of runs){const [x,y,width]=m.slice(1).map(Number);for(let i=0;i<width;i++)cells.add((x+i-4)+','+(y-4));}
 assert.equal(cells.size,dark);for(let y=0;y<qr.getModuleCount();y++)for(let x=0;x<qr.getModuleCount();x++)assert.equal(cells.has(x+','+y),qr.isDark(y,x),'SVG preserves the actual QR module at '+x+','+y);
});
test('invalid share links never produce a fake QR',()=>{
 for(const url of ['https://share.example/s/short','javascript:alert(1)',URL_VALUE+'#fragment'])assert.throws(()=>drawQR(svgContainer(),url),rejection('INVALID_SHARE_RESPONSE'));
 assert.throws(()=>drawQR({},URL_VALUE),rejection('QR_UNAVAILABLE'));
});
