// Items page: search every charm, phone call and memory card.
import { loadDb, h, itemIcon, itemChips, initChrome, openItem, matches, relevance, toast, sfx } from './common.js';
import { ARCH_LABELS } from '../core/engine.js';
import { loadLocal, saveLocal } from './state.js';

const $ = (id) => document.getElementById(id);
const TIER_ORDER = { S: 0, A: 1, B: 2, C: 3, D: 4 };
const RARITY_ORDER = { Legendary: 0, Rare: 1, Uncommon: 2, Common: 3 };
let db;
const f = { q: '', kind: 'charm', rarity: '', cat: '', arch: '', sort: 'name', dlc: true };

init().catch((e) => { $('count').textContent = 'Could not load items: ' + e.message; });

async function init() {
  initChrome();
  db = await loadDb();
  const p = new URLSearchParams(location.search);
  for (const k of Object.keys(f)) if (p.has(k)) f[k] = k === 'dlc' ? p.get(k) !== '0' : p.get(k);
  if (!['charm', 'phone', 'memory'].includes(f.kind)) f.kind = 'charm';
  const archSel = $('arch');
  for (const [id, label] of Object.entries(ARCH_LABELS)) archSel.append(h('option', { value: id }, label));
  $('q').value = f.q; $('rarity').value = f.rarity; $('cat').value = f.cat; $('arch').value = f.arch; $('sort').value = f.sort; $('dlc').checked = f.dlc;
  $('q').addEventListener('input', (e) => { f.q = e.target.value.trim(); draw(); });
  for (const k of ['rarity', 'cat', 'arch', 'sort']) $(k).addEventListener('change', (e) => { f[k] = e.target.value; draw(); });
  $('dlc').addEventListener('change', (e) => { f.dlc = e.target.checked; draw(); });
  $('kind-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { f.kind = b.dataset.kind; sfx.click(); draw(); }));
  const intro = $('items-intro');
  intro.textContent = `${db.charms.length} lucky charms, ${db.phone.length} phone calls and ${db.memory.length} memory cards, straight from the in-game text.`;
  draw();
  const open = p.get('item');
  if (open && db.byId.has(open)) openItem(db, open, addOpts(db.byId.get(open)));
}

// The add button in the details dialog, chosen by the item's own kind (also for related items).
function addOpts(it) {
  const s = loadLocal();
  const base = { forItem: addOpts };
  if (it.kind === 'memory') {
    if (s.mode.memory === it.id) return { ...base, note: 'This is your memory card' };
    return { ...base, onAdd: (x) => { const st = loadLocal(); st.mode.memory = x.id; saveLocal(st); sfx.add(); toast(`Set ${x.name} as your memory card`); }, addLabel: 'Use this memory card' };
  }
  if (it.kind === 'charm' && s.charms.some((c) => c.id === it.id)) return { ...base, note: 'Already in your build' };
  return {
    ...base,
    addLabel: it.kind === 'phone' ? 'Add to my calls' : 'Add to my build',
    onAdd: (x) => {
      const st = loadLocal();
      if (x.kind === 'charm') {
        if (st.charms.some((c) => c.id === x.id)) { toast(`${x.name} is already in your build`); return; }
        st.charms.push({ id: x.id, trait: null, drawer: false });
      } else st.phone[x.id] = Math.min(99, (st.phone[x.id] || 0) + 1);
      saveLocal(st); sfx.add(); toast(x.kind === 'phone' ? `Added ${x.name} to your calls` : `Added ${x.name} to your build`);
    },
  };
}

function draw() {
  $('kind-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === f.kind)));
  $('cat-wrap').hidden = f.kind !== 'charm';
  const pool = f.kind === 'charm' ? db.charms : f.kind === 'phone' ? db.phone : db.memory;
  let list = pool.filter((it) => {
    if (!f.dlc && it.dlc) return false;
    if (f.rarity && it.rarity !== f.rarity) return false;
    if (f.cat && f.kind === 'charm' && it.category !== f.cat) return false;
    if (f.arch && !((it.model && it.model.archetypes) || []).includes(f.arch)) return false;
    return matches(it, f.q);
  });
  const tier = (it) => (it.model ? TIER_ORDER[it.model.tier] ?? 9 : 9);
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    tier: (a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name),
    cost: (a, b) => (a.cost ?? 99) - (b.cost ?? 99) || a.name.localeCompare(b.name),
    rarity: (a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9) || a.name.localeCompare(b.name),
  };
  const sorter = Object.hasOwn(sorters, f.sort) ? sorters[f.sort] : sorters.name;
  // best matches first only with the default name order; a chosen sort is kept while searching
  const byMatch = f.q && sorter === sorters.name;
  list = list.sort((a, b) => (byMatch ? relevance(a, f.q) - relevance(b, f.q) : 0) || sorter(a, b));
  const grid = $('grid');
  grid.replaceChildren();
  $('count').textContent = `${list.length} ${f.kind === 'charm' ? 'charms' : f.kind === 'phone' ? 'phone calls' : 'memory cards'}`;
  if (!list.length) grid.append(h('p', { class: 'empty-state', style: { gridColumn: '1 / -1' } }, 'Nothing matches these filters. Clear the search or pick "Any".'));
  for (const it of list) {
    grid.append(h('button', { class: `tile ${it.kind} rarity-${it.rarity || ''}`, type: 'button', onclick: () => openItem(db, it.id, addOpts(it)) },
      itemIcon(it), h('div', {}, h('div', { class: 't-name' }, it.name), h('div', { class: 't-meta' }, itemChips(it)))));
  }
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (k === 'dlc') { if (!v) p.set('dlc', '0'); }
    else if (v && !(k === 'kind' && v === 'charm') && !(k === 'sort' && v === 'name')) p.set(k, v);
  }
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}
