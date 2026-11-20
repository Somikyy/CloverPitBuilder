// Build Helper engine.
//
// analyze(state, db) ->
//   - the build's current numbers (coins per spin, where coins come from, pattern odds)
//   - a deadline check (are you on track for the current debt?)
//   - how much each owned charm contributes (leave-one-out)
//   - ranked recommendations (charms + phone abilities) with reasons
//   - a ranking of the specific offers the player typed in (store / phone)
//
// Scoring blends: simulated coin gain over the player's horizon ("now" vs
// "later"), growth from permanent scaling, economy, utility, risk and synergy
// with what the player already has. Where an item's effect can't be simulated,
// the curated ratings in data/models fill the gap.

import { simulate } from './sim.js';
import {
  newDerived, cloneDerived, applyModel, applyTrait, compileSim, totalSM, totalPM, chance666,
} from './effects.js';
import {
  SYMBOLS, SYMBOL_NAMES, PATTERNS, PATTERN_NAMES, BASE_VALUE, BASE_WEIGHT, PATTERN_BASE, PATTERN_SIZE,
  MOD, RULES, SYM, PAT, deadlineInfo, maskToList,
} from './constants.js';

export const ENGINE_VERSION = 1;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtPct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.1 ? 1 : 0)}%`;

// ------------------------------------------------------------------ database
export function makeDb(itemsJson, modelsList, mechanics) {
  const models = new Map();
  for (const m of modelsList || []) models.set(m.id, m);
  const byId = new Map();
  const all = [];
  for (const [coll, kind] of [['charms', 'charm'], ['phone', 'phone'], ['memory', 'memory']]) {
    for (const it of itemsJson[coll] || []) {
      const x = { ...it, kind, model: models.get(it.id) || null };
      byId.set(it.id, x);
      all.push(x);
    }
  }
  return {
    byId, all, mechanics,
    charms: all.filter((x) => x.kind === 'charm'),
    phone: all.filter((x) => x.kind === 'phone'),
    memory: all.filter((x) => x.kind === 'memory'),
  };
}

// ------------------------------------------------------------------ state
export function defaultState() {
  return {
    v: 1,
    mode: { memory: 'erased_memory_card', hard: false, sacred: false, dlc: true },
    deadline: 1,
    tickets: 0,
    coins: null,
    deposited: null,
    charms: [],     // [{ id, trait?, drawer? }]
    phone: {},      // { id: times }
    stats: {},      // overrides from the in-game boards
    offers: [],     // [{ id, price? }]
    prefs: { horizon: 0.7 },
  };
}

export function deriveBuild(state, db) {
  const d = newDerived();
  const env = {
    deadline: clamp(Math.round(state.deadline || 1), 1, 30),
    sacred: !!(state.mode && state.mode.sacred),
    hard: !!(state.mode && state.mode.hard),
    dlc: !(state.mode && state.mode.dlc === false),
  };
  const coverage = [];
  const mem = state.mode && state.mode.memory && db.byId.get(state.mode.memory);
  if (mem && mem.model) coverage.push([mem.id, applyModel(d, mem.model, { item: mem })]);
  for (const [id, times] of Object.entries(state.phone || {})) {
    const it = db.byId.get(id);
    if (it && it.model && times > 0) coverage.push([id, applyModel(d, it.model, { item: it, times })]);
  }
  for (const c of state.charms || []) {
    if (c.drawer) continue;
    const it = db.byId.get(c.id);
    if (!it) continue;
    if (it.model) coverage.push([c.id, applyModel(d, it.model, { item: it })]);
    if (c.trait) applyTrait(d, c.trait, c.id);
    if (c.id === 'depression') d.flags.depression = true;
  }
  if (env.hard) d.debtMul *= 1 + 0.25 * (env.deadline - 1);
  applyOverrides(d, state.stats || {});
  return { d, env, coverage };
}

function num(x) { return x !== null && x !== undefined && x !== '' && Number.isFinite(+x) ? +x : null; }

function applyOverrides(d, st) {
  if (st.values) SYMBOLS.forEach((s, i) => { const v = num(st.values[s]); if (v !== null) d.values[i] = Math.max(0, v); });
  if (st.patterns) PATTERNS.forEach((p, i) => { const v = num(st.patterns[p]); if (v !== null) d.patVals[i] = Math.max(0, v); });
  if (st.chances) {
    const given = SYMBOLS.map((s) => num(st.chances[s]));
    if (given.every((x) => x !== null)) {
      const sumGiven = given.reduce((a, b) => a + b, 0);
      const tot = d.weights.reduce((a, b) => a + b, 0);
      if (sumGiven > 0) d.weights = given.map((g) => (g / sumGiven) * tot);
    }
  }
  const sm = num(st.sm); if (sm !== null) { d.smAdd = Math.max(0, sm); d.smMul = 1; }
  const pm = num(st.pm); if (pm !== null) { d.pmAdd = Math.max(0, pm); d.pmMul = 1; }
  const it = num(st.interest); if (it !== null) d.interest = Math.max(0, it);
  const cs = num(st.charmSpace); if (cs !== null) d.charmSpace = Math.max(0, cs);
}

// ------------------------------------------------------------------ context
function linEV(values, patVals, SM, PM, N) {
  let s = 0;
  for (let i = 0; i < 7; i++) for (let p = 0; p < 14; p++) s += values[i] * patVals[p] * N[i * 14 + p];
  return s * SM * PM;
}

function structKey(cfg) {
  return JSON.stringify([cfg.weights.map((w) => w.toFixed(4)), cfg.enabled, cfg.mods.slice(21, 35), cfg.mods.slice(56, 63), cfg.luck, cfg.retrig,
    cfg.force, cfg.extraSpins, cfg.temps.map((t) => [t.kind, t.trigger, t.value, t.mask, t.pats]), cfg.rb.map((r) => [r.cost, r.effects, r.extraTriggers, r.noConsume]),
    cfg.transforms, cfg.randomMul, cfg.dynamo, cfg.spinsPerRound, cfg.roundsPerDeadline, cfg.p666.toFixed(5), cfg.protect666.toFixed(4), cfg.sacred, cfg.spontaneous]);
}

function buildCtx(state, db, built, opt) {
  const { d, env } = built;
  const seed = opt.seed ?? 20251119;
  const cfg = compileSim(d, env);
  const base = simulate(cfg, { seed, deadlines: opt.baseDeadlines ?? 420 });
  const cmp = simulate(cfg, { seed: seed + 7, deadlines: opt.cmpDeadlines ?? 150 });
  const SM = totalSM(d), PM = totalPM(d);
  const N = base.N;
  const dEVdV = SYMBOLS.map((_, s) => { let x = 0; for (let p = 0; p < 14; p++) x += d.patVals[p] * N[s * 14 + p]; return x * SM * PM; });
  const dEVdPV = PATTERNS.map((_, p) => { let x = 0; for (let s = 0; s < 7; s++) x += d.values[s] * N[s * 14 + p]; return x * SM * PM; });
  const lin = linEV(d.values, d.patVals, SM, PM, N) || 1e-9;
  const ev = Math.max(base.evNet, 1e-9);
  const spinsPerRound = base.spinsPerRound;
  const roundsPerDeadline = Math.max(1, cfg.roundsPerDeadline);
  const evRound = ev * spinsPerRound;
  const info = deadlineInfo(env.deadline);
  const debt = info.debt * d.debtMul * (state.mode && state.mode.memory === 'delusions_of_grandeur' ? 2 : 1) * (state.mode && state.mode.memory === 'old_wounds' ? 0.5 : 1);
  const deposited = num(state.deposited);
  const depositEst = deposited !== null ? deposited : Math.min(debt * 0.5, 0.5 * evRound * roundsPerDeadline);
  const interestCoins = (d.interest / 100) * depositEst;
  const g = clamp(num(state.prefs && state.prefs.horizon) ?? 0.7, 0, 1);
  const H = 1 + Math.round(11 * g); // horizon in rounds
  const symShare = base.symCoins.map((x) => x / (base.ev || 1e-9));
  const patShare = base.patCoins.map((x) => x / (base.ev || 1e-9));
  const ownedIds = new Set((state.charms || []).filter((c) => !c.drawer).map((c) => c.id));
  const drawerIds = new Set((state.charms || []).filter((c) => c.drawer).map((c) => c.id));
  const phoneIds = new Set(Object.keys(state.phone || {}).filter((k) => state.phone[k] > 0));
  const p666 = chance666(d, env.deadline, env.sacred);
  return {
    state, db, d, env, cfg, base, cmp, seed, opt, SM, PM, N, dEVdV, dEVdPV, lin, ev, evRound, spinsPerRound,
    roundsPerDeadline, debt, depositEst, interestCoins, g, H, symShare, patShare, ownedIds, drawerIds, phoneIds, p666,
    tickets: num(state.tickets) ?? 0, coins: num(state.coins), key: structKey(cfg), cache: new Map(),
  };
}

// Events per round for "when.on" triggers (rough averages from typical runs).
function eventsPerRound(ev, ctx, n = 1) {
  const R = ctx.roundsPerDeadline;
  const map = {
    roundStart: 1, roundEnd: 1,
    deadlineStart: 1 / R, deadlineEnd: 1 / R,
    purchase: 2 / R, restock: (1.5 + freeRestocksPerDeadline(ctx)) / R, discard: 0.6 / R,
    phonePick: 1 / R, phoneReroll: 0.6 / R, roundSkipped: 0.4 / R,
    charmTriggers: ctx.base.pAnyCharmTrig * ctx.spinsPerRound, dying: 0,
  };
  return (map[ev] ?? 0) / Math.max(1, n);
}

function freeRestocksPerDeadline(ctx) {
  let x = 0;
  for (const e of ctx.d.econ) if (e.kind === 'restocks' && e.per === 'deadline') x += e.amount;
  return x;
}

function postRate(pc, stats, randomMul) {
  if (!pc) return 0;
  switch (pc.kind) {
    case 'patternsAtLeast': return stats.pAtLeast[Math.min(40, pc.n)] || 0;
    case 'patternsExactly': return pc.n === 1 ? stats.pExactly1 : 0;
    case 'noPatterns': return stats.pNone;
    case 'sizeAtLeast': return pc.n >= 5 ? stats.pSize5 : stats.pSize4;
    case 'onlyEye': return stats.pOnlyEye;
    case 'on666': return stats.p666 + stats.p999;
    case 'onJackpot': return stats.pJackpot;
    case 'scoredAll': return stats.pCloverBell;
    case 'scoredAny': return stats.pGem;
    case 'noRewardStreak': return pc.n >= 4 ? stats.pNoReward4 : pc.n === 3 ? stats.pNoReward3 : stats.pNoReward2;
    case 'chance': return Math.min(1, pc.p * randomMul);
    case 'and': return pc.all.reduce((a, x) => a * postRate(x, stats, randomMul), 1);
    default: return 0;
  }
}

// ------------------------------------------------------------------ valuation
// Converts growth entries into per-round linear (A) and log (G) growth of coins.
function growthOf(entries, ctx, d2, stats) {
  let A = 0, G = 0;
  const notes = [];
  const SM = totalSM(d2), PM = totalPM(d2);
  const ev = Math.max(stats.evNet, 1e-9);
  const spr = stats.spinsPerRound;
  for (const gr of entries) {
    let perRound = 0;
    if (gr.rate) {
      if (gr.rate.post) perRound = postRate(gr.rate.post, stats, d2.randomMul) * spr;
      else if (gr.rate.event) perRound = eventsPerRound(gr.rate.event, ctx, gr.rate.n);
      else if (gr.rate.rb) perRound = Math.min(1, (1 + d2.rbExtra) / Math.max(1, gr.rate.rb - d2.rbCostReduce));
      else if (gr.rate.rbRound) perRound = Math.min(1, 1 / Math.max(1, gr.rate.rbRound - d2.rbCostReduce));
    }
    if (!perRound) continue;
    let dA = 0, dG = 0;
    switch (gr.kind) {
      case 'smAdd': dA = (gr.amount * d2.smMul) / Math.max(SM, 1e-9); break;
      case 'pmAdd': dA = (gr.amount * d2.pmMul) / Math.max(PM, 1e-9); break;
      case 'smMul': case 'pmMul': dG = Math.log(gr.mul || 1); break;
      case 'symAddBase': {
        if (gr.mul) { let share = 0; for (const s of maskToList(gr.mask)) share += ctx.symShare[s]; dG = Math.log(1 + (gr.mul - 1) * share); break; }
        let dev = 0;
        for (const s of maskToList(gr.mask)) dev += gr.amount * BASE_VALUE[s] * ctx.dEVdV[s];
        dA = dev / ev; break;
      }
      case 'symAddBaseScored': {
        let dev = 0;
        for (const s of maskToList(gr.mask)) dev += gr.amount * BASE_VALUE[s] * stats.cellEvents[s] * spr * ctx.dEVdV[s];
        dA = dev / ev; break;
      }
      case 'symMul': { let share = 0; for (const s of maskToList(gr.mask)) share += ctx.symShare[s]; dG = Math.log(1 + ((gr.mul || 2) - 1) * share); break; }
      case 'patAddBase': { let dev = 0; for (const p of gr.pats) dev += gr.amount * PATTERN_BASE[p] * ctx.dEVdPV[p]; dA = dev / ev; break; }
      case 'patMul': { let share = 0; for (const p of gr.pats) share += ctx.patShare[p]; dG = Math.log(1 + ((gr.mul || 2) - 1) * share); break; }
      default: break;
    }
    if (gr.resets) { dA *= 0.5; dG *= 0.5; }
    A += dA * perRound;
    G += dG * perRound;
    if (dA || dG) notes.push({ src: gr.src, kind: gr.kind, perRound, dA, dG });
  }
  return { A, G, notes };
}

// Modifier chances added by a candidate -> growth / coins / tickets.
function modifierValue(dBefore, dAfter, ctx, stats) {
  let A = 0, coins = 0, tickets = 0, smBoost = 0;
  const spr = stats.spinsPerRound;
  const ev = Math.max(stats.evNet, 1e-9);
  for (let s = 0; s < 7; s++) {
    const ev_s = stats.cellEvents[s];
    const dGold = dAfter.mods[MOD.golden * 7 + s] - dBefore.mods[MOD.golden * 7 + s];
    if (dGold) A += (dGold * ev_s * spr * BASE_VALUE[s] * ctx.dEVdV[s]) / ev;
    const dTok = dAfter.mods[MOD.token * 7 + s] - dBefore.mods[MOD.token * 7 + s];
    if (dTok) coins += dTok * ev_s * spr * (ctx.interestCoins / 2);
    const dTic = dAfter.mods[MOD.ticket * 7 + s] - dBefore.mods[MOD.ticket * 7 + s];
    if (dTic) tickets += dTic * ev_s * spr;
    const dRise = dAfter.mods[MOD.rising * 7 + s] - dBefore.mods[MOD.rising * 7 + s];
    if (dRise) smBoost += dRise * ev_s * spr;
    const dInv = dAfter.mods[MOD.investor * 7 + s] - dBefore.mods[MOD.investor * 7 + s];
    if (dInv) coins += dInv * ev_s * spr * 0.5 * (ctx.depositEst / 100);
    const dChain = dAfter.mods[MOD.chain * 7 + s] - dBefore.mods[MOD.chain * 7 + s];
    if (dChain) {
      let dev = 0;
      for (let p = 0; p < 14; p++) dev += dChain * ctx.N[s * 14 + p] * PATTERN_SIZE[p] * PATTERN_BASE[p] * ctx.dEVdPV[p] * spr;
      A += dev / ev;
    }
  }
  // Rising: +1 Symbols Multiplier per event until the end of the deadline -> average boost
  const m = smBoost ? 1 + (smBoost * ctx.roundsPerDeadline * 0.5) / Math.max(totalSM(dAfter), 1e-9) : 1;
  return { A, coins, tickets, m };
}

function econOf(entries, ctx, d2) {
  // Returns { tickets (per deadline), restocks (per deadline), coinsPerRound, coinsInstant, interestPts, rounds, deathSave, discount }
  const R = ctx.roundsPerDeadline;
  const out = { tickets: 0, restocks: 0, coinsPerRound: 0, coinsInstant: 0, roundsPerDeadline: 0, roundsInstant: 0, deathSave: 0, discount: 0, ticketMul: 1, resell: 0, charges: 0, reasons: [] };
  const stats = ctx.base;
  for (const e of entries) {
    const per = e.per;
    const rateOf = () => {
      if (!e.when) return 1;
      if (e.when.on) return eventsPerRound(e.when.on, ctx, e.when.n || 1) * R; // per deadline
      const pc = e.when.chance !== undefined && Object.keys(e.when).length === 1 ? { kind: 'chance', p: e.when.chance } : null;
      if (pc) return postRate(pc, stats, d2.randomMul) * ctx.spinsPerRound * R;
      return 1;
    };
    switch (e.kind) {
      case 'tickets': {
        if (e.perUnit) break;
        if (e.mul) { out.tickets += (ctx.tickets * (e.mul - 1)) / Math.max(1, ctx.H / R); break; }
        if (e.set === 0) { out.tickets -= ctx.tickets / Math.max(1, ctx.H / R); break; }
        const amt = e.amount || 0;
        if (per === 'instant') out.tickets += amt / Math.max(1, ctx.H / R);
        else if (per === 'round') out.tickets += amt * R;
        else if (per === 'deadline') out.tickets += amt;
        else out.tickets += amt * rateOf();
        break;
      }
      case 'ticketIncome': out.ticketMul *= e.set === 0 ? 0 : (e.mul || 1); break;
      case 'restocks': {
        const amt = e.amount || 0;
        if (per === 'instant') out.restocks += amt / Math.max(1, ctx.H / R);
        else if (per === 'deadline') out.restocks += amt;
        else if (per === 'round') out.restocks += amt * R;
        else out.restocks += amt * rateOf();
        break;
      }
      case 'coinsInterest': {
        let perSpin = 1;
        if (e.when) {
          const pc = postCondOf(e.when);
          perSpin = pc ? postRate(pc, stats, d2.randomMul) : 0;
        }
        out.coinsPerRound += perSpin * ctx.spinsPerRound * e.multiple * ((d2.interest / 100) * ctx.depositEst);
        break;
      }
      case 'coins': {
        let amt = e.amount || 0;
        if (e.debtFraction) amt = e.debtFraction * ctx.debt;
        if (e.mul) amt = (ctx.coins ?? ctx.evRound) * (e.mul - 1);
        if (e.set === 0) amt = -(ctx.coins ?? ctx.evRound);
        if (per === 'instant') out.coinsInstant += amt;
        else if (per === 'round') out.coinsPerRound += amt;
        else if (per === 'deadline') out.coinsPerRound += amt / R;
        else out.coinsPerRound += (amt * rateOf()) / R;
        break;
      }
      case 'interest': {
        const amt = e.amount || 0;
        const val = (amt / 100) * ctx.depositEst;
        if (per === 'rb') out.coinsPerRound += (val / Math.max(1, e.cost)) * R * 0.5;
        else if (per === 'instant') out.coinsPerRound += val * 0.6;
        else out.coinsPerRound += val;
        break;
      }
      case 'rounds': {
        if (per === 'instant') out.roundsInstant += e.amount || 1;
        else if (per === 'rb') out.roundsPerDeadline += Math.min(1, (e.amount || 1) * R / Math.max(1, e.cost));
        else out.roundsPerDeadline += e.amount || 0;
        break;
      }
      case 'discount': out.discount += (e.amount || 0) * 2 + (e.freeCharms || 0) * 3; break;
      case 'deathSave': out.deathSave += 1; break;
      case 'resell': out.resell += e.amount || 0; break;
      case 'charges': out.charges += 1; break;
      default: break;
    }
  }
  return out;
}

function postCondOf(when) {
  if (when.patternsAtLeast) return { kind: 'patternsAtLeast', n: when.patternsAtLeast };
  if (when.chance !== undefined) return { kind: 'chance', p: when.chance };
  if (when.on === '666') return { kind: 'on666' };
  if (when.noPatterns) return { kind: 'noPatterns' };
  if (when.patternSizeAtLeast) return { kind: 'sizeAtLeast', n: when.patternSizeAtLeast };
  return null;
}

function horizonValue(m, A, G, C, H, life = Infinity) {
  // average coins per round over H rounds relative to the current build (=1)
  let s = 0;
  for (let t = 0; t < H; t++) {
    const active = t < life;
    s += active ? m * (1 + A * t) * Math.exp(Math.min(G * t, 8)) + C : 1;
  }
  return s / H;
}

function lifetimeRounds(model, item, stats) {
  let life = Infinity;
  for (const e of (model && model.effects) || []) {
    const da = e.discardAfter;
    if (da) {
      if (da.of === 'rounds') life = Math.min(life, da.count);
      else if (da.of === 'activations' || da.of === 'uses') {
        const p = e.when && e.when.chance ? e.when.chance : 0.2;
        life = Math.min(life, da.count / Math.max(0.05, p * stats.spinsPerRound));
      }
    }
    if (e.decay && e.decay.add < 0 && e.add) life = Math.min(life, Math.abs(e.add / e.decay.add) / (e.decay.per === 'round' ? 1 : 3) / 2 + 0.5);
  }
  return life;
}

// ------------------------------------------------------------------ build profile
const ARCH_LABELS = {
  lemon: 'Lemon', cherry: 'Cherry', clover: 'Clover', bell: 'Bell', diamond: 'Diamond', treasure: 'Treasure', seven: 'Seven',
  fruit: 'Fruit', gems: 'Gems', jackpot: 'Luck / Jackpot', retrigger: 'Retrigger', multiplier: 'Multiplier scaling', golden: 'Golden',
  chain: 'Chain', interest: 'Interest / Cats', tickets: 'Ticket economy', redButton: 'Red Button', devil: '666 / Devil',
  sacred: 'Sacred (999)', noReward: 'No-reward (Trains)', phone: 'Phone', traits: 'Traits', discard: 'Discard', restock: 'Restock',
};
export { ARCH_LABELS };

function buildArchetypes(ctx) {
  const w = {};
  const add = (k, v) => { w[k] = (w[k] || 0) + v; };
  const ids = [...ctx.ownedIds, ...ctx.phoneIds];
  for (const id of ids) {
    const it = ctx.db.byId.get(id);
    if (it && it.model) for (const a of it.model.archetypes || []) add(a, 1);
  }
  const mem = ctx.state.mode && ctx.db.byId.get(ctx.state.mode.memory);
  if (mem && mem.model) for (const a of mem.model.archetypes || []) add(a, 0.5);
  // symbol focus from the simulation (only when it deviates from the even spread)
  SYMBOLS.forEach((s, i) => { const share = ctx.symShare[i]; if (share > 0.22) add(s, (share - 0.14) * 8); });
  const fruit = ctx.symShare[0] + ctx.symShare[1], gems = ctx.symShare[4] + ctx.symShare[5] + ctx.symShare[6];
  if (fruit > 0.45) add('fruit', (fruit - 0.3) * 5);
  if (gems > 0.55) add('gems', (gems - 0.4) * 5);
  if (ctx.env.sacred) add('sacred', 2);
  if (ctx.p666 > 0.04) add('devil', (ctx.p666 - 0.02) * 40);
  const list = Object.entries(w).filter(([, v]) => v > 0.3).sort((a, b) => b[1] - a[1]);
  const total = list.reduce((a, [, v]) => a + v, 0) || 1;
  return list.map(([k, v]) => ({ id: k, label: ARCH_LABELS[k] || k, weight: v / total, raw: v }));
}

function supportFor(tag, ctx) {
  const st = ctx.base, d = ctx.d;
  const owned = [...ctx.ownedIds].map((id) => ctx.db.byId.get(id)).filter(Boolean);
  const countProv = (t) => owned.filter((it) => it.model && (it.model.provides || []).includes(t)).length;
  if (SYM[tag] !== undefined) return clamp(ctx.symShare[SYM[tag]] * 4, 0, 1.6);
  switch (tag) {
    case 'fruit': return clamp((ctx.symShare[0] + ctx.symShare[1]) * 2.5, 0, 1.6);
    case 'yellow': return clamp((ctx.symShare[0] + ctx.symShare[3] + ctx.symShare[5] + ctx.symShare[6]) * 1.8, 0, 1.6);
    case 'nonYellow': return clamp((ctx.symShare[1] + ctx.symShare[2] + ctx.symShare[4]) * 2.2, 0, 1.6);
    case 'patternCount': return clamp(st.pAtLeast[3] * 6 + st.avgPatterns * 0.4, 0, 1.6);
    case 'luck': return clamp(st.luckAvg / 3, 0, 1.6);
    case 'retrigger': return clamp(countProv('retrigger') * 0.45, 0, 1.6);
    case 'redButton': case 'charges': return clamp(owned.filter((it) => it.redButtonCharges).length * 0.4, 0, 1.6);
    case 'triggersRandomly': return clamp(owned.filter((it) => it.triggersRandomly).length * 0.45, 0, 1.6);
    case 'phone': return clamp(0.4 + Math.max(0, 9 - ctx.env.deadline) * 0.1, 0, 1.6);
    case 'tickets': return clamp(ctx.tickets / 15, 0, 1.6);
    case 'interest': return clamp((d.interest - 7) / 8 + 0.3, 0, 1.6);
    case 'noReward': return clamp(st.pNone * 1.8, 0, 1.6);
    case '666': return clamp(ctx.p666 * 18, 0, 1.6);
    case '999': case 'sacred': return ctx.env.sacred ? 1.4 : 0.1;
    case 'traits': return clamp((ctx.state.charms || []).filter((c) => c.trait).length * 0.4, 0, 1.6);
    case 'restock': return clamp(freeRestocksPerDeadline(ctx) * 0.4 + 0.3, 0, 1.6);
    case 'discard': return clamp(owned.filter((it) => it.model && (it.model.provides || []).includes('temporary')).length * 0.4 + 0.2, 0, 1.6);
    case 'charmCount': return clamp(owned.length / 7, 0, 1.6);
    case 'symbolValue': case 'symbolChance': case 'symbolsMult': case 'patternsMult': case 'patternValue': return 1;
    case 'jackpot': return clamp(st.pJackpot * 40 + st.luckAvg / 6, 0, 1.6);
    case 'eye': return clamp(st.pOnlyEye * 60 + ctx.patShare[9] * 3, 0, 1.6);
    case 'aboveBelow': return clamp((ctx.patShare[7] + ctx.patShare[8]) * 3, 0, 1.6);
    case 'largePatterns': return clamp(st.pSize4 * 3, 0, 1.6);
    case 'smallPatterns': return clamp((ctx.patShare[0] + ctx.patShare[1] + ctx.patShare[2]) * 1.5, 0, 1.6);
    case 'drawers': return ctx.env.deadline >= 5 ? 1 : 0.6;
    case 'golden': case 'chain': case 'token': case 'ticketMod': case 'repetition': case 'battery': return clamp(countProv(tag) * 0.5 + 0.2, 0, 1.6);
    default: return 0.6;
  }
}

// ------------------------------------------------------------------ candidates
function candidatePool(ctx) {
  const { db, env, state } = ctx;
  const out = [];
  const charmsOwned = ctx.ownedIds;
  for (const it of db.charms) {
    if (it.category !== 'store') continue;
    if (!env.dlc && it.dlc) continue;
    if (charmsOwned.has(it.id) || ctx.drawerIds.has(it.id)) continue;
    out.push(it);
  }
  for (const it of db.phone) {
    if (!env.dlc && it.dlc) continue;
    if (it.type === 'sacred' && !env.sacred) continue;
    if (it.type === 'red' && env.sacred) continue;
    const taken = (state.phone || {})[it.id] || 0;
    if (it.maxUses && taken >= it.maxUses) continue;
    out.push(it);
  }
  return out;
}

function simFor(d2, ctx) {
  const cfg2 = compileSim(d2, ctx.env);
  const key = structKey(cfg2);
  if (key === ctx.key) return { stats: ctx.cmp, same: true };
  if (ctx.cache.has(key)) return { stats: ctx.cache.get(key), same: false };
  const stats = simulate(cfg2, { seed: ctx.seed + 7, deadlines: ctx.opt.cmpDeadlines ?? 150 });
  ctx.cache.set(key, stats);
  return { stats, same: false };
}

/**
 * Evaluate adding one item to the build.
 */
export function evaluateItem(it, ctx, extra = {}) {
  const model = it.model;
  const reasons = [];
  const d2 = cloneDerived(ctx.d);
  const times = it.kind === 'phone' ? 1 + ctx.d.phoneExtra : 1;
  const cov = model ? applyModel(d2, model, { item: it, times }) : { handled: 0, total: 0, unhandled: [] };
  if (extra.trait) applyTrait(d2, extra.trait, it.id);
  // phone abilities that apply a trait to a random equipped charm
  for (const m of d2.meta.filter((x) => x.src === it.id && x.kind === 'trait')) {
    const equipped = (ctx.state.charms || []).filter((c) => !c.drawer).length;
    if (!equipped && m.target !== 'store') continue;
    if (m.target === 'store') continue;
    const tr = m.apply === 'random' ? null : m.apply;
    if (tr) applyTrait(d2, tr, it.id);
    else { // random trait: average of the seven
      d2.smAdd += 2 / 7; d2.pmAdd += 1 / 7; d2.interest += 3 / 7; d2.chance666Add += 0.6 / 7;
    }
  }

  // ---- coins now
  const { stats, same } = simFor(d2, ctx);
  const SM2 = totalSM(d2), PM2 = totalPM(d2);
  let m;
  if (same) {
    const lin2 = linEV(d2.values, d2.patVals, SM2, PM2, ctx.N);
    m = lin2 / ctx.lin;
  } else {
    // the candidate simulation already includes its value / multiplier changes
    m = (stats.evNet * stats.spinsPerRound) / Math.max(ctx.cmp.evNet * ctx.cmp.spinsPerRound, 1e-9);
  }
  if (!Number.isFinite(m) || m <= 0) m = 1e-6;
  // 666 / protection changes that the linear path cannot see
  if (same) {
    const p1 = chance666(ctx.d, ctx.env.deadline), p2 = chance666(d2, ctx.env.deadline);
    if (p1 !== p2 || ctx.d.protect666 !== d2.protect666) {
      const loss = (p, pr) => 1 - Math.min(0.9, 3.5 * p * (1 - pr));
      m *= loss(p2, d2.protect666) / loss(p1, ctx.d.protect666);
    }
  }
  // more rounds per deadline = more coins per deadline
  if (d2.roundsPerDeadline !== ctx.d.roundsPerDeadline) m *= d2.roundsPerDeadline / ctx.d.roundsPerDeadline;
  if (d2.debtMul !== ctx.d.debtMul) m /= d2.debtMul / ctx.d.debtMul;

  // ---- growth
  const newGrowth = d2.growth.slice(ctx.d.growth.length);
  const gr = growthOf(newGrowth, ctx, d2, same ? ctx.base : stats);
  const mv = modifierValue(ctx.d, d2, ctx, same ? ctx.base : stats);
  m *= mv.m;
  let A = gr.A + mv.A, G = gr.G;
  // per-unit multipliers (Lost Wallet, CloverPet, Shopping Cart, Dark Lotus, The Collector, ...)
  for (const g of newGrowth) {
    if (g.kind !== 'smPerUnit' && g.kind !== 'pmPerUnit') continue;
    const units = unitsOf(g.unit, ctx);
    const per = g.unit.per || 1;
    const bonus = Math.floor(units / per) * g.amount;
    const isSM = g.kind === 'smPerUnit';
    const cur = isSM ? SM2 : PM2;
    m *= (cur + bonus) / Math.max(cur, 1e-9);
    const growthUnits = unitGrowthPerRound(g.unit, ctx);
    A += ((growthUnits / per) * g.amount) / Math.max(cur + bonus, 1e-9);
  }

  // ---- economy & coin income
  const newEcon = d2.econ.slice(ctx.d.econ.length);
  const ec = econOf(newEcon, ctx, d2);
  const R = ctx.roundsPerDeadline;
  ec.tickets += mv.tickets * R;
  if (ec.ticketMul !== 1) ec.tickets += (ec.ticketMul - 1) * (R * 1.2 + 1.5);
  const evRound = Math.max(ctx.evRound, 1e-9);
  const C = (ec.coinsPerRound + mv.coins) / evRound + (ec.roundsPerDeadline / R);
  const instantC = ec.coinsInstant / evRound / Math.max(1, ctx.H);
  const life = lifetimeRounds(model, it, stats);
  const V = horizonValue(m, A, G, C + instantC + ec.roundsInstant / ctx.H, ctx.H, life);
  const Vnow = horizonValue(m, A, G, C + ec.coinsInstant / evRound + ec.roundsInstant, 1, life);

  // ---- scores
  const coinScore = 100 * Math.tanh(Math.log2(Math.max(V, 1e-6)) / 0.8);
  const econScore = 100 * Math.tanh((ec.tickets + 0.5 * ec.restocks + ec.discount) / 6);
  const charmSpaceDelta = d2.charmSpace - ctx.d.charmSpace;
  let utility = 0;
  if (charmSpaceDelta) utility += 35 * charmSpaceDelta;
  if (ec.deathSave) utility += 30;
  if (d2.protect666 > ctx.d.protect666 && ctx.env.deadline >= 2) utility += 60 * (d2.protect666 - ctx.d.protect666) * Math.min(1, ctx.p666 * 25 + 0.2);
  const r = (model && model.ratings) || { power: 3, scaling: 3, economy: 2, utility: 2, risk: 1 };
  const prior = 10 * (r.power * (1 - ctx.g) + r.scaling * ctx.g);
  const quant = cov.total ? cov.handled / cov.total : 0;
  const measured = Math.abs(V - 1) > 0.004 || ec.tickets || ec.restocks;

  // cares / synergy
  const cares = (model && model.cares) || [];
  let careFactor = 1;
  const careNotes = [];
  if (cares.length) {
    const sup = cares.map((t) => [t, supportFor(t, ctx)]);
    careFactor = clamp(sup.reduce((a, [, v]) => a + v, 0) / sup.length, 0.15, 1.5);
    for (const [t, v] of sup) {
      if (v >= 1) careNotes.push(t);
    }
  }
  let syn = 0;
  const synReasons = [];
  const mine = [...ctx.ownedIds, ...ctx.phoneIds, ...ctx.drawerIds, ctx.state.mode && ctx.state.mode.memory].filter(Boolean);
  for (const s of (model && model.synergies) || []) {
    if (mine.includes(s.id)) { syn += 9; synReasons.push({ type: 'syn', id: s.id, why: s.why }); }
  }
  for (const s of (model && model.antiSynergies) || []) {
    if (mine.includes(s.id)) { syn -= 12; synReasons.push({ type: 'anti', id: s.id, why: s.why }); }
  }
  for (const id of mine) {
    const o = ctx.db.byId.get(id);
    if (!o || !o.model) continue;
    for (const s of o.model.synergies || []) if (s.id === it.id && !synReasons.some((x) => x.id === id)) { syn += 7; synReasons.push({ type: 'syn', id, why: s.why }); }
    for (const s of o.model.antiSynergies || []) if (s.id === it.id && !synReasons.some((x) => x.id === id)) { syn -= 9; synReasons.push({ type: 'anti', id, why: s.why }); }
  }
  syn = clamp(syn, -30, 30);
  let archBonus = 0;
  const archHits = [];
  for (const a of (model && model.archetypes) || []) {
    const hit = ctx.arch.find((x) => x.id === a);
    if (hit) { archBonus += 22 * hit.weight; archHits.push(hit.label); }
  }
  archBonus = clamp(archBonus, 0, 15);

  let power;
  if (measured && quant > 0) power = 0.8 * quant * coinScore + (1 - 0.8 * quant) * prior * careFactor;
  else power = prior * careFactor;
  const devilBuild = ctx.arch.some((x) => x.id === 'devil' && x.weight > 0.15);
  const riskPenalty = (r.risk || 0) * (devilBuild && (model.provides || []).includes('666') ? 0.3 : 1.4);
  let score = power + 0.3 * econScore * (ctx.g > 0.5 ? 1 : 1.2) + 0.35 * utility + syn + archBonus - riskPenalty
    + 0.12 * (r.economy || 0) * 10 * (1 - quant) + 0.1 * (r.utility || 0) * 10 * (1 - quant);

  // ---- reasons (most important first)
  if (measured && Math.abs(V - 1) > 0.004) {
    const now = Vnow - 1, avg = V - 1;
    if (Math.abs(now) >= 0.01) reasons.push({ kind: now > 0 ? 'good' : 'bad', text: `${fmtPct(now)} coins per round right away` });
    if (Math.abs(V - Vnow) > 0.02 && ctx.H > 1) {
      if (V > Vnow) reasons.push({ kind: 'good', text: `${fmtPct(avg)} on average over the next ${ctx.H} rounds as it grows` });
      else reasons.push({ kind: avg >= 0 ? 'neutral' : 'bad', text: `Fades: ${fmtPct(avg)} on average over the next ${ctx.H} rounds` });
    }
  }
  if (A > 0.004 || G > 0.002) {
    const per = A + G;
    reasons.push({ kind: 'good', text: `Scales: about ${fmtPct(per)} more coins every round, permanently` });
  }
  topSymbolReason(it, model, ctx, reasons);
  for (const s of synReasons.slice(0, 3)) {
    const o = ctx.db.byId.get(s.id);
    reasons.push({ kind: s.type === 'syn' ? 'good' : 'bad', text: `${s.type === 'syn' ? 'Combos with' : 'Clashes with'} ${o ? o.name : s.id}: ${s.why}` });
  }
  if (archHits.length) reasons.push({ kind: 'good', text: `Fits your ${archHits.slice(0, 2).join(' + ')} build` });
  if (cares.length && careFactor < 0.45 && quant < 0.5) reasons.push({ kind: 'bad', text: `Needs ${cares.map(tagLabel).slice(0, 2).join(' / ')} support you don't have yet` });
  else if (careNotes.length && quant < 0.8) reasons.push({ kind: 'good', text: `Your build supports it (${careNotes.map(tagLabel).slice(0, 2).join(', ')})` });
  if (ec.tickets > 0.5) reasons.push({ kind: 'good', text: `About +${ec.tickets.toFixed(1)} tickets per deadline` });
  if (ec.tickets < -0.5) reasons.push({ kind: 'bad', text: `Costs about ${Math.abs(ec.tickets).toFixed(1)} tickets per deadline` });
  if (ec.restocks > 0.4) reasons.push({ kind: 'good', text: `About +${ec.restocks.toFixed(1)} free restocks per deadline` });
  if (charmSpaceDelta) reasons.push({ kind: charmSpaceDelta > 0 ? 'good' : 'bad', text: `${charmSpaceDelta > 0 ? '+' : ''}${charmSpaceDelta} charm space` });
  const p1 = chance666(ctx.d, ctx.env.deadline), p2 = chance666(d2, ctx.env.deadline);
  if (p2 > p1 + 1e-6) reasons.push({ kind: devilBuild ? 'good' : 'bad', text: `666 chance ${(p1 * 100).toFixed(1)}% → ${(p2 * 100).toFixed(1)}%` });
  if (d2.protect666 > ctx.d.protect666 + 1e-6) reasons.push({ kind: 'good', text: 'Protects you from 666' });
  if (Number.isFinite(life) && life < ctx.H) reasons.push({ kind: 'neutral', text: `Temporary: lasts about ${Math.max(1, Math.round(life))} round${life >= 1.5 ? 's' : ''}` });
  if (quant < 0.5 && model && model.tip) reasons.push({ kind: 'neutral', text: model.tip });

  const price = extra.price ?? (it.kind === 'charm' ? it.cost : 0);
  const affordable = it.kind !== 'charm' || price == null || price <= ctx.tickets;
  return {
    id: it.id, kind: it.kind, name: it.name, score, price, affordable,
    parts: { power: Math.round(power), coins: Math.round(coinScore), econ: Math.round(econScore), utility: Math.round(utility), synergy: Math.round(syn + archBonus), risk: Math.round(riskPenalty), prior: Math.round(prior) },
    value: { now: Vnow, horizon: V, growthPerRound: A + G, ticketsPerDeadline: ec.tickets },
    quant, reasons: dedupeReasons(reasons).slice(0, 7), tier: model ? model.tier : null,
  };
}

function dedupeReasons(rs) {
  const seen = new Set();
  return rs.filter((r) => { if (seen.has(r.text)) return false; seen.add(r.text); return true; });
}

function topSymbolReason(it, model, ctx, reasons) {
  if (!model) return;
  const syms = (model.provides || []).filter((t) => SYM[t] !== undefined);
  if (!syms.length) return;
  const best = syms.map((t) => [t, ctx.symShare[SYM[t]]]).sort((a, b) => b[1] - a[1])[0];
  if (best[1] >= 0.25) reasons.push({ kind: 'good', text: `${SYMBOL_NAMES[SYM[best[0]]]}s make ${Math.round(best[1] * 100)}% of your coins` });
  else if (best[1] < 0.1) reasons.push({ kind: 'bad', text: `${SYMBOL_NAMES[SYM[best[0]]]}s make only ${Math.round(best[1] * 100)}% of your coins` });
}

const TAG_LABELS = {
  patternCount: 'many patterns per spin', noReward: 'spins without reward', triggersRandomly: 'random-trigger charms',
  redButton: 'Red Button charms', charges: 'charge sources', phone: 'phone calls', tickets: 'ticket stockpile', interest: 'Interest',
  '666': '666 hits', '999': '999 hits', traits: 'charm traits', restock: 'restocks', discard: 'discarding', retrigger: 'retriggers',
  luck: 'Luck', charmCount: 'many charms', jackpot: 'jackpots', eye: 'EYE patterns', aboveBelow: 'ABOVE/BELOW patterns',
};
function tagLabel(t) { return TAG_LABELS[t] || (SYM[t] !== undefined ? SYMBOL_NAMES[SYM[t]] + 's' : t); }

function unitsOf(unit, ctx) {
  switch (unit.of) {
    case 'tickets': return ctx.tickets;
    case 'freeRestocks': return freeRestocksPerDeadline(ctx) * 0.5 + 1;
    case 'phoneRerolls': return Math.max(0, ctx.env.deadline - 1) * 0.6;
    case 'redCallsRefused': return Math.max(0, Math.floor((ctx.env.deadline - 1) / 3));
    case 'traitsEquipped': return (ctx.state.charms || []).filter((c) => c.trait).length;
    case 'resellTotal': return [...ctx.ownedIds].reduce((a, id) => { const x = ctx.db.byId.get(id); return a + Math.max(1, Math.floor(((x && x.cost) || 2) / 2)); }, 0);
    case 'skippedRounds': return Math.max(0, ctx.env.deadline - 1) * 0.4;
    default: return 0;
  }
}

function unitGrowthPerRound(unit, ctx) {
  const R = ctx.roundsPerDeadline;
  switch (unit.of) {
    case 'tickets': return 1.2;
    case 'phoneRerolls': return 0.6 / R;
    case 'redCallsRefused': return 0.33 / R;
    case 'skippedRounds': return 0.4 / R;
    default: return 0;
  }
}

// ------------------------------------------------------------------ owned contributions
// Value of each equipped charm = evaluating it as if it were added to the build without it.
function ownedContributions(ctx) {
  const out = [];
  const charms = (ctx.state.charms || []).filter((c) => !c.drawer);
  for (const c of charms) {
    const it = ctx.db.byId.get(c.id);
    if (!it) continue;
    const st2 = { ...ctx.state, charms: ctx.state.charms.filter((x) => x !== c) };
    const built = deriveBuild(st2, ctx.db);
    const ctx2 = buildCtx(st2, ctx.db, built, { ...ctx.opt, baseDeadlines: ctx.opt.ownedDeadlines ?? 140 });
    ctx2.arch = ctx.arch;
    ctx2.cache.set(ctx.key, ctx.cmp);
    const e = evaluateItem(it, ctx2, { trait: c.trait || null });
    out.push({
      id: c.id, name: it.name, trait: c.trait || null, score: e.score,
      now: e.value.now, horizon: e.value.horizon, growth: e.value.growthPerRound,
      reasons: e.reasons.slice(0, 3),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ------------------------------------------------------------------ deadline check
function deadlineCheck(ctx) {
  const R = ctx.roundsPerDeadline;
  const lever = deadlineInfo(ctx.env.deadline).lever * (ctx.base.spinsPerRound / 7);
  const perRound = ctx.base.evNet * ctx.base.spinsPerRound + (ctx.d.interest / 100) * ctx.depositEst - lever;
  const expected = perRound * R;
  const need = ctx.debt;
  const ratio = expected / Math.max(need, 1);
  let status = 'unknown';
  if (ratio >= 1.6) status = 'safe';
  else if (ratio >= 1.0) status = 'ok';
  else if (ratio >= 0.6) status = 'tight';
  else status = 'danger';
  return { expectedPerRound: perRound, expectedPerDeadline: expected, debt: need, ratio, status, leverPerRound: lever };
}

// ------------------------------------------------------------------ main
export function analyze(state, db, opt = {}) {
  const built = deriveBuild(state, db);
  const ctx = buildCtx(state, db, built, opt);
  ctx.arch = buildArchetypes(ctx);
  const check = deadlineCheck(ctx);
  const owned = opt.skipOwned ? [] : ownedContributions(ctx);
  // weakest owned charm (for "replace" suggestions when the table is full)
  const spaceUsed = (state.charms || []).filter((c) => !c.drawer && !(db.byId.get(c.id) || {}).noSpace).length;
  const full = spaceUsed >= ctx.d.charmSpace;
  const weakest = owned.length ? owned[owned.length - 1] : null;

  const pool = opt.pool || candidatePool(ctx);
  const evals = [];
  for (const it of pool) {
    try { evals.push(evaluateItem(it, ctx)); } catch (err) { evals.push({ id: it.id, kind: it.kind, name: it.name, score: -999, error: String(err), reasons: [], parts: {} }); }
  }
  evals.sort((a, b) => b.score - a.score);
  const charms = evals.filter((x) => x.kind === 'charm');
  const phone = evals.filter((x) => x.kind === 'phone');

  // offers (what the player sees right now)
  const offers = [];
  for (const o of state.offers || []) {
    const it = db.byId.get(o.id);
    if (!it) continue;
    const ev = evaluateItem(it, ctx, { price: num(o.price) ?? (it.kind === 'charm' ? it.cost : 0), trait: o.trait || null });
    offers.push({ ...ev, offerPrice: num(o.price) });
  }
  offers.sort((a, b) => b.score - a.score);
  for (const o of offers) {
    if (o.kind === 'charm' && o.price) o.perTicket = o.score / Math.max(1, o.price);
  }

  const st = ctx.base;
  return {
    engine: ENGINE_VERSION,
    build: {
      ev: st.evNet, evGross: st.ev, evRound: st.evNet * st.spinsPerRound,
      spinsPerRound: st.spinsPerRound, roundsPerDeadline: ctx.roundsPerDeadline,
      SM: ctx.SM, PM: ctx.PM, interest: ctx.d.interest, charmSpace: ctx.d.charmSpace, spaceUsed, full,
      weights: ctx.d.weights.slice(), values: ctx.d.values.slice(), patVals: ctx.d.patVals.slice(),
      chances: ctx.d.weights.map((w) => w / ctx.d.weights.reduce((a, b) => a + b, 0)),
      symShare: ctx.symShare, patShare: ctx.patShare,
      pNone: st.pNone, pAtLeast3: st.pAtLeast[3], pAtLeast5: st.pAtLeast[5], pAtLeast7: st.pAtLeast[7], pJackpot: st.pJackpot,
      avgPatterns: st.avgPatterns, luckAvg: st.luckAvg, p666: ctx.p666, protect666: ctx.d.protect666,
      archetypes: ctx.arch, horizonRounds: ctx.H, debt: ctx.debt,
    },
    check, owned, weakest: full ? weakest : null,
    recommendations: { all: evals, charms, phone },
    offers,
  };
}
