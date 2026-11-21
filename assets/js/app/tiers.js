// Tier list page: curated general tiers, or tiers recomputed for the saved build.
import { loadDb, h, itemIcon, initChrome, openItem, sfx } from './common.js';
import { ARCH_LABELS, analyze } from '../core/engine.js';
import { loadLocal, isEmptyBuild, BUILD_KEY } from './state.js';

const $ = (id) => document.getElementById(id);
const TIERS = ['S', 'A', 'B', 'C', 'D'];
const TIER_COLORS = { S: '#ff9f2a', A: '#e0c34f', B: '#73b86d', C: '#5c8fb3', D: '#6f6f6f' };
let db, mode = 'base', kind = 'charm', arch = '', storeOnly = true, dlc = true, buildResult = null, busy = false, failed = false, gen = 0;
const INTRO = {
  base: 'General strength in an average run. Switch to “For my build” to re-rank everything for the build you set up in the helper.',
  build: 'Re-ranked by the helper’s simulator for the build you set up in the helper. Switch to “General” for the overall tiers and for memory cards.',
};

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
  // the build changed in the helper (another tab): rank it again
  window.addEventListener('storage', (e) => {
    if (e.key !== BUILD_KEY && e.key !== null) return;
    gen++; buildResult = null; failed = false;
    if (mode === 'build' && !busy) draw(); // a run still going is thrown away when it ends (see runBuild)
  });
  draw();
}

function runBuild() {
  if (buildResult || busy || failed) return;
  busy = true;
  $('tier-status').innerHTML = '<span class="busy-dot"></span> Simulating your build…';
  const state = loadLocal();
  const g = gen;
  // a result for a build that has changed since (edited in another tab) is thrown away and redone
  const done = (res, err) => {
    busy = false;
    if (g !== gen) { if (mode === 'build') draw(); return; }
    if (err) { failed = true; $('tier-status').textContent = 'The simulator failed for this build. Check your build in the helper.'; return; }
    buildResult = res;
    if (mode === 'build') draw();
  };
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { w.terminate(); done(e.data.res, e.data.error); };
    w.onerror = () => { w.terminate(); fallback(state, done); };
    w.postMessage({ id: 1, state, base: location.href });
  } catch { fallback(state, done); }
}

function fallback(state, done) {
  setTimeout(() => {
    let res = null, err = null;
    try { res = analyze(state, db); } catch (e) { err = e; }
    done(res, err);
  }, 20);
}

function draw() {
  if (mode === 'build' && kind === 'memory') kind = 'charm';
  $('mode-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('kind-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  const memBtn = $('kind-seg').querySelector('[data-kind="memory"]');
  memBtn.disabled = mode === 'build';
  memBtn.title = mode === 'build' ? 'Memory cards are not ranked for a build. Switch to General to see them.' : '';
  $('tier-intro').textContent = INTRO[mode];
  const all = kind === 'charm' ? db.charms : kind === 'phone' ? db.phone : db.memory;
  // for a build only store charms are ranked (they're the ones you can buy)
  const storeView = kind === 'charm' && (storeOnly || mode === 'build');
  const inView = (it) => !storeView || it.category === 'store';
  // no store charm is DLC: then the DLC switch can't change anything
  const dlcMatters = all.some((it) => it.dlc && inView(it));
  $('dlc').disabled = !dlcMatters;
  $('dlc').closest('label').title = dlcMatters ? '' : 'No DLC items in this view';
  $('store-only').disabled = kind !== 'charm' || mode === 'build';
  $('store-only').checked = mode === 'build' ? true : storeOnly;
  $('store-only').closest('label').title = mode === 'build' && kind === 'charm' ? 'For your build only store charms are ranked' : '';
  const p = new URLSearchParams();
  if (mode === 'build') p.set('mode', 'build');
  if (kind !== 'charm') p.set('kind', kind);
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);

  const pool = all.filter((it) => (dlc || !it.dlc) && inView(it));
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
    // describe everything the ranking used, not just the charms (calls, deadline, memory card...)
    const owned = st.charms.length;
    const calls = Object.values(st.phone).reduce((a, x) => a + x, 0);
    const parts = [];
    if (owned) parts.push(`${owned} charm${owned === 1 ? '' : 's'}`);
    if (calls) parts.push(`${calls} phone call${calls === 1 ? '' : 's'}`);
    parts.push(`deadline ${st.deadline}`);
    $('tier-status').textContent = isEmptyBuild({ ...st, offers: [] })
      ? 'Your build is empty, so this ranks picks for a fresh run. Set up your build in the helper for personal tiers.'
      : `Ranked for your build: ${parts.join(', ')}.${owned && kind === 'charm' ? ' Charms you already have are left out.' : ''}`;
  }
  const box = $('rows');
  box.replaceChildren();
  for (const t of TIERS) {
    let empty = 'Nothing here';
    if (mode === 'base' && !rows[t].length && kind === 'charm' && storeOnly && db.charms.some((it) => it.model && it.model.tier === t && (dlc || !it.dlc))) {
      empty = `No store charm is ${t} tier. Untick “Store charms only” to see the special ones.`;
    }
    box.append(row(t, rows[t], empty));
  }
  if (unrated.length) box.append(row('?', unrated.map((x) => x)));
}

function row(t, entries, empty = 'Nothing here') {
  const items = entries.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.it.name.localeCompare(b.it.name));
  return h('section', { class: `tier-row kind-${kind}`, 'aria-label': t === '?' ? 'Not rated yet' : `Tier ${t}` },
    h('div', { class: 'tier-label', style: { background: TIER_COLORS[t] || '#3a453e', color: t === '?' ? 'var(--bone)' : '#161616' } }, t),
    h('div', { class: 'tier-items' },
      items.length ? items.map(({ it, score }) => {
        const dim = arch && !((it.model && it.model.archetypes) || []).includes(arch);
        return h('button', { class: 'tier-item', type: 'button', style: dim ? { opacity: 0.22 } : null, title: it.model ? `${it.name}\n${it.model.summary}` : it.name, onclick: () => openItem(db, it.id) },
          itemIcon(it), h('span', {}, it.name), score != null ? h('b', { class: 'sc' }, String(Math.round(score))) : null);
      }) : h('span', { class: 'muted small', style: { alignSelf: 'center' } }, empty)));
}
