// Build state: local persistence, share links (#b=...) and saved builds.
import { defaultState } from '../core/engine.js';
import { store } from './common.js';

const KEY = 'cp.build.v1';
const SAVED = 'cp.saved.v1';

export function normalize(s) {
  const d = defaultState();
  if (!s || typeof s !== 'object') return d;
  return {
    ...d,
    ...s,
    mode: { ...d.mode, ...(s.mode || {}) },
    charms: Array.isArray(s.charms) ? s.charms.filter((c) => c && typeof c.id === 'string') : [],
    phone: s.phone && typeof s.phone === 'object' ? s.phone : {},
    stats: s.stats && typeof s.stats === 'object' ? s.stats : {},
    offers: Array.isArray(s.offers) ? s.offers.filter((o) => o && typeof o.id === 'string') : [],
    prefs: { ...d.prefs, ...(s.prefs || {}) },
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
    charms: (o.c || []).map(([id, trait, drawer]) => ({ id, trait: trait || null, drawer: !!drawer })),
    phone: Object.fromEntries(o.p || []),
    stats: o.s || {},
    offers: (o.o || []).map(([id, price]) => ({ id, price })),
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
    let bytes = b64url.dec(body);
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    return expand(JSON.parse(new TextDecoder().decode(bytes)));
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
export function listSaved() { return store.get(SAVED, []); }
export function saveBuild(name, state) {
  const list = listSaved().filter((x) => x.name !== name);
  list.unshift({ name, state, ts: Date.now() });
  store.set(SAVED, list.slice(0, 30));
}
export function deleteSaved(name) { store.set(SAVED, listSaved().filter((x) => x.name !== name)); }
