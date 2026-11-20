// Build Helper page.
import {
  loadDb, h, itemIcon, itemChips, initChrome, sfx, openItem, toast, TRAITS, reducedMotion, fmtNum, matches, CATEGORY_LABEL,
} from './common.js';
import { loadLocal, saveLocal, shareUrl, readHashCode, decodeShare, listSaved, saveBuild, deleteSaved, normalize } from './state.js';
import { analyze, defaultState } from '../core/engine.js';
import { SYMBOLS, SYMBOL_NAMES, PATTERNS, PATTERN_NAMES } from '../core/constants.js';

const $ = (id) => document.getElementById(id);
let db, state, result = null, activeTab = 'charms', showAll = false, worker = null, reqId = 0, lastTopKey = '', timer = null;
const PATTERN_ICONS = ['PatternHor', 'PatternVer', 'PatternDiag', 'PatternHorL', 'PatternHorXL', 'PatternZig', 'PatternZag', 'PatternAbove', 'PatternBelow', 'PatternEye', 'PatternJackpot', 'PatternHorS', 'PatternVerS', 'PatternDiagS'];
const SYMBOL_ICONS = ['SymbolLemon', 'SymbolCherry', 'SymbolClover', 'SymbolBell', 'SymbolDiamond', 'SymbolTreasure', 'SymbolSeven'];

init().catch((err) => {
  console.error(err);
  $('status-left').textContent = 'Could not start: ' + err.message;
});

async function init() {
  initChrome();
  db = await loadDb();
  const code = readHashCode();
  if (code) {
    const s = await decodeShare(code);
    if (s) { state = s; saveLocal(state); toast('Loaded a shared build'); }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!state) state = loadLocal();
  setupWorker();
  bindStatic();
  renderBuild();
  renderSaved();
  run(true);
}

// ------------------------------------------------------------------ engine
function setupWorker() {
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => onResult(e.data);
    worker.onerror = () => { worker = null; run(true); };
  } catch { worker = null; }
}

function run(now = false) {
  saveLocal(state);
  clearTimeout(timer);
  const go = () => {
    const id = ++reqId;
    $('status-left').innerHTML = '<span class="busy-dot"></span> Simulating spins…';
    if (worker) worker.postMessage({ id, state: JSON.parse(JSON.stringify(state)), base: location.href });
    else setTimeout(() => {
      try { onResult({ id, res: analyze(state, db) }); } catch (err) { onResult({ id, error: String(err) }); }
    }, 10);
  };
  if (now) go(); else timer = setTimeout(go, 280);
}

function onResult(msg) {
  if (msg.id !== reqId) return;
  if (msg.error) { $('status-left').textContent = 'Something went wrong in the simulator. Try changing a value.'; console.error(msg.error); return; }
  result = msg.res;
  renderResults();
  renderAtm();
  renderBoardsPlaceholders();
  const sims = result.build ? `${result.ms ? result.ms + ' ms' : ''}` : '';
  $('status-left').textContent = describeStatus();
  $('status-right').textContent = sims;
}

function describeStatus() {
  const empty = !state.charms.length && !Object.keys(state.phone).length;
  if (activeTab === 'charms' && state.tickets > 0 && result.recommendations.charms.length) {
    const top = result.recommendations.charms[0];
    const best = result.recommendations.charms.find((x) => x.affordable);
    if (best && best !== top) return `Best you can afford with ${state.tickets} tickets: ${best.name}`;
  }
  if (activeTab === 'phone') return "At the phone? Add its options under What's offered now to compare them.";
  if (empty) return 'General picks for this deadline. Add your charms for personal advice.';
  const a = result.build.archetypes[0];
  return a ? `Reading your ${a.label} build` : 'Reading your build';
}

// ------------------------------------------------------------------ static bindings
function bindStatic() {
  const mem = $('memory');
  for (const m of db.memory) mem.append(h('option', { value: m.id }, m.name + (m.dlc ? ' (DLC)' : '')));
  mem.addEventListener('change', () => { state.mode.memory = mem.value; sfx.click(); renderBuild(); run(); });
  $('deadline').addEventListener('input', (e) => { const v = Math.round(+e.target.value); if (v >= 1) { state.deadline = Math.min(30, v); run(); renderAtmDeadline(); } });
  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    state.deadline = Math.max(1, Math.min(30, (state.deadline || 1) + +b.dataset.step));
    $('deadline').value = state.deadline; sfx.click(); renderAtmDeadline(); run();
  }));
  const numField = (id, key) => $(id).addEventListener('input', (e) => { const v = e.target.value; state[key] = v === '' ? (key === 'tickets' ? 0 : null) : Math.max(0, +v); run(); });
  numField('tickets', 'tickets'); numField('coins', 'coins'); numField('deposited', 'deposited');
  for (const k of ['hard', 'sacred', 'dlc']) $(k).addEventListener('change', (e) => { state.mode[k] = e.target.checked; sfx.click(); run(); renderBuild(); });
  $('add-call').addEventListener('click', () => openPicker('phone'));
  $('horizon').addEventListener('input', (e) => { state.prefs.horizon = +e.target.value; run(); });
  $('lever').addEventListener('click', () => {
    sfx.lever();
    $('lever').classList.add('pulled');
    setTimeout(() => $('lever').classList.remove('pulled'), 300);
    lastTopKey = '';
    if (result) renderReels(true);
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = ['charms', 'phone', 'offers'];
    const i = (tabs.indexOf(activeTab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
    selectTab(tabs[i]); $('tab-' + tabs[i]).focus();
  });
  $('show-more').addEventListener('click', () => { showAll = !showAll; renderResults(); });
  $('add-offer-charm').addEventListener('click', () => openPicker('offer-charm'));
  $('add-offer-phone').addEventListener('click', () => openPicker('offer-phone'));
  $('clear-offers').addEventListener('click', () => { state.offers = []; run(); renderResults(); });
  $('copy-link').addEventListener('click', async () => {
    const url = await shareUrl(state);
    try { await navigator.clipboard.writeText(url); toast('Share link copied'); } catch { prompt('Copy this link:', url); }
  });
  $('save-build').addEventListener('click', () => {
    const name = prompt('Name this build', suggestName());
    if (!name) return;
    saveBuild(name.slice(0, 60), state); renderSaved(); toast(`Saved “${name}”`);
  });
  $('new-run').addEventListener('click', () => {
    if (!confirm('Start a new run? Your current build will be cleared (saved builds stay).')) return;
    state = defaultState(); renderBuild(); run(true); toast('New run started');
  });
  $('reset-stats').addEventListener('click', () => { state.stats = {}; renderBuild(); run(); });
  for (const [id, key] of [['sm', 'sm'], ['pm', 'pm'], ['interest', 'interest'], ['charmspace', 'charmSpace']]) {
    $(id).addEventListener('input', (e) => { setStat(null, key, e.target.value); e.target.classList.toggle('overridden', e.target.value !== ''); run(); });
  }
}

function suggestName() {
  const a = result && result.build.archetypes[0];
  return `${a ? a.label : 'My'} build, deadline ${state.deadline}`;
}

function setStat(group, key, raw) {
  const v = raw === '' ? null : +raw;
  if (group) {
    state.stats[group] = state.stats[group] || {};
    if (v === null || !Number.isFinite(v)) delete state.stats[group][key]; else state.stats[group][key] = v;
    if (!Object.keys(state.stats[group]).length) delete state.stats[group];
  } else if (v === null || !Number.isFinite(v)) delete state.stats[key]; else state.stats[key] = v;
}

// ------------------------------------------------------------------ build panel
function renderBuild() {
  $('memory').value = state.mode.memory || 'erased_memory_card';
  const memIt = db.byId.get(state.mode.memory);
  $('memory-art').src = (memIt && memIt.icon) || 'assets/icons/memory/erased_memory_card.webp';
  $('deadline').value = state.deadline;
  $('tickets').value = state.tickets || 0;
  $('coins').value = state.coins ?? '';
  $('deposited').value = state.deposited ?? '';
  $('hard').checked = !!state.mode.hard;
  $('sacred').checked = !!state.mode.sacred;
  $('dlc').checked = state.mode.dlc !== false;
  $('horizon').value = state.prefs.horizon ?? 0.7;
  renderSockets();
  renderCalls();
  renderBoards();
  renderAtmDeadline();
}

function charmSpace() {
  return (result && result.build.charmSpace) || 7;
}

function renderSockets() {
  const box = $('sockets');
  box.replaceChildren();
  const onTable = state.charms.filter((c) => !c.drawer);
  const used = onTable.filter((c) => !(db.byId.get(c.id) || {}).noSpace).length;
  const space = Math.max(charmSpace(), used);
  for (const c of state.charms) {
    const it = db.byId.get(c.id);
    if (!it) continue;
    const tr = TRAITS.find((t) => t.id === c.trait);
    const el = h('button', { class: `socket${c.drawer ? ' drawer' : ''}`, type: 'button', title: `${it.name}${tr ? ' (' + tr.name + ')' : ''}${c.drawer ? ' (in a drawer)' : ''}`, onclick: () => openCharmMenu(c) },
      itemIcon(it),
      tr ? h('span', { class: 'trait-dot', style: { background: tr.color, color: tr.color } }) : null,
      c.drawer ? h('span', { class: 'badge' }, 'drawer') : null);
    box.append(el);
  }
  for (let i = used; i < space; i++) {
    box.append(h('button', { class: 'socket empty', type: 'button', 'aria-label': 'Add a charm', onclick: () => openPicker('charm') }, '+'));
  }
  if (used >= space) box.append(h('button', { class: 'socket empty', type: 'button', 'aria-label': 'Add a charm', title: 'Add a charm (table is full)', onclick: () => openPicker('charm') }, '+'));
  $('space-count').textContent = `${used}/${space}`;
}

function renderCalls() {
  const ul = $('calls');
  ul.replaceChildren();
  const entries = Object.entries(state.phone).filter(([, n]) => n > 0);
  if (!entries.length) ul.append(h('li', { class: 'note', style: { margin: 0 } }, 'No calls yet. The phone rings from deadline 2.'));
  for (const [id, n] of entries) {
    const it = db.byId.get(id);
    if (!it) continue;
    const set = (v) => { if (v <= 0) delete state.phone[id]; else state.phone[id] = v; renderCalls(); run(); };
    ul.append(h('li', { class: `call ${it.type}` },
      h('button', { class: 'link-btn', type: 'button', style: { textDecoration: 'none' }, 'aria-label': `Details: ${it.name}`, onclick: () => openItem(db, id) }, itemIcon(it)),
      h('span', { class: 'call-name' }, it.name),
      h('span', { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': 'Fewer', onclick: () => { sfx.remove(); set(n - 1); } }, '−'),
        h('input', { class: 'input num', type: 'number', min: '0', value: String(n), 'aria-label': `Times taken: ${it.name}`, oninput: (e) => set(Math.max(0, Math.round(+e.target.value || 0))) }),
        h('button', { type: 'button', 'aria-label': 'More', onclick: () => { sfx.add(); set(n + 1); } }, '+'))));
  }
}

function renderBoards() {
  const sb = $('symbols-board');
  sb.replaceChildren(h('div', { class: 'board-head' }, h('span'), h('span', {}, 'Symbol'), h('span', {}, 'Value'), h('span', {}, 'Chance %')));
  SYMBOLS.forEach((s, i) => {
    const v = state.stats.values && state.stats.values[s];
    const c = state.stats.chances && state.stats.chances[s];
    sb.append(h('div', { class: 'board-row' },
      h('img', { src: `assets/icons/game/${SYMBOL_ICONS[i]}.webp`, alt: '' }),
      h('span', {}, SYMBOL_NAMES[i]),
      h('input', { class: `input num${v != null ? ' overridden' : ''}`, type: 'number', step: 'any', min: '0', value: v ?? '', 'data-sym-val': s, 'aria-label': `${SYMBOL_NAMES[i]} value`, oninput: (e) => { setStat('values', s, e.target.value); e.target.classList.toggle('overridden', e.target.value !== ''); run(); } }),
      h('input', { class: `input num${c != null ? ' overridden' : ''}`, type: 'number', step: 'any', min: '0', value: c ?? '', 'data-sym-chance': s, 'aria-label': `${SYMBOL_NAMES[i]} chance percent`, oninput: (e) => { setStat('chances', s, e.target.value); e.target.classList.toggle('overridden', e.target.value !== ''); run(); } })));
  });
  const pb = $('patterns-board');
  pb.replaceChildren(h('div', { class: 'board-head', style: { gridTemplateColumns: '52px 1fr 84px' } }, h('span'), h('span', {}, 'Pattern'), h('span', {}, 'Value ×')));
  PATTERNS.forEach((p, i) => {
    if (i >= 11) return; // size-2 patterns only exist with Angel's Hand
    const v = state.stats.patterns && state.stats.patterns[p];
    pb.append(h('div', { class: 'board-row pat' },
      h('img', { src: `assets/icons/game/${PATTERN_ICONS[i]}.webp`, alt: '' }),
      h('span', {}, PATTERN_NAMES[i]),
      h('input', { class: `input num${v != null ? ' overridden' : ''}`, type: 'number', step: 'any', min: '0', value: v ?? '', 'data-pat': p, 'aria-label': `${PATTERN_NAMES[i]} value`, oninput: (e) => { setStat('patterns', p, e.target.value); e.target.classList.toggle('overridden', e.target.value !== ''); run(); } })));
  });
  for (const [id, key] of [['sm', 'sm'], ['pm', 'pm'], ['interest', 'interest'], ['charmspace', 'charmSpace']]) {
    $(id).value = state.stats[key] ?? '';
    $(id).classList.toggle('overridden', state.stats[key] != null);
  }
}

function renderBoardsPlaceholders() {
  if (!result) return;
  const b = result.build;
  SYMBOLS.forEach((s, i) => {
    const vi = document.querySelector(`[data-sym-val="${s}"]`);
    const ci = document.querySelector(`[data-sym-chance="${s}"]`);
    if (vi) vi.placeholder = fmtNum(b.values[i]);
    if (ci) ci.placeholder = (b.chances[i] * 100).toFixed(1);
  });
  PATTERNS.forEach((p, i) => { const el = document.querySelector(`[data-pat="${p}"]`); if (el) el.placeholder = fmtNum(b.patVals[i]); });
  $('sm').placeholder = fmtNum(b.SM); $('pm').placeholder = fmtNum(b.PM);
  $('interest').placeholder = fmtNum(b.interest); $('charmspace').placeholder = String(b.charmSpace);
  renderSockets();
}

// ------------------------------------------------------------------ dialogs: picker & charm menu
let pickerDialog = null;
function openPicker(mode) {
  // mode: charm | phone | offer-charm | offer-phone
  if (!pickerDialog) {
    pickerDialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'picker-title' });
    pickerDialog.addEventListener('click', (e) => { if (e.target === pickerDialog) pickerDialog.close(); });
    document.body.append(pickerDialog);
  }
  const isPhone = mode === 'phone' || mode === 'offer-phone';
  const title = { charm: 'Add a charm to your table', phone: 'Add a phone call you took', 'offer-charm': 'What is in the store?', 'offer-phone': 'What is the phone offering?' }[mode];
  let q = '', group = 'all';
  const groupsCharm = [['all', 'All'], ['Common', 'Common'], ['Uncommon', 'Uncommon'], ['Rare', 'Rare'], ['Legendary', 'Legendary'], ['special', 'Special']];
  const groupsPhone = [['all', 'All'], ['normal', 'Normal'], ['red', 'Red'], ['sacred', 'Sacred']];
  const groups = isPhone ? groupsPhone : groupsCharm;
  const grid = h('div', { class: 'item-grid' });
  const search = h('input', { class: 'input', type: 'search', placeholder: isPhone ? 'Search calls: lemon, double, trait…' : 'Search charms: lemon, luck, 666, retrigger…', 'aria-label': 'Search' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' });
  const owned = new Set(state.charms.map((c) => c.id));
  const draw = () => {
    grid.replaceChildren();
    const list = (isPhone ? db.phone : db.charms).filter((it) => {
      if (!isPhone) {
        if (group === 'special') { if (it.category === 'store') return false; }
        else if (group !== 'all' && it.rarity !== group) return false;
        if (mode === 'offer-charm' && it.category !== 'store') return false;
      } else if (group !== 'all' && it.type !== group) return false;
      if (state.mode.dlc === false && it.dlc) return false;
      return matches(it, q);
    });
    if (!list.length) grid.append(h('p', { class: 'empty-state' }, 'Nothing matches. Try a shorter word.'));
    for (const it of list) {
      grid.append(h('button', { class: `tile ${it.kind} rarity-${it.rarity || ''}${owned.has(it.id) && mode === 'charm' ? ' owned' : ''}`, type: 'button', onclick: () => pick(it) },
        itemIcon(it), h('div', {}, h('div', { class: 't-name' }, it.name), h('div', { class: 't-meta' }, itemChips(it, { tier: false })))));
    }
  };
  const pick = (it) => {
    sfx.add();
    if (mode === 'charm') {
      if (state.charms.some((c) => c.id === it.id)) { toast(`${it.name} is already on your table`); return; }
      state.charms.push({ id: it.id, trait: null, drawer: false });
      renderSockets(); toast(`Added ${it.name}`);
    } else if (mode === 'phone') {
      state.phone[it.id] = (state.phone[it.id] || 0) + 1; renderCalls(); toast(`Added ${it.name}`);
    } else {
      state.offers.push({ id: it.id, price: it.kind === 'charm' ? it.cost : null });
      selectTab('offers'); toast(`Added offer: ${it.name}`);
    }
    run();
    if (mode !== 'charm' && mode !== 'phone') pickerDialog.close();
  };
  for (const [g, label] of groups) {
    const b = h('button', { type: 'button', 'aria-pressed': String(g === group), onclick: () => { group = g; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); } }, label);
    seg.append(b);
  }
  search.addEventListener('input', () => { q = search.value.trim(); draw(); });
  pickerDialog.replaceChildren(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'picker-title' }, title), h('button', { class: 'close-btn', type: 'button', 'aria-label': 'Close', onclick: () => pickerDialog.close() }, '×')),
    h('div', { class: 'sheet-body' }, h('div', { class: 'filters' }, search, seg), grid),
  );
  draw();
  pickerDialog.showModal();
  search.focus();
}

let menuDialog = null;
function openCharmMenu(c) {
  const it = db.byId.get(c.id);
  if (!it) return;
  if (!menuDialog) {
    menuDialog = h('dialog', { class: 'sheet', style: { width: 'min(460px, calc(100vw - 24px))' }, 'aria-labelledby': 'menu-title' });
    menuDialog.addEventListener('click', (e) => { if (e.target === menuDialog) menuDialog.close(); });
    document.body.append(menuDialog);
  }
  const traitSel = h('select', { class: 'select', 'aria-label': 'Trait' },
    h('option', { value: '' }, 'No trait'),
    TRAITS.map((t) => h('option', { value: t.id, selected: c.trait === t.id }, `${t.name}: ${t.effect}`)));
  traitSel.addEventListener('change', () => { c.trait = traitSel.value || null; renderSockets(); run(); });
  menuDialog.replaceChildren(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'menu-title' }, it.name), h('button', { class: 'close-btn', type: 'button', 'aria-label': 'Close', onclick: () => menuDialog.close() }, '×')),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
        h('div', { class: 'socket', style: { width: '84px', flex: 'none' } }, itemIcon(it)),
        h('div', {}, h('p', { style: { margin: '0 0 8px' } }, (it.model && it.model.summary) || ''), h('div', { class: 'row' }, itemChips(it)))),
      h('label', { class: 'field', style: { marginTop: '14px' } }, h('span', {}, 'Trait on this charm'), traitSel),
      h('div', { class: 'row', style: { marginTop: '14px' } },
        h('button', { class: 'btn', type: 'button', onclick: () => { c.drawer = !c.drawer; sfx.click(); renderSockets(); run(); menuDialog.close(); } }, c.drawer ? 'Put back on the table' : 'Move to a drawer'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { menuDialog.close(); openItem(db, it.id); } }, 'Details'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.charms = state.charms.filter((x) => x !== c); sfx.remove(); renderSockets(); run(); menuDialog.close(); } }, 'Remove'))),
  );
  menuDialog.showModal();
}

// ------------------------------------------------------------------ results
function selectTab(tab) {
  activeTab = tab; showAll = false;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  $('offers-bar').hidden = tab !== 'offers';
  $('machine-mode').textContent = { charms: 'Charms', phone: 'Phone calls', offers: "What's offered now" }[tab];
  if (tab === 'phone') sfx.ring();
  renderResults();
  lastTopKey = '';
  renderReels(true);
  if (result) $('status-left').textContent = describeStatus();
}

function currentList() {
  if (!result) return [];
  if (activeTab === 'offers') return result.offers;
  return activeTab === 'phone' ? result.recommendations.phone : result.recommendations.charms;
}

function renderResults() {
  if (!result) return;
  $('n-charms').textContent = String(result.recommendations.charms.length);
  $('n-phone').textContent = String(result.recommendations.phone.length);
  $('n-offers').textContent = state.offers.length ? String(state.offers.length) : '';
  const list = currentList();
  const ol = $('picks');
  ol.replaceChildren();
  if (activeTab === 'offers' && !state.offers.length) {
    ol.append(h('li', { class: 'empty-state' }, 'Type in what the store or the phone is showing you right now, and the picks get ranked against each other, including the price.'));
    $('show-more').hidden = true;
    renderReels();
    return;
  }
  const max = showAll ? list.length : 12;
  list.slice(0, max).forEach((r, i) => ol.append(renderPick(r, i)));
  $('show-more').hidden = list.length <= 12;
  $('show-more').textContent = showAll ? 'Show fewer' : `Show all ${list.length}`;
  renderReels();
}

function renderPick(r, i) {
  const it = db.byId.get(r.id);
  const seg = Math.max(0, Math.min(10, Math.round(r.score / 10)));
  const meter = h('div', { class: 'meter', title: `Score ${Math.round(r.score)}` }, Array.from({ length: 10 }, (_, k) => h('i', { class: k < seg ? 'on' : '' })));
  const takeLabel = r.kind === 'phone' ? 'Took it' : 'Bought it';
  const take = () => {
    if (r.kind === 'charm') { if (!state.charms.some((c) => c.id === r.id)) state.charms.push({ id: r.id, trait: null, drawer: false }); state.tickets = Math.max(0, (state.tickets || 0) - (r.price || 0)); }
    else state.phone[r.id] = (state.phone[r.id] || 0) + 1;
    if (activeTab === 'offers') state.offers = state.offers.filter((o) => o.id !== r.id);
    sfx.win(); renderBuild(); run(); toast(r.kind === 'phone' ? `Added call: ${r.name}` : `Bought ${r.name}`);
  };
  const offer = activeTab === 'offers' ? state.offers.find((o) => o.id === r.id) : null;
  const chips = itemChips(it, { tickets: state.tickets, price: r.price });
  return h('li', { class: 'pick' },
    h('span', { class: 'rank' }, String(i + 1)),
    h('button', { class: 'art', type: 'button', 'aria-label': `Details: ${r.name}`, onclick: () => openItem(db, r.id, { onAdd: take, addLabel: takeLabel }) }, itemIcon(it)),
    h('div', {},
      h('h4', {}, h('button', { type: 'button', onclick: () => openItem(db, r.id, { onAdd: take, addLabel: takeLabel }) }, r.name), chips),
      r.kind === 'charm' && !r.affordable && state.tickets > 0 ? h('div', { class: 'small', style: { color: '#ffb3aa' } }, `Costs ${r.price}, you have ${state.tickets} tickets`) : null,
      h('ul', { class: 'why' }, (r.reasons || []).slice(0, i < 3 ? 6 : 4).map((x) => h('li', { class: x.kind }, x.text))),
      offer && r.kind === 'charm' ? h('label', { class: 'small row', style: { marginTop: '6px', gap: '6px' } }, 'Price in store', h('input', { class: 'input num', style: { width: '72px', height: '28px', fontSize: '17px' }, type: 'number', min: '0', value: offer.price ?? '', oninput: (e) => { offer.price = e.target.value === '' ? null : +e.target.value; run(); } })) : null,
    ),
    h('div', { class: 'side' }, meter, h('span', { class: 'score' }, String(Math.round(r.score))),
      h('button', { class: 'btn small', type: 'button', onclick: take }, takeLabel),
      offer ? h('button', { class: 'link-btn', type: 'button', onclick: () => { state.offers = state.offers.filter((o) => o !== offer); run(); } }, 'Remove offer') : null),
  );
}

// ------------------------------------------------------------------ reels
function renderReels(force = false) {
  const list = currentList();
  const top = list.slice(0, 3);
  const key = activeTab + ':' + top.map((x) => x.id).join(',');
  const reels = $('reels'), labels = $('reel-labels');
  if (!top.length) {
    reels.replaceChildren();
    labels.replaceChildren(h('div', { class: 'screen-empty', style: { gridColumn: '1 / -1' } }, activeTab === 'offers' ? 'Waiting for offers' : 'Nothing to show', h('small', {}, activeTab === 'offers' ? 'Add what the store or phone shows you below.' : 'Add items to your build.')));
    return;
  }
  const changed = key !== lastTopKey;
  lastTopKey = key;
  const pool = (activeTab === 'phone' ? db.phone : db.charms).filter((x) => x.icon);
  const animate = (changed || force) && !reducedMotion();
  reels.replaceChildren();
  labels.replaceChildren();
  top.forEach((r, i) => {
    const it = db.byId.get(r.id);
    const n = 14 + i * 4;
    const strip = h('div', { class: 'reel-strip' });
    for (let k = 0; k < n; k++) strip.append(h('div', { class: 'reel-cell' }, itemIcon(pool[(k * 7 + i * 13 + (Date.now() >> 6)) % pool.length])));
    strip.append(h('div', { class: 'reel-cell' }, itemIcon(it)));
    strip.append(h('div', { class: 'reel-cell' }, itemIcon(pool[(i * 5 + 3) % pool.length])));
    const reel = h('div', { class: 'reel' }, strip, h('div', { class: 'reel-payline' }));
    reels.append(reel);
    labels.append(h('div', { class: 'reel-label' },
      h('div', { class: 'name' }, h('span', { class: 'rank' }, String(i + 1)), r.name),
      h('div', { class: 'meta' }, metaLine(r))));
    const cellH = () => strip.firstChild.getBoundingClientRect().height || 98;
    const finalY = () => -(n * cellH() - (reel.clientHeight - cellH()) / 2);
    if (!animate) { requestAnimationFrame(() => { strip.style.transform = `translateY(${finalY()}px)`; }); return; }
    reel.classList.add('spinning');
    strip.style.transform = 'translateY(0px)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const dur = 700 + i * 320;
      strip.style.transition = `transform ${dur}ms cubic-bezier(.15,.75,.3,1.08)`;
      strip.style.transform = `translateY(${finalY()}px)`;
      setTimeout(() => { reel.classList.remove('spinning'); sfx.stop(); if (i === top.length - 1) sfx.win(); }, dur);
    }));
  });
  if (animate) {
    let t = 0;
    const iv = setInterval(() => { sfx.tick(); if ((t += 70) > 700 + (top.length - 1) * 320) clearInterval(iv); }, 70);
  }
}

function metaLine(r) {
  const v = r.value || {};
  if (v.horizon && Math.abs(v.horizon - 1) > 0.01) {
    const pct = Math.round((v.horizon - 1) * 100);
    return `${pct >= 0 ? '+' : ''}${pct}% coins over ${result.build.horizonRounds} rounds`;
  }
  if (v.ticketsPerDeadline > 0.5) return `+${v.ticketsPerDeadline.toFixed(1)} tickets per deadline`;
  return r.tier ? `Tier ${r.tier} pick` : 'Situational pick';
}

// ------------------------------------------------------------------ ATM
function renderAtmDeadline() { $('led-deadline').textContent = String(state.deadline); }

function renderAtm() {
  const b = result.build, c = result.check;
  renderAtmDeadline();
  $('led-debt').textContent = fmtNum(c.debt);
  $('led-expected').textContent = fmtNum(c.expectedPerDeadline);
  $('led-ev').textContent = fmtNum(b.ev);
  const lamp = $('lamp');
  const emptyBuild = !state.charms.length && !Object.keys(state.phone).length && !Object.keys(state.stats).length;
  if (emptyBuild) {
    lamp.className = 'lamp';
    $('status-text').textContent = 'Add your charms, calls or in-game numbers to check this deadline.';
  }
  lamp.className = emptyBuild ? 'lamp' : 'lamp ' + c.status;
  const text = {
    safe: `On track: about ${c.ratio.toFixed(1)}× the debt. Good time to invest in scaling.`,
    ok: 'Should make it, but without much room to spare.',
    tight: `Tight: you're expected to reach about ${Math.round(c.ratio * 100)}% of the debt. Favour picks that pay now.`,
    danger: `At risk: only about ${Math.round(c.ratio * 100)}% of the debt. Move the slider toward "Survive this deadline".`,
  }[c.status] || '';
  if (!emptyBuild) $('status-text').textContent = text;

  const bars = $('sym-bars');
  bars.replaceChildren();
  const order = SYMBOLS.map((s, i) => i).sort((a, b2) => b.symShare[b2] - b.symShare[a]);
  for (const i of order) {
    const pct = Math.max(0, b.symShare[i] * 100);
    bars.append(h('div', { class: 'bar-row', title: `${SYMBOL_NAMES[i]}: value ${fmtNum(b.values[i])}, chance ${(b.chances[i] * 100).toFixed(1)}%` },
      h('img', { src: `assets/icons/game/${SYMBOL_ICONS[i]}.webp`, alt: SYMBOL_NAMES[i] }),
      h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, pct)}%` } })),
      h('span', { class: 'pct' }, `${Math.round(pct)}%`)));
  }
  const odds = $('odds');
  odds.replaceChildren(
    odd(`${Math.round((1 - b.pNone) * 100)}%`, 'chance to score'),
    odd(`${(b.pAtLeast3 * 100).toFixed(1)}%`, '3+ patterns'),
    odd(`${(b.pJackpot * 100).toFixed(2)}%`, 'jackpot'),
    odd(`${(b.p666 * 100).toFixed(1)}%`, b.protect666 > 0 ? `666 (${Math.round(b.protect666 * 100)}% blocked)` : '666 chance'),
    odd(b.luckAvg.toFixed(1), 'average luck'),
    odd(fmtNum(b.evRound), 'coins per round'),
  );
  const arch = $('arch');
  arch.replaceChildren();
  const archList = b.archetypes.slice(0, 5);
  if (!archList.length) arch.append(h('span', { class: 'muted small' }, 'Not enough charms to tell yet.'));
  for (const a of archList) arch.append(h('span', { class: 'chip', title: `${Math.round(a.weight * 100)}%` }, a.label));

  const owned = $('owned');
  owned.replaceChildren();
  if (!result.owned.length) owned.append(h('li', { class: 'muted small', style: { display: 'block' } }, 'Add charms to see how much each one is worth.'));
  for (const o of result.owned) {
    const it = db.byId.get(o.id);
    const pct = Math.round((o.horizon - 1) * 100);
    owned.append(h('li', { title: (o.reasons || []).map((r) => r.text).join('\n') },
      itemIcon(it), h('button', { class: 'link-btn', type: 'button', style: { color: 'var(--bone)', textDecoration: 'none', textAlign: 'left' }, onclick: () => openItem(db, o.id) }, o.name),
      h('span', { class: `val${pct < 0 ? ' neg' : ''}` }, Math.abs(pct) >= 1 ? `${pct > 0 ? '+' : ''}${pct}%` : `${Math.round(o.score)} pts`)));
  }
  const weak = $('weakest');
  weak.replaceChildren();
  if (result.weakest) {
    const top = result.recommendations.charms[0];
    weak.append(h('p', { class: 'warn' }, `Your table is full. The weakest charm is ${result.weakest.name}${top && top.score > result.weakest.score ? `; ${top.name} scores higher, so consider replacing it.` : '.'}`));
  }
}

function odd(big, label) { return h('div', { class: 'odd' }, h('b', {}, big), h('span', {}, label)); }

// ------------------------------------------------------------------ saved builds
function renderSaved() {
  const box = $('saved-list');
  box.replaceChildren();
  const list = listSaved();
  if (!list.length) return;
  box.append(h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'Saved builds'));
  for (const s of list.slice(0, 8)) {
    box.append(h('div', { class: 'row', style: { gap: '8px', justifyContent: 'space-between' } },
      h('button', { class: 'link-btn', type: 'button', onclick: () => { state = normalize(s.state); renderBuild(); run(true); toast(`Loaded “${s.name}”`); } }, s.name),
      h('button', { class: 'link-btn', type: 'button', style: { color: 'var(--grime)' }, 'aria-label': `Delete ${s.name}`, onclick: () => { deleteSaved(s.name); renderSaved(); } }, 'Delete')));
  }
}
