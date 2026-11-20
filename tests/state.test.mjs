import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } };
const { encodeShare, decodeShare, normalize } = await import('../assets/js/app/state.js');

test('share links round-trip a build', async () => {
  const s = normalize({
    mode: { memory: 'first_love', hard: true, sacred: false, dlc: false }, deadline: 6, tickets: 13, coins: 5000, deposited: null,
    charms: [{ id: 'pentacle', trait: 'avid', drawer: false }, { id: 'megaphone', trait: null, drawer: true }],
    phone: { life_gave_me_lemons: 3 }, stats: { values: { lemon: 50 }, sm: 4 }, offers: [{ id: 'stonks', price: 1 }], prefs: { horizon: 0.4 },
  });
  const code = await encodeShare(s);
  assert.match(code, /^[zj][A-Za-z0-9_-]+$/);
  const back = await decodeShare(code);
  assert.deepEqual(back.charms, s.charms);
  assert.deepEqual(back.phone, s.phone);
  assert.deepEqual(back.stats, s.stats);
  assert.deepEqual(back.mode, s.mode);
  assert.equal(back.deadline, 6);
  assert.equal(back.prefs.horizon, 0.4);
  assert.deepEqual(back.offers, s.offers);
});

test('bad share codes are ignored', async () => {
  assert.equal(await decodeShare('z!!!'), null);
  assert.equal(await decodeShare('jAAAA'), null);
});
