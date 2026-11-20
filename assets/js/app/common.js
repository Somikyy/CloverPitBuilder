// Shared helpers for every page: data loading, rendering, sound, settings, item details.
import { makeDb } from '../core/engine.js';

// ------------------------------------------------------------------ data
let dbPromise = null;
export function loadDb() {
  if (!dbPromise) {
    dbPromise = Promise.all([
      fetchJson('data/items.json'),
      fetchJson('data/models.json').catch(() => []),
      fetchJson('data/mechanics.json'),
    ]).then(([items, models, mech]) => makeDb(items, Array.isArray(models) ? models : models.models || [], mech));
  }
  return dbPromise;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  return r.json();
}

// ------------------------------------------------------------------ DOM
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICON = 'assets/icons/game/';
const TOKEN_ICONS = {
  lemon: 'SymbolLemon', cherry: 'SymbolCherry', clover: 'SymbolClover', bell: 'SymbolBell', diamond: 'SymbolDiamond',
  treasure: 'SymbolTreasure', seven: 'SymbolSeven', coins: 'Coin', tickets: 'Ticket', charge: 'Energy', 'red button': 'RedButton',
  '6': 'Number6', '9': 'Number9',
  hor: 'PatternHor', horl: 'PatternHorL', horxl: 'PatternHorXL', ver: 'PatternVer', diag: 'PatternDiag', zig: 'PatternZig',
  zag: 'PatternZag', above: 'PatternAbove', below: 'PatternBelow', eye: 'PatternEye', jackpot: 'PatternJackpot',
  hors: 'PatternHorS', vers: 'PatternVerS', diags: 'PatternDiagS',
};

/** Wiki description text -> HTML with inline game icons for [Lemon], [Tickets], [HorXL] ... */
export function richText(text) {
  return esc(text).replace(/\[([^\]]{1,24})\]/g, (m, raw) => {
    const k = raw.trim().toLowerCase();
    const mod = k.match(/^(\w+) modifier$/);
    if (mod) return `<img class="desc-icon" src="${ICON}Modifier${cap(mod[1])}.webp" alt="${esc(raw)}" title="${esc(raw)}">`;
    const f = TOKEN_ICONS[k];
    if (!f) return esc(raw);
    const cls = f.startsWith('Pattern') ? 'desc-icon pat' : 'desc-icon';
    return `<img class="${cls}" src="${ICON}${f}.webp" alt="${esc(raw)}" title="${esc(raw)}">`;
  });
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function itemIcon(it, cls = '') {
  if (it && it.icon) return h('img', { src: it.icon, alt: '', class: cls, loading: 'lazy', decoding: 'async' });
  const initials = (it ? it.name : '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='8' fill='%23262f2a'/><text x='32' y='40' font-size='22' text-anchor='middle' fill='%23ff9f2a' font-family='monospace'>${encodeURIComponent(initials)}</text></svg>`;
  return h('img', { src: `data:image/svg+xml;utf8,${svg}`, alt: '', class: cls });
}

export const CATEGORY_LABEL = { store: 'Store charm', surgery: 'Surgery charm (DLC)', sacred: 'Sacred charm', evil: 'Evil charm (DLC)', cadaver: 'Corpse piece' };
export const PHONE_LABEL = { normal: 'Normal call', red: 'Red call', sacred: 'Sacred call' };
export const TRAITS = [
  { id: 'ambitious', name: 'Ambitious', color: '#ff8c00', effect: 'Patterns Multiplier +1' },
  { id: 'avid', name: 'Avid', color: '#ffd500', effect: 'Symbols Multiplier +2' },
  { id: 'devious', name: 'Devious', color: '#ff2a2a', effect: '+0.6% chance of 666' },
  { id: 'florid', name: 'Florid', color: '#9acd32', effect: '+3 tickets when a deadline ends' },
  { id: 'gambler', name: 'Gambler', color: '#2fbf4a', effect: '1 free restock every deadline' },
  { id: 'obsessive', name: 'Obsessive', color: '#00e5ff', effect: 'Last pattern triggers one more time' },
  { id: 'speculative', name: 'Speculative', color: '#ffb6c1', effect: '+3% interest' },
];

export function itemChips(it, opts = {}) {
  const chips = [];
  if (it.model && it.model.tier && opts.tier !== false) chips.push(h('span', { class: `chip tier tier-${it.model.tier}`, title: 'Baseline tier' }, it.model.tier));
  if (it.kind === 'charm' && it.cost != null) {
    const cant = opts.tickets != null && it.cost > opts.tickets;
    chips.push(h('span', { class: `chip ticket${cant ? ' cant' : ''}`, title: `${it.cost} clover tickets` }, h('img', { src: `${ICON}Ticket.webp`, alt: '' }), String(opts.price ?? it.cost)));
  }
  if (it.redButtonCharges) chips.push(h('span', { class: 'chip charge', title: `Red Button charm: ${it.redButtonCharges} charges` }, h('img', { src: `${ICON}RedButton.webp`, alt: '' }), `${it.redButtonCharges}`));
  if (it.triggersRandomly) chips.push(h('span', { class: 'chip', title: 'Triggers randomly' }, `${it.triggersRandomly}%`));
  if (it.noSpace) chips.push(h('span', { class: 'chip', title: "Doesn't take charm space" }, 'No space'));
  if (it.kind === 'phone' && it.type !== 'normal') chips.push(h('span', { class: `chip ${it.type}` }, PHONE_LABEL[it.type]));
  if (it.kind === 'charm' && it.category !== 'store' && opts.category !== false) chips.push(h('span', { class: `chip ${it.category === 'sacred' ? 'sacred' : it.category === 'evil' ? 'red' : ''}` }, CATEGORY_LABEL[it.category]));
  if (it.dlc) chips.push(h('span', { class: 'chip dlc', title: 'Unholy Fusion DLC' }, 'DLC'));
  return chips;
}

// ------------------------------------------------------------------ settings
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
export { store };

export const settings = {
  sound: store.get('cp.sound', true),
  fx: store.get('cp.fx', true),
};

export function initChrome() {
  const sBtn = document.getElementById('toggle-sound');
  const fBtn = document.getElementById('toggle-fx');
  const apply = () => {
    if (sBtn) { sBtn.setAttribute('aria-pressed', String(settings.sound)); sBtn.querySelector('span').textContent = settings.sound ? 'Sound on' : 'Sound off'; }
    if (fBtn) { fBtn.setAttribute('aria-pressed', String(settings.fx)); fBtn.querySelector('span').textContent = settings.fx ? 'CRT on' : 'CRT off'; }
    document.documentElement.classList.toggle('no-fx', !settings.fx);
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('fx', settings.fx));
  };
  sBtn && sBtn.addEventListener('click', () => { settings.sound = !settings.sound; store.set('cp.sound', settings.sound); apply(); if (settings.sound) sfx.click(); });
  fBtn && fBtn.addEventListener('click', () => { settings.fx = !settings.fx; store.set('cp.fx', settings.fx); apply(); sfx.click(); });
  apply();
}

export function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

export const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ sound (synthesised, no audio files)
let ac = null, gestured = false;
for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, () => { gestured = true; }, { capture: true, passive: true });
function audio() {
  if (!settings.sound || !gestured) return null;
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch { return null; }
}
function tone(freq, dur, { type = 'square', vol = 0.06, at = 0, slide = 0 } = {}) {
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(dur, { vol = 0.08, at = 0, freq = 1200, q = 0.8 } = {}) {
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + at;
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = a.createGain(); g.gain.value = vol;
  s.connect(f).connect(g).connect(a.destination); s.start(t0);
}
export const sfx = {
  click() { tone(900, 0.03, { vol: 0.025 }); },
  add() { tone(520, 0.05, { vol: 0.04 }); tone(780, 0.07, { vol: 0.035, at: 0.05 }); },
  remove() { tone(420, 0.06, { vol: 0.035, slide: -180 }); },
  lever() { noise(0.18, { vol: 0.12, freq: 380, q: 0.6 }); tone(95, 0.22, { type: 'sine', vol: 0.18, slide: -45 }); },
  tick() { tone(1700 + Math.random() * 200, 0.012, { vol: 0.018 }); },
  stop() { noise(0.06, { vol: 0.09, freq: 900, q: 1.2 }); tone(140, 0.08, { type: 'triangle', vol: 0.08 }); },
  win() { [988, 1319, 1568, 1976].forEach((f, i) => tone(f, 0.12, { type: 'triangle', vol: 0.05, at: i * 0.07 })); },
  ring() { for (let i = 0; i < 2; i++) { tone(440, 0.35, { type: 'sine', vol: 0.04, at: i * 0.5 }); tone(480, 0.35, { type: 'sine', vol: 0.04, at: i * 0.5 }); } },
};

// ------------------------------------------------------------------ item details dialog
let dialog = null;
export function openItem(db, id, opts = {}) {
  const it = db.byId.get(id);
  if (!it) return;
  if (!dialog) {
    dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'item-title' });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  const m = it.model;
  const rel = (list, anti) => (list || []).map((s) => {
    const o = db.byId.get(s.id);
    if (!o) return null;
    return h('button', { class: `rel${anti ? ' anti' : ''}`, type: 'button', onclick: () => openItem(db, s.id, opts) },
      itemIcon(o), h('span', {}, h('b', {}, o.name), h('span', { class: 'rel-why' }, s.why || '')));
  });
  const ratingRow = (label, v, risk) => [h('span', {}, label), h('div', { class: `bar${risk ? ' risk' : ''}` }, h('i', { style: { width: `${(v || 0) * 10}%` } })), h('span', { class: 'led-font' }, String(v ?? '–'))];
  const typeLine = it.kind === 'charm' ? `${it.rarity || ''} ${CATEGORY_LABEL[it.category] || 'charm'}` : it.kind === 'phone' ? `${it.rarity ? it.rarity + ' ' : ''}${PHONE_LABEL[it.type]}` : `${it.rarity ? it.rarity + ' ' : ''}Memory card`;
  const body = h('div', { class: 'detail' },
    h('div', { class: 'detail-art' },
      h('div', { class: `frame ${it.kind}` }, itemIcon(it)),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, itemChips(it, { category: false })),
      opts.onAdd ? h('button', { class: 'btn amber', type: 'button', onclick: () => { opts.onAdd(it); dialog.close(); } }, opts.addLabel || 'Add to my build') : null,
    ),
    h('div', {},
      h('div', { class: `rar rarity-${it.rarity || ''}` }, typeLine),
      m ? h('p', { class: 'summary' }, m.summary) : null,
      h('h3', {}, 'In-game text'),
      h('div', { class: 'official', html: richText(it.description) }),
      it.recipe ? h('p', { class: 'small' }, h('b', {}, 'Recipe: '), it.recipe.map((r) => (db.byId.get(r) ? db.byId.get(r).name : r)).join(' + ')) : null,
      it.dialogue ? h('p', { class: 'small muted' }, `“${it.dialogue}”`) : null,
      it.response ? h('p', { class: 'small muted' }, `Your answer: “${it.response}”`) : null,
      m && m.tip ? [h('h3', {}, 'Tip'), h('p', { style: { margin: 0 } }, m.tip)] : null,
      m ? [h('h3', {}, 'Strength'),
        h('div', { class: 'ratings' },
          ratingRow('Power now', m.ratings.power), ratingRow('Scaling', m.ratings.scaling), ratingRow('Economy', m.ratings.economy),
          ratingRow('Utility', m.ratings.utility), ratingRow('Risk', m.ratings.risk, true))] : null,
      m && (m.synergies || []).length ? [h('h3', {}, 'Works well with'), h('div', { class: 'rel-list' }, rel(m.synergies))] : null,
      m && (m.antiSynergies || []).length ? [h('h3', {}, 'Clashes with'), h('div', { class: 'rel-list' }, rel(m.antiSynergies, true))] : null,
      it.unlock ? [h('h3', {}, 'How to unlock'), h('p', { class: 'small', style: { margin: 0 } }, it.unlock)] : null,
      h('p', { class: 'note' }, 'In-game text from the ', h('a', { href: it.wiki, target: '_blank', rel: 'noopener' }, 'CloverPit Wiki'), ' (CC BY-SA 4.0).'),
    ),
  );
  dialog.replaceChildren(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'item-title' }, it.name), h('button', { class: 'close-btn', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    h('div', { class: 'sheet-body' }, body),
  );
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.sheet-body').scrollTop = 0;
}

// ------------------------------------------------------------------ search
export function searchText(it) {
  if (!it._search) {
    const m = it.model || {};
    it._search = [it.name, it.description, m.summary, (m.provides || []).join(' '), (m.archetypes || []).join(' '), it.rarity, it.category, it.type].join(' ').toLowerCase();
  }
  return it._search;
}

export function matches(it, q) {
  if (!q) return true;
  const s = searchText(it);
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => s.includes(w));
}

export function fmtNum(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e15) return x.toExponential(2).replace('e+', 'e');
  if (a >= 1e9) return (x / 1e9).toFixed(a >= 1e11 ? 0 : 1) + 'B';
  if (a >= 1e6) return (x / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  if (a >= 1e4) return (x / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  if (a >= 100 || (Number.isInteger(x) && a >= 1)) return Math.round(x).toLocaleString('en-US');
  if (a >= 10) return x.toFixed(1);
  return x.toFixed(2);
}
