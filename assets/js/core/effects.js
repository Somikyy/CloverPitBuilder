// Effects interpreter: turns item models (docs/MODEL_SPEC.md) into
//  - changes to the build's stats (symbol values/chances, multipliers, ...)
//  - simulator rules (luck / retrigger / forced patterns / temporary buffs / Red Button)
//  - growth entries (permanent scaling, valued later over the player's horizon)
//  - economy entries (tickets, coins, interest, restocks, ...)
// Anything it cannot express is reported as "unhandled" so the engine can fall
// back on the model's ratings for that part.

import {
  SYM, BASE_VALUE, BASE_WEIGHT, PATTERN_BASE, PAT, MOD, RULES,
  symbolsFromSpec, patternsFromSpec, maskToList,
} from './constants.js';

export function newDerived() {
  return {
    weights: BASE_WEIGHT.slice(),
    values: BASE_VALUE.slice(),
    patVals: PATTERN_BASE.slice(),
    enabled: PATTERN_BASE.map((_, i) => i < 11),
    smAdd: 1, smMul: 1, pmAdd: 1, pmMul: 1,
    interest: RULES.baseInterest,
    charmSpace: RULES.charmSpace,
    spinsPerRound: RULES.spinsMost,
    roundsPerDeadline: RULES.roundsPerDeadline,
    chance666Add: 0, chance666Mul: 1,
    protect666: 0,
    protectRandom: [], // 666 protection that "triggers randomly" (Rosary): Horseshoe doubles it
    randomMul: 1,
    rbExtra: 0, rbNoConsume: 0, rbCostReduce: 0, rbNoRecharge: false,
    phoneExtra: 0, phoneOptions: 0,
    debtMul: 1,
    mods: new Array(70).fill(0),
    luck: [], retrig: [], force: [], extraSpins: [], temps: [], rb: [],
    charges: [], roundEndCharges: [], trigLuck: [],
    transforms: { painKillers: false, halo: false, d4: 0 },
    growth: [],   // {kind, ...} permanent scaling, valued by the engine
    econ: [],     // {kind, amount, per, ...}
    risk: [],     // {kind, amount}
    meta: [],     // {kind, ...} effects on other items (Horseshoe, Nuclear Button, Megaphone ...)
    flags: {},
  };
}

export function cloneDerived(d) {
  return {
    ...d,
    weights: d.weights.slice(), values: d.values.slice(), patVals: d.patVals.slice(), enabled: d.enabled.slice(),
    mods: d.mods.slice(),
    luck: d.luck.slice(), retrig: d.retrig.slice(), force: d.force.slice(), extraSpins: d.extraSpins.slice(),
    temps: d.temps.slice(), rb: d.rb.slice(), transforms: { ...d.transforms },
    charges: d.charges.slice(), roundEndCharges: d.roundEndCharges.slice(), trigLuck: d.trigLuck.slice(), protectRandom: d.protectRandom.slice(),
    growth: d.growth.slice(), econ: d.econ.slice(), risk: d.risk.slice(), meta: d.meta.slice(), flags: { ...d.flags },
  };
}

export function symCtx(d) {
  let mp = 0, mv = 0;
  for (let s = 1; s < 7; s++) {
    if (d.weights[s] > d.weights[mp] + 1e-9) mp = s;
    if (d.values[s] > d.values[mv] + 1e-9) mv = s;
  }
  let mpm = 0, mvm = 0;
  for (let s = 0; s < 7; s++) {
    if (Math.abs(d.weights[s] - d.weights[mp]) < 1e-9) mpm |= 1 << s;
    if (Math.abs(d.values[s] - d.values[mv]) < 1e-9) mvm |= 1 << s;
  }
  return { mostProbableMask: mpm, mostValuableMask: mvm };
}

// ---------------------------------------------------------------- conditions
// Pre-spin conditions (decided before the reels stop).
function preCond(when) {
  if (!when) return { kind: 'always' };
  if (when.chance !== undefined && Object.keys(when).length === 1) return { kind: 'chance', p: when.chance };
  if (when.spin === 'first' || when.spin === 'last') return { kind: 'spin', which: when.spin };
  // "every N spins" counts from when the charm was bought, so its phase vs. the Round is unknown:
  // use a neutral mid-Round phase instead of always landing on the last spin.
  if (when.spin === 'every') return { kind: 'every', n: when.n || 7, phase: Math.floor((when.n || 7) / 2) };
  if (when.round === 'first' || when.round === 'last') return { kind: 'round', which: when.round };
  if (when.noRewardStreak) return { kind: 'noRewardStreak', n: when.noRewardStreak };
  if (when.noPatterns) return { kind: 'noPatternsPrev' };
  if (when.noLargeStreak) return { kind: 'no5Streak', n: when.noLargeStreak };
  if (when.scored && when.streak) return { kind: 'scoredStreak', n: when.streak };
  if (when.on === '666') return { kind: 'after666' };
  return null;
}

// Post-spin triggers (decided from what the spin produced).
function postCond(when) {
  if (!when) return null;
  const parts = [];
  if (when.patternsAtLeast) parts.push({ kind: 'patternsAtLeast', n: when.patternsAtLeast });
  if (when.patternsExactly) parts.push({ kind: 'patternsExactly', n: when.patternsExactly });
  if (when.noPatterns) parts.push({ kind: 'noPatterns' });
  if (when.patternSizeAtLeast) parts.push({ kind: 'sizeAtLeast', n: when.patternSizeAtLeast });
  if (when.onlyPattern === 'EYE') parts.push({ kind: 'onlyEye' });
  if (when.on === '666' || when.on === '999') parts.push({ kind: 'on666' });
  if (when.on === 'jackpot') parts.push({ kind: 'onJackpot' });
  if (when.scoredAll) parts.push({ kind: 'scoredAll', mask: symbolsFromSpec(when.scoredAll) });
  if (when.scored && !when.streak) parts.push({ kind: 'scoredAny', mask: symbolsFromSpec(when.scored) });
  if (when.noRewardStreak) parts.push({ kind: 'noRewardStreak', n: when.noRewardStreak });
  if (when.chance !== undefined) parts.push({ kind: 'chance', p: when.chance });
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { kind: 'and', all: parts };
}

const EVENT_KEYS = ['roundStart', 'roundEnd', 'deadlineStart', 'deadlineEnd', 'purchase', 'restock', 'discard',
  'phonePick', 'phoneReroll', 'roundSkipped', 'charmTriggers', 'dying'];

function scopeMask(scope, ctx) {
  if (!scope || scope === 'all') return 127;
  if (Array.isArray(scope)) return symbolsFromSpec(scope, ctx);
  return symbolsFromSpec(scope, ctx) || 127;
}

function isPermanent(e) {
  return e.duration === 'permanent' || (e.stack && (e.reset === undefined || e.reset === 'never'));
}

// ---------------------------------------------------------------- main
/**
 * Apply one model's effects to a derived build.
 * @param d derived build (mutated)
 * @param model item model
 * @param opt { times=1, owned=true, item }  item = raw item from items.json (charges etc.)
 * @returns { handled: n, total: n, notes: [] }
 */
export function applyModel(d, model, opt = {}) {
  const times = opt.times ?? 1;
  const item = opt.item || {};
  const forceSym = opt.symCtx || null; // in-game numbers typed by the player decide "most valuable" targets
  const res = { handled: 0, total: 0, unhandled: [] };
  if (!model || !Array.isArray(model.effects)) return res;
  const src = model.id;
  if (src === 'depression') d.flags.depression = true; // no spontaneous luck from the machine
  if (src === 'super_capacitor') d.flags.superCap = true; // full button charms feed charges to others every spin
  const isRB = model.effects.some((e) => e.when && e.when.redButton);
  let rbEntry = null;
  if (isRB) {
    // raw charge cost; cost reductions (e.g. "I'm feeling more energetic recently.") are applied in compileSim
    const cost = Math.max(1, item.redButtonCharges || 1);
    rbEntry = { src, cost, max: cost, duration: 'round', effects: [] };
  }

  for (const e of model.effects) {
    res.total++;
    const ok = applyEffect(d, e, { src, times, model, item, rbEntry, forceSym });
    if (ok) res.handled++;
    else res.unhandled.push(e.type === 'special' ? e.text : e.type);
  }
  // charms whose behaviour is simulated through a flag count as fully simulated
  if (src === 'depression' || src === 'super_capacitor') res.handled = res.total;
  // every Red Button charm goes to the simulator, even when all it does is grow (Cross, Ring Bell):
  // its measured presses per round price that growth, so charge sources (batteries, Dynamo) count
  if (rbEntry) {
    rbEntry.extraTriggers = d.rbExtra;
    rbEntry.noConsume = d.rbNoConsume;
    rbEntry.noRecharge = d.rbNoRecharge;
    d.rb.push(rbEntry);
  }
  return res;
}

function applyEffect(d, e, c) {
  const { src, times, rbEntry, item } = c;
  const w = e.when || null;
  const ctx = c.forceSym || symCtx(d);
  const n = times;

  // ---------- Red Button activated effects
  if (w && w.redButton) {
    if (!rbEntry) return false;
    const dur = e.duration || 'round';
    if (e.type === 'symbolChance' && e.add !== undefined) {
      rbEntry.effects.push({ kind: 'weightAdd', mask: symbolsFromSpec(e.symbols, ctx), value: e.add });
      rbEntry.duration = 'deadline';
      return true;
    }
    if (e.type === 'retrigger') { rbEntry.effects.push({ kind: 'retrigRound', mask: scopeMask(e.scope, ctx), value: e.add || 1 }); return true; }
    if (e.type === 'luck') { rbEntry.effects.push({ kind: 'luckFirst', value: e.add || 0 }); return true; }
    if (e.type === 'spins') { rbEntry.effects.push({ kind: 'extraSpin', luck: e.luck || 0 }); return true; }
    if (e.type === 'addPatterns') { rbEntry.effects.push({ kind: 'addPattern', pats: patternsFromSpec(e.patterns) }); return true; }
    if (e.type === 'forcePattern') { rbEntry.effects.push({ kind: 'force', pats: patternsFromSpec(Array.isArray(e.pattern) ? e.pattern : [e.pattern]) }); return true; }
    // permanent things bought with charges -> growth per activation
    if (e.type === 'symbolsMult' || e.type === 'patternsMult') {
      d.growth.push({ kind: e.type === 'symbolsMult' ? 'smAdd' : 'pmAdd', amount: (e.add || 0) * n, rate: { rb: rbEntry.cost }, src, mul: e.mul });
      return true;
    }
    if (e.type === 'symbolValue' && e.addBase) {
      d.growth.push({ kind: 'symAddBaseScored', amount: e.addBase * n, mask: symbolsFromSpec(e.symbols || 'all', ctx), rate: { rbRound: rbEntry.cost }, src });
      rbEntry.roundScoped = true; // Midas Touch works for the rest of the Round: press it at a Round's start
      return true;
    }
    if (e.type === 'rounds') { d.econ.push({ kind: 'rounds', amount: (e.add || 1) * n, per: 'rb', cost: rbEntry.cost, src }); return true; }
    if (e.type === 'interest') { d.econ.push({ kind: 'interest', amount: (e.add || 0) * n, per: 'rb', cost: rbEntry.cost, src }); return true; }
    if (e.type === 'chance666' || e.type === 'debt' || e.type === 'coins') { d.risk.push({ kind: e.type, e, src }); return false; }
    return false;
  }

  switch (e.type) {
    // ================================================= scoring stats
    case 'symbolChance': {
      if (e.symbols === 'random' && (!w || w.event === 'instant')) { // expected value over the 7 symbols
        const f = Math.min(1, (e.count || 1) / 7);
        for (let s = 0; s < 7; s++) {
          if (e.add !== undefined) d.weights[s] = Math.max(0, d.weights[s] + e.add * n * f);
          else if (e.mulBase !== undefined) d.weights[s] = Math.max(0, d.weights[s] - BASE_WEIGHT[s] * (1 - Math.pow(e.mulBase, n)) * f);
        }
        return true;
      }
      const mask = symbolsFromSpec(e.symbols, ctx);
      if (!mask) return false;
      if (w && !(w.event === 'instant')) {
        // temporary or conditional chance changes
        if (w.on === 'deadlineEnd' || w.on === 'deadlineStart') { d.growth.push({ kind: 'note', src }); return false; }
        return false;
      }
      for (const s of maskToList(mask)) {
        if (e.add !== undefined) d.weights[s] = Math.max(0, d.weights[s] + e.add * n);
        else if (e.mulBase !== undefined) d.weights[s] = Math.max(0, d.weights[s] - BASE_WEIGHT[s] * (1 - Math.pow(e.mulBase, n)));
        else if (e.set !== undefined) d.weights[s] = e.set;
      }
      return true;
    }
    case 'symbolValue': {
      if (e.symbols === 'random' && (!w || w.event === 'instant')) {
        const f = Math.min(1, (e.count || 1) / 7);
        for (let s = 0; s < 7; s++) {
          if (e.mul !== undefined) d.values[s] *= 1 + (Math.pow(e.mul, n) - 1) * f;
          if (e.addBase !== undefined) d.values[s] += e.addBase * BASE_VALUE[s] * n * f;
        }
        return true;
      }
      const mask = symbolsFromSpec(e.symbols || 'all', ctx);
      if (!mask) return false;
      if (!w || w.event === 'instant') {
        for (const s of maskToList(mask)) {
          if (e.mul !== undefined) d.values[s] *= Math.pow(e.mul, n);
          if (e.addBase !== undefined) d.values[s] += e.addBase * BASE_VALUE[s] * n;
          if (e.add !== undefined) d.values[s] += e.add * n;
        }
        return true;
      }
      const pc = postCond(w);
      if (isPermanent(e)) {
        if (EVENT_KEYS.includes(w.on)) { d.growth.push({ kind: 'symAddBase', amount: (e.addBase || 0) * n, mul: e.mul, mask, rate: { event: w.on, n: w.n || 1 }, src }); return !!(e.addBase || e.mul); }
        if (pc) { d.growth.push({ kind: e.mul ? 'symMul' : 'symAddBase', amount: (e.addBase || e.add || 0) * n, mul: e.mul, mask, rate: { post: pc }, src }); return true; }
        return false;
      }
      if (pc && (e.duration === 'round' || e.duration === 'deadline' || e.duration === 'spin')) {
        if (e.mul) { d.temps.push({ trigger: pc, kind: e.duration === 'deadline' ? 'symMulDeadline' : 'symMulRound', mask, value: e.mul, stack: !!e.stack, src }); return true; }
        if (e.addBase) {
          const perExtra = /after the second|beyond the second|after the 2nd|for every pattern/i.test(e.note || '') || src === 'mushrooms';
          d.temps.push({ trigger: perExtra ? { kind: 'always' } : pc, kind: 'symAddBaseRound', mask, value: e.addBase, perExtraPattern: perExtra, src });
          return true;
        }
      }
      return false;
    }
    case 'patternValue': {
      const pats = patternsFromSpec(e.patterns);
      if (!pats.length) return false;
      if (!w || w.event === 'instant') {
        for (const p of pats) {
          if (e.mul !== undefined) d.patVals[p] *= Math.pow(e.mul, n);
          if (e.addBase !== undefined) d.patVals[p] += e.addBase * PATTERN_BASE[p] * n;
        }
        return true;
      }
      const pc = postCond(w);
      if (isPermanent(e)) {
        if (EVENT_KEYS.includes(w.on)) { d.growth.push({ kind: e.mul ? 'patMul' : 'patAddBase', amount: (e.addBase || 0) * n, mul: e.mul, pats, rate: { event: w.on, n: w.n || 1 }, src }); return true; }
        if (pc) { d.growth.push({ kind: e.mul ? 'patMul' : 'patAddBase', amount: (e.addBase || 0) * n, mul: e.mul, pats, rate: { post: pc }, src }); return true; }
        return false;
      }
      if (pc && (e.duration === 'round' || e.duration === 'deadline' || e.duration === 'spin')) {
        if (e.mul) { d.temps.push({ trigger: pc, kind: 'patMulRound', pats, value: e.mul, stack: !!e.stack, src }); return true; }
        if (e.addBase) { d.temps.push({ trigger: pc, kind: 'patAddBaseRound', pats, value: e.addBase, src }); return true; }
      }
      return false;
    }
    case 'symbolsMult':
    case 'patternsMult': {
      const isSM = e.type === 'symbolsMult';
      if (e.perUnit) {
        d.growth.push({ kind: isSM ? 'smPerUnit' : 'pmPerUnit', amount: (e.add || 0) * n, unit: e.perUnit, cap: e.cap, src });
        return true;
      }
      if (!w || w.event === 'instant') {
        if (e.add !== undefined) { if (isSM) d.smAdd += e.add * n; else d.pmAdd += e.add * n; }
        if (e.mul !== undefined) { if (isSM) d.smMul *= Math.pow(e.mul, n); else d.pmMul *= Math.pow(e.mul, n); }
        return true;
      }
      const pc = postCond(w);
      if (isPermanent(e)) {
        const rate = EVENT_KEYS.includes(w.on) ? { event: w.on, n: w.n || 1 } : pc ? { post: pc } : null;
        if (!rate) return false;
        d.growth.push({ kind: e.mul ? (isSM ? 'smMul' : 'pmMul') : (isSM ? 'smAdd' : 'pmAdd'), amount: (e.add || 0) * n, mul: e.mul, rate, cap: e.cap, src });
        return true;
      }
      if (pc && (e.duration === 'round' || e.duration === 'deadline' || e.duration === 'spin')) {
        if (isSM && e.mul) { d.temps.push({ trigger: pc, kind: 'smMulRound', value: e.mul, stack: !!e.stack, src }); return true; }
        if (e.add) { d.temps.push({ trigger: pc, kind: (isSM ? 'sm' : 'pm') + (e.duration === 'deadline' ? 'AddDeadline' : 'AddRound'), value: e.add, src }); return true; }
      }
      if (EVENT_KEYS.includes(w.on) && e.reset) {
        // e.g. bonus that grows each deadline/round and resets: approximate as average bonus
        d.growth.push({ kind: isSM ? 'smAdd' : 'pmAdd', amount: (e.add || 0) * n * 0.5, rate: { event: w.on, n: w.n || 1 }, src, resets: e.reset });
        return true;
      }
      return false;
    }
    case 'luck': {
      const amount = (e.add || 0) * n;
      if (e.perUnit) return false;
      if (!w) { d.luck.push({ add: amount, cond: { kind: 'always' }, src }); return true; }
      const pre = preCond(w);
      if (pre && !(w.patternsAtLeast || w.on === 'roundSkipped')) {
        if (pre.kind === 'after666') { d.temps.push({ trigger: { kind: 'on666' }, kind: 'luckNext', value: amount, src }); return true; }
        d.luck.push({ add: amount, cond: pre, src, discardAfter: e.discardAfter });
        return true;
      }
      const pc = postCond(w);
      if (pc) { d.temps.push({ trigger: pc, kind: 'luckNext', value: amount, src }); return true; }
      if (w.on === 'roundStart') { d.luck.push({ add: amount, cond: { kind: 'spin', which: 'first' }, src }); return true; }
      if (w.on === 'charmTriggers') { d.trigLuck.push({ n: w.n || 5, add: amount, src }); return true; }
      return false;
    }
    case 'retrigger': {
      const add = (e.add || 1) * n;
      if (e.scope === 'lastPattern') { d.retrig.push({ add, mask: 127, last: true, cond: preCond(w) || { kind: 'always' }, src }); return true; }
      if (e.scope === 'singleDiamondTreasure') { // Necklace: simulated (2 extra triggers, last pays double)
        d.retrig.push({ add: 0, mask: 0, necklace: true, cond: { kind: 'always' }, src });
        return true;
      }
      const mask = scopeMask(e.scope, c.forceSym || symCtx(d));
      if (!w) { d.retrig.push({ add, mask, cond: { kind: 'always' }, src }); return true; }
      const pre = preCond(w);
      if (pre && pre.kind !== 'after666') { d.retrig.push({ add, mask, cond: pre, src }); return true; }
      const pc = postCond(w);
      if (pc && (e.duration === 'round' || !e.duration)) { d.temps.push({ trigger: pc, kind: 'retrigRound', mask, value: add, src }); return true; }
      if (isPermanent(e)) { d.retrig.push({ add, mask, cond: { kind: 'always' }, src }); return true; }
      return false;
    }
    case 'modifierChance': {
      const m = MOD[e.modifier];
      if (m === undefined) return false;
      const mask = symbolsFromSpec(e.symbols || 'all', ctx);
      if (w && !(w.event === 'instant')) {
        // growing chances (Naughty Dealer, Greedy King...): count about half of what builds up
        if (!e.stack) return false;
        const grown = Math.min(e.cap ?? 0.25, (e.add || 0) * 4) * 0.5;
        for (const s of maskToList(mask)) d.mods[m * 7 + s] = Math.min(1, d.mods[m * 7 + s] + grown * n);
        return true;
      }
      for (const s of maskToList(mask)) d.mods[m * 7 + s] = Math.min(1, d.mods[m * 7 + s] + (e.add || 0) * n);
      if (e.decay) d.flags['decay_' + src] = e.decay;
      return true;
    }
    case 'forcePattern': {
      const pats = patternsFromSpec(Array.isArray(e.pattern) ? e.pattern : [e.pattern]);
      if (!pats.length) return false;
      const pre = w ? preCond(w) : null;
      if (pre) { d.force.push({ pats, all: !!e.all, cond: pre, src }); return true; }
      const pc = postCond(w);
      if (pc) { d.temps.push({ trigger: pc, kind: 'forceNext', pats, src }); return true; }
      if (w && w.on === 'roundStart') { d.force.push({ pats, all: !!e.all, cond: { kind: 'roundFirstSpinOnce' }, src }); return true; }
      return false;
    }
    case 'addPatterns': {
      const pats = patternsFromSpec(e.patterns);
      if (!w) { for (const p of pats) d.enabled[p] = true; return true; }
      return false;
    }
    case 'transform': {
      if (e.mode === 'singlePatternToBest') { d.transforms.painKillers = true; return true; }
      if (e.mode === 'spreadSinglePattern') { d.transforms.halo = true; return true; }
      if (e.mode === 'rerollNonPattern') { d.transforms.d4 = (w && w.chance) || 0.3; return true; }
      return false;
    }

    // ================================================= run / economy
    case 'spins': {
      if (e.set !== undefined && !w) { d.spinsPerRound = e.set; return true; }
      if (!w) { d.spinsPerRound = Math.max(1, d.spinsPerRound + (e.add || 0) * n); return true; }
      const pre = preCond(w);
      if (pre && pre.kind === 'chance') { d.extraSpins.push({ n: (e.add || 1) * n, luck: e.luck || 0, cond: pre, src }); return true; }
      const pc = postCond(w);
      if (pc || (w.on === '666')) {
        d.temps.push({ trigger: pc || { kind: 'on666' }, kind: 'extraSpins', value: (e.add || 1) * n, decreasing: c.model && c.model.id === 'book_of_shadows', luck: e.luck || 0, src });
        return true;
      }
      return false;
    }
    case 'rounds': {
      if (e.set !== undefined && !w) { d.roundsPerDeadline = e.set; return true; }
      if (!w && (e.per === 'deadline' || !e.per)) { d.roundsPerDeadline += (e.add || 0) * n; return true; }
      d.econ.push({ kind: 'rounds', amount: (e.add || 1) * n, per: e.per || (w && w.event === 'instant' ? 'instant' : 'deadline'), when: w, src });
      return true;
    }
    case 'interest': {
      if (!w && !e.per) { d.interest += (e.add || 0) * n; if (e.decay) d.flags['decay_' + src] = e.decay; return true; }
      d.econ.push({ kind: 'interest', amount: (e.add || 0) * n, per: e.per || 'instant', when: w, src });
      return true;
    }
    case 'tickets':
      d.econ.push({ kind: 'tickets', amount: (e.add || 0) * n, mul: e.mul, set: e.set, per: e.per || (w ? 'event' : 'instant'), when: w, perUnit: e.perUnit, src });
      return true;
    case 'ticketIncome':
      d.econ.push({ kind: 'ticketIncome', mul: e.mul, set: e.set, src });
      return true;
    case 'coins':
      if (e.interestMultiple !== undefined) {
        d.econ.push({ kind: 'coinsInterest', multiple: e.interestMultiple * n, when: w, src });
        return true;
      }
      d.econ.push({ kind: 'coins', amount: (e.add || 0) * n, mul: e.mul, set: e.set, debtFraction: e.debtFraction, per: e.per || 'instant', when: w, src });
      return true;
    case 'freeRestocks':
      d.econ.push({ kind: 'restocks', amount: (e.add || 0) * n, per: e.per || (w && w.event === 'instant' ? 'instant' : w ? 'event' : 'deadline'), when: w, src });
      return true;
    case 'storeDiscount':
      d.econ.push({ kind: 'discount', amount: (e.add || 0) * n, freeCharms: e.freeCharms, per: e.per, when: w, src });
      return true;
    case 'charmSpace':
      d.charmSpace += (e.add || 0) * n;
      return true;
    case 'chance666':
      if (w && !(w.event === 'instant') && !(w.redButton)) { d.risk.push({ kind: 'chance666Cond', amount: e.add || 0, src }); return false; }
      if (e.mul !== undefined) d.chance666Mul *= Math.pow(e.mul, n);
      else d.chance666Add += (e.add || 0) * n;
      return true;
    case 'protect666': {
      const keep = e.discardChance ? 1 - e.discardChance * 0.5 : 1;
      if (w && w.chance && item.triggersRandomly) { d.protectRandom.push({ p: Math.min(1, (e.chance ?? 1) * w.chance), keep, src }); return true; }
      const p = Math.min(1, (e.chance ?? 1) * (w && w.chance ? w.chance : 1));
      d.protect666 = 1 - (1 - d.protect666) * (1 - p * keep);
      return true;
    }
    case 'debt':
      if (e.mul !== undefined) d.debtMul *= Math.pow(e.mul, n);
      else if (e.addPct !== undefined) d.debtMul *= 1 + (e.addPct / 100) * n;
      else return false;
      return true;
    case 'charges': {
      d.econ.push({ kind: 'charges', restore: e.restore, targets: e.targets, when: w, src });
      const amount = typeof e.restore === 'number' ? e.restore : e.restore === 'all' ? 9 : 1;
      const all = e.targets === 'all' || e.restore === 'all';
      if (w && w.on === 'roundEnd') { d.roundEndCharges.push({ chance: w.chance ?? 1, amount, all, random: !!(w.chance && item.triggersRandomly), src }); return true; }
      if (w && w.on === 'restock') { d.roundEndCharges.push({ chance: 0.8 / Math.max(1, w.n || 1), amount, all, src }); return true; }
      if (w && w.on === 'roundStart') { d.roundEndCharges.push({ chance: 1, amount, all, src }); return true; }
      const pc = w && postCond(w);
      if (pc) { d.charges.push({ trigger: pc, amount, all, src }); return true; }
      return !!(w && w.event === 'instant'); // instant refills (Car Battery) are valued from ratings
    }
    case 'redButton':
      if (e.extraTriggers) d.rbExtra += e.extraTriggers * n;
      if (e.costReduce) d.rbCostReduce += e.costReduce * n;
      if (e.noRecharge) d.rbNoRecharge = true;
      if (e.noConsumeChance) d.rbNoConsume = 1 - (1 - d.rbNoConsume) * (1 - e.noConsumeChance);
      d.meta.push({ kind: 'redButton', e, src });
      for (const rb of d.rb) { rb.extraTriggers = d.rbExtra; rb.noConsume = d.rbNoConsume; }
      return true;
    case 'phone':
      if (e.extraTriggers) d.phoneExtra += e.extraTriggers * n;
      if (e.extraOptions) d.phoneOptions += e.extraOptions * n;
      d.meta.push({ kind: 'phone', e, src });
      return true;
    case 'randomTriggers':
      d.randomMul *= e.mul || 1;
      d.meta.push({ kind: 'randomTriggers', e, src });
      return true;
    case 'resellValue':
      d.econ.push({ kind: 'resell', amount: e.add || 0, mul: e.mul, per: e.per, src });
      return true;
    case 'trait':
      d.meta.push({ kind: 'trait', apply: e.apply, target: e.target, when: w, src });
      return e.target === 'randomEquipped' || e.target === 'allEquipped';
    case 'deathSave':
      d.econ.push({ kind: 'deathSave', rounds: e.rounds, payDebt: e.payDebt, src });
      return true;
    case 'spawnCharm':
      d.meta.push({ kind: 'spawnCharm', pool: e.pool, src });
      return false;
    case 'special':
    default:
      return false;
  }
}

// Traits on owned charms (applied once per charm).
export function applyTrait(d, trait, src) {
  switch (trait) {
    case 'ambitious': d.pmAdd += 1; break;
    case 'avid': d.smAdd += 2; break;
    case 'devious': d.chance666Add += 0.6; break;
    case 'florid': d.econ.push({ kind: 'tickets', amount: 3, per: 'deadline', src }); break;
    case 'gambler': d.econ.push({ kind: 'restocks', amount: 1, per: 'deadline', src }); break;
    case 'obsessive': d.retrig.push({ add: 1, mask: 127, last: true, cond: { kind: 'always' }, src }); break;
    case 'speculative': d.interest += 3; break;
    default: break;
  }
}

export function totalSM(d) { return d.smAdd * d.smMul; }

/** Chance that a 666 is blocked, with random-trigger protection (Rosary) scaled by Horseshoe-like effects. */
export function protect666Of(d) {
  let miss = 1 - d.protect666;
  for (const x of d.protectRandom || []) miss *= 1 - Math.min(1, x.p * d.randomMul) * x.keep;
  return 1 - miss;
}
export function totalPM(d) { return d.pmAdd * d.pmMul; }

export function chance666(d, deadline, sacred) {
  if (deadline < RULES.first666Deadline) return 0;
  const p = (RULES.chance666 + d.chance666Add) * d.chance666Mul;
  return Math.min(RULES.chance666Cap, Math.max(0, p)) / 100;
}

/** Compile a derived build into a simulator config. */
export function compileSim(d, env) {
  const p666 = chance666(d, env.deadline, env.sacred);
  const sixes = env.deadline >= RULES.first666Deadline;
  return {
    weights: d.weights.slice(),
    values: d.values.slice(),
    baseValues: BASE_VALUE.slice(),
    patVals: d.patVals.slice(),
    basePatVals: PATTERN_BASE.slice(),
    enabled: d.enabled.slice(),
    SM: totalSM(d),
    PM: totalPM(d),
    deadline: env.deadline,
    roundsPerDeadline: Math.max(1, Math.round(d.roundsPerDeadline)),
    spinsPerRound: Math.max(1, Math.round(d.spinsPerRound)),
    spontaneous: !d.flags.depression,
    sixes,
    p666,
    p66: sixes ? RULES.chance66 / 100 : 0,
    p6: sixes ? RULES.chance6 / 100 : 0,
    sacred: !!env.sacred,
    protect666: protect666Of(d),
    mods: d.mods.slice(),
    luck: d.luck.map((x) => ({ add: x.add, cond: x.cond })),
    retrig: d.retrig.map((x) => ({ add: x.add, mask: x.mask, last: !!x.last, necklace: !!x.necklace, cond: x.cond })),
    force: d.force.map((x) => ({ pats: x.pats, all: x.all, cond: x.cond })),
    extraSpins: d.extraSpins.map((x) => ({ n: x.n, luck: x.luck, cond: x.cond })),
    temps: d.temps.map((x) => ({ ...x })),
    rb: d.rb.map((x) => ({ ...x, cost: Math.max(1, x.cost - d.rbCostReduce), max: Math.max(1, x.max - d.rbCostReduce), extraTriggers: d.rbExtra, noConsume: d.rbNoConsume, noRecharge: d.rbNoRecharge })),
    transforms: { ...d.transforms },
    randomMul: d.randomMul,
    charges: d.charges.map((x) => ({ trigger: x.trigger, amount: x.amount, all: x.all })),
    roundEndCharges: d.roundEndCharges.map((x) => ({ chance: x.random ? Math.min(1, x.chance * d.randomMul) : x.chance, amount: x.amount, all: x.all })),
    trigLuck: d.trigLuck.map((x) => ({ n: x.n, add: x.add })),
    superCap: !!d.flags.superCap,
  };
}

export { SYM, PAT, postCond };
