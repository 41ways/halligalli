/* 화면 갈무리용 — ?qa=shot 으로 들어오면 방을 만들고 봇을 채워 판을 벌인 뒤,
   사람처럼 카드를 뒤집는다. 화면이 실제로 도는 모습을 찍기 위한 것이다.
   평소에는 index.html 의 한 줄이 이 파일을 아예 부르지 않는다. */
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('qa') !== 'shot') return;

  var bots = Math.max(1, (parseInt(q.get('n'), 10) || 3) - 1);
  function el(id) { return document.getElementById(id); }
  function ready(fn) { el('btnEnter') ? fn() : setTimeout(function () { ready(fn); }, 40); }

  ready(function () {
    el('btnEnter').click();
    el('inName').value = '민수';
    el('btnCreate').click();

    setTimeout(function () {
      for (var i = 0; i < bots; i++) el('btnAddBot').click();
      setTimeout(function () {
        el('btnStart').click();
        setTimeout(function () {
          var go = el('btnGo');
          if (go && go.offsetParent) go.click();
          // 사람처럼 카드를 뒤집는다 (판이 계속 돌아가야 화면이 비지 않는다)
          setInterval(function () {
            var f = el('btnFlip');
            if (f && !f.disabled) f.click();
          }, 1400);
        }, 1500);
      }, 800);
    }, 1200);
  });
})();
