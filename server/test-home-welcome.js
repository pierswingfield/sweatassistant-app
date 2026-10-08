// H-2: Home name preference is account-scoped and gym profiles are exposed
// only as suggestions during the authenticated gym-link flow.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');

const uid = testkit.createUser(db, `home-welcome-${Date.now()}@test.local`, 'encrypted');
db.linkGym(uid, 'jab-boxing');
db.upsertUserGym(uid, 'psycle-london', { display_name: 'Ada Lovelace' });
db.upsertUserGym(uid, 'jab-boxing', { display_name: 'Grace Hopper' });

assert.deepStrictEqual(
  db.getUserGymsPublic(uid).map((gym) => [gym.gym_id, gym.display_name]).sort(),
  [['jab-boxing', 'Grace Hopper'], ['psycle-london', 'Ada Lovelace']],
  'the client receives the linked profiles needed to detect a conflict');

assert.deepStrictEqual(db.splitSettingsByScope({ firstName: 'Ada' }), { account: { firstName: 'Ada' }, gym: {} },
  'first name is never scoped to an active gym');
db.setUserSettings(uid, { firstName: 'Ada' });
db.runWithGymContext(uid, 'jab-boxing', () => {
  assert.strictEqual(db.getUserSettings(uid).firstName, 'Ada', 'a gym switch does not change the account greeting');
});
assert.strictEqual(db.getUserSettings(uid).firstName, 'Ada');

console.log('PASS test-home-welcome');
