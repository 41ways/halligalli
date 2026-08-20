'use strict';
/**
 * 할리갈리 — 온라인 대전 서버
 *  - 정적 파일 서빙(public/) + WebSocket 게임 서버
 *  - 게임 상태/판정/타이머/봇은 전부 서버가 관리한다(권위 서버).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8788;
const PUBLIC = path.join(__dirname, 'public');

/* ─────────────────────────── 게임 상수 ─────────────────────────── */

const FRUITS = ['banana', 'lime', 'strawberry', 'grape'];
// 정품 할리갈리 분포: 과일당 1개×5, 2개×3, 3개×3, 4개×2, 5개×1 = 14장 → 총 56장
const COUNT_DIST = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5];

const BOT = {
  easy:   { min: 1100, max: 2100, miss: 0.40, falseCall: 0.050, flip: [700, 1600] },
  normal: { min:  650, max: 1300, miss: 0.18, falseCall: 0.030, flip: [550, 1200] },
  hard:   { min:  380, max:  800, miss: 0.04, falseCall: 0.015, flip: [400,  900] },
};
const BOT_NAMES = ['깐돌이', '알밤이', '토실이', '방울이', '뽀리', '멍구'];

const MAX_PLAYERS = 6;
const RESOLVE_PAUSE_OK = 1400;   // 성공 후 정지 시간
const RESOLVE_PAUSE_NG = 1000;   // 오답 후 정지 시간
const WRONG_LOCK = 900;          // 오답한 사람의 재입력 잠금
const DC_FLIP_DELAY = 1500;      // 접속 끊긴 사람 차례는 자동으로 넘김

/* ─────────────────────────── 유틸 ─────────────────────────── */

const rnd = (min, max) => min + Math.random() * (max - min);
const pick = a => a[Math.floor(Math.random() * a.length)];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  const deck = [];
  for (const f of FRUITS) for (const n of COUNT_DIST) deck.push({ f, n });
  return shuffle(deck);
}

const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => pick(alphabet.split(''))).join('');
  } while (rooms.has(code));
  return code;
}

const token = () => crypto.randomBytes(12).toString('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

/* ─────────────────────────── 방 ─────────────────────────── */

function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby',              // lobby | playing | over
    hostId: null,
    players: [],
    nextId: 1,
    turn: null,                  // 현재 뒤집을 차례인 player id
    frozen: false,               // 5개가 떠 있는 동안은 아무도 카드를 못 깐다
    turnEndsAt: 0,
    resolving: false,
    fiveSince: 0,
    winner: null,
    lock: {},
    cfg: { botDiff: 'normal', turnLimit: 6000 },
    timers: { turn: null, resume: null, nudge: null, bots: [] },
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, { name, bot }) {
  const p = {
    id: room.nextId++,
    token: token(),
    name: name || `플레이어 ${room.nextId - 1}`,
    bot: !!bot,
    ws: null,
    connected: !!bot,
    hand: [], table: [], out: false,
    hits: 0, misses: 0, best: null,
  };
  room.players.push(p);
  if (!p.bot && room.hostId == null) room.hostId = p.id;
  return p;
}

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const [gone] = room.players.splice(i, 1);
  if (room.hostId === gone.id) {
    const next = room.players.find(p => !p.bot && p.connected) || room.players.find(p => !p.bot);
    room.hostId = next ? next.id : null;
  }
  if (room.phase === 'playing') {
    sweepOut(room);
    if (room.turn === gone.id) beginTurn(room, i);
  }
}

const inPlay = p => !p.out && (p.hand.length > 0 || p.table.length > 0);
const humansOf = room => room.players.filter(p => !p.bot).length;
/** 사람끼리 붙을 땐 봇은 카드만 넘겨주는 딜러 역할 — 종은 사람만 친다 */
const botsMayCall = room => humansOf(room) <= 1;
const canFlip = p => !p.out && p.hand.length > 0;

function sums(room) {
  const s = {};
  for (const f of FRUITS) s[f] = 0;
  for (const p of room.players) {
    if (p.out || !p.table.length) continue;
    const top = p.table[p.table.length - 1];
    s[top.f] += top.n;
  }
  return s;
}
const fivesOf = s => FRUITS.filter(f => s[f] === 5);

/* ─────────────────────────── 통신 ─────────────────────────── */

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function stateOf(room) {
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    cfg: room.cfg,
    turn: room.turn,
    turnEndsAt: room.turnEndsAt,
    now: Date.now(),
    resolving: room.resolving,
    frozen: room.frozen,
    winner: room.winner,
    players: room.players.map(p => ({
      id: p.id, name: p.name, bot: p.bot, connected: p.connected,
      hand: p.hand.length, pile: p.table.length,
      top: p.table.length ? p.table[p.table.length - 1] : null,
      out: p.out, hits: p.hits, misses: p.misses, best: p.best,
    })),
  };
}

function broadcast(room, obj) {
  for (const p of room.players) if (!p.bot) send(p.ws, obj);
}
const pushState = room => broadcast(room, stateOf(room));
const ev = (room, obj) => broadcast(room, Object.assign({ t: 'ev' }, obj));

/* ─────────────────────────── 타이머 ─────────────────────────── */

function clearBotTimers(room) {
  room.timers.bots.forEach(clearTimeout);
  room.timers.bots = [];
}
function clearAll(room) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.resume); room.timers.resume = null;
  clearTimeout(room.timers.nudge); room.timers.nudge = null;
  clearBotTimers(room);
}

/* ─────────────────────────── 진행 ─────────────────────────── */

function startGame(room) {
  clearAll(room);
  const players = room.players;
  if (players.length < 2) return;

  const deck = makeDeck();
  players.forEach((p, i) => {
    p.hand = []; p.table = []; p.out = false;
    p.hits = 0; p.misses = 0; p.best = null;
  });
  deck.forEach((c, i) => players[i % players.length].hand.push(c));

  room.phase = 'playing';
  room.resolving = false;
  room.frozen = false;
  room.winner = null;
  room.fiveSince = 0;
  room.lock = {};
  room.turn = players[0].id;

  ev(room, { kind: 'start' });
  beginTurn(room, 0);
}

/** fromIdx 부터 시작해 카드를 뒤집을 수 있는 다음 사람을 찾아 차례를 넘긴다 */
function beginTurn(room, fromIdx) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.nudge); room.timers.nudge = null;
  if (room.phase !== 'playing' || room.resolving) return;

  // 같은 과일 5개가 떠 있는 동안엔 아무도 다음 카드를 깔 수 없다.
  // 누군가 종(=타자)을 칠 때까지 판이 멈춘다.
  room.frozen = fivesOf(sums(room)).length > 0;

  const n = room.players.length;
  if (!n) return;
  let target = null;
  for (let i = 0; i < n; i++) {
    const p = room.players[(fromIdx + i) % n];
    if (canFlip(p)) { target = p; break; }
  }

  if (room.frozen) {
    room.turn = target ? target.id : null;
    room.turnEndsAt = 0;
    armNudge(room);
    pushState(room);
    return;
  }

  if (!target) {                       // 아무도 못 뒤집음 → 카드 수로 종료
    return endGame(room, null);
  }

  room.turn = target.id;
  const limit = target.connected ? room.cfg.turnLimit : DC_FLIP_DELAY;
  room.turnEndsAt = limit > 0 ? Date.now() + limit : 0;

  if (target.bot) {
    const [lo, hi] = BOT[room.cfg.botDiff].flip;
    room.timers.turn = setTimeout(() => doFlip(room, target.id, true), rnd(lo, hi));
  } else if (limit > 0) {
    room.timers.turn = setTimeout(() => doFlip(room, target.id, true), limit);
  }
  pushState(room);
}

function armNudge(room) {
  clearTimeout(room.timers.nudge);
  room.timers.nudge = setTimeout(() => {
    if (room.phase === 'playing' && room.frozen && !room.resolving) {
      ev(room, { kind: 'nudge' });
      armNudge(room);
    }
  }, 15_000);
}

function doFlip(room, playerId, auto) {
  if (room.phase !== 'playing' || room.resolving || room.frozen) return;
  if (room.turn !== playerId) return;
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;
  const p = room.players[idx];
  if (!canFlip(p)) return beginTurn(room, idx + 1);

  clearTimeout(room.timers.turn); room.timers.turn = null;
  room.lastActive = Date.now();

  const card = p.hand.shift();
  p.table.push(card);
  ev(room, { kind: 'flip', by: p.id, card, auto: !!auto });

  evaluate(room);
  beginTurn(room, idx + 1);
}

/** 테이블에 5가 있는지 보고 봇들의 반응을 예약한다 */
function evaluate(room) {
  clearBotTimers(room);
  if (room.phase !== 'playing') return;

  const s = sums(room);
  const fives = fivesOf(s);
  room.fiveSince = fives.length ? Date.now() : 0;

  if (!botsMayCall(room)) return;      // 사람이 2명 이상 → 봇은 종을 치지 않는다

  const cfg = BOT[room.cfg.botDiff];
  for (const p of room.players) {
    if (!p.bot || !inPlay(p)) continue;

    if (fives.length) {
      const fruit = pick(fives);
      if (Math.random() < cfg.miss) {
        // 한 번 놓쳤어도 판이 길어지면 뒤늦게 알아채기도 한다
        if (Math.random() < 0.5) {
          room.timers.bots.push(setTimeout(() => doCall(room, p.id, fruit), rnd(2300, 4300)));
        }
        continue;
      }
      room.timers.bots.push(setTimeout(() => doCall(room, p.id, fruit), rnd(cfg.min, cfg.max)));
    } else {
      // 4개/6개처럼 아슬아슬할 때 가끔 잘못 외친다
      const near = FRUITS.filter(f => s[f] === 4 || s[f] === 6);
      if (near.length && Math.random() < cfg.falseCall) {
        const f = pick(near);
        room.timers.bots.push(setTimeout(() => doCall(room, p.id, f), rnd(cfg.min, cfg.max)));
      }
    }
  }
}

/** 종 치기 = 과일 이름 외치기 */
function doCall(room, playerId, fruit) {
  if (room.phase !== 'playing' || room.resolving) return;
  if (!FRUITS.includes(fruit)) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p || !inPlay(p)) return;
  if ((room.lock[p.id] || 0) > Date.now()) return;

  const s = sums(room);
  const correct = s[fruit] === 5;

  room.resolving = true;
  clearAll(room);
  room.lastActive = Date.now();

  let payload;
  if (correct) {
    const rt = room.fiveSince ? Date.now() - room.fiveSince : null;
    const pot = [];
    for (const q of room.players) { pot.push(...q.table); q.table = []; }
    p.hand.push(...shuffle(pot));
    p.hits++;
    if (rt != null && (p.best == null || rt < p.best)) p.best = rt;
    payload = { kind: 'call', ok: true, by: p.id, fruit, gained: pot.length, rt };
    room.turn = p.id;                      // 다음 뒤집기는 이긴 사람부터
  } else {
    const targets = room.players.filter(q => q !== p && inPlay(q));
    let given = 0;
    for (const t of targets) {
      if (p.hand.length) { t.hand.push(p.hand.shift()); given++; }
      else if (p.table.length) { t.hand.push(p.table.pop()); given++; }
    }
    p.misses++;
    room.lock[p.id] = Date.now() + WRONG_LOCK;
    payload = { kind: 'call', ok: false, by: p.id, fruit, count: s[fruit], given };
  }

  ev(room, payload);
  sweepOut(room);
  pushState(room);

  room.timers.resume = setTimeout(() => {
    room.resolving = false;
    if (room.phase !== 'playing') return;
    if (checkEnd(room)) return;
    evaluate(room);
    const idx = Math.max(0, room.players.findIndex(x => x.id === room.turn));
    beginTurn(room, correct ? idx : idx);
  }, correct ? RESOLVE_PAUSE_OK : RESOLVE_PAUSE_NG);
}

/** 손패·앞면이 모두 0인 사람을 탈락 처리 */
function sweepOut(room) {
  for (const p of room.players) {
    if (!p.out && p.hand.length === 0 && p.table.length === 0) {
      p.out = true;
      ev(room, { kind: 'out', by: p.id });
    }
  }
}

function checkEnd(room) {
  const alive = room.players.filter(inPlay);
  if (alive.length <= 1) { endGame(room, alive[0] || null); return true; }
  return false;
}

function endGame(room, winner) {
  clearAll(room);
  if (!winner) {
    // 아무도 뒤집을 수 없는 교착 상태 → 가진 카드가 가장 많은 사람 승
    const ranked = room.players.filter(p => !p.out)
      .sort((a, b) => (b.hand.length + b.table.length) - (a.hand.length + a.table.length));
    winner = ranked[0] || null;
  }
  room.phase = 'over';
  room.resolving = false;
  room.frozen = false;
  room.turn = null;
  room.turnEndsAt = 0;
  room.winner = winner ? winner.id : null;
  ev(room, { kind: 'end', by: room.winner });
  pushState(room);
}

/* ─────────────────────────── 메시지 처리 ─────────────────────────── */

function attach(room, p, ws) {
  p.ws = ws; p.connected = true;
  ws.roomCode = room.code; ws.playerId = p.id;
  send(ws, { t: 'welcome', you: p.id, token: p.token, code: room.code });
  pushState(room);
}

function handle(ws, msg) {
  const room = rooms.get(ws.roomCode);

  switch (msg.t) {
    case 'create': {
      const r = createRoom();
      const p = addPlayer(r, { name: clean(msg.name, 12) || '플레이어 1' });
      attach(r, p, ws);
      return;
    }

    case 'join': {
      const code = clean(msg.code, 8).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
      if (r.phase !== 'lobby') return send(ws, { t: 'err', msg: '이미 시작한 방이에요.' });
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
      const p = addPlayer(r, { name: clean(msg.name, 12) || `플레이어 ${r.players.length + 1}` });
      attach(r, p, ws);
      ev(r, { kind: 'joined', by: p.id });
      return;
    }

    case 'resume': {
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '방이 사라졌어요.', fatal: true });
      const p = r.players.find(x => x.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '자리를 찾을 수 없어요.', fatal: true });
      if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (_) {} }
      attach(r, p, ws);
      return;
    }
  }

  if (!room) return;
  const me = room.players.find(p => p.id === ws.playerId);
  if (!me) return;
  const isHost = room.hostId === me.id;
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'name':
      me.name = clean(msg.name, 12) || me.name;
      pushState(room);
      break;

    case 'addBot': {
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '자리가 없어요.' });
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `봇 ${room.players.length + 1}`;
      addPlayer(room, { name, bot: true });
      pushState(room);
      break;
    }

    case 'removeBot': {
      if (!isHost || room.phase === 'playing') return;
      const target = room.players.find(p => p.id === msg.id && p.bot);
      if (target) { removePlayer(room, target.id); pushState(room); }
      break;
    }

    case 'kick': {
      if (!isHost || room.phase === 'playing') return;
      const target = room.players.find(p => p.id === msg.id && p.id !== room.hostId);
      if (!target) return;
      if (target.ws) send(target.ws, { t: 'err', msg: '방장이 내보냈어요.', fatal: true });
      removePlayer(room, target.id);
      pushState(room);
      break;
    }

    case 'cfg': {
      if (!isHost) return;
      if (['easy', 'normal', 'hard'].includes(msg.botDiff)) room.cfg.botDiff = msg.botDiff;
      if ([0, 4000, 6000, 9000].includes(msg.turnLimit)) room.cfg.turnLimit = msg.turnLimit;
      pushState(room);
      break;
    }

    case 'start':
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length < 2) return send(ws, { t: 'err', msg: '2명 이상이어야 시작할 수 있어요.' });
      startGame(room);
      break;

    case 'flip':
      doFlip(room, me.id, false);
      break;

    case 'call':
      doCall(room, me.id, msg.fruit);
      break;

    case 'again':
      if (!isHost) return;
      if (room.phase === 'over') startGame(room);
      break;

    case 'leave':
      removePlayer(room, me.id);
      ws.roomCode = null;
      pushState(room);
      break;
  }
}

/* ─────────────────────────── 서버 ─────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = decodeURIComponent(url.pathname);

  if (file === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
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
    try { handle(ws, msg); }
    catch (e) { console.error('handle error', e); }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = room.players.find(x => x.id === ws.playerId);
    if (!p) return;
    p.connected = false; p.ws = null;

    if (room.phase === 'lobby') {
      removePlayer(room, p.id);
    } else if (room.turn === p.id) {
      // 접속이 끊긴 사람의 차례면 곧바로 자동으로 넘긴다
      const idx = room.players.findIndex(x => x.id === p.id);
      clearTimeout(room.timers.turn);
      room.timers.turn = setTimeout(() => doFlip(room, p.id, true), DC_FLIP_DELAY);
    }
    pushState(room);
  });
});

// 끊긴 소켓 정리 + 빈 방 청소
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    if (humans === 0 && now - room.lastActive > 90_000) {
      clearAll(room);
      rooms.delete(code);
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`할리갈리 서버 → http://localhost:${PORT}`);
});
