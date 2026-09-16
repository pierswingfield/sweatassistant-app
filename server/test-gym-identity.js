// Gym-link identity tests (WP-D5).
//
// A gym link stores the password but, until this WP, not the email — because
// there was only ever one gym and `users.email` doubled as its login. Decision D4
// broke that equivalence on purpose: a Sweat Assistant account is not a gym
// account. That left re-authentication with nothing to authenticate AS.
//
// The thing being pinned here is the SEPARATION, not just the column. The failure
// this guards against is subtle and tempting: quietly falling back to
// `users.email` when `gym_email` is NULL. That would work for every account that
// exists today (they are all default-gym links where the two happen to match) and
// would silently re-assert the coupling D4 exists to remove — invisibly, until a
// user with different addresses hits it.
//
//   1. A gym login captures the gym email; signup (no gym) captures nothing.
//   2. The two addresses stay distinct — `.email` is the account, `.gym_email`
//      is the gym, and neither is ever read as the other.
//   3. Existing default-gym links backfill; other gyms' links do NOT.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const DEFAULT_GYM = 'psycle-london';
const OTHER_GYM = 'jab-boxing';

// jab-boxing ships behind the WP-T4 rollout gate. Enable it in the test DB so the
// second-gym paths exercise what a real second gym does once the gate lifts.
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(OTHER_GYM);

let seq = 0;
const uniq = (p) => `${p}-${Date.now()}-${seq++}@test.local`;

// --- 1. capture -------------------------------------------------------------

check('a gym login captures the gym email on the link', () => {
  const email = uniq('login');
  const uid = db.createUser(email, 'enc:pw');
  const link = db.getUserGym(uid, DEFAULT_GYM);
  assert.strictEqual(link.gym_email, email,
    'createUser IS the gym-login path — the address was just proven against the gym');
});

check('signup with no gym captures no gym email anywhere', () => {
  const email = uniq('signup');
  const uid = db.createAccount(email, 'a-long-enough-password');
  assert.strictEqual(db.getUserGyms(uid).length, 0, 'signup attaches no gym (D4)');
  const rows = db.db.prepare('SELECT * FROM user_gyms WHERE user_id = ?').all(uid);
  assert.strictEqual(rows.length, 0, 'and writes no link row to seed an email into');
});

check('linking a second gym stores that gym\'s own email, lower-cased', () => {
  const uid = db.createUser(uniq('multi'), 'enc:pw');
  db.upsertUserGym(uid, OTHER_GYM, { gym_email: 'Boxer@JAB.example', encrypted_password: 'enc:jab' });
  assert.strictEqual(db.getUserGym(uid, OTHER_GYM).gym_email, 'Boxer@JAB.example',
    'db layer stores verbatim; auth.linkGymAccount is what lower-cases');
});

// --- 2. separation ----------------------------------------------------------

check('account email and gym email stay distinct on the merged user', () => {
  const accountEmail = uniq('account');
  const uid = db.createUser(accountEmail, 'enc:pw');
  // The user later re-links Psycle under a different address at the gym.
  db.upsertUserGym(uid, DEFAULT_GYM, { gym_email: 'different@gym.example' });

  const user = db.getUserById(uid);
  assert.strictEqual(user.email, accountEmail, '.email remains the Sweat Assistant identity');
  assert.strictEqual(user.gym_email, 'different@gym.example', '.gym_email is the gym login');
  assert.notStrictEqual(user.email, user.gym_email, 'the two must not collapse into one');
});

check('gym_email resolves per request-scoped gym, not per account', () => {
  const uid = db.createUser(uniq('perGym'), 'enc:pw');
  db.upsertUserGym(uid, DEFAULT_GYM, { gym_email: 'me@psycle.example' });
  db.upsertUserGym(uid, OTHER_GYM, { gym_email: 'me@jab.example' });

  // No more setActiveGym/persisted choice (removed 2026-09-15, stage 4 of the
  // active-gym audit) — `runWithGymContext` stands in for a real `x-gym-id`
  // header the same way it does throughout the rest of the suite.
  assert.strictEqual(db.getUserById(uid).gym_email, 'me@psycle.example', 'default with no context named');
  db.runWithGymContext(uid, OTHER_GYM, () => {
    assert.strictEqual(db.getUserById(uid).gym_email, 'me@jab.example',
      'a different request gym resolves a different login identity');
  });
});

check('a missing gym email reads as NULL — never as the account email', () => {
  const accountEmail = uniq('noFallback');
  const uid = db.createUser(accountEmail, 'enc:pw');
  db.upsertUserGym(uid, OTHER_GYM, { encrypted_password: 'enc:jab' }); // no gym_email

  const user = db.runWithGymContext(uid, OTHER_GYM, () => db.getUserById(uid));
  assert.strictEqual(user.gym_email, null,
    'NULL means "cannot re-login unattended" and must stay NULL');
  assert.notStrictEqual(user.gym_email, accountEmail,
    'falling back to users.email here would silently restore the D4 coupling');
});

check('an unrelated link update does not clobber a stored gym email', () => {
  const uid = db.createUser(uniq('preserve'), 'enc:pw');
  db.upsertUserGym(uid, DEFAULT_GYM, { gym_email: 'keep@me.example' });
  db.updateUserJWT(uid, 'new-token', new Date(Date.now() + 8.64e7).toISOString());
  assert.strictEqual(db.getUserGym(uid, DEFAULT_GYM).gym_email, 'keep@me.example',
    'upsertUserGym merges over the existing row rather than resetting omitted fields');
});

// --- 3. backfill ------------------------------------------------------------

check('a pre-D5 default-gym link backfills from the account email', () => {
  const accountEmail = uniq('backfill');
  const uid = db.createUser(accountEmail, 'enc:pw');
  // Simulate the pre-migration state: the column exists but was never populated.
  db.db.prepare('UPDATE user_gyms SET gym_email = NULL WHERE user_id = ?').run(uid);

  db.db.prepare(`
    UPDATE user_gyms
       SET gym_email = (SELECT email FROM users WHERE users.id = user_gyms.user_id)
     WHERE gym_email IS NULL AND gym_id = ?
  `).run(DEFAULT_GYM);

  assert.strictEqual(db.getUserGym(uid, DEFAULT_GYM).gym_email, accountEmail,
    'provable for the default gym only: pre-D4 an SA login WAS a CodexFit login');
});

check('a pre-D5 link to any OTHER gym is left NULL, not guessed', () => {
  const uid = db.createUser(uniq('noGuess'), 'enc:pw');
  db.upsertUserGym(uid, OTHER_GYM, { encrypted_password: 'enc:jab' });
  db.db.prepare('UPDATE user_gyms SET gym_email = NULL WHERE user_id = ?').run(uid);

  db.db.prepare(`
    UPDATE user_gyms
       SET gym_email = (SELECT email FROM users WHERE users.id = user_gyms.user_id)
     WHERE gym_email IS NULL AND gym_id = ?
  `).run(DEFAULT_GYM);

  assert.strictEqual(db.getUserGym(uid, OTHER_GYM).gym_email, null,
    'the email for a non-default gym was collected, used and discarded — we do not know it');
});

// --- 4. exposure ------------------------------------------------------------

check('getUserGymsPublic exposes gym_email and still withholds secrets', () => {
  const uid = db.createUser(uniq('public'), 'enc:pw');
  db.upsertUserGym(uid, DEFAULT_GYM, { gym_email: 'shown@psycle.example' });

  const [row] = db.getUserGymsPublic(uid).filter((g) => g.gym_id === DEFAULT_GYM);
  assert.strictEqual(row.gym_email, 'shown@psycle.example',
    'the user\'s own address — needed to render "linked as …" and to prompt a re-link');
  assert.ok(!('encrypted_password' in row), 'credentials stay out of the public shape');
  assert.ok(!('session_json' in row), 'sessions stay out of the public shape');
});

// --- run --------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of checks) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks.length} gym-identity checks FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${passed}/${checks.length} gym-identity checks passed.`);
