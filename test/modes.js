/**
 * 기본 / 익스트림이 서로 꼬이지 않는지 확인한다.
 *   node test/modes.js            (서버가 8788 에 떠 있어야 한다)
 *   PORT=8790 node test/modes.js  (다른 포트로)
 */
const WebSocket = require('../node_modules/ws');
const PORT = process.env.PORT || 8788;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FRUITS = ['banana', 'lime', 'strawberry', 'grape'];
const KO = { banana:'바나나', lime:'라임', strawberry:'딸기', grape:'포도' };
const EX_WORDS = ['짝', '코끼리', '원숭이', '돼지'];

let pass = 0, fail = 0;
const ok  = (t, m='') => { pass++; console.log('  ✅', t, m); };
const bad = (t, m='') => { fail++; console.log('  ❌', t, m); };
const check = (cond, t, m='') => cond ? ok(t, m) : bad(t, m);

function client(name, mode) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, me:null, st:null, evs:[], drops:[] };
  ws.on('message', d => { const m = JSON.parse(d);
    if (m.t === 'welcome') c.me = m.you;
    else if (m.t === 'state') c.st = m;
    else if (m.t === 'ev') c.evs.push(m);
    else if (m.t === 'drop') c.drops.push(m.why); });
  c.send = o => ws.send(JSON.stringify(o));
  c.ready = new Promise(r => ws.on('open', r));
  c.mode = mode;
  return c;
}

const tops = s => s.players.filter(p => !p.out && p.top).map(p => p.top);
const fsum = s => { const o = {}; FRUITS.forEach(f => o[f] = 0);
  for (const c of tops(s)) if (!c.sp) for (const f of c.f) o[f]++; return o; };
const hasPair = s => { const seen = new Set();
  for (const c of tops(s)) { if (c.sp) continue; if (seen.has(c.d)) return true; seen.add(c.d); } return false; };

async function run(mode) {
  console.log(`\n[${mode}]`);
  const c = client('검사', mode);
  await c.ready;
  c.send({ t:'create', name:'검사', mode });
  await sleep(300);
  c.send({ t:'addBot' }); await sleep(200);
  c.send({ t:'cfg', turnLimit:0, botDiff:'easy' }); await sleep(200);
  c.send({ t:'start' }); await sleep(300);

  const total = c.st.players.reduce((a, p) => a + p.hand, 0);
  check(c.st.cfg.mode === mode, '방 모드', `= ${c.st.cfg.mode}`);
  check(total === (mode === 'extreme' ? 72 : 56), '덱 장수', `= ${total}장`);

  c.send({ t:'go' }); await sleep(300);

  // 판을 굴리면서 카드 구성과 종 조건이 모드에 맞는지 본다
  let sawAnimal = false, sawMulti = false, sawFiveNotFrozen = false, sawPairNotFrozen = false;
  const call = async w => { const b = c.evs.length; c.send({ t:'call', word:w });
    await sleep(320); return c.evs.slice(b).find(e => e.kind === 'call'); };

  const t0 = Date.now();
  let wordTested = false, otherWordTested = false;
  while (Date.now() - t0 < 30000) {
    if (!c.st || c.st.phase !== 'playing') break;
    for (const card of tops(c.st)) {
      if (card.sp) sawAnimal = true;
      else if (new Set(card.f).size > 1) sawMulti = true;
    }
    const s = fsum(c.st), five = FRUITS.find(f => s[f] === 5), pair = hasPair(c.st);

    if (mode === 'basic' && pair && !five && c.st.frozen) sawPairNotFrozen = true;   // 기본은 짝으로 안 멈춰야
    if (mode === 'extreme' && five && !pair && !(c.st.animals||[]).length && c.st.frozen) sawFiveNotFrozen = true;

    // 다른 모드 말을 직접 쏴 본다 → 서버가 '모르는 말' 로 돌려줘야 한다
    if (!otherWordTested) {
      const w = mode === 'extreme' ? KO.banana : '돼지';
      const before = c.drops.length;
      c.send({ t:'call', word:w }); await sleep(300);
      check(c.drops.slice(before).includes('noword'),
            '다른 모드 말은 거부', `"${w}" → ${c.drops.slice(before)[0] || '반응 없음'}`);
      otherWordTested = true;
      continue;
    }

    // 이 모드 말은 반드시 판정된다
    if (!wordTested) {
      const w = mode === 'extreme' ? '짝' : KO[FRUITS.find(f => s[f] > 0) || 'banana'];
      const e = await call(w);
      check(!!e, '이 모드 말은 판정됨', `"${w}" → ${e ? (e.ok ? '성공' : '오답') : '반응 없음'}`);
      wordTested = true;
      await sleep(1500);
      continue;
    }

    if (c.st.turn === c.me && !c.st.frozen) c.send({ t:'flip' });
    await sleep(90);
    if (wordTested && otherWordTested && (mode === 'basic' ? true : sawAnimal)) break;
  }

  if (mode === 'extreme') {
    check(sawAnimal, '익스트림에 동물 카드가 나온다');
    check(sawMulti, '익스트림 카드에 과일이 여러 종류');
    check(!sawFiveNotFrozen, '익스트림은 "5개"로 멈추지 않는다');
  } else {
    check(!sawAnimal, '기본에 동물 카드가 없다');
    check(!sawMulti, '기본 카드는 한 종류 과일만');
    check(!sawPairNotFrozen, '기본은 "짝"으로 멈추지 않는다');
  }
  c.ws.close();
}

(async () => {
  await run('basic');
  await run('extreme');
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
