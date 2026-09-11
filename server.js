'use strict';
/**
 * 할리갈리 — Node 서버 (로컬 개발 · 테스트용, 예전 Render 배포)
 *  - 정적 파일(public/) + WebSocket. 판은 game.js 가 쥐고 여기는 전달만 한다.
 *  - 실제 서비스는 Cloudflare(worker.js)에서 같은 game.js 로 돈다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { rooms, handle, disconnect, sweepRooms, selfCheck } = require('./game');

const PORT = process.env.PORT || 8788;
const PUBLIC = path.join(__dirname, 'public');

/* ─────────────────────────── 서버 ─────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let file;
  try { file = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (_) { res.writeHead(400).end('bad request'); return; }   // %E0 같은 주소 하나로 서버가 죽지 않게

  if (file === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, rev: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null }));
  }

  if (file === '/') file = '/index.html';
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('없는 페이지입니다'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'ping') return;               // 살아 있다는 신호일 뿐
    try { handle(ws, msg); }
    catch (e) { console.error('handle error', e); }
  });

  ws.on('close', () => disconnect(ws));
});

// 끊긴 소켓 정리 + 빈 방 청소
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
  sweepRooms();
}, 30_000);

server.listen(PORT, () => {
  selfCheck();
  console.log(`할리갈리 서버 → http://localhost:${PORT}`);
});
