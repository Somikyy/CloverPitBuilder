// Build Helper page.
import {
  loadDb, h, itemIcon, itemChips, initChrome, sfx, openItem, toast, TRAITS, reducedMotion, fmtNum, matches, relevance,
  keepFocus, returnFocusOnClose,
} from './common.js';
import { loadLocal, saveLocal, shareUrl, readHashCode, decodeShare, listSaved, saveBuild, deleteSaved, normalize } from './state.js';
import { analyze, defaultState } from '../core/engine.js';
import { SYMBOLS, SYMBOL_NAMES, PATTERNS, PATTERN_NAMES } from '../core/constants.js';

const $ = (id) => document.getElementById(id);
let db, state, result = null, activeTab = 'charms', showAll = false, worker = null, reqId = 0, lastTopKey = '', timer = null;
const PATTERN_ICONS = ['PatternHor', 'PatternVer', 'PatternDiag', 'PatternHorL', 'PatternHorXL', 'PatternZig', 'PatternZag', 'PatternAbove', 'PatternBelow', 'PatternEye', 'PatternJackpot', 'PatternHorS', 'PatternVerS', 'PatternDiagS'];
const SYMBOL_ICONS = ['SymbolLemon', 'SymbolCherry', 'SymbolClover', 'SymbolBell', 'SymbolDiamond', 'SymbolTreasure', 'SymbolSeven'];
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

init().catch((err) => {
  console.error(err);
  $('status-left').textContent = 'Could not start: ' + err.message;
});

async function init() {
  initChrome();
  db = await loadDb();
  state = loadLocal();
  await loadFromHash(true);
  setupWorker();
  bindStatic();
  renderBuild();
  renderSaved();
  run(true);
  window.addEventListener('hashchange', () => { loadFromHash(false); });
}

function isEmptyBuild(s) {
  return !s.charms.length && !Object.keys(s.phone).length && !Object.keys(s.stats).length && !s.offers.length && s.deadline === 1 && !s.tickets;
}

// A share link (#b=...) replaces the current build. A build in progress is kept in Saved builds first.
async function loadFromHash(first) {
  const code = readHashCode();
  if (!code) return;
  history.replaceState(null, '', location.pathname + location.search);
  const s = await decodeShare(code);
  if (!s) { toast('This share link is incomplete or broken, so nothing was loaded.'); return; }
  const cur = normalize(state);
  if (JSON.stringify(cur) === JSON.stringify(s)) { if (!first) toast('This build is already open'); return; }
  const keep = !isEmptyBuild(cur);
  if (keep) {
    const when = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    saveBuild(`My build before a shared link (${when})`, cur);
  }
  state = s;
  saveLocal(state);
  toast(keep ? 'Loaded a shared build. Your own build is under Saved builds.' : 'Loaded a shared build');
  if (!first) { renderBuild(); renderSaved(); run(true); }
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
  renderCallsNote();
  $('status-left').textContent = describeStatus();
  $('status-right').textContent = result.ms ? `${result.ms} ms` : '';
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
// A number box: typing updates the build at once; leaving the box writes back the value actually used
// (clamped, rounded), so the box never shows a number the helper isn't using.
function numberBox(el, { get, set, int = false, min = 0, max = Infinity, empty = 'keep', after = null }) {
  el.addEventListener('input', () => {
    if (el.value === '') {
      if (empty === 'keep') return;
      set(empty === 'zero' ? 0 : null);
    } else {
      const v = +el.value;
      if (!Number.isFinite(v)) return;
      set(clampNum(int ? Math.round(v) : v, min, max));
    }
    if (after) after();
    run();
  });
  el.addEventListener('change', () => { const v = get(); el.value = v ?? ''; });
}

function bindStatic() {
  const mem = $('memory');
  for (const m of db.memory) mem.append(h('option', { value: m.id }, m.name + (m.dlc ? ' (DLC)' : '')));
  mem.addEventListener('change', () => { state.mode.memory = mem.value; sfx.click(); renderBuild(); run(); });
  numberBox($('deadline'), { get: () => state.deadline, set: (v) => { state.deadline = v; }, int: true, min: 1, max: 30, after: renderAtmDeadline });
  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    state.deadline = clampNum((state.deadline || 1) + +b.dataset.step, 1, 30);
    $('deadline').value = state.deadline; sfx.click(); renderAtmDeadline(); run();
  }));
  numberBox($('tickets'), { get: () => state.tickets, set: (v) => { state.tickets = v; }, int: true, empty: 'zero', max: 99999 });
  numberBox($('coins'), { get: () => state.coins, set: (v) => { state.coins = v; }, empty: 'null' });
  numberBox($('deposited'), { get: () => state.deposited, set: (v) => { state.deposited = v; }, empty: 'null' });
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
    saveBuild(name.slice(0, 60), state); renderSaved(); toast(`Saved “${name.slice(0, 60)}”`);
  });
  $('new-run').addEventListener('click', () => {
    if (!confirm('Start a new run? Your current build will be cleared (saved builds stay).')) return;
    state = defaultState(); renderBuild(); run(true); toast('New run started');
  });
  $('reset-stats').addEventListener('click', () => { state.stats = {}; renderBuild(); run(); });
  for (const [id, key] of [['sm', 'sm'], ['pm', 'pm'], ['interest', 'interest'], ['charmspace', 'charmSpace']]) statBox($(id), null, key, key === 'charmSpace');
}

function suggestName() {
  const a = result && result.build.archetypes[0];
  return `${a ? a.label : 'My'} build, deadline ${state.deadline}`;
}

function getStat(group, key) {
  return group ? (state.stats[group] ? state.stats[group][key] : undefined) : state.stats[key];
}

function setStat(group, key, raw, int = false) {
  let v = raw === '' || raw === null ? null : +raw;
  if (v !== null && Number.isFinite(v)) v = Math.max(0, int ? Math.round(v) : v);
  if (group) {
    state.stats[group] = state.stats[group] || {};
    if (v === null || !Number.isFinite(v)) delete state.stats[group][key]; else state.stats[group][key] = v;
    if (!Object.keys(state.stats[group]).length) delete state.stats[group];
  } else if (v === null || !Number.isFinite(v)) delete state.stats[key]; else state.stats[key] = v;
}

// An in-game number box: empty means "use the calculated value" (shown in grey).
function statBox(el, group, key, int = false) {
  el.addEventListener('input', () => { setStat(group, key, el.value, int); el.classList.toggle('overridden', getStat(group, key) != null); run(); });
  el.addEventListener('change', () => { el.value = getStat(group, key) ?? ''; });
  return el;
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
  if (result && Number.isFinite(result.build.charmSpace)) return result.build.charmSpace;
  return state.stats.charmSpace ?? 7;
}

function spaceUsed() {
  return state.charms.filter((c) => !c.drawer && !(db.byId.get(c.id) || {}).noSpace).length;
}

function renderSockets() {
  const box = $('sockets');
  const used = spaceUsed();
  const space = charmSpace();
  keepFocus(box, () => {
    box.replaceChildren();
    for (const c of state.charms) {
      const it = db.byId.get(c.id);
      if (!it) continue;
      const tr = TRAITS.find((t) => t.id === c.trait);
      box.append(h('button', {
        class: `socket${c.drawer ? ' drawer' : ''}`, type: 'button', 'data-fkey': `socket:${c.id}`,
        title: `${it.name}${tr ? ' (' + tr.name + ')' : ''}${c.drawer ? ' (in a drawer)' : ''}`, 'aria-label': `${it.name}${tr ? ', ' + tr.name : ''}${c.drawer ? ', in a drawer' : ''}`,
        onclick: () => openCharmMenu(c),
      },
      itemIcon(it),
      tr ? h('span', { class: 'trait-dot', style: { background: tr.color, color: tr.color } }) : null,
      c.drawer ? h('span', { class: 'badge' }, 'drawer') : null));
    }
    const free = Math.max(1, space - used); // always one "+" so a full table can still be edited
    for (let i = 0; i < free; i++) {
      box.append(h('button', { class: 'socket empty', type: 'button', 'data-fkey': `socket:empty:${i}`, 'aria-label': 'Add a charm', title: used >= space ? 'Add a charm (your table is full)' : 'Add a charm', onclick: () => openPicker('charm') }, '+'));
    }
  });
  $('space-count').textContent = `${used}/${space}`;
  $('space-count').classList.toggle('over', used > space);
  const warn = $('space-warn');
  warn.hidden = used <= space;
  if (used > space) warn.textContent = `More charms than space (${used}/${space}). Move one to a drawer, or type your charm space under In-game numbers.`;
}

function renderCalls() {
  const ul = $('calls');
  keepFocus(ul, () => {
    ul.replaceChildren();
    const entries = Object.entries(state.phone).filter(([, n]) => n > 0);
    if (!entries.length) ul.append(h('li', { class: 'note', style: { margin: 0 } }, 'No calls yet. The phone rings from deadline 2.'));
    for (const [id, n] of entries) {
      const it = db.byId.get(id);
      if (!it) continue;
      const input = h('input', { class: 'input num', type: 'number', min: '1', max: '99', inputmode: 'numeric', value: String(n), 'data-fkey': `call:n:${id}`, 'aria-label': `Times taken: ${it.name}` });
      // typing changes the count in place (no re-render, so the box keeps focus); an empty or zero box
      // goes back to the last count when you leave it. Only the minus button removes a call.
      const commit = (v) => {
        v = clampNum(Math.round(v), 0, 99);
        if (v <= 0) { delete state.phone[id]; renderCalls(); $('add-call').focus(); toast(`Removed ${it.name}`); run(); return; }
        state.phone[id] = v; input.value = String(v); run();
      };
      input.addEventListener('input', () => { const v = +input.value; if (input.value !== '' && Number.isFinite(v) && v >= 1) { state.phone[id] = clampNum(Math.round(v), 1, 99); run(); } });
      input.addEventListener('change', () => { input.value = String(state.phone[id] || n); });
      ul.append(h('li', { class: `call ${it.type}` },
        h('button', { class: 'link-btn', type: 'button', style: { textDecoration: 'none' }, 'data-fkey': `call:info:${id}`, 'aria-label': `Details: ${it.name}`, onclick: () => openItem(db, id, detailOpts(it)) }, itemIcon(it)),
        h('span', { class: 'call-name' }, it.name),
        h('span', { class: 'stepper' },
          h('button', { type: 'button', 'data-fkey': `call:dec:${id}`, 'aria-label': `One fewer: ${it.name}`, onclick: () => { sfx.remove(); commit((state.phone[id] || 0) - 1); } }, '−'),
          input,
          h('button', { type: 'button', 'data-fkey': `call:inc:${id}`, 'aria-label': `One more: ${it.name}`, onclick: () => { sfx.add(); commit((state.phone[id] || 0) + 1); } }, '+'))));
    }
  });
  renderCallsNote();
}

// First Love / Megaphone change what one call counts for: say so next to the list.
function renderCallsNote() {
  const note = $('calls-note');
  const b = result && result.build;
  const mem = b ? b.memPhoneExtra : 0, adds = b ? b.callAddsPerTake : 1;
  const parts = [];
  if (mem > 0) parts.push(`Your memory card makes every call trigger ${mem + 1}×; that's counted for you, so enter each call once.`);
  if (adds > 1) parts.push(`Megaphone: a call taken while it's on your table counts ${adds}×, so “Took it” adds ${adds}.`);
  note.hidden = !parts.length;
  note.textContent = parts.join(' ');
}

function renderBoards() {
  const sb = $('symbols-board');
  sb.replaceChildren(h('div', { class: 'board-head' }, h('span'), h('span', {}, 'Symbol'), h('span', {}, 'Value'), h('span', {}, 'Chance %')));
  SYMBOLS.forEach((s, i) => {
    const v = getStat('values', s);
    const c = getStat('chances', s);
    sb.append(h('div', { class: 'board-row' },
      h('img', { src: `assets/icons/game/${SYMBOL_ICONS[i]}.webp`, alt: '' }),
      h('span', {}, SYMBOL_NAMES[i]),
      statBox(h('input', { class: `input num${v != null ? ' overridden' : ''}`, type: 'number', step: 'any', min: '0', value: v ?? '', 'data-sym-val': s, 'aria-label': `${SYMBOL_NAMES[i]} value` }), 'values', s),
      statBox(h('input', { class: `input num${c != null ? ' overridden' : ''}`, type: 'number', step: 'any', min: '0', max: '100', value: c ?? '', 'data-sym-chance': s, 'aria-label': `${SYMBOL_NAMES[i]} chance percent` }), 'chances', s)));
  });
  const pb = $('patterns-board');
  pb.replaceChildren(h('div', { class: 'board-head', style: { gridTemplateColumns: '52px 1fr 84px' } }, h('span'), h('span', {}, 'Pattern'), h('span', {}, 'Value ×')));
  PATTERNS.forEach((p, i) => {
    if (i >= 11) return; // size-2 patterns only exist with Angel's Hand
    const v = getStat('patterns', p);
    pb.append(h('div', { class: 'board-row pat' },
      h('img', { src: `assets/icons/game/${PATTERN_ICONS[i]}.webp`, alt: '' }),
      h('span', {}, PATTERN_NAMES[i]),
      statBox(h('input', { class: `input num${v != null ? ' overridden' : ''}`, type: 'number', step: 'any', min: '0', value: v ?? '', 'data-pat': p, 'aria-label': `${PATTERN_NAMES[i]} value` }), 'patterns', p)));
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

// ------------------------------------------------------------------ taking an item
// Adds a recommended item to the build ("Bought it" / "Took it"). Safe against double clicks:
// a charm is only paid for when it's actually added.
function takeItem(r) {
  if (r.kind === 'charm') {
    if (state.charms.some((c) => c.id === r.id)) { toast(`${r.name} is already on your table`); return false; }
    const it = db.byId.get(r.id);
    const full = !(it && it.noSpace) && spaceUsed() >= charmSpace();
    state.charms.push({ id: r.id, trait: null, drawer: false });
    state.tickets = Math.max(0, (state.tickets || 0) - (r.price || 0));
    toast(full ? `Bought ${r.name}. Your table is over its space now: move a charm to a drawer.` : `Bought ${r.name}`);
  } else {
    const adds = (result && result.build.callAddsPerTake) || 1;
    state.phone[r.id] = Math.min(99, (state.phone[r.id] || 0) + adds);
    toast(adds > 1 ? `Added call: ${r.name} (×${adds} with Megaphone)` : `Added call: ${r.name}`);
  }
  if (activeTab === 'offers') state.offers = state.offers.filter((o) => o.id !== r.id);
  sfx.win(); renderBuild(); run();
  return true;
}

function ownedInsight(o) {
  return [{ kind: 'neutral', text: `Without it your build would make ${Math.round((1 - 1 / Math.max(o.horizon, 0.01)) * 100)}% less over the next ${plural(result.build.horizonRounds, 'round')}.` }, ...(o.reasons || [])];
}

// Options for the details dialog of any item (also for items opened from "Works well with" links):
// the add button always acts on the item shown, with what the helper knows about it.
function detailOpts(it) {
  const base = { forItem: detailOpts };
  if (!it || it.kind === 'memory' || !result) return base;
  if (it.kind === 'charm' && state.charms.some((c) => c.id === it.id)) {
    const own = result.owned.find((x) => x.id === it.id);
    return { ...base, note: 'On your table', insight: own ? ownedInsight(own) : null };
  }
  const rec = result.recommendations.all.find((x) => x.id === it.id);
  if (!rec) return { ...base, note: it.kind === 'charm' && it.category !== 'store' ? "Not sold in the store, so it isn't ranked" : null };
  const taken = it.kind === 'phone' ? state.phone[it.id] || 0 : 0;
  return {
    ...base, insight: rec.reasons,
    onAdd: () => takeItem(rec),
    addLabel: it.kind === 'phone' ? (taken ? 'Took it again' : 'Took it') : 'Bought it',
    note: taken ? `Taken ×${taken}` : null,
  };
}

// ------------------------------------------------------------------ dialogs: picker & charm menu
let pickerDialog = null;
function openPicker(mode) {
  // mode: charm | phone | offer-charm | offer-phone
  if (!pickerDialog) {
    pickerDialog = h('dialog', { class: 'sheet picker', 'aria-labelledby': 'picker-title' });
    pickerDialog.addEventListener('click', (e) => { if (e.target === pickerDialog) pickerDialog.close(); });
    document.body.append(pickerDialog);
  }
  returnFocusOnClose(pickerDialog, mode === 'phone' ? $('add-call') : mode === 'charm' ? $('sockets') : $('add-offer-charm'));
  const isPhone = mode === 'phone' || mode === 'offer-phone';
  const title = { charm: 'Add a charm to your table', phone: 'Add a phone call you took', 'offer-charm': 'What is in the store?', 'offer-phone': 'What is the phone offering?' }[mode];
  let q = '', group = 'all';
  const groupsCharm = [['all', 'All'], ['Common', 'Common'], ['Uncommon', 'Uncommon'], ['Rare', 'Rare'], ['Legendary', 'Legendary'], ['special', 'Special']];
  const groupsPhone = [['all', 'All'], ['normal', 'Normal'], ['red', 'Red'], ['sacred', 'Sacred']];
  // the store only sells store charms, so "Special" would always be empty there
  const groups = isPhone ? groupsPhone : mode === 'offer-charm' ? groupsCharm.filter(([g]) => g !== 'special') : groupsCharm;
  const grid = h('div', { class: 'item-grid' });
  const search = h('input', { class: 'input', type: 'search', placeholder: isPhone ? 'Search calls: lemon, double, trait…' : 'Search charms: lemon, luck, 666, retrigger…', 'aria-label': 'Search' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' });
  const badge = (it) => {
    if (it.kind === 'charm' && state.charms.some((c) => c.id === it.id)) return 'Owned';
    if (mode === 'phone' && state.phone[it.id]) return `Taken ×${state.phone[it.id]}`;
    if (mode.startsWith('offer') && state.offers.some((o) => o.id === it.id)) return 'Offered';
    return null;
  };
  const draw = () => keepFocus(grid, () => {
    grid.replaceChildren();
    const list = (isPhone ? db.phone : db.charms).filter((it) => {
      if (!isPhone) {
        if (group === 'special') { if (it.category === 'store') return false; }
        else if (group !== 'all' && it.rarity !== group) return false;
        if (mode === 'offer-charm' && it.category !== 'store') return false;
      } else if (group !== 'all' && it.type !== group) return false;
      if (state.mode.dlc === false && it.dlc) return false;
      return matches(it, q);
    }).map((it, i) => [relevance(it, q), i, it]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
    if (!list.length) grid.append(h('p', { class: 'empty-state' }, q ? 'Nothing matches. Try a shorter word.' : 'Nothing in this group.'));
    for (const it of list) {
      grid.append(h('button', { class: `tile ${it.kind} rarity-${it.rarity || ''}`, type: 'button', 'data-badge': badge(it), 'data-fkey': `pick:${it.id}`, onclick: () => pick(it) },
        itemIcon(it), h('div', {}, h('div', { class: 't-name' }, it.name), h('div', { class: 't-meta' }, itemChips(it, { tier: false })))));
    }
  });
  const pick = (it) => {
    if (mode === 'charm') {
      if (state.charms.some((c) => c.id === it.id)) { toast(`${it.name} is already on your table`); return; }
      state.charms.push({ id: it.id, trait: null, drawer: false });
      sfx.add(); renderSockets(); toast(`Added ${it.name} to your table`);
    } else if (mode === 'phone') {
      state.phone[it.id] = Math.min(99, (state.phone[it.id] || 0) + 1);
      sfx.add(); renderCalls(); toast(`Added ${it.name} (taken ×${state.phone[it.id]})`);
    } else {
      if (it.kind === 'charm' && state.charms.some((c) => c.id === it.id)) { toast(`You already own ${it.name}`); return; }
      if (state.offers.some((o) => o.id === it.id)) { toast(`${it.name} is already in the offers`); return; }
      state.offers.push({ id: it.id, price: it.kind === 'charm' ? it.cost : null });
      sfx.add(); pickerDialog.close(); selectTab('offers'); toast(`Added offer: ${it.name}`);
    }
    run();
    if (pickerDialog.open) draw(); // show the new "Owned" / "Taken" badge
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
  returnFocusOnClose(menuDialog, $('sockets'));
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
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { menuDialog.close(); openItem(db, it.id, detailOpts(it)); } }, 'Details'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.charms = state.charms.filter((x) => x !== c); sfx.remove(); renderSockets(); run(); menuDialog.close(); toast(`Removed ${it.name}`); } }, 'Remove'))),
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
  keepFocus(ol, () => {
    ol.replaceChildren();
    if (activeTab === 'offers' && !state.offers.length) {
      ol.append(h('li', { class: 'empty-state' }, 'Type in what the store or the phone is showing you right now, and the picks get ranked against each other, including the price.'));
      return;
    }
    const max = showAll ? list.length : 12;
    list.slice(0, max).forEach((r, i) => ol.append(renderPick(r, i)));
  });
  $('show-more').hidden = (activeTab === 'offers' && !state.offers.length) || list.length <= 12;
  $('show-more').textContent = showAll ? 'Show fewer' : `Show all ${list.length}`;
  renderReels();
}

function renderPick(r, i) {
  const it = db.byId.get(r.id);
  const seg = Math.max(0, Math.min(10, Math.round(r.score / 10)));
  const meter = h('div', { class: 'meter', title: `Score ${Math.round(r.score)}` }, Array.from({ length: 10 }, (_, k) => h('i', { class: k < seg ? 'on' : '' })));
  const takeLabel = r.kind === 'phone' ? 'Took it' : 'Bought it';
  let done = false; // one take per rendered row, so a double click doesn't pay twice
  const take = () => { if (done) return; done = takeItem(r); };
  const offer = activeTab === 'offers' ? state.offers.find((o) => o.id === r.id) : null;
  const chips = itemChips(it, { tickets: state.tickets, price: r.price });
  const details = () => openItem(db, r.id, { onAdd: take, addLabel: takeLabel, insight: r.reasons, forItem: detailOpts });
  return h('li', { class: 'pick' },
    h('span', { class: 'rank' }, String(i + 1)),
    h('button', { class: 'art', type: 'button', 'data-fkey': `pick:art:${r.id}`, 'aria-label': `Details: ${r.name}`, onclick: details }, itemIcon(it)),
    h('div', {},
      h('h4', {}, h('button', { type: 'button', 'data-fkey': `pick:name:${r.id}`, onclick: details }, r.name), chips),
      r.kind === 'charm' && !r.affordable && state.tickets > 0 ? h('div', { class: 'small', style: { color: '#ffb3aa' } }, `Costs ${r.price}, you have ${state.tickets} tickets`) : null,
      h('ul', { class: 'why' }, (r.reasons || []).slice(0, i < 3 ? 6 : 4).map((x) => h('li', { class: x.kind }, x.text))),
      // the price is stored as you type and ranked when you leave the box (or press Enter),
      // so the list doesn't re-sort under your cursor
      offer && r.kind === 'charm' ? h('label', { class: 'small row', style: { marginTop: '6px', gap: '6px' } }, 'Price in store',
        h('input', {
          class: 'input num', style: { width: '72px', height: '28px', fontSize: '17px' }, type: 'number', min: '0', inputmode: 'numeric', value: offer.price ?? '', 'data-fkey': `offer:price:${r.id}`,
          oninput: (e) => { const v = e.target.value; offer.price = v === '' || !Number.isFinite(+v) ? null : Math.max(0, Math.round(+v)); saveLocal(state); },
          onchange: (e) => { e.target.value = offer.price ?? ''; run(); },
        })) : null,
    ),
    h('div', { class: 'side' }, meter, h('span', { class: 'score' }, String(Math.round(r.score))),
      h('button', { class: 'btn small', type: 'button', 'data-fkey': `pick:take:${r.id}`, onclick: take }, takeLabel),
      offer ? h('button', { class: 'link-btn', type: 'button', 'data-fkey': `offer:remove:${r.id}`, onclick: () => { state.offers = state.offers.filter((o) => o !== offer); run(); } }, 'Remove offer') : null),
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
  const off = Math.floor(Date.now() / 64) % pool.length; // always positive, so never an empty "?" cell
  const animate = (changed || force) && !reducedMotion();
  reels.replaceChildren();
  labels.replaceChildren();
  top.forEach((r, i) => {
    const it = db.byId.get(r.id);
    const n = 14 + i * 4;
    const strip = h('div', { class: 'reel-strip' });
    for (let k = 0; k < n; k++) strip.append(h('div', { class: 'reel-cell' }, itemIcon(pool[(k * 7 + i * 13 + off) % pool.length])));
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
    const H = result.build.horizonRounds;
    return H === 1 ? `${pct >= 0 ? '+' : ''}${pct}% coins next round` : `${pct >= 0 ? '+' : ''}${pct}% coins over ${H} rounds`;
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
  const exp = $('led-expected');
  exp.textContent = fmtNum(c.expectedPerDeadline);
  exp.classList.toggle('green', c.expectedPerDeadline >= 0); // red when spins cost more than they win
  $('led-ev').textContent = fmtNum(b.ev);
  const lamp = $('lamp');
  const emptyBuild = !state.charms.length && !Object.keys(state.phone).length && !Object.keys(state.stats).length;
  lamp.className = emptyBuild ? 'lamp' : 'lamp ' + c.status;
  const times = c.ratio < 10 ? c.ratio.toFixed(1) : fmtNum(c.ratio);
  const pct = Math.round(c.ratio * 100);
  const text = {
    safe: `On track: about ${times}× the debt. Good time to invest in scaling.`,
    ok: 'Should make it, but without much room to spare.',
    tight: `Tight: you're expected to reach about ${pct}% of the debt. Favour picks that pay now.`,
    danger: c.ratio <= 0
      ? 'At risk: right now your spins cost more coins than they win. Move the slider toward "Survive this deadline".'
      : `At risk: only about ${pct}% of the debt. Move the slider toward "Survive this deadline".`,
  }[c.status] || '';
  $('status-text').textContent = emptyBuild ? 'Add your charms, calls or in-game numbers to check this deadline.' : text;

  const bars = $('sym-bars');
  bars.replaceChildren();
  const order = SYMBOLS.map((s, i) => i).sort((a, b2) => b.symShare[b2] - b.symShare[a]);
  for (const i of order) {
    const share = Math.max(0, b.symShare[i] * 100);
    bars.append(h('div', { class: 'bar-row', title: `${SYMBOL_NAMES[i]}: value ${fmtNum(b.values[i])}, chance ${(b.chances[i] * 100).toFixed(1)}%` },
      h('img', { src: `assets/icons/game/${SYMBOL_ICONS[i]}.webp`, alt: SYMBOL_NAMES[i] }),
      h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, share)}%` } })),
      h('span', { class: 'pct' }, `${Math.round(share)}%`)));
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
  keepFocus(owned, () => {
    owned.replaceChildren();
    if (!result.owned.length) owned.append(h('li', { class: 'muted small', style: { display: 'block' } }, 'Add charms to see how much each one is worth.'));
    for (const o of result.owned) {
      const it = db.byId.get(o.id);
      const p = Math.round((o.horizon - 1) * 100);
      const pts = Math.round(o.score);
      owned.append(h('li', { title: (o.reasons || []).map((r) => r.text).join('\n') },
        itemIcon(it), h('button', { class: 'link-btn', type: 'button', 'data-fkey': `owned:${o.id}`, style: { color: 'var(--bone)', textDecoration: 'none', textAlign: 'left' }, onclick: () => openItem(db, o.id, { insight: ownedInsight(o), note: 'On your table', forItem: detailOpts }) }, o.name),
        h('span', { class: `val${p < 0 ? ' neg' : ''}` }, Math.abs(p) >= 1 ? `${p > 0 ? '+' : ''}${p}%` : plural(pts, 'pt'))));
    }
  });
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
  const list = listSaved();
  keepFocus(box, () => {
    box.replaceChildren();
    if (!list.length) return;
    box.append(h('div', { class: 'muted', style: { marginBottom: '4px' } }, `Saved builds (${list.length})`));
    const scroll = h('div', { class: 'saved-scroll' });
    for (const s of list) {
      scroll.append(h('div', { class: 'row saved-row' },
        h('button', { class: 'link-btn', type: 'button', 'data-fkey': `saved:${s.name}`, onclick: () => loadSaved(s.name) }, s.name),
        h('button', { class: 'link-btn dim', type: 'button', 'data-fkey': `saved-del:${s.name}`, 'aria-label': `Delete ${s.name}`, onclick: () => {
          if (!confirm(`Delete the saved build “${s.name}”?`)) return;
          deleteSaved(s.name); renderSaved(); toast(`Deleted “${s.name}”`);
        } }, 'Delete')));
    }
    box.append(scroll);
  });
}

// Always read the saved copy from storage, so edits made after loading it never leak back in.
function loadSaved(name) {
  const s = listSaved().find((x) => x.name === name);
  if (!s) { renderSaved(); return; }
  state = normalize(s.state);
  renderBuild(); run(true); toast(`Loaded “${s.name}”`);
}
