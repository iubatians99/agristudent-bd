// ============================================
// AGRI CORE — cgpa-planner.js
// Lock past SGPA → pick a target CGPA → see the SGPA needed
// in every remaining semester (12 semesters in total, equal weight).
// Data stays in this browser only (localStorage), nothing is sent anywhere.
// ============================================
(function () {
  var TOTAL = 12, NS = 'http://www.w3.org/2000/svg', KEY = 'cgpa-v2';
  var ORD = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','11th','12th'];
  var $ = function (i) { return document.getElementById(i); };
  var S = { N: 6, known: [], plan: [], target: 3.8, locked: false };
  try {
    var sv = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (sv && sv.N >= 1 && sv.N < TOTAL) {
      S = sv;
      // Safety: saved data must match the chosen semester count
      if (S.locked && (!Array.isArray(S.known) || S.known.length !== S.N ||
          S.known.some(function (x) { return typeof x !== 'number' || isNaN(x); }))) S.locked = false;
    }
  } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function num(v) { if (v === '' || v == null) return null; var n = parseFloat(v); return isNaN(n) ? null : Math.max(0, Math.min(4, n)); }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
  var kin = [], pin = [];

  var cur = $('cur');
  for (var i = 1; i < TOTAL; i++) {
    var o = document.createElement('option');
    o.value = i; o.textContent = ORD[i - 1] + ' semester'; cur.appendChild(o);
  }
  cur.value = S.N;
  cur.onchange = function () { S.known = kin.map(function (x) { return x.value; }); S.N = +cur.value; buildKnown(); };

  function cells(box, list, from, to, vals, cb) {
    box.innerHTML = ''; list.length = 0;
    for (var i = from; i < to; i++) {
      var d = document.createElement('div'), l = document.createElement('label'), n = document.createElement('input');
      l.textContent = ORD[i]; n.type = 'number'; n.step = '0.01'; n.min = '0'; n.max = '4'; n.inputMode = 'decimal'; n.placeholder = '–';
      n.setAttribute('aria-label', ORD[i] + ' semester SGPA');
      var v = vals[i - from]; n.value = (v == null ? '' : v);
      if (cb) n.oninput = cb;
      d.appendChild(l); d.appendChild(n); box.appendChild(d); list.push(n);
    }
  }
  function buildKnown() {
    $('sgl').textContent = 'Enter SGPA for 1st – ' + ORD[S.N - 1] + ' semester';
    cells($('known'), kin, 0, S.N, S.known);
  }
  function buildPlan() {
    cells($('plan'), pin, S.N, TOTAL, S.plan || [], function () { S.plan = pin.map(function (x) { return x.value; }); save(); render(); });
  }
  $('lock').onclick = function () {
    var v = kin.map(function (x) { return num(x.value); });
    if (v.some(function (x) { return x === null; })) { $('err').textContent = 'Please enter SGPA for every semester (0 – 4).'; return; }
    S.known = v; S.plan = []; S.locked = true; save(); show();
  };
  $('edit').onclick = function () { S.locked = false; save(); show(); };
  $('tg').oninput = function () { S.target = +this.value; save(); render(); };
  [3.5, 3.7, 3.8, 3.9, 4].forEach(function (v) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = v.toFixed(2); b.dataset.v = v;
    b.onclick = function () { S.target = v; $('tg').value = v; save(); render(); };
    $('chips').appendChild(b);
  });

  function show() {
    $('setup').hidden = S.locked; $('dash').hidden = !S.locked;
    if (S.locked) { $('lk').textContent = '1st – ' + ORD[S.N - 1] + ' semester'; buildPlan(); $('tg').value = S.target; render(); }
    else { $('err').textContent = ''; cur.value = S.N; buildKnown(); }
  }

  function el(n, a, t) { var e = document.createElementNS(NS, n); for (var k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; return e; }
  function rb(x, y, w, h, r) { r = Math.min(r, h, w / 2); return 'M' + x + ' ' + (y + h) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + (y + h) + 'Z'; }
  // Text with a soft white outline so labels stay readable over lines/bars
  var HALO = 'paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round;';

  function chart(items, T, cum) {
    var svg = $('chart'); svg.innerHTML = '';
    var W = 720, H = 380, L = 44, R = 62, T0 = 30, B = 38;
    var vs = [T]; items.forEach(function (it) { if (it.t !== 'g') vs.push(it.v); });
    var lo = Math.min(3, Math.floor(Math.min.apply(null, vs) * 2) / 2), hi = 4.2;
    var step = (4 - lo) > 1.01 ? 0.5 : 0.2;
    var Y = function (v) { return T0 + (hi - Math.max(v, lo)) / (hi - lo) * (H - T0 - B); };
    var y0 = H - B, bw = (W - L - R) / TOTAL, w = bw * 0.6;
    var defs = el('defs', {});
    [['gF', '#8b80f9', '#4f46e5'], ['gP', '#6ee7b7', '#10b981']].forEach(function (g) {
      var lg = el('linearGradient', { id: g[0], x1: 0, y1: 0, x2: 0, y2: 1 });
      lg.appendChild(el('stop', { offset: '0%', 'stop-color': g[1] }));
      lg.appendChild(el('stop', { offset: '100%', 'stop-color': g[2] })); defs.appendChild(lg);
    });
    svg.appendChild(defs);
    for (var g = lo; g <= 4.0001; g += step) {
      svg.appendChild(el('line', { x1: L, x2: W - R, y1: Y(g), y2: Y(g), stroke: '#e1e5f3' }));
      svg.appendChild(el('text', { x: L - 8, y: Y(g) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6a7390' }, g.toFixed(1)));
    }
    items.forEach(function (it, i) {
      var x = L + i * bw + (bw - w) / 2, cx = L + i * bw + bw / 2;
      svg.appendChild(el('text', { x: cx, y: H - 14, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#6a7390' }, ORD[i]));
      if (it.t === 'n') return;
      var y = Y(it.v), h = Math.max(y0 - y, 2);
      if (it.t === 'g') {
        svg.appendChild(el('path', { d: rb(x, y, w, h, 8), fill: 'none', 'stroke-width': 1.6, 'stroke-dasharray': '5 4', stroke: it.bad ? '#e11d48' : '#6a7390' }));
        // required value above the dashed bar
        svg.appendChild(el('text', { x: cx, y: y - 7, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 500, fill: it.bad ? '#e11d48' : '#6a7390', style: HALO }, it.lab));
      } else {
        svg.appendChild(el('path', { d: rb(x, y, w, h, 8), fill: it.t === 'k' ? 'url(#gF)' : 'url(#gP)' }));
        // value sits inside the bar, near its base, so it never collides with the target line or gold trend line
        svg.appendChild(el('text', { x: cx, y: y0 - 10, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#fff' }, it.lab));
      }
    });
    svg.appendChild(el('line', { x1: L, x2: W - R, y1: Y(T), y2: Y(T), 'stroke-width': 1.6, 'stroke-dasharray': '2 5', stroke: '#f59e0b' }));
    // target label lives in the right margin, clear of every bar
    svg.appendChild(el('text', { x: W - R + 6, y: Y(T) - 4, 'text-anchor': 'start', 'font-size': 11, 'font-weight': 600, fill: '#d97706' }, 'Target'));
    svg.appendChild(el('text', { x: W - R + 6, y: Y(T) + 10, 'text-anchor': 'start', 'font-size': 11, 'font-weight': 700, fill: '#d97706' }, T.toFixed(2)));
    if (cum.length) {
      svg.appendChild(el('polyline', { points: cum.map(function (p) { return (L + p[0] * bw + bw / 2) + ',' + Y(p[1]); }).join(' '), fill: 'none', 'stroke-width': 2.4, 'stroke-linejoin': 'round', stroke: '#f59e0b' }));
      cum.forEach(function (p) { svg.appendChild(el('circle', { cx: L + p[0] * bw + bw / 2, cy: Y(p[1]), r: 4.2, 'stroke-width': 2, fill: '#f59e0b', stroke: '#fff' })); });
    }
  }

  function render() {
    var N = S.N, rem = TOTAL - N, T = S.target, sk = sum(S.known), cg0 = sk / N;
    var pv = pin.map(function (x) { return num(x.value); });
    var fc = 0, sf = 0; pv.forEach(function (v) { if (v != null) { fc++; sf += v; } });
    var left = rem - fc, need = left > 0 ? (T * TOTAL - sk - sf) / left : null;
    $('tv').textContent = T.toFixed(2); $('t2').textContent = T.toFixed(2);
    Array.prototype.forEach.call($('chips').children, function (b) { b.className = Math.abs(+b.dataset.v - T) < 1e-9 ? 'on' : ''; });
    $('t1').textContent = cg0.toFixed(2); $('t1s').textContent = 'after ' + N + ' semesters';
    var t3 = $('t3'), t3s = $('t3s'); t3.className = '';
    if (left === 0) { t3.textContent = '–'; t3s.textContent = 'all semesters planned'; }
    else if (need <= 0) { t3.textContent = 'Safe'; t3.className = 'ok'; t3s.textContent = 'target already secured'; }
    else if (need > 4) { t3.textContent = '>4.00'; t3.className = 'bad'; t3s.textContent = 'not reachable'; }
    else { t3.textContent = need.toFixed(2); t3s.textContent = 'avg for next ' + left + ' semester' + (left > 1 ? 's' : ''); }
    var items = [], cum = [], run = 0, cnt = 0;
    for (var i = 0; i < TOTAL; i++) {
      if (i < N) { run += S.known[i]; cnt++; items.push({ t: 'k', v: S.known[i], lab: S.known[i].toFixed(2) }); cum.push([i, run / cnt]); }
      else if (pv[i - N] != null) { var v = pv[i - N]; run += v; cnt++; items.push({ t: 'p', v: v, lab: v.toFixed(2) }); cum.push([i, run / cnt]); }
      else if (need != null && need > 0) items.push({ t: 'g', v: Math.min(need, 4), lab: need > 4 ? '>4' : need.toFixed(2), bad: need > 4 });
      else items.push({ t: 'n' });
    }
    chart(items, T, cum);
    var proj = (sk + sf) / (N + fc);
    $('bl').textContent = fc ? 'Projected CGPA' : 'CGPA now';
    $('cg').textContent = proj.toFixed(2);
    $('bs').textContent = 'Average of ' + (N + fc) + ' semester' + (N + fc > 1 ? 's' : '') + ' (equal weight)';
    var m = $('msg');
    if (left === 0) { m.textContent = proj >= T - 1e-9 ? 'Target ' + T.toFixed(2) + ' achieved ✓' : 'Short of target by ' + (T - proj).toFixed(2); m.className = 'msg ' + (proj >= T - 1e-9 ? 'ok' : 'bad'); }
    else if (need <= 0) { m.textContent = 'Target secured even with minimum SGPA ✓'; m.className = 'msg ok'; }
    else if (need > 4) { m.textContent = 'Target ' + T.toFixed(2) + ' can not be reached by the 12th semester'; m.className = 'msg bad'; }
    else { m.textContent = 'Need average SGPA ' + need.toFixed(2) + ' in the remaining ' + left + ' semester' + (left > 1 ? 's' : ''); m.className = 'msg ' + (need > 3.95 ? 'bad' : 'ok'); }
  }
  // Intro guide first; returning users with locked results go straight to the planner
  function openApp(on) {
    $('intro').hidden = on; $('app').hidden = !on;
    window.scrollTo({ top: 0 });
  }
  $('startPlan').onclick = function () { openApp(true); };
  $('backIntro').onclick = function () { openApp(false); };
  // Click a screenshot to see it bigger
  var lb = $('lightbox');
  Array.prototype.forEach.call(document.querySelectorAll('img[data-zoom]'), function (im) {
    im.onclick = function () { $('lbImg').src = im.src; $('lbImg').alt = im.alt; lb.hidden = false; };
  });
  lb.onclick = function () { lb.hidden = true; };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') lb.hidden = true; });
  if (S.locked) { $('intro').hidden = true; $('app').hidden = false; }
  show();
})();
