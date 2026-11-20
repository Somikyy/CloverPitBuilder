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
