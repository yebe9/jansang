// Public, opt-in trace images only. This Worker has no private logbook bindings.
export const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_SHARE_BYTES = 100 * 1024 * 1024;
export const MAX_SHARES = 200;
export const IMAGE_WIDTH = 1080;
export const IMAGE_HEIGHT = 1350;
const encoder = new TextEncoder();
const BASE_HEADERS = {
  'Cache-Control':'private, no-store, max-age=0',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'X-Robots-Tag':'noindex, nofollow, noarchive',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
};
class ShareError extends Error {
  constructor(status,code,message){super(message);Object.assign(this,{status,code});}
}
const fail=(status,code,message)=>{throw new ShareError(status,code,message);};
function response(body,status=200,headers={}){return new Response(body,{status,headers:{...BASE_HEADERS,...headers}});}
function json(value,status=200,headers={}){return response(JSON.stringify(value),status,{'Content-Type':'application/json; charset=utf-8',...headers});}
function origins(env){return new Set((env.ALLOWED_ORIGINS||'https://yebe9.github.io,http://127.0.0.1:4173,http://localhost:4173').split(',').map(x=>x.trim()).filter(Boolean));}
function cors(request,env){const origin=request.headers.get('origin');return origin&&origins(env).has(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'}:{};}
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
async function tokenHash(token){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(token))));}
function newToken(){return hex(crypto.getRandomValues(new Uint8Array(32)));}
function database(env){if(!env.SHARE_DB?.prepare)fail(503,'NOT_CONFIGURED','이미지 공유 저장소를 준비하고 있어요. 잠시 후 다시 시도해 주세요.');return env.SHARE_DB;}
async function limitUploads(request,env){
 if(!env.SHARE_LIMITER?.limit||!env.TOTAL_SHARE_LIMITER?.limit)fail(503,'NOT_CONFIGURED','이미지 공유를 준비하고 있어요. 잠시 후 다시 시도해 주세요.');
 const visitor=request.headers.get('CF-Connecting-IP')||'unknown';
 if(!(await env.SHARE_LIMITER.limit({key:visitor})).success||!(await env.TOTAL_SHARE_LIMITER.limit({key:'image-shares'})).success)fail(429,'RATE_LIMITED','이미지를 여러 번 나눴어요. 1분 뒤 다시 시도해 주세요.');
}
async function boundedImage(request){
 if(!/^image\/png(?:\s*;.*)?$/i.test(request.headers.get('content-type')||''))fail(415,'PNG_REQUIRED','PNG 잔상 이미지만 공유할 수 있어요.');
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_IMAGE_BYTES))fail(413,'IMAGE_TOO_LARGE','공유 이미지는 1MB 이하여야 해요.');
 if(!request.body)fail(400,'INVALID_PNG','잔상 이미지를 다시 만들어 주세요.');
 const reader=request.body.getReader(),chunks=[];let total=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_IMAGE_BYTES){await reader.cancel();fail(413,'IMAGE_TOO_LARGE','공유 이미지는 1MB 이하여야 해요.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes,start,end){let c=0xffffffff;for(let i=start;i<end;i++)c=CRC_TABLE[(c^bytes[i])&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function validatePNG(bytes){
 const signature=[137,80,78,71,13,10,26,10];
 if(!(bytes instanceof Uint8Array)||bytes.length<57||bytes.length>MAX_IMAGE_BYTES||signature.some((v,i)=>bytes[i]!==v))fail(400,'INVALID_PNG','잔상 이미지를 다시 만들어 주세요.');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,chunks=0,hasData=false,ended=false;
 while(offset<bytes.length){
  if(offset+12>bytes.length||++chunks>4096)fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.');
  const size=view.getUint32(offset),type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
  if(size>MAX_IMAGE_BYTES||offset+12+size>bytes.length||!/^[A-Za-z]{4}$/.test(type)||crc32(bytes,offset+4,offset+8+size)!==view.getUint32(offset+8+size))fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.');
  if(chunks===1){
   if(type!=='IHDR'||size!==13||view.getUint32(offset+8)!==IMAGE_WIDTH||view.getUint32(offset+12)!==IMAGE_HEIGHT||bytes[offset+16]!==8||![2,6].includes(bytes[offset+17])||bytes[offset+18]!==0||bytes[offset+19]!==0||bytes[offset+20]>1)fail(400,'INVALID_PNG','1080 × 1350 크기의 잔상 이미지를 다시 만들어 주세요.');
  }else if(type==='IHDR')fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.');
  if(type[0]===type[0].toUpperCase()&&!['IHDR','PLTE','IDAT','IEND'].includes(type))fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.'); if(['acTL','fcTL','fdAT'].includes(type))fail(400,'INVALID_PNG','움직이는 영상 대신 잔상 이미지만 공유할 수 있어요.');
  if(type==='IDAT'){if(size===0)fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.');hasData=true;}
  if(type==='IEND'){if(size!==0||!hasData||offset+12!==bytes.length)fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.');ended=true;}
  offset+=12+size;if(ended)break;
 }
 if(!ended)fail(400,'INVALID_PNG','PNG 이미지 형식을 확인해 주세요.');return bytes;
}
export async function cleanupExpired(env,{now=Date.now()}={}){return database(env).prepare('DELETE FROM image_shares WHERE expires_at <= ?').bind(now).run();}
const CSS='*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;padding:30px 18px 42px;background:#111b20;color:#e1e8e4;font-family:Arial,"Malgun Gothic",sans-serif}main{max-width:560px;margin:auto}.brand{font-size:23px;font-weight:500;margin:0 0 30px}.eyebrow{font:10px monospace;letter-spacing:2px;color:#8fa99d}h1{font-size:28px;line-height:1.45;font-weight:500;margin:12px 0 10px}p{font-size:13px;line-height:1.8;color:#a7beb2}img{display:block;width:100%;height:auto;border:1px solid #57736555;border-radius:12px;background:#111b20;margin:22px 0}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.button{display:block;min-height:48px;border-radius:7px;padding:14px 12px;text-align:center;text-decoration:none;font:600 14px Arial,sans-serif;border:1px solid #7c9c8755;background:#213438;color:#dce7de;cursor:pointer}.primary{background:#e3ad90;border-color:#e3ad90;color:#192b2a}.small{font-size:11px;color:#829d8e;margin-top:20px}button:disabled{opacity:.5;cursor:wait}[hidden]{display:none!important}#status{min-height:24px}.error{padding:48px 0}a{color:#e5b193}';
function page(title,body,status=200){return response('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>'+title+'</title><style>'+CSS+'</style></head><body><main><p class="brand">잔상</p>'+body+'</main></body></html>',status,{'Content-Type':'text/html; charset=utf-8'});}
function unavailable(){return page('잔상 · 공유가 끝났어요','<section class="error"><p class="eyebrow">A MOMENT HAS PASSED</p><h1>이 잔상은 더 이상<br>열 수 없어요.</h1><p>공유 시간이 지났거나 링크가 올바르지 않습니다.</p><p>체험 화면에서 새로운 QR을 받아 주세요.</p></section>',410);}
function viewer(token,expiresAt){const url='/s/'+token+'/image.png';return page('잔상 · 내 움직임을 간직하기','<p class="eyebrow">YOUR TRACE, TO KEEP</p><h1>당신이 남긴 잔상.</h1><p>이미지를 저장하고 움직임의 순간을 간직하세요.</p><img id="trace-image" src="'+url+'" width="1080" height="1350" alt="내 움직임이 남긴 잔상 이미지"><div class="actions"><a class="button primary" id="download" href="'+url+'?download=1" download="ghosting.png">이미지 저장</a><button class="button" id="native-share" hidden>공유하기</button></div><p id="status" role="status"></p><p class="small">이 링크는 <time id="expires" datetime="'+new Date(expiresAt).toISOString()+'">'+new Date(expiresAt).toISOString()+'</time>까지 열 수 있어요.</p><script src="/share.js" defer></script>');}
function viewerClient(){
 'use strict';
 const image=document.getElementById('trace-image'),button=document.getElementById('native-share'),status=document.getElementById('status'),expires=document.getElementById('expires');
 const until=expires?Date.parse(expires.dateTime):NaN;
 if(expires&&Number.isFinite(until))expires.textContent=new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(until));
 if(!image||!button||!navigator.canShare||!navigator.share)return;
 let shareFile=null;
 // Prefetch before the click so mobile browsers retain transient activation.
 fetch(image.getAttribute('src'),{cache:'no-store'}).then(async result=>{
  if(!result.ok)return;
  const blob=await result.blob();if(blob.type!=='image/png')return;
  const file=new File([blob],'ghosting.png',{type:'image/png'});
  if(!navigator.canShare({files:[file]}))return;
  shareFile=file;button.hidden=false;
 }).catch(()=>{});
 button.addEventListener('click',()=>{
  if(!shareFile||button.disabled)return;
  if(Number.isFinite(until)&&Date.now()>=until){status.textContent='공유 시간이 지났어요. 새로운 QR을 받아 주세요.';button.hidden=true;return;}
  button.disabled=true;
  try{
   Promise.resolve(navigator.share({files:[shareFile],title:'잔상'})).then(()=>{status.textContent='';},error=>{
    if(error.name!=='AbortError')status.textContent='공유 메뉴를 열지 못했어요. 이미지 저장을 이용해 주세요.';
   }).finally(()=>{button.disabled=false;});
  }catch(_){status.textContent='이미지 저장을 이용해 주세요.';button.disabled=false;}
 });
}
export const VIEWER_SCRIPT='('+viewerClient.toString()+')();';
async function findShare(env,token,now){const row=await database(env).prepare('SELECT expires_at, byte_size FROM image_shares WHERE token_hash = ?').bind(await tokenHash(token)).first();return row&&Number(row.expires_at)>now?row:null;}
function imageBytes(value){if(value instanceof ArrayBuffer)return new Uint8Array(value);if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);if(Array.isArray(value)&&value.every(v=>Number.isInteger(v)&&v>=0&&v<=255))return Uint8Array.from(value);fail(503,'STORAGE_UNAVAILABLE','이미지를 읽지 못했어요. 잠시 후 다시 시도해 주세요.');}
export async function handleShare(request,env,{now=Date.now()}={}){
 const url=new URL(request.url),corsHeaders=cors(request,env);
 try{
  if(url.pathname==='/api/shares'){
   if(!request.headers.get('origin')||!origins(env).has(request.headers.get('origin')))fail(403,'ORIGIN_DENIED','잔상 체험 화면에서 공유해 주세요.');
   if(request.method==='OPTIONS')return response(null,204,corsHeaders);
   if(request.method!=='POST')fail(405,'METHOD_NOT_ALLOWED','POST 요청만 가능합니다.');
   const db=database(env);await limitUploads(request,env);const image=validatePNG(await boundedImage(request));
   await cleanupExpired(env,{now});const token=newToken(),hash=await tokenHash(token),expiresAt=now+SHARE_TTL_MS;
   // The budget check and insert are one serialized SQLite statement.
   const stored=await db.prepare('INSERT INTO image_shares (token_hash, created_at, expires_at, byte_size, image) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM image_shares) < ? AND (SELECT COALESCE(SUM(byte_size), 0) FROM image_shares) + ? <= ?').bind(hash,now,expiresAt,image.byteLength,image.buffer.slice(image.byteOffset,image.byteOffset+image.byteLength),MAX_SHARES,image.byteLength,MAX_SHARE_BYTES).run();
   if(Number(stored.meta?.changes)!==1)fail(503,'SHARE_CAPACITY','공유 보관함이 잠시 가득 찼어요. 이미지 저장을 이용해 주세요.');
   return json({url:new URL('/s/'+token,url.origin).href,expiresAt:new Date(expiresAt).toISOString()},201,corsHeaders);
  }
  if(request.method!=='GET'&&request.method!=='HEAD')fail(405,'METHOD_NOT_ALLOWED','GET 요청만 가능합니다.');
  if(url.pathname==='/share.js')return response(request.method==='HEAD'?null:VIEWER_SCRIPT,200,{'Content-Type':'text/javascript; charset=utf-8'});
  const match=url.pathname.match(/^\/s\/([a-f0-9]{64})(\/image\.png)?$/);
  if(!match)return page('잔상 · 공유 이미지','<p class="eyebrow">TRACES OF MOVEMENT</p><h1>QR로 잔상을 받아 보세요.</h1><p>체험 결과 화면에서 ‘폰으로 받기’를 눌러 주세요.</p>',404);
  const [,token,imagePath]=match; if([...url.searchParams].some(([key,value])=>key!=='download'||value!=='1')||url.searchParams.getAll('download').length>1||(!imagePath&&url.search))fail(400,'INVALID_LINK','공유 링크를 다시 확인해 주세요.'); const row=await findShare(env,token,now);
  if(!row)return imagePath?response('공유 시간이 지났거나 링크가 올바르지 않습니다.',410,{'Content-Type':'text/plain; charset=utf-8'}):unavailable();
  if(!imagePath){const result=viewer(token,Number(row.expires_at));return request.method==='HEAD'?response(null,result.status,Object.fromEntries(result.headers)):result;}
  const headers={'Content-Type':'image/png','Content-Disposition':(url.searchParams.get('download')==='1'?'attachment':'inline')+'; filename="ghosting.png"'};
  if(request.method==='HEAD')return response(null,200,headers);
  const stored=await database(env).prepare('SELECT image, byte_size FROM image_shares WHERE token_hash = ? AND expires_at > ?').bind(await tokenHash(token),now).first();
  if(!stored)return response('공유가 끝났습니다.',410,{'Content-Type':'text/plain; charset=utf-8'});
  const bytes=imageBytes(stored.image);if(bytes.byteLength!==Number(stored.byte_size))fail(503,'STORAGE_UNAVAILABLE','이미지를 읽지 못했어요.');return response(bytes,200,headers);
 }catch(error){if(error instanceof ShareError)return json({error:{code:error.code,message:error.message}},error.status,{...corsHeaders,...(error.status===429?{'Retry-After':'60'}:{})});return json({error:{code:'SHARE_UNAVAILABLE',message:'이미지 공유를 잠시 사용할 수 없어요. 이미지 저장을 이용해 주세요.'}},503,corsHeaders);}
}
export default {fetch:(request,env)=>handleShare(request,env),scheduled:(_controller,env,ctx)=>ctx.waitUntil(cleanupExpired(env))};