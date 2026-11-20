// CloverPit slot machine simulator.
//
// Simulates whole deadlines (rounds x spins) on the real 3x5 grid:
// symbol chances, luck, the wiki's pattern shapes and "larger pattern hides
// smaller one" rule, retriggers, symbol modifiers, 6/66/666, Red Button charms
// and temporary (round / deadline) buffs. Permanent growth is NOT applied
// during the run (that would make the numbers explode); instead the simulator
// measures how often every trigger condition happens, and the engine turns
// those rates into growth over the player's horizon.

import { makeRng } from './rng.js';
import { SIX } from './constants.js';

// ---------------------------------------------------------------- patterns
const cell = (r, c) => r * 5 + c;
const SHAPES = {
  5: [[2, 0], [1, 1], [0, 2], [1, 3], [2, 4]], // ZIG (peak at the top)
  6: [[0, 0], [1, 1], [2, 2], [1, 3], [0, 4]], // ZAG (V)
  7: [[0, 2], [1, 1], [1, 3], [2, 0], [2, 1], [2, 2], [2, 3], [2, 4]], // ABOVE
  8: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 1], [1, 3], [2, 2]], // BELOW
  9: [[0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3]], // EYE
};

function buildInstances() {
  const list = [];
  const add = (p, cells) => list.push({ p, cells, mask: cells.reduce((m, c) => m | (1 << c), 0), size: cells.length });
  for (let r = 0; r < 3; r++) for (let c = 0; c <= 2; c++) add(0, [cell(r, c), cell(r, c + 1), cell(r, c + 2)]);
  for (let c = 0; c < 5; c++) add(1, [cell(0, c), cell(1, c), cell(2, c)]);
  for (let c = 0; c <= 2; c++) {
    add(2, [cell(0, c), cell(1, c + 1), cell(2, c + 2)]);
    add(2, [cell(2, c), cell(1, c + 1), cell(0, c + 2)]);
  }
  for (let r = 0; r < 3; r++) for (let c = 0; c <= 1; c++) add(3, [cell(r, c), cell(r, c + 1), cell(r, c + 2), cell(r, c + 3)]);
  for (let r = 0; r < 3; r++) add(4, [0, 1, 2, 3, 4].map((c) => cell(r, c)));
  for (const p of [5, 6, 7, 8, 9]) add(p, SHAPES[p].map(([r, c]) => cell(r, c)));
  add(10, Array.from({ length: 15 }, (_, i) => i));
  for (let r = 0; r < 3; r++) for (let c = 0; c <= 3; c++) add(11, [cell(r, c), cell(r, c + 1)]);
  for (let r = 0; r <= 1; r++) for (let c = 0; c < 5; c++) add(12, [cell(r, c), cell(r + 1, c)]);
  for (let r = 0; r <= 1; r++) for (let c = 0; c <= 3; c++) {
    add(13, [cell(r, c), cell(r + 1, c + 1)]);
    add(13, [cell(r + 1, c), cell(r, c + 1)]);
  }
  for (const inst of list) {
    inst.containers = [];
    for (let j = 0; j < list.length; j++) {
      const o = list[j];
      if (o === inst || o.p === 10 || o.size <= inst.size) continue;
      if ((o.mask & inst.mask) === inst.mask) inst.containers.push(j);
    }
  }
  return list;
}

export const INSTANCES = buildInstances();
const NI = INSTANCES.length;
const INST_P = Int8Array.from(INSTANCES.map((i) => i.p));
const INST_MASK = Int32Array.from(INSTANCES.map((i) => i.mask));
const INST_FIRST = Int8Array.from(INSTANCES.map((i) => i.cells[0]));
const INST_SIZE = Int8Array.from(INSTANCES.map((i) => i.size));
const INST_CONT = INSTANCES.map((i) => Int16Array.from(i.containers));
const INST_CELLS = INSTANCES.map((i) => Int8Array.from(i.cells));
const POPCOUNT15 = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };

// Which grid cells border a cell (for Halo).
const NEIGHBOURS = Array.from({ length: 15 }, (_, i) => {
  const r = Math.floor(i / 5), c = i % 5, out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 3 && cc >= 0 && cc < 5) out.push(rr * 5 + cc);
  }
  return out;
});

// ---------------------------------------------------------------- helpers
function pickWeighted(weights, total, u) {
  let x = u * total;
  for (let i = 0; i < 7; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  for (let i = 6; i >= 0; i--) if (weights[i] > 0) return i;
  return 0;
}

function preCondOk(c, ctx, rng) {
  switch (c.kind) {
    case 'always': return true;
    case 'chance': return rng() < Math.min(1, c.p * ctx.randomMul);
    case 'spin': return c.which === 'first' ? ctx.spinIdx === 0 : ctx.spinIdx === ctx.spinsThisRound - 1;
    case 'every': return ((ctx.globalSpin + 1) % c.n) === 0;
    case 'round': return c.which === 'first' ? ctx.roundIdx === 0 : ctx.roundIdx === ctx.roundsThisDeadline - 1;
    case 'noRewardStreak': return ctx.noRewardStreak >= c.n;
    case 'noPatternsPrev': return ctx.prevPatterns === 0 && ctx.spinIdx > 0;
    case 'after666': return ctx.after666;
    case 'scoredStreak': return ctx.gemStreak >= c.n;
    case 'no5Streak': return ctx.no5Streak >= c.n;
    case 'roundFirstSpinOnce': return ctx.spinIdx === 0 && ctx.roundIdx === 0;
    default: return false;
  }
}

function postCondOk(c, o, rng, randomMul) {
  switch (c.kind) {
    case 'always': return true;
    case 'chance': return rng() < Math.min(1, c.p * randomMul);
    case 'patternsAtLeast': return o.patCount >= c.n;
    case 'patternsExactly': return o.instCount === c.n;
    case 'noPatterns': return o.instCount === 0;
    case 'sizeAtLeast': return o.maxSize >= c.n;
    case 'onlyEye': return o.instCount === 1 && o.onlyEye;
    case 'on666': return o.is666;
    case 'onJackpot': return o.jackpot;
    case 'scoredAll': return (o.scoredMask & c.mask) === c.mask;
    case 'scoredAny': return (o.scoredMask & c.mask) !== 0;
    case 'noRewardStreak': return o.noRewardStreak > 0 && o.noRewardStreak % c.n === 0;
    case 'and': return c.all.every((x) => postCondOk(x, o, rng, randomMul));
    default: return false;
  }
}

// ---------------------------------------------------------------- simulate
/**
 * @param {object} cfg compiled config (see build.js compileSim)
 * @param {object} [opt] { seed, deadlines }
 */
export function simulate(cfg, opt = {}) {
  const seed = opt.seed ?? 1234567;
  const rng = makeRng(seed);                 // misc: conditions, sixes, spontaneous luck
  const rg = makeRng((seed * 2654435761) >>> 0 ^ 0x5bd1e995); // grid cells + luck placement
  const rmod = makeRng((seed + 0x9e3779b9) >>> 0);           // symbol modifiers
  const rl = makeRng((seed ^ 0x85ebca6b) >>> 0);             // the machine's own (spontaneous) luck
  const rs = makeRng((seed * 31 + 0xc2b2ae35) >>> 0);        // 6 / 66 / 666 rolls and placement
  const rc = makeRng((seed * 7 + 0x27d4eb2f) >>> 0);         // charm trigger chances
  const nDeadlines = opt.deadlines ?? 400;
  const D = cfg.deadline;
  const roundsPerDeadline = cfg.roundsPerDeadline;
  const baseSpins = cfg.spinsPerRound;
  const weights0 = Float64Array.from(cfg.weights);
  const values = Float64Array.from(cfg.values);
  const patVals = Float64Array.from(cfg.patVals);
  const enabled0 = Uint8Array.from(cfg.enabled.map((x) => (x ? 1 : 0)));
  const mods = Float64Array.from(cfg.mods); // [m*7+s]
  const randomMul = cfg.randomMul || 1;

  // per-symbol modifier tables
  const modTable = [];
  for (let s = 0; s < 7; s++) {
    const t = [];
    for (let m = 0; m < 10; m++) if (mods[m * 7 + s] > 0) t.push([m, mods[m * 7 + s]]);
    modTable.push(t);
  }

  const luckSrc = cfg.luck || [];
  const retrigSrc = cfg.retrig || [];
  const forceSrc = cfg.force || [];
  const extraSrc = cfg.extraSpins || [];
  const temps = cfg.temps || [];
  const rbItems = (cfg.rb || []).map((x) => ({ ...x, charges: x.max ?? x.cost, activeDeadline: false }));

  // accumulators
  const N = new Float64Array(7 * 14);
  const hist = new Float64Array(64);
  const modEvents = new Float64Array(70);
  const cellsScored = new Float64Array(7);
  const cellEvents = new Float64Array(7);
  const symCoins = new Float64Array(7);
  const patCoins = new Float64Array(14);
  let spins = 0, rounds = 0, coins = 0, coinsNet = 0, linear = 0;
  let cntExactly1 = 0, cntNone = 0, cntSize4 = 0, cntSize5 = 0, cntOnlyEye = 0, cnt666 = 0, cnt999 = 0;
  let cntJackpot = 0, cntGem = 0, cntCloverBell = 0, cntNoReward2 = 0, cntNoReward3 = 0, cntNoReward4 = 0;
  let luckSum = 0, extraSpinsTotal = 0, rbActivations = 0, chargesFromBattery = 0, cntAnyCharmTrig = 0;
  let cntAllSymbolsRound = 0, cntBlocked666 = 0;
  const tempTriggerCounts = new Float64Array(temps.length);

  const grid = new Int8Array(15);
  const cellMod = new Int8Array(15);
  const symMask = new Int32Array(8);
  const formed = new Uint8Array(NI);
  const scored = new Int16Array(NI);
  const trig = new Float64Array(NI);
  const idx15 = new Int8Array(15);
  const spinRetrig = new Float64Array(7);

  let globalSpin = (D - 1) * roundsPerDeadline * baseSpins;
  let nextOLS = D <= 1 ? Infinity : globalSpin + 1 + Math.floor(rl() * 5);
  const ilsOffset = Math.floor(rl() * 5);

  for (let d = 0; d < nDeadlines; d++) {
    // deadline-scoped temporary state
    const weights = Float64Array.from(weights0);
    const enabled = Uint8Array.from(enabled0);
    const dlSymMul = new Float64Array(7).fill(1);
    let dlSM = 0, dlPM = 0;
    for (const rb of rbItems) rb.activeDeadline = false;
    let roundsThisDeadline = roundsPerDeadline;
    let noRewardStreak = 0, prevPatterns = 1, gemStreak = 0, no5Streak = 0, spinInDeadline = 0;

    for (let r = 0; r < roundsThisDeadline; r++) {
      rounds++;
      // round-scoped temporary state
      const rSymMul = new Float64Array(7).fill(1);
      const rSymAddBase = new Float64Array(7);
      const rPatMul = new Float64Array(14).fill(1);
      const rPatAddBase = new Float64Array(14);
      let rSMmul = 1, rSMadd = 0, rPMadd = 0;
      const rRetrig = new Float64Array(7);
      const rEnabled = Uint8Array.from(enabled);
      let luckNext = 0, pendingForce = null, after666 = false, bosLeft = 3;
      let roundCoins = 0, roundScoredMask = 0;
      let spinsThisRound = baseSpins;
      let pendingExtra = []; // [{luck}]

      // Red Button policy: fire every charged charm at round start.
      for (const rb of rbItems) {
        if (rb.charges < rb.cost) continue;
        if (rb.duration === 'deadline' && rb.activeDeadline) continue;
        const times = 1 + (rb.extraTriggers || 0);
        rb.charges -= rb.noConsume && rng() < rb.noConsume ? 0 : rb.cost;
        rb.activeDeadline = true;
        rbActivations++;
        for (let t = 0; t < times; t++) {
          for (const e of rb.effects) {
            if (e.kind === 'weightAdd') for (let s = 0; s < 7; s++) { if (e.mask & (1 << s)) weights[s] += e.value; }
            else if (e.kind === 'retrigRound') { for (let s = 0; s < 7; s++) if (e.mask & (1 << s)) rRetrig[s] += e.value; }
            else if (e.kind === 'luckFirst') luckNext += e.value;
            else if (e.kind === 'extraSpin') { pendingExtra.push({ luck: e.luck || 0 }); spinsThisRound++; extraSpinsTotal++; }
            else if (e.kind === 'addPattern') { const pick = e.pats[Math.floor(rng() * e.pats.length)]; rEnabled[pick] = 1; }
            else if (e.kind === 'symAddBaseRound') for (let s = 0; s < 7; s++) { if (e.mask & (1 << s)) rSymAddBase[s] += e.value; }
            else if (e.kind === 'force') pendingForce = e.pats;
          }
        }
      }

      for (let si = 0; si < spinsThisRound; si++) {
        spins++; globalSpin++; spinInDeadline++;
        const ctx = {
          spinIdx: si, spinsThisRound, roundIdx: r, roundsThisDeadline, globalSpin,
          noRewardStreak, prevPatterns, after666, gemStreak, no5Streak, randomMul,
        };
        // ---- luck
        let charmLuck = luckNext; luckNext = 0;
        for (const L of luckSrc) if (preCondOk(L.cond, ctx, rc)) charmLuck += L.add;
        let luck = charmLuck;
        if (si >= baseSpins && pendingExtra.length) luck += pendingExtra.shift().luck;
        if (cfg.spontaneous) {
          if (D <= 1) {
            const sn = spinInDeadline;
            if (sn > 1 && (sn + ilsOffset + 1) % (4 + Math.floor(sn / 6)) === 0) {
              const roll = Math.floor(rl() * 6); // 4,5,6,6,7,8
              luck += [4, 5, 6, 6, 7, 8][roll];
            }
          } else if (globalSpin >= nextOLS) {
            let add = globalSpin % 3 === 0 ? 5 + Math.floor(rl() * 3) : 3 + Math.floor(rl() * 3);
            if (globalSpin % 7 === 0) add += 7 + Math.floor(rl() * 3);
            luck += add;
            nextOLS = globalSpin + 4 + (D - 1) + (rl() < 0.5 ? 1 : 0);
          }
          if (noRewardStreak >= 4) luck += 5 + (noRewardStreak - 4);
          if (charmLuck >= 1 && charmLuck <= 4) { { const a = rl(), b = rl(); if (a < 0.5) luck += 1 + Math.floor(b * 2); } }
          else if (charmLuck >= 5 && charmLuck <= 6) { if (rl() < 0.25) luck += 1; }
          else if (charmLuck === 7) { if (rl() < 1 / 6) luck += 1; }
        }
        luckSum += luck;

        // ---- grid
        let wTotal = 0;
        for (let s = 0; s < 7; s++) wTotal += weights[s];
        for (let c = 0; c < 15; c++) grid[c] = pickWeighted(weights, wTotal, rg());
        const luckU = rg();
        if (luck > 0) {
          const ls = pickWeighted(weights, wTotal, luckU);
          if (luck >= 15) grid.fill(ls);
          else {
            for (let i = 0; i < 15; i++) idx15[i] = i;
            for (let i = 0; i < luck; i++) {
              const j = i + Math.floor(rg() * (15 - i));
              const t = idx15[i]; idx15[i] = idx15[j]; idx15[j] = t;
              grid[idx15[i]] = ls;
            }
          }
        }
        // ---- forced patterns
        let force = pendingForce; pendingForce = null;
        for (const F of forceSrc) if (preCondOk(F.cond, ctx, rc)) force = F.all ? F.pats : [F.pats[Math.floor(rng() * F.pats.length)]];
        if (force) {
          for (const p of force) {
            const fs = pickWeighted(weights, wTotal, rng());
            const inst = INSTANCES.find((x) => x.p === p && (p !== 4 || x.cells[0] === 5)) || INSTANCES.find((x) => x.p === p);
            for (const c of inst.cells) grid[c] = fs;
          }
        }
        // ---- sixes
        let is666 = false;
        if (cfg.sixes) {
          const u1 = rs(), u2 = rs(), u3 = rs();
          let n6 = 0;
          if (u1 < cfg.p666) { n6 = 3; is666 = true; }
          else if (u2 < cfg.p66) n6 = 2;
          else if (u3 < cfg.p6) n6 = 1;
          for (let i = 0; i < 15; i++) idx15[i] = i;
          for (let i = 0; i < n6; i++) {
            const j = i + Math.floor(rs() * (15 - i));
            const t = idx15[i]; idx15[i] = idx15[j]; idx15[j] = t;
            grid[idx15[i]] = SIX;
          }
        }
        // ---- modifiers
        for (let c = 0; c < 15; c++) {
          cellMod[c] = -1;
          const s = grid[c];
          if (s === SIX) continue;
          const t = modTable[s];
          const u = rmod();
          let acc = 0;
          for (let k = 0; k < t.length; k++) { acc += t[k][1]; if (u < acc) { cellMod[c] = t[k][0]; break; } }
        }

        // ---- detection (with optional transforms)
        let instCount = 0;
        const detect = () => {
          symMask.fill(0);
          for (let c = 0; c < 15; c++) symMask[grid[c]] |= 1 << c;
          for (let i = 0; i < NI; i++) {
            formed[i] = 0;
            if (!rEnabled[INST_P[i]]) continue;
            const s = grid[INST_FIRST[i]];
            if (s === SIX) continue;
            if ((symMask[s] & INST_MASK[i]) === INST_MASK[i]) formed[i] = 1;
          }
          instCount = 0;
          for (let i = 0; i < NI; i++) {
            if (!formed[i]) continue;
            const cont = INST_CONT[i];
            let hidden = false;
            for (let k = 0; k < cont.length; k++) if (formed[cont[k]]) { hidden = true; break; }
            if (!hidden) scored[instCount++] = i;
          }
        };
        detect();
        if (instCount === 1 && cfg.transforms) {
          const only = scored[0];
          if (cfg.transforms.halo) {
            const s = grid[INST_FIRST[only]];
            for (const c of INST_CELLS[only]) for (const nb of NEIGHBOURS[c]) if (grid[nb] !== SIX) grid[nb] = s;
            detect();
          } else if (cfg.transforms.painKillers) {
            let best = 0;
            for (let s = 1; s < 7; s++) if (values[s] > values[best]) best = s;
            for (const c of INST_CELLS[only]) grid[c] = best;
            detect();
          }
        }
        if (cfg.transforms && cfg.transforms.d4 && rng() < Math.min(1, cfg.transforms.d4 * randomMul)) {
          let inPat = 0;
          for (let k = 0; k < instCount; k++) inPat |= INST_MASK[scored[k]];
          for (let c = 0; c < 15; c++) if (!(inPat & (1 << c)) && grid[c] !== SIX) grid[c] = pickWeighted(weights, wTotal, rng());
          detect();
        }

        // ---- triggers per pattern
        let lastAdd = 0;
        for (let s = 0; s < 7; s++) spinRetrig[s] = rRetrig[s];
        for (const R of retrigSrc) {
          if (!preCondOk(R.cond, ctx, rc)) continue;
          if (R.last) lastAdd += R.add;
          else for (let s = 0; s < 7; s++) if (R.mask & (1 << s)) spinRetrig[s] += R.add;
        }
        let patCount = 0, maxSize = 0, scoredMask = 0, jackpot = false, onlyEye = false, cellsMaskSpin = 0;
        let spinCoins = 0;
        const SMx = (cfg.SM + dlSM + rSMadd) * rSMmul;
        const PMx = cfg.PM + dlPM + rPMadd;
        for (let k = 0; k < instCount; k++) {
          const i = scored[k];
          const s = grid[INST_FIRST[i]];
          const p = INST_P[i];
          let t = 1 + spinRetrig[s];
          if (k === instCount - 1) t += lastAdd;
          const cells = INST_CELLS[i];
          for (let q = 0; q < cells.length; q++) if (cellMod[cells[q]] === 3) t += 1; // repetition
          trig[i] = t;
          patCount += t;
          if (INST_SIZE[i] > maxSize) maxSize = INST_SIZE[i];
          scoredMask |= 1 << s;
          cellsMaskSpin |= INST_MASK[i];
          if (p === 10) jackpot = true;
          if (p === 9) onlyEye = true;
          N[s * 14 + p] += t;
          cellEvents[s] += t * INST_SIZE[i];
          const symV = values[s] * rSymMul[s] * dlSymMul[s] + rSymAddBase[s] * (cfg.baseValues ? cfg.baseValues[s] : 0);
          const patV = patVals[p] * rPatMul[p] + rPatAddBase[p] * (cfg.basePatVals ? cfg.basePatVals[p] : 0);
          const c = symV * patV * t;
          spinCoins += c;
          symCoins[s] += c * SMx * PMx;
          patCoins[p] += c * SMx * PMx;
          linear += values[s] * patVals[p] * t * cfg.SM * cfg.PM;
          for (let q = 0; q < cells.length; q++) {
            const m = cellMod[cells[q]];
            if (m >= 0) modEvents[m * 7 + s] += t;
          }
        }
        for (let c = 0; c < 15; c++) if (cellsMaskSpin & (1 << c)) cellsScored[grid[c]] += 1;
        spinCoins *= SMx * PMx;
        if (patCount < hist.length) hist[patCount | 0]++; else hist[hist.length - 1]++;
        if (instCount === 1) cntExactly1++;
        if (instCount === 0) cntNone++;
        if (maxSize >= 4) cntSize4++;
        if (maxSize >= 5) cntSize5++;
        if (instCount === 1 && onlyEye) cntOnlyEye++;
        if (jackpot) cntJackpot++;
        if (scoredMask & 0b1110000) cntGem++;
        if ((scoredMask & 0b1100) === 0b1100) cntCloverBell++;
        roundScoredMask |= scoredMask;

        // ---- 666 / 999
        coins += spinCoins;
        roundCoins += spinCoins;
        if (is666) {
          if (cfg.sacred) { cnt999++; roundCoins += roundCoins; }
          else {
            cnt666++;
            if (cfg.protect666 && rs() < cfg.protect666) { cntBlocked666++; is666 = false; }
            else if (D >= 3) roundCoins = 0;
          }
        }

        // ---- post-spin triggered temporaries
        const o = { patCount, instCount, maxSize, onlyEye, is666, jackpot, scoredMask, noRewardStreak: patCount > 0 ? 0 : noRewardStreak + 1 };
        let anyTrig = false;
        for (let ti = 0; ti < temps.length; ti++) {
          const T = temps[ti];
          if (!postCondOk(T.trigger, o, rc, randomMul)) continue;
          tempTriggerCounts[ti]++;
          anyTrig = true;
          const v = T.value;
          switch (T.kind) {
            case 'symMulRound': for (let s = 0; s < 7; s++) if (T.mask & (1 << s)) rSymMul[s] = T.stack ? rSymMul[s] * v : Math.max(rSymMul[s], v); break;
            case 'symMulDeadline': for (let s = 0; s < 7; s++) if (T.mask & (1 << s)) dlSymMul[s] = T.stack ? dlSymMul[s] * v : Math.max(dlSymMul[s], v); break;
            case 'symAddBaseRound': {
              const extra = T.perExtraPattern ? Math.max(0, patCount - 2) : 1;
              for (let s = 0; s < 7; s++) if (T.mask & (1 << s)) rSymAddBase[s] += v * extra;
              break;
            }
            case 'patMulRound': for (const p of T.pats) rPatMul[p] = T.stack ? rPatMul[p] * v : Math.max(rPatMul[p], v); break;
            case 'patAddBaseRound': for (const p of T.pats) rPatAddBase[p] += v; break;
            case 'smMulRound': rSMmul = T.stack ? rSMmul * v : Math.max(rSMmul, v); break;
            case 'smAddRound': rSMadd += v; break;
            case 'smAddDeadline': dlSM += v; break;
            case 'pmAddRound': rPMadd += v; break;
            case 'pmAddDeadline': dlPM += v; break;
            case 'retrigRound': for (let s = 0; s < 7; s++) if (T.mask & (1 << s)) rRetrig[s] += v; break;
            case 'luckNext': luckNext += v; break;
            case 'extraSpins': {
              let n = v;
              if (T.decreasing) { n = Math.max(0, bosLeft); bosLeft--; }
              for (let q = 0; q < n; q++) pendingExtra.push({ luck: T.luck || 0 });
              spinsThisRound += n; extraSpinsTotal += n;
              break;
            }
            case 'forceNext': pendingForce = T.pats; break;
            default: break;
          }
        }
        if (anyTrig) cntAnyCharmTrig++;

        // ---- extra spins from pre-spin sources (Fake Coin etc.)
        for (const X of extraSrc) {
          if (preCondOk(X.cond, ctx, rc)) {
            for (let q = 0; q < X.n; q++) pendingExtra.push({ luck: X.luck || 0 });
            spinsThisRound += X.n; extraSpinsTotal += X.n;
          }
        }

        // ---- history
        const reward = patCount > 0;
        if (!reward) { noRewardStreak++; if (noRewardStreak === 2) cntNoReward2++; if (noRewardStreak === 3) cntNoReward3++; if (noRewardStreak >= 4) cntNoReward4++; }
        else noRewardStreak = 0;
        prevPatterns = instCount;
        gemStreak = (scoredMask & 0b1110000) ? gemStreak + 1 : 0;
        no5Streak = maxSize >= 5 ? 0 : no5Streak + 1;
        if (gemStreak >= 3) gemStreak = 0; // Eye Jar consumes the streak
        after666 = after666 || is666;

        // battery modifier: recharge red button charms
        let bat = 0;
        if (rbItems.length) {
          for (let k = 0; k < instCount; k++) {
            const i = scored[k];
            for (const c of INST_CELLS[i]) if (cellMod[c] === 4) bat += trig[i];
          }
          for (let q = 0; q < bat; q++) {
            const pool = rbItems.filter((x) => x.charges < (x.max ?? x.cost));
            if (!pool.length) break;
            pool[Math.floor(rng() * pool.length)].charges++;
            chargesFromBattery++;
          }
        }
      }
      coinsNet += roundCoins;
      if (roundScoredMask === 127) cntAllSymbolsRound++;
      // round end: recharge red button charms
      for (const rb of rbItems) {
        rb.charges = Math.min((rb.max ?? rb.cost), rb.charges + (rb.noRecharge ? 0 : 1) + (cfg.dynamo && rng() < cfg.dynamo ? 1 : 0));
      }
    }
  }

  const per = (x) => x / spins;
  const pAtLeast = new Float64Array(41);
  {
    let tail = 0;
    for (let k = hist.length - 1; k >= 0; k--) { tail += hist[k]; if (k <= 40) pAtLeast[k] = tail / spins; }
  }
  return {
    spins, rounds,
    spinsPerRound: spins / rounds,
    ev: coins / spins,
    evNet: coinsNet / spins,
    linearEv: linear / spins,
    N: N.map(per),
    pAtLeast: Array.from(pAtLeast),
    avgPatterns: hist.reduce((a, v, k) => a + v * k, 0) / spins,
    pExactly1: per(cntExactly1), pNone: per(cntNone), pSize4: per(cntSize4), pSize5: per(cntSize5),
    pOnlyEye: per(cntOnlyEye), p666: per(cnt666), p999: per(cnt999), pBlocked666: per(cntBlocked666), pJackpot: per(cntJackpot),
    pGem: per(cntGem), pCloverBell: per(cntCloverBell),
    pNoReward2: per(cntNoReward2), pNoReward3: per(cntNoReward3), pNoReward4: per(cntNoReward4),
    pAnyCharmTrig: per(cntAnyCharmTrig), pAllSymbolsRound: cntAllSymbolsRound / rounds,
    modEvents: modEvents.map(per),
    cellsScored: cellsScored.map(per),
    cellEvents: cellEvents.map(per),
    symCoins: symCoins.map(per), patCoins: patCoins.map(per),
    luckAvg: luckSum / spins,
    extraSpinsPerRound: extraSpinsTotal / rounds,
    rbActivationsPerRound: rbActivations / rounds,
    chargesFromBatteryPerRound: chargesFromBattery / rounds,
    tempTriggerRates: Array.from(tempTriggerCounts).map(per),
  };
}
