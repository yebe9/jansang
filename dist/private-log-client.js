/* Durable automatic recording queue. Video stays private until owner authentication. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GhostingPrivateLogs=api;})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  function browserStore(win){
    let opening;
    function db(){return opening||=(new Promise((resolve,reject)=>{
      if(!win.indexedDB){reject(new Error('이 브라우저에서 자동 보관 저장소를 열 수 없어요.'));return;}
      const request=win.indexedDB.open('ghosting-private-drafts',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'id'});
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('다른 잔상 탭을 닫고 다시 열어주세요.'));
    }));}
    async function run(mode,action){const database=await db();return new Promise((resolve,reject)=>{
      const tx=database.transaction('drafts',mode);const req=action(tx.objectStore('drafts'));let result;
      req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error||req.error);tx.onabort=()=>reject(tx.error||new Error('자동 보관이 중단됐어요.'));
    });}
    return {all:()=>run('readonly',s=>s.getAll()),put:value=>run('readwrite',s=>s.put(value)),delete:id=>run('readwrite',s=>s.delete(id))};
  }
  class Client{
    constructor({base,win=window,store,onState=()=>{},minSyncIntervalMs=8000,ackTimeoutMs=60000,now=()=>Date.now(),setTimer,clearTimer}){
      this.win=win;this.base=base;this.onState=onState;this.store=store||browserStore(win);
      this.interval=Math.max(0,minSyncIntervalMs);this.now=now;this.setTimer=setTimer||((f,ms)=>win.setTimeout(f,ms));this.clearTimer=clearTimer||(id=>win.clearTimeout(id));this.lastSentAt=-Infinity;this.syncTimer=null;this.confirmed=0;this.ackTimeout=ackTimeoutMs;this.ackTimer=null;this.suppressed=new Set();
      this.queue=new Map();this.popup=null;this.authenticated=false;this.inflight=null;this.needsReconnect=false;this.persistence=new Map();
      const url=new URL(base);if(url.protocol!=='https:')throw new Error('비공개 기록함은 HTTPS 주소여야 해요.');this.origin=url.origin;
      this.listener=event=>{void this.receive(event);};win.addEventListener('message',this.listener);
      this.ready=this.restore();
    }
    emit(kind,message){this.onState({kind,message,pending:this.queue.size});}
    async restore(){try{for(const draft of await this.store.all()){if(draft&&draft.record?.id===draft.id&&Number.isInteger(draft.revision))this.queue.set(draft.id,draft);}if(this.queue.size)this.emit('queued','이 기기에 남은 기록을 찾았어요. 기록함에 로그인하면 자동 동기화합니다.');}catch(error){this.emit('error',error.message||'자동 보관 저장소를 열지 못했어요.');}}
    prepare(){
      try{if(this.popup&&!this.popup.closed&&!this.needsReconnect){if(!this.authenticated)this.popup.focus?.();this.pump();return this.popup;}
        const url=new URL('/logs/',this.base);url.search='?capture=1&save=1&auto=1';
        this.popup=this.win.open(url.href,'ghosting-private-records');this.authenticated=false;this.needsReconnect=false;
        if(!this.popup){this.emit('queued','이 기기에 자동 보관합니다. 비공개 기록함을 열어 로그인하면 온라인에 동기화돼요.');return null;}
        this.emit('connecting','열린 비공개 기록함에서 로그인하면 영상과 결과가 자동 동기화됩니다.');return this.popup;
      }catch(error){this.emit('error',error.message);return null;}
    }
    async enqueue(record,video=null){
      await this.ready;
      if(!record||typeof record.id!=='string'||!Number.isSafeInteger(record.revision)||record.revision<1)throw new Error('자동 보관 기록 번호를 확인해 주세요.');
      if(this.suppressed.has(record.id)){this.emit('cancelled','이 움직임의 보관을 취소했어요. 새 움직임부터 자동 보관합니다.');return;}
      const previous=this.queue.get(record.id);
      if(previous&&previous.revision>=record.revision)return;
      const draft={id:record.id,record,video:video||previous?.video||null,revision:record.revision};
      this.queue.set(record.id,draft);
      const previousWrite=this.persistence.get(record.id)||Promise.resolve();
      const write=previousWrite.catch(()=>{}).then(()=>this.store.put(draft));this.persistence.set(record.id,write);
      try{await write;this.emit('queued',this.authenticated?'영상과 결과를 비공개 기록함에 동기화하고 있어요.':'이 기기에 자동 보관했어요. 비공개 기록함에 로그인하면 온라인에도 동기화됩니다.');}
      catch(error){this.emit('error','기기 보관 실패: '+(error.message||'저장 공간을 확인해 주세요.'));}
      this.pump();
    }
    throttle(){const wait=this.interval-(this.now()-this.lastSentAt);if(wait<=0)return false;if(this.syncTimer===null)this.syncTimer=this.setTimer(()=>{this.syncTimer=null;if(this.inflight)this.send();else this.pump();},wait);return true;}
    send(){
      if(!this.inflight||!this.popup||this.popup.closed)return;
      if(this.throttle())return;this.lastSentAt=this.now();
      try{this.popup.postMessage({type:'ghosting:capture',record:this.inflight.record,video:this.inflight.video},this.origin);
        if(this.ackTimer!==null)this.clearTimer(this.ackTimer);
        if(this.ackTimeout>0)this.ackTimer=this.setTimer(()=>{this.ackTimer=null;this.inflight=null;this.authenticated=false;this.needsReconnect=true;this.emit('error','기기에 보관 중 · 기록함 연결이 지연됐어요. 상단 비공개 로그를 열면 다시 연결합니다.');},this.ackTimeout);}
      catch(error){this.inflight=null;this.authenticated=false;this.needsReconnect=true;this.emit('error','기록함으로 보내지 못했어요. 기기 보관 기록은 다시 동기화할 수 있습니다.');}
    }
    pump(){
      if(!this.authenticated||!this.popup||this.popup.closed||this.inflight)return;
      const next=this.queue.values().next().value;
      if(!next){this.emit(this.confirmed?'saved':'ready',this.confirmed?'영상과 결과를 비공개 기록함에 자동 보관했어요.':'비공개 기록함에 연결됐어요. 새 움직임을 자동 보관합니다.');return;}
      if(this.throttle())return;this.inflight=next;this.send();
    }
    async receive(event){
      if(!this.popup||event.source!==this.popup||event.origin!==this.origin||!event.data)return;
      const data=event.data;
      if(data.type==='ghosting:ready'){
        await this.ready;this.authenticated=true;this.needsReconnect=false;
        if(this.inflight)this.send();else this.pump();return;
      }
      if(!this.inflight||data.id!==this.inflight.id||data.revision!==this.inflight.revision)return;
      if(data.type==='ghosting:saved'||data.type==='ghosting:error'||data.type==='ghosting:discarded'){
        if(this.ackTimer!==null){this.clearTimer(this.ackTimer);this.ackTimer=null;}
      }
      if(data.type==='ghosting:discarded'||(data.type==='ghosting:error'&&data.code==='RECORD_DELETED')){
        const id=this.inflight.id;this.suppressed.add(id);this.queue.delete(id);this.inflight=null;
        const cleanup=(this.persistence.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.store.delete(id));this.persistence.set(id,cleanup);
        try{await cleanup;}catch{this.emit('error','기기의 취소 기록을 정리하지 못했어요.');}
        this.emit('cancelled','선택한 움직임의 자동 보관을 취소했어요.');this.pump();return;
      }
      if(data.type==='ghosting:saved'){
        const saved=this.inflight;const latest=this.queue.get(saved.id);
        if(latest?.revision===saved.revision){
          this.queue.delete(saved.id);
          // Serialize deletion with puts so an in-flight newer input cannot be erased.
          const write=(this.persistence.get(saved.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
            const current=this.queue.get(saved.id);if(current)await this.store.put(current);else await this.store.delete(saved.id);
          });this.persistence.set(saved.id,write);
          try{await write;}catch{this.emit('error','온라인 저장은 완료됐어요. 기기의 대기 기록 정리를 다시 시도합니다.');}
        }
        this.confirmed++;this.inflight=null;this.pump();
      }else if(data.type==='ghosting:error'){
        this.inflight=null;this.authenticated=false;this.needsReconnect=true;
        this.emit('error','기기에 보관 중 · '+(typeof data.message==='string'?data.message:'비공개 기록함에서 다시 로그인해 주세요.'));
      }
    }
    dispose(){this.win.removeEventListener('message',this.listener);if(this.syncTimer!==null)this.clearTimer(this.syncTimer);if(this.ackTimer!==null)this.clearTimer(this.ackTimer);}
  }
  return {Client,browserStore};
});
