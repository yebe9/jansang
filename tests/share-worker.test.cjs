const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {deflateSync}=require('node:zlib');
const vm=require('node:vm');
const moduleReady=import('../share/worker.mjs');
const base='https://ghosting-image-share.example',origin='https://yebe9.github.io',now=1793872800000;
function crc32(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function chunk(name,data=Buffer.alloc(0)){const bytes=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([bytes,data])));return Buffer.concat([length,bytes,data,crc]);}
function png({width=1080,height=1350,animated=false}={}){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const pixels=Buffer.alloc(height*(1+width*4)); // Real, complete RGBA scanlines with filter zero.
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(animated?[chunk('acTL',Buffer.alloc(8))]:[]),chunk('IDAT',deflateSync(pixels)),chunk('IEND')]);
}
const PNG=png();
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(fs.readFileSync(require.resolve('../share/schema.sql'),'utf8'));
 const statements=[],bindingKeys=[];
 const db={prepare(sql){statements.push(sql);const statement=sqlite.prepare(sql);const wrap=(args=[])=>({
  bind:(...values)=>wrap(values.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v)),
  first:async()=>statement.get(...args)||null,
  run:async()=>({meta:{changes:Number(statement.run(...args).changes)}}),
 });return wrap();}};
 const env={SHARE_DB:db,SHARE_LIMITER:{limit:async({key})=>{bindingKeys.push(key);return{success:true};}},TOTAL_SHARE_LIMITER:{limit:async()=>({success:true})}};
 return {sqlite,env,statements,bindingKeys};
}
function request(path='/api/shares',{method='POST',body=PNG,type='image/png',requestOrigin=origin,headers={}}={}){
 return new Request(base+path,{method,headers:{...(requestOrigin===null?{}:{Origin:requestOrigin}),...(type===null?{}:{'Content-Type':type}),...headers},...(['GET','HEAD','OPTIONS'].includes(method)?{}:{body})});
}
async function call(f,path,options,time=now){return(await moduleReady).handleShare(request(path,options),f.env,{now:time});}
async function upload(f,time=now){const response=await call(f,'/api/shares',{},time);assert.equal(response.status,201);return response.json();}
function urlPath(shared){return new URL(shared.url).pathname;}

test('an opted-in real PNG gets a random private-token link and a strict 24-hour expiry',async()=>{
 const f=fixture(),m=await moduleReady;const a=await upload(f),b=await upload(f);
 assert.notEqual(a.url,b.url);assert.match(a.url,new RegExp('^'+base+'/s/[a-f0-9]{64}$'));
 assert.equal(Date.parse(a.expiresAt),now+m.SHARE_TTL_MS);assert.equal(Object.keys(a).sort().join(','),'expiresAt,url');
 const token=new URL(a.url).pathname.split('/').at(-1),rows=f.sqlite.prepare('SELECT * FROM image_shares').all();
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.token_hash!==token));assert.equal(rows[0].byte_size,PNG.length);
 assert.deepEqual(Object.keys(rows[0]).sort(),['byte_size','created_at','expires_at','image','token_hash']);
 const image=await call(f,urlPath(a)+'/image.png',{method:'GET',requestOrigin:null});
 assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
 assert.equal(image.headers.get('cache-control'),'private, no-store, max-age=0');assert.equal(image.headers.get('x-content-type-options'),'nosniff');
 assert.equal(image.headers.get('referrer-policy'),'no-referrer');assert.match(image.headers.get('x-robots-tag'),/noindex/);
 f.sqlite.close();
});

test('only the authorized image-sharing origins can upload or preflight, without cookies',async()=>{
 const f=fixture();
 for(const requestOrigin of ['https://evil.example','null',null,'https://yebe9.github.io.evil.test']){
  const r=await call(f,'/api/shares',{requestOrigin});assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);
 }
 for(const requestOrigin of [origin,'http://127.0.0.1:4173','http://localhost:4173']){
  const r=await call(f,'/api/shares',{method:'OPTIONS',requestOrigin});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),requestOrigin);assert.equal(r.headers.get('access-control-allow-credentials'),null);
 }
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,0);f.sqlite.close();
});

test('unconfigured or exhausted rate limits fail closed before the image body reaches storage',async()=>{
 const f=fixture();
 delete f.env.SHARE_LIMITER;let r=await call(f);assert.equal(r.status,503);
 f.env.SHARE_LIMITER={limit:async()=>({success:false})};r=await call(f);assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');
 f.env.SHARE_LIMITER={limit:async()=>({success:true})};f.env.TOTAL_SHARE_LIMITER={limit:async()=>({success:false})};r=await call(f);assert.equal(r.status,429);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,0);
 const g=fixture();delete g.env.SHARE_DB;r=await call(g);assert.equal(r.status,503);f.sqlite.close();g.sqlite.close();
});

test('invalid, animated, truncated, corrupt and oversized inputs are never shared',async()=>{
 const f=fixture();
 const badCRC=Buffer.from(PNG);badCRC[29]^=1;
 const cases=[
  {body:'<html>no image</html>',type:'text/html',expected:415},
  {body:PNG,type:'video/webm',expected:415},
  {body:Buffer.from('not png'),expected:400},
  {body:PNG.subarray(0,PNG.length-5),expected:400},
  {body:Buffer.concat([PNG,Buffer.from('<html>trailing')]),expected:400},
  {body:badCRC,expected:400},
  {body:png({width:200,height:200}),expected:400},
  {body:png({animated:true}),expected:400},
  {body:Buffer.concat([PNG.subarray(0,33),chunk('ABCD'),PNG.subarray(33)]),expected:400},
  {body:Buffer.alloc(1024*1024+1),expected:413},
  {body:PNG,headers:{'Content-Length':String(1024*1024+1)},expected:413},
 ];
 for(const {expected,...options} of cases){const r=await call(f,'/api/shares',options);assert.equal(r.status,expected);}
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,0);f.sqlite.close();
});

test('viewer and image stop responding at the exact expiry, even before scheduled deletion',async()=>{
 const f=fixture(),m=await moduleReady,shared=await upload(f),path=urlPath(shared),until=Date.parse(shared.expiresAt);
 for(const suffix of ['', '/image.png']){
  let r=await call(f,path+suffix,{method:'GET',requestOrigin:null},until-1);assert.equal(r.status,200);
  r=await call(f,path+suffix,{method:'GET',requestOrigin:null},until);assert.equal(r.status,410);assert.equal(r.headers.get('cache-control'),'private, no-store, max-age=0');
  r=await call(f,path+suffix,{method:'GET',requestOrigin:null},until+1);assert.equal(r.status,410);
 }
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,1,'access is denied independently of deletion timing');
 await m.cleanupExpired(f.env,{now:until});assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,0);
 assert.equal((await call(f,path,{method:'GET',requestOrigin:null},until+1)).status,410);
 f.sqlite.close();
});

test('the public viewer offers only the trace image, download and supported device sharing',async()=>{
 const f=fixture(),shared=await upload(f),path=urlPath(shared);
 const r=await call(f,path,{method:'GET',requestOrigin:null});const html=await r.text();
 assert.match(html,/이미지 저장/);assert.match(html,new RegExp(path+'/image.png\\?download=1'));
 assert.match(html,/background:#111b20/);assert.doesNotMatch(html,/video|api\/records|password|Gemini|intention/);
 assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(r.headers.get('x-frame-options'),'DENY');
 assert.equal(r.headers.get('access-control-allow-origin'),null);
 const download=await call(f,path+'/image.png?download=1',{method:'GET',requestOrigin:null});
 assert.equal(download.headers.get('content-disposition'),'attachment; filename="ghosting.png"');
 const script=await call(f,'/share.js',{method:'GET',requestOrigin:null});assert.equal(script.status,200);assert.match(await script.text(),/navigator\.share/);f.sqlite.close();
});

test('image HEAD reads only metadata and never transfers the stored image bytes',async()=>{
 const f=fixture(),shared=await upload(f),path=urlPath(shared);f.statements.length=0;
 const r=await call(f,path+'/image.png',{method:'HEAD',requestOrigin:null});assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,0);
 assert.ok(f.statements.every(sql=>!sql.includes('SELECT image,')));f.sqlite.close();
});

test('the count and byte limits are atomic with the insert, not a stale preflight check',async()=>{
 const f=fixture(),m=await moduleReady;
 const put=f.sqlite.prepare('INSERT INTO image_shares VALUES (?, ?, ?, ?, ?)');
 const tiny=PNG;for(let i=0;i<m.MAX_SHARES-1;i++)put.run(i.toString(16).padStart(64,'0'),now,now+m.SHARE_TTL_MS,tiny.length,tiny);
 const responses=await Promise.all([call(f),call(f)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,503]);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,m.MAX_SHARES);
 assert.ok(f.statements.some(sql=>sql.startsWith('INSERT INTO')&&sql.includes('COUNT(*)')&&sql.includes('SUM(byte_size)')));
 f.sqlite.close();
 const g=fixture(),large=Buffer.alloc(m.MAX_IMAGE_BYTES),putLarge=g.sqlite.prepare('INSERT INTO image_shares VALUES (?, ?, ?, ?, ?)');
 for(let i=0;i<m.MAX_SHARE_BYTES/m.MAX_IMAGE_BYTES;i++)putLarge.run(i.toString(16).padStart(64,'0'),now,now+m.SHARE_TTL_MS,large.length,large);
 assert.equal((await call(g)).status,503);assert.equal(g.sqlite.prepare('SELECT SUM(byte_size) AS size FROM image_shares').get().size,m.MAX_SHARE_BYTES);g.sqlite.close();
});

test('expired images free capacity on the next upload without affecting active shares',async()=>{
 const f=fixture(),m=await moduleReady,put=f.sqlite.prepare('INSERT INTO image_shares VALUES (?, ?, ?, ?, ?)');
 for(let i=0;i<m.MAX_SHARES;i++)put.run(i.toString(16).padStart(64,'0'),now-1000,now,PNG.length,PNG);
 assert.equal((await call(f)).status,201);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_shares').get().n,1);f.sqlite.close();
});

test('malformed routes and non-upload methods do not reveal stored metadata',async()=>{
 const f=fixture();
 for(const path of ['/api/records','/s/123','/s/'+'a'.repeat(64)+'/../x','/s/'+'a'.repeat(64)+'/image.svg']){
  const r=await call(f,path,{method:'GET',requestOrigin:null});assert.equal(r.status,404);assert.equal(r.headers.get('access-control-allow-origin'),null);
 }
 assert.equal((await call(f,'/api/shares',{method:'GET'})).status,405);
 assert.equal((await call(f,'/s/'+'a'.repeat(64),{method:'POST'})).status,405);
 assert.equal((await call(f,'/s/'+'a'.repeat(64),{method:'GET',requestOrigin:null})).status,410);f.sqlite.close();
});

test('D1 array-serialized blobs preserve every original byte',async()=>{
 const f=fixture(),shared=await upload(f),path=urlPath(shared),original=f.env.SHARE_DB.prepare;
 f.env.SHARE_DB.prepare=sql=>{const statement=original(sql);const wrap=s=>({bind:(...args)=>wrap(s.bind(...args)),run:()=>s.run(),first:async()=>{const row=await s.first();return row?.image?{...row,image:Array.from(row.image)}:row;}});return wrap(statement);};
 const r=await call(f,path+'/image.png',{method:'GET',requestOrigin:null});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG);f.sqlite.close();
});
test('only the documented image download query is accepted',async()=>{
 const f=fixture(),shared=await upload(f),path=urlPath(shared);
 for(const query of ['?download=2','?download=1&download=1','?download=1&other=1','?next=https://evil.example']){
  const r=await call(f,path+'/image.png'+query,{method:'GET',requestOrigin:null});assert.equal(r.status,400);
 }
 assert.equal((await call(f,path+'?download=1',{method:'GET',requestOrigin:null})).status,400);
 f.sqlite.close();
});

test('mobile sharing prepares the file before a click and calls native share within the click gesture',async()=>{
 const {VIEWER_SCRIPT}=await moduleReady,events={},until=Date.now()+60000;
 const nodes={
  'trace-image':{getAttribute:()=>'/s/'+'a'.repeat(64)+'/image.png'},
  'native-share':{hidden:true,disabled:false,addEventListener:(name,callback)=>{events[name]=callback;}},
  status:{textContent:''},expires:{dateTime:new Date(until).toISOString(),textContent:''},
 };
 let finishFetch,fetchCalls=0,shareCalls=0,gestureActive=false;
 const context={
  document:{getElementById:id=>nodes[id]},File,Date,Intl,Promise,
  navigator:{
   canShare:({files})=>files.length===1&&files[0].type==='image/png',
   share:({files})=>{assert.equal(gestureActive,true);assert.equal(files[0].name,'ghosting.png');shareCalls++;return Promise.resolve();},
  },
  fetch:()=>{fetchCalls++;return new Promise(resolve=>{finishFetch=resolve;});},
 };
 vm.runInNewContext(VIEWER_SCRIPT,context);
 assert.equal(fetchCalls,1);assert.equal(nodes['native-share'].hidden,true);
 finishFetch(new Response(PNG,{headers:{'Content-Type':'image/png'}}));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes['native-share'].hidden,false);
 gestureActive=true;events.click();gestureActive=false;
 assert.equal(shareCalls,1,'native share is called synchronously before click activation ends');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes['native-share'].disabled,false);
 const other={...context,fetch:()=>Promise.reject(new Error('offline'))};
 nodes['native-share'].hidden=true;vm.runInNewContext(VIEWER_SCRIPT,other);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes['native-share'].hidden,true,'download remains the fallback if file preparation fails');
});