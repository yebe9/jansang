const {test}=require('node:test');const assert=require('node:assert/strict');
const {Client}=require('../dist/private-log-client.js');
function harness({saved=new Map(),failPut=false}={}){
 const messages=[],states=[],windows=[];const store={all:async()=>[...saved.values()],put:async d=>{if(failPut)throw new Error('quota');saved.set(d.id,d);},delete:async id=>{saved.delete(id);}};
 const win={addEventListener(){},removeEventListener(){},open(url,name){const popup={url,name,closed:false,postMessage(data,origin){messages.push({data,origin});}};windows.push(popup);return popup;}};
 const client=new Client({base:'https://private.example',win,store,minSyncIntervalMs:0,ackTimeoutMs:0,onState:s=>states.push(s)});
 const record=(revision=1,id='take-one')=>({id,revision,intention:'차분한',createdAt:'2026-10-30T00:00:00Z'});
 const receive=(data,extra={})=>client.receive({source:client.popup,origin:'https://private.example',data,...extra});
 return {client,store,saved,messages,states,windows,record,receive};
}
test('automatic records are durable locally before authentication and never open an unsolicited window',async()=>{
 const h=harness();await h.client.enqueue(h.record(),new Blob(['private video']));assert.equal(h.saved.size,1);assert.equal(h.windows.length,0);assert.equal(h.messages.length,0);assert.match(h.states.at(-1).message,/기기에 자동 보관/);
});
test('pending video and metadata restore across page reload until owner signs in',async()=>{
 const saved=new Map();const one=harness({saved});await one.client.enqueue(one.record(),new Blob(['video']));one.client.dispose();
 const two=harness({saved});await two.client.ready;assert.equal(two.client.queue.size,1);two.client.prepare();await two.receive({type:'ghosting:ready'});assert.equal(two.messages[0].data.video.size,5);assert.equal(two.messages[0].data.record.intention,'차분한');
});
test('private login handshake requires exact origin and opened window identity',async()=>{
 const h=harness();await h.client.enqueue(h.record());h.client.prepare();await h.receive({type:'ghosting:ready'},{origin:'https://evil.example'});await h.receive({type:'ghosting:ready'},{source:{}});assert.equal(h.messages.length,0);await h.receive({type:'ghosting:ready'});assert.equal(h.messages.length,1);assert.equal(h.messages[0].origin,'https://private.example');assert.match(h.windows[0].url,/capture=1&save=1&auto=1/);
});
test('a newer intention revision survives acknowledgement for an older upload',async()=>{
 const h=harness();await h.client.enqueue(h.record(1));h.client.prepare();await h.receive({type:'ghosting:ready'});await h.client.enqueue({...h.record(2),intention:'경쾌한'});assert.equal(h.messages.length,1);
 await h.receive({type:'ghosting:saved',id:'take-one',revision:1});assert.equal(h.saved.get('take-one').revision,2);assert.equal(h.messages[1].data.record.intention,'경쾌한');
 await h.receive({type:'ghosting:saved',id:'take-one',revision:1});assert.equal(h.saved.size,1,'stale acknowledgement cannot erase revision 2');
 await h.receive({type:'ghosting:saved',id:'take-one',revision:2});assert.equal(h.saved.size,0);assert.equal(h.client.queue.size,0);
});
test('repeated readiness resends one immutable upload while different record acknowledgements are ignored',async()=>{
 const h=harness();await h.client.enqueue(h.record());h.client.prepare();await h.receive({type:'ghosting:ready'});await h.receive({type:'ghosting:ready'});assert.equal(h.messages.length,2);assert.equal(h.messages[0].data.record.revision,h.messages[1].data.record.revision);await h.receive({type:'ghosting:saved',id:'someone-else',revision:1});assert.equal(h.saved.size,1);
});
test('online save failure preserves the durable draft and a user gesture can reconnect',async()=>{
 const h=harness();await h.client.enqueue(h.record());h.client.prepare();await h.receive({type:'ghosting:ready'});await h.receive({type:'ghosting:error',id:'take-one',revision:1,message:'로그인이 필요해요'});assert.equal(h.saved.size,1);assert.equal(h.client.authenticated,false);assert.match(h.states.at(-1).message,/로그인/);h.client.prepare();assert.equal(h.windows.length,2);await h.receive({type:'ghosting:ready'});assert.equal(h.messages.length,2);
});
test('a local storage error remains explicit and is never reported as successful offline storage',async()=>{
 const h=harness({failPut:true});await h.client.enqueue(h.record());assert.equal(h.saved.size,0);assert.equal(h.states.at(-1).kind,'error');assert.match(h.states.at(-1).message,/quota/);assert.equal(h.messages.length,0);
});
test('two pending takes upload serially and release video only after matching server confirmation',async()=>{
 const h=harness();await h.client.enqueue(h.record(1,'first'));await h.client.enqueue(h.record(1,'second'));h.client.prepare();await h.receive({type:'ghosting:ready'});assert.equal(h.messages[0].data.record.id,'first');await h.receive({type:'ghosting:saved',id:'first',revision:1});assert.equal(h.messages[1].data.record.id,'second');assert.equal(h.saved.size,1);await h.receive({type:'ghosting:saved',id:'second',revision:1});assert.equal(h.saved.size,0);
});

test('production sync interval retains the existing write limit and coalesces newer input durably',async()=>{
 let clock=1000,timer;const saved=new Map(),messages=[];
 const popup={closed:false,postMessage:data=>messages.push(data)};
 const win={addEventListener(){},removeEventListener(){},open:()=>popup};
 const client=new Client({base:'https://private.example',win,ackTimeoutMs:0,store:{all:async()=>[],put:async d=>saved.set(d.id,d),delete:async id=>saved.delete(id)},now:()=>clock,setTimer:(fn,ms)=>{timer={fn,ms};return 1;},clearTimer(){}});
 const record=revision=>({id:'take',revision});
 await client.enqueue(record(1));client.prepare();const event=data=>({source:popup,origin:'https://private.example',data});
 await client.receive(event({type:'ghosting:ready'}));await client.receive(event({type:'ghosting:saved',id:'take',revision:1}));
 await client.enqueue(record(2));await client.enqueue(record(3));assert.equal(messages.length,1);assert.equal(saved.get('take').revision,3);assert.equal(timer.ms,8000);
 clock+=8000;timer.fn();assert.equal(messages.length,2);assert.equal(messages[1].record.revision,3);
});

test('explicit discard suppresses only that take and does not block later recordings',async()=>{
 const h=harness();await h.client.enqueue(h.record(1,'first'));await h.client.enqueue(h.record(1,'next'));h.client.prepare();await h.receive({type:'ghosting:ready'});
 await h.receive({type:'ghosting:discarded',id:'first',revision:1});assert.equal(h.saved.has('first'),false);assert.equal(h.messages.at(-1).data.record.id,'next');
 await h.client.enqueue(h.record(2,'first'));assert.equal(h.saved.has('first'),false);
});
test('server deletion is respected instead of retrying that take ahead of all newer recordings',async()=>{
 const h=harness();await h.client.enqueue(h.record(1,'first'));await h.client.enqueue(h.record(1,'next'));h.client.prepare();await h.receive({type:'ghosting:ready'});
 await h.receive({type:'ghosting:error',id:'first',revision:1,code:'RECORD_DELETED'});assert.equal(h.saved.has('first'),false);assert.equal(h.messages.at(-1).data.record.id,'next');
});

test('a missing acknowledgement becomes a recoverable error while preserving the durable draft',async()=>{
 const callbacks=[],states=[],saved=new Map();const popup={closed:false,postMessage(){}};
 const win={addEventListener(){},removeEventListener(){},open:()=>popup};
 const client=new Client({base:'https://private.example',win,minSyncIntervalMs:0,store:{all:async()=>[],put:async d=>saved.set(d.id,d),delete:async id=>saved.delete(id)},onState:s=>states.push(s),setTimer:(fn,ms)=>{callbacks.push({fn,ms});return callbacks.length;},clearTimer(){}});
 await client.enqueue({id:'draft',revision:1});client.prepare();await client.receive({source:popup,origin:'https://private.example',data:{type:'ghosting:ready'}});assert.equal(callbacks[0].ms,60000);callbacks[0].fn();assert.equal(saved.size,1);assert.equal(client.needsReconnect,true);assert.match(states.at(-1).message,/기기에 보관/);
});
