// Core game constants shared by the simulator and the engine.
// Values mirror data/mechanics.json (sourced from the CloverPit Wiki).

export const SYMBOLS = ['lemon', 'cherry', 'clover', 'bell', 'diamond', 'treasure', 'seven'];
export const SYMBOL_NAMES = ['Lemon', 'Cherry', 'Clover', 'Bell', 'Diamond', 'Treasure', 'Seven'];
export const SYMBOL_PLURALS = ['Lemons', 'Cherries', 'Clovers', 'Bells', 'Diamonds', 'Treasures', 'Sevens'];
export const SYM = Object.fromEntries(SYMBOLS.map((s, i) => [s, i]));
export const BASE_VALUE = [2, 2, 3, 3, 5, 5, 7];
export const BASE_WEIGHT = [1.3, 1.3, 1.0, 1.0, 0.8, 0.8, 0.5];
export const SIX = 7; // grid cell value used for a "6" (blocks patterns)

export const PATTERNS = ['HOR', 'VER', 'DIAG', 'HOR_L', 'HOR_XL', 'ZIG', 'ZAG', 'ABOVE', 'BELOW', 'EYE', 'JACKPOT', 'HOR_S', 'VER_S', 'DIAG_S'];
export const PATTERN_NAMES = ['HOR', 'VER', 'DIAG', 'HOR-L', 'HOR-XL', 'ZIG', 'ZAG', 'ABOVE', 'BELOW', 'EYE', 'JACKPOT', 'HOR-S', 'VER-S', 'DIAG-S'];
export const PAT = Object.fromEntries(PATTERNS.map((p, i) => [p, i]));
export const PATTERN_BASE = [1, 1, 1, 2, 3, 4, 4, 7, 7, 8, 10, 0.5, 0.5, 0.5];
export const PATTERN_SIZE = [3, 3, 3, 4, 5, 5, 5, 8, 8, 10, 15, 2, 2, 2];
export const SMALL_PATTERNS = [0, 1, 2, 11, 12, 13];
export const LARGE_PATTERNS = [3, 4, 5, 6, 7, 8, 9, 10];

export const MODIFIERS = ['golden', 'token', 'ticket', 'repetition', 'battery', 'chain', 'investor', 'rising', 'copy', 'revenge'];
export const MOD = Object.fromEntries(MODIFIERS.map((m, i) => [m, i]));

export const TRAITS = ['ambitious', 'avid', 'devious', 'florid', 'gambler', 'obsessive', 'speculative'];

// Symbol groups as 7-bit masks (bit i = SYMBOLS[i]).
export const MASK_ALL = 0b1111111;
export const MASK_FRUIT = (1 << 0) | (1 << 1);
export const MASK_YELLOW = (1 << 0) | (1 << 3) | (1 << 5) | (1 << 6);
export const MASK_NONYELLOW = (1 << 1) | (1 << 2) | (1 << 4);
export const MASK_GEMS = (1 << 4) | (1 << 5) | (1 << 6);

export const RULES = {
  rows: 3,
  cols: 5,
  charmSpace: 7,
  roundsPerDeadline: 3,
  spinsMost: 7,
  spinsFew: 3,
  baseInterest: 7,
  chance666: 1.5,
  chance666Cap: 30,
  chance66: 6.0,
  chance6: 7.5,
  first666Deadline: 3,
  ticketsMost: 1,
  ticketsPerSkippedRound: 4,
};

// Debt / lever / restock per deadline (wiki ATM page). Index = deadline - 1.
export const DEADLINES = [
  { debt: 75, lever: 7, restock: 3 },
  { debt: 200, lever: 14, restock: 6 },
  { debt: 666, lever: 28, restock: 20 },
  { debt: 2222, lever: 42, restock: 69 },
  { debt: 12500, lever: 56, restock: 300 },
  { debt: 33333, lever: 140, restock: 1000 },
  { debt: 66666, lever: 168, restock: 2000 },
  { debt: 200000, lever: 196, restock: 7000 },
  { debt: 1000000, lever: 224, restock: 43000 },
  { debt: 6000000, lever: 756, restock: 375000 },
  { debt: 144000000, lever: 1260, restock: 9000000 },
  { debt: 13800000000, lever: 1386, restock: 864000000 },
  { debt: 2e13, lever: 1500, restock: 1.3e12 },
  { debt: 2e17, lever: 546, restock: 1.27e16 },
  { debt: 2e22, lever: 588, restock: 5.41e20 },
  { debt: 2.96e27, lever: 840, restock: 1e25 },
];

export function deadlineInfo(n) {
  const i = Math.max(1, Math.min(n, DEADLINES.length)) - 1;
  return DEADLINES[i];
}

export function symbolsFromSpec(spec, ctx = {}) {
  // Returns a 7-bit mask for a model's `symbols` field.
  if (Array.isArray(spec)) return spec.reduce((m, s) => (SYM[s] !== undefined ? m | (1 << SYM[s]) : m), 0);
  switch (spec) {
    case 'all': return MASK_ALL;
    case 'fruit': return MASK_FRUIT;
    case 'yellow': return MASK_YELLOW;
    case 'nonYellow': return MASK_NONYELLOW;
    case 'gems': return MASK_GEMS;
    case 'mostProbable': return ctx.mostProbableMask ?? (1 << 0);
    case 'mostValuable': return ctx.mostValuableMask ?? (1 << 6);
    default: return 0;
  }
}

export function patternsFromSpec(spec) {
  // Returns array of pattern indices.
  if (Array.isArray(spec)) return spec.map((p) => PAT[p]).filter((x) => x !== undefined);
  if (spec === 'small') return SMALL_PATTERNS.slice();
  if (spec === 'large') return LARGE_PATTERNS.slice();
  if (spec === 'all') return PATTERNS.map((_, i) => i);
  if (typeof spec === 'string' && PAT[spec] !== undefined) return [PAT[spec]];
  return [];
}

export function maskToList(mask) {
  const out = [];
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) out.push(i);
  return out;
}
