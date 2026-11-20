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

test('normalize cleans junk and never shares nested objects', () => {
  const src = { deadline: 'x', tickets: -3, phone: { a: 1e9, b: 'x', c: 2 }, stats: { values: { lemon: '7', cherry: 'y' }, sm: -2 }, charms: [{ id: 'pentacle', trait: 'bogus' }, { id: 'pentacle' }], prefs: { horizon: 9 } };
  const s = normalize(src);
  assert.equal(s.deadline, 1);
  assert.equal(s.tickets, 0);
  assert.deepEqual(s.phone, { a: 99, c: 2 });
  assert.deepEqual(s.stats, { values: { lemon: 7 }, sm: 0 });
  assert.deepEqual(s.charms, [{ id: 'pentacle', trait: null, drawer: false }]);
  assert.equal(s.prefs.horizon, 1);
  const t = normalize(s);
  t.phone.c = 5; t.charms[0].trait = 'avid'; t.stats.values.lemon = 1;
  assert.equal(s.phone.c, 2); assert.equal(s.charms[0].trait, null); assert.equal(s.stats.values.lemon, 7);
});
