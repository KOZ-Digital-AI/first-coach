/* FIRST COACH v0.1 — app shell, routing and views. No framework, no build step, no server.
 * Everything a player does is stored in this browser only (localStorage).
 */
(function () {
  'use strict';

  const D = window.FC_DATA, I = window.FC_I18N;
  const TR = D.tracks, TSLUGS = TR.map(x => x.slug);
  const DRILLS = D.drills, BY = new Map(DRILLS.map(d => [d.slug, d]));
  const TESTS = D.tests, RUB = new Map(D.rubrics.map(r => [r.skill, r]));
  const app = document.getElementById('app');
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Where coaches' drills are sent. Leave empty to offer Share / Copy only.
  const CONTACT_EMAIL = 'work@koz-ai.com';

  // ---------- storage ----------
  // G holds what the device shares (language, players, coaches' drills); st holds the signed-in player's own data.
  const OLD_KEY = 'first-coach-lite:v1', GKEY = 'first-coach:global', PKEY = id => 'first-coach:p:' + id;
  const DEF = { profile: null, levels: null, xp: {}, sessions: [], current: null, tests: [], seq: 0, last: null, planStart: null };
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable: app still works for this visit */ } };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let G = Object.assign({ lang: null, profiles: [], current: null, contrib: [], lib: {} }, read(GKEY) || {});
  (function migrate() {
    const old = read(OLD_KEY);
    if (!old) return;
    G.lang = G.lang || old.lang || null;
    G.contrib = (G.contrib || []).concat(old.contrib || []);
    if (old.profile && !G.profiles.length) {
      const id = uid(), data = {};
      Object.keys(DEF).forEach(k => { if (old[k] !== undefined) data[k] = old[k]; });
      G.profiles.push({ id, name: '', avatar: 0, color: 0, pin: null, createdAt: new Date().toISOString() });
      write(PKEY(id), data);
      G.current = id;
    }
    write(GKEY, G);
    try { localStorage.removeItem(OLD_KEY); } catch (e) { /* ignore */ }
  })();
  const me = () => G.profiles.find(p => p.id === G.current) || null;
  let st = Object.assign({}, DEF, (me() && read(PKEY(G.current))) || {});
  const save = () => { write(GKEY, G); if (me()) write(PKEY(G.current), st); };

  // ---------- i18n ----------
  const detect = () => { const n = (navigator.language || 'ru').toLowerCase(); return n.startsWith('kk') ? 'kk' : n.startsWith('en') ? 'en' : 'ru'; };
  let lang = G.lang || detect();
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function t(path, vars) {
    let s = get(I[lang], path);
    if (s == null) s = get(I.ru, path);
    if (s == null) return path;
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
    return s;
  }
  const L = o => (o ? (o[lang] || o.ru || o.en || '') : '');
  // Word form after a number: Russian has three forms, English two, Kazakh one.
  function pl(path, n) {
    const f = t(path);
    if (!Array.isArray(f)) return f;
    if (lang === 'ru') { const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2] || f[f.length - 1]; }
    if (lang === 'en') return f[n === 1 ? 0 : 1] || f[0];
    return f[0];
  }
  const trackOf = slug => TR.find(x => x.slug === slug);
  const trackName = slug => { const x = trackOf(slug); return x ? L(x.names) : slug; };
  window.FCAnim.setLabels(k => t('anim.' + k));

  // ---------- dates ----------
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const today = () => ymd(new Date());
  const fmtDate = s => { try { return new Date(s + 'T12:00:00').toLocaleDateString(lang === 'kk' ? 'kk-KZ' : lang === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' }); } catch (e) { return s; } };

  // ---------- drills ----------
  const custom = () => G.contrib.filter(c => c.status === 'approved').map(c => ({
    slug: 'c-' + c.id, custom: true, track: c.skill, level: +c.level || 1, minutes: +c.minutes || 5, equipment: c.equipment || 'ball',
    space: 'home_3x3', partner: false, ageMin: 5, ageMax: 99,
    title: { kk: c.title, ru: c.title, en: c.title }, goal: { kk: c.goal, ru: c.goal, en: c.goal },
    instructions: { kk: c.instructions, ru: c.instructions, en: c.instructions },
    mistakes: c.mistakes ? [{ kk: c.mistakes, ru: c.mistakes, en: c.mistakes }] : [], safety: c.safety ? [{ kk: c.safety, ru: c.safety, en: c.safety }] : [],
    dose: {}, progressionSlugs: [], regressionSlugs: [], author: c.author, source: c.source || 'Community', license: 'CC-BY-SA-4.0', semver: '1.0.0', status: c.verify || 'COMMUNITY',
  }));
  const drill = slug => BY.get(slug) || custom().find(d => d.slug === slug);
  const allDrills = () => DRILLS.concat(custom());
  const SPACE = { home_3x3: 0, yard: 1, field: 2 };
  const eqOK = (d, p) => d.equipment === 'nothing' || (p.ball && (d.equipment === 'ball' || (d.equipment === 'ball_wall' && p.wall) || (d.equipment === 'cones' && p.cones)));
  const fits = (d, p) => eqOK(d, p) && SPACE[d.space] <= SPACE[p.space] && (!d.partner || p.partner) && p.age >= d.ageMin && p.age <= d.ageMax;
  const targetLevel = lv => (lv <= 2 ? 1 : lv === 3 ? 2 : 3);
  const steps = txt => String(txt || '').split('\n').map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  const touchesOf = d => (!d || d.equipment === 'nothing') ? 0 : (d.dose.reps || Math.round((d.dose.durationSec || 30) * 1.2)) * (d.dose.sets || 1);
  function doseText(d) {
    const x = d.dose || {};
    if (x.durationSec) return t('s.time', { s: x.sets || 1, sec: x.durationSec });
    if (x.reps && x.sets > 1) return t('s.sets', { s: x.sets, r: x.reps });
    if (x.reps) return t('s.reps', { r: x.reps });
    return d.minutes + ' ' + t('d.min');
  }
  const hash01 = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

  // ---------- plan & session logic ----------
  const DEF_PROFILE = { age: 10, goal: 'ball-mastery', ball: true, wall: false, cones: false, partner: false, space: 'home_3x3', days: 3, minutes: 20 };
  function focusTracks() {
    const p = st.profile, lv = st.levels;
    const rest = TSLUGS.filter(s => s !== p.goal).sort((a, b) => lv[a] - lv[b] || TSLUGS.indexOf(a) - TSLUGS.indexOf(b));
    return [p.goal, rest[0], rest[1]];
  }
  function candidates(track, p, lv) {
    const tl = targetLevel(lv[track]);
    let c = allDrills().filter(d => d.track === track && fits(d, p) && d.level <= tl).sort((a, b) => b.level - a.level || a.minutes - b.minutes);
    if (p.ball) c = c.filter(d => d.equipment !== 'nothing').concat(c.filter(d => d.equipment === 'nothing'));
    return c;
  }
  function buildSession() {
    const p = st.profile, lv = st.levels, seq = st.seq || 0, budget = p.minutes;
    const items = [], used = new Set();
    let total = 0;
    const add = (d, role) => { items.push({ slug: d.slug, role }); used.add(d.slug); total += d.minutes; };
    if (budget >= 15) {
      const warm = DRILLS.filter(d => d.equipment === 'nothing' && fits(d, p) && d.level <= targetLevel(lv[d.track]) && d.minutes <= 4);
      if (warm.length) add(warm[seq % warm.length], 'warmup');
    }
    const [g, w1, w2] = focusTracks();
    const order = [g, w1, g, w2, w1, g, w2, w1, g, w2];
    const turn = {};
    for (const tr of order) {
      if (total >= budget - 1) break;
      const c = candidates(tr, p, lv).filter(d => !used.has(d.slug));
      if (!c.length) continue;
      const top = c.filter(d => d.level === c[0].level);
      turn[tr] = (turn[tr] || 0) + 1;
      const first = top[(seq + turn[tr] - 1) % top.length];
      const pick = [first].concat(c).find(d => total + d.minutes <= budget + 2);
      if (pick) add(pick, tr === g ? 'goal' : 'weak');
    }
    if (!items.length) {
      const any = allDrills().filter(d => fits(d, p)).sort((a, b) => a.level - b.level)[0];
      if (any) add(any, 'goal');
    }
    return { id: Date.now(), seq, date: today(), items, done: {}, ratings: {}, changes: {} };
  }
  function ensureSession() {
    if (!st.current || !st.current.items || !st.current.items.length) { st.current = buildSession(); save(); }
    return st.current;
  }
  function overall() {
    const lv = st.levels, avg = TSLUGS.reduce((a, s) => a + lv[s], 0) / TSLUGS.length;
    return avg < 1.8 ? 0 : avg < 2.8 ? 1 : avg < 3.8 ? 2 : 3;
  }
  function streak() {
    const days = new Set(st.sessions.map(s => s.date)), d = new Date();
    let n = 0;
    if (!days.has(ymd(d))) d.setDate(d.getDate() - 1);
    while (days.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function badges() {
    const S = st.sessions, days = new Set(S.map(s => s.date)).size;
    const touches = S.reduce((a, s) => a + s.drills.reduce((b, sl) => b + touchesOf(BY.get(sl)), 0), 0);
    const weakDone = S.some(s => s.drills.some(sl => (BY.get(sl) || {}).track === 'weak-foot'));
    return {
      first: S.length >= 1, streak3: streak() >= 3, d10: days >= 10, t1000: touches >= 1000,
      test: st.tests.length >= 1, weak2: weakDone && !!st.levels && st.levels['weak-foot'] >= 2,
    };
  }

  // ---------- small UI helpers ----------
  function toast(msg) {
    const old = $('.toast'); if (old) old.remove();
    const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
  }
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.createElement('div'); box.className = 'confetti';
    const cols = ['#2e7d53', '#df8a1d', '#f07b2a', '#3b62a8', '#101815', '#52b883'];
    for (let i = 0; i < 70; i++) {
      const c = document.createElement('i');
      c.style.left = Math.random() * 100 + '%'; c.style.background = cols[i % cols.length];
      c.style.animationDelay = Math.random() * 0.6 + 's'; c.style.animationDuration = 1.4 + Math.random() * 1.2 + 's';
      box.appendChild(c);
    }
    document.body.appendChild(box); setTimeout(() => box.remove(), 3200);
  }
  let audio = null;
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate([180, 80, 180]); } catch (e) { /* no vibration */ }
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.22].forEach(off => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.0001, audio.currentTime + off); g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + off + 0.18);
        o.start(audio.currentTime + off); o.stop(audio.currentTime + off + 0.2);
      });
    } catch (e) { /* no audio */ }
  }
  const tag = (txt, cls) => `<span class="tag ${cls || ''}">${esc(txt)}</span>`;
  function metaTags(d) {
    return tag(trackName(d.track), 'tag-accent') + tag(t('d.level') + ' ' + d.level) + tag(d.minutes + ' ' + t('d.min')) + tag(t('d.eq.' + d.equipment))
      + (d.partner ? tag(t('d.partner'), 'tag-warn') : '');
  }
  const animBox = (d, ctrl) => `<div class="anim-wrap" style="position:relative"><div class="anim" data-anim="${esc(d.slug)}" data-track="${esc(d.track)}" aria-label="${esc(L(d.title))}"></div>${ctrl ? `<div class="anim-ctrl"><button type="button" data-act="animSlow" aria-pressed="false">0.5×</button><button type="button" data-act="animPause" aria-pressed="false" aria-label="${esc(t('s.pause'))}">❚❚</button></div>` : ''}</div>`;
  const dcard = d => `<a class="dcard" href="#/drill/${esc(d.slug)}">${animBox(d)}<h3>${esc(L(d.title))}</h3><div class="meta">${tag(trackName(d.track), 'tag-accent')}${tag(t('d.level') + ' ' + d.level)}${tag(d.minutes + ' ' + t('d.min'))}</div></a>`;
  const ICON = {
    train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l3.8 2.8-1.5 4.4H9.7l-1.5-4.4z"/></svg>',
    library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
    tests: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 13V9M9.5 2.5h5M19 6l-1.5 1.5"/></svg>',
    progress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16M6 15l4-4 3 3 5-6"/></svg>',
  };

  // ---------- views ----------
  const SHOWCASE = ['juggling-alternating-feet', 'ball-mastery-inside-ping-pong', 'dribbling-five-cone-slalom', 'passing-wall-inside-foot', 'ball-mastery-sole-pull-push', 'juggling-drop-bounce-catch'];
  let showTimer = null, showIdx = 0;
  function startShowcase() {
    const box = $('#showcase'); if (!box) return;
    const paint = () => {
      const d = BY.get(SHOWCASE[showIdx % SHOWCASE.length]);
      const el = $('#showAnim'); if (!el || !d) return;
      window.FCAnim.mount(el, d.slug, { track: d.track, alt: L(d.title), autoplay: true });
      $('#showTitle').textContent = L(d.title);
      $('#showTrack').textContent = trackName(d.track);
      $('#showLink').setAttribute('href', '#/drill/' + d.slug);
      $$('#showDots i').forEach((x, i) => x.classList.toggle('on', i === showIdx % SHOWCASE.length));
    };
    paint();
    showTimer = setInterval(() => { showIdx++; paint(); }, 6500);
  }
  function viewHome() {
    const has = !!(me() && st.profile);
    const count = f => DRILLS.filter(f).length;
    const kit = [
      count(d => d.equipment === 'nothing'),
      count(d => d.equipment === 'nothing' || d.equipment === 'ball'),
      count(d => d.equipment !== 'cones'),
      DRILLS.length,
    ];
    after(startShowcase);
    return `
    <section class="hero">
      <div class="stack" style="gap:18px">
        <div class="eyebrow">${esc(t('home.eyebrow'))}</div>
        <h1 class="h1">${esc(t('home.headline'))}</h1>
        <p class="lead">${esc(t('home.intro'))}</p>
        <div class="cta">
          <a class="btn btn-primary" href="#/plan">${esc(has ? t('home.continue') : t('home.start'))} →</a>
          <a class="btn btn-secondary" href="#/library">${esc(t('home.browse'))}</a>
        </div>
        <ul class="facts">${t('home.facts').map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <aside class="card-ink hero-card on-ink" id="showcase" aria-live="polite">
        <span class="label">${esc(t('home.demoLabel'))}</span>
        <div class="anim-wrap" style="position:relative"><div class="anim" id="showAnim"></div></div>
        <a class="show-cap" id="showLink" href="#/library"><span class="tag tag-accent" id="showTrack"></span><b id="showTitle"></b></a>
        <div class="dots-row" id="showDots" aria-hidden="true">${SHOWCASE.map(() => '<i></i>').join('')}</div>
      </aside>
    </section>

    <section class="section">
      <h2 class="h2">${esc(t('home.howTitle'))}</h2>
      <ol class="flow" style="padding:0">${t('home.steps').map(s => `<li><div><b>${esc(s[0])}</b><span>${esc(s[1])}</span></div></li>`).join('')}</ol>
    </section>

    <section class="section">
      <h2 class="h2">${esc(t('home.skillsTitle'))}</h2>
      <p class="lead" style="margin-top:12px">${esc(t('home.skillsBody'))}</p>
      <div class="skills">${TR.map(x => `<button type="button" class="skill-card" data-act="libTrack" data-v="${x.slug}"><span class="skill-name">${esc(L(x.names))}</span><span class="muted small">${esc(L((x.outcomes || [])[0]))}</span><span class="tag">${esc(t('home.drillsN', { n: DRILLS.filter(d => d.track === x.slug).length }))}</span></button>`).join('')}</div>
    </section>

    <section class="section">
      <h2 class="h2">${esc(t('home.kitTitle'))}</h2>
      <p class="lead" style="margin-top:12px">${esc(t('home.kitBody'))}</p>
      <div class="kit">${kit.map((n, i) => `<div><b>${n}</b><span>${esc(t('home.kit')[i])}</span></div>`).join('')}</div>
    </section>

    <section class="section two">
      <div class="stack"><h2 class="h2">${esc(t('home.safeTitle'))}</h2><ul class="privacy">${t('home.safe').map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="card stack coach">
        <h2 class="h3">${esc(t('home.coachTitle'))}</h2>
        <p class="muted" style="margin:0">${esc(t('home.coachBody'))}</p>
        <a class="btn btn-primary" href="#/contribute" style="align-self:flex-start">${esc(t('home.coachCta'))} →</a>
        <p class="small muted" style="margin:0">${esc(t('home.honest'))}</p>
      </div>
    </section>`;
  }

  // --- onboarding ---
  let ob = null;
  function viewStart(arg) {
    if (!ob) ob = { p: Object.assign({}, DEF_PROFILE, st.profile || {}), lv: Object.assign({}, ...TSLUGS.map(s => ({ [s]: 1 })), st.levels || {}), step: 0 };
    if (arg !== '' && arg != null && !isNaN(+arg)) { ob.step = +arg; history.replaceState(null, '', '#/start'); }
    const N = 5, p = ob.p, s = ob.step;
    const pressed = v => `aria-pressed="${v ? 'true' : 'false'}"`;
    let body = '';
    if (s === 0) {
      const ages = [[6, '5–7'], [8, '8–9'], [10, '10–11'], [12, '12–13'], [15, '14–17'], [20, '18+']];
      body = `<h2 class="h2">${esc(t('ob.ageQ'))}</h2><div class="options">${ages.map(([v, l]) => `<button type="button" class="option" data-act="obSet" data-k="age" data-v="${v}" ${pressed(p.age === v)}><b>${l}</b></button>`).join('')}</div>`;
    } else if (s === 1) {
      body = `<h2 class="h2">${esc(t('ob.goalQ'))}</h2><div class="options">${TR.map(x => `<button type="button" class="option" data-act="obSet" data-k="goal" data-v="${x.slug}" ${pressed(p.goal === x.slug)}><b>${esc(L(x.names))}</b><span>${esc(L((x.outcomes || [])[0]))}</span></button>`).join('')}</div>`;
    } else if (s === 2) {
      const n = DRILLS.filter(d => fits(d, p)).length;
      body = `<h2 class="h2">${esc(t('ob.kitQ'))}</h2><p class="muted" style="margin:0">${esc(t('ob.kitHint'))}</p>
        <div class="options">${['ball', 'wall', 'cones', 'partner'].map(k => `<button type="button" class="option" data-act="obToggle" data-k="${k}" ${pressed(p[k])}><b>${esc(t('ob.kit.' + k))}</b></button>`).join('')}</div>
        <h3 class="h3">${esc(t('ob.spaceQ'))}</h3>
        <div class="options">${['home_3x3', 'yard', 'field'].map(k => `<button type="button" class="option" data-act="obSet" data-k="space" data-v="${k}" ${pressed(p.space === k)}><b>${esc(t('ob.space.' + k))}</b></button>`).join('')}</div>
        <p class="notice">${esc(t('ob.fit', { n }))}</p>`;
    } else if (s === 3) {
      body = `<h2 class="h2">${esc(t('ob.timeQ'))}</h2>
        <h3 class="h3">${esc(t('ob.days'))}</h3><div class="chips">${[2, 3, 4, 5].map(v => `<button type="button" class="chip" data-act="obSet" data-k="days" data-v="${v}" ${pressed(p.days === v)}>${v}</button>`).join('')}</div>
        <h3 class="h3">${esc(t('ob.minutes'))}</h3><div class="chips">${[10, 15, 20, 30].map(v => `<button type="button" class="chip" data-act="obSet" data-k="minutes" data-v="${v}" ${pressed(p.minutes === v)}>${v} ${esc(t('d.min'))}</button>`).join('')}</div>`;
    } else {
      body = `<h2 class="h2">${esc(t('ob.baseQ'))}</h2><p class="muted" style="margin:0">${esc(t('ob.baseHint'))}</p>
        <div class="baseline">${TR.map(x => {
          const v = ob.lv[x.slug];
          return `<div class="bl"><div class="bl-top"><b>${esc(L(x.names))}</b><span class="tag tag-accent">${esc(t('ob.lvl'))} ${v}/5</span></div>
            <div class="seg" role="group" aria-label="${esc(L(x.names))}">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-act="obLevel" data-k="${x.slug}" data-v="${i}" ${pressed(i === v)} class="${i < v ? 'below' : ''}">${i}</button>`).join('')}</div>
            <p>${esc(L(x.levels[v - 1]))}</p></div>`;
        }).join('')}</div>`;
    }
    return `<div class="wizard">
      <div class="stack" style="gap:8px"><div class="eyebrow">${esc(t('ob.eyebrow'))}</div><h1 class="h2">${esc(t('ob.title'))}</h1></div>
      <div class="bar" aria-hidden="true">${Array.from({ length: N }, (_, i) => `<span class="${i <= s ? 'on' : ''}"></span>`).join('')}</div>
      <div class="small muted">${esc(t('ob.step', { n: s + 1, t: N }))}</div>
      <div class="panel">${body}</div>
      <div class="actions">
        ${s > 0 ? `<button type="button" class="btn btn-secondary" data-act="obBack">← ${esc(t('ob.back'))}</button>` : '<span></span>'}
        ${s < N - 1 ? `<button type="button" class="btn btn-primary" data-act="obNext">${esc(t('ob.next'))} →</button>` : `<button type="button" class="btn btn-accent" data-act="obBuild">${esc(t('ob.build'))} →</button>`}
      </div></div>`;
  }

  // --- plan ---
  const times = d => (lang === 'ru' ? d + (d >= 2 && d <= 4 ? ' раза' : ' раз') : d);
  const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
  function viewPlan() {
    if (!st.profile) { location.replace('#/start'); return ''; }
    const cur = ensureSession(), p = st.profile, lv = st.levels, [g, w1, w2] = focusTracks();
    const items = cur.items.map(i => ({ i, d: drill(i.slug) })).filter(x => x.d);
    const mins = items.reduce((a, x) => a + x.d.minutes, 0);
    const roleTag = r => r === 'warmup' ? tag(t('plan.warmup')) : '';
    const start = st.planStart || (st.sessions[0] && st.sessions[0].date) || today();
    const day = dayDiff(start, today()), week = Math.min(4, Math.floor(day / 7) + 1);
    const perWeek = [0, 0, 0, 0];
    st.sessions.forEach(x => { const w = Math.floor(dayDiff(start, x.date) / 7); if (w >= 0 && w < 4) perWeek[w]++; });
    const trainedToday = st.sessions.some(x => x.date === today()) && !Object.keys(cur.done).length;
    const cycleDone = day >= 28;
    return `<div class="page-head"><div class="eyebrow">${esc(t('auth.hello', { name: nameOf(me()) }))}</div><h1 class="h1">${esc(t('plan.title'))}</h1></div>
    <div class="plan">
      <div class="card stack plan-today">
        ${cycleDone ? `<p class="notice" style="margin:0">${esc(t('plan.cycleDone'))} <a href="#/tests">${esc(t('nav.tests'))} →</a></p>` : trainedToday ? `<p class="notice" style="margin:0">${esc(t('plan.restToday'))}</p>` : ''}
        <div class="row between"><h2 class="h3">${esc(t('plan.today'))}</h2>${tag(t('plan.sessionNo', { n: (st.sessions.length || 0) + 1 }))}</div>
        <p class="muted" style="margin:0">${esc(t('plan.total', { m: mins, k: items.length }))}</p>
        <a class="btn btn-primary btn-block" href="#/session">▶ ${esc(t('plan.start'))}</a>
        <div class="session-list">${items.map(({ i, d }) => `<a class="srow ${cur.done[i.slug] ? 'done' : ''}" href="#/drill/${esc(d.slug)}">${animBox(d)}<div><h4>${cur.done[i.slug] ? '✓ ' : ''}${esc(L(d.title))}</h4><div class="meta">${roleTag(i.role)}${tag(trackName(d.track), 'tag-accent')}${tag(d.minutes + ' ' + t('d.min'))}</div></div></a>`).join('')}</div>
      </div>
      <div class="stack plan-side">
        <div class="card-ink stack on-ink" style="gap:12px">
          <span class="small" style="color:var(--on-ink-muted);font-weight:800;letter-spacing:.1em;text-transform:uppercase">${esc(t('plan.level'))}</span>
          <div class="big-level">${esc(t('plan.levels')[overall()])}</div>
          <div class="small" style="color:var(--on-ink-muted)">${esc(t('plan.goal'))}: <b style="color:var(--on-ink)">${esc(trackName(p.goal))}</b> · ${esc(t('plan.schedule', { d: times(p.days), m: p.minutes }))}</div>
          <div class="weeks">${[0, 1, 2, 3].map(w => `<div class="${w + 1 === week && !cycleDone ? 'cur' : ''}"><span>${esc(t('plan.week', { n: w + 1 }))}</span><div class="wdots">${Array.from({ length: p.days }, (_, k) => `<i class="${k < perWeek[w] ? 'on' : ''}"></i>`).join('')}</div></div>`).join('')}</div>
          <div class="small" style="color:var(--on-ink-muted)">${esc(t('plan.weekOf', { n: week }))} · ${esc(t('plan.weekProgress', { d: perWeek[week - 1], t: p.days }))}</div>
        </div>
        <div class="card stack">
          <h3 class="h3">${esc(t('plan.skill'))}</h3>
          <div class="levels">${TSLUGS.map(s => `<div class="lvl"><span><b>${esc(trackName(s))}</b> ${s === g ? tag(t('plan.goalTag'), 'tag-accent') : (s === w1 || s === w2) ? tag(t('plan.weakTag'), 'tag-warn') : ''}</span><span class="small muted">${lv[s]}/5</span>
            <div class="pips">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= lv[s] ? 'on' : ''}"></i>`).join('')}</div></div>`).join('')}</div>
        </div>
        <div class="row"><a class="btn btn-secondary btn-sm" href="#/tests">${esc(t('plan.test'))}</a><a class="btn btn-ghost btn-sm" href="#/start">${esc(t('plan.edit'))}</a>${cycleDone ? `<button type="button" class="btn btn-ghost btn-sm" data-act="newPlan">${esc(t('plan.newPlan'))}</button>` : ''}</div>
      </div>
    </div>`;
  }

  // --- session player ---
  let sets = {}, timer = null;
  function stopTimer() { if (timer && timer.iv) clearInterval(timer.iv); timer = null; }
  const drillHead = d => `<h1 class="h2">${esc(L(d.title))}</h1><p class="lead">${esc(L(d.goal))}</p>`;
  function drillBody(d) {
    return `<div class="card stack"><h2 class="h3">${esc(t('s.how'))}</h2><ol class="steps">${steps(L(d.instructions)).map(x => `<li><span>${esc(x)}</span></li>`).join('')}</ol></div>
      ${d.mistakes && d.mistakes.length ? `<details class="fold" open><summary>${esc(t('s.mistakes'))}</summary><ul>${d.mistakes.map(m => `<li>${esc(L(m))}</li>`).join('')}</ul></details>` : ''}
      ${d.safety && d.safety.length ? `<details class="fold"><summary>${esc(t('s.safety'))}</summary><ul>${d.safety.map(m => `<li>${esc(L(m))}</li>`).join('')}</ul></details>` : ''}`;
  }
  function timerCard(d) {
    const x = d.dose || {}, n = x.sets || 1, C = 2 * Math.PI * 48;
    return `<div class="card stack">
      <div class="dose"><b>${esc(doseText(d))}</b>${tag(d.minutes + ' ' + t('d.min'))}</div>
      <div class="timer">
        <div class="ring" id="ring"><svg viewBox="0 0 112 112"><circle class="track" cx="56" cy="56" r="48"/><circle class="prog" cx="56" cy="56" r="48" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="0"/></svg><div class="num" id="ringNum">0:00</div></div>
        <div class="stack" style="gap:8px"><span class="small muted">${esc(x.durationSec ? t('s.timerSet') : t('s.timerAll'))}</span>
          <div class="row"><button type="button" class="btn btn-primary btn-sm" data-act="timer" id="timerBtn">▶ ${esc(t('s.start'))}</button><button type="button" class="btn btn-ghost btn-sm" data-act="timerReset">↺ ${esc(t('s.reset'))}</button></div></div>
      </div>
      ${n > 1 ? `<div class="stack" style="gap:6px"><span class="small muted">${esc(t('s.setsDone'))}</span><div class="sets">${Array.from({ length: n }, (_, i) => `<button type="button" data-act="set" data-v="${i}" aria-pressed="${sets[d.slug] && sets[d.slug][i] ? 'true' : 'false'}">${i + 1}</button>`).join('')}</div></div>` : ''}
    </div>`;
  }
  function initTimer(d) {
    stopTimer();
    const perSet = !!(d.dose && d.dose.durationSec);
    const total = perSet ? d.dose.durationSec : d.minutes * 60;
    timer = { total, left: total, iv: null, slug: d.slug, perSet };
    paintTimer();
  }
  function paintTimer() {
    const num = $('#ringNum'), prog = $('#ring .prog'), btn = $('#timerBtn');
    if (!num || !timer) return;
    const C = 2 * Math.PI * 48, s = Math.max(0, Math.ceil(timer.left));
    num.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    prog.style.strokeDashoffset = (C * (1 - timer.left / timer.total)).toFixed(1);
    btn.textContent = (timer.iv ? '❚❚ ' + t('s.pause') : '▶ ' + t('s.start'));
  }
  function toggleTimer() {
    if (!timer) return;
    if (timer.iv) { clearInterval(timer.iv); timer.iv = null; paintTimer(); return; }
    if (timer.left <= 0) timer.left = timer.total;
    let last = Date.now();
    timer.iv = setInterval(() => {
      const now = Date.now(); timer.left -= (now - last) / 1000; last = now;
      if (timer.left <= 0) {
        timer.left = 0; clearInterval(timer.iv); timer.iv = null; beep();
        if (timer.perSet) {
          const b = $$('.sets button').find(x => x.getAttribute('aria-pressed') !== 'true');
          if (b) b.click();
        }
      }
      paintTimer();
    }, 200);
    paintTimer();
  }

  function viewSession() {
    if (!st.profile) { location.replace('#/start'); return ''; }
    const cur = ensureSession();
    const idx = cur.items.findIndex(i => !cur.done[i.slug]);
    if (idx < 0) { finishSession(); return ''; }
    const item = cur.items[idx], d = drill(item.slug);
    if (!d) { cur.done[item.slug] = true; save(); return viewSession(); }
    const canEasier = (d.regressionSlugs || []).some(s => BY.get(s) && eqOK(BY.get(s), st.profile));
    const canHarder = (d.progressionSlugs || []).some(s => BY.get(s) && eqOK(BY.get(s), st.profile));
    after(() => initTimer(d));
    return `<div class="player">
      <div class="player-top"><a class="btn btn-ghost btn-sm" href="#/plan">✕ ${esc(t('s.exit'))}</a>
        <div class="dots">${cur.items.map((i, k) => `<i class="${cur.done[i.slug] ? 'on' : k === idx ? 'cur' : ''}"></i>`).join('')}</div>
        <span class="small muted" style="white-space:nowrap">${esc(t('s.of', { i: idx + 1, n: cur.items.length }))}</span></div>
      <div class="player-grid">
        <div class="stack pa">
          ${animBox(d, true)}
          <div class="row">${item.role === 'warmup' ? tag(t('plan.warmup')) : ''}${metaTags(d)}</div>
          ${drillHead(d)}
        </div>
        <div class="stack pb">${drillBody(d)}</div>
        <div class="player-side stack ps">
          ${timerCard(d)}
          <div class="dock"><button type="button" class="btn btn-accent btn-block" data-act="drillDone" style="min-height:58px;font-size:17px">✓ ${esc(idx === cur.items.length - 1 ? t('s.finish') : t('s.next'))}</button></div>
          ${canEasier || canHarder ? `<div class="stack" style="gap:6px"><span class="small muted">${esc(t('s.swapQ'))}</span><div class="row" style="flex-wrap:nowrap">
            <button type="button" class="btn btn-secondary btn-block btn-sm" data-act="swap" data-v="easier" ${canEasier ? '' : 'disabled'}>↓ ${esc(t('s.easier'))}</button>
            <button type="button" class="btn btn-secondary btn-block btn-sm" data-act="swap" data-v="harder" ${canHarder ? '' : 'disabled'}>↑ ${esc(t('s.harder'))}</button>
          </div></div>` : ''}
        </div>
      </div></div>`;
  }
  function openRate() {
    if ($('.sheet')) return;
    const el = document.createElement('div');
    el.className = 'sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<div><h2 class="h3" style="text-align:center">${esc(t('s.rateQ'))}</h2><p class="small muted" style="text-align:center;margin:-6px 0 0">${esc(t('s.rateHint'))}</p><div class="rate">
      <button type="button" data-act="rate" data-v="easy"><span>😀</span>${esc(t('s.easy'))}</button>
      <button type="button" data-act="rate" data-v="ok"><span>🙂</span>${esc(t('s.ok'))}</button>
      <button type="button" data-act="rate" data-v="hard"><span>😅</span>${esc(t('s.hard'))}</button></div></div>`;
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    document.body.appendChild(el);
    const first = el.querySelector('button'); if (first) first.focus();
  }
  function rateDrill(r) {
    const sheet = $('.sheet'); if (sheet) sheet.remove();
    const cur = st.current; if (!cur) return;
    const item = cur.items.find(i => !cur.done[i.slug]); if (!item) return;
    const d = drill(item.slug);
    cur.done[item.slug] = true; cur.ratings[item.slug] = r;
    const tr = d.track;
    if (st.levels[tr] != null) {
      st.xp[tr] = (st.xp[tr] || 0) + (r === 'easy' ? 2 : r === 'ok' ? 1 : -1);
      if (st.xp[tr] >= 4 && st.levels[tr] < 5) { st.levels[tr]++; st.xp[tr] = 0; cur.changes[tr] = (cur.changes[tr] || 0) + 1; }
      else if (st.xp[tr] <= -2 && st.levels[tr] > 1) { st.levels[tr]--; st.xp[tr] = 0; cur.changes[tr] = (cur.changes[tr] || 0) - 1; }
    }
    save();
    if (cur.items.every(i => cur.done[i.slug])) finishSession(); else render(true);
  }
  function swapDrill(dir) {
    const cur = st.current, item = cur.items.find(i => !cur.done[i.slug]), d = drill(item.slug);
    const list = dir === 'easier' ? d.regressionSlugs : d.progressionSlugs;
    const next = (list || []).map(s => BY.get(s)).find(x => x && eqOK(x, st.profile) && !cur.items.some(i => i.slug === x.slug));
    if (!next) return;
    item.slug = next.slug; save(); render(true); toast(t('s.swapped'));
  }
  function finishSession() {
    const cur = st.current;
    if (!cur) { location.replace('#/done'); return; }
    const before = badges();
    const drills = cur.items.map(i => i.slug).filter(s => cur.done[s]);
    const minutes = drills.reduce((a, s) => a + ((drill(s) || {}).minutes || 0), 0);
    st.sessions.push({ date: today(), minutes, drills, ratings: cur.ratings });
    const now = badges();
    st.last = { minutes, drills: drills.length, changes: cur.changes || {}, fresh: Object.keys(now).filter(k => now[k] && !before[k]) };
    st.current = null; st.seq = (st.seq || 0) + 1;
    save();
    location.replace('#/done');
  }
  function viewDone() {
    const l = st.last;
    if (!l) { location.replace('#/plan'); return ''; }
    const ch = Object.entries(l.changes || {}).filter(([, v]) => v);
    after(confetti);
    return `<div class="fin">
      <div class="burst" aria-hidden="true">🏆</div>
      <h1 class="h1" style="font-size:clamp(34px,7vw,60px)">${esc(t('s.finTitle'))}</h1>
      <div class="fin-stats"><div><b>${l.minutes}</b><span>${esc(pl('s.finMin', l.minutes))}</span></div><div><b>${l.drills}</b><span>${esc(pl('s.finDrills', l.drills))}</span></div><div><b>${streak()}</b><span>${esc(pl('s.finStreak', streak()))}</span></div></div>
      ${l.fresh && l.fresh.length ? `<div class="stack" style="gap:8px;align-items:center"><span class="small muted">${esc(t('s.badge'))}</span><div class="row" style="justify-content:center">${l.fresh.map(k => `<span class="badge-new">★ ${esc(t('b.' + k))}</span>`).join('')}</div></div>` : ''}
      <div class="stack" style="gap:8px">${ch.length ? ch.map(([tr, v]) => `<p class="notice ${v < 0 ? 'warn' : ''}" style="margin:0">${esc(t(v > 0 ? 's.adaptUp' : 's.adaptDown', { t: trackName(tr) }))}</p>`).join('') : `<p class="notice" style="margin:0">${esc(t('s.adaptSame'))}</p>`}</div>
      <p class="muted" style="margin:0">${esc(t('s.restNote'))}</p>
      <div class="cta" style="justify-content:center"><a class="btn btn-primary" href="#/progress">${esc(t('s.toProgress'))} →</a><a class="btn btn-secondary" href="#/plan">${esc(t('s.again'))}</a></div>
    </div>`;
  }

  // --- drill detail ---
  const VERIFY = ['COMMUNITY', 'REVIEWED', 'EXPERT VERIFIED', 'ACADEMY VERIFIED'];
  function verifyTag(d) {
    const i = d.custom ? Math.max(0, VERIFY.indexOf(d.status)) : 0;
    return i > 0 ? tag(t('a.levels')[i], 'tag-accent') : tag(t('d.pending'), 'tag-warn');
  }
  function viewDrill(slug) {
    const d = drill(slug);
    if (!d) return `<div class="page-head"><p class="lead">404</p><a class="btn btn-secondary" href="#/library">${esc(t('d.back'))}</a></div>`;
    const link = s => { const x = BY.get(s); return x ? `<a class="tag tag-accent" href="#/drill/${esc(s)}" style="text-decoration:none">${esc(L(x.title))}</a>` : ''; };
    after(() => initTimer(d));
    return `<div class="player">
      <div class="player-top"><button type="button" class="btn btn-ghost btn-sm" data-act="back">← ${esc(t('d.back'))}</button></div>
      <div class="player-grid">
        <div class="stack pa">${animBox(d, true)}<div class="row">${metaTags(d)}</div>${drillHead(d)}</div>
        <div class="stack pb">${drillBody(d)}</div>
        <div class="player-side stack ps">
          ${timerCard(d)}
          <div class="card stack small">
            <div class="row between"><span class="muted">${esc(t('d.age'))}</span><b>${esc(d.ageMax >= 99 ? t('d.years', { a: d.ageMin }) : t('d.range', { a: d.ageMin, b: d.ageMax }))}</b></div>
            <div class="row between"><span class="muted">${esc(t('d.equipment'))}</span><b>${esc(t('d.eq.' + d.equipment))}</b></div>
            <div class="row between"><span class="muted">${esc(t('d.space'))}</span><b>${esc(t('d.sp.' + d.space))}</b></div>
            <div class="row between"><span class="muted">${esc(t('d.author'))}</span><b>${esc(/^FIRST COACH/i.test(d.author || '') ? t('d.team') : d.author)}</b></div>
            <div class="row between"><span class="muted">${esc(t('d.status'))}</span>${verifyTag(d)}</div>
            ${(d.regressionSlugs || []).length ? `<div class="stack" style="gap:6px"><span class="muted">↓ ${esc(t('s.easier'))}</span><div class="row">${d.regressionSlugs.map(link).join('')}</div></div>` : ''}
            ${(d.progressionSlugs || []).length ? `<div class="stack" style="gap:6px"><span class="muted">↑ ${esc(t('s.harder'))}</span><div class="row">${d.progressionSlugs.map(link).join('')}</div></div>` : ''}
          </div>
          <a class="btn btn-secondary btn-block" href="#/contribute/${esc(d.slug)}">✎ ${esc(t('d.suggest'))}</a>
        </div>
      </div></div>`;
  }

  // --- library ---
  function viewLibrary() {
    const f = Object.assign({ track: '', eq: '', lvl: 0 }, G.lib || {});
    const list = allDrills().filter(d => (!f.track || d.track === f.track) && (!f.eq || d.equipment === f.eq) && (!f.lvl || d.level === f.lvl));
    const chip = (k, v, label) => `<button type="button" class="chip" data-act="lib" data-k="${k}" data-v="${v}" aria-pressed="${String(f[k]) === String(v) ? 'true' : 'false'}">${esc(label)}</button>`;
    return `<div class="page-head"><div class="eyebrow">${esc(t('lib.eyebrow'))}</div><h1 class="h1">${esc(t('lib.title'))}</h1><p class="lead">${esc(t('lib.intro'))}</p></div>
      <div class="filters">
        <div class="chips">${chip('track', '', t('lib.all'))}${TR.map(x => chip('track', x.slug, L(x.names))).join('')}</div>
        <div class="chips">${chip('eq', '', t('lib.anyEq'))}${['nothing', 'ball', 'ball_wall', 'cones'].map(k => chip('eq', k, t('d.eq.' + k))).join('')}</div>
        <div class="chips">${chip('lvl', 0, t('lib.anyLvl'))}${[1, 2, 3].map(k => chip('lvl', k, t('d.level') + ' ' + k)).join('')}</div>
      </div>
      <p class="small muted">${esc(t('lib.count', { n: list.length }))}</p>
      ${list.length ? `<div class="grid drills">${list.map(dcard).join('')}</div>` : `<p class="notice warn">${esc(t('lib.empty'))}</p>`}`;
  }

  // --- tests ---
  const bandOf = (test, age) => age <= 9 ? test.thresholds.upTo9 : age <= 13 ? test.thresholds.from10to13 : test.thresholds.from14;
  function testLevel(test, v, age) {
    const th = bandOf(test, age);
    let lv = 1;
    th.forEach(x => { if (test.direction === 'lower' ? v <= x : v >= x) lv++; });
    return lv;
  }
  const unit = (test, n) => pl('t.units.' + test.unit, n == null ? 5 : Math.round(n));
  const hist = slug => st.tests.filter(x => x.slug === slug);
  function delta(test, a, b) {
    if (a == null || b == null || !a) return '';
    const pct = Math.round(((b - a) / a) * 100) * (test.direction === 'lower' ? -1 : 1);
    return `<span class="delta ${pct < 0 ? 'neg' : ''}">${pct > 0 ? '+' : ''}${pct}%</span>`;
  }
  function spark(vals) {
    if (vals.length < 2) return '';
    const mn = Math.min(...vals), mx = Math.max(...vals), w = 200, h = 44, pad = 5;
    const pts = vals.map((v, i) => [pad + (i / (vals.length - 1)) * (w - 2 * pad), h - pad - ((v - mn) / ((mx - mn) || 1)) * (h - 2 * pad)]);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="M${pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L')}"/><circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="3.5"/></svg>`;
  }
  function viewTests() {
    const age = (st.profile || DEF_PROFILE).age;
    return `<div class="page-head"><div class="eyebrow">${esc(t('t.eyebrow'))}</div><h1 class="h1">${esc(t('t.title'))}</h1><p class="lead">${esc(t('t.intro'))}</p></div>
      <div class="grid">${TESTS.map(x => {
        const h = hist(x.slug), last = h[h.length - 1], prev = h[h.length - 2];
        return `<a class="card stack" href="#/test/${x.slug}" style="text-decoration:none">
          <div class="row between">${tag(trackName(x.skill), 'tag-accent')}${tag(t('d.eq.' + x.equipment))}</div>
          <h2 class="h3">${esc(t('t.names.' + x.slug))}</h2>
          ${last ? `<div class="row" style="align-items:baseline"><span class="big-num" style="font-size:44px">${last.value}</span><span class="muted">${esc(unit(x, last.value))}</span>${delta(x, prev && prev.value, last.value)}</div>
            <div class="band">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= testLevel(x, last.value, age) ? 'on' : ''}"></i>`).join('')}</div>` : `<span class="muted">${esc(t('t.never'))}</span>`}
          <span class="btn btn-secondary btn-sm" style="align-self:flex-start">${esc(t('t.go'))} →</span></a>`;
      }).join('')}</div>`;
  }
  let testVal = 0, sw = null;
  function stopSw() { if (sw && sw.iv) clearInterval(sw.iv); sw = null; }
  function viewTest(slug) {
    const x = TESTS.find(y => y.slug === slug);
    if (!x) { location.replace('#/tests'); return ''; }
    const age = (st.profile || DEF_PROFILE).age, h = hist(slug), last = h[h.length - 1];
    testVal = last ? last.value : 0;
    const secs = slug === 'ball-mastery-30s' ? 30 : slug === 'wall-passing-60s' ? 60 : 0;
    const watch = slug === 'slalom-time';
    const pseudo = { slug: 'test-' + slug, minutes: secs / 60, dose: { durationSec: secs } };
    if (secs) after(() => { initTimer(pseudo); });
    return `<div class="player">
      <div class="player-top"><a class="btn btn-ghost btn-sm" href="#/tests">← ${esc(t('d.back'))}</a></div>
      <div class="player-grid">
        <div class="stack">
          <div class="row">${tag(trackName(x.skill), 'tag-accent')}${tag(t('d.eq.' + x.equipment))}${x.direction === 'lower' ? tag(t('t.lower'), 'tag-warn') : ''}</div>
          <h1 class="h2">${esc(t('t.names.' + slug))}</h1>
          <div class="card stack"><h2 class="h3">${esc(t('t.protocol'))}</h2><ol class="steps">${steps(L(x.protocol)).map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol></div>
        </div>
        <div class="player-side stack">
          ${secs ? `<div class="card stack"><span class="small muted">${esc(t('t.countdown'))} · ${secs} ${esc(t('t.units.s'))}</span><div class="timer"><div class="ring" id="ring"><svg viewBox="0 0 112 112"><circle class="track" cx="56" cy="56" r="48"/><circle class="prog" cx="56" cy="56" r="48" stroke-dasharray="${(2 * Math.PI * 48).toFixed(1)}" stroke-dashoffset="0"/></svg><div class="num" id="ringNum">0:${secs}</div></div><div class="row"><button type="button" class="btn btn-primary btn-sm" data-act="timer" id="timerBtn">▶ ${esc(t('s.start'))}</button><button type="button" class="btn btn-ghost btn-sm" data-act="timerReset">↺</button></div></div></div>` : ''}
          ${watch ? `<div class="card stack"><span class="small muted">${esc(t('t.stopwatch'))}</span><div class="big-num" id="sw">0.0</div><div class="row"><button type="button" class="btn btn-primary btn-sm" data-act="sw">▶ / ■</button><button type="button" class="btn btn-ghost btn-sm" data-act="swReset">↺</button></div></div>` : ''}
          <div class="card stack">
            <span class="small muted">${esc(t('t.result'))} (${esc(unit(x))})</span>
            <div class="stepper"><button type="button" data-act="tv" data-v="-1" aria-label="−1">−</button><input id="tv" inputmode="decimal" value="${testVal}" aria-label="${esc(t('t.result'))}"><button type="button" data-act="tv" data-v="1" aria-label="+1">+</button></div>
            ${x.unit !== 's' ? `<span class="small muted">${esc(t('t.countHint'))}</span>` : ''}
            <button type="button" class="btn btn-accent btn-block" data-act="saveTest" data-v="${slug}">✓ ${esc(t('t.save'))}</button>
          </div>
          ${h.length ? `<div class="card stack"><h2 class="h3">${esc(t('t.history'))}</h2>${spark(h.map(y => y.value))}
            ${h.length > 1 ? `<div class="row between"><span class="muted">${esc(t('t.prev'))}: <b>${h[h.length - 2].value}</b></span><span>${esc(t('t.today'))}: <b>${last.value}</b> ${delta(x, h[h.length - 2].value, last.value)}</span></div>` : ''}
            <div class="row between small"><span class="muted">${esc(t('t.level'))}</span><b>${testLevel(x, last.value, age)}/5</b></div>
            <div class="stack small" style="gap:4px">${h.slice(-6).reverse().map(y => `<div class="row between"><span class="muted">${esc(fmtDate(y.date))}</span><b>${y.value} ${esc(unit(x, y.value))}</b></div>`).join('')}</div></div>` : ''}
        </div>
      </div></div>`;
  }

  // --- progress ---
  function viewProgress() {
    if (!st.profile) return `<div class="page-head"><h1 class="h1">${esc(t('p.title'))}</h1><p class="lead">${esc(t('p.empty'))}</p><a class="btn btn-primary" href="#/start" style="align-self:flex-start">${esc(t('home.start'))} →</a></div>`;
    const S = st.sessions, mins = S.reduce((a, s) => a + s.minutes, 0), drillsDone = S.reduce((a, s) => a + s.drills.length, 0), b = badges(), lv = st.levels;
    const legend = t('p.legend');
    return `<div class="page-head"><div class="eyebrow">${esc(t('p.eyebrow'))}</div><h1 class="h1">${esc(t('p.title'))}</h1><p class="lead">${esc(t('p.compare'))}</p></div>
      <div class="metrics"><div class="metric"><b>${S.length}</b><span>${esc(pl('p.sessions', S.length))}</span></div><div class="metric"><b>${mins}</b><span>${esc(pl('p.minutes', mins))}</span></div><div class="metric"><b>${streak()}</b><span>${esc(pl('p.streak', streak()))}</span></div><div class="metric"><b>${drillsDone}</b><span>${esc(pl('p.drills', drillsDone))}</span></div></div>
      <section class="section stack"><h2 class="h3">${esc(t('p.badges'))}</h2><div class="badges">${Object.keys(b).map(k => `<span class="bdg ${b[k] ? 'on' : ''}">${b[k] ? '★ ' : ''}${esc(t('b.' + k))}</span>`).join('')}</div></section>
      <section class="section stack"><div class="row between"><h2 class="h3">${esc(t('p.tree'))}</h2><div class="legend"><span>✓ ${esc(legend[0])}</span><span>● ${esc(legend[1])}</span><span>○ ${esc(legend[2])}</span></div></div>
        <div class="tree">${TR.map(x => `<section><div class="row between"><b>${esc(L(x.names))}</b>${tag(lv[x.slug] + '/5', 'tag-accent')}</div>
          ${x.nodes.map((n, i) => { const c = i < lv[x.slug] - 1 ? 'm' : i === lv[x.slug] - 1 ? 'c' : 'l'; return `<div class="node ${c}"><i>${c === 'm' ? '✓' : ''}</i><span>${esc(L(n.names))}</span></div>`; }).join('')}</section>`).join('')}</div></section>
      <section class="section stack"><h2 class="h3">${esc(t('p.tests'))}</h2><div class="grid">${TESTS.map(x => { const h = hist(x.slug); const l = h[h.length - 1]; return `<a class="card stack" href="#/test/${x.slug}" style="text-decoration:none"><b>${esc(t('t.names.' + x.slug))}</b>${l ? `<div class="row" style="align-items:baseline"><span class="big-num" style="font-size:36px">${l.value}</span><span class="muted">${esc(unit(x, l.value))}</span>${h.length > 1 ? delta(x, h[h.length - 2].value, l.value) : ''}</div>${spark(h.map(y => y.value))}` : `<span class="muted">${esc(t('t.never'))}</span>`}</a>`; }).join('')}</div></section>
      <section class="section row"><a class="btn btn-secondary" href="#/start/4">${esc(t('p.reset'))}</a><a class="btn btn-ghost" href="#/video">${esc(t('p.video'))}</a><button type="button" class="btn btn-danger" data-act="wipe">${esc(t('auth.delete'))}</button></section>`;
  }

  // --- contribute ---
  let sent = false;
  function viewContribute(slug) {
    const base = slug ? drill(slug) : null;
    if (sent) {
      const canShare = !!navigator.share;
      return `<div class="fin"><div class="burst" aria-hidden="true">🤝</div><h1 class="h1" style="font-size:clamp(34px,7vw,60px)">${esc(t('c.thanksTitle'))}</h1>
        <p class="lead" style="margin:0 auto">${esc(CONTACT_EMAIL ? t('c.thanksEmail') : canShare ? t('c.thanksShare') : t('c.thanksCopy'))}</p>
        ${CONTACT_EMAIL ? `<p class="small muted" style="margin:0">${esc(t('c.sendTo'))} <b>${esc(CONTACT_EMAIL)}</b>${G.contrib[0] && G.contrib[0].files && G.contrib[0].files.length ? '<br>' + esc(t('c.attachHint')) : ''}</p>` : ''}
        <div class="cta" style="justify-content:center">
          ${CONTACT_EMAIL ? `<a class="btn btn-primary" href="${esc(mailtoFor(G.contrib[0]))}">✉ ${esc(t('c.email'))}</a>` : ''}
          ${canShare ? `<button type="button" class="btn ${CONTACT_EMAIL ? 'btn-secondary' : 'btn-primary'}" data-act="shareContrib">${esc(t('c.share'))}</button>` : ''}
          <button type="button" class="btn btn-secondary" data-act="copyContrib">${esc(t('c.copy'))}</button>
        </div>
        <button type="button" class="btn btn-ghost" data-act="another" style="justify-self:center">+ ${esc(t('c.another'))}</button></div>`;
    }
    const f = k => esc(t('c.f.' + k));
    const v = (k, def) => esc(base ? def : '');
    return `<div class="page-head"><div class="eyebrow">${esc(t('c.eyebrow'))}</div><h1 class="h1">${esc(t('c.title'))}</h1><p class="lead">${esc(t('c.intro'))}</p>
      ${base ? `<p class="notice">${esc(t('c.improve', { t: L(base.title) }))}</p>` : ''}</div>
      <form class="card form" id="cform" novalidate>
        <input type="hidden" name="improves" value="${esc(base ? base.slug : '')}">
        <div class="form-grid">
          <div class="field full"><label for="f-title">${f('title')} *</label><input id="f-title" name="title" required placeholder="${esc(t('c.ph.title'))}" value="${v('title', L(base && base.title))}"></div>
          <div class="field"><label for="f-sport">${f('sport')}</label><select id="f-sport" name="sport"><option value="football">${esc(t('c.football'))}</option></select></div>
          <div class="field"><label for="f-skill">${f('skill')}</label><select id="f-skill" name="skill">${TR.map(x => `<option value="${x.slug}" ${base && base.track === x.slug ? 'selected' : ''}>${esc(L(x.names))}</option>`).join('')}</select></div>
          <div class="field"><label for="f-age">${f('age')}</label><input id="f-age" name="age" value="${esc(base ? base.ageMin + '+' : '8+')}"></div>
          <div class="field"><label for="f-level">${f('level')}</label><select id="f-level" name="level">${[1, 2, 3].map(i => `<option value="${i}" ${base && base.level === i ? 'selected' : ''}>${esc(t('d.level'))} ${i}</option>`).join('')}</select></div>
          <div class="field"><label for="f-minutes">${f('minutes')}</label><input id="f-minutes" name="minutes" type="number" min="1" max="60" value="${base ? base.minutes : 5}"></div>
          <div class="field"><label for="f-eq">${f('equipment')}</label><select id="f-eq" name="equipment">${['nothing', 'ball', 'ball_wall', 'cones'].map(k => `<option value="${k}" ${(base ? base.equipment === k : k === 'ball') ? 'selected' : ''}>${esc(t('d.eq.' + k))}</option>`).join('')}</select></div>
          <div class="field full"><label for="f-goal">${f('goal')}</label><input id="f-goal" name="goal" value="${v('goal', L(base && base.goal))}"></div>
          <div class="field full"><label for="f-ins">${f('instructions')} *</label><textarea id="f-ins" name="instructions" required placeholder="${esc(t('c.ph.instructions'))}">${v('instructions', L(base && base.instructions))}</textarea></div>
          <div class="field"><label for="f-mis">${f('mistakes')}</label><textarea id="f-mis" name="mistakes">${v('mistakes', base ? (base.mistakes || []).map(L).join('\n') : '')}</textarea></div>
          <div class="field"><label for="f-saf">${f('safety')}</label><textarea id="f-saf" name="safety">${v('safety', base ? (base.safety || []).map(L).join('\n') : '')}</textarea></div>
          <div class="field"><label for="f-pro">${f('progression')}</label><textarea id="f-pro" name="progression"></textarea></div>
          <div class="field"><label for="f-reg">${f('regression')}</label><textarea id="f-reg" name="regression"></textarea></div>
          <div class="field"><label for="f-media">${f('media')}</label><input id="f-media" name="media" type="file" accept="video/*,image/*,application/pdf" multiple></div>
          <div class="field"><label for="f-src">${f('source')}</label><input id="f-src" name="source" placeholder="https://"></div>
          <div class="field full"><label for="f-author">${f('author')} *</label><input id="f-author" name="author" required placeholder="${esc(t('c.ph.author'))}"></div>
          <label class="check full"><input type="checkbox" name="rights" id="f-rights" required><span>${esc(t('c.rights'))}</span></label>
        </div>
        <button type="submit" class="btn btn-primary" style="align-self:flex-start">${esc(t('c.submit'))} →</button>
      </form>`;
  }
  // The message a coach sends to the team: labelled lines first, then one block per long answer.
  function contribText(c) {
    if (!c) return '';
    const F = k => t('c.f.' + k), line = '────────────────────────';
    const short = [[F('title'), c.title], [t('a.improvement'), c.improves ? '«' + (L((drill(c.improves) || {}).title) || c.improves) + '»' : ''],
      [F('skill'), trackName(c.skill)], [F('age'), c.age], [F('level'), c.level ? t('d.level') + ' ' + c.level : ''],
      [F('minutes'), c.minutes], [F('equipment'), c.equipment ? t('d.eq.' + c.equipment) : '']];
    const long = [[F('goal'), c.goal], [F('instructions'), c.instructions], [F('mistakes'), c.mistakes],
      [F('progression'), c.progression], [F('regression'), c.regression], [F('safety'), c.safety]];
    const out = [t('c.mail.head'), line];
    short.filter(r => r[1]).forEach(r => out.push(r[0] + ': ' + r[1]));
    long.filter(r => r[1]).forEach(r => out.push('', r[0].toUpperCase(), r[1]));
    out.push('', F('author').split('—')[0].trim().toUpperCase(), c.author);
    if (c.source) out.push(F('source') + ': ' + c.source);
    if (c.files && c.files.length) out.push('', t('c.mail.attach', { files: c.files.map(f => f.name).join(', ') }));
    out.push('', line, t('c.mail.consent'), t('c.mail.sent', { date: fmtDate(today()) + ' ' + new Date().getFullYear(), id: c.id }));
    return out.join('\n');
  }
  const mailtoFor = c => 'mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent(t('c.subject') + ' — «' + (c ? c.title : '') + '»') + '&body=' + encodeURIComponent(contribText(c));
  function submitContribution(form) {
    const fd = new FormData(form), o = {};
    ['improves', 'title', 'sport', 'skill', 'age', 'level', 'minutes', 'equipment', 'goal', 'instructions', 'mistakes', 'safety', 'progression', 'regression', 'source', 'author'].forEach(k => { o[k] = String(fd.get(k) || '').trim(); });
    if (!o.title || !o.instructions || !o.author || !fd.get('rights')) { toast(t('c.required')); return; }
    const files = Array.from(form.querySelector('#f-media').files || []).map(f => ({ name: f.name, size: f.size, type: f.type }));
    G.contrib.unshift(Object.assign(o, { id: Date.now().toString(36), status: 'pending', verify: 'COMMUNITY', files, createdAt: new Date().toISOString(), history: [{ at: new Date().toISOString(), what: 'submitted' }] }));
    save(); sent = true; render(true);
  }

  // --- admin ---
  let editing = null;
  function viewAdmin() {
    const pend = G.contrib.filter(c => c.status === 'pending' || c.status === 'changes');
    const done = G.contrib.filter(c => c.status === 'approved' || c.status === 'rejected');
    const card = c => {
      const ed = editing === c.id;
      return `<article><div class="row between"><div class="row">${tag(t('a.st.' + c.status), c.status === 'approved' ? 'tag-accent' : c.status === 'rejected' ? '' : 'tag-warn')}${tag(trackName(c.skill))}${c.improves ? tag(t('a.improvement')) : ''}</div><span class="small muted">${esc(new Date(c.createdAt).toLocaleString())}</span></div>
        ${ed ? `<div class="field"><input id="e-title" value="${esc(c.title)}"></div><div class="field"><textarea id="e-ins">${esc(c.instructions)}</textarea></div>` : `<h3 class="h3">${esc(c.title)}</h3><pre>${esc(c.instructions)}</pre>`}
        <span class="small muted">${esc(t('a.by'))}: <b>${esc(c.author)}</b>${c.source ? ' · ' + esc(c.source) : ''}${c.files && c.files.length ? ' · 📎 ' + c.files.map(f => esc(f.name)).join(', ') : ''}</span>
        <div class="row">
          ${ed ? `<button type="button" class="btn btn-primary btn-sm" data-act="adm" data-k="save" data-v="${c.id}">${esc(t('a.save'))}</button>` : `<button type="button" class="btn btn-ghost btn-sm" data-act="adm" data-k="edit" data-v="${c.id}">✎ ${esc(t('a.edit'))}</button>`}
          ${c.status !== 'approved' ? `<button type="button" class="btn btn-accent btn-sm" data-act="adm" data-k="approve" data-v="${c.id}">✓ ${esc(t('a.approve'))}</button>` : ''}
          ${c.status === 'pending' ? `<button type="button" class="btn btn-secondary btn-sm" data-act="adm" data-k="changes" data-v="${c.id}">${esc(t('a.changes'))}</button>` : ''}
          ${c.status !== 'rejected' ? `<button type="button" class="btn btn-danger btn-sm" data-act="adm" data-k="reject" data-v="${c.id}">${esc(t('a.reject'))}</button>` : ''}
          ${c.status === 'approved' ? `<label class="small muted" for="v-${c.id}">${esc(t('a.verify'))}</label><select id="v-${c.id}" data-act-change="verify" data-v="${c.id}" class="chip">${VERIFY.map((x, i) => `<option value="${x}" ${c.verify === x ? 'selected' : ''}>${esc(t('a.levels')[i])}</option>`).join('')}</select><a class="btn btn-ghost btn-sm" href="#/drill/c-${c.id}">→</a>` : ''}
        </div></article>`;
    };
    return `<div class="page-head"><div class="eyebrow">${esc(t('a.eyebrow'))}</div><h1 class="h1">${esc(t('a.title'))}</h1><p class="muted" style="margin:0">${esc(t('a.note'))}</p></div>
      <section class="stack"><h2 class="h3">${esc(t('a.pending'))} · ${pend.length}</h2><div class="adm">${pend.length ? pend.map(card).join('') : `<p class="muted">${esc(t('a.empty'))}</p>`}</div></section>
      ${done.length ? `<section class="section stack"><h2 class="h3">${esc(t('a.approved'))}</h2><div class="adm">${done.map(card).join('')}</div></section>` : ''}`;
  }
  function adminAct(k, id) {
    const c = G.contrib.find(x => x.id === id); if (!c) return;
    const log = what => { c.history = c.history || []; c.history.push({ at: new Date().toISOString(), what }); };
    if (k === 'edit') { editing = id; }
    else if (k === 'save') { c.title = $('#e-title').value.trim() || c.title; c.instructions = $('#e-ins').value.trim() || c.instructions; editing = null; log('edited'); }
    else { c.status = k === 'approve' ? 'approved' : k === 'reject' ? 'rejected' : 'changes'; log(c.status); }
    save(); render(true);
  }

  // --- video self-check ---
  let vid = { track: null, url: null, ans: {} };
  function viewVideo() {
    const tr = vid.track || (st.profile ? st.profile.goal : 'ball-mastery');
    const rub = RUB.get(tr);
    const lv = st.levels || {};
    const miss = rub ? rub.criteria.filter(c => vid.ans[c.key] === 'n') : [];
    const answered = rub ? rub.criteria.filter(c => vid.ans[c.key]).length : 0;
    const rec = allDrills().filter(d => d.track === tr && d.level <= targetLevel(lv[tr] || 1) && (!st.profile || fits(d, st.profile))).slice(0, 3);
    return `<div class="page-head"><div class="eyebrow">${esc(t('v.eyebrow'))}</div><h1 class="h1">${esc(t('v.title'))}</h1><p class="lead">${esc(t('v.intro'))}</p></div>
      <div class="player-grid">
        <div class="stack">
          <div class="card stack"><h2 class="h3">${esc(t('v.pick'))}</h2><div class="chips">${TR.map(x => `<button type="button" class="chip" data-act="vtrack" data-v="${x.slug}" aria-pressed="${x.slug === tr ? 'true' : 'false'}">${esc(L(x.names))}</button>`).join('')}</div></div>
          <div class="card stack video-box">
            ${vid.url ? `<video src="${vid.url}" controls playsinline muted loop></video><div class="row between"><span class="small muted">🔒 ${esc(t('v.local'))}</span><button type="button" class="btn btn-ghost btn-sm" data-act="vclear">${esc(t('v.clear'))}</button></div>`
              : `<label class="btn btn-primary" for="vfile" style="align-self:flex-start">● ${esc(t('v.record'))}</label><input id="vfile" type="file" accept="video/*" capture="environment" class="sr">`}
            ${rub && rub.recordingTips ? `<details class="fold"><summary>${esc(t('v.tips'))}</summary><ul>${rub.recordingTips.map(x => `<li>${esc(L(x))}</li>`).join('')}</ul></details>` : ''}
          </div>
          <p class="notice warn">${esc(t('v.ai'))}</p>
        </div>
        <div class="player-side stack">
          <div class="card stack"><h2 class="h3">${esc(t('v.check'))}</h2><div class="crit">${rub ? rub.criteria.map(c => `<article><b>${esc(L(c.label))}</b><span class="small muted">${esc(L(c.description))}</span><ul>${c.lookFor.map(x => `<li>${esc(L(x))}</li>`).join('')}</ul>
            <div class="yn"><button type="button" class="y" data-act="vans" data-k="${c.key}" data-v="y" aria-pressed="${vid.ans[c.key] === 'y' ? 'true' : 'false'}">✓ ${esc(t('v.yes'))}</button><button type="button" class="n" data-act="vans" data-k="${c.key}" data-v="n" aria-pressed="${vid.ans[c.key] === 'n' ? 'true' : 'false'}">${esc(t('v.notyet'))}</button></div></article>`).join('') : ''}</div></div>
          ${answered ? `<div class="card-ink stack on-ink"><span class="small" style="color:var(--on-ink-muted);font-weight:800;letter-spacing:.1em;text-transform:uppercase">${esc(t('v.result'))}</span>
            ${miss.length ? `<div><span class="small" style="color:var(--on-ink-muted)">${esc(t('v.focus'))}</span><div class="h3">${esc(L(miss[0].label))}</div><p style="margin:6px 0 0;color:var(--on-ink-muted)">${esc(L(miss[0].description))}</p></div>` : `<div class="h3">${esc(t('v.allGood'))}</div>`}
            <span class="small" style="color:var(--on-ink-muted)">${esc(t('v.rec'))}</span>
            <div class="stack" style="gap:6px">${rec.map(d => `<a href="#/drill/${d.slug}" style="color:var(--on-ink);font-weight:700">→ ${esc(L(d.title))}</a>`).join('')}</div>
            <span class="small" style="color:var(--on-ink-muted)">${esc(t('v.repeat'))}</span></div>` : ''}
        </div>
      </div>`;
  }

  // --- the gift page: a letter, then a button that opens the school to every child ---
  function viewGift() {
    const facts = [[DRILLS.length, t('gift.stats')[0]], [TR.length, t('gift.stats')[1]], [3, t('gift.stats')[2]], ['0 ₸', t('gift.stats')[3]]];
    return `<section class="gift" lang="${lang}">
      <div class="gift-top">
        <span class="gift-brand"><img src="icons/favicon.svg" alt="" width="30" height="30"><b>${esc(t('brand'))}</b></span>
        <div class="gift-langs">${['kk', 'ru', 'en'].map(l => `<button type="button" data-act="lang" data-v="${l}" aria-pressed="${l === lang}">${{ kk: 'ҚАЗ', ru: 'РУС', en: 'ENG' }[l]}</button>`).join('')}</div>
      </div>
      <div class="gift-eyebrow">${esc(t('gift.eyebrow'))}</div>
      <div class="gift-hero">
        <div class="gift-60" aria-hidden="true">60</div>
        <div class="gift-anims on-ink">${['juggling-alternating-feet', 'dribbling-five-cone-slalom', 'ball-mastery-inside-ping-pong'].map(sl => `<div class="anim" data-anim="${sl}" data-track="${BY.get(sl).track}"></div>`).join('')}</div>
      </div>
      <article class="gift-letter">
        <h1>${esc(t('gift.title'))}</h1>
        ${t('gift.letter').map(x => `<p>${esc(x)}</p>`).join('')}
        <p class="gift-sign">${esc(t('gift.sign'))}</p>
      </article>
      <div class="gift-launch" id="giftLaunch">
        <button type="button" class="launch" data-act="giftOpen"><span class="launch-ring" aria-hidden="true"></span><span class="launch-ball" aria-hidden="true">⚽</span><b>${esc(t('gift.button'))}</b></button>
      </div>
      <div class="gift-open" id="giftOpen" hidden>
        <h2>${esc(t('gift.openTitle'))}</h2>
        <p class="gift-sub">${esc(t('gift.openSub'))}</p>
        <div class="gift-stats">${facts.map((f, i) => `<div><b data-count="${typeof f[0] === 'number' ? f[0] : ''}">${typeof f[0] === 'number' ? 0 : f[0]}</b><span>${esc(f[1])}</span></div>`).join('')}</div>
        <div class="gift-qr"><img src="icons/qr-app.svg" alt="QR" width="200" height="200"><div><p>${esc(t('gift.qr'))}</p><a href="#/">first-coach-production.up.railway.app</a></div></div>
        <div class="gift-next"><h3>${esc(t('gift.nextTitle'))}</h3><ul>${t('gift.next').map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="gift-cta"><a class="btn gift-btn" href="#/">${esc(t('gift.app'))} →</a><a class="btn gift-btn-ghost" href="https://github.com/KOZ-Digital-AI/first-coach" target="_blank" rel="noopener">${esc(t('gift.code'))}</a></div>
        <button type="button" class="gift-replay" data-act="giftReplay">↺ ${esc(t('gift.replay'))}</button>
      </div>
    </section>`;
  }
  function giftOpen() {
    const launch = $('#giftLaunch'), open = $('#giftOpen');
    if (!launch || !open) return;
    launch.classList.add('gone');
    setTimeout(() => {
      launch.hidden = true; open.hidden = false; open.classList.add('show');
      confetti(); setTimeout(confetti, 700);
      try { if (navigator.vibrate) navigator.vibrate([60, 40, 120]); } catch (e) { /* no vibration */ }
      $$('[data-count]', open).forEach(el => {
        const to = +el.dataset.count; if (!to) return;
        const t0 = performance.now();
        const step = now => { const k = Math.min(1, (now - t0) / 1600); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      });
      open.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 450);
  }

  // --- players (light sign-in, stored on this device only) ---
  const AVATARS = ['⚽', '🦁', '🐯', '🦊', '🐺', '🦅', '🐼', '🐸', '🐬', '🐻', '🐱', '🚀'];
  const COLORS = ['#2e7d53', '#3b62a8', '#df8a1d', '#d9485f', '#7c4dcc', '#0e8a9a'];
  const hashPin = (id, pin) => { let h = 5381; for (const c of id + ':' + pin) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
  const nameOf = p => (p && p.name) || t('auth.player');
  const avatar = (p, size) => `<span class="av av-${size || 'md'}" style="--c:${COLORS[(p && p.color) || 0]}" aria-hidden="true">${AVATARS[(p && p.avatar) || 0]}</span>`;
  let pending = null, nf = null, pinBuf = '', gate = null;
  function signIn(id) {
    G.current = id; st = Object.assign({}, DEF, read(PKEY(id)) || {}); save();
    const next = pending || (st.profile ? '#/plan' : '#/start');
    pending = null; pinBuf = ''; gate = null;
    location.hash = next;
  }
  function signOut(to) { G.current = null; st = Object.assign({}, DEF); save(); location.hash = to || '#/'; }
  function viewLogin(arg) {
    if (arg === 'new' || !G.profiles.length) return viewNewPlayer();
    if (arg.startsWith('pin/')) return viewPin(arg.slice(4));
    return `<div class="auth">
      <div class="auth-head"><h1 class="h1">${esc(t('auth.who'))}</h1><p class="lead">${esc(t('auth.whoHint'))}</p></div>
      <div class="prof-grid">
        ${G.profiles.map(p => { const n = ((read(PKEY(p.id)) || {}).sessions || []).length; return `<button type="button" class="prof" data-act="authPick" data-v="${p.id}">${avatar(p, 'lg')}<b>${esc(nameOf(p))}${p.pin ? ' <span class="lock" aria-label="PIN">🔒</span>' : ''}</b><span class="small muted">${esc(t('auth.sessionsN', { n }))}</span></button>`; }).join('')}
        <a class="prof prof-add" href="#/login/new"><span class="av av-lg av-add" aria-hidden="true">+</span><b>${esc(t('auth.add'))}</b></a>
      </div></div>`;
  }
  function viewNewPlayer() {
    nf = nf || { name: '', avatar: Math.floor(Math.random() * AVATARS.length), color: Math.floor(Math.random() * COLORS.length), pin: '' };
    return `<div class="auth"><form class="auth-card" id="nfForm" novalidate>
      <div class="auth-preview">${avatar(nf, 'xl')}<h1 class="h2">${esc(nf.name || t('auth.newTitle'))}</h1></div>
      <div class="field"><label for="nf-name">${esc(t('auth.name'))}</label><input id="nf-name" maxlength="20" autocomplete="off" placeholder="${esc(t('auth.namePh'))}" value="${esc(nf.name)}"><small>${esc(t('auth.nameHint'))}</small></div>
      <div class="field"><span class="lbl">${esc(t('auth.avatar'))}</span><div class="av-grid" role="group">${AVATARS.map((a, i) => `<button type="button" class="av-pick" data-act="nfAvatar" data-v="${i}" aria-pressed="${i === nf.avatar}" aria-label="${a}" style="--c:${COLORS[nf.color]}">${a}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">${esc(t('auth.color'))}</span><div class="sw-row" role="group">${COLORS.map((c, i) => `<button type="button" class="sw" data-act="nfColor" data-v="${i}" aria-pressed="${i === nf.color}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div></div>
      <div class="field"><label for="nf-pin">${esc(t('auth.pin'))}</label><input id="nf-pin" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="• • • •" value="${esc(nf.pin)}"><small>${esc(t('auth.pinHint'))}</small></div>
      <button type="submit" class="btn btn-accent btn-block" style="min-height:54px;font-size:17px">${esc(t('auth.create'))} →</button>
      ${G.profiles.length ? `<a class="btn btn-ghost" href="#/login">← ${esc(t('auth.back'))}</a>` : ''}
    </form></div>`;
  }
  function createPlayer() {
    const name = (nf.name || '').trim(), pin = (nf.pin || '').trim();
    if (!name) { toast(t('auth.nameReq')); const i = $('#nf-name'); if (i) i.focus(); return; }
    if (pin && !/^\d{4}$/.test(pin)) { toast(t('auth.pinBad')); return; }
    const id = uid();
    G.profiles.push({ id, name, avatar: nf.avatar, color: nf.color, pin: pin ? hashPin(id, pin) : null, createdAt: new Date().toISOString() });
    nf = null;
    signIn(id);
  }
  function viewPin(id) {
    const p = G.profiles.find(x => x.id === id);
    if (!p) { location.replace('#/login'); return ''; }
    return `<div class="auth auth-narrow">
      <div class="auth-preview">${avatar(p, 'xl')}<h1 class="h2">${esc(t('auth.hello', { name: nameOf(p) }))}</h1><p class="muted" style="margin:0">${esc(t('auth.enterPin'))}</p></div>
      <div class="pin-dots" id="pinDots" aria-live="polite">${[0, 1, 2, 3].map(i => `<i class="${i < pinBuf.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k => k ? `<button type="button" data-act="pinKey" data-v="${k}" data-k="${id}" aria-label="${k === '⌫' ? 'delete' : k}">${k}</button>` : '<span></span>').join('')}</div>
      ${gate ? `<div class="card stack" style="width:100%"><label for="gateIn" class="small">${esc(t('auth.gate', gate))}</label><div class="row" style="flex-wrap:nowrap"><input id="gateIn" class="pin-input" inputmode="numeric" maxlength="3" style="flex:1"><button type="button" class="btn btn-primary" data-act="gateOk" data-v="${id}">${esc(t('auth.gateBtn'))}</button></div></div>`
        : `<button type="button" class="btn btn-ghost btn-sm" data-act="pinForgot">${esc(t('auth.forgot'))}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/login">← ${esc(t('auth.back'))}</a>
    </div>`;
  }
  function pinKey(k, id) {
    const p = G.profiles.find(x => x.id === id); if (!p) return;
    if (k === '⌫') pinBuf = pinBuf.slice(0, -1); else if (pinBuf.length < 4) pinBuf += k;
    const dots = $('#pinDots');
    if (dots) dots.innerHTML = [0, 1, 2, 3].map(i => `<i class="${i < pinBuf.length ? 'on' : ''}"></i>`).join('');
    if (pinBuf.length === 4) {
      if (hashPin(id, pinBuf) === p.pin) { signIn(id); return; }
      pinBuf = '';
      if (dots) { dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); setTimeout(() => { dots.innerHTML = '<i></i><i></i><i></i><i></i>'; }, 350); }
      try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) { /* no vibration */ }
      toast(t('auth.wrongPin'));
    }
  }
  function meMenu() {
    const box = $('#me'); if (!box) return;
    const p = me();
    box.innerHTML = p
      ? `<button type="button" class="me-btn" data-act="meToggle" aria-haspopup="true" aria-expanded="false">${avatar(p, 'sm')}<span class="me-name">${esc(nameOf(p))}</span></button>
        <div class="menu" id="meMenu" hidden>
          <div class="menu-head">${avatar(p, 'md')}<b>${esc(nameOf(p))}</b></div>
          <a href="#/progress">${esc(t('auth.menuProgress'))}</a>
          ${installEvt ? `<button type="button" data-act="installApp">${esc(t('auth.install'))}</button>` : ''}
          <button type="button" data-act="authSwitch">${esc(t('auth.switch'))}</button>
          <button type="button" data-act="authLogout">${esc(t('auth.logout'))}</button>
        </div>`
      : `<a class="btn btn-secondary btn-sm me-in" href="#/login">${esc(t('auth.signin'))}</a>`;
  }
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; meMenu(); });

  function fallbackCopy(txt, done) {
    const ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nothing more to try */ }
    ta.remove();
  }

  // ---------- router ----------
  const ROUTES = { '60': viewGift, gift: viewGift, login: viewLogin, '': viewHome, start: viewStart, plan: viewPlan, session: viewSession, done: viewDone, drill: viewDrill, library: viewLibrary, tests: viewTests, test: viewTest, progress: viewProgress, contribute: viewContribute, admin: viewAdmin, video: viewVideo };
  const NAV = { login: 'train', '': 'home', start: 'train', plan: 'train', session: 'train', done: 'train', drill: 'library', library: 'library', tests: 'tests', test: 'tests', progress: 'progress', contribute: 'contribute', admin: 'admin', video: 'progress' };
  let queue = [], lastRoute = null;
  const after = fn => queue.push(fn);
  function parse() { const h = location.hash.replace(/^#\/?/, ''); const i = h.indexOf('/'); return i < 0 ? { r: h, arg: '' } : { r: h.slice(0, i), arg: decodeURIComponent(h.slice(i + 1)) }; }
  function render(keepScroll) {
    stopTimer(); stopSw();
    if (showTimer) { clearInterval(showTimer); showTimer = null; }
    document.title = t('title');
    $$('.sheet').forEach(x => x.remove());
    const { r, arg } = parse();
    if (['start', 'plan', 'session', 'done', 'progress', 'tests', 'test', 'video'].includes(r) && !me()) {
      pending = location.hash; location.replace('#/login'); return;
    }
    if (r === 'login' && !arg.startsWith('pin/')) pinBuf = '';
    document.body.dataset.route = r || 'home';
    if (r !== 'contribute') sent = false;
    if (r !== 'start') ob = null;
    queue = [];
    const view = ROUTES[r] || viewHome;
    const html = view(arg);
    if (html === '' && r !== '' && location.hash.replace(/^#\/?/, '').split('/')[0] !== r) return; // redirected
    app.innerHTML = html;
    document.documentElement.lang = lang;
    $$('[data-anim]', app).forEach(el => window.FCAnim.mount(el, el.dataset.anim, { track: el.dataset.track, offset: hash01(el.dataset.anim), alt: el.getAttribute('aria-label') }));
    const cur = NAV[r] || 'home';
    $$('[data-nav]').forEach(a => a.setAttribute('aria-current', a.dataset.nav === cur ? 'page' : 'false'));
    $$('[data-lang]').forEach(b => b.setAttribute('aria-pressed', b.dataset.lang === lang ? 'true' : 'false'));
    $$('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
    const sel = $('#langSel'); if (sel) sel.value = lang;
    meMenu();
    queue.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    const key = r + '/' + arg;
    if (!keepScroll && key !== lastRoute) window.scrollTo(0, 0);
    lastRoute = key;
  }
  window.addEventListener('hashchange', () => render(false));

  // ---------- events ----------
  const ACT = {
    lang(v) { lang = v; G.lang = v; save(); render(true); },
    obSet(v, k) { ob.p[k] = isNaN(+v) ? v : +v; const adv = k === 'age' || k === 'goal'; if (adv) ob.step++; render(true); if (adv) window.scrollTo(0, 0); },
    obToggle(v, k) { ob.p[k] = !ob.p[k]; if (k !== 'ball' && ob.p[k] && (k === 'wall' || k === 'cones')) ob.p.ball = true; if (k === 'ball' && !ob.p.ball) { ob.p.wall = false; ob.p.cones = false; } render(true); },
    obLevel(v, k) { ob.lv[k] = +v; render(true); },
    obNext() { ob.step = Math.min(4, ob.step + 1); render(false); window.scrollTo(0, 0); },
    obBack() { ob.step = Math.max(0, ob.step - 1); render(false); window.scrollTo(0, 0); },
    obBuild() { st.profile = Object.assign({}, ob.p); st.levels = Object.assign({}, ob.lv); st.xp = {}; st.current = null; st.planStart = today(); save(); ob = null; location.hash = '#/plan'; },
    newPlan() { st.planStart = today(); st.current = null; save(); render(false); },
    libTrack(v) { G.lib = { track: v, eq: '', lvl: 0 }; save(); location.hash = '#/library'; },
    animSlow(v, k, el) { const a = el.closest('.anim-wrap').querySelector('.anim').__fc; const on = el.getAttribute('aria-pressed') !== 'true'; a.setSpeed(on ? 0.5 : 1); el.setAttribute('aria-pressed', String(on)); },
    animPause(v, k, el) { const a = el.closest('.anim-wrap').querySelector('.anim').__fc; const playing = a.toggle(); el.setAttribute('aria-pressed', String(!playing)); el.textContent = playing ? '❚❚' : '▶'; },
    timer() { toggleTimer(); },
    timerReset() { if (timer) { if (timer.iv) clearInterval(timer.iv); timer.iv = null; timer.left = timer.total; paintTimer(); } },
    set(v, k, el) { const slug = (timer && timer.slug) || 'x'; sets[slug] = sets[slug] || {}; sets[slug][v] = !sets[slug][v]; el.setAttribute('aria-pressed', String(!!sets[slug][v])); },
    swap(v) { swapDrill(v); },
    drillDone() { openRate(); },
    rate(v) { rateDrill(v); },
    lib(v, k) { G.lib = Object.assign({}, G.lib, { [k]: k === 'lvl' ? +v : v }); save(); render(true); },
    tv(v) { const i = $('#tv'); const n = Math.max(0, (parseFloat(String(i.value).replace(',', '.')) || 0) + +v); i.value = String(Math.round(n * 10) / 10); },
    saveTest(slug) {
      const x = TESTS.find(y => y.slug === slug), v = parseFloat(String($('#tv').value).replace(',', '.'));
      if (!(v >= 0)) return;
      st.tests.push({ slug, value: v, date: today() });
      if (st.levels) st.levels[x.skill] = testLevel(x, v, (st.profile || DEF_PROFILE).age);
      if (st.current && !Object.keys(st.current.done).length) st.current = null;
      save(); render(true); toast(t('t.saved'));
    },
    sw() {
      const el = $('#sw'); if (!el) return;
      if (sw && sw.iv) { clearInterval(sw.iv); sw.iv = null; const v = Math.round(sw.ms / 100) / 10; $('#tv').value = String(v); return; }
      sw = sw || { ms: 0 }; let last = Date.now();
      sw.iv = setInterval(() => { const n = Date.now(); sw.ms += n - last; last = n; el.textContent = (sw.ms / 1000).toFixed(1); }, 100);
    },
    swReset() { stopSw(); const el = $('#sw'); if (el) el.textContent = '0.0'; },
    another() { sent = false; render(false); },
    back() { if (history.length > 1) history.back(); else location.hash = '#/library'; },
    shareContrib() { const c = G.contrib[0]; if (c && navigator.share) navigator.share({ title: t('c.subject'), text: contribText(c) }).catch(() => {}); },
    copyContrib() {
      const txt = contribText(G.contrib[0]);
      const done = () => toast(t('c.copied'));
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, () => fallbackCopy(txt, done));
      else fallbackCopy(txt, done);
    },
    adm(v, k) { adminAct(k, v); },
    vtrack(v) { vid.track = v; vid.ans = {}; render(true); },
    vans(v, k) { vid.ans[k] = v; render(true); },
    vclear() { if (vid.url) URL.revokeObjectURL(vid.url); vid.url = null; render(true); },
    wipe() {
      const p = me(); if (!p || !confirm(t('auth.deleteQ', { name: nameOf(p) }))) return;
      try { localStorage.removeItem(PKEY(p.id)); } catch (e) { /* ignore */ }
      G.profiles = G.profiles.filter(x => x.id !== p.id); signOut('#/');
    },
    authPick(v) { const p = G.profiles.find(x => x.id === v); if (!p) return; if (p.pin) { pinBuf = ''; gate = null; location.hash = '#/login/pin/' + v; } else signIn(v); },
    nfAvatar(v) { nf.avatar = +v; render(true); },
    nfColor(v) { nf.color = +v; render(true); },
    pinKey(v, k) { pinKey(v, k); },
    pinForgot() { const a = 3 + Math.floor(Math.random() * 6), b = 4 + Math.floor(Math.random() * 5); gate = { a, b, ans: a * b }; render(true); const i = $('#gateIn'); if (i) i.focus(); },
    gateOk(v) {
      const i = $('#gateIn'), p = G.profiles.find(x => x.id === v);
      if (!i || !p || !gate) return;
      if (+i.value === gate.ans) { p.pin = null; save(); signIn(v); } else { toast(t('auth.gateWrong')); i.value = ''; }
    },
    meToggle(v, k, el) { const m = $('#meMenu'); if (!m) return; m.hidden = !m.hidden; el.setAttribute('aria-expanded', String(!m.hidden)); },
    authSwitch() { signOut('#/login'); },
    authLogout() { signOut('#/'); },
    giftOpen() { giftOpen(); },
    giftReplay() { render(false); window.scrollTo(0, 0); },
    installApp() { if (!installEvt) return; installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; meMenu(); }); },
  };
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACT[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el.dataset.v, el.dataset.k, el); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'langSel') { ACT.lang(e.target.value); return; }
    if (e.target.id === 'vfile' && e.target.files && e.target.files[0]) { if (vid.url) URL.revokeObjectURL(vid.url); vid.url = URL.createObjectURL(e.target.files[0]); render(true); }
    if (e.target.dataset && e.target.dataset.actChange === 'verify') { const c = G.contrib.find(x => x.id === e.target.dataset.v); if (c) { c.verify = e.target.value; save(); toast('✓ ' + t('a.levels')[Math.max(0, VERIFY.indexOf(c.verify))]); } }
  });
  document.addEventListener('submit', e => {
    if (e.target.id === 'cform') { e.preventDefault(); submitContribution(e.target); }
    if (e.target.id === 'nfForm') { e.preventDefault(); createPlayer(); }
  });
  document.addEventListener('input', e => {
    if (!nf) return;
    if (e.target.id === 'nf-name') { nf.name = e.target.value; const h = $('.auth-preview h1'); if (h) h.textContent = nf.name || t('auth.newTitle'); }
    if (e.target.id === 'nf-pin') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); nf.pin = e.target.value; }
  });
  document.addEventListener('click', e => { const m = $('#meMenu'); if (m && !m.hidden && !e.target.closest('#me')) m.hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { const s = $('.sheet'); if (s) s.remove(); const m = $('#meMenu'); if (m) m.hidden = true; }
    const pinView = location.hash.startsWith('#/login/pin/');
    if (pinView && /^[0-9]$/.test(e.key) && !(e.target && e.target.id === 'gateIn')) pinKey(e.key, location.hash.split('/').pop());
    if (pinView && e.key === 'Backspace' && !(e.target && e.target.id === 'gateIn')) pinKey('⌫', location.hash.split('/').pop());
  });

  // ---------- boot ----------
  document.getElementById('tabbar').innerHTML = [['plan', 'train'], ['library', 'library'], ['tests', 'tests'], ['progress', 'progress']]
    .map(([r, k]) => `<a href="#/${r}" data-nav="${k}">${ICON[k]}<span data-t="nav.${k}"></span></a>`).join('');
  render(false);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* not supported here */ }
  }
})();
