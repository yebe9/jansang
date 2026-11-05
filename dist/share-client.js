/* Ghosting image sharing: explicit PNG upload and a locally encoded QR. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(globalThis,require('./vendor/qrcode-generator-2.0.4.js'));
  else root.GhostingShare=factory(root,root.qrcode);
})(typeof window!=='undefined'?window:globalThis,function(root,encoder){
  'use strict';
  const MAX_IMAGE_BYTES=1024*1024,MAX_RESPONSE_BYTES=8192,DEADLINE_MS=20000,DAY_MS=86400000;
  const TOKEN_PATH=/^\/s\/[a-f0-9]{64}$/;
  class ShareError extends Error{constructor(code,message,status){super(message);this.name='ShareError';this.code=code;if(status)this.status=status;}}
  const fail=(code,message,status)=>{throw new ShareError(code,message,status);};
  const abortError=()=>Object.assign(new Error('공유 준비를 취소했어요.'),{name:'AbortError'});
  const active=signal=>{if(signal.aborted)throw abortError();};
  function baseURL(value){
    let url;try{url=new URL(typeof value==='string'?value.trim():'');}catch{fail('SHARE_CONFIG','이미지 공유 서버를 확인해 주세요.');}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('SHARE_CONFIG','이미지 공유 서버를 확인해 주세요.');
    return url;
  }
  function sharedURL(value,origin){
    let url;try{url=new URL(typeof value==='string'&&value.length<=512?value:'');}catch{fail('INVALID_SHARE_RESPONSE','공유 주소를 받지 못했어요. 다시 시도해 주세요.');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!TOKEN_PATH.test(url.pathname)||(origin&&url.origin!==origin))fail('INVALID_SHARE_RESPONSE','공유 주소를 받지 못했어요. 다시 시도해 주세요.');
    return url.href;
  }
  async function validatePNG(blob,signal){
    if(!root.Blob||!(blob instanceof root.Blob)||blob.type!=='image/png')fail('INVALID_SHARE_IMAGE','잔상 PNG 이미지만 공유할 수 있어요.');
    if(blob.size<33||blob.size>MAX_IMAGE_BYTES)fail('SHARE_IMAGE_SIZE','공유할 이미지 크기를 확인해 주세요.');
    active(signal);
    const raw=new Uint8Array(await blob.slice(0,24).arrayBuffer());active(signal);
    const expected=[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82];
    if(expected.some((value,index)=>raw[index]!==value))fail('INVALID_SHARE_IMAGE','잔상 PNG 이미지만 공유할 수 있어요.');
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    if(view.getUint32(16)!==1080||view.getUint32(20)!==1350)fail('SHARE_IMAGE_DIMENSIONS','잔상 이미지를 다시 준비해 주세요.');
  }
  async function readJSON(response,signal){
    if(Number(response.headers?.get?.('content-length'))>MAX_RESPONSE_BYTES)fail('INVALID_SHARE_RESPONSE','공유 서버의 응답을 확인하지 못했어요.');
    let text;
    if(response.body?.getReader){
      const reader=response.body.getReader(),chunks=[];let length=0;
      try{while(true){active(signal);const part=await reader.read();active(signal);if(part.done)break;length+=part.value.byteLength;
        if(length>MAX_RESPONSE_BYTES){Promise.resolve(reader.cancel()).catch(()=>{});fail('INVALID_SHARE_RESPONSE','공유 서버의 응답을 확인하지 못했어요.');}chunks.push(part.value);}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}text=new TextDecoder().decode(bytes);
      }finally{try{reader.releaseLock();}catch{}}
    }else{text=await response.text();if(new TextEncoder().encode(text).byteLength>MAX_RESPONSE_BYTES)fail('INVALID_SHARE_RESPONSE','공유 서버의 응답을 확인하지 못했어요.');}
    active(signal);try{return JSON.parse(text);}catch{fail('INVALID_SHARE_RESPONSE','공유 서버의 응답을 확인하지 못했어요.');}
  }
  function responseError(status){
    if(status===429)fail('SHARE_RATE_LIMITED','공유 요청이 많아요. 잠시 후 다시 시도해 주세요.',status);
    if(status===413)fail('SHARE_IMAGE_SIZE','공유할 이미지가 너무 커요. 다시 준비해 주세요.',status);
    if(status===400||status===415)fail('INVALID_SHARE_IMAGE','잔상 이미지를 다시 준비해 주세요.',status);
    fail('SHARE_UNAVAILABLE','이미지 공유를 준비하지 못했어요. 잠시 후 다시 시도해 주세요.',status);
  }
  function createClient({fetchImpl=root.fetch?.bind(root),now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),timeoutMs=DEADLINE_MS}={}){
    async function create(blob,{apiBase,signal}={}){
      const base=baseURL(apiBase);if(signal?.aborted)throw abortError();
      const controller=new AbortController();let timer,aborted,timedOut=false;
      const cancelled=new Promise((_,reject)=>{
        aborted=()=>{reject(abortError());controller.abort();};signal?.addEventListener('abort',aborted,{once:true});
        timer=setTimer(()=>{timedOut=true;reject(new ShareError('SHARE_TIMEOUT','공유 준비가 지연되고 있어요. 다시 시도해 주세요.'));controller.abort();},Math.min(DEADLINE_MS,Math.max(1,Number.isFinite(timeoutMs)?timeoutMs:DEADLINE_MS)));
      });
      const operation=async()=>{
        await validatePNG(blob,controller.signal);active(controller.signal);
        if(typeof fetchImpl!=='function')fail('SHARE_UNAVAILABLE','이 브라우저에서 공유 서버에 연결하지 못했어요.');
        let response;try{response=await fetchImpl(new URL('/api/shares',base).href,{method:'POST',headers:{'Content-Type':'image/png'},body:blob,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});}
        catch(error){active(controller.signal);fail('SHARE_NETWORK','공유 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');}
        active(controller.signal);
        if(!response.ok)responseError(response.status);
        const data=await readJSON(response,controller.signal);active(controller.signal);
        if(!data||typeof data!=='object'||Array.isArray(data))fail('INVALID_SHARE_RESPONSE','공유 정보를 받지 못했어요.');
        const url=sharedURL(data.url,base.origin),expires=typeof data.expiresAt==='string'?Date.parse(data.expiresAt):NaN;
        const remaining=expires-now();if(!Number.isFinite(expires)||remaining<=0||remaining>DAY_MS+60000)fail('INVALID_SHARE_RESPONSE','공유 만료 시간을 확인하지 못했어요. 다시 시도해 주세요.');
        return {url,expiresAt:new Date(expires).toISOString()};
      };
      try{return await Promise.race([operation(),cancelled]);}
      catch(error){if(timedOut&&error?.name==='AbortError')throw new ShareError('SHARE_TIMEOUT','공유 준비가 지연되고 있어요. 다시 시도해 주세요.');throw error;}
      finally{clearTimer(timer);signal?.removeEventListener('abort',aborted);}
    }
    return {create};
  }
  function drawQR(container,value){
    const url=sharedURL(value),doc=container?.ownerDocument||root.document;
    if(!container?.replaceChildren||!doc?.createElementNS||typeof encoder!=='function')fail('QR_UNAVAILABLE','QR 코드를 준비하지 못했어요. 다시 시도해 주세요.');
    const qr=encoder(0,'M');qr.addData(url,'Byte');qr.make();
    const count=qr.getModuleCount(),quiet=4,size=count+quiet*2,ns='http://www.w3.org/2000/svg';
    const svg=doc.createElementNS(ns,'svg');for(const [name,val] of Object.entries({xmlns:ns,viewBox:'0 0 '+size+' '+size,width:size*6,height:size*6,role:'img','aria-label':'휴대폰으로 잔상 이미지를 받는 QR 코드','shape-rendering':'crispEdges'}))svg.setAttribute(name,String(val));
    const background=doc.createElementNS(ns,'rect');for(const [name,val] of Object.entries({width:size,height:size,fill:'#e2eadf'}))background.setAttribute(name,String(val));svg.append(background);
    const data=[];for(let y=0;y<count;y++){let x=0;while(x<count){if(!qr.isDark(y,x)){x++;continue;}const start=x;while(x<count&&qr.isDark(y,x))x++;data.push('M'+(start+quiet)+' '+(y+quiet)+'h'+(x-start)+'v1h-'+(x-start)+'z');}}
    const path=doc.createElementNS(ns,'path');path.setAttribute('d',data.join(''));path.setAttribute('fill','#102024');svg.append(path);container.replaceChildren(svg);return svg;
  }
  return {...createClient(),createClient,drawQR,ShareError,MAX_IMAGE_BYTES,DEADLINE_MS};
});
