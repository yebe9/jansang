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

function harness({ session = true, records = [], fetch: customFetch, capture = true, autoSave = false } = {}) {
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
  const doc = { getElementById(id) { assert.ok(elements.has(id), `existing HTML element ${id}`); return elements.get(id); }, createElement: tag => new Element(tag), body: new Element('body') };
  const win = new Element('window');
  const calls = [], messages = [], createdURLs = [], revokedURLs = [];
  const timers = new Map();
  win.location = { search: capture ? (autoSave ? '?capture=1&save=1' : '?capture=1') : '' };
  win.opener = { postMessage: (message, origin) => messages.push({ message, origin }) };
  Object.assign(win, { Blob, FormData, AbortController });
  win.URL = { createObjectURL(blob) { const url = `blob:test-${createdURLs.length}`; createdURLs.push({ url, blob }); return url; }, revokeObjectURL(url) { revokedURLs.push(url); } };
  win.setTimeout = (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'same-origin', 'all private requests include same-origin credentials');
    const custom = await customFetch?.(url, options);
    if (custom) return custom;
    if (url === '/api/session') return reply({ authenticated: session }, session ? 200 : 401);
    if (url === '/api/login' || url === '/api/logout') return reply({ ok: true });
    if (url === '/api/records' && options.method !== 'POST') return reply({ records });
    if (url.startsWith('/api/records/') && options.method === 'DELETE') return reply({ deleted: true });
    if (url.startsWith('/api/records/')) return reply({ record: example(decodeURIComponent(url.split('/')[3])) });
    throw new Error(`Unmocked fetch ${url}`);
  };
  const app = createApp(win, doc);
  return {
    win, doc, app, calls, messages, createdURLs, revokedURLs, get: id => elements.get(id),
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
  assert.deepEqual(saved, { message: { type: 'ghosting:saved', id: 'record-one' }, origin: 'https://yebe9.github.io' });
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
