// C3-8 — admin user detail must be able to view a NON-default linked gym.
//
// db.getUserDetail(userId) (and gymGet inside admin.js) resolve through
// db.resolveActiveGymId(userId), which — with no per-request context — always
// falls back to the default gym (psycle-london) for a multi-gym account. The
// admin route GET /api/admin/users/:id had no way to ask for a DIFFERENT
// linked gym, so a two-gym account's JAB side (session, priority, spot maps,
// queue) was never viewable from the admin panel.
//
// Fixed in server/admin.js by accepting `?gymId=` (validated against
// user_gyms — the same rule auth.js's withGymContext applies to the
// `x-gym-id` header) and running the whole handler through
// db.runWithGymContext(userId, gymId, ...), exactly the pattern calendar.js
// already uses for background per-gym work. This test exercises the
// underlying resolution db.getUserDetail relies on directly (runWithGymContext
// + resolveActiveGymId), since that is the actual mechanism the route change
// leans on — a route-level check is covered by the real-browser pass.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('with no gym context, a two-gym account\'s detail resolves to the default gym', () => {
  const uid = db.createUser(`picker-a-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(uid, 'jab-boxing', { encryptedPassword: 'enc:pw' });
  db.upsertUserGym(uid, 'psycle-london', { display_name: 'Psycle Side', priority: 11 });
  db.upsertUserGym(uid, 'jab-boxing', { display_name: 'JAB Side', priority: 22 });

  const detail = db.getUserDetail(uid);
  assert.strictEqual(detail.user.display_name, 'Psycle Side', 'default gym wins with no context, as before');
});

check('runWithGymContext(uid, "jab-boxing") makes getUserDetail resolve the JAB side', () => {
  const uid = db.createUser(`picker-b-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(uid, 'jab-boxing', { encryptedPassword: 'enc:pw' });
  db.upsertUserGym(uid, 'psycle-london', { display_name: 'Psycle Side', priority: 11 });
  db.upsertUserGym(uid, 'jab-boxing', { display_name: 'JAB Side', priority: 22 });
  db.setStudioPreference(uid, 'mock-room-BOXING', { preferredSlots: ['a'] }, 'jab-boxing');

  const detail = db.runWithGymContext(uid, 'jab-boxing', () => db.getUserDetail(uid));
  assert.strictEqual(detail.user.display_name, 'JAB Side', 'the requested gym\'s own link data, not the default');
  assert.strictEqual(detail.user.priority, 22);
  assert.deepStrictEqual(
    detail.gyms.map((g) => g.gym_id).sort(),
    ['jab-boxing', 'psycle-london'],
    'the picker needs the full linked-gym list regardless of which one is being viewed',
  );

  // And the default resolution is unaffected outside the context (no leak).
  assert.strictEqual(db.getUserDetail(uid).user.display_name, 'Psycle Side');
});

check('isGymLinked is the gate the route uses to validate ?gymId= before trusting it', () => {
  const uid = db.createUser(`picker-c-${Date.now()}@test.local`, 'enc:pw');
  assert.strictEqual(db.isGymLinked(uid, 'jab-boxing'), false, 'not linked yet — the route must 403 this');
  db.linkGym(uid, 'jab-boxing', { encryptedPassword: 'enc:pw' });
  assert.strictEqual(db.isGymLinked(uid, 'jab-boxing'), true);
  assert.strictEqual(db.isGymLinked(uid, 'not-a-real-gym'), false);
});

check('the per-request context does not leak across users (admin viewing account B while resolving account A)', () => {
  const uidA = db.createUser(`picker-d1-${Date.now()}@test.local`, 'enc:pw');
  const uidB = db.createUser(`picker-d2-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(uidA, 'jab-boxing', { encryptedPassword: 'enc:pw' });

  db.runWithGymContext(uidA, 'jab-boxing', () => {
    assert.strictEqual(db.resolveActiveGymId(uidA), 'jab-boxing');
    assert.strictEqual(db.resolveActiveGymId(uidB), 'psycle-london',
      'a different account read inside the same request must resolve ITS OWN default, not uidA\'s requested gym');
  });
});

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-8: admin gym picker resolution\n');
  for (const { name, fn } of checks) {
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} admin-gym-picker checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} admin-gym-picker checks passed.`);
})();
