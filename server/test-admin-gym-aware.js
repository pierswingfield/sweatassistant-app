// C3-7 — db.getAllUsers() must not hardcode DEFAULT_GYM_ID.
//
// getAllUsers() used to LEFT JOIN user_gyms ON ug.gym_id = DEFAULT_GYM_ID, so a
// JAB-only account (no psycle-london link) never matched the join at all: its
// display_name/priority/session came back blank/default, and the admin user
// list only ever showed Psycle data (Documentation/Workstreams/C3-multi-gym-
// correctness.md C3-7). Fixed by resolving each user's OWN gym
// (resolveActiveGymId) instead of a literal.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('a JAB-only account shows its own display name, priority and gym in the admin list', () => {
  const uid = db.createAccount(`jabonly-${Date.now()}@test.local`, 'password123');
  db.linkGym(uid, 'jab-boxing', { encryptedPassword: 'enc:pw' });
  db.upsertUserGym(uid, 'jab-boxing', { display_name: 'JAB Jane', priority: 55, gym_email: 'jane@test.local' });
  db.setGymSession(uid, 'jab-boxing', { accessToken: 'jab-token', expiresAt: '2099-01-01T00:00:00Z' });

  assert.deepStrictEqual(db.getUserGyms(uid).map((g) => g.gym_id), ['jab-boxing'], 'sole link is JAB');

  const row = db.getAllUsers().find((u) => u.id === uid);
  assert.ok(row, 'user must appear in the admin list');
  assert.strictEqual(row.active_gym_id, 'jab-boxing', 'resolves to the account\'s own (sole) gym');
  assert.strictEqual(row.display_name, 'JAB Jane',
    'must read the JAB link\'s own display_name, not come back null from a Psycle-only join');
  assert.strictEqual(row.priority, 55, 'must read the JAB link\'s own priority, not fall through to the 100 default');
  assert.strictEqual(row.jwt_expires_at, '2099-01-01T00:00:00Z', 'must read the JAB link\'s own session');
  assert.strictEqual(row.gym_count, 1);
});

check('a Psycle-only account is unaffected (behaviour-preservation)', () => {
  const uid = db.createUser(`psycleonly-${Date.now()}@test.local`, 'enc:pw');
  db.upsertUserGym(uid, 'psycle-london', { display_name: 'Psycle Pete', priority: 42 });

  const row = db.getAllUsers().find((u) => u.id === uid);
  assert.ok(row);
  assert.strictEqual(row.active_gym_id, 'psycle-london');
  assert.strictEqual(row.display_name, 'Psycle Pete');
  assert.strictEqual(row.priority, 42);
});

check('a two-gym account resolves to the default gym (psycle-london), same as resolveActiveGymId', () => {
  const uid = db.createUser(`twogym-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(uid, 'jab-boxing', { encryptedPassword: 'enc:pw' });
  db.upsertUserGym(uid, 'psycle-london', { display_name: 'Psycle Side', priority: 10 });
  db.upsertUserGym(uid, 'jab-boxing', { display_name: 'JAB Side', priority: 20 });

  const row = db.getAllUsers().find((u) => u.id === uid);
  assert.strictEqual(row.active_gym_id, 'psycle-london');
  assert.strictEqual(row.display_name, 'Psycle Side');
  assert.strictEqual(row.gym_count, 2);
});

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-7: admin user list is gym-aware\n');
  for (const { name, fn } of checks) {
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} admin-gym-aware checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} admin-gym-aware checks passed.`);
})();
