// Tier calibration table: each item's curated tier/ratings next to how the engine scores it
// across the typical builds in tools/scenarios.mjs. Writes markdown to stdout.
//
// Usage:  node tools/calibration_table.mjs > tools/.cache/calibration.md
import { loadDb } from '../tests/load.mjs';
import { analyze, defaultState } from '../assets/js/core/engine.js';

const db = loadDb();
const V = (l, c, cl, b, d, t, s) => ({ lemon: l, cherry: c, clover: cl, bell: b, diamond: d, treasure: t, seven: s });
const charms = (...ids) => ids.map((x) => (typeof x === 'string' ? { id: x } : x));
const SCEN = {
  fresh: { deadline: 1, tickets: 4 },
  early: { deadline: 3, tickets: 6, charms: charms('lucky_cat', 'rotated_hamsa'), stats: { values: V(4, 4, 5, 5, 8, 8, 11) } },
  lemon: { deadline: 4, tickets: 6, charms: charms('golden_lemon', 'lemon_picture', { id: 'pentacle', trait: 'avid' }), phone: { life_gave_me_lemons: 2, i_need_supplements: 1 }, stats: { values: { lemon: 24 } } },
  retrigger: { deadline: 6, tickets: 8, charms: charms('pentacle', 'hamsa', 'broken_calculator', 'horseshoe', 'red_pepper', 'green_pepper'), stats: { values: V(10, 10, 12, 12, 20, 20, 28), sm: 4, pm: 2 } },
  devil: { deadline: 7, tickets: 10, charms: charms('necronomicon', 'demons_horn', 'book_of_shadows', 'baphomet', 'gabihbbh', 'crystal_skull'), stats: { values: V(20, 20, 30, 30, 60, 60, 90), sm: 5, pm: 4 } },
  button: { deadline: 5, tickets: 7, charms: charms('lemon_picture', 'diamond_picture', 'number_1', 'midas_touch', 'nuclear_button', 'aa_batteries'), stats: { values: V(12, 8, 10, 14, 20, 18, 25), sm: 3 } },
  gems: { deadline: 6, tickets: 8, charms: charms('golden_seven', 'golden_diamond', 'seven_picture', 'crystal_sphere'), phone: { i_didnt_hurt_anybody: 2, please_ill_give_you_anything: 1 }, stats: { values: V(4, 4, 6, 6, 30, 25, 60), sm: 4, pm: 2 } },
  sacred: { deadline: 6, tickets: 9, mode: { sacred: true }, charms: charms('holy_bible', 'rosary', 'pentacle', 'golden_seven'), phone: { im_re_organizing_my_mind: 1 }, stats: { values: V(10, 10, 12, 12, 25, 25, 40), sm: 6 } },
};
const scores = new Map();
for (const [name, sc] of Object.entries(SCEN)) {
  const st = defaultState();
  Object.assign(st, sc, { mode: { ...st.mode, ...(sc.mode || {}) } });
  const r = analyze(st, db, { skipOwned: true });
  for (const kind of ['charms', 'phone']) {
    const list = r.recommendations[kind];
    list.forEach((x, i) => {
      const e = scores.get(x.id) || { ranks: {}, scores: {} };
      e.ranks[name] = (i + 1) / list.length; e.scores[name] = Math.round(x.score);
      scores.set(x.id, e);
    });
  }
}
const names = Object.keys(SCEN);
const rows = [];
for (const it of db.all) {
  if (it.kind === 'memory' || !it.model) continue;
  if (it.kind === 'charm' && it.category !== 'store') continue;
  const e = scores.get(it.id);
  if (!e) continue;
  const rk = names.map((n) => e.ranks[n]).filter((x) => x !== undefined);
  const best = Math.min(...rk), mean = rk.reduce((a, b) => a + b, 0) / rk.length;
  rows.push({ it, best, mean, e });
}
rows.sort((a, b) => a.mean - b.mean);
console.log('# Calibration table\n');
console.log('Rank percentiles: 0.00 = best pick in that scenario list, 1.00 = worst. best = best percentile over scenarios.\n');
console.log(`| item | kind | tier | p/s/e/u/r | best | mean | ${names.join(' | ')} |`);
console.log(`|---|---|---|---|---|---|${names.map(() => '---').join('|')}|`);
for (const { it, best, mean, e } of rows) {
  const r = it.model.ratings;
  console.log(`| ${it.name} (${it.id}) | ${it.kind}${it.cost ? ' ' + it.cost + 't' : ''} | ${it.model.tier} | ${r.power}/${r.scaling}/${r.economy}/${r.utility}/${r.risk} | ${best.toFixed(2)} | ${mean.toFixed(2)} | ${names.map((n) => (e.scores[n] ?? '-')).join(' | ')} |`);
}
