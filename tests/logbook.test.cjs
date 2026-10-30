const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const moduleReady = import('../logbook/worker.mjs');
const base = 'https://ghosting-logbook.example';
const now = 1792512000000;
const password = 'a-long-test-only-owner-password';
const salt = 'test-only-random-salt';
let digest;
async function fixture() {
  const { passwordDigest } = await moduleReady;
  digest ||= await passwordDigest(password, salt);
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(require.resolve('../logbook/schema.sql'), 'utf8'));
  const videos = new Map();
  let videoReads = 0;
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const wrapped = (args = []) => ({
        bind: (...values) => wrapped(values),
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } }),
      });
      return wrapped();
    },
    batch: async operations => Promise.all(operations.map(op => op.run())),
  };
  return {
    sqlite, videos, reads: () => videoReads,
    env: {
      DB: db, VIDEOS: {
        put: async (key, value) => videos.set(key, value.slice(0)),
        get: async key => { videoReads++; return videos.get(key)?.slice(0) ?? null; },
        delete: async key => videos.delete(key),
      },
      LOGBOOK_PASSWORD_HASH: digest, LOGBOOK_PASSWORD_SALT: salt,
      LOGIN_LIMITER: { limit: async () => ({ success: true }) },
      WRITE_LIMITER: { limit: async () => ({ success: true }) },
      ASSETS: { fetch: async () => new Response('<h1>login</h1>', { headers: { 'Content-Type': 'text/html' } }) },
    },
  };
}
function request(path, options = {}) {
  const { cookie, origin = base, ...rest } = options;
  return new Request(base + path, {
    ...rest, headers: { ...(origin && { Origin: origin }), ...(cookie && { Cookie: cookie }), ...rest.headers },
  });
}
async function call(f, path, options, time = now) {
  return (await moduleReady).handleLogbook(request(path, options), f.env, { now: time });
}
async function login(f) {
  const response = await call(f, '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
function record() {
  return {
    id: randomUUID(), createdAt: new Date(now).toISOString(), source: 'hand', handTarget: 'indexTip',
    durationMs: 10000, intention: '경쾌한', details: '나만의 설명', metrics: { meanSpeed: 0.2 },
    analysis: { impression: '분주한', description: '짧은 리듬이 이어집니다.', qualities: ['분주한'],
      observations: ['작은 방향 전환이 반복됩니다.'], candidates: [
        { label: '분주한', score: 79, evidence: '짧은 변화가 반복됨' },
        { label: '리드미컬한', score: 65, evidence: '반복되는 시간 간격' },
      ], rubric: { version: 'test', kind: 'heuristic', eligible: { 유연한: false } } },
    analysisError: null,
  };
}
function upload(data, video = true) {
  const form = new FormData();
  form.set('record', JSON.stringify(data));
  if (video) form.set('video', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6])], { type: 'video/webm' }), 'sample.webm');
  return form;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function markedUpload(data, marker) {
  const form = upload(data, false);
  form.set('video', new Blob([
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, marker, marker + 1, marker + 2]),
  ], { type: 'video/webm' }), 'sample.webm');
  return form;
}
test('private records, metadata and video never return without a valid owner session', async () => {
  const f = await fixture();
  const id = randomUUID();
  for (const path of ['/api/session', '/api/records', `/api/records/${id}`, `/api/records/${id}/video`]) {
    const response = await call(f, path);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(f.reads(), 0);
  const response = await call(f, '/logs/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  f.sqlite.close();
});

test('static asset canonical redirects cannot loop the root or logs page through index.html', async () => {
  const f = await fixture();
  const assetPaths = [];
  f.env.ASSETS.fetch = async req => {
    const path = new URL(req.url).pathname;
    assetPaths.push(path);
    // Match the deployed asset service: explicit index.html canonicalizes to
    // /, while / resolves index.html internally and serves HTML directly.
    if (path === '/index.html') return new Response(null, {
      status: 308, headers: { Location: base + '/' },
    });
    assert.equal(path, '/');
    return new Response('<h1>private logbook login</h1>', { headers: { 'Content-Type': 'text/html' } });
  };
  try {
    for (const path of ['/', '/logs', '/logs/']) {
      const before = assetPaths.length;
      const response = await call(f, path);
      assert.equal(response.status, 200, path + ' must serve HTML without a canonical redirect');
      assert.equal(response.headers.get('location'), null);
      assert.match(await response.text(), /logbook login/);
      assert.deepEqual(assetPaths.slice(before), ['/']);
    }
    let path = '/index.html';
    let final;
    const before = assetPaths.length;
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await call(f, path);
      if (response.status === 200) { final = response; break; }
      assert.equal(response.status, 308);
      path = new URL(response.headers.get('location'), base).pathname;
    }
    assert.ok(final, 'Following /index.html → / must terminate instead of looping through the Worker');
    assert.deepEqual(assetPaths.slice(before), ['/index.html', '/']);
    assert.equal(final.headers.get('cache-control'), 'private, no-store');
    assert.match(final.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { f.sqlite.close(); }
});
test('login rejects cross-origin requests, incorrect passwords and throttled attempts; session expires and logout revokes it', async () => {
  const f = await fixture();
  const body = JSON.stringify({ password });
  assert.equal((await call(f, '/api/login', { method: 'POST', origin: 'https://attacker.example', body })).status, 403);
  assert.equal((await call(f, '/api/login', { method: 'POST', body: '{"password":"wrong"}' })).status, 401);
  const cookie = await login(f);
  assert.ok(!cookie.includes(password));
  assert.equal((await call(f, '/api/session', { cookie })).status, 200);
  assert.equal((await call(f, '/api/session', { cookie }, now + 12 * 60 * 60 * 1000 + 1)).status, 401);
  assert.equal((await call(f, '/api/logout', { method: 'POST', cookie, origin: null })).status, 403);
  const loggedOut = await call(f, '/api/logout', { method: 'POST', cookie });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.equal((await call(f, '/api/session', { cookie })).status, 401);
  f.env.LOGIN_LIMITER.limit = async () => ({ success: false });
  assert.equal((await call(f, '/api/login', { method: 'POST', body })).status, 429);
  f.sqlite.close();
});
test('authenticated video and candidate scores survive save/list/detail/range/download/delete, including idempotent save', async () => {
  const f = await fixture();
  const cookie = await login(f);
  const data = record();
  let response = await call(f, '/api/records', { method: 'POST', cookie, body: upload(data) });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  response = await call(f, '/api/records', { method: 'POST', cookie, body: upload(data) });
  assert.deepEqual(await response.json(), { id: data.id, revision:0, alreadySaved: true });
  const list = await (await call(f, '/api/records', { cookie })).json();
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].hasVideo, true);
  assert.equal(list.storage.usedBytes, 10);
  assert.ok(!JSON.stringify(list).includes('나만의 설명'));
  const detail = await (await call(f, `/api/records/${data.id}`, { cookie })).json();
  assert.deepEqual(detail.record.analysis.candidates, data.analysis.candidates);
  assert.equal(detail.record.details, data.details);
  assert.equal((await call(f, `/api/records/${data.id}/video`, { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  response = await call(f, `/api/records/${data.id}/video`, { cookie, headers: { Range: 'bytes=4-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-6/10');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  response = await call(f, `/api/records/${data.id}/video`, { cookie, headers: { Range: 'bytes=99-' } });
  assert.equal(response.status, 416);
  assert.equal((await call(f, `/api/records/${data.id}`, { cookie, method: 'DELETE', origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call(f, `/api/records/${data.id}`, { cookie, method: 'DELETE' })).status, 200);
  assert.equal(f.videos.size, 0);
  assert.equal((await call(f, `/api/records/${data.id}/video`, { cookie })).status, 404);
  f.sqlite.close();
});
test('upload type checks and quota reservations prevent oversized or fabricated video files and storage overflow', async () => {
  const f = await fixture();
  const cookie = await login(f);
  const form = upload(record(), false);
  form.set('video', new Blob(['<script>bad</script>'], { type: 'video/webm' }), 'bad.webm');
  assert.equal((await call(f, '/api/records', { cookie, method: 'POST', body: form })).status, 400);
  assert.equal((await call(f, '/api/records', {
    cookie, method: 'POST', body: upload(record()), headers: { 'Content-Length': String(17 * 1024 * 1024) }
  })).status, 413);
  const data = record();
  assert.equal((await call(f, '/api/records', { cookie, method: 'POST', body: upload(data, false) })).status, 201);
  f.sqlite.prepare('UPDATE records SET video_bytes = ?').run((await moduleReady).MAX_STORAGE_BYTES);
  assert.equal((await call(f, '/api/records', { cookie, method: 'POST', body: upload(record()) })).status, 409);
  assert.equal(f.videos.size, 0);
  f.sqlite.close();
});
test('a failed video write releases its reservation; delayed KV visibility gives a retryable error, not a public fallback', async () => {
  const f = await fixture();
  const cookie = await login(f);
  const put = f.env.VIDEOS.put;
  f.env.VIDEOS.put = async () => { throw new Error('not exposed'); };
  const failed = await call(f, '/api/records', { cookie, method: 'POST', body: upload(record()) });
  assert.equal(failed.status, 503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
  f.env.VIDEOS.put = put;
  const data = record();
  assert.equal((await call(f, '/api/records', { cookie, method: 'POST', body: upload(data) })).status, 201);
  f.env.VIDEOS.get = async () => null;
  const delayed = await call(f, `/api/records/${data.id}/video`, { cookie });
  assert.equal(delayed.status, 503);
  assert.equal((await delayed.json()).error.code, 'VIDEO_PENDING');
  f.sqlite.close();
});

test('deleting a pending upload prevents a late KV write from recreating its record or leaving a private blob', { timeout: 5000 }, async () => {
  const f = await fixture();
  const cookie = await login(f);
  const data = record();
  const entered = deferred();
  const release = deferred();
  const put = f.env.VIDEOS.put;
  let pendingKey;
  f.env.VIDEOS.put = async (key, value) => {
    pendingKey = key;
    entered.resolve();
    await release.promise;
    return put(key, value);
  };
  const saving = call(f, '/api/records', { cookie, method: 'POST', body: markedUpload(data, 10) });
  let result;
  try {
    await entered.promise;
    assert.equal(f.sqlite.prepare('SELECT state FROM records WHERE id = ?').get(data.id).state, 'pending');
    assert.equal((await call(f, `/api/records/${data.id}`, { cookie })).status, 409);
    assert.equal((await call(f, `/api/records/${data.id}`, { cookie, method: 'DELETE' })).status, 200);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
    assert.equal(f.videos.has(pendingKey), false, 'The DELETE happens before the blocked write becomes visible');
    release.resolve();
    result = await saving;
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'SAVE_FAILED');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
    assert.equal(f.videos.size, 0, 'The late writer must clean up its own now-unreserved blob');
    assert.equal((await call(f, `/api/records/${data.id}/video`, { cookie })).status, 404);
  } finally {
    release.resolve();
    if (!result) await saving;
    f.sqlite.close();
  }
});

test('a deleted pending upload finishing late cannot replace or delete a newer upload with the same record ID', { timeout: 5000 }, async () => {
  const f = await fixture();
  const cookie = await login(f);
  const original = record();
  const replacement = { ...original, details: 'new upload owns the ID' };
  const entered = deferred();
  const release = deferred();
  const put = f.env.VIDEOS.put;
  let oldKey;
  f.env.VIDEOS.put = async (key, value) => {
    if (!oldKey) {
      oldKey = key;
      entered.resolve();
      await release.promise;
    }
    return put(key, value);
  };
  const oldSave = call(f, '/api/records', { cookie, method: 'POST', body: markedUpload(original, 10) });
  let oldResponse;
  try {
    await entered.promise;
    assert.equal((await call(f, `/api/records/${original.id}`, { cookie, method: 'DELETE' })).status, 200);
    const newSave = await call(f, '/api/records', { cookie, method: 'POST', body: markedUpload(replacement, 40) });
    assert.equal(newSave.status, 201);
    const newRow = f.sqlite.prepare('SELECT state, video_key FROM records WHERE id = ?').get(original.id);
    assert.equal(newRow.state, 'ready');
    assert.notEqual(newRow.video_key, oldKey, 'Each upload attempt must own a distinct blob key');
    assert.equal(f.videos.has(newRow.video_key), true);
    release.resolve();
    oldResponse = await oldSave;
    assert.equal(oldResponse.status, 503, 'A lost reservation must not report successful completion');
    assert.equal((await oldResponse.json()).error.code, 'SAVE_FAILED');
    const finalRow = f.sqlite.prepare('SELECT state, video_key FROM records WHERE id = ?').get(original.id);
    assert.deepEqual(finalRow, newRow, 'The old completion and its cleanup cannot mutate the new generation');
    assert.equal(f.videos.has(oldKey), false);
    assert.deepEqual([...f.videos.keys()], [newRow.video_key]);
    const detail = await (await call(f, `/api/records/${original.id}`, { cookie })).json();
    assert.equal(detail.record.details, replacement.details);
    const video = await call(f, `/api/records/${original.id}/video`, { cookie });
    assert.equal(video.status, 200);
    assert.deepEqual([...new Uint8Array(await video.arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3, 40, 41, 42]);
  } finally {
    release.resolve();
    if (!oldResponse) await oldSave;
    f.sqlite.close();
  }
});

test('a stale concurrent DELETE cannot delete the metadata or video of a later upload generation', { timeout: 5000 }, async () => {
  const f = await fixture();
  const cookie = await login(f);
  const data = record();
  assert.equal((await call(f, '/api/records', { cookie, method: 'POST', body: markedUpload(data, 10) })).status, 201);
  const oldKey = f.sqlite.prepare('SELECT video_key FROM records WHERE id = ?').get(data.id).video_key;
  const entered = deferred();
  const release = deferred();
  const deleteVideo = f.env.VIDEOS.delete;
  let deleteCalls = 0;
  f.env.VIDEOS.delete = async key => {
    if (++deleteCalls === 1) { entered.resolve(); await release.promise; }
    return deleteVideo(key);
  };
  const staleDelete = call(f, `/api/records/${data.id}`, { cookie, method: 'DELETE' });
  let deleted;
  try {
    await entered.promise;
    assert.equal(f.sqlite.prepare('SELECT state FROM records WHERE id = ?').get(data.id).state, 'deleting');
    assert.equal((await call(f, `/api/records/${data.id}`, { cookie, method: 'DELETE' })).status, 200);
    assert.equal((await call(f, '/api/records', { cookie, method: 'POST', body: markedUpload(data, 70) })).status, 201);
    const newKey = f.sqlite.prepare('SELECT video_key FROM records WHERE id = ?').get(data.id).video_key;
    assert.notEqual(newKey, oldKey);
    release.resolve();
    deleted = await staleDelete;
    assert.equal(deleted.status, 200);
    assert.equal(f.sqlite.prepare('SELECT video_key FROM records WHERE id = ?').get(data.id).video_key, newKey);
    assert.deepEqual([...f.videos.keys()], [newKey]);
    const video = await call(f, `/api/records/${data.id}/video`, { cookie });
    assert.equal(video.status, 200);
    assert.deepEqual([...new Uint8Array(await video.arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3, 70, 71, 72]);
  } finally {
    release.resolve();
    if (!deleted) await staleDelete;
    f.sqlite.close();
  }
});
test('record validator does not invent candidate scores, accepts failures without analysis, and rejects malformed values', async () => {
  const { validateRecord, videoRange } = await moduleReady;
  const data = record();
  delete data.analysis.candidates;
  const valid = validateRecord(data);
  assert.equal(valid.analysis.candidates, undefined);
  data.analysis = null;
  data.analysisError = { code: 'AI_TIMEOUT', message: '다시 시도해 주세요.' };
  assert.equal(validateRecord(data).analysisError.code, 'AI_TIMEOUT');
  const invalid = record();
  invalid.analysis.candidates[0].score = 101;
  assert.throws(() => validateRecord(invalid), /수치/);
  invalid.analysis.candidates[0].score = 50;
  invalid.id = '../../secret';
  assert.throws(() => validateRecord(invalid), /기록/);
  assert.deepEqual(videoRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(videoRange('bytes=3-', 10), { start: 3, end: 9 });
  assert.equal(videoRange('bytes=0-2,4-5', 10), false);
});


test('revision PUT updates private metadata and semantic provenance while preserving its stored video generation',async()=>{
 const f=await fixture(),cookie=await login(f),data={...record(),revision:1};
 assert.equal((await call(f,'/api/records',{cookie,method:'POST',body:upload(data)})).status,201);
 const initial=f.sqlite.prepare('SELECT * FROM records WHERE id=?').get(data.id);const originalVideo=f.videos.get(initial.video_key);
 const next={...data,revision:2,intention:'단호한',details:'새 입력',similarity:{method:'fasttext-cosine',model:'cc.ko.300',results:[{label:'차분한',similarity:-12.5,rawCosine:-.125,evidence:'실제 코사인'}]},analysis:{...data.analysis,motionCaption:{provider:'MotionGPT',model:'MotionGPT-base',text:'a person turns'}}};
 let response=await call(f,'/api/records/'+data.id,{cookie,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
 assert.deepEqual(await response.json(),{id:data.id,revision:2,updated:true});
 const saved=(await(await call(f,'/api/records/'+data.id,{cookie})).json()).record;
 assert.equal(saved.revision,2);assert.equal(saved.intention,'단호한');assert.deepEqual(saved.similarity,next.similarity);assert.deepEqual(saved.analysis.motionCaption,next.analysis.motionCaption);assert.equal(saved.hasVideo,true);
 const current=f.sqlite.prepare('SELECT * FROM records WHERE id=?').get(data.id);assert.equal(current.video_key,initial.video_key);assert.equal(f.videos.size,1);assert.strictEqual(f.videos.get(current.video_key),originalVideo);
 for(const version of [1,2]){
  response=await call(f,'/api/records/'+data.id,{cookie,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...next,revision:version,intention:'후퇴하면 안 됨'})});
  assert.equal(response.status,200);assert.equal((await response.json()).revision,2);
 }
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT metadata FROM records WHERE id=?').get(data.id).metadata).intention,'단호한');f.sqlite.close();
});

test('metadata PUT requires owner and same-origin credentials and cannot change immutable identity fields',async()=>{
 const f=await fixture(),cookie=await login(f),data={...record(),revision:1};
 await call(f,'/api/records',{cookie,method:'POST',body:upload(data,false)});
 const options={method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,revision:2})};
 assert.equal((await call(f,'/api/records/'+data.id,options)).status,401);
 assert.equal((await call(f,'/api/records/'+data.id,{...options,cookie,origin:'https://evil.example'})).status,403);
 for(const changed of [{id:randomUUID()},{createdAt:new Date(now+1).toISOString()},{source:'webcam'}]){
  const response=await call(f,'/api/records/'+data.id,{...options,cookie,body:JSON.stringify({...data,revision:2,...changed})});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'IMMUTABLE_RECORD');
 }
 assert.equal((await call(f,'/api/records/'+data.id,{...options,cookie,body:JSON.stringify({...data,revision:1.5})})).status,400);
 assert.equal((await call(f,'/api/records/'+data.id,{...options,cookie,headers:{'Content-Type':'application/json','Content-Length':String(200*1024)}})).status,413);
 f.sqlite.close();
});

test('concurrent metadata edits retain the greatest revision regardless of CAS scheduling order',async()=>{
 for(const blockedRevision of [2,3]){
  const f=await fixture(),cookie=await login(f),data={...record(),revision:1};await call(f,'/api/records',{cookie,method:'POST',body:upload(data,false)});
  const entered=deferred(),release=deferred(),prepare=f.env.DB.prepare.bind(f.env.DB);let held=false;
  f.env.DB.prepare=sql=>{
   const statement=prepare(sql);if(!sql.startsWith('UPDATE records SET metadata'))return statement;
   return {bind(...values){const bound=statement.bind(...values);return {...bound,run:async()=>{if(values[1]===blockedRevision&&!held){held=true;entered.resolve();await release.promise;}return bound.run();}};}};
  };
  const update=revision=>call(f,'/api/records/'+data.id,{cookie,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,revision,intention:'버전'+revision})});
  const blocked=update(blockedRevision);await entered.promise;
  assert.equal((await update(blockedRevision===2?3:2)).status,200);release.resolve();assert.equal((await blocked).status,200);
  const saved=(await(await call(f,'/api/records/'+data.id,{cookie})).json()).record;assert.equal(saved.revision,3);assert.equal(saved.intention,'버전3');f.sqlite.close();
 }
});

test('a deleted and recreated video generation rejects an old pending metadata CAS',async()=>{
 const f=await fixture(),cookie=await login(f),data={...record(),revision:1};await call(f,'/api/records',{cookie,method:'POST',body:markedUpload(data,30)});
 const entered=deferred(),release=deferred(),prepare=f.env.DB.prepare.bind(f.env.DB);let held=false;
 f.env.DB.prepare=sql=>{
  const statement=prepare(sql);if(!sql.startsWith('UPDATE records SET metadata'))return statement;
  return {bind(...values){const bound=statement.bind(...values);return {...bound,run:async()=>{if(!held){held=true;entered.resolve();await release.promise;}return bound.run();}};}};
 };
 const pending=call(f,'/api/records/'+data.id,{cookie,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,revision:2,intention:'지연된 예전 편집'})});
 await entered.promise;await call(f,'/api/records/'+data.id,{cookie,method:'DELETE'});await call(f,'/api/records',{cookie,method:'POST',body:markedUpload({...data,intention:'새 영상'},60)});
 release.resolve();const response=await pending;assert.equal(response.status,409);assert.equal((await response.json()).error.code,'RECORD_REPLACED');
 const saved=(await(await call(f,'/api/records/'+data.id,{cookie})).json()).record;assert.equal(saved.intention,'새 영상');assert.equal(saved.revision,1);assert.equal(f.videos.size,1);f.sqlite.close();
});


test('similarity validator preserves AI rank, measured zero and unknown null without coercion',async()=>{
 const {validateRecord}=await moduleReady;
 const data=record();data.similarity={method:'fasttext-cosine',model:'test-vectors',rankingScope:'ai-movement-order',results:[
   {label:'분주한',aiRank:1,similarity:null,rawCosine:null,evidence:'원래 움직임 근거'},
   {label:'리드미컬한',aiRank:2,similarity:0,rawCosine:0,evidence:'실제 0'}
 ]};
 assert.deepEqual(validateRecord(data).similarity,data.similarity);
 for(const rank of [0,6,1.5,'1',null]){
   const invalid=structuredClone(data);invalid.similarity.results[0].aiRank=rank;
   assert.throws(()=>validateRecord(invalid),/순위/);
 }
 for(const value of [undefined,'0',101,-101]){
   const invalid=structuredClone(data);invalid.similarity.results[0].similarity=value;
   assert.throws(()=>validateRecord(invalid),/수치/);
 }
});
