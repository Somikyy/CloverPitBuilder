// Node helper: load the site's data files and build the engine database.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../assets/js/core/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export function loadDb() {
  const items = JSON.parse(readFileSync(join(ROOT, 'data/items.json'), 'utf8'));
  const mech = JSON.parse(readFileSync(join(ROOT, 'data/mechanics.json'), 'utf8'));
  let models = [];
  const dir = join(ROOT, 'data/models');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const arr = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    models = models.concat(Array.isArray(arr) ? arr : arr.models || []);
  }
  return makeDb(items, models, mech);
}
