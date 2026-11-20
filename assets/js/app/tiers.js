// Tier list page: curated general tiers, or tiers recomputed for the saved build.
import { loadDb, h, itemIcon, initChrome, openItem, sfx } from './common.js';
import { ARCH_LABELS, analyze } from '../core/engine.js';
import { loadLocal } from './state.js';

const $ = (id) => document.getElementById(id);
const TIERS = ['S', 'A', 'B', 'C', 'D'];
const TIER_COLORS = { S: '#ff9f2a', A: '#e0c34f', B: '#73b86d', C: '#5c8fb3', D: '#6f6f6f' };
let db, mode = 'base', kind = 'charm', arch = '', storeOnly = true, dlc = true, buildResult = null, busy = false;

init().catch((e) => { $('tier-status').textContent = 'Could not load: ' + e.message; });

async function init() {
  initChrome();
  db = await loadDb();
  const p = new URLSearchParams(location.search);
  if (p.get('mode') === 'build') mode = 'build';
  if (['charm', 'phone', 'memory'].includes(p.get('kind'))) kind = p.get('kind');
  for (const [id, label] of Object.entries(ARCH_LABELS)) $('arch').append(h('option', { value: id }, label));
  $('arch').addEventListener('change', (e) => { arch = e.target.value; draw(); });
  $('store-only').addEventListener('change', (e) => { storeOnly = e.target.checked; draw(); });
  $('dlc').addEventListener('change', (e) => { dlc = e.target.checked; draw(); });
  $('mode-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; sfx.click(); draw(); }));
  $('kind-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { kind = b.dataset.kind; sfx.click(); draw(); }));
  draw();
}

function runBuild() {
  if (buildResult || busy) return;
  busy = true;
  $('tier-status').innerHTML = '<span class="busy-dot"></span> Simulating your build…';
  const state = loadLocal();
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { busy = false; if (e.data.error) { $('tier-status').textContent = 'The simulator failed for this build.'; return; } buildResult = e.data.res; w.terminate(); draw(); };
    w.onerror = () => { w.terminate(); fallback(state); };
    w.postMessage({ id: 1, state, base: location.href });
  } catch { fallback(state); }
}

function fallback(state) {
  setTimeout(() => { try { buildResult = analyze(state, db); } catch { /* shown below */ } busy = false; draw(); }, 20);
}

function draw() {
  $('mode-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('kind-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  if (mode === 'build' && kind === 'memory') kind = 'charm';
  $('kind-seg').querySelector('[data-kind="memory"]').disabled = mode === 'build';
  const p = new URLSearchParams();
  if (mode === 'build') p.set('mode', 'build');
  if (kind !== 'charm') p.set('kind', kind);
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);

  const pool = (kind === 'charm' ? db.charms : kind === 'phone' ? db.phone : db.memory)
    .filter((it) => (dlc || !it.dlc) && (!storeOnly || kind !== 'charm' || it.category === 'store'));
  const rows = Object.fromEntries(TIERS.map((t) => [t, []]));
  const unrated = [];
  if (mode === 'base') {
    $('tier-status').textContent = `${pool.length} ${kind === 'charm' ? 'charms' : kind === 'phone' ? 'phone calls' : 'memory cards'}`;
    for (const it of pool) (it.model && rows[it.model.tier] ? rows[it.model.tier] : unrated).push({ it });
  } else {
    if (!buildResult) { runBuild(); $('rows').replaceChildren(); return; }
    const list = (kind === 'phone' ? buildResult.recommendations.phone : buildResult.recommendations.charms).filter((r) => pool.some((x) => x.id === r.id));
    const st = loadLocal();
    const n = list.length;
    const cut = [0.08, 0.28, 0.63, 0.88];
    list.forEach((r, i) => {
      const q = i / Math.max(1, n);
      const t = q < cut[0] ? 'S' : q < cut[1] ? 'A' : q < cut[2] ? 'B' : q < cut[3] ? 'C' : 'D';
      rows[t].push({ it: db.byId.get(r.id), score: r.score });
    });
    const owned = st.charms.length;
    $('tier-status').textContent = owned
      ? `Ranked for your build: ${owned} charm${owned === 1 ? '' : 's'}, deadline ${st.deadline}. Items you already own are left out.`
      : 'Your build is empty, so this ranks picks for a fresh run. Set up your build in the helper for personal tiers.';
  }
  const box = $('rows');
  box.replaceChildren();
  for (const t of TIERS) box.append(row(t, rows[t]));
  if (unrated.length) box.append(row('?', unrated.map((x) => x)));
}

function row(t, entries) {
  const items = entries.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.it.name.localeCompare(b.it.name));
  return h('section', { class: 'tier-row', 'aria-label': t === '?' ? 'Not rated yet' : `Tier ${t}` },
    h('div', { class: 'tier-label', style: { background: TIER_COLORS[t] || '#3a453e', color: t === '?' ? 'var(--bone)' : '#161616' } }, t),
    h('div', { class: 'tier-items' },
      items.length ? items.map(({ it, score }) => {
        const dim = arch && !((it.model && it.model.archetypes) || []).includes(arch);
        return h('button', { class: 'tier-item', type: 'button', style: dim ? { opacity: 0.22 } : null, title: it.model ? it.model.summary : it.name, onclick: () => openItem(db, it.id) },
          itemIcon(it), h('span', {}, it.name), score != null ? h('b', { class: 'sc' }, String(Math.round(score))) : null);
      }) : h('span', { class: 'muted small', style: { alignSelf: 'center' } }, 'Nothing here')));
}
