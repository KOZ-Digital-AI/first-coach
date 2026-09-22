/* FIRST COACH — drill animations.
 * Pure SVG, no dependencies, one shared requestAnimationFrame loop.
 * Three views: side (a player in profile), feet (close-up of both feet from above), top (a pitch diagram from above).
 * Every drill slug in the Open Sport Commons maps to one scene below; unknown slugs fall back to a scene for their track.
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const W = 320, H = 200, G = 176, BR = 7.5;
  const rad = d => d * Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const smooth = u => u * u * (3 - 2 * u);
  const frac = v => v - Math.floor(v);
  const r1 = n => Math.round(n * 10) / 10;
  const bump = (t, c, w) => { let d = Math.abs(t - c); d = Math.min(d, 1 - d); return d < w ? smooth(1 - d / w) : 0; };

  let labelFn = k => k;

  function S(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------- interpolation helpers ----------
  function kf(t, frames) {
    if (t <= frames[0][0]) return frames[0][1];
    for (let i = 0; i < frames.length - 1; i++) {
      const ta = frames[i][0], tb = frames[i + 1][0];
      if (t <= tb) {
        const a = frames[i][1], b = frames[i + 1][1];
        const u = tb > ta ? smooth((t - ta) / (tb - ta)) : 1;
        const o = {};
        for (const k in a) o[k] = (typeof a[k] === 'number' && typeof b[k] === 'number') ? lerp(a[k], b[k], u) : (u < 0.5 ? a[k] : b[k]);
        return o;
      }
    }
    return frames[frames.length - 1][1];
  }

  // pts: [t, x, y, mode, h]; mode is the motion from this point to the next: arc | fall | rise | dec | lin | hold
  function track(t, pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (t >= a[0] && t <= b[0]) {
        const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1;
        const m = a[3] || 'lin';
        if (m === 'hold') return { x: a[1], y: a[2] };
        if (m === 'arc') return { x: lerp(a[1], b[1], u), y: lerp(a[2], b[2], u) - (a[4] || 0) * 4 * u * (1 - u) };
        if (m === 'fall') return { x: lerp(a[1], b[1], u), y: lerp(a[2], b[2], u * u) };
        if (m === 'rise') return { x: lerp(a[1], b[1], u), y: lerp(a[2], b[2], 1 - (1 - u) * (1 - u)) };
        if (m === 'dec') { const e = 1 - (1 - u) * (1 - u); return { x: lerp(a[1], b[1], e), y: lerp(a[2], b[2], e) }; }
        const e = smooth(u);
        return { x: lerp(a[1], b[1], e), y: lerp(a[2], b[2], e) };
      }
    }
    const l = pts[pts.length - 1];
    return { x: l[1], y: l[2] };
  }

  // ---------- shared overlay pieces ----------
  const VB = { side: [40, 34, 240, 150] };
  const vbOf = svg => svg.__vb || [0, 0, W, H];
  function mkLabel(svg, pos) {
    const [vx, vy, , vh] = vbOf(svg);
    const g = S('g', { class: 'a-pillg', transform: pos === 'bottom' ? `translate(${vx + 10} ${vy + vh - 24})` : `translate(${vx + 9} ${vy + 9})` }, svg);
    const bg = S('rect', { x: 0, y: 0, height: 18, rx: 9, class: 'a-pill' }, g);
    const tx = S('text', { x: 9, y: 12.6, class: 'a-pill-text' }, g);
    let cur = null;
    g.style.display = 'none';
    return {
      set(key) {
        if (key === cur) return;
        cur = key;
        if (!key) { g.style.display = 'none'; return; }
        const txt = labelFn(key);
        tx.textContent = txt;
        g.style.display = '';
        let w = 0;
        try { w = tx.getComputedTextLength(); } catch (e) { w = 0; }
        bg.setAttribute('width', Math.round((w || txt.length * 7.6) + 18));
      }
    };
  }
  function mkCounter(svg, cls, bottom) {
    const [vx, vy, vw, vh] = vbOf(svg);
    const tx = S('text', { x: vx + vw - 11, y: bottom ? vy + vh - 10 : vy + 29, 'text-anchor': 'end', class: 'a-count ' + (cls || '') }, svg);
    let cur = null;
    return { set(v) { const s = v == null ? '' : String(v); if (s !== cur) { cur = s; tx.textContent = s; } } };
  }
  function ringLayer(svg) {
    const c = S('circle', { r: 0, class: 'a-flash' }, svg);
    return {
      set(x, y, k) { // k: 0..1 progress of the flash, or -1 hidden
        if (k < 0) { c.setAttribute('r', 0); c.style.opacity = 0; return; }
        c.setAttribute('cx', r1(x)); c.setAttribute('cy', r1(y));
        c.setAttribute('r', r1(6 + k * 16)); c.style.opacity = r1(1 - k);
      }
    };
  }

  // ---------- SIDE VIEW ----------
  const LEN = { torso: 36, head: 13, thigh: 26, shin: 26, foot: 9, upper: 19, fore: 18 };
  const BASE = { x: 142, lift: 0, torso: 3, lt: 3, ls: -3, lfa: 0, rt: -3, rs: 3, rfa: 0, la: -10, lf: 8, ra: 12, rf: 30 };
  const pose = o => Object.assign({}, BASE, o);

  function fk(p) {
    const sn = a => Math.sin(rad(a)), cs = a => Math.cos(rad(a));
    const drop = Math.max(cs(p.lt) * LEN.thigh + cs(p.ls) * LEN.shin, cs(p.rt) * LEN.thigh + cs(p.rs) * LEN.shin);
    const hip = { x: p.x, y: G - 3.5 - drop - p.lift };
    const neck = { x: hip.x + sn(p.torso) * LEN.torso, y: hip.y - cs(p.torso) * LEN.torso };
    const head = { x: neck.x + sn(p.torso) * LEN.head, y: neck.y - cs(p.torso) * LEN.head };
    const leg = (t, s, fa) => {
      const k = { x: hip.x + sn(t) * LEN.thigh, y: hip.y + cs(t) * LEN.thigh };
      const a = { x: k.x + sn(s) * LEN.shin, y: k.y + cs(s) * LEN.shin };
      const ph = s + fa;
      return { k, a, toe: { x: a.x + cs(ph) * LEN.foot, y: a.y - sn(ph) * LEN.foot } };
    };
    const sh = { x: neck.x - sn(p.torso) * 4, y: neck.y + cs(p.torso) * 4 };
    const arm = (u, f) => {
      const e = { x: sh.x + sn(u) * LEN.upper, y: sh.y + cs(u) * LEN.upper };
      return { s: sh, e, h: { x: e.x + sn(f) * LEN.fore, y: e.y + cs(f) * LEN.fore } };
    };
    return { hip, neck, head, L: leg(p.lt, p.ls, p.lfa), R: leg(p.rt, p.rs, p.rfa), LA: arm(p.la, p.lf), RA: arm(p.ra, p.rf) };
  }
  const footTop = (f, leg) => { const l = f[leg]; return { x: (l.a.x + l.toe.x) / 2 + 1, y: Math.min(l.a.y, l.toe.y) - BR - 3.5 }; };
  const thighTop = (f, leg) => { const l = f[leg]; return { x: lerp(f.hip.x, l.k.x, 0.72), y: lerp(f.hip.y, l.k.y, 0.72) - BR - 5 }; };
  const handsAt = f => ({ x: f.RA.h.x + 4, y: f.RA.h.y - 4 });

  function renderSide(svg, spec) {
    S('rect', { width: W, height: H, class: 'a-bg' }, svg);
    S('rect', { y: G, width: W, height: H - G, class: 'a-turf' }, svg);
    S('line', { x1: 0, y1: G, x2: W, y2: G, class: 'a-ground' }, svg);
    const fig = S('g', spec.mirror ? { transform: 'translate(320 0) scale(-1 1)' } : {}, svg);
    const sh = S('ellipse', { cy: G + 1.5, rx: 24, ry: 3.2, class: 'a-shadow' }, fig);
    const bsh = S('ellipse', { cy: G + 1.5, rx: 7, ry: 2, class: 'a-shadow' }, fig);
    const fa = S('polyline', { class: 'a-limb a-arm a-far' }, fig);
    const fl = S('polyline', { class: 'a-limb a-leg a-far' }, fig);
    const tor = S('line', { class: 'a-jersey' }, fig);
    const hd = S('circle', { r: 9.5, class: 'a-head' }, fig);
    const nl = S('polyline', { class: 'a-limb a-leg' + (spec.weak ? ' a-weak' : '') }, fig);
    const na = S('polyline', { class: 'a-limb a-arm' }, fig);
    const bg = S('g', { class: 'a-ballg' + (spec.ghost ? ' a-ghost' : '') }, fig);
    S('circle', { r: BR, class: 'a-ball' }, bg);
    S('path', { d: 'M0,-3.4 L3.2,-1 L2,2.8 L-2,2.8 L-3.2,-1Z', class: 'a-ball-patch' }, bg);
    const ring = ringLayer(fig);
    const lab = mkLabel(svg), cnt = mkCounter(svg);
    const pl = (...p) => p.map(q => r1(q.x) + ',' + r1(q.y)).join(' ');
    return (t, n) => {
      const o = spec.frame(t, n), f = o.f;
      fa.setAttribute('points', pl(f.LA.s, f.LA.e, f.LA.h));
      fl.setAttribute('points', pl(f.hip, f.L.k, f.L.a, f.L.toe));
      nl.setAttribute('points', pl(f.hip, f.R.k, f.R.a, f.R.toe));
      na.setAttribute('points', pl(f.RA.s, f.RA.e, f.RA.h));
      tor.setAttribute('x1', r1(f.hip.x)); tor.setAttribute('y1', r1(f.hip.y));
      tor.setAttribute('x2', r1(f.neck.x)); tor.setAttribute('y2', r1(f.neck.y));
      hd.setAttribute('cx', r1(f.head.x)); hd.setAttribute('cy', r1(f.head.y));
      sh.setAttribute('cx', r1(f.hip.x + 4));
      if (o.ball) {
        bg.style.opacity = o.ball.o == null ? 1 : o.ball.o;
        bg.setAttribute('transform', `translate(${r1(o.ball.x)} ${r1(o.ball.y)}) rotate(${Math.round(o.ball.x * 9 + o.ball.y * 5) % 360})`);
        const hgt = clamp((G - BR - o.ball.y) / 110, 0, 0.7);
        bsh.setAttribute('cx', r1(o.ball.x)); bsh.setAttribute('rx', r1(7 * (1 - hgt)));
        bsh.style.opacity = o.ball.o == null ? 1 - hgt : o.ball.o * (1 - hgt);
      } else { bg.style.opacity = 0; bsh.style.opacity = 0; }
      if (o.ring) ring.set(o.ring.x, o.ring.y, o.ring.k); else ring.set(0, 0, -1);
      lab.set(o.label || null);
      cnt.set(o.count);
    };
  }

  // --- side scenes ---
  const ARMS_OUT = { la: -78, lf: -86, ra: 80, rf: 88 };
  const BAL = { la: -24, lf: -4, ra: 26, rf: 42 };

  function juggle(seq, opts) {
    opts = opts || {};
    const N = seq.length, D = 1 / N;
    const up = {
      R: { rt: 58, rs: 14, rfa: -14, torso: -1 },
      L: { lt: 58, ls: 14, lfa: -14, torso: -1, la: 36, lf: 52, ra: -26, rf: -6 },
      T: { rt: 86, rs: -4, rfa: 8, torso: -4 },
    };
    const rest = pose(BAL);
    const frames = [[0, rest]];
    const contacts = [];
    seq.forEach((k, i) => {
      const w0 = i * D, tc = w0 + D * 0.5;
      const pc = pose(Object.assign({}, BAL, up[k]));
      frames.push([w0 + D * 0.14, rest], [tc, pc], [w0 + D * 0.86, rest]);
      const f = fk(pc);
      const c = k === 'T' ? thighTop(f, 'R') : footTop(f, k === 'L' ? 'L' : 'R');
      contacts.push([tc, c.x, c.y]);
    });
    frames.push([1, rest]);
    const h = opts.h || 40;
    const pts = [[contacts[N - 1][0] - 1, contacts[N - 1][1], contacts[N - 1][2], 'arc', h]];
    contacts.forEach(c => pts.push([c[0], c[1], c[2], 'arc', h]));
    pts.push([contacts[0][0] + 1, contacts[0][1], contacts[0][2]]);
    return {
      view: 'side', period: opts.period || N * 780,
      frame(t, n) {
        const done = contacts.filter(c => c[0] <= t).length;
        const near = contacts.find(c => Math.abs(c[0] - t) < 0.06);
        return {
          f: fk(kf(t, frames)), ball: track(t, pts),
          count: opts.noCount ? null : n * N + done,
          label: opts.label || (near && seq[contacts.indexOf(near)] === 'T' ? 'thigh' : null),
        };
      }
    };
  }

  function bounceJuggle() {
    const rest = pose(BAL);
    const upR = pose(Object.assign({}, BAL, { rt: 38, rs: 6, rfa: -8 }));
    const frames = [[0, rest], [0.14, rest], [0.3, upR], [0.48, rest], [1, rest]];
    const c = footTop(fk(upR), 'R');
    const gx = c.x + 7, gy = G - BR;
    const pts = [[-0.25, gx, gy, 'arc', 12], [0.3, c.x, c.y, 'arc', 28], [0.75, gx, gy, 'arc', 12], [1.3, c.x, c.y]];
    return {
      view: 'side', period: 1300,
      frame(t, n) {
        return {
          f: fk(kf(t, frames)), ball: track(t, pts), count: n + (t >= 0.3 ? 1 : 0),
          label: t > 0.22 && t < 0.44 ? 'touch' : (t > 0.66 && t < 0.86 ? 'bounce' : null),
        };
      }
    };
  }

  function dropBounceCatch() {
    const hold = pose({ ra: 22, rf: 78, la: 16, lf: 72, lt: 8, ls: -8, rt: 8, rs: -8, torso: 8 });
    const low = pose({ ra: 18, rf: 70, la: 12, lf: 64, lt: 20, ls: -18, rt: 20, rs: -18, torso: 13 });
    const frames = [[0, hold], [0.16, hold], [0.62, low], [0.74, low], [1, hold]];
    const h0 = handsAt(fk(hold)), hc = handsAt(fk(kf(0.66, frames)));
    const gy = G - BR;
    const pts = [[0, h0.x, h0.y, 'hold'], [0.12, h0.x, h0.y, 'fall'], [0.38, h0.x + 2, gy, 'rise'], [0.66, hc.x, hc.y, 'hold'], [1, hc.x, hc.y]];
    return {
      view: 'side', period: 2300,
      frame(t) {
        const f = fk(kf(t, frames));
        const ball = (t < 0.12 || t > 0.66) ? handsAt(f) : track(t, pts);
        return {
          f, ball, ring: t > 0.38 && t < 0.46 ? { x: ball.x, y: G, k: (t - 0.38) / 0.08 } : null,
          label: t < 0.16 ? 'drop' : (t > 0.34 && t < 0.5 ? 'bounce' : (t > 0.62 && t < 0.82 ? 'catch' : null)),
        };
      }
    };
  }

  function liftCatch(touches) {
    const HA = { ra: 22, rf: 78, la: 16, lf: 72 };
    const hold = pose(Object.assign({ torso: 6 }, HA));
    const ready = pose(Object.assign({ torso: 6, rt: 22, rs: 8, rfa: -6 }, HA));
    const kick = pose(Object.assign({ torso: 4, rt: 50, rs: 14, rfa: -12 }, HA));
    const hands = handsAt(fk(hold));
    const c = footTop(fk(kick), 'R');
    let frames, pts, tCatch, contacts;
    if (touches === 1) {
      contacts = [0.36];
      frames = [[0, hold], [0.18, ready], [0.3, ready], [0.36, kick], [0.48, hold], [1, hold]];
      pts = [[0.1, hands.x, hands.y, 'fall'], [0.36, c.x, c.y, 'rise'], [0.62, hands.x, hands.y, 'hold'], [1, hands.x, hands.y]];
      tCatch = 0.62;
    } else {
      contacts = [0.32, 0.56];
      frames = [[0, hold], [0.16, ready], [0.27, ready], [0.32, kick], [0.42, ready], [0.52, ready], [0.56, kick], [0.66, hold], [1, hold]];
      pts = [[0.1, hands.x, hands.y, 'fall'], [0.32, c.x, c.y, 'arc', 26], [0.56, c.x, c.y, 'rise'], [0.8, hands.x, hands.y, 'hold'], [1, hands.x, hands.y]];
      tCatch = 0.8;
    }
    return {
      view: 'side', period: touches === 1 ? 2200 : 2800,
      frame(t) {
        const f = fk(kf(t, frames));
        const ball = (t < 0.1 || t >= tCatch) ? handsAt(f) : track(t, pts);
        const k = contacts.filter(x => x <= t).length;
        return {
          f, ball, count: t < 0.1 ? null : k,
          label: t < 0.14 ? 'drop' : (t > tCatch - 0.04 && t < tCatch + 0.16 ? 'catch' : (k ? 'touch' : null)),
        };
      }
    };
  }

  function stork() {
    const st = pose({});
    const a = pose(Object.assign({}, ARMS_OUT, { rt: 72, rs: -22, rfa: -8 }));
    const b = pose(Object.assign({}, ARMS_OUT, { lt: 72, ls: -22, lfa: -8 }));
    const mid = pose(ARMS_OUT);
    const frames = [[0, st], [0.08, a], [0.44, a], [0.5, mid], [0.58, b], [0.94, b], [1, st]];
    return {
      view: 'side', period: 7000,
      frame(t) {
        const p = kf(t, frames);
        const holding = (t > 0.08 && t < 0.44) || (t > 0.58 && t < 0.94);
        if (holding) { p.torso += 1.6 * Math.sin(t * 90); p.la += 4 * Math.sin(t * 70); p.ra -= 4 * Math.sin(t * 70); }
        const start = t < 0.5 ? 0.08 : 0.58;
        return { f: fk(p), ball: null, count: holding ? Math.min(5, Math.floor((t - start) / 0.072) + 1) : null, label: holding ? 'hold' : null };
      }
    };
  }

  function hopFreeze() {
    return {
      view: 'side', period: 3600,
      frame(t) {
        const p = pose(Object.assign({}, ARMS_OUT, { rt: 18, rs: -78, rfa: -40 }));
        let label = null, count = null;
        if (t < 0.6) {
          const ph = frac(t / 0.15), s = Math.sin(Math.PI * ph);
          p.lift = 13 * s; p.lt = 14 - 11 * s; p.ls = -14 + 11 * s;
          count = Math.floor(t / 0.15) + 1;
        } else {
          p.lt = 10; p.ls = -10; p.torso = 5 + Math.sin(t * 60);
          label = 'freeze';
        }
        return { f: fk(p), ball: null, label, count };
      }
    };
  }

  function quickFeet(look) {
    const a = pose({ lt: 24, ls: -22, rt: 10, rs: -10, la: 28, lf: 70, ra: -18, rf: 40, torso: 7, lift: 1 });
    const b = pose({ lt: 10, ls: -10, rt: 24, rs: -22, la: -18, lf: 40, ra: 28, rf: 70, torso: 7, lift: 1 });
    const frames = [[0, a], [0.5, b], [1, a]];
    return {
      view: 'side', period: 440,
      frame(t, n) { return { f: fk(kf(t, frames)), ball: null, label: look && (n % 9) > 5 ? 'look' : null }; }
    };
  }

  function kneeMarch() {
    const st = pose({ la: -4, lf: 4, ra: 4, rf: 8 });
    const r = pose({ rt: 88, rs: 4, rfa: -4, torso: 10, la: 42, lf: 30, ra: -8, rf: 10 });
    const l = pose({ lt: 88, ls: 4, lfa: -4, torso: 10, ra: 42, rf: 30, la: -8, lf: 10 });
    const frames = [[0, st], [0.25, r], [0.5, st], [0.75, l], [1, st]];
    return { view: 'side', period: 1500, frame(t, n) { return { f: fk(kf(t, frames)), ball: null, count: n * 2 + (t > 0.25 ? 1 : 0) + (t > 0.75 ? 1 : 0) }; } };
  }

  function airSwings() {
    const base = Object.assign({}, ARMS_OUT, { lt: 6, ls: -6 });
    const back = pose(Object.assign({}, base, { rt: -26, rs: -40, rfa: -20 }));
    const fwd = pose(Object.assign({}, base, { rt: 38, rs: 30, rfa: -18 }));
    const frames = [[0, back], [0.5, fwd], [1, back]];
    return { view: 'side', mirror: true, weak: true, period: 1900, frame(t, n) { return { f: fk(kf(t, frames)), ball: null, label: 'weak', count: n + (t > 0.5 ? 1 : 0) }; } };
  }

  function readyShape() {
    const st = pose({ lt: 28, ls: -22, rt: 24, rs: -26, torso: 14, la: -6, lf: 30, ra: 30, rf: 62 });
    const recv = pose({ lt: 28, ls: -22, rt: 34, rs: 18, rfa: 8, torso: 12, la: -6, lf: 30, ra: 34, rf: 66 });
    const cush = pose({ lt: 28, ls: -22, rt: 24, rs: 6, rfa: 4, torso: 12, la: -6, lf: 30, ra: 30, rf: 62 });
    const frames = [[0, st], [0.38, st], [0.56, recv], [0.7, cush], [0.84, st], [1, st]];
    return {
      view: 'side', ghost: true, period: 2600,
      frame(t) {
        const p = kf(t, frames);
        if (t < 0.38) p.lift = 2.5 * Math.abs(Math.sin(t * 40));
        const f = fk(p);
        const stopAt = footTop(fk(recv), 'R');
        let ball = null;
        if (t > 0.3 && t < 0.92) {
          const x = t < 0.6 ? lerp(330, stopAt.x + 10, 1 - Math.pow(1 - (t - 0.3) / 0.3, 2)) : stopAt.x + 10 - (t > 0.6 ? Math.min(6, (t - 0.6) * 60) : 0);
          ball = { x, y: G - BR, o: t > 0.84 ? (0.92 - t) / 0.08 : 1 };
        }
        return { f, ball, label: t < 0.34 ? 'ready' : (t > 0.56 && t < 0.8 ? 'cushion' : null) };
      }
    };
  }

  // ---------- FEET VIEW (close-up from above) ----------
  const FB = 17; // ball radius in the feet view
  const SHOE = 'M0,-25 C8,-25 11,-15 11,-4 C11,8 9,20 0,24 C-9,20 -11,8 -11,-4 C-11,-15 -8,-25 0,-25Z';
  const LR = { x: 138, y: 142, r: -6, lift: 0 }, RR = { x: 182, y: 142, r: 6, lift: 0 };

  function renderFeet(svg, spec) {
    S('rect', { width: W, height: H, class: 'a-grass' }, svg);
    for (let i = 0; i < W; i += 64) S('rect', { x: i, y: 0, width: 32, height: H, class: 'a-stripe' }, svg);
    if (spec.draw) spec.draw(svg);
    const shL = S('ellipse', { rx: 12, ry: 24, class: 'a-shadow' }, svg);
    const shR = S('ellipse', { rx: 12, ry: 24, class: 'a-shadow' }, svg);
    const shB = S('ellipse', { rx: FB, ry: FB * 0.8, class: 'a-shadow' }, svg);
    const ball = S('g', { class: 'a-ballg' + (spec.ghost ? ' a-ghost' : '') }, svg);
    S('circle', { r: FB, class: 'a-ball' }, ball);
    S('path', { d: 'M0,-6 L5.7,-1.9 L3.5,4.9 L-3.5,4.9 L-5.7,-1.9Z M0,-6 L0,-13 M5.7,-1.9 L12.4,-4 M3.5,4.9 L7.7,10.7 M-3.5,4.9 L-7.7,10.7 M-5.7,-1.9 L-12.4,-4', class: 'a-ball-patch a-ball-lines' }, ball);
    const mk = (weak) => {
      const g = S('g', {}, svg);
      S('path', { d: SHOE, class: 'a-shoe' + (weak ? ' a-weakshoe' : '') }, g);
      S('path', { d: 'M-4,-10 H4 M-4,-4 H4 M-4,2 H4', class: 'a-lace' }, g);
      return g;
    };
    const fL = mk(spec.weak), fR = mk(false);
    const ring = ringLayer(svg);
    const lab = mkLabel(svg), cnt = mkCounter(svg, 'a-count-light');
    const place = (g, sh, s) => {
      const sc = 1 + 0.12 * (s.lift || 0);
      g.setAttribute('transform', `translate(${r1(s.x)} ${r1(s.y)}) rotate(${r1(s.r || 0)}) scale(${r1(sc * 100) / 100})`);
      sh.setAttribute('transform', `translate(${r1(s.x + 3 + 7 * (s.lift || 0))} ${r1(s.y + 4 + 7 * (s.lift || 0))}) rotate(${r1(s.r || 0)})`);
      sh.style.opacity = r1(1 - 0.45 * (s.lift || 0));
    };
    return (t, n) => {
      const o = spec.frame(t, n);
      let L = o.L, R = o.R, B = o.ball;
      if (spec.mirror) {
        const m = s => ({ x: W - s.x, y: s.y, r: -(s.r || 0), lift: s.lift });
        const nl = m(R), nr = m(L); L = nl; R = nr; B = { x: W - B.x, y: B.y, rot: -(B.rot || 0), o: B.o };
      }
      place(fL, shL, L); place(fR, shR, R);
      ball.setAttribute('transform', `translate(${r1(B.x)} ${r1(B.y)}) rotate(${Math.round(B.rot || 0)})`);
      ball.style.opacity = B.o == null ? 1 : B.o;
      shB.setAttribute('transform', `translate(${r1(B.x + 3)} ${r1(B.y + 5)})`);
      shB.style.opacity = B.o == null ? 1 : B.o;
      if (o.ring) ring.set(spec.mirror ? W - o.ring.x : o.ring.x, o.ring.y, o.ring.k); else ring.set(0, 0, -1);
      lab.set(o.label || null);
      cnt.set(o.count);
    };
  }

  function soleTaps(opts) {
    opts = opts || {};
    const onR = { x: 163, y: 103, r: 0, lift: 1 }, onL = { x: 157, y: 103, r: 0, lift: 1 };
    const fr = [[0, RR], [0.1, RR], [0.25, onR], [0.4, RR], [1, RR]];
    const fl = [[0, LR], [0.6, LR], [0.75, onL], [0.9, LR], [1, LR]];
    return {
      view: 'feet', ghost: opts.ghost, period: 1150,
      frame(t, n) {
        return { L: kf(t, fl), R: kf(t, fr), ball: { x: 160, y: 88, rot: 0 }, count: n * 2 + (t >= 0.25 ? 1 : 0) + (t >= 0.75 ? 1 : 0), label: opts.ghost ? 'imagine' : null };
      }
    };
  }

  function soleRolls() {
    return {
      view: 'feet', period: 3200,
      frame(t) {
        const w = Math.sin(Math.PI * 4 * t);
        const bx = 160 + (t >= 0.5 ? 24 * w : 0), by = 90 + (t < 0.5 ? 14 * w : 0);
        return {
          L: { x: 124, y: 150, r: -6, lift: 0 }, R: { x: bx + 2, y: by + 15, r: 0, lift: 1 },
          ball: { x: bx, y: by, rot: (bx - 160) * 5 + (by - 90) * 5 }, label: t < 0.5 ? 'fwdBack' : 'sideSide',
        };
      }
    };
  }

  function pingPong(opts) {
    opts = opts || {};
    const period = opts.fast ? 760 : 980;
    return {
      view: 'feet', period,
      draw: opts.signal ? svg => {
        const g = S('g', { class: 'a-signal', transform: 'translate(262 16)' }, svg);
        S('rect', { width: 46, height: 40, rx: 8, class: 'a-card' }, g);
        g.__num = S('text', { x: 23, y: 29, 'text-anchor': 'middle', class: 'a-card-num' }, g);
        opts._sig = g;
      } : null,
      frame(t, n) {
        const x = 160 + 17 * Math.cos(2 * Math.PI * t);
        const bR = bump(t, 0, 0.13), bL = bump(t, 0.5, 0.13);
        if (opts._sig) {
          const show = (n % 4) === 3;
          opts._sig.style.opacity = show ? 1 : 0;
          opts._sig.__num.textContent = String((n * 7) % 5 + 1);
        }
        return {
          L: { x: 116 + 5 * bL, y: 128, r: -4 + 6 * bL, lift: 0 }, R: { x: 204 - 5 * bR, y: 128, r: 4 - 6 * bR, lift: 0 },
          ball: { x, y: 128, rot: x * 6 }, count: opts.noCount ? null : n * 2 + (t >= 0.5 ? 1 : 0),
          label: opts.signal && (n % 4) === 3 ? 'callNumber' : null,
        };
      }
    };
  }

  function pullPush() {
    const A = [180, 84], Bp = [180, 108], C = [140, 84], Dp = [140, 108];
    const ball = [[0, A[0], A[1], 'lin'], [0.18, Bp[0], Bp[1], 'hold'], [0.26, Bp[0], Bp[1], 'dec'], [0.46, C[0], C[1], 'hold'], [0.52, C[0], C[1], 'lin'],
      [0.68, Dp[0], Dp[1], 'hold'], [0.76, Dp[0], Dp[1], 'dec'], [0.96, A[0], A[1], 'hold'], [1, A[0], A[1]]];
    const rRest = { x: 190, y: 148, r: 6, lift: 0 }, lRest = { x: 130, y: 148, r: -6, lift: 0 };
    const fr = [[0, { x: 182, y: 100, r: 0, lift: 1 }], [0.18, { x: 182, y: 124, r: 0, lift: 1 }], [0.26, { x: 205, y: 114, r: -22, lift: 0.3 }],
      [0.33, { x: 192, y: 104, r: -26, lift: 0.2 }], [0.46, rRest], [0.9, rRest], [0.96, { x: 182, y: 100, r: 0, lift: 1 }], [1, { x: 182, y: 100, r: 0, lift: 1 }]];
    const fl = [[0, lRest], [0.4, lRest], [0.46, { x: 138, y: 100, r: 0, lift: 1 }], [0.68, { x: 138, y: 124, r: 0, lift: 1 }], [0.76, { x: 115, y: 114, r: 22, lift: 0.3 }],
      [0.83, { x: 128, y: 104, r: 26, lift: 0.2 }], [0.96, lRest], [1, lRest]];
    return {
      view: 'feet', period: 3200,
      frame(t) {
        const b = track(t, ball);
        return { L: kf(t, fl), R: kf(t, fr), ball: { x: b.x, y: b.y, rot: b.x * 4 + b.y * 4 }, label: (t < 0.2 || (t > 0.5 && t < 0.7)) ? 'pull' : ((t > 0.24 && t < 0.46) || (t > 0.74 && t < 0.96) ? 'push' : null) };
      }
    };
  }

  function insideOutside(opts) {
    opts = opts || {};
    const ball = [[0, 174, 92, 'dec'], [0.3, 148, 92, 'hold'], [0.5, 148, 92, 'dec'], [0.8, 174, 92, 'hold'], [1, 174, 92]];
    const fr = [[0, { x: 202, y: 104, r: -8, lift: 0.15 }], [0.3, { x: 177, y: 104, r: -8, lift: 0.1 }], [0.41, { x: 150, y: 120, r: 0, lift: 1 }],
      [0.5, { x: 120, y: 104, r: 8, lift: 0.15 }], [0.8, { x: 145, y: 104, r: 8, lift: 0.1 }], [0.91, { x: 176, y: 120, r: 0, lift: 1 }], [1, { x: 202, y: 104, r: -8, lift: 0.15 }]];
    return {
      view: 'feet', mirror: opts.weak, weak: opts.weak, period: 1700,
      frame(t, n) {
        const b = track(t, ball);
        return { L: { x: 100, y: 152, r: -8, lift: 0 }, R: kf(t, fr), ball: { x: b.x, y: b.y, rot: b.x * 6 }, label: t < 0.34 ? 'inside' : (t > 0.48 && t < 0.84 ? 'outside' : null), count: n * 2 + (t > 0.02 ? 1 : 0) + (t > 0.5 ? 1 : 0) };
      }
    };
  }

  function clockTaps() {
    const cx = 160, cy = 100, R0 = 56, taps = 8;
    return {
      view: 'feet', period: 6400,
      draw(svg) {
        [['12', 0, -1], ['3', 1, 0], ['6', 0, 1], ['9', -1, 0]].forEach(([s, dx, dy]) => {
          const tx = S('text', { x: cx + dx * 92, y: cy + dy * 84 + 4, 'text-anchor': 'middle', class: 'a-clock' }, svg);
          tx.textContent = s;
        });
        S('circle', { cx, cy, r: 76, class: 'a-zone' }, svg);
      },
      frame(t, n) {
        const th = 2 * Math.PI * t;
        const C = { x: cx + R0 * Math.sin(th), y: cy + R0 * Math.cos(th) };
        const phi = -th;
        const cs = Math.cos(phi), sn = Math.sin(phi);
        const toW = (lx, ly) => ({ x: C.x + lx * cs - ly * sn, y: C.y + lx * sn + ly * cs });
        let bl = 0, brr = 0;
        for (let k = 0; k < taps; k++) { const b = bump(t, (k + 0.5) / taps, 0.045); if (k % 2) bl = Math.max(bl, b); else brr = Math.max(brr, b); }
        const lp = toW(lerp(-13, -2, bl), lerp(0, -40, bl)), rp = toW(lerp(13, 2, brr), lerp(0, -40, brr));
        const deg = phi * 180 / Math.PI;
        const done = Math.floor(t * taps + 0.5);
        return { L: { x: lp.x, y: lp.y, r: deg, lift: bl }, R: { x: rp.x, y: rp.y, r: deg, lift: brr }, ball: { x: cx, y: cy, rot: 0 }, count: n * taps + done };
      }
    };
  }

  function rollStop(opts) {
    opts = opts || {};
    const sole = opts.stop === 'sole';
    const stopR = sole ? { x: 163, y: 103, r: 0, lift: 1 } : { x: 160, y: 116, r: 90, lift: 0.25 };
    const restR = { x: 184, y: 150, r: 6, lift: 0 };
    const fr = [[0, restR], [0.22, restR], [0.38, stopR], [0.7, stopR], [0.82, restR], [1, restR]];
    return {
      view: 'feet', mirror: opts.weak, weak: opts.weak, period: 2600,
      frame(t, n) {
        let y = -24, o = 1;
        if (t < 0.05) o = 0;
        else if (t < 0.4) y = lerp(-24, 88, 1 - Math.pow(1 - (t - 0.05) / 0.35, 2));
        else { y = 88; if (t > 0.84) o = Math.max(0, (0.96 - t) / 0.12); }
        return {
          L: { x: 136, y: 150, r: -6, lift: 0 }, R: kf(t, fr), ball: { x: 160, y, rot: y * 5, o },
          ring: t > 0.4 && t < 0.5 ? { x: 160, y: 88, k: (t - 0.4) / 0.1 } : null,
          label: t > 0.4 && t < 0.68 ? (sole ? 'sole' : 'stop') : null, count: n + (t > 0.4 ? 1 : 0),
        };
      }
    };
  }

  function soleDrag() {
    return {
      view: 'feet', mirror: true, weak: true, period: 3400,
      frame(t) {
        let bx = 160, by = 88;
        if (t < 0.5) by = 88 + 22 * Math.sin(Math.PI * 2 * t);
        else bx = 160 + 26 * Math.sin(Math.PI * 2 * (t - 0.5));
        return { L: { x: 128, y: 150, r: -6, lift: 0 }, R: { x: bx + 2, y: by + 15, r: 0, lift: 1 }, ball: { x: bx, y: by, rot: bx * 5 + by * 5 }, label: 'weak' };
      }
    };
  }

  function figureEight() {
    return {
      view: 'feet', period: 3800,
      draw(svg) { S('path', { d: (() => { let d = ''; for (let i = 0; i <= 64; i++) { const th = i / 64 * 2 * Math.PI; d += (i ? 'L' : 'M') + r1(160 + 72 * Math.sin(th)) + ' ' + r1(118 + 50 * Math.sin(2 * th)); } return d; })(), class: 'a-trail' }, svg); },
      frame(t, n) {
        const th = 2 * Math.PI * t;
        return { L: { x: 124, y: 118, r: -4, lift: 0 }, R: { x: 196, y: 118, r: 4, lift: 0 }, ball: { x: 160 + 72 * Math.sin(th), y: 118 + 50 * Math.sin(2 * th), rot: th * 300 }, count: n + 1 };
      }
    };
  }

  // ---------- TOP VIEW (pitch diagram) ----------
  function topBase(svg, bg) {
    bg = bg || {};
    S('rect', { width: W, height: H, class: 'a-grass' }, svg);
    for (let i = 0; i < W; i += 40) S('rect', { x: i, y: 0, width: 20, height: H, class: 'a-stripe' }, svg);
    if (bg.zone) {
      const s = bg.zone === '4x4' ? 156 : 132;
      S('rect', { x: 160 - s / 2, y: 100 - s / 2, width: s, height: s, rx: 4, class: 'a-zone' }, svg);
      const tx = S('text', { x: 160 - s / 2 + 6, y: 100 - s / 2 + 13, class: 'a-zone-label' }, svg);
      tx.textContent = (bg.zone === '4x4' ? '4×4 ' : '3×3 ') + labelFn('m');
      if (bg.zone === '4x4') [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([dx, dy]) => S('ellipse', { cx: 160 + dx * s / 2, cy: 100 + dy * s / 2, rx: 3.2, ry: 6, class: 'a-marker' }, svg));
    }
    if (bg.wall) {
      S('rect', { x: 20, y: 4, width: 280, height: 20, rx: 2, class: 'a-wall' }, svg);
      let d = 'M20 14H300';
      for (let x = 20, i = 0; x < 300; x += 22, i++) d += `M${x + (i % 2 ? 11 : 0)} 4V14M${x + (i % 2 ? 0 : 11)} 14V24`;
      S('path', { d, class: 'a-wall-lines' }, svg);
      const tx = S('text', { x: 300 - 8, y: 36, 'text-anchor': 'end', class: 'a-zone-label' }, svg);
      tx.textContent = labelFn('wall');
    }
    (bg.cones || []).forEach(c => cone(svg, c[0], c[1]));
    (bg.markers || []).forEach(c => S('ellipse', { cx: c[0], cy: c[1], rx: 3.2, ry: 6, class: 'a-marker' }, svg));
    if (bg.draw) bg.draw(svg);
  }
  function cone(svg, x, y) {
    S('ellipse', { cx: x + 1.8, cy: y + 2.4, rx: 7.6, ry: 6.4, class: 'a-shadow' }, svg);
    S('circle', { cx: x, cy: y, r: 7, class: 'a-cone' }, svg);
    S('circle', { cx: x, cy: y, r: 2.8, class: 'a-cone-top' }, svg);
  }
  function topPlayer(svg, cls) {
    const g = S('g', { class: 'a-tp ' + (cls || '') }, svg);
    S('ellipse', { cx: 2, cy: 3, rx: 13, ry: 9, class: 'a-shadow' }, g);
    const fl = S('ellipse', { cx: -5, cy: 0, rx: 2.8, ry: 4.4, class: 'a-tfoot' }, g);
    const fr = S('ellipse', { cx: 5, cy: 0, rx: 2.8, ry: 4.4, class: 'a-tfoot' }, g);
    S('ellipse', { cx: 0, cy: 0, rx: 12, ry: 6.5, class: 'a-tbody' }, g);
    S('circle', { cx: 0, cy: 0.5, r: 5.2, class: 'a-thead' }, g);
    return {
      set(x, y, angDeg, phase, kick) { // kick: null | {side:'L'|'R', weak}
        g.setAttribute('transform', `translate(${r1(x)} ${r1(y)}) rotate(${r1(angDeg + 90)}) scale(1.32)`);
        const s = Math.sin(phase) * 4;
        fl.setAttribute('cy', r1(kick && kick.side === 'L' ? -10 : -s));
        fr.setAttribute('cy', r1(kick && kick.side === 'R' ? -10 : s));
        fl.setAttribute('class', 'a-tfoot' + (kick && kick.side === 'L' ? (kick.weak ? ' a-kick-weak' : ' a-kick') : ''));
        fr.setAttribute('class', 'a-tfoot' + (kick && kick.side === 'R' ? (kick.weak ? ' a-kick-weak' : ' a-kick') : ''));
      }
    };
  }
  function topBall(svg) {
    const sh = S('ellipse', { rx: 6, ry: 4.8, class: 'a-shadow' }, svg);
    const g = S('g', {}, svg);
    S('circle', { r: 6.2, class: 'a-ball a-ball-top' }, g);
    S('circle', { r: 2.3, class: 'a-ball-patch' }, g);
    return {
      set(x, y, o) {
        g.setAttribute('transform', `translate(${r1(x)} ${r1(y)})`);
        sh.setAttribute('transform', `translate(${r1(x + 1.5)} ${r1(y + 2)})`);
        g.style.opacity = sh.style.opacity = o == null ? 1 : o;
      }
    };
  }

  function buildPath(pts) {
    const n = pts.length, P = i => pts[(i + n) % n], SUB = 18, samples = [], knotIdx = [];
    for (let i = 0; i < n; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      knotIdx.push(samples.length);
      for (let j = 0; j < SUB; j++) {
        const u = j / SUB, u2 = u * u, u3 = u2 * u;
        const c = k => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
        samples.push([c(0), c(1)]);
      }
    }
    samples.push(samples[0].slice());
    const cum = [0];
    for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
    const len = cum[cum.length - 1];
    function at(s) {
      const d = frac(s) * len;
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      const u = (d - cum[lo]) / ((cum[hi] - cum[lo]) || 1), a = samples[lo], b = samples[hi];
      return { x: lerp(a[0], b[0], u), y: lerp(a[1], b[1], u), a: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI };
    }
    return { at, len, d: 'M' + samples.map(p => r1(p[0]) + ' ' + r1(p[1])).join('L') + 'Z', knots: knotIdx.map(i => cum[i] / len) };
  }
  function timing(t, segs, knots) {
    const tot = segs.reduce((a, s) => a + s[1], 0);
    let acc = 0, s0 = 0;
    for (const seg of segs) {
      const target = typeof seg[0] === 'string' ? knots[+seg[0].slice(1)] : seg[0];
      const w = seg[1] / tot;
      if (t <= acc + w) {
        const u = (t - acc) / w;
        return { s: lerp(s0, target, seg[3] === 'lin' ? u : smooth(u)), label: seg[2] || null, moving: target !== s0, fast: seg[4] };
      }
      acc += w; s0 = target;
    }
    return { s: s0, label: null, moving: false };
  }

  // spec: {view:'path', pts, segs, bg, touch, weak:'all'|'switch', signal:{x,y,partner}}
  function renderPath(svg, spec) {
    topBase(svg, spec.bg);
    const path = buildPath(spec.pts);
    S('path', { d: path.d, class: 'a-trail' }, svg);
    let sig = null, sight = null, partner = null;
    if (spec.signal) {
      if (spec.signal.partner) { partner = topPlayer(svg, 'a-tp2'); partner.set(spec.signal.x + 20, spec.signal.y + 34, 180, 0, null); }
      sight = S('line', { class: 'a-sight' }, svg);
      sig = S('g', { class: 'a-signal', transform: `translate(${spec.signal.x - 17} ${spec.signal.y - 15})` }, svg);
      S('rect', { width: 34, height: 30, rx: 7, class: 'a-card' }, sig);
      sig.__n = S('text', { x: 17, y: 22, 'text-anchor': 'middle', class: 'a-card-num a-card-num-sm' }, sig);
    }
    const pl = topPlayer(svg), ball = topBall(svg), lab = mkLabel(svg, spec.labelPos), cnt = mkCounter(svg, 'a-count-light', spec.bg && spec.bg.wall);
    const segs = spec.segs || [[1, 1, null, 'lin']];
    const touch = spec.touch || 24;
    return (t, n) => {
      const tm = timing(t, segs, path.knots);
      const t2 = t + 0.004, s2 = t2 >= 1 ? timing(t2 - 1, segs, path.knots).s + 1 : timing(t2, segs, path.knots).s;
      const P = path.at(tm.s);
      const speed = Math.abs(s2 - tm.s) * path.len;
      const sf = clamp(speed / (spec.nominal || 1.1), 0, 1);
      const dist = (n + tm.s) * path.len;
      const k = frac(dist / touch);
      const pulse = k < 0.16 ? k / 0.16 : 1 - (k - 0.16) / 0.84;
      const lead = 9 + (spec.lead || 9) * pulse * sf;
      const B = path.at(tm.s + lead / path.len);
      const idx = Math.floor(dist / touch);
      let kick = null;
      if (sf > 0.3 && k < 0.14) {
        if (spec.weak === 'all') kick = { side: 'L', weak: true };
        else if (spec.weak === 'switch') { const w = (idx % 8) >= 5; kick = { side: w ? 'L' : 'R', weak: w }; }
        else kick = { side: idx % 2 ? 'L' : 'R', weak: false };
      }
      pl.set(P.x, P.y, P.a, dist / 7, kick);
      ball.set(B.x, B.y);
      let label = tm.label;
      if (spec.weak === 'switch' && sf > 0.3 && (idx % 8) >= 5) label = 'switch';
      if (sig) {
        const on = frac(t * (spec.signal.per || 3)) > 0.62;
        sig.style.opacity = on ? 1 : 0;
        sight.style.opacity = on ? 0.85 : 0;
        sight.setAttribute('x1', r1(P.x)); sight.setAttribute('y1', r1(P.y));
        sight.setAttribute('x2', spec.signal.x); sight.setAttribute('y2', spec.signal.y);
        sig.__n.textContent = String((Math.floor(t * (spec.signal.per || 3)) + n * 2) % 5 + 1);
        if (on) label = spec.signal.partner ? 'callNumber' : 'look';
      }
      lab.set(label);
      cnt.set(spec.count ? (idx % spec.count) + 1 : null);
    };
  }

  // spec: {view:'kf', bg, P:[[t,x,y,a]], P2, B:[[t,x,y,mode]|[t,'F'|'P'|'F2']], kicks:[[t,who,side,weak]], rings:[[t,x,y]], labels:[[t0,t1,key]]}
  function kfArr(t, fr) {
    if (t <= fr[0][0]) return fr[0].slice(1);
    for (let i = 0; i < fr.length - 1; i++) {
      const a = fr[i], b = fr[i + 1];
      if (t <= b[0]) { const u = b[0] > a[0] ? smooth((t - a[0]) / (b[0] - a[0])) : 1; return [lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u)]; }
    }
    return fr[fr.length - 1].slice(1);
  }
  function renderKf(svg, spec) {
    topBase(svg, spec.bg);
    const pl = topPlayer(svg), p2 = spec.P2 ? topPlayer(svg, 'a-tp2') : null;
    const ball = topBall(svg), ring = ringLayer(svg), lab = mkLabel(svg, spec.labelPos), cnt = mkCounter(svg, 'a-count-light', !!(spec.bg && spec.bg.wall));
    const feetOf = (p, fwd) => ({ x: p[0] + Math.cos(rad(p[2])) * (fwd || 12), y: p[1] + Math.sin(rad(p[2])) * (fwd || 12) });
    const resolve = (pt, t) => {
      if (pt[1] === 'F') return feetOf(kfArr(t, spec.P));
      if (pt[1] === 'F2') return feetOf(kfArr(t, spec.P2));
      if (pt[1] === 'P') { const p = kfArr(t, spec.P); return { x: p[0], y: p[1] }; }
      return { x: pt[1], y: pt[2] };
    };
    let last = null, dist = 0;
    return (t, n) => {
      const p = kfArr(t, spec.P);
      if (last) { const d = Math.hypot(p[0] - last[0], p[1] - last[1]); if (d < 20) dist += d; }
      last = p;
      const kickFor = who => { const k = (spec.kicks || []).find(k => k[1] === who && t >= k[0] && t < k[0] + 0.06); return k ? { side: k[2], weak: !!k[3] } : null; };
      pl.set(p[0], p[1], p[2], dist / 6, kickFor(1));
      if (p2) { const q = kfArr(t, spec.P2); p2.set(q[0], q[1], q[2], 0, kickFor(2)); }
      const B = spec.B;
      let bp = null;
      for (let i = 0; i < B.length - 1; i++) {
        if (t >= B[i][0] && t <= B[i + 1][0]) {
          const a = B[i];
          if (a[1] === 'F' || a[1] === 'F2' || a[1] === 'P') { bp = resolve(a, t); break; }
          const A = resolve(a, a[0]), Bn = resolve(B[i + 1], B[i + 1][0]);
          const u = B[i + 1][0] > a[0] ? (t - a[0]) / (B[i + 1][0] - a[0]) : 1;
          const e = a[3] === 'dec' ? 1 - (1 - u) * (1 - u) : a[3] === 'hold' ? 0 : smooth(u);
          bp = { x: lerp(A.x, Bn.x, e), y: lerp(A.y, Bn.y, e) };
          break;
        }
      }
      if (!bp) bp = resolve(B[B.length - 1], t);
      ball.set(bp.x, bp.y, spec.ballHidden && spec.ballHidden(t) ? 0 : 1);
      const r = (spec.rings || []).find(r => t >= r[0] && t < r[0] + 0.08);
      if (r) { const c = r[1] === 'B' ? bp : { x: r[1], y: r[2] }; ring.set(c.x, c.y, (t - r[0]) / 0.08); } else ring.set(0, 0, -1);
      const l = (spec.labels || []).find(l => t >= l[0] && t < l[1]);
      lab.set(l ? l[2] : null);
      cnt.set(spec.count ? spec.count(t, n) : null);
    };
  }

  // --- top scene builders ---
  function wall(o) {
    o = o || {};
    const passes = o.ladder ? 3 : (o.feet === 'alt' || o.gate === 'alt' ? 2 : 1);
    const D = 1 / passes, px = 160;
    const baseY = { 2: 100, 3: 128, 4: 152 }[o.dist || 3];
    const rows = o.ladder ? [96, 124, 152] : null;
    const pyOf = i => rows ? rows[i % 3] : baseY;
    const sideOf = i => o.feet === 'alt' ? (i % 2 ? 'L' : 'R') : (o.feet === 'W' ? 'L' : 'R');
    const footX = side => px + (side === 'L' ? -6 : 6);
    const startOf = i => o.two ? [px + 16, pyOf(i) - 11] : [footX(sideOf(i)), pyOf(i) - 11];
    const tx = o.target ? 214 : px;
    const P = [], B = [], kicks = [], rings = [], labels = [];
    for (let i = 0; i < passes; i++) {
      const t0 = i * D, py = pyOf(i), fy = py - 11, side = sideOf(i), st = startOf(i);
      const tk = t0 + D * 0.03, tw = t0 + D * 0.3, tr = t0 + D * 0.58;
      const back = o.two ? [px, fy] : (o.feet === 'alt' ? [footX(sideOf(i + 1)), fy] : [footX(side), fy]);
      P.push([t0, px, py, -90]);
      kicks.push([tk, 1, side, !!o.weak]);
      B.push([t0, st[0], st[1], 'hold'], [tk, st[0], st[1], 'dec'], [tw, tx, 29, 'dec'], [tr, back[0], back[1], 'hold']);
      if (o.target) rings.push([tw, tx, 14]);
      if (o.stop === 'sole') { rings.push([tr, back[0], back[1]]); labels.push([tr, tr + D * 0.25, 'sole']); }
      if (o.two) {
        kicks.push([tr + D * 0.06, 1, 'R', false]);
        B.push([tr + D * 0.06, back[0], back[1], 'dec'], [tr + D * 0.2, st[0], st[1], 'hold']);
        labels.push([tr + D * 0.04, tr + D * 0.24, 'one'], [t0, t0 + D * 0.12, 'two']);
        P.push([t0 + D * 0.98, px, py, -90]);
      } else if (o.gate) {
        const g = o.gate === 'alt' ? (i % 2 ? 1 : -1) : (o.gate === 'R' ? 1 : -1);
        const gx = px + g * 74, face = g > 0 ? 0 : -180, faceBack = g > 0 ? -180 : 0, a = tr + D * 0.04;
        kicks.push([a, 1, g > 0 ? 'R' : 'L', !!o.weak]);
        B.push([a, back[0], back[1], 'dec'], [a + D * 0.16, gx, py - 2, 'hold'], [t0 + D * 0.84, 'F'], [t0 + D * 0.97, st[0], st[1], 'hold']);
        P.push([a, px, py, -90], [a + D * 0.18, gx - g * 10, py, face], [t0 + D * 0.84, gx - g * 10, py, face], [t0 + D * 0.88, gx - g * 10, py, faceBack], [t0 + D * 0.97, px, py, faceBack]);
        labels.push([tr - D * 0.14, tr + D * 0.16, g > 0 ? 'right' : 'left']);
      } else if (rows) {
        const ny = pyOf(i + 1), ns = startOf(i + 1);
        B.push([t0 + D * 0.8, 'F'], [t0 + D * 0.98, ns[0], ns[1], 'hold']);
        P.push([t0 + D * 0.8, px, py, -90], [t0 + D * 0.98, px, ny, -90]);
      } else {
        P.push([t0 + D * 0.98, px, py, -90]);
      }
    }
    P.push([1, px, pyOf(0), -90]);
    const s0 = startOf(0);
    B.push([1, s0[0], s0[1], 'hold']);
    const bg = {
      wall: true, cones: o.gate && o.gate !== 'alt' ? [[px + (o.gate === 'R' ? 64 : -64), baseY - 16], [px + (o.gate === 'R' ? 64 : -64), baseY + 14]] : [],
      draw: svg => {
        if (o.target) { S('circle', { cx: tx, cy: 14, r: 8, class: 'a-target' }, svg); S('circle', { cx: tx, cy: 14, r: 3.5, class: 'a-target-in' }, svg); }
        if (rows) rows.forEach((y, i) => {
          S('line', { x1: 40, y1: y + 12, x2: 280, y2: y + 12, class: 'a-dist' }, svg);
          const t = S('text', { x: 44, y: y + 8, class: 'a-zone-label' }, svg); t.textContent = (i + 2) + ' ' + labelFn('m');
        });
      }
    };
    return {
      view: 'kf', period: passes * (o.two ? 2300 : o.gate ? 3400 : 1900), bg, P, B, kicks, rings, labels, labelPos: 'bottom',
      count: (t, n) => n * passes + Math.floor(t * passes + 0.7),
    };
  }

  function partner(o) {
    o = o || {};
    const A = [160, 168, -90], Bq = [160, 32, 90];
    const stopLabel = o.sole ? 'sole' : 'stop';
    return {
      view: 'kf', period: 3000, labelPos: 'bottom',
      bg: { markers: [] },
      P: [[0, ...A], [1, ...A]], P2: [[0, ...Bq], [1, ...Bq]],
      B: [[0, 160, 157, 'hold'], [0.04, 160, 157, 'dec'], [0.34, 160, 43, 'hold'], [0.54, 160, 43, 'dec'], [0.84, 160, 157, 'hold'], [1, 160, 157]],
      kicks: [[0.04, 1, o.weak ? 'L' : 'R', o.weak], [0.54, 2, o.weak ? 'L' : 'R', o.weak]],
      rings: [[0.34, 160, 43], [0.84, 160, 157]],
      labels: [[0.34, 0.5, stopLabel], [0.84, 1, stopLabel]],
      count: (t, n) => n * 2 + (t > 0.34 ? 1 : 0) + (t > 0.84 ? 1 : 0),
    };
  }

  function dashStop() {
    return {
      view: 'kf', period: 5200,
      bg: { cones: [[36, 82], [36, 118], [262, 82], [262, 118]] },
      P: [[0, 44, 100, 0], [0.3, 244, 100, 0], [0.38, 252, 100, 0], [0.46, 252, 100, 0], [0.52, 252, 104, 180], [0.96, 50, 104, 180], [1, 44, 100, 360]],
      B: [[0, 53, 100, 'lin'], [0.3, 256, 100, 'dec'], [0.38, 261, 100, 'hold'], [0.5, 261, 100, 'lin'], [0.52, 'F']],
      rings: [[0.38, 261, 100]],
      labels: [[0.02, 0.28, 'fast'], [0.38, 0.5, 'sole'], [0.54, 0.95, 'walkBack']],
    };
  }

  function redirect() {
    const py = 150;
    return {
      view: 'kf', period: 6400, labelPos: 'bottom', bg: { zone: '3x3' },
      P: [[0, 160, py, -90], [0.06, 160, py, -90], [0.2, 160, 112, -90], [0.28, 160, 112, -90], [0.4, 122, 102, -170], [0.46, 122, 102, -170], [0.5, 160, py, -90],
        [0.56, 160, py, -90], [0.7, 160, 112, -90], [0.78, 160, 112, -90], [0.9, 198, 102, -10], [0.96, 198, 102, -10], [1, 160, py, -90]],
      B: [[0, 'P'], [0.04, 160, py - 4, 'dec'], [0.18, 160, 96, 'hold'], [0.28, 160, 96, 'dec'], [0.36, 114, 94, 'hold'], [0.46, 'P'],
        [0.54, 160, py - 4, 'dec'], [0.68, 160, 96, 'hold'], [0.78, 160, 96, 'dec'], [0.86, 206, 94, 'hold'], [0.96, 'P'], [1, 'P']],
      kicks: [[0.28, 1, 'R', false], [0.78, 1, 'L', false]],
      labels: [[0.14, 0.3, 'left'], [0.64, 0.8, 'right']],
    };
  }

  function twoTouchSelf() {
    return {
      view: 'kf', period: 5200, bg: { zone: '3x3' },
      P: [[0, 108, 100, 0], [0.06, 108, 100, 0], [0.26, 190, 100, 0], [0.3, 196, 100, 0], [0.4, 202, 100, 180], [0.56, 202, 100, 180], [0.76, 120, 100, 180], [0.8, 114, 100, 180], [0.9, 108, 100, 360], [1, 108, 100, 360]],
      B: [[0, 117, 100, 'hold'], [0.04, 117, 100, 'dec'], [0.26, 206, 100, 'hold'], [0.3, 206, 100, 'dec'], [0.4, 193, 100, 'hold'], [0.54, 193, 100, 'dec'],
        [0.76, 104, 100, 'hold'], [0.8, 104, 100, 'dec'], [0.9, 117, 100, 'hold'], [1, 117, 100]],
      kicks: [[0.04, 1, 'R', false], [0.3, 1, 'R', false], [0.54, 1, 'L', false], [0.8, 1, 'L', false]],
      rings: [[0.3, 'B'], [0.8, 'B']],
      labels: [[0.28, 0.42, 'one'], [0.52, 0.62, 'two'], [0.78, 0.9, 'one'], [0.02, 0.12, 'two']],
    };
  }

  function compass() {
    const c = [160, 100];
    const steps = [[0, -34, 'fwd'], [34, 0, 'rightDir'], [0, 34, 'back'], [-34, 0, 'leftDir']];
    const P = [[0, c[0], c[1], -90]], labels = [], rings = [];
    steps.forEach(([dx, dy, key], i) => {
      const t0 = i * 0.25;
      P.push([t0 + 0.04, c[0], c[1], -90], [t0 + 0.1, c[0] + dx, c[1] + dy, -90], [t0 + 0.16, c[0] + dx, c[1] + dy, -90], [t0 + 0.22, c[0], c[1], -90]);
      labels.push([t0 + 0.06, t0 + 0.2, key]);
      rings.push([t0 + 0.1, c[0] + dx, c[1] + dy]);
    });
    P.push([1, c[0], c[1], -90]);
    return {
      view: 'kf', period: 4400, B: [[0, -40, -40, 'hold'], [1, -40, -40]], P, labels, rings,
      bg: { draw: svg => {
        S('path', { d: 'M160 44V156M104 100H216', class: 'a-cross' }, svg);
        [['↑', 160, 38], ['→', 226, 104], ['↓', 160, 172], ['←', 94, 104]].forEach(([s, x, y]) => { const t = S('text', { x, y, 'text-anchor': 'middle', class: 'a-arrow' }, svg); t.textContent = s; });
      } },
      ballHidden: () => true,
    };
  }

  // ---------- drill → scene map ----------
  const zone = { zone: '3x3' };
  const slalomPts = (xs, amp, y) => {
    const out = [[xs[0] - 38, y]];
    for (let i = 0; i < xs.length; i++) out.push([xs[i], y + (i % 2 ? amp : -amp)]);
    out.push([xs[xs.length - 1] + 30, y]);
    for (let i = xs.length - 1; i >= 0; i--) out.push([xs[i], y + (i % 2 ? -amp : amp)]);
    return out;
  };
  const turnPts = (x0, x1, y, w) => [[x0 - 12, y], [x0, y - w], [(x0 + x1) / 2, y - w - 1], [x1, y - w], [x1 + 12, y], [x1, y + w], [(x0 + x1) / 2, y + w + 1], [x0, y + w]];

  const SCENES = {
    // Ball mastery
    'ball-mastery-ghost-ball': () => soleTaps({ ghost: true }),
    'ball-mastery-sole-taps': () => soleTaps(),
    'ball-mastery-sole-rolls': () => soleRolls(),
    'ball-mastery-foundation-touches': () => pingPong({ fast: true }),
    'ball-mastery-clock-taps': () => clockTaps(),
    'ball-mastery-inside-ping-pong': () => pingPong(),
    'ball-mastery-sole-pull-push': () => pullPush(),
    'ball-mastery-inside-outside-rhythm': () => insideOutside(),
    'ball-mastery-figure-eight': () => figureEight(),
    'ball-mastery-turn-and-go': () => ({ view: 'path', pts: turnPts(56, 262, 100, 7), segs: [[0.5, 1], [0.5, 0.18, 'sole'], [1, 1], [1, 0.18, 'sole']] }),
    'ball-mastery-slow-fast-stop': () => ({ view: 'path', pts: turnPts(34, 286, 100, 7), segs: [[0.14, 0.34, 'slow', 'lin'], [0.34, 0.14, 'fast', 'lin'], [0.47, 0.3, 'slow'], [0.47, 0.18, 'stop'], [0.5, 0.08], [0.64, 0.34, 'slow', 'lin'], [0.84, 0.14, 'fast', 'lin'], [0.97, 0.3, 'slow'], [0.97, 0.18, 'stop'], [1, 0.08]] }),
    'ball-mastery-look-up-touches': () => pingPong({ signal: true, noCount: true }),
    // Dribbling
    'dribbling-quick-feet-look-around': () => quickFeet(true),
    'dribbling-snail-circle': () => ({ view: 'path', bg: zone, period: 9000, pts: Array.from({ length: 12 }, (_, i) => [160 + 46 * Math.cos(i / 12 * 2 * Math.PI), 100 + 46 * Math.sin(i / 12 * 2 * Math.PI)]), touch: 14, lead: 5 }),
    'dribbling-there-and-back': () => ({ view: 'path', bg: zone, pts: turnPts(104, 216, 100, 6), segs: [[0.5, 1], [0.5, 0.25, 'sole'], [1, 1], [1, 0.25, 'sole']], touch: 16 }),
    'dribbling-freeze-and-go': () => ({ view: 'path', bg: zone, pts: [[160, 100], [198, 70], [204, 132], [124, 134], [116, 72]], segs: [['k1', 1], ['k1', 0.5, 'freeze'], ['k2', 1], ['k2', 0.5, 'freeze'], ['k3', 1], ['k3', 0.5, 'freeze'], ['k4', 1], ['k4', 0.5, 'freeze'], [1, 1], [1, 0.5, 'freeze']], touch: 18 }),
    'dribbling-five-cone-slalom': () => ({ view: 'path', period: 9000, bg: { cones: [60, 110, 160, 210, 260].map(x => [x, 100]) }, pts: slalomPts([60, 110, 160, 210, 260], 18, 100), touch: 18 }),
    'dribbling-two-foot-zigzag': () => ({ view: 'path', bg: zone, pts: [[96, 100], [118, 74], [140, 126], [162, 74], [184, 126], [206, 74], [226, 100], [206, 126], [184, 74], [162, 126], [140, 74], [118, 126]], touch: 30, period: 8000 }),
    'dribbling-sole-stop-turn': () => ({ view: 'path', bg: zone, pts: turnPts(100, 220, 100, 6), segs: [[0.5, 1], [0.5, 0.25, 'sole'], [1, 1], [1, 0.25, 'sole']], touch: 20 }),
    'dribbling-change-direction-box': () => ({ view: 'path', period: 9000, bg: { cones: [[96, 42], [224, 42], [224, 158], [96, 158]] }, pts: [[80, 26], [240, 26], [240, 174], [80, 174]], segs: [['k1', 1], ['k1', 0.25, 'outside'], ['k2', 1], ['k2', 0.25, 'sole'], ['k3', 1], ['k3', 0.25, 'any'], [1, 1], [1, 0.25, 'inside']], touch: 26 }),
    'dribbling-look-up-dribble': () => ({ view: 'path', bg: { zone: '4x4' }, period: 9000, pts: [[120, 70], [200, 60], [214, 120], [168, 142], [110, 132]], touch: 16, signal: { x: 290, y: 24, per: 3 } }),
    'dribbling-partner-finger-signal': () => ({ view: 'path', bg: { zone: '4x4' }, period: 9000, pts: [[120, 70], [196, 64], [214, 126], [150, 146], [106, 118]], touch: 16, signal: { x: 280, y: 22, per: 3, partner: true } }),
    'dribbling-tight-cone-weave': () => ({ view: 'path', period: 8000, bg: { cones: [110, 135, 160, 185, 210].map(x => [x, 100]) }, pts: slalomPts([110, 135, 160, 185, 210], 13, 100), touch: 10, lead: 5 }),
    'dribbling-speed-dash-stop': () => dashStop(),
    // Passing / first touch
    'passing-ready-shape': () => readyShape(),
    'passing-foot-to-foot': () => pingPong(),
    'passing-roll-and-stop': () => rollStop(),
    'passing-wall-inside-foot': () => wall({ dist: 3 }),
    'passing-pass-walk-stop': () => ({ view: 'path', bg: zone, pts: turnPts(104, 216, 100, 6), touch: 34, lead: 20, segs: [[0.5, 1, null, 'lin'], [0.5, 0.2, 'stop'], [1, 1, null, 'lin'], [1, 0.2, 'stop']] }),
    'passing-roll-receive-redirect': () => redirect(),
    'passing-wall-first-touch-gate': () => wall({ dist: 3, gate: 'L' }),
    'passing-wall-alternate-feet': () => wall({ dist: 3, feet: 'alt' }),
    'passing-two-touch-self': () => twoTouchSelf(),
    'passing-wall-two-touch-tempo': () => wall({ dist: 4, two: true }),
    'passing-wall-target': () => wall({ dist: 4, target: true }),
    'passing-partner-pass-and-stop': () => partner(),
    // Weak foot
    'weak-foot-air-swings': () => airSwings(),
    'weak-foot-sole-drag': () => soleDrag(),
    'weak-foot-fifty-touches': () => ({ view: 'path', bg: zone, pts: turnPts(100, 220, 100, 6), weak: 'all', touch: 16, segs: [[0.5, 1], [0.5, 0.2, 'sole'], [1, 1], [1, 0.2, 'sole']], count: 50 }),
    'weak-foot-roll-and-stop': () => rollStop({ stop: 'sole', weak: true }),
    'weak-foot-wall-taps': () => wall({ dist: 2, feet: 'W', weak: true }),
    'weak-foot-inside-outside-walk': () => insideOutside({ weak: true }),
    'weak-foot-wall-ladder': () => wall({ ladder: true, feet: 'W', weak: true }),
    'weak-foot-circle-dribble': () => ({ view: 'path', bg: zone, period: 8000, pts: Array.from({ length: 12 }, (_, i) => [160 + 50 * Math.cos(i / 12 * 2 * Math.PI), 100 + 50 * Math.sin(i / 12 * 2 * Math.PI)]), weak: 'all', touch: 16 }),
    'weak-foot-wall-return-stop': () => wall({ dist: 3, feet: 'W', weak: true, stop: 'sole' }),
    'weak-foot-receive-and-exit': () => wall({ dist: 4, feet: 'W', weak: true, gate: 'alt' }),
    'weak-foot-partner-pass-and-stop': () => partner({ weak: true, sole: true }),
    'weak-foot-jog-and-switch': () => ({ view: 'path', period: 9000, pts: turnPts(30, 290, 100, 8), weak: 'switch', touch: 20 }),
    // Juggling & coordination
    'juggling-stork-stand': () => stork(),
    'juggling-drum-roll-feet': () => quickFeet(false),
    'juggling-drop-bounce-catch': () => dropBounceCatch(),
    'juggling-bounce-juggle': () => bounceJuggle(),
    'juggling-lift-and-catch': () => liftCatch(1),
    'juggling-touch-catch-reset': () => liftCatch(2),
    'juggling-ladder-3-5-7': () => juggle(['R', 'L', 'R'], { label: 'ladder' }),
    'juggling-knee-touch-march': () => kneeMarch(),
    'juggling-hop-and-freeze': () => hopFreeze(),
    'juggling-step-compass': () => compass(),
    'juggling-alternating-feet': () => juggle(['R', 'L']),
    'juggling-thigh-and-foot': () => juggle(['R', 'T', 'R'], { h: 34 }),
  };
  const FALLBACK = {
    'ball-mastery': 'ball-mastery-inside-ping-pong', 'dribbling': 'dribbling-five-cone-slalom', 'passing-first-touch': 'passing-wall-inside-foot',
    'weak-foot': 'weak-foot-sole-drag', 'juggling-coordination': 'juggling-alternating-feet',
  };

  // ---------- runtime ----------
  const live = new Set();
  let raf = 0;
  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => { if (e.target.__fc) e.target.__fc.visible = e.isIntersecting; }), { rootMargin: '60px' }) : null;

  function loop(now) {
    raf = 0;
    for (const a of live) {
      if (!a.el.isConnected) { live.delete(a); if (io) io.unobserve(a.el); continue; }
      if (!a.visible || a.paused) { a.last = now; continue; }
      a.time += (now - (a.last || now)) * a.speed;
      a.last = now;
      a.draw(a.time);
    }
    if (live.size) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf && live.size) raf = requestAnimationFrame(loop); }

  function mount(el, slug, opts) {
    opts = opts || {};
    const make = SCENES[slug] || SCENES[FALLBACK[opts.track] || 'ball-mastery-inside-ping-pong'];
    const spec = make();
    el.innerHTML = '';
    const vb = VB[spec.view] || [0, 0, W, H];
    const svg = S('svg', { viewBox: vb.join(' '), class: 'fc-anim-svg', role: 'img', 'aria-label': opts.alt || slug, preserveAspectRatio: 'xMidYMid slice' });
    svg.__vb = vb;
    el.appendChild(svg);
    const upd = spec.view === 'side' ? renderSide(svg, spec) : spec.view === 'feet' ? renderFeet(svg, spec) : spec.view === 'path' ? renderPath(svg, spec) : renderKf(svg, spec);
    const period = spec.period || 6000;
    const inst = {
      el, period, speed: 1, time: (opts.offset || 0) * period, last: 0, visible: !io, paused: !!(reduced.matches && !opts.autoplay),
      draw(ms) { const x = ms / period; upd(frac(x), Math.floor(x)); },
      toggle() { this.paused = !this.paused; kick(); return !this.paused; },
      setSpeed(s) { this.speed = s; },
    };
    el.__fc = inst;
    inst.draw(inst.time || period * 0.3);
    if (io) io.observe(el);
    live.add(inst);
    kick();
    return inst;
  }

  window.FCAnim = { mount, has: slug => !!SCENES[slug], setLabels(fn) { labelFn = fn; } };
})();
