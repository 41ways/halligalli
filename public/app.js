'use strict';
/* 할리갈리 — 클라이언트 */

const FRUITS = [
  { id:'banana',     ko:'바나나', emoji:'🍌', names:['바나나','banana'] },
  { id:'lime',       ko:'라임',   emoji:'🍋', names:['라임','lime','lemon','레몬'] },
  { id:'strawberry', ko:'딸기',   emoji:'🍓', names:['딸기','strawberry','berry'] },
  { id:'grape',      ko:'포도',   emoji:'🍇', names:['포도','grape','grapes'] },
];
const F = Object.fromEntries(FRUITS.map(f => [f.id, f]));
const NAME2ID = {};
FRUITS.forEach(f => f.names.forEach(n => NAME2ID[n] = f.id));

/* 원작 카드처럼 과일이 흩어져 배치되는 좌표 [x%, y%, 회전deg] */
const PIPS = {
  1: [[50,50,-4]],
  2: [[33,30,-13],[67,70,11]],
  3: [[32,26,-15],[50,50,5],[68,74,13]],
  4: [[31,29,-11],[69,29,9],[31,71,8],[69,71,-9]],
  5: [[30,26,-13],[70,26,10],[50,50,-3],[30,74,9],[70,74,-10]],
};

/** 받침이 있으면 앞쪽, 없으면 뒤쪽 조사를 붙인다 — "라임은 / 딸기는" */
function hasBatchim(w) {
  const c = String(w).charCodeAt(String(w).length - 1);
  if (!(c >= 0xAC00 && c <= 0xD7A3)) return false;
  return (c - 0xAC00) % 28 !== 0;
}
const josa = (w, withB, withoutB) => w + (hasBatchim(w) ? withB : withoutB);

const $ = id => document.getElementById(id);
const el = {};
['scLogin','scLobby','scGame','inName','inCode','btnCreate','btnJoin','loginHint',
 'roomCode','btnCopy','lobbyPlayers','hostBox','optDiff','optLimit',
 'btnAddBot','btnStart','lobbyHint','barCode','btnLeave','tally',
 'entry','btnFlip','flipTimer','status','log','overlay','ovTitle','ovSub','btnAgain',
 'btnToLobby','toast','verdict','ovRank','theme','themeGame','board','slots','bell','btnSound','bigToggle','btnGo','waitMsg','turnNow','startGate'].forEach(k => el[k] = $(k));

let ws = null, me = null, S = null, clockOffset = 0;
let flashInfo = null, flashUntil = 0, verdictTimer = null;

/* ───────────── 소리 ───────────── */
let actx = null;
let muted = localStorage.getItem('hgMute') !== '0';   // 기본은 무음
function setMuted(v) {
  muted = v;
  localStorage.setItem('hgMute', v ? '1' : '0');
  el.btnSound.textContent = v ? '🔇' : '🔊';
  el.btnSound.title = v ? '소리 켜기' : '소리 끄기';
}
function tone(freq, dur, type, gain) {
  if (muted) return;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(gain || .06, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch (_) {}
}
const sfxFlip  = () => tone(300, .06, 'triangle', .035);
const sfxRight = () => { tone(880, .12, 'sine', .09); setTimeout(() => tone(1320, .22, 'sine', .08), 90); };
const sfxWrong = () => tone(150, .3, 'sawtooth', .07);

/* ───────────── 화면 ───────────── */
function show(which) {
  el.scLogin.hidden = which !== 'login';
  el.scLobby.hidden = which !== 'lobby';
  el.scGame.hidden  = which !== 'game';
  if (which === 'game') setTimeout(() => el.entry.focus(), 30);
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2400);
}

function log(html, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.innerHTML = html;
  el.log.prepend(d);
  while (el.log.children.length > 40) el.log.lastChild.remove();
}

/* ───────────── 연결 ───────────── */
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => onOpen && onOpen();
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.t === 'welcome') {
      me = m.you;
      sessionStorage.setItem('hg', JSON.stringify({ code: m.code, token: m.token }));
      location.hash = m.code;
    } else if (m.t === 'state') {
      onState(m);
    } else if (m.t === 'ev') {
      onEvent(m);
    } else if (m.t === 'err') {
      toast(m.msg);
      if (m.fatal) { sessionStorage.removeItem('hg'); show('login'); }
    }
  };
  ws.onclose = () => {
    if (!el.scLogin.hidden) return;
    toast('연결이 끊겼어요. 다시 접속하는 중…');
    setTimeout(tryResume, 1200);
  };
}
const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function tryResume() {
  const saved = sessionStorage.getItem('hg');
  if (!saved) return;
  const { code, token } = JSON.parse(saved);
  connect(() => send({ t: 'resume', code, token }));
}

/* ───────────── 상태 렌더 ───────────── */
function onState(s) {
  const prev = S;
  S = s;
  clockOffset = s.now - Date.now();
  el.roomCode.textContent = s.code;
  el.barCode.textContent = s.code;

  if (s.phase === 'lobby') { renderLobby(); show('lobby'); el.overlay.hidden = true; }
  else { renderGame(); show('game'); }

  if (s.phase === 'over') showResult();
  else el.overlay.hidden = true;
}

const myP = () => S && S.players.find(p => p.id === me);
const isHost = () => S && S.hostId === me;

/* ── 대기실 ── */
function renderLobby() {
  el.lobbyPlayers.innerHTML = S.players.map(p => `
    <div class="lp">
      <span class="av">${p.bot ? '🤖' : '🧑'}</span>
      <span class="nm">${esc(p.name)}</span>
      ${p.id === S.hostId ? '<span class="tagx">방장</span>' : ''}
      ${p.id === me ? '<span class="tagx">나</span>' : ''}
      ${p.bot ? '<span class="tagx">봇</span>' : ''}
      <span class="sp"></span>
      ${isHost() && p.id !== me ? `<button class="x" data-kick="${p.id}" data-bot="${p.bot ? 1 : 0}">✕</button>` : ''}
    </div>`).join('');

  el.hostBox.hidden = !isHost();
  el.optDiff.value = S.cfg.botDiff;
  el.optLimit.value = String(S.cfg.turnLimit);
  el.btnStart.disabled = S.players.length < 2;
  el.lobbyHint.textContent = isHost()
    ? (S.players.length < 2 ? '봇을 추가하거나 친구가 들어오면 시작할 수 있어요.' : '준비되면 시작하세요.')
    : '방장이 시작하기를 기다리는 중…';
}

el.lobbyPlayers.addEventListener('click', e => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const id = +b.dataset.kick;
  send(b.dataset.bot === '1' ? { t: 'removeBot', id } : { t: 'kick', id });
});

/* ── 카드 ── */
function pipsHTML(card) {
  return (PIPS[card.n] || []).map(([x, y, r]) =>
    `<span class="pip" style="left:${x}%;top:${y}%;transform:rotate(${r}deg)">${F[card.f].emoji}</span>`
  ).join('');
}
function cardFace(card) {
  return `<div class="top card">${pipsHTML(card)}</div>`;
}
/** 장수에 비례해 더미 두께를 만든다 — 한 장 낼 때마다 실제로 얇아진다 */
function layers(n) {
  if (n <= 0) return '';
  const L = Math.min(10, n);              // 그려줄 층 수
  const t = Math.min(24, n * 0.42);       // 전체 두께(px)
  let out = '';
  for (let i = L; i >= 1; i--) {
    const d = t * (i / L);
    out += `<i class="lay" style="transform:translate(${(d * .55).toFixed(2)}px,${d.toFixed(2)}px)"></i>`;
  }
  return out;
}
function stackHTML(kind, n, inner) {
  return `<div class="stack ${kind}" data-n="${n}">${layers(n)}${inner}</div>`;
}

/* ── 게임 ──
   나를 아래쪽에 두고 시계 방향으로 자리를 잡는다.
   손패 뭉치는 자기 쪽 바깥, 펼친 카드는 가운데 종 주변. */
/* 배치 모드 — C: 종을 둘러싼 원형 / D: 가로 두 줄(크게보기) */
let layoutMode = localStorage.getItem('hgLayout') === 'D' ? 'D' : 'C';
const DECK_SCALE = 0.55;               // 손패 뭉치는 펼친 카드보다 작게
const MAX_CH = 190;

/** 실제 크기를 재서 카드가 최대한 커지도록 반경과 카드 높이를 잡는다 */
function layoutBoard() {
  if (!el.slots.children.length) return;
  const bellHalf = (el.bell.offsetHeight || 40) / 2;
  const H = el.board.clientHeight, W = el.board.clientWidth;
  const G = 8, PAD = 16;               // PAD = 더미 두께가 아래로 삐져나오는 몫
  const n = S.players.length;
  let ch;

  if (layoutMode === 'D') {
    const byHeight = (H - bellHalf * 2 - G * 3 - PAD) / (1 + DECK_SCALE);
    const byWidth  = 1.4 * (W - 20 - 14 * (n - 1)) / n;
    ch = Math.min(MAX_CH, byHeight, byWidth);
  } else {
    ch = (H / 2 - bellHalf - G * 2 - PAD) / (1 + DECK_SCALE);
    const py = bellHalf + G + ch / 2;
    const ry = py + ch / 2 + G + (ch * DECK_SCALE + PAD) / 2;
    el.board.style.setProperty('--py', py + 'px');
    el.board.style.setProperty('--ry', ry + 'px');
  }

  ch = Math.max(52, Math.min(MAX_CH, ch));
  el.board.style.setProperty('--ch', ch + 'px');
  el.board.style.setProperty('--cw', (ch / 1.4) + 'px');
  el.board.style.setProperty('--deckScale', DECK_SCALE);
}
window.addEventListener('resize', () => { if (S && S.phase !== 'lobby') layoutBoard(); });

function seatAngles(n, myIdx) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (i - myIdx + n) % n;
    const a = (90 + k * 360 / n) * Math.PI / 180;
    out[i] = { c: +Math.cos(a).toFixed(4), s: +Math.sin(a).toFixed(4) };
  }
  return out;
}

function renderGame() {
  const n = S.players.length;
  const myIdx = Math.max(0, S.players.findIndex(p => p.id === me));
  const big = layoutMode === 'D';
  el.board.classList.toggle('rows', big);

  const state = p => {
    const fl = flashInfo && flashInfo.id === p.id && Date.now() < flashUntil ? flashInfo : null;
    return {
      fl,
      cls: [
        p.id === me ? 'mine' : '', S.turn === p.id ? 'turn' : '', p.out ? 'out' : '',
        (!p.connected && !p.bot) ? 'dc' : '', fl ? fl.kind : ''
      ].filter(Boolean).join(' '),
      canFlip: p.id === me && S.turn === me && !S.resolving && !S.frozen && S.phase === 'playing',
    };
  };

  const deckHTML = (p, style) => {
    const { fl, cls, canFlip } = state(p);
    return `
      <div class="slot deck-slot ${cls}${canFlip ? ' canflip' : ''}" data-id="${p.id}" data-role="deck" style="${style}">
        <div class="stacks">${stackHTML('deck', p.hand, p.hand > 0
          ? '<div class="top back"></div>'
          : '<div class="top card empty">빈 덱</div>')}</div>
        <div class="tagline">
          <div class="who"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.bot ? '🤖' : ''}${!p.connected && !p.bot ? '📴' : ''}${S.turn === p.id && S.phase === 'playing' ? '<span class="turnbadge">차례</span>' : ''}</div>
          <div class="counts">
            <span><b>${p.hand}</b>장</span>
            <span class="h">종 ${p.hits}</span><span class="m">오답 ${p.misses}</span>
            ${p.out ? '<span class="badge">탈락</span>' : ''}
          </div>
        </div>
        ${fl ? `<span class="delta ${fl.kind}">${fl.delta}</span>` : ''}
      </div>`;
  };

  const pileHTML = (p, style) => `
      <div class="slot pile-slot ${state(p).cls}" data-id="${p.id}" data-role="pile" style="${style}">
        <div class="stacks">${stackHTML('pile', p.pile, p.top ? cardFace(p.top) : '')}</div>
      </div>`;

  if (big) {
    // 펼친 카드가 한 줄, 각자의 손패는 자기 카드 바로 아래에 열로 묶인다
    const order = [...S.players.slice(myIdx), ...S.players.slice(0, myIdx)];
    el.slots.innerHTML =
      `<div class="rowline">${order.map(p =>
        `<div class="col">${pileHTML(p, '')}${deckHTML(p, '')}</div>`).join('')}</div>`;
  } else {
    const ang = seatAngles(n, myIdx);
    el.slots.innerHTML = S.players.map((p, i) => {
      const style = `--c:${ang[i].c};--s:${ang[i].s}`;
      return deckHTML(p, style) + pileHTML(p, style);
    }).join('');
  }

  layoutBoard();

  // 클릭으로는 종을 칠 수 없다 — 오직 타자로만. 아래는 '이렇게 치면 된다'는 안내.
  el.tally.innerHTML = FRUITS.map(f => `
    <div class="chip">
      <span class="em">${f.emoji}</span><span>${f.ko}</span>
    </div>`).join('');

  const mine = myP();
  const myTurn = S.turn === me && !S.resolving && S.phase === 'playing';
  el.btnFlip.classList.toggle('on', myTurn && !S.frozen);
  el.btnFlip.disabled = S.turn !== me || S.phase !== 'playing';

  const ready = S.phase === 'ready';
  el.startGate.hidden = !ready;
  el.btnGo.hidden = !isHost();
  el.waitMsg.textContent = isHost()
    ? '모두 준비됐으면 시작하세요'
    : '방장이 시작하기를 기다리는 중…';
  el.waitMsg.hidden = isHost();

  const turnP = S.players.find(p => p.id === S.turn);
  const myTurnNow = S.turn === me && S.phase === 'playing';
  el.turnNow.className = 'turnnow' + (S.phase !== 'playing' ? '' : myTurnNow ? ' me' : ' active');
  el.turnNow.querySelector('.ttext').innerHTML =
    S.phase === 'ready' ? '시작 대기 중'
    : S.phase !== 'playing' ? '—'
    : myTurnNow ? '내 차례 — 카드를 뒤집으세요'
    : `<b>${turnP ? esc(turnP.name) : '?'}</b> 차례`;
  document.querySelector('.table').classList.toggle('myturn', myTurnNow);

  if (mine && mine.out) el.entry.placeholder = '탈락했습니다 — 관전 중';
  else el.entry.placeholder = '같은 과일 5개를 찾으면 이름을 치세요';
}

function esc(t) {
  return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ── 자동 넘김 타이머 바 ── */
function tickTimer() {
  if (!S || S.phase !== 'playing' || !S.turnEndsAt || S.turn !== me) {
    el.flipTimer.style.width = '0%'; return;
  }
  const left = S.turnEndsAt - (Date.now() + clockOffset);
  const total = S.cfg.turnLimit || 1;
  el.flipTimer.style.width = Math.max(0, Math.min(100, (1 - left / total) * 100)) + '%';
}
setInterval(tickTimer, 60);

/* ───────────── 애니메이션 ───────────── */
function slotEl(id, role) {
  return el.slots.querySelector(`.slot[data-id="${id}"][data-role="${role}"]`);
}
function ringBell() {
  el.bell.classList.remove('ring'); void el.bell.offsetWidth;
  el.bell.classList.add('ring');
  setTimeout(() => el.bell.classList.remove('ring'), 700);
}

function flyer(fromEl, toEl, innerFront, spin, ms) {
  if (!fromEl || !toEl) return;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'flyer' + (spin ? '' : ' sweep');
  f.innerHTML = `<div class="face back"></div><div class="face front">${innerFront || ''}</div>`;
  f.style.cssText +=
    `--x0:${a.left}px;--y0:${a.top}px;--w0:${a.width}px;--h0:${a.height}px;` +
    `--x1:${b.left}px;--y1:${b.top}px;--w1:${b.width}px;--h1:${b.height}px;--ms:${ms}ms;`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), ms + 90);
}

/** 손패에서 한 장을 뽑아 → 공중에서 뒤집으며 → 종 옆에 내려놓는다 */
function animFlip(playerId, card) {
  const deck = slotEl(playerId, 'deck'), pile = slotEl(playerId, 'pile');
  if (!deck || !pile) return;
  const from = deck.querySelector('.stack'), to = pile.querySelector('.stack');
  const top = to && to.querySelector('.top');
  if (top) { top.style.visibility = 'hidden'; setTimeout(() => { top.style.visibility = ''; }, 430); }
  flyer(from, to, cardFace(card), true, 460);
}

/** 성공한 사람이 판에 깔린 카드를 전부 쓸어 담는 연출 */
function animCollect(winnerId) {
  const win = slotEl(winnerId, 'deck');
  if (!win) return;
  ringBell();
  const target = win.querySelector('.stack');
  for (const p of S.players) {
    const pile = slotEl(p.id, 'pile');
    if (!pile) continue;
    const st = pile.querySelector('.stack');
    if (!st || !st.querySelector('.card:not(.empty)')) continue;
    flyer(st, target, '', false, 520);
  }
  win.classList.add('win');
  setTimeout(() => win.classList.remove('win'), 700);
}

/* ───────────── 이벤트 ───────────── */
function onEvent(m) {
  const who = id => {
    const p = S && S.players.find(x => x.id === id);
    return p ? esc(p.name) : '?';
  };

  if (m.kind === 'dealt') {
    el.log.innerHTML = ''; el.status.innerHTML = '';
    log('카드를 나눴습니다. 방장이 시작을 누르면 첫 차례가 열립니다.');
  }

  if (m.kind === 'start') {
    el.status.innerHTML = '';
    log('게임 시작! 같은 과일이 <b>정확히 5개</b>가 되는 순간을 노리세요.');
  }

  if (m.kind === 'joined') log(`<b>${who(m.by)}</b> 님이 들어왔습니다`);

  if (m.kind === 'flip') {
    sfxFlip();
    // state 메시지가 뒤따라오므로 렌더가 끝난 뒤에 연출을 얹는다
    setTimeout(() => animFlip(m.by, m.card), 0);
  }

  if (m.kind === 'call') {
    const f = F[m.fruit];
    const name = who(m.by);
    const mine = m.by === me;

    if (m.ok) {
      setTimeout(() => animCollect(m.by), 0);
      markSeat(m.by, 'hit', `+${m.gained}`, 1900);
      showVerdict(
        `<div class="vw">${f.emoji} ${mine ? '내가' : name} 종을 쳤다!</div>
         <div class="vs">${f.ko} 5개 · <b>+${m.gained}장</b>${m.rt != null ? ` · ${m.rt}ms` : ''}</div>`,
        'ok', 1900);
      if (mine) { sfxRight(); flash('good'); } else sfxWrong();
      el.status.innerHTML = mine
        ? `<span class="ok">성공!</span> ${f.emoji} ${f.ko} 5개 — <b>${m.gained}장</b> 획득${m.rt != null ? ` · ${m.rt}ms` : ''}`
        : `<b>${name}</b>${hasBatchim(name) ? '이' : '가'} 먼저 <b>${f.ko}</b>${hasBatchim(f.ko) ? '을' : '를'} 외쳤습니다 — ${m.gained}장`;
      log(`${f.emoji} <b>${name}</b> 성공 → +${m.gained}장${m.rt != null ? ` <span style="opacity:.6">(${m.rt}ms)</span>` : ''}`, 'win');
    } else {
      markSeat(m.by, 'miss', `−${m.given}`, 1700);
      showVerdict(
        `<div class="vw">✕ ${mine ? '내' : name} 오답</div>
         <div class="vs">${f.emoji} ${josa(f.ko, '은', '는')} <b>${m.count}개</b>였습니다 · <b>−${m.given}장</b></div>`,
        'no', 1700);
      if (mine) { sfxWrong(); flash('bad'); }
      el.status.innerHTML = mine
        ? `<span class="no">틀렸어요!</span> ${josa(f.ko, '은', '는')} ${m.count}개 — 카드 ${m.given}장 지급`
        : `<b>${name}</b> 오답 (${f.ko} ${m.count}개) — 카드를 받았습니다`;
      log(`✕ <b>${name}</b> 오답 · ${f.ko} ${m.count}개 → −${m.given}장`, 'lose');
    }
    el.entry.value = '';
  }

  if (m.kind === 'nudge') {
    el.status.innerHTML = '<b>…모두가 뭔가를 놓치고 있습니다.</b> 판을 다시 보세요';
  }

  if (m.kind === 'out') log(`<b>${who(m.by)}</b> 카드 소진 — 탈락`);
  if (m.kind === 'end') { el.verdict.hidden = true; clearTimeout(verdictTimer); }
  if (m.kind === 'end') log(m.by === me ? '🏆 승리!' : `게임 종료 — <b>${who(m.by)}</b> 승리`);
}

/** 누가 맞혔고 누가 잘못 쳤는지 화면 한가운데에 크게 알린다 */
function showVerdict(html, kind, ms) {
  el.verdict.className = 'verdict ' + kind;
  el.verdict.innerHTML = html;
  el.verdict.hidden = false;
  clearTimeout(verdictTimer);
  verdictTimer = setTimeout(() => { el.verdict.hidden = true; }, ms);
}

function markSeat(id, kind, delta, ms) {
  flashInfo = { id, kind, delta };
  flashUntil = Date.now() + ms;
  if (S) renderGame();
  setTimeout(() => { if (S && Date.now() >= flashUntil) renderGame(); }, ms + 40);
}

function flash(kind) {
  el.entry.classList.remove('good', 'bad');
  void el.entry.offsetWidth;
  el.entry.classList.add(kind);
  setTimeout(() => el.entry.classList.remove(kind), 520);
}

function showResult() {
  const w = S.players.find(p => p.id === S.winner);
  const mine = myP();
  const won = S.winner === me;
  el.ovTitle.textContent = won ? '🏆 내가 이겼다!' : (w ? `🏆 ${w.name} 승리` : '게임 종료');
  el.ovSub.innerHTML = mine
    ? `내 기록 — 종 <b>${mine.hits}</b> · 오답 <b>${mine.misses}</b>` +
      (mine.best != null ? ` · 최고 반응 <b>${mine.best}ms</b>` : '')
    : '관전 종료';

  const ranked = [...S.players].sort((a, b) => (b.hand + b.pile) - (a.hand + a.pile) || b.hits - a.hits);
  el.ovRank.innerHTML = ranked.map((p, i) => `
    <div class="rk${p.id === S.winner ? ' first' : ''}${p.id === me ? ' mine' : ''}">
      <span class="pos">${p.id === S.winner ? '🏆' : i + 1}</span>
      <span class="nm">${esc(p.name)}${p.bot ? ' 🤖' : ''}${p.id === me ? ' <small>(나)</small>' : ''}</span>
      <span class="hm"><span class="h">종 ${p.hits}</span> · <span class="m">오답 ${p.misses}</span></span>
      <span class="cards">${p.hand + p.pile}장</span>
    </div>`).join('');

  el.btnAgain.hidden = !isHost();
  el.overlay.hidden = false;
}

/* ───────────── 입력 ───────────── */
/* 입력값의 '끝'이 과일 이름과 맞으면 호출 — 카드가 계속 뒤집혀도 타자가 끊기지 않게 */
function matchFruit(v) {
  let best = null, len = 0;
  for (const name in NAME2ID) {
    if (name.length > len && v.endsWith(name)) { best = NAME2ID[name]; len = name.length; }
  }
  return best;
}
function tryCall(raw) {
  let v = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return;
  if (v.length > 24) { v = v.slice(-24); el.entry.value = v; }
  const id = matchFruit(v);
  if (!id) return;
  if (!S || S.phase !== 'playing') { el.entry.value = ''; return; }
  send({ t: 'call', fruit: id });
}

el.entry.addEventListener('input', e => tryCall(e.target.value));
el.entry.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); tryCall(el.entry.value); el.entry.value = ''; }
  if (e.key === 'Escape') el.entry.value = '';
});

function doFlip() {
  if (!S || S.phase !== 'playing' || S.turn !== me || S.resolving) return;
  if (S.frozen) {                       // 5개가 떠 있는 동안엔 카드를 깔 수 없다
    el.btnFlip.classList.remove('nope'); void el.btnFlip.offsetWidth;
    el.btnFlip.classList.add('nope');
    return;
  }
  send({ t: 'flip' });
}
el.btnFlip.addEventListener('click', doFlip);
el.slots.addEventListener('click', e => {
  const slot = e.target.closest('.slot');
  if (slot && +slot.dataset.id === me) doFlip();
});
document.addEventListener('click', e => {
  if (!el.scGame.hidden && !e.target.closest('button,select,input')) el.entry.focus();
});

/* ───────────── 접속/대기실 조작 ───────────── */
const nameOf = () => el.inName.value.trim() || '플레이어';

el.btnCreate.addEventListener('click', () => {
  localStorage.setItem('hgName', nameOf());
  connect(() => send({ t: 'create', name: nameOf() }));
});
el.btnJoin.addEventListener('click', () => {
  const code = el.inCode.value.trim().toUpperCase();
  if (code.length !== 4) return toast('4자리 방 코드를 입력하세요.');
  localStorage.setItem('hgName', nameOf());
  connect(() => send({ t: 'join', code, name: nameOf() }));
});
el.inCode.addEventListener('keydown', e => { if (e.key === 'Enter') el.btnJoin.click(); });
el.inName.addEventListener('keydown', e => { if (e.key === 'Enter') el.btnCreate.click(); });

el.btnCopy.addEventListener('click', async () => {
  const url = `${location.origin}/#${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요'); }
  catch (_) { toast(url); }
});
el.btnAddBot.addEventListener('click', () => send({ t: 'addBot' }));
el.btnStart.addEventListener('click', () => send({ t: 'start' }));
el.optDiff.addEventListener('change', () => send({ t: 'cfg', botDiff: el.optDiff.value }));
el.optLimit.addEventListener('change', () => send({ t: 'cfg', turnLimit: +el.optLimit.value }));
el.btnAgain.addEventListener('click', () => send({ t: 'again' }));
el.btnToLobby.addEventListener('click', () => { el.overlay.hidden = true; });
el.btnLeave.addEventListener('click', () => {
  send({ t: 'leave' });
  sessionStorage.removeItem('hg');
  location.hash = '';
  location.reload();
});

/* ───────────── 테마 ───────────── */
function applyTheme(v) {
  document.documentElement.dataset.theme = v;
  localStorage.setItem('hgTheme', v);
  el.theme.value = v; el.themeGame.value = v;
}
el.theme.addEventListener('change', () => applyTheme(el.theme.value));
el.themeGame.addEventListener('change', () => applyTheme(el.themeGame.value));

/* ───────────── 시작 ───────────── */
applyTheme(localStorage.getItem('hgTheme') || 'paper');

function setLayout(mode) {
  layoutMode = mode;
  localStorage.setItem('hgLayout', mode);
  el.bigToggle.checked = mode === 'D';
  if (S && S.phase !== 'lobby') renderGame();
}
el.bigToggle.addEventListener('change', () => setLayout(el.bigToggle.checked ? 'D' : 'C'));
setLayout(layoutMode);
el.btnGo.addEventListener('click', () => send({ t: 'go' }));
el.btnSound.addEventListener('click', () => setMuted(!muted));
setMuted(muted);
el.inName.value = localStorage.getItem('hgName') || '';
const hash = location.hash.replace('#', '').toUpperCase();
if (/^[A-Z0-9]{4}$/.test(hash)) {
  el.inCode.value = hash;
  el.loginHint.innerHTML = `방 <b>${hash}</b> 에 참가합니다 — 닉네임을 정하고 <b>참가</b>를 누르세요.`;
}
if (sessionStorage.getItem('hg')) tryResume();
show('login');
