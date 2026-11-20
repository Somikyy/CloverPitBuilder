// Build state: local persistence, share links (#b=...) and saved builds.
import { defaultState } from '../core/engine.js';
import { store } from './common.js';

const KEY = 'cp.build.v1';
const SAVED = 'cp.saved.v1';

// Cleans a build from storage or a share link: numbers become finite numbers in range, nested
// objects are fresh copies (so editing the build never changes a saved copy), unknown junk is dropped.
const finite = (x) => (x !== null && x !== undefined && x !== '' && Number.isFinite(+x) ? +x : null);
const clampInt = (x, lo, hi, dflt) => { const v = finite(x); return v === null ? dflt : Math.max(lo, Math.min(hi, Math.round(v))); };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const TRAIT_IDS = ['ambitious', 'avid', 'devious', 'florid', 'gambler', 'obsessive', 'speculative'];

function cleanNumbers(o, keys) {
  const out = {};
  if (!isObj(o)) return out;
  for (const k of keys ? keys.filter((x) => Object.hasOwn(o, x)) : Object.keys(o)) {
    const v = finite(o[k]);
    if (v !== null) out[k] = Math.max(0, v);
  }
  return out;
}

export function normalize(s) {
  const d = defaultState();
  if (!isObj(s)) return d;
  const mode = isObj(s.mode) ? s.mode : {};
  const st = isObj(s.stats) ? s.stats : {};
  const stats = {};
  for (const g of ['values', 'chances', 'patterns']) { const o = cleanNumbers(st[g]); if (Object.keys(o).length) stats[g] = o; }
  Object.assign(stats, cleanNumbers(st, ['sm', 'pm', 'interest', 'charmSpace']));
  if (stats.charmSpace !== undefined) stats.charmSpace = Math.round(stats.charmSpace);
  const phone = {};
  if (isObj(s.phone)) for (const [id, n] of Object.entries(s.phone)) { const v = clampInt(n, 0, 99, 0); if (v > 0) phone[id] = v; }
  const coins = finite(s.coins), deposited = finite(s.deposited);
  const horizon = finite(isObj(s.prefs) ? s.prefs.horizon : null);
  const seen = new Set();
  return {
    v: 1,
    mode: {
      memory: typeof mode.memory === 'string' && mode.memory ? mode.memory : d.mode.memory,
      hard: !!mode.hard, sacred: !!mode.sacred, dlc: mode.dlc !== false,
    },
    deadline: clampInt(s.deadline, 1, 30, 1),
    tickets: clampInt(s.tickets, 0, 99999, 0),
    coins: coins === null ? null : Math.max(0, coins),
    deposited: deposited === null ? null : Math.max(0, deposited),
    charms: (Array.isArray(s.charms) ? s.charms : [])
      .filter((c) => c && typeof c.id === 'string' && !seen.has(c.id) && seen.add(c.id))
      .map((c) => ({ id: c.id, trait: TRAIT_IDS.includes(c.trait) ? c.trait : null, drawer: !!c.drawer })),
    phone,
    stats,
    offers: (Array.isArray(s.offers) ? s.offers : []).filter((o) => o && typeof o.id === 'string')
      .map((o) => { const pr = finite(o.price); return { id: o.id, price: pr === null ? null : Math.max(0, Math.round(pr)) }; }),
    prefs: { horizon: horizon === null ? d.prefs.horizon : Math.max(0, Math.min(1, horizon)) },
  };
}

export function loadLocal() { return normalize(store.get(KEY, null)); }
export function saveLocal(state) { store.set(KEY, state); }

// ---------- compact form for links
function compact(s) {
  const o = {
    v: 1,
    m: [s.mode.memory || '', s.mode.hard ? 1 : 0, s.mode.sacred ? 1 : 0, s.mode.dlc === false ? 0 : 1],
    d: s.deadline, t: s.tickets,
    c: s.charms.map((c) => [c.id, c.trait || 0, c.drawer ? 1 : 0]),
    p: Object.entries(s.phone).filter(([, n]) => n > 0),
    h: s.prefs.horizon,
  };
  if (s.coins != null) o.co = s.coins;
  if (s.deposited != null) o.de = s.deposited;
  if (s.offers.length) o.o = s.offers.map((x) => [x.id, x.price ?? null]);
  const st = cleanStats(s.stats);
  if (st) o.s = st;
  return o;
}

function cleanStats(st) {
  if (!st) return null;
  const out = {};
  for (const [k, v] of Object.entries(st)) {
    if (v && typeof v === 'object') {
      const inner = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== null && x !== undefined));
      if (Object.keys(inner).length) out[k] = inner;
    } else if (v !== '' && v !== null && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function expand(o) {
  return normalize({
    mode: { memory: o.m?.[0] || 'erased_memory_card', hard: !!o.m?.[1], sacred: !!o.m?.[2], dlc: o.m?.[3] !== 0 },
    deadline: o.d ?? 1, tickets: o.t ?? 0, coins: o.co ?? null, deposited: o.de ?? null,
    charms: (Array.isArray(o.c) ? o.c : []).filter(Array.isArray).map(([id, trait, drawer]) => ({ id, trait: trait || null, drawer: !!drawer })),
    phone: Object.fromEntries(Array.isArray(o.p) ? o.p.filter((x) => Array.isArray(x) && typeof x[0] === 'string') : []),
    stats: o.s || {},
    offers: (Array.isArray(o.o) ? o.o : []).filter(Array.isArray).map(([id, price]) => ({ id, price })),
    prefs: { horizon: o.h ?? 0.7 },
  });
}

const b64url = {
  enc(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeShare(state) {
  const json = new TextEncoder().encode(JSON.stringify(compact(state)));
  if (typeof CompressionStream !== 'undefined') {
    try { return 'z' + b64url.enc(await pipe(json, new CompressionStream('deflate-raw'))); } catch { /* fall through */ }
  }
  return 'j' + b64url.enc(json);
}

export async function decodeShare(code) {
  if (!code) return null;
  try {
    const kind = code[0], body = code.slice(1);
    if (kind !== 'z' && kind !== 'j') return null;
    let bytes = b64url.dec(body);
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    const o = JSON.parse(new TextDecoder().decode(bytes));
    return o && typeof o === 'object' && !Array.isArray(o) ? expand(o) : null;
  } catch { return null; }
}

export async function shareUrl(state) {
  const code = await encodeShare(state);
  const u = new URL(location.href);
  u.hash = 'b=' + code;
  return u.toString();
}

export function readHashCode() {
  const m = location.hash.match(/[#&]b=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ---------- saved builds
export function listSaved() { const l = store.get(SAVED, []); return Array.isArray(l) ? l.filter((x) => x && typeof x.name === 'string') : []; }
export function saveBuild(name, state) {
  const list = listSaved().filter((x) => x.name !== name);
  list.unshift({ name, state: normalize(state), ts: Date.now() });
  store.set(SAVED, list.slice(0, 30));
}
export function deleteSaved(name) { store.set(SAVED, listSaved().filter((x) => x.name !== name)); }
