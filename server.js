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
// 정품 할리갈리 분포: 과일당 1개×5, 2개×3, 3개×3, 4개×2, 5개×1 = 14장
const COUNT_DIST = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5];

/* ── 익스트림 과일 카드 ─────────────────────────────
   한 장에 과일 종류가 1~3가지 들어가고, 같은 종류는 하나씩만 그려진다.
   '같은 배치' = 그려진 과일 조합이 똑같은 카드, 즉 d 가 같은 카드.
      과일 1종 카드  … 4종(과일마다 하나씩) × 4장 = 16
      과일 2종 카드  … 6종(2가지 조합 전부) × 4장 = 24
      과일 3종 카드  … 4종(딸바포·딸바라·딸라포·라바포) × 6장 = 24
   총 과일 64장 + 동물 8장 = 72장.
   장수를 바꾸려면 EX_COPIES 만 고치면 된다. */
const EX_COPIES = { 1: 4, 2: 4, 3: 6 };

function exDesigns() {
  const out = [];
  const combos = (k) => {
    const res = [];
    const walk = (start, acc) => {
      if (acc.length === k) { res.push(acc.slice()); return; }
      for (let i = start; i < FRUITS.length; i++) { acc.push(FRUITS[i]); walk(i + 1, acc); acc.pop(); }
    };
    walk(0, []);
    return res;
  };
  for (const k of [1, 2, 3]) {
    for (const c of combos(k)) out.push({ f: c, copies: EX_COPIES[k] });
  }
  return out;
}

const ANIMALS = ['elephant', 'monkey', 'pig'];
const ANIMAL_COPIES = { elephant: 3, monkey: 3, pig: 2 };

const NAMES = {
  banana:     ['바나나', 'banana'],
  lime:       ['라임', 'lime', 'lemon', '레몬'],
  strawberry: ['딸기', 'strawberry', 'berry'],
  grape:      ['포도', 'grape', 'grapes'],
  elephant:   ['코끼리', 'elephant'],
  monkey:     ['원숭이', 'monkey'],
  pig:        ['돼지', 'pig'],
  pair:       ['짝', '같다', 'pair', 'same'],
};

const norm = w => String(w || '').trim().toLowerCase().replace(/\s+/g, '').slice(-24);

/** 입력의 끝이 어떤 이름과 맞는지 — 가장 긴 것을 고른다 */
function matchWord(word, keys) {
  let best = null, len = 0;
  for (const k of keys) {
    for (const nm of NAMES[k]) {
      if (nm.length > len && word.endsWith(nm)) { best = k; len = nm.length; }
    }
  }
  return best;
}

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



/* 카드 한 장 = { d: 배치 id, f: [과일...] } · 동물 카드는 { d, sp: 동물 } */
function basicFruitDeck() {
  const deck = [];
  for (const f of FRUITS) for (const n of COUNT_DIST) {
    deck.push({ d: f + ':' + n, f: Array(n).fill(f) });
  }
  return deck;
}
function exFruitDeck() {
  const deck = [];
  for (const d of exDesigns()) {
    const key = d.f.join('+');
    for (let c = 0; c < d.copies; c++) deck.push({ d: key, f: d.f.slice() });
  }
  return deck;
}
function animalDeck() {
  const deck = [];
  for (const a of ANIMALS) {
    for (let c = 0; c < ANIMAL_COPIES[a]; c++) deck.push({ d: 'a' + a, sp: a });
  }
  return deck;
}

/* ─────────────────────────────────────────────────────────
   모드는 여기 한 곳에서만 갈린다.
   덱 · 칠 수 있는 말 · 종 조건 · 판정이 모두 이 표에 들어 있고,
   바깥 코드는 modeOf(room) 을 통해서만 접근한다.
   ───────────────────────────────────────────────────────── */
const MODES = {
  basic: {
    ko: '기본',
    deck: () => basicFruitDeck(),
    words: () => FRUITS,                       // 칠 수 있는 말 (그 외는 모르는 말)
    hasAnimals: false,
    ringable(room) {
      return fivesOf(sums(room)).map(f => ({ key: f }));
    },
    judge(room, label) {
      const count = sums(room)[label];
      return { ok: count === 5, reason: 'count', count };
    },
  },

  extreme: {
    ko: '익스트림',
    deck: () => [...exFruitDeck(), ...animalDeck()],
    words: () => ['pair', ...ANIMALS],
    hasAnimals: true,
    ringable(room) {
      const x = extremeState(room);
      const out = [];
      if (x.ok.pair) out.push({ key: 'pair' });
      for (const a of ANIMALS) if (x.ok[a]) out.push({ key: a });
      return out;
    },
    judge(room, label) {
      const x = extremeState(room);
      if (label === 'pair') return { ok: x.ok.pair, reason: 'pair', count: null };
      return { ok: !!x.ok[label], reason: x.up.has(label) ? label : 'noanimal', count: null };
    },
  },
};
const MODE_KEYS = Object.keys(MODES);
const modeOf = room => MODES[room.cfg.mode] || MODES.basic;

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
    phase: 'lobby',              // lobby | ready | playing | over
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
    cfg: { botDiff: 'normal', turnLimit: 6000, mode: 'basic' },
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
    if (top.sp) continue;                       // 동물 카드는 과일이 아니다
    for (const f of top.f) s[f]++;
  }
  return s;
}
const fivesOf = s => FRUITS.filter(f => s[f] === 5);

function topCards(room) {
  const out = [];
  for (const p of room.players) {
    if (p.out || !p.table.length) continue;
    out.push(p.table[p.table.length - 1]);
  }
  return out;
}

/** 지금 테이블에 깔려 있는 동물 카드 */
function animalsUp(room) {
  if (!modeOf(room).hasAnimals) return [];
  const up = new Set(topCards(room).filter(c => c.sp).map(c => c.sp));
  return ANIMALS.filter(a => up.has(a));
}

/**
 * 익스트림 종 조건
 *  - 같은 배치(같은 과일·같은 개수) 카드가 두 장 이상  → 그 과일 이름
 *  - 코끼리가 있고 테이블에 딸기가 하나도 없음        → "코끼리"
 *  - 원숭이가 있고 테이블에 라임이 하나도 없음        → "원숭이"
 *  - 돼지가 있음 (조건 없음)                          → "돼지"
 */
function extremeState(room) {
  const tops = topCards(room);
  const s = sums(room);
  const up = new Set(tops.filter(c => c.sp).map(c => c.sp));

  const seen = new Set(), pairs = new Set();
  for (const c of tops) {
    if (c.sp) continue;
    if (seen.has(c.d)) pairs.add(c.d);          // 그려진 조합이 똑같은 카드 두 장
    seen.add(c.d);
  }

  return {
    sums: s,
    pairs,
    ok: {
      pair: pairs.size > 0,
      pig: up.has('pig'),
      elephant: up.has('elephant') && s.strawberry === 0,
      monkey: up.has('monkey') && s.lime === 0,
    },
    up,
  };
}

/** 지금 칠 수 있는 말들 */
function ringableWords(room) {
  return modeOf(room).ringable(room);
}

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
    animals: animalsUp(room),
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

  const deck = shuffle(modeOf(room).deck());
  players.forEach((p, i) => {
    p.hand = []; p.table = []; p.out = false;
    p.hits = 0; p.misses = 0; p.best = null;
  });
  deck.forEach((c, i) => players[i % players.length].hand.push(c));

  room.phase = 'ready';           // 카드는 깔렸지만 아직 아무도 못 뒤집는다
  room.resolving = false;
  room.frozen = false;
  room.winner = null;
  room.fiveSince = 0;
  room.lock = {};
  room.turn = players[0].id;
  room.turnEndsAt = 0;

  ev(room, { kind: 'dealt' });
  pushState(room);
}

/** 방장이 테이블에서 시작을 누르면 그때 첫 차례가 열린다 */
function beginGame(room) {
  if (room.phase !== 'ready') return;
  room.phase = 'playing';
  const idx = Math.max(0, room.players.findIndex(p => p.id === room.turn));
  ev(room, { kind: 'start' });
  beginTurn(room, idx);
}

/** fromIdx 부터 시작해 카드를 뒤집을 수 있는 다음 사람을 찾아 차례를 넘긴다 */
function beginTurn(room, fromIdx) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.nudge); room.timers.nudge = null;
  if (room.phase !== 'playing' || room.resolving) return;

  // 칠 수 있는 조건이 하나라도 성립하면, 누가 칠 때까지 아무도 카드를 못 깐다
  room.frozen = ringableWords(room).length > 0;

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

const STALL_MS = 8_000;

/** 아무도 못 알아채고 오래 멈춰 있으면 살짝 찔러주고, 봇이 판을 되살린다 */
function armNudge(room) {
  clearTimeout(room.timers.nudge);
  room.timers.nudge = setTimeout(() => {
    if (room.phase !== 'playing' || !room.frozen || room.resolving) return;
    ev(room, { kind: 'nudge' });

    // 다 같이 놓치면 판이 영영 멈춘다.
    // 봇이 있으면 이번엔 확실히 치게 해서 진행을 살린다(사람이 먼저 칠 여유는 남긴다).
    const win = ringableWords(room);
    const bots = room.players.filter(p => p.bot && inPlay(p));
    if (win.length && bots.length && botsMayCall(room)) {
      const word = NAMES[pick(win).key][0];
      const who = pick(bots);
      room.timers.bots.push(setTimeout(() => doCall(room, who.id, word), rnd(1400, 2800)));
    }
    armNudge(room);
  }, STALL_MS);
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

/** 칠 거리가 생겼는지 보고 봇들의 반응을 예약한다 */
function evaluate(room) {
  clearBotTimers(room);
  if (room.phase !== 'playing') return;

  const win = ringableWords(room);
  room.fiveSince = win.length ? Date.now() : 0;

  if (!botsMayCall(room)) return;      // 사람이 2명 이상 → 봇은 종을 치지 않는다

  const cfg = BOT[room.cfg.botDiff];
  const s = sums(room);
  const ex = modeOf(room).hasAnimals ? extremeState(room) : null;

  for (const p of room.players) {
    if (!p.bot || !inPlay(p)) continue;

    if (win.length) {
      const word = NAMES[pick(win).key][0];
      if (Math.random() < cfg.miss) {
        if (Math.random() < 0.5) {
          room.timers.bots.push(setTimeout(() => doCall(room, p.id, word), rnd(2300, 4300)));
        }
        continue;
      }
      room.timers.bots.push(setTimeout(() => doCall(room, p.id, word), rnd(cfg.min, cfg.max)));
    } else {
      // 아깝게 안 되는 상황에서 가끔 잘못 친다
      const near = [];
      if (ex) {
        for (const a of ANIMALS) if (ex.up.has(a) && !ex.ok[a]) near.push(a);   // 조건 안 맞는 동물
        if (!ex.ok.pair) near.push('pair');                                      // 짝이 아닌데 짝
      } else {
        for (const f of FRUITS) if (s[f] === 4 || s[f] === 6) near.push(f);
      }
      if (near.length && Math.random() < cfg.falseCall) {
        room.timers.bots.push(setTimeout(() => doCall(room, p.id, NAMES[pick(near)][0]), rnd(cfg.min, cfg.max)));
      }
    }
  }
}

/** 종 치기 = 이름 타자. 판정은 전부 서버가 한다. */
function doCall(room, playerId, rawWord) {
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  // 무시할 때도 왜 무시했는지 돌려준다. 아무 반응이 없으면 입력창에 글자가 남아 죽는다.
  const drop = why => { if (!p.bot) send(p.ws, { t: 'drop', why }); };

  if (room.phase !== 'playing') return drop('notplaying');
  if (room.resolving) return drop('resolving');
  if (!inPlay(p)) return drop('out');
  if ((room.lock[p.id] || 0) > Date.now()) return drop('locked');

  const word = norm(rawWord);
  if (!word) return;

  const mode = modeOf(room);
  const label = matchWord(word, mode.words());
  if (!label) return drop('noword');         // 이 모드에서 쓰지 않는 말
  const { ok: correct, reason, count } = mode.judge(room, label);

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
    payload = { kind: 'call', ok: true, by: p.id, label, gained: pot.length, rt };
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
    payload = { kind: 'call', ok: false, by: p.id, label, count, given, reason };
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
    beginTurn(room, idx);
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
      if (MODE_KEYS.includes(msg.mode)) r.cfg.mode = msg.mode;
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
      if (!isHost || room.phase === 'playing' || room.phase === 'ready') return;
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
      if (MODE_KEYS.includes(msg.mode) && room.phase === 'lobby') room.cfg.mode = msg.mode;
      pushState(room);
      break;
    }

    case 'start':
      if (!isHost || room.phase === 'playing' || room.phase === 'ready') return;
      if (room.players.length < 2) return send(ws, { t: 'err', msg: '2명 이상이어야 시작할 수 있어요.' });
      startGame(room);
      break;

    case 'go':
      if (!isHost) return;
      beginGame(room);
      break;

    case 'flip':
      doFlip(room, me.id, false);
      break;

    case 'call':
      doCall(room, me.id, msg.word);
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

/** 모드 구성이 어긋나면 게임 중이 아니라 시작할 때 바로 터지게 한다 */
function selfCheck() {
  for (const key of MODE_KEYS) {
    const m = MODES[key];
    const deck = m.deck();
    const animals = deck.filter(c => c.sp).length;

    if (m.hasAnimals && animals === 0) throw new Error(`${key}: 동물 카드가 없습니다`);
    if (!m.hasAnimals && animals > 0) throw new Error(`${key}: 동물 카드가 섞였습니다`);

    for (const w of m.words()) {
      if (!NAMES[w]) throw new Error(`${key}: '${w}' 의 이름 목록이 없습니다`);
    }
    for (const c of deck) {
      if (c.sp) {
        if (!ANIMALS.includes(c.sp)) throw new Error(`${key}: 모르는 동물 ${c.sp}`);
        continue;
      }
      if (!Array.isArray(c.f) || !c.f.length) throw new Error(`${key}: 과일 없는 카드`);
      for (const f of c.f) if (!FRUITS.includes(f)) throw new Error(`${key}: 모르는 과일 ${f}`);
      if (!c.d) throw new Error(`${key}: 배치 id 없는 카드`);
    }
    console.log(`  ${m.ko.padEnd(5)} ${String(deck.length).padStart(3)}장` +
      ` (과일 ${deck.length - animals} · 동물 ${animals})` +
      ` · 칠 수 있는 말: ${m.words().map(w => NAMES[w][0]).join(' / ')}`);
  }
}

server.listen(PORT, () => {
  selfCheck();
  console.log(`할리갈리 서버 → http://localhost:${PORT}`);
});
