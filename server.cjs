// 로컬 정적 서버 + API 프록시. 키는 환경변수에만 저장한다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const root = path.join(__dirname, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ttf': 'font/ttf' };
const apiReady = import('./api/handler.mjs');
let limiter;
const server = http.createServer(async (req, res) => {
  // Reject DNS-rebinding hosts before exposing a server-side API credential.
  if (!['127.0.0.1:4173', 'localhost:4173'].includes(req.headers.host)) {
    res.writeHead(403); res.end('Forbidden host'); return;
  }
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  if (url.startsWith('/api/')) {
    try {
      const { handleApi, createLocalLimiter } = await apiReady;
      limiter ||= createLocalLimiter();
      const options = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) {
        options.body = Readable.toWeb(req);
        options.duplex = 'half';
      }
      const request = new Request(`http://${req.headers.host}${req.url}`, options);
      const response = await handleApi(request, { env: process.env, allowLocal: true, checkLimit: limiter });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'SERVER_ERROR', message: '로컬 분석 서버에서 오류가 발생했습니다.' } }));
    }
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end('Method not allowed'); return; }
  const file = path.resolve(root, '.' + (url === '/' ? '/index.html' : url));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(4173, '127.0.0.1', () => {
  console.log('Local: http://127.0.0.1:4173');
  console.log(`Gemini: ${process.env.GEMINI_API_KEY ? 'configured (key stays on server)' : 'not configured; set GEMINI_API_KEY to enable AI'}`);
});
