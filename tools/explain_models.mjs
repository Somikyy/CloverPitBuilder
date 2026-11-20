// Show how the engine interprets item models.
//
// Usage:  node tools/explain_models.mjs [models-file.json | id ...]
//
// For every model it prints which effects the engine can use (handled) and which it
// cannot (unhandled -> valued only by ratings), plus the item's value when added to a
// neutral deadline-4 build: coins per round now and on average over 9 rounds.
import { readFileSync, existsSync } from 'node:fs';
import { loadDb } from '../tests/load.mjs';
import { analyze, defaultState } from '../assets/js/core/engine.js';
import { newDerived, applyModel } from '../assets/js/core/effects.js';

const db = loadDb();
const args = process.argv.slice(2);
let ids = [];
for (const a of args) {
  if (a.endsWith('.json') && existsSync(a)) ids = ids.concat(JSON.parse(readFileSync(a, 'utf8')).map((m) => m.id));
  else ids.push(a);
}
if (!ids.length) ids = db.all.filter((x) => x.model).map((x) => x.id);

const st = defaultState();
st.deadline = 4;
st.stats = { values: { lemon: 8, cherry: 6, clover: 9, bell: 9, diamond: 15, treasure: 15, seven: 21 }, sm: 2 };
st.charms = [{ id: 'golden_lemon' }, { id: 'rotated_hamsa' }];
const pool = ids.map((id) => db.byId.get(id)).filter((it) => it && it.model && it.kind !== 'memory');
const res = analyze(st, db, { skipOwned: true, pool });
const byId = Object.fromEntries(res.recommendations.all.map((r) => [r.id, r]));

for (const id of ids) {
  const it = db.byId.get(id);
  if (!it) { console.log(`?? ${id}: not in items.json`); continue; }
  if (!it.model) { console.log(`-- ${id}: no model`); continue; }
  const d = newDerived();
  const cov = applyModel(d, it.model, { item: it });
  const r = byId[id];
  const val = r ? `now ${fmt(r.value.now)} | avg9 ${fmt(r.value.horizon)} | growth/round ${(r.value.growthPerRound * 100).toFixed(1)}% | tickets/deadline ${r.value.ticketsPerDeadline.toFixed(1)} | score ${r.score.toFixed(0)}` : '(memory card: applied to the whole run)';
  console.log(`${cov.handled === cov.total ? 'OK' : cov.handled ? '~~' : 'XX'} ${id} [${it.model.tier}] handled ${cov.handled}/${cov.total}${cov.unhandled.length ? ' | unhandled: ' + cov.unhandled.map((u) => String(u).slice(0, 70)).join(' ; ') : ''}\n     ${val}`);
}

function fmt(v) { const p = (v - 1) * 100; return `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`; }
