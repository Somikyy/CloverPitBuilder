// Sanity scenarios: typical builds and what the engine recommends for them.
//
// Usage:  node tools/scenarios.mjs [scenario-name ...]
// Prints coins per spin, detected build type and the top charm / phone picks per scenario,
// so changes to models or the engine can be eyeballed for nonsense.
import { loadDb } from '../tests/load.mjs';
import { analyze, defaultState } from '../assets/js/core/engine.js';

const db = loadDb();
const V = (l, c, cl, b, d, t, s) => ({ lemon: l, cherry: c, clover: cl, bell: b, diamond: d, treasure: t, seven: s });
const charms = (...ids) => ids.map((x) => (typeof x === 'string' ? { id: x } : x));

const SCENARIOS = {
  fresh: { deadline: 1 },
  lemon: { deadline: 4, tickets: 6, charms: charms('golden_lemon', 'lemon_picture', { id: 'pentacle', trait: 'avid' }), phone: { life_gave_me_lemons: 2, i_need_supplements: 1 }, stats: { values: { lemon: 24 } } },
  retrigger: { deadline: 6, tickets: 8, charms: charms('pentacle', 'hamsa', 'broken_calculator', 'horseshoe', 'red_pepper', 'green_pepper'), stats: { values: V(10, 10, 12, 12, 20, 20, 28), sm: 4, pm: 2 } },
  devil: { deadline: 7, tickets: 10, charms: charms('necronomicon', 'demons_horn', 'book_of_shadows', 'baphomet', 'gabihbbh', 'crystal_skull'), stats: { values: V(20, 20, 30, 30, 60, 60, 90), sm: 5, pm: 4 } },
  button: { deadline: 5, tickets: 7, charms: charms('lemon_picture', 'diamond_picture', 'number_1', 'midas_touch', 'nuclear_button', 'aa_batteries'), stats: { values: V(12, 8, 10, 14, 20, 18, 25), sm: 3 } },
  cats: { deadline: 5, tickets: 5, deposited: 6000, charms: charms('lucky_cat', 'chonky_cat', 'stonks', 'grandmas_purse', 'cat_food'), stats: { values: V(8, 8, 12, 12, 20, 20, 28), sm: 3 } },
  tickets: { deadline: 4, tickets: 32, charms: charms('lost_wallet', 'cloverpet', 'cloverpot', 'fidelity_card'), stats: { values: V(6, 6, 9, 9, 15, 15, 21), sm: 2 } },
  sacred: { deadline: 6, tickets: 9, mode: { sacred: true }, charms: charms('holy_bible', 'rosary', 'pentacle', 'golden_seven'), phone: { im_re_organizing_my_mind: 1 }, stats: { values: V(10, 10, 12, 12, 25, 25, 40), sm: 6 } },
};

const pick = process.argv.slice(2);
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (pick.length && !pick.includes(name)) continue;
  const st = defaultState();
  Object.assign(st, sc, { mode: { ...st.mode, ...(sc.mode || {}) } });
  const t0 = Date.now();
  const r = analyze(st, db, {});
  const pct = (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  console.log(`\n=== ${name} (deadline ${st.deadline})  ${Date.now() - t0} ms`);
  console.log(`coins/spin ${r.build.ev.toFixed(1)}  per deadline ${Math.round(r.check.expectedPerDeadline)} vs debt ${Math.round(r.check.debt)} (${r.check.status})  build: ${r.build.archetypes.slice(0, 3).map((a) => a.label).join(', ') || '-'}`);
  if (r.owned.length) console.log('owned: ' + r.owned.map((o) => `${o.name} ${pct(o.horizon)}`).join(' | '));
  console.log('charms: ' + r.recommendations.charms.slice(0, 10).map((x) => `${x.name} ${Math.round(x.score)} (${pct(x.value.now)}/${pct(x.value.horizon)})`).join(' | '));
  console.log('phone:  ' + r.recommendations.phone.slice(0, 6).map((x) => `${x.name} ${Math.round(x.score)} (${pct(x.value.now)}/${pct(x.value.horizon)})`).join(' | '));
}
