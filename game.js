'use strict';
/**
 * 할리갈리 — 판 진행과 방 관리.
 *  - 게임 상태/판정/타이머/봇은 전부 서버가 관리한다(권위 서버).
 *  - 통신 방식은 모른다. 소켓은 send(문자열) · close() · readyState 만 있으면 된다.
 *    Node 서버(server.js)와 Cloudflare(worker.js)가 이 파일을 똑같이 쓴다.
 */

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
const LOBBY_GRACE = 20_000;      // 대기실에서 끊긴 자리를 비우기까지 (새로고침은 이 안에 돌아온다)

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

const token = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)),
  b => b.toString(16).padStart(2, '0')).join('');
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
    cfg: { botDiff: 'normal', turnLimit: 6000, mode: 'basic', spaceBell: false },
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
  clearTimeout(gone.leaveT);
  if (room.hostId === gone.id) {
    const next = room.players.find(p => !p.bot && p.connected) || room.players.find(p => !p.bot);
    room.hostId = next ? next.id : null;
  }
  if (room.phase === 'playing') {
    sweepOut(room);
    // 나간 사람의 앞면 카드도 같이 빠진다. 그 카드로 성립하던 "다섯"이 사라졌을 수 있고
    // (얼린 채로 아무도 못 치고 못 뒤집는 판이 된다), 혼자 남았으면 판이 끝나야 한다.
    if (checkEnd(room)) return;
    if (room.resolving) return;             // 판정 중이면 재개 타이머가 다시 계산한다
    evaluate(room);
    const cur = room.players.findIndex(x => x.id === room.turn);
    beginTurn(room, cur >= 0 ? cur : i);
  }
}

const inPlay = p => !p.out && (p.hand.length > 0 || p.table.length > 0);
const humansOf = room => room.players.filter(p => !p.bot).length;
/** 사람끼리 붙을 땐 봇은 카드만 넘겨주는 딜러 역할 — 종은 사람만 친다 */
// 끊겼거나 탈락한 사람까지 세면, 혼자 남은 사람이 봇과 하는데도 봇이 종을 안 친다.
const botsMayCall = room => room.players.filter(p => !p.bot && p.connected && inPlay(p)).length <= 1;
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
/** 종을 칠 수 있는 상태인지 — 아니면 이유를 돌려주고 false.
    무시할 때도 이유를 알려준다. 아무 반응이 없으면 입력창에 글자가 남아 죽는다. */
function canRing(room, p) {
  const drop = why => { if (!p.bot) send(p.ws, { t: 'drop', why }); return false; };
  if (room.phase !== 'playing') return drop('notplaying');
  if (room.resolving) return drop('resolving');
  if (!inPlay(p)) return drop('out');
  if ((room.lock[p.id] || 0) > Date.now()) return drop('locked');
  return true;
}

/** 이름을 타자로 쳐서 종 치기 */
function doCall(room, playerId, rawWord) {
  const p = room.players.find(x => x.id === playerId);
  if (!p || !canRing(room, p)) return;

  const word = norm(rawWord);
  if (!word) return;

  const mode = modeOf(room);
  const label = matchWord(word, mode.words());
  if (!label) {                              // 이 모드에서 쓰지 않는 말
    if (!p.bot) send(p.ws, { t: 'drop', why: 'noword' });
    return;
  }
  const { ok, reason, count } = mode.judge(room, label);
  settle(room, p, { correct: ok, label, reason, count });
}

/** 스페이스바로 종 치기 — 이름 없이 '지금 칠 조건인가' 만 본다 */
function doBell(room, playerId) {
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  if (!room.cfg.spaceBell) {
    if (!p.bot) send(p.ws, { t: 'drop', why: 'nospace' });
    return;
  }
  if (!canRing(room, p)) return;

  const win = ringableWords(room);
  settle(room, p, {
    correct: win.length > 0,
    label: win.length ? win[0].key : null,
    reason: 'nobell',
    count: null,
    bell: true,
  });
}

/** 성공/오답 정산 — 타자든 스페이스바든 여기로 모인다 */
function settle(room, p, { correct, label, reason, count, bell }) {
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
    payload = { kind: 'call', ok: true, by: p.id, label, gained: pot.length, rt, bell: !!bell };
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
    payload = { kind: 'call', ok: false, by: p.id, label, count, given, reason, bell: !!bell };
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
  clearTimeout(p.leaveT);
  const wasGone = !p.connected;
  p.ws = ws; p.connected = true;
  // 내 차례에 끊겨서 1.5초 뒤 대신 뒤집어 주려던 예약이 걸려 있으면, 원래 제한시간으로 되돌린다.
  // (그대로 두면 새로고침만 해도 '자동 넘김 없음' 방에서 카드가 저절로 뒤집힌다.)
  if (wasGone && room.phase === 'playing' && room.turn === p.id && !room.resolving && !room.frozen) {
    clearTimeout(room.timers.turn); room.timers.turn = null;
    const limit = room.cfg.turnLimit;
    room.turnEndsAt = limit > 0 ? Date.now() + limit : 0;
    if (limit > 0) room.timers.turn = setTimeout(() => doFlip(room, p.id, true), limit);
  }
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
      // 먼저 붙어 있던 소켓(복제한 탭 등)은 4001 로 닫는다. 그 탭은 스스로 다시 붙지 않으므로
      // 두 탭이 서로를 밀어내며 끝없이 다시 붙는 일이 없다.
      if (p.ws && p.ws !== ws) { try { p.ws.close(4001, 'moved'); } catch (_) {} }
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
      if (typeof msg.spaceBell === 'boolean') room.cfg.spaceBell = msg.spaceBell;
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

    // 같은 방 사람끼리 하는 잡담. 판정에는 아무 영향이 없고 서버는 저장하지 않는다.
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const now = Date.now();
      if (now - (me.lastChat || 0) < 400) return;      // 도배 막기
      me.lastChat = now;
      broadcast(room, { t: 'chat', from: me.id, name: me.name, text });
      break;
    }

    case 'bell':
      doBell(room, me.id);
      break;

    case 'again':
      if (!isHost) return;
      if (room.phase === 'over') startGame(room);
      break;

    // 끝난 판을 접고 대기실로. 대기실이어야 새 사람이 코드로 들어올 수 있다.
    case 'lobby': {
      if (!isHost || room.phase !== 'over') return;
      clearAll(room);
      room.phase = 'lobby';
      room.turn = null; room.turnEndsAt = 0; room.winner = null;
      room.resolving = false; room.frozen = false; room.fiveSince = 0; room.lock = {};
      for (const p of room.players) { p.hand = []; p.table = []; p.out = false; }
      pushState(room);
      break;
    }

    case 'leave':
      removePlayer(room, me.id);
      ws.roomCode = null;
      pushState(room);
      break;
  }
}

/** 소켓이 닫혔다. 그 사이 같은 자리가 새 소켓으로 다시 붙었으면(새로고침) 건드리지 않는다.
 *  keepSeat — 서버가 스스로 끊은 경우(오래 조작 없음 · 소식 없음). 사람은 나간 게 아니라서
 *  대기실 자리를 지워 버리면 "누르면 다시 붙어요" 가 거짓말이 된다. 자리는 두고 방장만 넘긴다. */
function disconnect(ws, { keepSeat = false } = {}) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = room.players.find(x => x.id === ws.playerId);
  if (!p || p.ws !== ws) return;
  p.connected = false; p.ws = null;
  room.lastActive = Date.now();              // 빈 방 청소는 마지막 사람이 떠난 때부터 센다

  // 방장이 끊기면 붙어 있는 사람에게 넘긴다 — 판 중이든 끝난 뒤든.
  // 안 그러면 '시작'·'다시 하기'·'대기실로'를 누를 사람이 없어 방이 멈춘다.
  if (room.hostId === p.id) {
    const next = room.players.find(x => !x.bot && x.connected);
    if (next) room.hostId = next.id;
  }

  if (room.phase === 'lobby') {
    // 새로고침·앱 전환은 소켓이 먼저 닫히고 곧바로 다시 붙는다. 그 사이에 자리를 지우면
    // 돌아왔을 때 "자리를 찾을 수 없어요" 로 쫓겨난다. 잠깐 기다렸다가 그래도 없으면 뺀다.
    // 서버가 스스로 끊은 경우(keepSeat)는 사람이 나간 게 아니므로 자리를 그대로 둔다.
    clearTimeout(p.leaveT);
    if (!keepSeat) {
      p.leaveT = setTimeout(() => {
        if (p.connected || room.phase !== 'lobby' || rooms.get(room.code) !== room) return;
        removePlayer(room, p.id);
        pushState(room);
      }, LOBBY_GRACE);
    }
  } else if (room.turn === p.id) {
    // 접속이 끊긴 사람의 차례면 곧바로 자동으로 넘긴다
    clearTimeout(room.timers.turn);
    room.timers.turn = setTimeout(() => doFlip(room, p.id, true), DC_FLIP_DELAY);
  }
  pushState(room);
}

/** 사람이 다 떠난 방을 치운다. 통신 쪽이 30초마다 부른다.
 *  대기실에 자리만 남은 사람이 있으면(서버가 오래 조작 없는 연결을 닫은 경우) 10분까지 기다려 준다. */
function sweepRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    const seated = room.phase === 'lobby' && room.players.some(p => !p.bot);
    if (humans === 0 && now - room.lastActive > (seated ? 10 * 60_000 : 90_000)) {
      clearAll(room);
      rooms.delete(code);
    }
  }
}

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

module.exports = { rooms, handle, disconnect, sweepRooms, selfCheck, MAX_PLAYERS };
