'use strict';
/**
 * 떠 있는 서버에 붙어서 한 판의 뼈대를 확인한다 — 어느 서버든 주소만 주면 된다.
 *   node test/smoke.js http://127.0.0.1:8793          (wrangler dev)
 *   node test/smoke.js https://halligalli.xxx.workers.dev (배포본)
 * 두 사람이 방을 만들고 · 들어가고 · 채팅하고 · 시작해서 카드를 뒤집고 · 새로고침(resume)까지.
 * IDLE=1 을 주면 조작 없는 소켓이 4000 으로 닫히는지도 본다(서버를 IDLE_MS 를 줄여 띄웠을 때만).
 */
const assert = require('assert');
const WebSocket = require('ws');

const BASE = (process.argv[2] || 'http://127.0.0.1:8793').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.closed = null;
    ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
    ws.on('close', code => { ws.closed = code; });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
const tx = (ws, obj) => ws.send(JSON.stringify(obj));
async function waitFor(ws, pred, ms = 6000, what = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = ws.inbox.length - 1; i >= 0; i--) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(25);
  }
  throw new Error('기다리던 메시지가 오지 않음 ' + what + ': ' + JSON.stringify(ws.inbox.slice(-2)).slice(0, 300));
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

(async () => {
  console.log('할리갈리 연결 확인 → ' + BASE);
  let a, b, code, tokenB, idB;

  await check('화면 파일이 나온다', async () => {
    const html = await fetch(BASE + '/').then(r => r.text());
    assert.ok(html.includes('할리갈리'), 'index.html 이 아님');
    const css = await fetch(BASE + '/style.css');
    assert.strictEqual(css.status, 200);
  });

  await check('상태 확인', async () => {
    const h = await fetch(BASE + '/healthz').then(r => r.json());
    assert.strictEqual(h.ok, true);
  });

  await check('방 만들기 · 들어가기', async () => {
    a = await open();
    tx(a, { t: 'create', name: '방장' });
    const w = await waitFor(a, m => m.t === 'welcome');
    code = w.code;
    b = await open();
    tx(b, { t: 'join', code, name: '민수' });
    const wb = await waitFor(b, m => m.t === 'welcome');
    tokenB = wb.token; idB = wb.you;
    const s = await waitFor(a, m => m.t === 'state' && m.players.length === 2);
    assert.strictEqual(s.phase, 'lobby');
  });

  await check('ping 은 아무 일도 일으키지 않는다', async () => {
    const n = a.inbox.length;
    tx(a, { t: 'ping' });
    await sleep(300);
    assert.strictEqual(a.inbox.length, n);
  });

  await check('채팅이 같은 방에 간다', async () => {
    tx(b, { t: 'chat', text: '안녕하세요' });
    const c = await waitFor(a, m => m.t === 'chat');
    assert.strictEqual(c.text, '안녕하세요');
    assert.strictEqual(c.name, '민수');
  });

  await check('시작해서 카드를 뒤집는다', async () => {
    tx(a, { t: 'start' });
    await waitFor(a, m => m.t === 'state' && m.phase === 'ready');
    tx(a, { t: 'go' });
    const s = await waitFor(a, m => m.t === 'state' && m.phase === 'playing' && m.turn != null);
    const who = s.turn === idB ? b : a;
    tx(who, { t: 'flip' });
    await waitFor(a, m => m.t === 'state' && m.players.some(p => p.pile > 0), 6000, '(뒤집음)');
  });

  await check('새로고침해도 자리를 지키고, 옛 소켓이 닫혀도 끊긴 걸로 치지 않는다', async () => {
    const b2 = await open();
    tx(b2, { t: 'resume', code, token: tokenB });
    await waitFor(b2, m => m.t === 'welcome');
    b.close();
    await sleep(800);
    const s = a.inbox.filter(m => m.t === 'state').pop();
    const me = s.players.find(p => p.id === idB);
    assert.strictEqual(me.connected, true, '새 소켓이 붙어 있는데 끊긴 걸로 표시됨');
    b = b2;
  });

  await check('같은 자리로 다른 탭이 들어오면 먼저 탭은 4001 로 닫힌다', async () => {
    const b2 = await open();
    tx(b2, { t: 'resume', code, token: tokenB });
    await waitFor(b2, m => m.t === 'welcome');
    const end = Date.now() + 3000;
    while (b.closed == null && Date.now() < end) await sleep(25);
    assert.strictEqual(b.closed, 4001);
    b = b2;
  });

  if (process.env.IDLE) {
    await check('조작이 없으면 4000 으로 닫힌다 (ping 만 보내도)', async () => {
      const c = await open();
      tx(c, { t: 'create', name: '가만히' });
      await waitFor(c, m => m.t === 'welcome');
      const end = Date.now() + 15000;
      while (c.closed == null && Date.now() < end) { tx(c, { t: 'ping' }); await sleep(400); }
      assert.strictEqual(c.closed, 4000);
      assert.ok(c.inbox.some(m => m.t === 'idle'), 'idle 알림이 먼저 와야 함');
      // 서버가 스스로 끊은 것이라 대기실 자리는 남아 있어야 한다 — 다시 누르면 이어 붙는다
      const w = c.inbox.find(m => m.t === 'welcome');
      const c2 = await open();
      tx(c2, { t: 'resume', code: w.code, token: w.token });
      const back = await waitFor(c2, m => m.t === 'welcome' || m.t === 'err');
      assert.strictEqual(back.t, 'welcome', '자리가 지워짐: ' + JSON.stringify(back));
      c2.close();
    });
  }

  a.close(); b.close();
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
