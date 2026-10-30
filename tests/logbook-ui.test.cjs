const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, scoreValue, frequencies, MAX_VIDEO_BYTES } = require('../logbook/public/app.js');
const html = fs.readFileSync(path.join(__dirname, '../logbook/public/index.html'), 'utf8');
const flush = async () => { for (let i = 0; i < 14; i++) await Promise.resolve(); };
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => body });
const example = (id = 'record-one') => ({
  id, createdAt: '2026-10-20T12:00:00Z', source: 'hand', durationMs: 10000,
  intention: '차분한', details: '두 손을 천천히', hasVideo: true,
  analysis: { impression: '유연한', description: '이어지는 흐름이 느껴집니다.', qualities: ['매끄러운'], observations: ['손이 이어서 움직입니다.'], candidates: [
    { label: '유연한', score: 82, evidence: '끊어지지 않는 이동' },
    { label: '나풀거리는', evidence: '수치는 보고하지 않음' },
  ] },
});

function harness({ session = true, records = [], fetch: customFetch, capture = true, autoSave = false, continuous = false, sessionData = new Map() } = {}) {
  class Element {
    constructor(tagName = 'div', attrs = '') {
      this.tagName = tagName; this.children = []; this.events = new Map(); this.attributes = new Map();
      this.hidden = /\bhidden(?:\s|=|$)/.test(attrs); this.disabled = false; this.open = false; this.style = {};
      this._text = ''; this.value = ''; this.classList = { toggle() {} }; this.src = '';
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ''; this.children = children; }
    addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(callback); }
    dispatch(name, attrs = {}) { return Promise.all((this.events.get(name) || []).map(fn => fn({ preventDefault() {}, target: this, ...attrs }))); }
    click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
    pause() {} load() {} focus() {} remove() {}
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const elements = new Map();
  for (const [, tag, attrs, id] of html.matchAll(/<([a-z][\w:-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) elements.set(id, new Element(tag, attrs));
  const home=new Element('a');home.setAttribute('href','/');
  const serverRecords=new Map(records.map(record=>[record.id,{...record}]));
  const doc = { querySelector(selector){assert.equal(selector,'.site-header .brand');return home;}, getElementById(id) { assert.ok(elements.has(id), `existing HTML element ${id}`); return elements.get(id); }, createElement: tag => new Element(tag), body: new Element('body') };
  const win = new Element('window');
  win.sessionStorage={getItem:key=>sessionData.get(key)??null,setItem:(key,value)=>sessionData.set(key,String(value))};
  const calls = [], messages = [], createdURLs = [], revokedURLs = [];
  const timers = new Map();
  win.location = { search: capture ? (autoSave ? '?capture=1&save=1'+(continuous?'&auto=1':'') : '?capture=1') : '' };
  win.opener = { postMessage: (message, origin) => messages.push({ message, origin }) };
  Object.assign(win, { Blob, FormData, AbortController });
  win.URL = { createObjectURL(blob) { const url = `blob:test-${createdURLs.length}`; createdURLs.push({ url, blob }); return url; }, revokeObjectURL(url) { revokedURLs.push(url); } };
  win.setTimeout = (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'same-origin', 'all private requests include same-origin credentials');
    const custom = await customFetch?.(url, options);
    if (custom) {
      if(custom.ok && url === '/api/records' && options.method === 'POST') {
        const record=JSON.parse(options.body.get('record'));serverRecords.set(record.id,{...record,revision:record.revision||0,state:'ready',hasVideo:Boolean(options.body.get('video'))});
      } else if(custom.ok && url.startsWith('/api/records/') && options.method === 'PUT') {
        const record=JSON.parse(options.body),previous=serverRecords.get(record.id);serverRecords.set(record.id,{...previous,...record,hasVideo:previous?.hasVideo||false,revision:record.revision||0,state:'ready'});
      } else if(custom.ok && options.method === 'DELETE') serverRecords.delete(decodeURIComponent(url.split('/')[3]));
      return custom;
    }
    if (url === '/api/session') return reply({ authenticated: session }, session ? 200 : 401);
    if (url === '/api/login' || url === '/api/logout') return reply({ ok: true });
    if (url === '/api/records' && options.method !== 'POST') return reply({ records:[...serverRecords.values()].map(record=>({...record,impression:record.impression||record.analysis?.impression})) });
    const id=decodeURIComponent(url.split('/')[3]||'');
    if (url.startsWith('/api/records/') && options.method === 'DELETE') {serverRecords.delete(id);return reply({ deleted:true });}
    if (url.startsWith('/api/records/') && options.method === 'PUT') {
      const previous=serverRecords.get(id);if(!previous)return reply({error:{message:'기록을 찾을 수 없어요.'}},404);
      const input=JSON.parse(options.body),revision=Math.max(previous.revision||0,input.revision||0);
      if((input.revision||0)>(previous.revision||0))serverRecords.set(id,{...previous,...input,revision});
      return reply({id,revision,alreadySaved:revision===(previous.revision||0)});
    }
    if (url.startsWith('/api/records/')) return reply({ record: serverRecords.get(id) || example(id) });
    throw new Error(`Unmocked fetch ${url}`);
  };
  const app = createApp(win, doc);
  return {
    win, doc, app, calls, messages, createdURLs, revokedURLs, home, serverRecords, sessionData, get: id => elements.get(id),
    async capture(record = example(), video = new Blob(['mock video'], { type: 'video/webm' }), extra = {}) {
      await win.dispatch('message', { source: win.opener, origin: 'https://yebe9.github.io', data: { type: 'ghosting:capture', record, video }, ...extra });
    },
    async selectFirst() { await elements.get('record-list').children[0].children[0].click(); },
  };
}

test('logbook does not announce ready or show private data until authenticated', async () => {
  const app = harness({ session: false });
  await app.app.start();
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.get('login-panel').hidden, false);
  assert.equal(app.messages.length, 0);
  await app.capture();
  assert.equal(app.get('record-detail').hidden, true);
  app.get('password').value = 'test-password-only';
  await app.get('login-form').dispatch('submit');
  assert.equal(app.get('password').value, '');
  assert.equal(app.get('workspace').hidden, false);
  assert.equal(app.messages.length, 3);
  assert.ok(app.messages.every(item => item.message.type === 'ghosting:ready' && item.origin !== '*'));
});

test('capture requires trusted opener and exact allowed origin, then waits for explicit save', async () => {
  const app = harness();
  await app.app.start();
  await app.capture(example(), undefined, { origin: 'https://evil.test' });
  await app.capture(example(), undefined, { source: {} });
  assert.equal(app.get('record-detail').hidden, true);
  await app.capture();
  assert.equal(app.get('record-detail').hidden, false);
  assert.equal(app.get('pending-actions').hidden, false);
  assert.equal(app.get('detail-intention').textContent, '차분한');
  assert.ok(app.get('record-video').src.startsWith('blob:'));
  assert.equal(app.calls.filter(call => call.options.method === 'POST').length, 0);
  const ordinary = harness({ capture: false });
  await ordinary.app.start(); await ordinary.capture();
  assert.equal(ordinary.get('record-detail').hidden, true);
});

test('save sends reviewed record and video with FormData; successful save replies only to trusted origin', async () => {
  const app = harness({ fetch: (url, options) => url === '/api/records' && options.method === 'POST' ? reply({ id: 'record-one' }) : undefined });
  await app.app.start(); await app.capture(); await app.get('save-capture').click();
  const call = app.calls.find(item => item.options.method === 'POST');
  assert.equal(call.url, '/api/records');
  assert.ok(call.options.body instanceof FormData);
  assert.equal(JSON.parse(call.options.body.get('record')).intention, '차분한');
  assert.equal(call.options.body.get('video').type, 'video/webm');
  assert.equal(app.get('pending-actions').hidden, true);
  const saved = app.messages.find(item => item.message.type === 'ghosting:saved');
  assert.deepEqual(saved, { message: { type: 'ghosting:saved', id: 'record-one',revision:0,storedRevision:0 }, origin: 'https://yebe9.github.io' });
  assert.ok(app.revokedURLs.includes(app.createdURLs[0].url));
});

test('failed save keeps the staged video and permits retry, including idempotent already-saved reply', async () => {
  let attempts = 0;
  const app = harness({ fetch: (url, options) => {
    if (url === '/api/records' && options.method === 'POST') return ++attempts === 1 ? reply({ error: { message: '저장 공간 확인 필요' } }, 503) : reply({ id: 'record-one', alreadySaved: true });
  } });
  await app.app.start(); await app.capture(); await app.get('save-capture').click();
  assert.match(app.get('detail-status').textContent, /저장 공간 확인 필요/);
  assert.equal(app.get('pending-actions').hidden, false);
  assert.equal(app.get('save-capture').disabled, false);
  await app.get('save-capture').click();
  assert.match(app.get('workspace-status').textContent, /이미 저장된/);
  assert.equal(attempts, 2);
});

test('missing, null and invalid scores stay unreported while a genuine zero is displayed', async () => {
  assert.equal(scoreValue(undefined), null); assert.equal(scoreValue(null), null);
  assert.equal(scoreValue('0'), null); assert.equal(scoreValue(101), null); assert.equal(scoreValue(0), 0);
  const app = harness();
  const record = example();
  record.analysis.candidates = [{ label: '<img onerror=alert(1)>', score: null, evidence: '<script>bad</script>' }, { label: '고요한', score: 0 }];
  await app.app.start(); await app.capture(record);
  const rows = app.get('candidate-list').children;
  assert.equal(rows[0].children.length, 2, 'missing score has no bar');
  assert.match(rows[0].textContent, /미보고/);
  assert.ok(rows[0].textContent.includes('<img onerror=alert(1)>'), 'untrusted label remains literal text');
  assert.equal(rows[1].children[1].getAttribute('aria-valuenow'), '0');
});

test('session expiration clears visible private data and video URLs', async () => {
  let expire = false;
  const app = harness({ fetch: url => expire && url === '/api/records' ? reply({}, 401) : undefined });
  await app.app.start(); await app.capture();
  const preview = app.get('record-video').src;
  expire = true;
  await app.get('refresh').click();
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.get('login-panel').hidden, false);
  assert.equal(app.get('detail-intention').textContent, '');
  assert.equal(app.get('record-video').src, '');
  assert.ok(app.revokedURLs.includes(preview));
});

test('new capture cannot silently replace pending data and refresh warns about loss', async () => {
  const app = harness();
  await app.app.start(); await app.capture();
  const newer = { ...example('new'), intention: '빠른' };
  await app.capture(newer);
  assert.equal(app.get('detail-intention').textContent, '차분한');
  assert.match(app.get('workspace-status').textContent, /먼저 받은/);
  let prevented = false;
  await app.win.dispatch('beforeunload', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const cancel = app.get('discard-capture').click();
  await flush();
  assert.equal(app.get('confirm-dialog').open, true);
  await app.get('confirm-accept').click(); await cancel;
  assert.equal(app.get('record-detail').hidden, true);
});

test('oversized or non-video captures are rejected before upload', async () => {
  const app = harness();
  await app.app.start();
  await app.capture(example(), new Blob(['bad'], { type: 'text/html' }));
  assert.equal(app.get('record-detail').hidden, true);
  await app.capture(example(), new Blob([new Uint8Array(MAX_VIDEO_BYTES + 1)], { type: 'video/webm' }));
  assert.equal(app.get('record-detail').hidden, true);
  assert.match(app.get('workspace-status').textContent, /15 MiB/);
});

test('unfinished entries can be deleted from list without loading their detail', async () => {
  const app = harness({ records: [{ ...example(), state: 'pending', impression: '유연한' }] });
  await app.app.start();
  const deletion = app.get('record-list').children[0].children[1].click();
  await flush();
  assert.equal(app.get('confirm-dialog').open, true);
  assert.equal(app.calls.some(call => call.options.method === 'DELETE'), false);
  await app.get('confirm-accept').click(); await deletion;
  assert.ok(app.calls.some(call => call.url === '/api/records/record-one' && call.options.method === 'DELETE'));
  assert.equal(app.calls.some(call => call.url === '/api/records/record-one' && !call.options.method), false);
});

test('late detail response cannot expose private content after logout', async () => {
  let resolveDetail;
  const app = harness({ records: [{ ...example(), impression: '유연한' }], fetch: url => url === '/api/records/record-one' ? new Promise(resolve => { resolveDetail = resolve; }) : undefined });
  await app.app.start();
  const opening = app.selectFirst();
  await flush();
  await app.get('logout').click();
  resolveDetail(reply({ record: example() })); await opening;
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.get('record-detail').hidden, true);
  assert.equal(app.get('detail-intention').textContent, '');
});

test('representative impression frequencies count existing labels without inventing missing ones', () => {
  assert.deepEqual(frequencies([{ impression: '유연한' }, { impression: '유연한' }, { impression: '' }, {}, { impression: '빠른' }]), [['유연한', 2], ['빠른', 1]]);
});

test('rubric exposes missing measurements and ranking mismatch without changing AI scores', async () => {
  const app = harness();
  const record = example();
  record.analysis.rubric = {
    note: '2D 관측의 경험적 기준입니다.',
    eligible: { '유연한': false, '유려한': true },
    metrics: { captureAspect: null, movingRatio: 0 },
    candidateRankingConsistent: false,
  };
  await app.app.start(); await app.capture(record);
  assert.equal(app.get('ranking-note').hidden, false);
  assert.match(app.get('rubric-eligibility').textContent, /유연한: 경험적 기준 미충족/);
  assert.match(app.get('rubric-metrics').textContent, /captureAspect미측정/);
  assert.match(app.get('rubric-metrics').textContent, /movingRatio0/);
  assert.match(app.get('candidate-list').textContent, /82 \/ 100/);
});


test('a save request from the result saves after authenticated receipt without a second click', async () => {
  const app = harness({ autoSave:true, fetch:(url,options) => url === '/api/records' && options.method === 'POST' ? reply({id:'record-one'}) : undefined });
  await app.app.start();
  assert.equal(app.calls.filter(c => c.url === '/api/records' && c.options.method === 'POST').length,0);
  await app.capture(example(),null,{origin:'https://evil.test'});
  assert.equal(app.calls.filter(c => c.options.method === 'POST').length,0);
  await app.capture(example(),null);
  assert.equal(app.calls.filter(c => c.url === '/api/records' && c.options.method === 'POST').length,1);
  assert.ok(app.messages.some(m => m.message.type === 'ghosting:received' && m.message.id === 'record-one'));
  assert.ok(app.messages.some(m => m.message.type === 'ghosting:saved' && m.message.id === 'record-one'));
});

test('resending the same capture while uploading acknowledges receipt without a duplicate upload', async () => {
  let finish;
  const response = new Promise(resolve => {finish=resolve;});
  const app = harness({ autoSave:true,fetch:(url,options) => url === '/api/records' && options.method === 'POST' ? response : undefined });
  await app.app.start();
  const saving = app.capture(example(),null);
  await flush();
  await app.capture(example(),null);
  assert.equal(app.calls.filter(c => c.url === '/api/records' && c.options.method === 'POST').length,1);
  assert.equal(app.messages.filter(m => m.message.type === 'ghosting:received').length,2);
  finish(reply({id:'record-one'}));
  await saving;
  assert.equal(app.messages.filter(m => m.message.type === 'ghosting:saved').length,1);
});

test('automatic save failure preserves the capture and reports the cause to the result for retry', async () => {
  let attempts=0;
  const app = harness({autoSave:true,fetch:(url,options) => {
    if(url === '/api/records' && options.method === 'POST') return ++attempts === 1 ? reply({error:{message:'저장 공간 확인'}},503) : reply({id:'record-one'});
  }});
  await app.app.start(); await app.capture(example(),null);
  assert.equal(app.get('pending-actions').hidden,false);
  assert.match(app.get('detail-status').textContent,/저장 공간 확인/);
  assert.ok(app.messages.some(m => m.message.type === 'ghosting:error' && m.message.id === 'record-one' && m.message.message === '저장 공간 확인'));
  await app.get('save-capture').click();
  assert.equal(attempts,2);
  assert.ok(app.messages.some(m => m.message.type === 'ghosting:saved'));
});

test('expired login resumes a requested automatic save after signing in again', async () => {
  let attempts=0;
  const app = harness({autoSave:true,fetch:(url,options) => {
    if(url === '/api/records' && options.method === 'POST') return ++attempts === 1 ? reply({},401) : reply({id:'record-one'});
  }});
  await app.app.start(); await app.capture(example(),null);
  assert.equal(app.get('login-panel').hidden,false);
  app.get('password').value='test-password-only';
  await app.get('login-form').dispatch('submit');
  assert.equal(attempts,2);
  assert.ok(app.messages.some(m => m.message.type === 'ghosting:saved'));
});


test('a capture arriving during login does not retry a failed automatic save behind the user', async () => {
  let finishList, attempts=0;
  const listResponse=new Promise(resolve=>{finishList=resolve;});
  const app=harness({autoSave:true,fetch:(url,options)=>{
    if(url==='/api/records' && options.method==='POST'){ attempts++; return reply({error:{message:'retry explicitly'}},503); }
    if(url==='/api/records')return listResponse;
  }});
  const starting=app.app.start(); await flush();
  await app.capture(example(),null);
  finishList(reply({records:[]})); await starting;
  assert.equal(attempts,1);
  assert.equal(app.get('pending-actions').hidden,false);
});


test('continuous capture saves later revisions with JSON PUT while preserving the first video upload',async()=>{
 const calls=[];
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>{
  if(url==='/api/records'&&options.method==='POST'){const record=JSON.parse(options.body.get('record'));return reply({id:record.id,revision:record.revision});}
  if(url==='/api/records/record-one'&&options.method==='PUT'){calls.push(JSON.parse(options.body));return reply({id:'record-one',revision:JSON.parse(options.body).revision,updated:true});}
 }});
 await app.app.start();await app.capture({...example(),revision:1});
 const latest={...example(),revision:2,intention:'긴장한',details:'후속 입력'};
 await app.capture(latest,null);
 assert.equal(app.calls.filter(c=>c.url==='/api/records'&&c.options.method==='POST').length,1);
 assert.equal(calls.length,1);assert.equal(calls[0].intention,'긴장한');
 const update=app.calls.find(c=>c.options.method==='PUT');
 assert.equal(update.options.headers['Content-Type'],'application/json');
 assert.equal(app.messages.filter(m=>m.message.type==='ghosting:saved').at(-1).message.revision,2);
});

test('queued newer revisions are serialized and coalesced without discarding earlier receipt acknowledgements',async()=>{
 let finish;const first=new Promise(resolve=>{finish=resolve;});const updates=[];
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>{
  if(url==='/api/records'&&options.method==='POST')return first;
  if(options.method==='PUT'){const record=JSON.parse(options.body);updates.push(record.revision);return reply({id:record.id,revision:record.revision});}
 }});
 await app.app.start();const saving=app.capture({...example(),revision:1});await flush();
 await app.capture({...example(),revision:2},null);await app.capture({...example(),revision:2},null);await app.capture({...example(),revision:3},null);
 assert.equal(updates.length,0,'No overlapping metadata write during video upload');
 finish(reply({id:'record-one',revision:1}));await saving;for(let n=0;n<5;n++)await flush();
 assert.deepEqual(updates,[3]);
 const saved=app.messages.filter(m=>m.message.type==='ghosting:saved').map(m=>m.message.revision);
 assert.deepEqual(saved,[1,2,3]);
 assert.ok(app.messages.filter(m=>m.message.type==='ghosting:received').every(m=>Number.isSafeInteger(m.message.revision)));
});

test('continuous mode accepts the next movement after finishing the previous one',async()=>{
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>{
  if(url==='/api/records'&&options.method==='POST'){const record=JSON.parse(options.body.get('record'));return reply({id:record.id,revision:record.revision});}
 }});
 await app.app.start();await app.capture({...example(),revision:1},null);await app.capture({...example('record-two'),revision:1},null);
 assert.equal(app.calls.filter(c=>c.url==='/api/records'&&c.options.method==='POST').length,2);
 assert.deepEqual(app.messages.filter(m=>m.message.type==='ghosting:saved').map(m=>m.message.id),['record-one','record-two']);
});

test('a restored draft with an existing remote ID upgrades metadata without reuploading its video',async()=>{
 let put;
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>{
  if(url==='/api/records'&&options.method==='POST')return reply({id:'record-one',revision:1,alreadySaved:true});
  if(options.method==='PUT'){put=JSON.parse(options.body);return reply({id:'record-one',revision:3});}
 }});
 await app.app.start();await app.capture({...example(),revision:3,intention:'새 느낌'},null);
 assert.equal(put.intention,'새 느낌');
 assert.ok(app.messages.some(m=>m.message.type==='ghosting:saved'&&m.message.revision===3));
});

test('session expiry and logout report exact pending revisions to the durable parent queue',async()=>{
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>url==='/api/records'&&options.method==='POST'?reply({},401):undefined});
 await app.app.start();await app.capture({...example(),revision:5},null);
 const failure=app.messages.find(m=>m.message.type==='ghosting:error');
 assert.equal(failure.message.id,'record-one');assert.equal(failure.message.revision,5);assert.equal(failure.message.code,'LOGIN_REQUIRED');
 assert.equal(app.get('workspace').hidden,true);
});

test('semantic similarities keep negative values and model provenance distinct from legacy fit scores',async()=>{
 const app=harness();await app.app.start();
 const record={...example(),revision:2,similarity:{method:'fasttext-cosine',model:'cc.ko.300',results:[{label:'나풀거리는',similarity:61,rawCosine:.61},{label:'유연한',similarity:-23.5,rawCosine:-.235,evidence:'단어 벡터 비교'}]}};
 await app.capture(record,null);
 assert.equal(app.get('candidates-heading').textContent,'AI 해석 결과 TOP 5');assert.match(app.get('candidate-description').textContent,/내 의도와 의미 유사도/);
 assert.equal(app.get('candidate-scale').textContent,'코사인 × 100');assert.match(app.get('similarity-provenance').textContent,/cc.ko.300/);
 const row=app.get('candidate-list').children[0];assert.equal(row.children[0].children[0].textContent,'#1 유연한');assert.match(row.children[0].textContent,/-23.5/);assert.equal(app.get('candidate-list').children[1].children[0].children[0].textContent,'#2 나풀거리는');
 assert.equal(row.children[1].getAttribute('aria-valuemin'),'-100');assert.equal(row.children[1].getAttribute('aria-valuenow'),'-23.5');
 assert.equal(row.children[1].children[1].style.width,'11.75%');
});


test('logging in with a previously stored take updates metadata directly without resending a video',async()=>{
 const app=harness({autoSave:true,continuous:true,records:[{...example(),revision:2,state:'ready'}],fetch:(url,options)=>{
  if(options.method==='PUT')return reply({id:'record-one',revision:3});
 }});
 await app.app.start();await app.capture({...example(),revision:3});
 assert.equal(app.calls.filter(c=>c.url==='/api/records'&&c.options.method==='POST').length,0);
 assert.equal(app.calls.filter(c=>c.options.method==='PUT').length,1);
 assert.ok(app.messages.some(m=>m.message.type==='ghosting:saved'&&m.message.revision===3));
});


test('the logo preserves capture, save and continuous mode when reopening the log page',async()=>{
 const capture=harness({autoSave:true,continuous:true});await capture.app.start();
 assert.equal(capture.home.getAttribute('href'),'/logs/?capture=1&save=1&auto=1');
 const ordinary=harness({capture:false});await ordinary.app.start();assert.equal(ordinary.home.getAttribute('href'),'/');
});

test('a cached stored revision does not send a saved acknowledgement until the server verifies it',async()=>{
 let finish;const response=new Promise(resolve=>{finish=resolve;});
 const app=harness({autoSave:true,continuous:true,records:[{...example(),revision:4,state:'ready'}],fetch:(_url,options)=>options.method==='PUT'?response:undefined});
 await app.app.start();const receiving=app.capture({...example(),revision:3},null);await flush();
 assert.equal(app.calls.filter(call=>call.options.method==='PUT').length,1);
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:saved'),false);
 finish(reply({id:'record-one',revision:4,alreadySaved:true}));await receiving;
 const saved=app.messages.find(item=>item.message.type==='ghosting:saved');
 assert.equal(saved.message.revision,3);assert.equal(saved.message.storedRevision,4);
});

test('deleting a record prevents later automatic captures from recreating it and reports the exact revision',async()=>{
 const app=harness({autoSave:true,continuous:true,records:[{...example(),revision:2,state:'ready'}]});
 await app.app.start();await app.selectFirst();
 const deleting=app.get('delete-record').click();await flush();await app.get('confirm-accept').click();await deleting;
 const writes=app.calls.filter(call=>['POST','PUT'].includes(call.options.method)).length;
 await app.capture({...example(),revision:3},null);
 assert.equal(app.calls.filter(call=>['POST','PUT'].includes(call.options.method)).length,writes);
 assert.equal(app.serverRecords.has('record-one'),false);
 const error=app.messages.filter(item=>item.message.type==='ghosting:error').at(-1);
 assert.equal(error.message.id,'record-one');assert.equal(error.message.revision,3);assert.equal(error.message.code,'RECORD_DELETED');
 assert.match(error.message.message,/삭제한 움직임/);
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:saved'),false);
});

test('a missing remote record on PUT becomes an explicit deletion error without a POST fallback',async()=>{
 const app=harness({autoSave:true,continuous:true,records:[{...example(),revision:1,state:'ready'}],fetch:(_url,options)=>options.method==='PUT'?reply({error:{message:'기록을 찾을 수 없어요.'}},404):undefined});
 await app.app.start();await app.capture({...example(),revision:2},null);await app.capture({...example(),revision:3},null);
 assert.equal(app.calls.filter(call=>call.options.method==='PUT').length,1);
 assert.equal(app.calls.some(call=>call.url==='/api/records'&&call.options.method==='POST'),false);
 const failures=app.messages.filter(item=>item.message.type==='ghosting:error');
 assert.deepEqual(failures.map(item=>item.message.revision),[2,3]);assert.ok(failures.every(item=>item.message.code==='RECORD_DELETED'));
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:saved'),false);
});

test('refreshing a list after deletion evicts stale revision caches instead of acknowledging a missing record',async()=>{
 const app=harness({autoSave:true,continuous:true,records:[{...example(),revision:3,state:'ready'}]});await app.app.start();
 app.serverRecords.delete('record-one');await app.get('refresh').click();
 await app.capture({...example(),revision:2},null);
 assert.equal(app.calls.some(call=>['POST','PUT'].includes(call.options.method)),false);
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:saved'),false);
 assert.ok(app.messages.some(item=>item.message.type==='ghosting:error'&&item.message.code==='RECORD_DELETED'));
});

test('the same log window remembers explicit deletions across a page reload',async()=>{
 const sessionData=new Map();
 const app=harness({autoSave:true,continuous:true,sessionData,records:[{...example(),revision:2,state:'ready'}]});
 await app.app.start();await app.selectFirst();const deleting=app.get('delete-record').click();await flush();await app.get('confirm-accept').click();await deleting;
 const reloaded=harness({autoSave:true,continuous:true,sessionData});await reloaded.app.start();
 await reloaded.capture({...example(),revision:3},null);
 assert.equal(reloaded.calls.some(call=>['POST','PUT'].includes(call.options.method)),false);
 assert.ok(reloaded.messages.some(item=>item.message.type==='ghosting:error'&&item.message.id==='record-one'&&item.message.revision===3));
});


test('a confirmed discard reports the exact pending revision only to its trusted parent',async()=>{
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>url==='/api/records'&&options.method==='POST'?reply({error:{message:'일시 저장 실패'}},503):undefined});
 await app.app.start();await app.capture({...example(),revision:5},null);
 const cancelling=app.get('discard-capture').click();await flush();
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:discarded'),false);
 await app.get('confirm-accept').click();await cancelling;
 const cancelled=app.messages.filter(item=>item.message.type==='ghosting:discarded');
 assert.deepEqual(cancelled,[{message:{type:'ghosting:discarded',id:'record-one',revision:5},origin:'https://yebe9.github.io'}]);
 assert.equal(app.get('record-detail').hidden,true);
 let prevented=false;await app.win.dispatch('beforeunload',{preventDefault(){prevented=true;}});assert.equal(prevented,false);
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:saved'),false);
});

test('dismissing the discard confirmation retains the pending video and sends no cancellation',async()=>{
 const app=harness();await app.app.start();await app.capture({...example(),revision:2});
 const cancelling=app.get('discard-capture').click();await flush();await app.get('confirm-cancel').click();await cancelling;
 assert.equal(app.get('record-detail').hidden,false);assert.equal(app.get('pending-actions').hidden,false);
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:discarded'),false);
});

test('a stale discard confirmation cannot discard a newer pending revision',async()=>{
 const app=harness({autoSave:true,continuous:true,fetch:(url,options)=>url==='/api/records'&&options.method==='POST'?reply({error:{message:'일시 저장 실패'}},503):undefined});
 await app.app.start();await app.capture({...example(),revision:1},null);
 const cancelling=app.get('discard-capture').click();await flush();
 await app.capture({...example(),revision:2,intention:'최근 입력'},null);
 await app.get('confirm-accept').click();await cancelling;
 assert.equal(app.messages.some(item=>item.message.type==='ghosting:discarded'),false);
 assert.equal(app.get('detail-intention').textContent,'최근 입력');assert.equal(app.get('pending-actions').hidden,false);
});


test('private log keeps all five AI rows and their movement evidence when similarity is missing or unavailable',async()=>{
 const app=harness();await app.app.start();
 const record=example();record.analysis.candidates=['단호한','가벼운','차분한','날카로운','기계적인'].map((label,index)=>({label,score:80-index,evidence:'원래 움직임 근거 '+index}));
 record.similarity={method:'fasttext-cosine',model:'test-vectors',results:[
   {label:'날카로운',aiRank:4,similarity:82,rawCosine:.82,evidence:'semantic override'},
   {label:'단호한',aiRank:1,similarity:0,rawCosine:0},
   {label:'기계적인',aiRank:5,similarity:null,rawCosine:null}
 ]};
 await app.capture(record,null);
 const rows=app.get('candidate-list').children;assert.equal(rows.length,5);
 assert.deepEqual(rows.map(row=>row.children[0].children[0].textContent),record.analysis.candidates.map((candidate,index)=>'#'+(index+1)+' '+candidate.label));
 assert.match(rows[0].children[0].textContent,/의도 유사도 0/);assert.equal(rows[0].children[1].getAttribute('aria-valuenow'),'0');
 for(const index of [1,2,4]){assert.match(rows[index].children[0].textContent,/측정불가/);assert.equal(rows[index].children.length,2);}
 assert.match(rows[3].children[2].textContent,/원래 움직임 근거 3/);assert.doesNotMatch(rows[3].textContent,/semantic override/);
});
