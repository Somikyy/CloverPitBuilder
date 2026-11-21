// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, INSTANCES } from '../assets/js/core/sim.js';
import { BASE_VALUE, BASE_WEIGHT, PATTERN_BASE, PATTERNS } from '../assets/js/core/constants.js';
import { analyze, defaultState, evaluateItem } from '../assets/js/core/engine.js';
import { loadDb } from './load.mjs';

const db = loadDb();
const cfg = (over = {}) => ({
  weights: BASE_WEIGHT.slice(), values: BASE_VALUE.slice(), baseValues: BASE_VALUE.slice(), patVals: PATTERN_BASE.slice(),
  basePatVals: PATTERN_BASE.slice(), enabled: PATTERNS.map((_, i) => i < 11), SM: 1, PM: 1, deadline: 4, roundsPerDeadline: 3,
  spinsPerRound: 7, spontaneous: true, sixes: true, p666: 0.015, p66: 0.06, p6: 0.075, sacred: false, protect666: 0,
  mods: new Array(70).fill(0), luck: [], retrig: [], force: [], extraSpins: [], temps: [], rb: [], randomMul: 1, ...over,
});

test('pattern instances match the 3x5 board', () => {
  const count = (p) => INSTANCES.filter((i) => i.p === p).length;
  assert.equal(count(0), 9);  // HOR
  assert.equal(count(1), 5);  // VER
  assert.equal(count(2), 6);  // DIAG
  assert.equal(count(3), 6);  // HOR-L
  assert.equal(count(4), 3);  // HOR-XL
  assert.equal(count(10), 1); // JACKPOT
  // a full board scores Jackpot + Above + Below + Eye + middle HOR-XL + 3 VER + 2 DIAG = 10 patterns
  const r = simulate(cfg({ luck: [{ add: 15, cond: { kind: 'always' } }], sixes: false, spontaneous: false }), { deadlines: 20 });
  assert.equal(r.pJackpot, 1);
  assert.equal(Math.round(r.avgPatterns), 10);
});

test('scoring is linear in symbol values and multipliers', () => {
  const a = simulate(cfg(), { deadlines: 60, seed: 5 });
  const b = simulate(cfg({ values: BASE_VALUE.map((v) => v * 2), SM: 3 }), { deadlines: 60, seed: 5 });
  assert.ok(Math.abs(b.ev / a.ev - 6) < 1e-9);
});

test('rare valuable symbols gain more from +1 chance than common cheap ones', () => {
  const base = simulate(cfg(), { deadlines: 300, seed: 9 }).ev;
  const w7 = BASE_WEIGHT.slice(); w7[6] += 1;
  const wL = BASE_WEIGHT.slice(); wL[0] += 1;
  const seven = simulate(cfg({ weights: w7 }), { deadlines: 300, seed: 9 }).ev;
  const lemon = simulate(cfg({ weights: wL }), { deadlines: 300, seed: 9 }).ev;
  assert.ok(seven > lemon && lemon > base * 0.98);
});

test('a lemon-heavy build values lemon upgrades above cherry upgrades', () => {
  const st = defaultState();
  st.deadline = 4;
  st.stats = { values: { lemon: 40 } };
  st.phone = { life_gave_me_lemons: 2 };
  const r = analyze(st, db, { skipOwned: true });
  const byId = Object.fromEntries(r.recommendations.phone.map((x) => [x.id, x]));
  assert.ok(byId.life_gave_me_lemons.value.now > byId.i_used_to_eat_healthy.value.now);
  assert.ok(r.build.symShare[0] > 0.5);
});

test('Necronomicon triples coins on an empty pattern multiplier (minus extra 666 risk)', () => {
  const st = defaultState();
  st.deadline = 4;
  const r = analyze(st, db, { skipOwned: true, pool: [db.byId.get('necronomicon')] });
  const v = r.recommendations.all[0].value.now;
  assert.ok(v > 2.3 && v < 3.05, `got ${v}`);
});

test('analyze never throws on random builds', () => {
  const charms = db.charms.filter((c) => c.category === 'store');
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 6; k++) {
    const st = defaultState();
    st.deadline = 1 + Math.floor(rnd() * 12);
    st.tickets = Math.floor(rnd() * 30);
    st.mode.sacred = rnd() < 0.2;
    for (let i = 0; i < 7; i++) st.charms.push({ id: charms[Math.floor(rnd() * charms.length)].id, trait: rnd() < 0.2 ? 'avid' : null });
    for (let i = 0; i < 3; i++) { const p = db.phone[Math.floor(rnd() * db.phone.length)]; st.phone[p.id] = 1 + Math.floor(rnd() * 2); }
    const r = analyze(st, db, { baseDeadlines: 60, cmpDeadlines: 40, ownedDeadlines: 40 });
    assert.ok(Number.isFinite(r.build.ev));
    assert.ok(r.recommendations.all.every((x) => !x.error && Number.isFinite(x.score)), 'all candidates scored');
  }
});

test('every model references existing items', () => {
  for (const it of db.all) {
    if (!it.model) continue;
    for (const s of [...(it.model.synergies || []), ...(it.model.antiSynergies || [])]) assert.ok(db.byId.has(s.id), `${it.id} -> ${s.id}`);
  }
});

test('evaluateItem is deterministic', () => {
  const st = defaultState();
  st.deadline = 3;
  const a = analyze(st, db, { skipOwned: true, pool: [db.byId.get('pentacle')] }).recommendations.all[0].score;
  const b = analyze(st, db, { skipOwned: true, pool: [db.byId.get('pentacle')] }).recommendations.all[0].score;
  assert.equal(a, b);
  assert.equal(typeof evaluateItem, 'function');
});

// ---- fixes from the final review
import { deriveBuild } from '../assets/js/core/engine.js';
import { totalSM, totalPM, protect666Of, compileSim } from '../assets/js/core/effects.js';
const mk = (o) => Object.assign(defaultState(), o);
const fast = { baseDeadlines: 80, cmpDeadlines: 40, ownedDeadlines: 40 };

test('owned charms are not charged their shop price', () => {
  const r = analyze(mk({ deadline: 5, tickets: 0, charms: ['evil_deal', 'golden_lemon', 'hamsa'].map((id) => ({ id })) }), db, fast);
  const evil = r.owned.find((o) => o.id === 'evil_deal');
  assert.ok(evil && evil.score === Math.max(...r.owned.map((o) => o.score)), r.owned.map((o) => `${o.id} ${Math.round(o.score)}`).join(', '));
});

test('trait phone calls and per-unit charms change the build, once', () => {
  assert.equal(totalSM(deriveBuild(mk({ charms: [{ id: 'golden_lemon' }], phone: { this_time_im_betting_on_yellow: 1 } }), db).d), 3);
  // the same Avid marked on the charm by hand is not counted twice
  assert.equal(totalSM(deriveBuild(mk({ charms: [{ id: 'golden_lemon', trait: 'avid' }], phone: { this_time_im_betting_on_yellow: 1 } }), db).d), 3);
  // no charm on the table: nothing to put the trait on
  assert.equal(totalSM(deriveBuild(mk({ phone: { this_time_im_betting_on_yellow: 1 } }), db).d), 1);
  assert.equal(totalPM(deriveBuild(mk({ tickets: 45, charms: [{ id: 'lost_wallet' }] }), db).d), 4);
  assert.equal(totalPM(deriveBuild(mk({ deadline: 30, charms: [{ id: 'chastity_belt' }] }), db).d), 4); // capped at +3
});

test('First Love doubles calls already taken', () => {
  const st = mk({ mode: { ...defaultState().mode, memory: 'first_love' }, phone: { im_re_organizing_my_mind: 1 } });
  assert.equal(totalSM(deriveBuild(st, db).d), 7); // +3 twice
});

test('one typed chance is used as typed', () => {
  const { d } = deriveBuild(mk({ stats: { chances: { seven: 30, lemon: -5 } } }), db);
  const tot = d.weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs((100 * d.weights[6]) / tot - 30) < 1e-9);
  assert.equal(d.weights[0], 0);
});

test('bad numbers from a link cannot break the engine', () => {
  for (const deadline of ['x', {}, ['pentacle'], null, -4, 1e9]) {
    const r = analyze(mk({ deadline, phone: { i_cant_quit_now: 1e6 } }), db, { ...fast, skipOwned: true });
    assert.ok(Number.isFinite(r.check.debt) && r.recommendations.all.every((x) => Number.isFinite(x.score)));
  }
});

test('Horseshoe doubles Rosary and Dynamo', () => {
  const { d, env } = deriveBuild(mk({ deadline: 5, charms: ['rosary', 'dynamo', 'lemon_picture', 'horseshoe'].map((id) => ({ id })) }), db);
  assert.ok(Math.abs(protect666Of(d) - 0.7) < 1e-9);
  assert.deepEqual(compileSim(d, env).roundEndCharges.map((x) => x.chance), [0.8]);
});

test('charge sources speed up permanent Red Button growth', () => {
  const st = mk({ deadline: 5, charms: [{ id: 'cross' }] });
  const r = analyze(st, db, { ...fast, skipOwned: true, pool: ['dynamo', 'nuclear_button'].map((id) => db.byId.get(id)) });
  for (const x of r.recommendations.all) assert.ok(x.value.growthPerRound > 0.001, `${x.id} ${x.value.growthPerRound}`);
});

test('a luck item and the base build see the same grids (per-spin random streams)', () => {
  const base = cfg({ deadline: 4 });
  const lucky = cfg({ deadline: 4, luck: [{ add: 2, cond: { kind: 'always' } }] });
  const a = simulate(base, { deadlines: 40, seed: 3 }), b = simulate(lucky, { deadlines: 40, seed: 3 });
  assert.equal(a.spins, b.spins);
  assert.ok(b.ev > a.ev); // more luck never loses coins on the same grids
});

test('every pick explains its score, in plain words', () => {
  const builds = [defaultState(), mk({ mode: { ...defaultState().mode, memory: 'first_love' }, deadline: 3, charms: [{ id: 'lucky_cat', trait: 'avid' }, { id: 'fruit_basket' }], phone: { i_need_supplements: 1 }, stats: { values: { lemon: 3 }, sm: 4 } })];
  for (const st of builds) {
    const r = analyze(st, db, { ...fast, skipOwned: true });
    for (const x of r.recommendations.all) {
      assert.ok(x.reasons.length > 0, `${x.id} has no reason`);
      for (const y of x.reasons) {
        assert.ok(!/Cherrys/.test(y.text), y.text);
        if (/as it grows/.test(y.text)) assert.ok(y.text.startsWith('+'), `${x.id}: ${y.text}`); // a loss never "grows"
      }
    }
  }
});

test('Number 2 says why it loses to Lemon Picture in a lemon build', () => {
  const st = mk({ deadline: 3, tickets: 6, charms: [{ id: 'golden_lemon' }, { id: 'pentacle', trait: 'avid' }], phone: { life_gave_me_lemons: 2, i_need_supplements: 1 }, stats: { values: { lemon: 24 } }, offers: [{ id: 'lemon_picture', price: 2 }, { id: 'number_2', price: 3 }] });
  const r = analyze(st, db, { ...fast, skipOwned: true });
  assert.deepEqual(r.offers.map((o) => o.id), ['lemon_picture', 'number_2']);
  const why = r.offers[1].reasons.map((x) => x.text);
  assert.ok(why.some((t) => /^Cherries, Clovers and Diamonds make only \d+% of your coins$/.test(t)), why.join(' | '));
});

test('your charms are listed by the coins they add, and the weakest is the last', () => {
  const ids = ['golden_lemon', 'lemon_picture', 'pentacle', 'clicker', 'fruit_basket', 'vines_soup', 'personal_trainer'];
  const st = mk({ deadline: 4, tickets: 6, charms: ids.map((id) => ({ id, trait: id === 'pentacle' ? 'avid' : null, drawer: false })), phone: { life_gave_me_lemons: 2, i_need_supplements: 1 }, stats: { values: { lemon: 24 } } });
  const r = analyze(st, db, fast);
  const h = r.owned.map((o) => o.horizon);
  assert.ok(h.every((v, i) => i === 0 || v <= h[i - 1]), r.owned.map((o) => `${o.id} ${o.horizon.toFixed(2)}`).join(', '));
  assert.equal(r.weakest && r.weakest.id, r.owned[r.owned.length - 1].id);
});

test('First Love doubles a doubling call twice', () => {
  const tickets = (memory) => analyze(mk({ mode: { ...defaultState().mode, memory }, deadline: 3, tickets: 5 }), db, { ...fast, skipOwned: true, pool: [db.byId.get('i_like_cryptic_values')] }).recommendations.all[0].value.ticketsPerDeadline;
  const once = tickets('erased_memory_card'), twice = tickets('first_love');
  assert.ok(once > 0 && Math.abs(twice / once - 3) < 1e-9, `${once} -> ${twice}`); // x2 adds the pile once, x4 adds it 3 times
});

test('temporary charms show their real length; emptying your hand is a one-off cost', () => {
  const r = analyze(mk({ deadline: 3, tickets: 5 }), db, { ...fast, skipOwned: true, pool: ['fortune_teller', 'i_like_cryptic_values', 'alexithymia'].map((id) => db.byId.get(id)) });
  const by = (id) => r.recommendations.all.find((x) => x.id === id).reasons.map((x) => x.text);
  assert.ok(by('fortune_teller').includes('Temporary: lasts about 5 rounds, weaker each round'), by('fortune_teller').join(' | '));
  for (const id of ['i_like_cryptic_values', 'alexithymia']) {
    assert.equal(by(id)[0], 'Sets the coins in your hand to 0, so deposit them first');
    assert.ok(!by(id).some((t) => /as it grows/.test(t)), by(id).join(' | '));
  }
});
