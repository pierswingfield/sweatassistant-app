// C3-20: calendar.js kept ONE global `locations_json` KV with a TTL. Gym A's
// refresh stamped it, so gym B's refreshLocationMap early-returned and gym B's
// addresses never reached the feed until the TTL lapsed. Now one entry per gym.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const poller = require('./poller');
const calendar = require('./calendar');

const PSY = 'psycle-london';
const JAB = 'jab-boxing';
const calls = [];
// Each gym answers with its OWN locations.
poller.fetchFromGym = async (userId, gymId, path) => {
  calls.push([gymId, path]);
  const data = gymId === PSY
    ? [{ name: 'Psycle Oxford Circus', address: '1 Oxford St' }]
    : [{ name: 'SW1', address: '2 Victoria St' }];
  return { ok: true, json: async () => ({ data }) };
};

(async () => {
  const uid = db.createAccount('locs@test.local', 'password-1234');
  db.upsertUserGym(uid, PSY, { gym_email: 'a@b' });
  db.upsertUserGym(uid, JAB, { gym_email: 'a@b' });

  await calendar.refreshLocationMap(uid, false, PSY);
  await calendar.refreshLocationMap(uid, false, JAB);
  assert.deepStrictEqual(calls.map((c) => c[0]), [PSY, JAB], 'gym B must NOT early-return because gym A refreshed');

  assert.strictEqual(calendar.cachedLocationMap(PSY)['Psycle Oxford Circus'], '1 Oxford St');
  assert.strictEqual(calendar.cachedLocationMap(JAB)['SW1'], '2 Victoria St');
  assert.strictEqual(calendar.cachedLocationMap(PSY)['SW1'], undefined, 'no cross-gym bleed');

  // A fresh entry for a gym is still honoured (TTL still works, per gym).
  await calendar.refreshLocationMap(uid, false, PSY);
  assert.strictEqual(calls.length, 2, 'a gym\'s own fresh entry is not refetched');

  // A pre-existing global entry from the old build is ignored, not misattributed.
  db.setKV('locations_json', JSON.stringify({ ts: Date.now(), map: { 'Old Place': 'x' } }));
  assert.strictEqual(calendar.cachedLocationMap(PSY)['Old Place'], undefined);
  console.log('✅ Location addresses are cached per gym.');
})().catch((e) => { console.error('❌', e); process.exit(1); });
