// A single-owner logbook. The analysis API never receives these videos.
// No public object URLs, CORS credentials, password values, or record logging.
export const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 500 * 1024 * 1024;
export const MAX_RECORDS = 500;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_UPLOAD_BYTES = MAX_VIDEO_BYTES + MAX_METADATA_BYTES + 16384;
const SESSION_SECONDS = 12 * 60 * 60;
const COOKIE = '__Host-ghosting_session';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = new Set(['video/webm', 'video/mp4']);
const enc = new TextEncoder();
const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra
  } });
}
function secured(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
const sha = async value => hex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
function constantEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export async function passwordDigest(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000
  }, key, 256));
}
function cookie(value, age = SESSION_SECONDS) {
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}
function sessionToken(request) {
  const token = (request.headers.get('cookie') || '').split(';')
    .map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}
async function session(request, env, now) {
  const token = sessionToken(request);
  if (!token) return null;
  const hash = await sha(token);
  const row = await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(hash, now).first();
  return row ? hash : null;
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin;
}
async function limited(binding, key) {
  if (!binding || !(await binding.limit({ key })).success) fail(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
}
async function bytes(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) fail(413, 'TOO_LARGE', '파일 크기가 저장 한도를 넘었습니다.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        fail(413, 'TOO_LARGE', '파일 크기가 저장 한도를 넘었습니다.');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { merged.set(part, offset); offset += part.length; }
  return merged;
}
function text(value, max, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max) fail(400, 'INVALID_RECORD', '기록 형식을 확인해 주세요.');
  return value;
}
function finite(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(400, 'INVALID_RECORD', '기록의 수치 형식을 확인해 주세요.');
  }
  return value;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
// Permit nested numeric rubric data, not arbitrary embedded URLs or binary data.
function safeMetrics(value) {
  if (value === undefined || value === null) return {};
  if (!plain(value) || Object.keys(value).length > 60) fail(400, 'INVALID_RECORD', '지표 형식을 확인해 주세요.');
  return Object.fromEntries(Object.entries(value).map(([key, val]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key)) fail(400, 'INVALID_RECORD', '지표 이름을 확인해 주세요.');
    return [key, val === null ? null : finite(val, -1e8, 1e8)];
  }));
}
export function validateRecord(raw) {
  if (!plain(raw) || !ID.test(raw.id || '') || !['hand', 'webcam', 'pointer', 'example'].includes(raw.source)) {
    fail(400, 'INVALID_RECORD', '기록 정보를 확인해 주세요.');
  }
  const created = Date.parse(raw.createdAt);
  if (!Number.isFinite(created)) fail(400, 'INVALID_RECORD', '기록 시간을 확인해 주세요.');
  const record = {
    id: raw.id.toLowerCase(), createdAt: new Date(created).toISOString(),
    source: raw.source, durationMs: finite(raw.durationMs, 0, 60000),
    revision: raw.revision === undefined ? 0 : finite(raw.revision,0,Number.MAX_SAFE_INTEGER),
    handTarget: ['indexTip', 'wrist'].includes(raw.handTarget) ? raw.handTarget : null,
    intention: text(raw.intention, 120, true), details: text(raw.details, 10000, true),
    metrics: safeMetrics(raw.metrics), analysis: null, analysisError: null,
  };
  if (!Number.isSafeInteger(record.revision)) fail(400,'INVALID_RECORD','기록 버전은 정수여야 합니다.');
  if (raw.similarity !== undefined && raw.similarity !== null) {
    const similarity=raw.similarity;
    if (!plain(similarity) || !Array.isArray(similarity.results) || similarity.results.length > 50) fail(400,'INVALID_RECORD','유사도 형식을 확인해 주세요.');
    record.similarity={
      method:text(similarity.method,100),model:text(similarity.model,300),
      results:similarity.results.map(item=>{
        if (!plain(item)) fail(400,'INVALID_RECORD','유사도 후보 형식을 확인해 주세요.');
        const result={label:text(item.label,100),similarity:item.similarity===null?null:finite(item.similarity,-100,100),evidence:text(item.evidence,1000,true)};
        if(item.aiRank!==undefined){
          if(!Number.isInteger(item.aiRank)||item.aiRank<1||item.aiRank>5)fail(400,'INVALID_RECORD','AI 순위는 1부터 5까지의 정수여야 합니다.');
          result.aiRank=item.aiRank;
        }
        if (item.rawCosine !== undefined) result.rawCosine=item.rawCosine===null?null:finite(item.rawCosine,-1,1);
        return result;
      })
    };
    if(similarity.queryCoverage!==undefined)record.similarity.queryCoverage=finite(similarity.queryCoverage,0,1);
    for(const key of ['missingTokens','matchedTokens','limitations'])if(similarity[key]!==undefined){
      if(!Array.isArray(similarity[key])||similarity[key].length>100)fail(400,'INVALID_RECORD','단어 비교 출처를 확인해 주세요.');
      record.similarity[key]=similarity[key].map(value=>text(value,key==='limitations'?1000:100));
    }
    for (const key of ['input','query','generatedAt','source','rankingScope']) if (similarity[key] !== undefined) record.similarity[key]=text(similarity[key],key==='input'||key==='query'?2000:300);
  }
  if (raw.analysis !== null && raw.analysis !== undefined) {
    const a = raw.analysis;
    if (!plain(a) || !Array.isArray(a.qualities) || a.qualities.length > 10 ||
        !Array.isArray(a.observations) || a.observations.length > 10) {
      fail(400, 'INVALID_RECORD', 'AI 결과 형식을 확인해 주세요.');
    }
    record.analysis = {
      impression: text(a.impression, 100), description: text(a.description, 2000),
      qualities: a.qualities.map(x => text(x, 100)),
      observations: a.observations.map(x => text(x, 1000)),
      caveat: text(a.caveat, 2000, true),
    };
    if (a.candidates !== undefined) {
      if (!Array.isArray(a.candidates) || a.candidates.length > 10) fail(400, 'INVALID_RECORD', '후보 형식을 확인해 주세요.');
      record.analysis.candidates = a.candidates.map(c => {
        if (!plain(c)) fail(400, 'INVALID_RECORD', '후보 형식을 확인해 주세요.');
        return { label: text(c.label, 100), score: finite(c.score, 0, 100), evidence: text(c.evidence, 1000) };
      });
    }
    if (a.motionCaption !== undefined) {
      if (!plain(a.motionCaption) || enc.encode(JSON.stringify(a.motionCaption)).length > 16000) fail(400,'INVALID_RECORD','움직임 해석 출처를 확인해 주세요.');
      record.analysis.motionCaption=JSON.parse(JSON.stringify(a.motionCaption));
    }
    if (a.rubric !== undefined) {
      if (!plain(a.rubric) || enc.encode(JSON.stringify(a.rubric)).length > 16000) fail(400, 'INVALID_RECORD', '기준 형식을 확인해 주세요.');
      // A JSON-only snapshot; rendered as text by the logbook, never executed.
      record.analysis.rubric = JSON.parse(JSON.stringify(a.rubric));
    }
  }
  if (raw.analysisError !== undefined && raw.analysisError !== null) {
    if (!plain(raw.analysisError)) fail(400, 'INVALID_RECORD', '오류 형식을 확인해 주세요.');
    record.analysisError = {
      code: text(raw.analysisError.code, 100, true), message: text(raw.analysisError.message, 2000, true)
    };
  }
  return record;
}
export function videoRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); end = size - 1; if (!suffix) return false; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}
async function save(request, env, now) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data;')) fail(400, 'INVALID_UPLOAD', '업로드 형식을 확인해 주세요.');
  const body = await bytes(request, MAX_UPLOAD_BYTES);
  let form;
  try { form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': contentType }, body }).formData(); }
  catch { fail(400, 'INVALID_UPLOAD', '업로드를 읽지 못했어요. 다시 시도해 주세요.'); }
  const raw = form.get('record');
  if (typeof raw !== 'string' || enc.encode(raw).length > MAX_METADATA_BYTES) fail(400, 'INVALID_RECORD', '기록이 너무 크거나 올바르지 않습니다.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(400, 'INVALID_RECORD', '기록을 읽지 못했어요.'); }
  const record = validateRecord(parsed);
  const video = form.get('video');
  let videoBytes = 0, videoType = '';
  if (video !== null) {
    if (!(video instanceof Blob) || !video.size || video.size > MAX_VIDEO_BYTES) fail(413, 'VIDEO_TOO_LARGE', '영상은 15 MiB 이내여야 합니다.');
    videoType = video.type.split(';')[0].toLowerCase();
    if (!MIME.has(videoType)) fail(400, 'VIDEO_TYPE', 'WebM 또는 MP4 영상만 저장할 수 있어요.');
    const prefix = new Uint8Array(await video.slice(0, 12).arrayBuffer());
    const webm = prefix[0] === 0x1a && prefix[1] === 0x45 && prefix[2] === 0xdf && prefix[3] === 0xa3;
    const mp4 = new TextDecoder().decode(prefix.slice(4, 8)) === 'ftyp';
    if ((videoType === 'video/webm' && !webm) || (videoType === 'video/mp4' && !mp4)) fail(400, 'VIDEO_TYPE', '영상 파일 형식이 맞지 않습니다.');
    videoBytes = video.size;
  }
  const existing = await env.DB.prepare('SELECT state, revision FROM records WHERE id = ?').bind(record.id).first();
  if (existing) {
    if (existing.state === 'ready') return json({ id: record.id, revision:existing.revision, alreadySaved: true });
    fail(409, 'RECORD_PENDING', '이 기록은 아직 저장 또는 삭제 중입니다. 잠시 후 다시 확인해 주세요.');
  }
  record.hasVideo = videoBytes > 0;
  const videoKey = `video:${record.id}:${crypto.randomUUID()}`;
  const inserted = await env.DB.prepare(`INSERT INTO records
    (id, created_at, stored_at, source, duration_ms, impression, metadata, video_bytes, video_type, video_key, revision, state)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
    WHERE (SELECT COUNT(*) FROM records) < ? AND
      (SELECT COALESCE(SUM(video_bytes), 0) FROM records) + ? <= ?
    ON CONFLICT(id) DO NOTHING`)
    .bind(record.id, record.createdAt, now, record.source, record.durationMs, record.analysis?.impression || null,
      JSON.stringify(record), videoBytes, videoType, videoKey, record.revision, MAX_RECORDS, videoBytes, MAX_STORAGE_BYTES).run();
  if (inserted.meta.changes !== 1) fail(409, 'STORAGE_LIMIT', '저장 한도에 도달했거나 같은 기록을 저장 중입니다. 기존 기록을 확인해 주세요.');
  try {
    if (videoBytes) await env.VIDEOS.put(videoKey, await video.arrayBuffer());
    const completed = await env.DB.prepare("UPDATE records SET state = 'ready' WHERE id = ? AND video_key = ? AND state = 'pending'")
      .bind(record.id, videoKey).run();
    if (completed.meta.changes !== 1) throw new Error('Upload reservation was removed');
  } catch {
    // Leave a tracked reservation if cleanup itself fails; never orphan a
    // private video by deleting its only index before deleting the object.
    if (videoBytes) await env.VIDEOS.delete(videoKey);
    await env.DB.prepare('DELETE FROM records WHERE id = ? AND video_key = ?').bind(record.id, videoKey).run();
    fail(503, 'SAVE_FAILED', '저장이 끝나지 않았어요. 잠시 후 다시 시도해 주세요.');
  }
  return json({ id: record.id,revision:record.revision }, 201);
}
async function updateMetadata(request,env,initialRow,now) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail(400,'INVALID_RECORD','JSON 기록 형식을 확인해 주세요.');
  let raw;
  try { raw=JSON.parse(new TextDecoder().decode(await bytes(request,MAX_METADATA_BYTES))); }
  catch(error) { if(error instanceof HttpError) throw error; fail(400,'INVALID_RECORD','기록을 읽지 못했어요.'); }
  const record=validateRecord(plain(raw?.record)?raw.record:raw);
  if(record.id!==initialRow.id || record.createdAt!==initialRow.created_at || record.source!==initialRow.source) fail(409,'IMMUTABLE_RECORD','기록 번호·시각·입력 방식은 바꿀 수 없습니다.');
  const videoKey=initialRow.video_key;
  let row=initialRow;
  // Compare-and-swap includes the private video's generation, so a deleted and
  // recreated record cannot be overwritten by an older in-flight edit.
  for(let attempt=0;attempt<4;attempt++) {
    if(row.state!=='ready') fail(409,'RECORD_PENDING','아직 저장 또는 삭제 중인 기록입니다. 잠시 후 다시 시도해 주세요.');
    if(record.revision<=row.revision) return json({id:record.id,revision:row.revision,alreadySaved:true,stale:record.revision<row.revision});
    record.hasVideo=row.video_bytes>0;
    const result=await env.DB.prepare("UPDATE records SET metadata = ?, revision = ?, stored_at = ?, duration_ms = ?, impression = ? WHERE id = ? AND revision = ? AND video_key = ? AND state = 'ready'")
      .bind(JSON.stringify(record),record.revision,now,record.durationMs,record.analysis?.impression || null,record.id,row.revision,videoKey).run();
    if(result.meta.changes===1) return json({id:record.id,revision:record.revision,updated:true});
    row=await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(record.id).first();
    if(!row) fail(404,'NOT_FOUND','기록을 찾을 수 없어요.');
    if(row.video_key!==videoKey) fail(409,'RECORD_REPLACED','이전 기록이 삭제되었어요. 새 기록으로 다시 보관해 주세요.');
  }
  fail(409,'UPDATE_CONFLICT','다른 창에서 기록을 갱신 중입니다. 잠시 후 다시 시도해 주세요.');
}
export async function handleLogbook(request, env, { now = Date.now() } = {}) {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return json({ error: { code: 'HTTPS_REQUIRED', message: 'HTTPS로 접속해 주세요.' } }, 400);
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'METHOD', '지원하지 않는 요청입니다.');
      if (!['/', '/logs', '/logs/', '/index.html', '/app.js', '/styles.css'].includes(url.pathname)) fail(404, 'NOT_FOUND', '페이지를 찾을 수 없어요.');
      // The asset binding resolves / to index.html. Requesting /index.html
      // directly would canonical-redirect to / and loop through this Worker.
      if (['/', '/logs', '/logs/'].includes(url.pathname)) url.pathname = '/';
      return secured(await env.ASSETS.fetch(new Request(url, request)));
    }
    if (!env.DB || !env.VIDEOS || !env.LOGBOOK_PASSWORD_HASH || !env.LOGBOOK_PASSWORD_SALT) {
      fail(503, 'NOT_CONFIGURED', '비공개 로그 저장소를 준비 중입니다.');
    }
    if (request.method === 'OPTIONS') fail(403, 'ORIGIN', '로그 페이지에서 요청해 주세요.');
    if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request)) fail(403, 'ORIGIN', '로그 페이지에서 요청해 주세요.');
    if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'ORIGIN', '로그 페이지에서 요청해 주세요.');
    if (url.pathname === '/api/login' && request.method === 'POST') {
      await limited(env.LOGIN_LIMITER, request.headers.get('CF-Connecting-IP') || 'unknown');
      let input;
      try { input = JSON.parse(new TextDecoder().decode(await bytes(request, 4096))); }
      catch (error) { if (error instanceof HttpError) throw error; fail(400, 'LOGIN', '비밀번호를 입력해 주세요.'); }
      const password = input?.password;
      if (typeof password !== 'string' || !password || password.length > 512) fail(401, 'LOGIN', '비밀번호를 확인해 주세요.');
      if (!constantEqual(await passwordDigest(password, env.LOGBOOK_PASSWORD_SALT), env.LOGBOOK_PASSWORD_HASH)) {
        fail(401, 'LOGIN', '비밀번호를 확인해 주세요.');
      }
      const token = randomToken();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
        env.DB.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').bind(await sha(token), now + SESSION_SECONDS * 1000)
      ]);
      return json({ authenticated: true }, 200, { 'Set-Cookie': cookie(token) });
    }
    const tokenHash = await session(request, env, now);
    if (!tokenHash) fail(401, 'LOGIN_REQUIRED', '로그인 후 기록을 볼 수 있어요.');
    if (url.pathname === '/api/session' && request.method === 'GET') return json({ authenticated: true });
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
      return json({ authenticated: false }, 200, { 'Set-Cookie': cookie('', 0) });
    }
    if (url.pathname === '/api/records' && request.method === 'GET') {
      const { results } = await env.DB.prepare("SELECT id, created_at, source, duration_ms, impression, video_bytes, revision, state FROM records ORDER BY created_at DESC LIMIT 500").all();
      return json({ records: results.map(r => ({
        id: r.id, createdAt: r.created_at, source: r.source, durationMs: r.duration_ms,
        impression: r.impression, hasVideo: r.video_bytes > 0, revision:r.revision, state: r.state
      })), storage: { usedBytes: results.reduce((n, r) => n + r.video_bytes, 0), maxBytes: MAX_STORAGE_BYTES, maxRecords: MAX_RECORDS } });
    }
    if (url.pathname === '/api/records' && request.method === 'POST') {
      await limited(env.WRITE_LIMITER, 'owner');
      return await save(request, env, now);
    }
    const match = /^\/api\/records\/([^/]+)(\/video)?$/.exec(url.pathname);
    if (!match || !ID.test(match[1])) fail(404, 'NOT_FOUND', '기록을 찾을 수 없어요.');
    const id = match[1].toLowerCase();
    const row = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
    if (!row) fail(404, 'NOT_FOUND', '기록을 찾을 수 없어요.');
    if (!match[2] && request.method === 'DELETE') {
      await limited(env.WRITE_LIMITER, 'owner');
      await env.DB.prepare("UPDATE records SET state = 'deleting' WHERE id = ? AND video_key = ?").bind(id, row.video_key).run();
      if (row.video_bytes) await env.VIDEOS.delete(row.video_key);
      await env.DB.prepare('DELETE FROM records WHERE id = ? AND video_key = ?').bind(id, row.video_key).run();
      return json({ deleted: true });
    }
    if (row.state !== 'ready') fail(409, 'RECORD_PENDING', '아직 저장 또는 삭제 중인 기록입니다. 목록에서 삭제 후 다시 저장할 수 있어요.');
    if (!match[2] && request.method === 'PUT') {
      await limited(env.WRITE_LIMITER,'owner');
      return await updateMetadata(request,env,row,now);
    }
    if (!match[2] && request.method === 'GET') return json({ record: {...JSON.parse(row.metadata),revision:row.revision} });
    if (match[2] && ['GET', 'HEAD'].includes(request.method)) {
      if (!row.video_bytes) fail(404, 'NO_VIDEO', '이 기록에는 저장된 영상이 없어요.');
      const range = videoRange(request.headers.get('range'), row.video_bytes);
      if (range === false) return new Response(null, { status: 416, headers: { ...securityHeaders, 'Content-Range': `bytes */${row.video_bytes}` } });
      const headers = {
        ...securityHeaders, 'Content-Type': row.video_type, 'Accept-Ranges': 'bytes',
        'Content-Length': String(range ? range.end - range.start + 1 : row.video_bytes),
        'Content-Disposition': `inline; filename="ghosting-${id}.${row.video_type === 'video/mp4' ? 'mp4' : 'webm'}"`,
      };
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${row.video_bytes}`;
      let body = null;
      if (request.method === 'GET') {
        body = await env.VIDEOS.get(row.video_key, 'arrayBuffer');
        if (!body) fail(503, 'VIDEO_PENDING', '영상 반영 중이거나 연결이 지연됐어요. 잠시 후 다시 열어주세요.');
        if (range) body = body.slice(range.start, range.end + 1);
      }
      return new Response(body, { status: range ? 206 : 200, headers });
    }
    fail(405, 'METHOD', '지원하지 않는 요청입니다.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: 'STORAGE_ERROR', message: '저장소 연결이 지연됐어요. 잠시 후 다시 시도해 주세요.' } }, 503);
  }
}
export default { fetch: handleLogbook };
