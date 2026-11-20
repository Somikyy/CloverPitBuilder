// Runs the build engine off the main thread so the page stays smooth.
import { analyze, makeDb } from '../core/engine.js';

let dbPromise = null;
async function load(base) {
  const get = async (p) => { const r = await fetch(new URL(p, base)); if (!r.ok) throw new Error(p); return r.json(); };
  const [items, models, mech] = await Promise.all([get('data/items.json'), get('data/models.json').catch(() => []), get('data/mechanics.json')]);
  return makeDb(items, Array.isArray(models) ? models : models.models || [], mech);
}

self.onmessage = async (e) => {
  const { id, state, base, opt } = e.data;
  try {
    if (!dbPromise) dbPromise = load(base);
    const db = await dbPromise;
    const t0 = performance.now();
    const res = analyze(state, db, opt || {});
    res.ms = Math.round(performance.now() - t0);
    self.postMessage({ id, res });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
