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
  newDerived, cloneDerived, applyModel, applyTrait, compileSim, totalSM, totalPM, chance666, postCond, protect666Of, symCtx,
} from './effects.js';
import {
  SYMBOLS, SYMBOL_NAMES, SYMBOL_PLURALS, PATTERNS, PATTERN_NAMES, BASE_VALUE, BASE_WEIGHT, PATTERN_BASE, PATTERN_SIZE,
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
  const first = deriveOnce(state, db, null);
  const st = state.stats || {};
  if (!hasNumbers(st.values) && !hasNumbers(st.chances)) return first;
  // "most valuable / most probable symbol" targets (Expired Meds, Sloth) follow the in-game numbers typed in
  return deriveOnce(state, db, symCtx(first.d));
}

const hasNumbers = (o) => !!o && typeof o === 'object' && Object.values(o).some((v) => num(v) !== null);

function deriveOnce(state, db, forcedSym) {
  const d = newDerived();
  const dl = Number(state.deadline);
  const env = {
    deadline: clamp(Number.isFinite(dl) ? Math.round(dl) : 1, 1, 30),
    sacred: !!(state.mode && state.mode.sacred),
    hard: !!(state.mode && state.mode.hard),
    dlc: !(state.mode && state.mode.dlc === false),
  };
  const opt = (item, times = 1) => ({ item, times, symCtx: forcedSym });
  const coverage = [];
  const mem = state.mode && state.mode.memory && db.byId.get(state.mode.memory);
  if (mem && mem.model) coverage.push([mem.id, applyModel(d, mem.model, opt(mem))]);
  // First Love: every phone ability of the run triggers once more. Megaphone (a charm) is not counted
  // here, because calls taken before it was bought were not doubled; "Took it" adds its extra instead.
  d.memPhoneExtra = d.phoneExtra;
  const charms = Array.isArray(state.charms) ? state.charms : [];
  const equipped = charms.filter((c) => c && !c.drawer && db.byId.has(c.id));
  // traits the player already marked on charms by hand, so a trait call isn't counted twice
  const handTraits = {};
  for (const c of equipped) if (c.trait) handTraits[c.trait] = (handTraits[c.trait] || 0) + 1;
  for (const [id, count] of Object.entries(state.phone || {})) {
    const it = db.byId.get(id);
    const n = Math.min(99, Math.floor(Number(count)));
    if (!it || !it.model || !Number.isFinite(n) || n <= 0) continue;
    const times = n * (1 + d.memPhoneExtra);
    const before = d.meta.length;
    coverage.push([id, applyModel(d, it.model, opt(it, times))]);
    applyCallTraits(d, d.meta.slice(before), times, equipped.length, handTraits);
  }
  for (const c of charms) {
    if (!c || c.drawer) continue;
    const it = db.byId.get(c.id);
    if (!it) continue;
    if (it.model) coverage.push([c.id, applyModel(d, it.model, opt(it))]);
    if (c.trait) applyTrait(d, c.trait, c.id);
    if (c.id === 'depression') d.flags.depression = true;
  }
  // per-unit multipliers of owned charms (Lost Wallet, CloverPet, Chastity Belt...)
  const uctx = { state, db, env, d, tickets: Math.max(0, num(state.tickets) ?? 0), ownedIds: new Set(equipped.map((c) => c.id)) };
  for (const g of d.growth) {
    if (g.kind === 'smPerUnit') d.smAdd += perUnitBonus(g, uctx);
    else if (g.kind === 'pmPerUnit') d.pmAdd += perUnitBonus(g, uctx);
  }
  if (env.hard) d.debtMul *= 1 + 0.25 * (env.deadline - 1);
  applyOverrides(d, state.stats || {});
  return { d, env, coverage };
}

// Phone calls that put a trait on a random equipped charm (Avid, Devious...). `metas` are the call's
// own meta entries. With `handTraits`, traits the player already marked on a charm are skipped.
function applyCallTraits(d, metas, times, equipped, handTraits = null) {
  if (!equipped) return;
  for (const m of metas) {
    if (m.kind !== 'trait' || m.target === 'store') continue;
    const tr = m.apply === 'random' ? null : m.apply;
    // "all equipped charms" gives each charm one trait (a charm holds one trait at a time)
    const reps = m.target === 'allEquipped' ? equipped : times;
    for (let k = 0; k < reps; k++) {
      if (tr && handTraits && handTraits[tr] > 0) { handTraits[tr]--; continue; }
      if (tr) applyTrait(d, tr, m.src);
      else { d.smAdd += 2 / 7; d.pmAdd += 1 / 7; d.interest += 3 / 7; d.chance666Add += 0.6 / 7; } // average of the 7 traits
    }
  }
}

function perUnitBonus(g, ctx) {
  const per = g.unit.per === 'deadline' ? ctx.env.deadline : Math.max(1, g.unit.per || 1);
  const b = Math.floor(unitsOf(g.unit, ctx) / per) * g.amount;
  return Math.max(0, Math.min(g.cap ?? Infinity, b));
}

function num(x) { return x !== null && x !== undefined && x !== '' && Number.isFinite(+x) ? +x : null; }

function applyOverrides(d, st) {
  if (st.values) SYMBOLS.forEach((s, i) => { const v = num(st.values[s]); if (v !== null) d.values[i] = Math.max(0, v); });
  if (st.patterns) PATTERNS.forEach((p, i) => { const v = num(st.patterns[p]); if (v !== null) d.patVals[i] = Math.max(0, v); });
  if (st.chances) {
    // Typed chances are used as they are; the symbols left empty share what's left of 100%
    // in proportion to their calculated chances.
    const given = SYMBOLS.map((s) => { const v = num(st.chances[s]); return v === null ? null : Math.max(0, v); });
    if (given.some((x) => x !== null)) {
      const tot = d.weights.reduce((a, b) => a + b, 0) || 1;
      const sumGiven = given.reduce((a, g) => a + (g ?? 0), 0);
      const restW = d.weights.reduce((a, w, i) => a + (given[i] === null ? w : 0), 0);
      const remain = Math.max(0, 100 - sumGiven);
      const pct = given.map((g, i) => (g !== null ? g : restW > 0 ? (remain * d.weights[i]) / restW : 0));
      const sumPct = pct.reduce((a, b) => a + b, 0);
      if (sumPct > 0) d.weights = pct.map((x) => (x / sumPct) * tot);
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
  // Pain Killers turns lone patterns into the most valuable symbol, so which symbol that is matters
  let best = -1;
  if (cfg.transforms.painKillers) { best = 0; for (let s = 1; s < 7; s++) if (cfg.values[s] > cfg.values[best]) best = s; }
  return JSON.stringify([cfg.weights.map((w) => w.toFixed(4)), cfg.enabled, cfg.mods.slice(21, 35), cfg.mods.slice(56, 63), cfg.luck, cfg.retrig,
    cfg.force, cfg.extraSpins, cfg.temps.map((t) => [t.kind, t.trigger, t.value, t.mask, t.pats]), cfg.rb.map((r) => [r.src, r.cost, r.effects, r.extraTriggers, r.noConsume, r.roundScoped]),
    cfg.transforms, best, cfg.randomMul, cfg.spinsPerRound, cfg.roundsPerDeadline, cfg.p666.toFixed(5), cfg.protect666.toFixed(4), cfg.sacred, cfg.spontaneous,
    cfg.charges, cfg.roundEndCharges, cfg.trigLuck, cfg.superCap]);
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
  // memory cards like Delusions of Grandeur (x2) or Old Wounds (x0.5) reach debtMul through their models
  let debt = info.debt * d.debtMul;
  const memModel = state.mode && db.byId.get(state.mode.memory);
  const memHasDebt = memModel && memModel.model && memModel.model.effects.some((e) => e.type === 'debt');
  if (!memHasDebt && state.mode && state.mode.memory === 'delusions_of_grandeur') debt *= 2;
  if (!memHasDebt && state.mode && state.mode.memory === 'old_wounds') debt *= 0.5;
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
    tickets: Math.max(0, num(state.tickets) ?? 0), coins: num(state.coins), key: structKey(cfg), cache: new Map(),
    ticketIncome: estimateTicketIncome(d, roundsPerDeadline),
  };
}

// Tickets per deadline a run usually earns: 1 per round (Most Spins) + a little from skipped rounds,
// plus ticket effects you own (Florid traits, CloverPot...).
function estimateTicketIncome(d, R) {
  let t = R * 1 + 1.5;
  for (const e of d.econ) {
    if (e.kind !== 'tickets' || e.perUnit) continue;
    if (e.per === 'deadline') t += e.amount || 0;
    else if (e.per === 'round') t += (e.amount || 0) * R;
  }
  for (const e of d.econ) if (e.kind === 'ticketIncome') t *= e.set === 0 ? 0.3 : (e.mul || 1);
  return Math.max(2, t);
}

// Events per round for "when.on" triggers (rough averages from typical runs).
function eventsPerRound(ev, ctx, n = 1, stats = ctx.base) {
  const R = ctx.roundsPerDeadline;
  const map = {
    roundStart: 1, roundEnd: 1,
    deadlineStart: 1 / R, deadlineEnd: 1 / R,
    purchase: 2 / R, restock: (1.5 + freeRestocksPerDeadline(ctx)) / R, discard: 0.6 / R,
    phonePick: 1 / R, phoneReroll: 0.6 / R, roundSkipped: 0.4 / R,
    charmTriggers: stats.charmTriggersPerRound ?? stats.pAnyCharmTrig * stats.spinsPerRound, dying: 0,
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
    case 'scoredAll': return pc.mask === 127 ? stats.pAllSymbolsRound / Math.max(1, stats.spinsPerRound) : stats.pCloverBell;
    case 'scoredAny': return stats.pGem;
    case 'noRewardStreak': return pc.n >= 4 ? stats.pNoReward4 : pc.n === 3 ? stats.pNoReward3 : stats.pNoReward2;
    case 'chance': return Math.min(1, pc.p * randomMul);
    case 'and': return pc.all.reduce((a, x) => a * postRate(x, stats, randomMul), 1);
    default: return 0;
  }
}

// ------------------------------------------------------------------ valuation
// Linear derivatives of coins per spin for a build (d) under simulated stats.
function derivs(d, stats) {
  const SM = totalSM(d), PM = totalPM(d), N = stats.N;
  const dV = new Array(7).fill(0), dP = new Array(14).fill(0);
  let ev = 0;
  for (let s = 0; s < 7; s++) for (let p = 0; p < 14; p++) {
    const n = N[s * 14 + p];
    if (!n) continue;
    dV[s] += d.patVals[p] * n * SM * PM;
    dP[p] += d.values[s] * n * SM * PM;
    ev += d.values[s] * d.patVals[p] * n * SM * PM;
  }
  return { dV, dP, ev: Math.max(ev, 1e-9), SM, PM };
}

// Converts growth entries into per-round linear (A) and log (G) growth of coins,
// relative to the coins of build `d2` under `stats`.
function growthOf(entries, ctx, d2, stats) {
  let A = 0, G = 0;
  const notes = [];
  const { dV, dP, ev, SM, PM } = derivs(d2, stats);
  const spr = stats.spinsPerRound;
  const symShare = stats.symCoins.map((x) => x / Math.max(stats.ev, 1e-9));
  const patShare = stats.patCoins.map((x) => x / Math.max(stats.ev, 1e-9));
  for (const gr of entries) {
    let perRound = 0;
    if (gr.rate) {
      if (gr.rate.post) perRound = postRate(gr.rate.post, stats, d2.randomMul) * spr;
      else if (gr.rate.event) perRound = eventsPerRound(gr.rate.event, ctx, gr.rate.n, stats);
      else if (gr.rate.rb || gr.rate.rbRound) {
        // presses x extra triggers per Round, measured by the simulator (batteries, Dynamo, Overdose...)
        const apps = stats.rbAppsPerRound && stats.rbAppsPerRound[gr.src];
        if (apps !== undefined) perRound = gr.rate.rbRound ? Math.min(1 + d2.rbExtra, apps) : apps;
        else {
          perRound = Math.min(1, 1 / Math.max(1, (gr.rate.rb || gr.rate.rbRound) - d2.rbCostReduce)) * (1 + d2.rbExtra);
          if (d2.rbNoRecharge) perRound *= 0.15; // Overdose: no recharge when a Round ends
        }
      }
    }
    if (!perRound) continue;
    let dA = 0, dG = 0;
    switch (gr.kind) {
      case 'smAdd': dA = (gr.amount * d2.smMul) / Math.max(SM, 1e-9); break;
      case 'pmAdd': dA = (gr.amount * d2.pmMul) / Math.max(PM, 1e-9); break;
      case 'smMul': case 'pmMul': dG = Math.log(gr.mul || 1); break;
      case 'symAddBase': {
        if (gr.mul) { let share = 0; for (const s of maskToList(gr.mask)) share += symShare[s]; dG = Math.log(1 + (gr.mul - 1) * share); break; }
        let dev = 0;
        for (const s of maskToList(gr.mask)) dev += gr.amount * BASE_VALUE[s] * dV[s];
        dA = dev / ev; break;
      }
      case 'symAddBaseScored': {
        let dev = 0;
        for (const s of maskToList(gr.mask)) dev += gr.amount * BASE_VALUE[s] * stats.cellEvents[s] * spr * dV[s];
        dA = dev / ev; break;
      }
      case 'symMul': { let share = 0; for (const s of maskToList(gr.mask)) share += symShare[s]; dG = Math.log(1 + ((gr.mul || 2) - 1) * share); break; }
      case 'patAddBase': { let dev = 0; for (const p of gr.pats) dev += gr.amount * PATTERN_BASE[p] * dP[p]; dA = dev / ev; break; }
      case 'patMul': { let share = 0; for (const p of gr.pats) share += patShare[p]; dG = Math.log(1 + ((gr.mul || 2) - 1) * share); break; }
      default: break;
    }
    if (gr.resets) { dA *= 0.5; dG *= 0.5; }
    A += dA * perRound;
    G += dG * perRound;
    if (dA || dG) notes.push({ src: gr.src, kind: gr.kind, perRound, dA, dG });
  }
  return { A, G, notes };
}

// All symbol-modifier chances of a build -> growth (golden/chain), coins (token/investor),
// tickets (ticket) and an average Symbols Multiplier boost (rising).
function modifierValue(d, ctx, stats) {
  let A = 0, coins = 0, tickets = 0, smBoost = 0;
  const { dV, dP, ev } = derivs(d, stats);
  const spr = stats.spinsPerRound;
  const interestCoins = (d.interest / 100) * ctx.depositEst;
  for (let s = 0; s < 7; s++) {
    const ce = stats.cellEvents[s];
    if (!ce) continue;
    const gold = d.mods[MOD.golden * 7 + s];
    if (gold) A += (gold * ce * spr * BASE_VALUE[s] * dV[s]) / ev;
    const tok = d.mods[MOD.token * 7 + s];
    if (tok) coins += tok * ce * spr * (interestCoins / 2);
    const tic = d.mods[MOD.ticket * 7 + s];
    if (tic) tickets += tic * ce * spr;
    const rise = d.mods[MOD.rising * 7 + s];
    if (rise) smBoost += rise * ce * spr;
    const inv = d.mods[MOD.investor * 7 + s];
    if (inv) coins += inv * ce * spr * 0.5 * (ctx.depositEst / 100);
    const chain = d.mods[MOD.chain * 7 + s];
    if (chain) {
      let dev = 0;
      for (let p = 0; p < 14; p++) dev += chain * stats.N[s * 14 + p] * PATTERN_SIZE[p] * PATTERN_BASE[p] * dP[p] * spr;
      A += dev / ev;
    }
  }
  const m = smBoost ? 1 + (smBoost * ctx.roundsPerDeadline * 0.5) / Math.max(totalSM(d), 1e-9) : 1;
  return { A, coins, tickets, m };
}

function econOf(entries, ctx, d2, stats = ctx.base) {
  // Returns { tickets (per deadline), restocks (per deadline), coinsPerRound, coinsInstant, rounds, deathSave, discount }
  const R = ctx.roundsPerDeadline;
  const spr = stats.spinsPerRound;
  const out = { tickets: 0, restocks: 0, coinsPerRound: 0, coinsInstant: 0, roundsPerDeadline: 0, roundsInstant: 0, deathSave: 0, discount: 0, ticketMul: 1, resell: 0, charges: 0 };
  for (const e of entries) {
    const per = e.per;
    const rateOf = () => { // events per deadline
      if (!e.when) return 1;
      const pc = postCond(e.when);
      if (pc) return postRate(pc, stats, d2.randomMul) * spr * R;
      if (e.when.on) return eventsPerRound(e.when.on, ctx, e.when.n || 1, stats) * R;
      return 1;
    };
    switch (e.kind) {
      case 'tickets': {
        if (e.perUnit) { // e.g. CloverPot: +1 ticket per X tickets held, X = current deadline
          const per = e.perUnit.per === 'deadline' ? ctx.env.deadline : (e.perUnit.per || 1);
          const units = e.perUnit.of === 'tickets' ? ctx.tickets : unitsOf(e.perUnit, ctx);
          const amt = (e.amount || 1) * Math.floor(units / Math.max(1, per));
          out.tickets += per === 'instant' ? amt / Math.max(1, ctx.H / R) : amt;
          break;
        }
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
          const pc = postCond(e.when);
          perSpin = pc ? postRate(pc, stats, d2.randomMul) : e.when.on ? eventsPerRound(e.when.on, ctx, e.when.n || 1, stats) / spr : 0;
        }
        out.coinsPerRound += perSpin * spr * e.multiple * ((d2.interest / 100) * ctx.depositEst);
        break;
      }
      case 'coins': {
        let amt = e.amount || 0;
        if (e.debtFraction) amt = e.debtFraction * ctx.debt;
        // coins held: if unknown, assume the player deposits first and keeps a small purse
        const held = ctx.coins ?? 0.25 * ctx.evRound;
        if (e.mul) amt = held * (e.mul - 1);
        if (e.set === 0) amt = -held;
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
      case 'resell': { // resell value turns into tickets when you sell; Dark Lotus also reads it
        const onTable = Math.max(1, ctx.ownedIds.size);
        const perDeadline = e.per === 'round' ? (e.amount || 0) * onTable * R : e.mul ? 1 : (e.amount || 0);
        out.resell += perDeadline;
        out.tickets += 0.35 * perDeadline;
        break;
      }
      case 'charges': out.charges += 1; break;
      default: break;
    }
  }
  return out;
}

// Everything that pays coins every round besides the reels: Interest, cats, tokens, coin effects.
function sideIncome(d, ctx, stats, econ, mods) {
  return (d.interest / 100) * ctx.depositEst + econ.coinsPerRound + mods.coins;
}


// Average coins per round over H rounds, candidate vs current build.
// cand/base: { m (coins-per-round multiplier, base=1), A, G (growth per round), C (side income per round, relative) }
function horizonValue(cand, base, H, life = Infinity, instant = 0) {
  let num = instant, den = 0;
  const L = Number.isFinite(life) ? Math.max(0, life) : Infinity;
  // permanent gains (golden values, chains, multipliers) earned while the charm was active
  const keptA = Math.max(0, cand.A - base.A) * (Number.isFinite(L) ? L : 0);
  const keptG = Math.max(0, cand.G - base.G) * (Number.isFinite(L) ? L : 0);
  for (let t = 0; t < H; t++) {
    const b = (1 + base.A * t) * Math.exp(Math.min(base.G * t, 8)) + base.C;
    const c = cand.m * (1 + cand.A * t) * Math.exp(Math.min(cand.G * t, 8)) + cand.C;
    num += t < L ? c : b * (1 + keptA) * Math.exp(Math.min(keptG, 8));
    den += b;
  }
  return num / Math.max(den, 1e-9);
}

// How long a temporary charm lasts. `life` is what the valuation uses (a fading effect counts as about
// half its full length at full strength); `shown` is the real length, for the text.
function lifetimeRounds(model, item, stats) {
  let life = Infinity, shown = Infinity, fades = false;
  for (const e of (model && model.effects) || []) {
    // break counters on event triggers (dying, purchases...) don't wear out with ordinary spins
    if (e.when && e.when.on) continue;
    if (e.type === 'deathSave') continue;
    const da = e.discardAfter;
    if (da) {
      let l = Infinity;
      if (da.of === 'rounds') l = da.count;
      else if (da.of === 'activations' || da.of === 'uses') {
        const p = e.when && e.when.chance ? e.when.chance : 0.2;
        l = da.count / Math.max(0.05, p * stats.spinsPerRound);
      }
      life = Math.min(life, l);
      shown = Math.min(shown, l);
    }
    if (e.decay && e.decay.add < 0 && e.add) {
      const full = Math.abs(e.add / e.decay.add) / (e.decay.per === 'round' ? 1 : 3);
      life = Math.min(life, full / 2 + 0.5);
      if (full <= shown) fades = true;
      shown = Math.min(shown, full);
    }
  }
  return { life, shown, fades };
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

// The current build's own growth and side income, measured the same way as candidates.
function setBaseline(ctx) {
  const S0 = ctx.cmp;
  const g0 = growthOf(ctx.d.growth, ctx, ctx.d, S0);
  ctx.baseMods = modifierValue(ctx.d, ctx, S0);
  const e0 = econOf(ctx.d.econ, ctx, ctx.d, S0);
  const evRound0 = Math.max(S0.evNet * S0.spinsPerRound, 1e-9);
  ctx.baseline = { m: 1, A: g0.A + ctx.baseMods.A, G: g0.G, C: sideIncome(ctx.d, ctx, S0, e0, ctx.baseMods) / evRound0 };
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
  const metaBefore = ctx.d.meta.length;
  const cov = model ? applyModel(d2, model, { item: it, times }) : { handled: 0, total: 0, unhandled: [] };
  if (extra.trait) applyTrait(d2, extra.trait, it.id);
  // phone abilities that apply a trait to a random equipped charm
  applyCallTraits(d2, d2.meta.slice(metaBefore), times, ctx.ownedIds.size);

  // ---- coins from the reels, now
  const { stats, same } = simFor(d2, ctx);
  const S1 = same ? ctx.cmp : stats;
  const SM2 = totalSM(d2), PM2 = totalPM(d2);
  let m;
  if (same) m = linEV(d2.values, d2.patVals, SM2, PM2, ctx.cmp.N) / Math.max(linEV(ctx.d.values, ctx.d.patVals, ctx.SM, ctx.PM, ctx.cmp.N), 1e-9);
  else m = (stats.evNet * stats.spinsPerRound) / Math.max(ctx.cmp.evNet * ctx.cmp.spinsPerRound, 1e-9);
  if (!Number.isFinite(m) || m <= 0) m = 1e-6;
  const prot1 = protect666Of(ctx.d), prot2 = protect666Of(d2);
  if (same) { // 666 / protection changes the linear path cannot see
    const p1 = chance666(ctx.d, ctx.env.deadline), p2 = chance666(d2, ctx.env.deadline);
    if (p1 !== p2 || prot1 !== prot2) {
      const loss = (p, pr) => 1 - Math.min(0.9, 3.5 * p * (1 - pr));
      m *= loss(p2, prot2) / loss(p1, prot1);
    }
  }
  if (d2.roundsPerDeadline !== ctx.d.roundsPerDeadline) m *= d2.roundsPerDeadline / ctx.d.roundsPerDeadline;
  if (d2.debtMul !== ctx.d.debtMul) m /= d2.debtMul / ctx.d.debtMul;

  // ---- growth: the whole build (owned + candidate) under the candidate's spins,
  // compared with the current build's own growth. This catches synergies such as
  // "more patterns per spin makes the Pentacle you own grow faster".
  const gr = growthOf(d2.growth, ctx, d2, S1);
  const mv = modifierValue(d2, ctx, S1);
  m *= mv.m / ctx.baseMods.m;
  let A = gr.A + mv.A, G = gr.G;
  const newGrowth = d2.growth.slice(ctx.d.growth.length);
  for (const g of newGrowth) { // per-unit multipliers (Lost Wallet, CloverPet, Shopping Cart, Dark Lotus...)
    if (g.kind !== 'smPerUnit' && g.kind !== 'pmPerUnit') continue;
    const per = g.unit.per === 'deadline' ? ctx.env.deadline : Math.max(1, g.unit.per || 1);
    const bonus = perUnitBonus(g, ctx);
    const cur = g.kind === 'smPerUnit' ? SM2 : PM2;
    m *= (cur + bonus) / Math.max(cur, 1e-9);
    if (bonus < (g.cap ?? Infinity)) A += ((unitGrowthPerRound(g.unit, ctx) / per) * g.amount) / Math.max(cur + bonus, 1e-9);
  }

  // ---- economy & side income (Interest, cats, tokens, coin effects) for the whole build
  const R = ctx.roundsPerDeadline;
  const ecAll = econOf(d2.econ, ctx, d2, S1);
  const ec = econOf(d2.econ.slice(ctx.d.econ.length), ctx, d2, S1); // the candidate's own economy
  ec.tickets += (mv.tickets - ctx.baseMods.tickets) * R;
  if (ec.ticketMul !== 1) ec.tickets += (ec.ticketMul - 1) * (R * 1.2 + 1.5);
  const evRound0 = Math.max(ctx.cmp.evNet * ctx.cmp.spinsPerRound, 1e-9);
  const C1 = sideIncome(d2, ctx, S1, ecAll, mv) / evRound0 + ec.roundsPerDeadline / R;
  const dInterest = d2.interest - ctx.d.interest;
  const { life, shown: lifeShown, fades } = lifetimeRounds(model, it, stats);
  const instant = ec.coinsInstant / evRound0 + ec.roundsInstant * m;
  // Phone multipliers (Megaphone, Dear Diary): one call per deadline; a doubled pick adds about
  // what a typical good pick is worth, once per deadline.
  for (const mm of d2.meta) {
    if (mm.src !== it.id || mm.kind !== 'phone') continue;
    const gain = ctx.phonePickGain ?? 0.2;
    if (mm.e.extraTriggers) A += (gain * mm.e.extraTriggers) / R;
    if (mm.e.extraOptions) A += (0.15 * gain * mm.e.extraOptions) / R;
  }
  const cand = { m, A, G, C: C1 };
  const V = horizonValue(cand, ctx.baseline, ctx.H, life, instant);
  const Vnow = horizonValue(cand, ctx.baseline, 1, life, instant);

  // ---- scores
  const coinScore = 100 * Math.tanh(Math.log2(Math.max(V, 1e-6)) / 0.8);
  const econScore = 100 * Math.tanh((ec.tickets + 0.5 * ec.restocks + ec.discount) / 6);
  const charmSpaceDelta = d2.charmSpace - ctx.d.charmSpace;
  // a charm that sits on the table uses a slot itself (Property Certificate nets +1, Megaphone -2)
  const spaceNet = charmSpaceDelta - (charmSpaceDelta && it.kind === 'charm' && !it.noSpace ? 1 : 0);
  let utility = 0;
  if (spaceNet) utility += 35 * spaceNet;
  if (ec.deathSave) utility += ctx.check && ctx.check.ratio < 1 ? 75 : 30; // worth most when you're short of the debt
  if (prot2 > prot1 && ctx.env.deadline >= 2) utility += 60 * (prot2 - prot1) * Math.min(1, ctx.p666 * 25 + 0.2);
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
    if (hit) { archBonus += 22 * hit.weight; if (hit.weight >= 0.12) archHits.push(hit.label); }
  }
  archBonus = clamp(archBonus, 0, 15);

  let power;
  if (measured && quant > 0) power = 0.8 * quant * coinScore + (1 - 0.8 * quant) * prior * careFactor;
  else power = prior * Math.min(careFactor, 1.25);
  const devilBuild = ctx.arch.some((x) => x.id === 'devil' && x.weight > 0.15);
  const riskPenalty = (r.risk || 0) * (devilBuild && ((model && model.provides) || []).includes('666') ? 0.3 : 1.4);
  // Tickets are scarce: pricier charms must be clearly better, and charms you'd have to save up
  // for over several deadlines (Evil Deal costs 50) sink.
  const price = extra.price ?? (it.kind === 'charm' ? it.cost : 0);
  let costPenalty = 0, waitDeadlines = 0;
  if (it.kind === 'charm' && price > 0) {
    waitDeadlines = Math.max(0, price - ctx.tickets) / ctx.ticketIncome;
    costPenalty = 1.2 * price + Math.min(60, 14 * waitDeadlines);
  }
  let score = power + 0.3 * econScore * (ctx.g > 0.5 ? 1 : 1.2) + 0.35 * utility + syn + archBonus - riskPenalty
    + 0.12 * (r.economy || 0) * 10 * (1 - quant) + 0.1 * (r.utility || 0) * 10 * (1 - quant) - costPenalty;

  // ---- reasons (most important first)
  // A one-off gain or loss (coins now, an extra Round) is told apart from what changes every round,
  // so a lump sum spread over the horizon never reads as "growth".
  const newEcon = d2.econ.slice(ctx.d.econ.length);
  const zeroesCoins = newEcon.some((e) => e.kind === 'coins' && e.set === 0 && e.per === 'instant');
  if (zeroesCoins) reasons.push({ kind: 'bad', text: 'Sets the coins in your hand to 0, so deposit them first' });
  else if (Math.abs(instant) >= 0.01) reasons.push(oneOffReason(instant));
  const Vx = instant ? horizonValue(cand, ctx.baseline, ctx.H, life, 0) : V;
  const Vnowx = instant ? horizonValue(cand, ctx.baseline, 1, life, 0) : Vnow;
  if (measured && Math.abs(Vx - 1) > 0.004) {
    const now = Vnowx - 1, avg = Vx - 1;
    if (Math.abs(now) >= 0.01) reasons.push({ kind: now > 0 ? 'good' : 'bad', text: `${fmtPct(now)} coins per round right away` });
    if (Math.abs(Vx - Vnowx) > 0.02 && ctx.H > 1) {
      if (Vx > Vnowx && avg > 0) reasons.push({ kind: 'good', text: `${fmtPct(avg)} on average over the next ${ctx.H} rounds as it grows` });
      else if (Vx > Vnowx) reasons.push({ kind: 'bad', text: `Grows, but still ${fmtPct(avg)} on average over the next ${ctx.H} rounds` });
      else reasons.push({ kind: avg >= 0 ? 'neutral' : 'bad', text: `Fades: ${fmtPct(avg)} on average over the next ${ctx.H} rounds` });
    }
  }
  const dGrowth = (A - ctx.baseline.A) + (G - ctx.baseline.G);
  if (dGrowth > 0.006 && !(Number.isFinite(life) && life < ctx.H)) {
    const per = dGrowth;
    reasons.push({ kind: 'good', text: `Scales: about ${fmtPct(per)} more coins every round, permanently` });
  }
  topSymbolReason(it, model, ctx, reasons);
  for (const s of synReasons.slice(0, 3)) {
    const o = ctx.db.byId.get(s.id);
    const nm = (o ? o.name : s.id).replace(/[.!?…]+$/, ''); // call names end in . ! or ?
    reasons.push({ kind: s.type === 'syn' ? 'good' : 'bad', text: `${s.type === 'syn' ? 'Combos with' : 'Clashes with'} ${nm}: ${s.why}` });
  }
  if (archHits.length) reasons.push({ kind: 'good', text: `Fits your ${archHits.slice(0, 2).join(' + ')} build` });
  if (cares.length && careFactor < 0.45 && quant < 0.5) reasons.push({ kind: 'bad', text: `Needs ${cares.map(tagLabel).slice(0, 2).join(' / ')} support you don't have yet` });
  else if (careNotes.length && quant < 0.8) reasons.push({ kind: 'good', text: `Your build supports it (${careNotes.map(tagLabel).slice(0, 2).join(', ')})` });
  if (ec.tickets > 0.5) reasons.push({ kind: 'good', text: `About +${ec.tickets.toFixed(1)} tickets per deadline` });
  if (ec.tickets < -0.5) reasons.push({ kind: 'bad', text: `Costs about ${Math.abs(ec.tickets).toFixed(1)} tickets per deadline` });
  if (ec.restocks > 0.4) reasons.push({ kind: 'good', text: `About +${ec.restocks.toFixed(1)} free restocks per deadline` });
  if (ec.discount > 0.5) reasons.push({ kind: 'good', text: 'Makes store charms cheaper' });
  if (dInterest) reasons.push({ kind: dInterest > 0 ? 'good' : 'bad', text: `Interest ${ctx.d.interest.toFixed(0)}% → ${d2.interest.toFixed(0)}%` });
  if (charmSpaceDelta) reasons.push({ kind: charmSpaceDelta > 0 ? 'good' : 'bad', text: `${charmSpaceDelta > 0 ? '+' : ''}${charmSpaceDelta} charm space` });
  const p1 = chance666(ctx.d, ctx.env.deadline), p2 = chance666(d2, ctx.env.deadline);
  if (p2 > p1 + 1e-6) reasons.push({ kind: devilBuild ? 'good' : 'bad', text: `666 chance ${(p1 * 100).toFixed(1)}% → ${(p2 * 100).toFixed(1)}%` });
  if (prot2 > prot1 + 1e-6) reasons.push({ kind: 'good', text: prot1 > 0 ? `666 blocked ${Math.round(prot1 * 100)}% → ${Math.round(prot2 * 100)}%` : 'Protects you from 666' });
  if (ec.deathSave && ctx.check && ctx.check.ratio < 1) reasons.push({ kind: 'good', text: "Saves the run if you can't pay this deadline" });
  if (Number.isFinite(lifeShown)) {
    const n = Math.max(1, Math.round(lifeShown));
    reasons.push({ kind: 'neutral', text: `Temporary: lasts about ${n} round${n === 1 ? '' : 's'}${fades ? ', weaker each round' : ''}` });
  }
  if (waitDeadlines >= 1.5) reasons.push({ kind: 'bad', text: `Costs ${price} tickets: about ${Math.round(waitDeadlines)} deadlines of saving` });
  if (quant < 0.5 && model && model.tip) reasons.push({ kind: 'neutral', text: model.tip });
  // every pick explains its score, even when its effect on this build is tiny
  if (!reasons.length) {
    if (Math.abs(V - 1) > 0.004) reasons.push({ kind: V > 1 ? 'neutral' : 'bad', text: `Small effect in your build: ${fmtPct(V - 1)} coins over the next ${ctx.H === 1 ? 'round' : `${ctx.H} rounds`}` });
    else reasons.push({ kind: 'neutral', text: 'No measurable change to your coins in this build' });
    if (cares.length && careFactor < 0.45) reasons.push({ kind: 'bad', text: `Needs ${cares.map(tagLabel).slice(0, 2).join(' / ')} support you don't have yet` });
  }

  const affordable = it.kind !== 'charm' || price == null || price <= ctx.tickets;
  return {
    id: it.id, kind: it.kind, name: it.name, score, price, affordable,
    parts: { power: Math.round(power), coins: Math.round(coinScore), econ: Math.round(econScore), utility: Math.round(utility), synergy: Math.round(syn + archBonus), risk: Math.round(riskPenalty), prior: Math.round(prior), cost: Math.round(costPenalty) },
    value: { now: Vnow, horizon: V, growthPerRound: dGrowth, ticketsPerDeadline: ec.tickets },
    quant, reasons: dedupeReasons(reasons).slice(0, 7), tier: model ? model.tier : null,
  };
}

function dedupeReasons(rs) {
  const seen = new Set();
  return rs.filter((r) => { if (seen.has(r.text)) return false; seen.add(r.text); return true; });
}

// symbol groups some items work on (they mirror supportFor)
const SYMBOL_GROUPS = { nonYellow: ['cherry', 'clover', 'diamond'], yellow: ['lemon', 'bell', 'treasure', 'seven'], fruit: ['lemon', 'cherry'] };
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

function topSymbolReason(it, model, ctx, reasons) {
  if (!model) return;
  const syms = (model.provides || []).filter((t) => SYM[t] !== undefined);
  let label, share;
  if (syms.length) {
    const best = syms.map((t) => [t, ctx.symShare[SYM[t]]]).sort((a, b) => b[1] - a[1])[0];
    label = SYMBOL_PLURALS[SYM[best[0]]]; share = best[1];
  } else {
    const g = (model.provides || []).map((t) => SYMBOL_GROUPS[t]).find(Boolean);
    if (!g) return;
    label = andList(g.map((s) => SYMBOL_PLURALS[SYM[s]])); share = g.reduce((a, s) => a + ctx.symShare[SYM[s]], 0);
  }
  if (share >= 0.25) reasons.push({ kind: 'good', text: `${label} make ${Math.round(share * 100)}% of your coins` });
  else if (share < 0.1) reasons.push({ kind: 'bad', text: `${label} make only ${Math.round(share * 100)}% of your coins` });
}

// A lump sum, in rounds' worth of coins: "One-off: about 1.5 rounds' worth of coins".
function oneOffReason(x) {
  const a = Math.abs(x);
  let amount;
  if (a < 0.95) amount = `${Math.max(1, Math.round(a * 100))}% of a round's coins`;
  else {
    const n = a < 9.5 ? Math.round(a * 10) / 10 : Math.round(a);
    amount = n === 1 ? "a round's worth of coins" : `${n} rounds' worth of coins`;
  }
  return x > 0 ? { kind: 'good', text: `One-off: about ${amount}` } : { kind: 'bad', text: `One-off: you lose about ${amount}` };
}

const TAG_LABELS = {
  patternCount: 'many patterns per spin', noReward: 'spins without reward', triggersRandomly: 'random-trigger charms',
  redButton: 'Red Button charms', charges: 'charge sources', phone: 'phone calls', tickets: 'ticket stockpile', interest: 'Interest',
  '666': '666 hits', '999': '999 hits', traits: 'charm traits', restock: 'restocks', discard: 'discarding', retrigger: 'retriggers',
  luck: 'Luck', charmCount: 'many charms', jackpot: 'jackpots', eye: 'EYE patterns', aboveBelow: 'ABOVE/BELOW patterns',
  nonYellow: 'Cherry/Clover/Diamond', yellow: 'Lemon/Bell/Treasure/Seven', fruit: 'Lemon/Cherry', drawers: 'drawers',
  symbolChance: 'symbol chances', symbolValue: 'symbol values', patternValue: 'pattern values', largePatterns: 'big patterns',
  smallPatterns: 'small patterns', spins: 'extra spins', rounds: 'extra Rounds', roundSkip: 'skipped Rounds', purchase: 'purchases',
  resell: 'resell value', charmSpace: 'charm space', temporary: 'temporary charms', sacred: 'Sacred mode', discount: 'discounts',
  phoneReroll: 'phone rerolls', instant: 'instant calls', revenge: 'Revenge', evil: 'Evil charms', surgery: 'surgery',
  golden: 'Golden modifiers', chain: 'Chain modifiers', token: 'Token modifiers', ticketMod: 'Ticket modifiers',
  repetition: 'Repetition modifiers', battery: 'Battery modifiers',
};
function tagLabel(t) { return TAG_LABELS[t] || (SYM[t] !== undefined ? SYMBOL_PLURALS[SYM[t]] : t); }

function unitsOf(unit, ctx) {
  switch (unit.of) {
    case 'tickets': return ctx.tickets;
    case 'freeRestocks': return freeRestocksPerDeadline(ctx) * 0.5 + 1;
    case 'phoneRerolls': return Math.max(0, ctx.env.deadline - 1) * 0.3;
    case 'redCallsRefused': return ctx.env.sacred ? Math.max(3, Math.floor((ctx.env.deadline - 1) / 2)) : Math.max(0, Math.floor((ctx.env.deadline - 1) / 3));
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
    case 'phoneRerolls': return 0.3 / R;
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
    setBaseline(ctx2);
    ctx2.cache.set(ctx.key, ctx.cmp);
    const e = evaluateItem(it, ctx2, { trait: c.trait || null, price: 0 }); // already paid for
    out.push({
      id: c.id, name: it.name, trait: c.trait || null, score: e.score,
      now: e.value.now, horizon: e.value.horizon, growth: e.value.growthPerRound, tickets: e.value.ticketsPerDeadline,
      // worth something besides coins (tickets, restocks, charm space, saving the run...)
      other: (e.parts.econ || 0) >= 5 || (e.parts.utility || 0) >= 5,
      reasons: e.reasons.slice(0, 3),
    });
  }
  // The list shows the coins each charm adds (leave-one-out), so it is ordered by that same number.
  out.sort((a, b) => (b.horizon - a.horizon) || (b.score - a.score));
  return out;
}

// The weakest charm on the table: the last in the list, skipping charms whose worth isn't in coins
// (tickets, charm space...), which coins can't be weighed against.
function weakestOwned(owned) {
  for (let i = owned.length - 1; i >= 0; i--) {
    const o = owned[i];
    if (!(Math.abs(o.horizon - 1) < 0.005 && o.other)) return o;
  }
  return owned.length ? owned[owned.length - 1] : null;
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
  setBaseline(ctx);
  const check = deadlineCheck(ctx);
  ctx.check = check;
  const owned = opt.skipOwned ? [] : ownedContributions(ctx);
  // weakest owned charm (for "replace" suggestions when the table is full)
  const spaceUsed = (state.charms || []).filter((c) => !c.drawer && !(db.byId.get(c.id) || {}).noSpace).length;
  const full = spaceUsed >= ctx.d.charmSpace;
  const weakest = weakestOwned(owned);

  const pool = opt.pool || candidatePool(ctx);
  const evals = [];
  const evalSafe = (it) => {
    try { evals.push(evaluateItem(it, ctx)); } catch (err) { evals.push({ id: it.id, kind: it.kind, name: it.name, score: -999, error: String(err), reasons: [], parts: {} }); }
  };
  // phone calls first: what a typical upcoming phone pick is worth feeds Megaphone-like charms
  for (const it of pool) if (it.kind === 'phone') evalSafe(it);
  const phoneGains = evals.filter((x) => x.kind === 'phone' && x.value).map((x) => Math.max(0, x.value.horizon - 1)).sort((a, b) => b - a);
  ctx.phonePickGain = phoneGains.length ? Math.min(1, phoneGains.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, phoneGains.length)) : 0.2;
  for (const it of pool) if (it.kind !== 'phone') evalSafe(it);
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
  // Tickets are scarce: a pricier charm has to be clearly better to win. Unaffordable ones sink.
  const tickets = num(state.tickets) ?? 0;
  for (const o of offers) {
    const price = o.kind === 'charm' ? (o.price ?? 0) : 0;
    o.affordable = o.kind !== 'charm' || tickets <= 0 || price <= tickets;
    o.rankScore = o.score - 1.5 * price;
    if (o.kind === 'charm' && price > 0) o.perTicket = o.score / price;
  }
  offers.sort((a, b) => (b.affordable - a.affordable) || (b.rankScore - a.rankScore));
  const charmOffers = offers.filter((o) => o.kind === 'charm' && o.affordable && o.perTicket);
  if (charmOffers.length > 1) {
    const best = charmOffers.reduce((a, b) => (b.perTicket > a.perTicket ? b : a));
    if (best !== offers[0]) best.reasons.unshift({ kind: 'good', text: 'Best value for your tickets' });
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
      avgPatterns: st.avgPatterns, luckAvg: st.luckAvg, p666: ctx.p666, protect666: protect666Of(ctx.d),
      // a call you take now triggers this many times (First Love and Megaphone add one each)
      callTriggers: 1 + ctx.d.phoneExtra, callAddsPerTake: 1 + ctx.d.phoneExtra - (ctx.d.memPhoneExtra || 0),
      memPhoneExtra: ctx.d.memPhoneExtra || 0,
      archetypes: ctx.arch, horizonRounds: ctx.H, debt: ctx.debt,
    },
    check, owned, weakest: full ? weakest : null,
    recommendations: { all: evals, charms, phone },
    offers,
  };
}
