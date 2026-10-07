// The app account identity + gym linking (WP-C2 slice 1b, Decision D4).
//
// Until D4, an app login WAS a gym login: `users.email` plus the gym's
// password, re-verified against CodexFit on every sign-in. That meant the account
// only existed as long as the membership did — cancel Psycle and you lose JAB too.
//
// The legacy "log in with your gym password, get migrated" path is GONE (the
// database was recreated, so nothing needs migrating): an account exists only via
// signup, logs in with its own password, and links gyms explicitly.
//
// The gym provider is stubbed — these tests must never touch a real CodexFit or
// MarianaTek server (AGENT_INSTRUCTIONS.md Golden Rule 8).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');

// --- stub the provider BEFORE auth.js captures getProvider at require time ----
const providers = require('./providers');
const GYM_PASSWORD = 'gym-password-123';
let providerLoginCalls = 0;

const fakeProvider = {
  async login({ email, password }) {
    providerLoginCalls++;
    if (password !== GYM_PASSWORD) {
      const err = new Error('Invalid credentials');
      err.status = 401;
      throw err;
    }
    return {
      session: { accessToken: 'stub-access-token', expiresAt: null },
      profile: { firstName: 'Test', lastName: 'User', raw: { id: 4242, email, first_name: 'Test', last_name: 'User' } },
      raw: { access_token: 'stub-access-token', user: { id: 4242, email, first_name: 'Test', last_name: 'User' } },
    };
  },
};
providers.getProvider = () => fakeProvider;

const db = require('./db');
const testkit = require('./testkit');
const auth = require('./auth');

db.db.prepare("UPDATE gyms SET enabled = 1 WHERE id = 'jab-boxing'").run();

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const uniq = (p) => `${p}-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}@test.local`;

// --- 1. the app login: its own credential, no gym fallback, no implicit accounts --

const APP_PASSWORD = 'my-app-password-1';

check('an account with no app password cannot log in, and the gym is never asked', async () => {
  const email = uniq('nopw');
  const uid = testkit.createUser(db, email, 'encrypted-blob');   // gym-linked, no password_hash
  assert.strictEqual(db.hasAccountPassword(uid), false, 'precondition');
  const before = providerLoginCalls;
  await assert.rejects(() => auth.handleLogin(email, GYM_PASSWORD), /invalid email or password/i);
  assert.strictEqual(providerLoginCalls, before, 'no gym-login fallback');
  assert.strictEqual(db.hasAccountPassword(uid), false, 'and a failed login never seeds a password');
});

check('an unknown email is rejected, creates nothing, and never reaches a gym', async () => {
  const email = uniq('ghost');
  const before = providerLoginCalls;
  await assert.rejects(() => auth.handleLogin(email, GYM_PASSWORD), /invalid email or password/i);
  assert.strictEqual(providerLoginCalls, before, 'the old bootstrap sent new emails to a default gym');
  assert.strictEqual(db.getUserByEmail(email), undefined, 'signup is the only way an account is created');
});

check('an app login authenticates locally, WITHOUT touching the gym', async () => {
  const email = uniq('local');
  await auth.handleSignup(email, APP_PASSWORD);
  const before = providerLoginCalls;
  const result = await auth.handleLogin(email, APP_PASSWORD);
  assert.ok(result.token);
  assert.strictEqual(providerLoginCalls, before,
    'no gym round-trip — login stays up even when the gym API is down or the membership lapsed');
});

check('a wrong password is rejected and does NOT fall back to the gym', async () => {
  const email = uniq('wrongpw');
  const { token } = await auth.handleSignup(email, APP_PASSWORD);
  assert.ok(token);
  const uid = db.getUserByEmail(email).id;
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);
  const before = providerLoginCalls;
  await assert.rejects(() => auth.handleLogin(email, GYM_PASSWORD), /invalid email or password/i);
  assert.strictEqual(providerLoginCalls, before,
    'falling back to gym auth would let a gym password act as the app password');
});

check('changing the app password stops the old one working', async () => {
  const email = uniq('changed');
  await auth.handleSignup(email, APP_PASSWORD);
  const uid = db.getUserByEmail(email).id;
  db.setAccountPassword(uid, 'my-new-app-password');
  await assert.rejects(() => auth.handleLogin(email, APP_PASSWORD),
    /invalid email or password/i, 'the old password must stop working, or the change was decorative');
  const ok = await auth.handleLogin(email, 'my-new-app-password');
  assert.ok(ok.token, 'and the new one works');
});

// --- 2. linking a second gym -------------------------------------------------

check('linkGymAccount stores credentials only after the provider accepts them', async () => {
  const email = uniq('link');
  const uid = testkit.createUser(db, email, 'encrypted-blob');
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);

  assert.strictEqual(db.isGymLinked(uid, 'jab-boxing'), true);
  const link = db.getUserGym(uid, 'jab-boxing');
  assert.ok(link.encrypted_password, 'credential stored');
  assert.ok(!String(link.encrypted_password).includes(GYM_PASSWORD), 'and encrypted, not plaintext');
  assert.ok(JSON.parse(link.session_json).accessToken, 'session stored for the auto-relogin ladder');
});

check('a rejected credential does not overwrite a working link', async () => {
  const email = uniq('noclobber');
  const uid = testkit.createUser(db, email, 'encrypted-blob');
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);
  const good = db.getUserGym(uid, 'jab-boxing').encrypted_password;

  await assert.rejects(() => auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', 'wrong'));
  assert.strictEqual(db.getUserGym(uid, 'jab-boxing').encrypted_password, good,
    'a failed re-auth must leave the previously working credential intact');
});

check('re-authenticating preserves priority tier and calendar token', async () => {
  const email = uniq('reauth');
  const uid = testkit.createUser(db, email, 'encrypted-blob');
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);
  db.upsertUserGym(uid, 'jab-boxing', { priority: 10, calendar_token: `tok-${Date.now()}` });
  const beforeLink = db.getUserGym(uid, 'jab-boxing');

  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);
  const after = db.getUserGym(uid, 'jab-boxing');
  assert.strictEqual(after.priority, 10, 're-auth must not silently demote a priority tier');
  assert.strictEqual(after.calendar_token, beforeLink.calendar_token, 'nor break a published feed URL');
});

check('linking refuses an unknown or not-yet-enabled gym', async () => {
  const uid = testkit.createUser(db, uniq('gated'), 'encrypted-blob');
  await assert.rejects(() => auth.linkGymAccount(uid, 'no-such-gym', 'a@b.c', GYM_PASSWORD), /Unknown gym/i);
  db.db.prepare("UPDATE gyms SET enabled = 0 WHERE id = 'jab-boxing'").run();
  try {
    await assert.rejects(() => auth.linkGymAccount(uid, 'jab-boxing', 'a@b.c', GYM_PASSWORD), /not available/i);
  } finally {
    db.db.prepare("UPDATE gyms SET enabled = 1 WHERE id = 'jab-boxing'").run();
  }
});

check('two gyms can be linked; each resolves via request context, not a stored choice', async () => {
  const email = uniq('twogyms');
  const uid = testkit.createUser(db, email, 'encrypted-blob');
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);

  const gyms = db.getUserGymsPublic(uid).map((g) => g.gym_id).sort();
  assert.deepStrictEqual(gyms, ['jab-boxing', 'psycle-london']);
  assert.strictEqual(db.resolveActiveGymId(uid), 'psycle-london', 'the earliest link wins with no per-request gym named');
  // No more setActiveGym/persisted choice (removed 2026-09-15, stage 4 of the
  // active-gym audit) — a real request names its gym via the `x-gym-id`
  // header, which `runWithGymContext` stands in for here.
  db.runWithGymContext(uid, 'jab-boxing', () => {
    assert.strictEqual(db.resolveActiveGymId(uid), 'jab-boxing');
    assert.strictEqual(db.getUserById(uid).gym_id, 'jab-boxing',
      'and the whole session/credential merge follows the request gym');
  });
});

check('unlinking Psycle leaves a working JAB-only account (the D4 scenario, end to end)', async () => {
  const email = uniq('cancelled');
  await auth.handleSignup(email, APP_PASSWORD);
  const uid = db.getUserByEmail(email).id;
  await auth.linkGymAccount(uid, 'psycle-london', 'psy@test.local', GYM_PASSWORD);
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);

  auth.unlinkGymAccount(uid, 'psycle-london');                       // membership cancelled

  assert.deepStrictEqual(db.getUserGymsPublic(uid).map((g) => g.gym_id), ['jab-boxing']);
  assert.strictEqual(db.resolveActiveGymId(uid), 'jab-boxing', 'resolution follows to the surviving gym');
  const login = await auth.handleLogin(email, APP_PASSWORD);
  assert.ok(login.token, 'and the account still logs in with its own password');
});

// --- 3. signup: an account that never had a gym ------------------------------

check('signup creates an account with a password and NO gym linked', async () => {
  const email = uniq('signup');
  const before = providerLoginCalls;
  const result = await auth.handleSignup(email, 'a-real-password');
  assert.ok(result.token, 'issues a session immediately');
  assert.strictEqual(result.needsGym, true, 'and tells the client to go link a gym');
  assert.strictEqual(providerLoginCalls, before, 'signup must not touch any gym');

  const uid = db.getUserByEmail(email).id;
  assert.deepStrictEqual(db.getUserGyms(uid), [], 'no gym link — this is the D4 shape');
  assert.strictEqual(db.verifyAccountPassword(uid, 'a-real-password'), true);
});

check('a signed-up account can log in before it has any gym', async () => {
  const email = uniq('signup-login');
  await auth.handleSignup(email, 'a-real-password');
  const login = await auth.handleLogin(email, 'a-real-password');
  assert.ok(login.token, 'login works with zero gyms linked');
});

check('signup rejects a duplicate email, a bad address, and a short password', async () => {
  const email = uniq('dupe');
  await auth.handleSignup(email, 'a-real-password');
  await assert.rejects(() => auth.handleSignup(email, 'another-password'), /already exists/i);
  await assert.rejects(() => auth.handleSignup('not-an-email', 'a-real-password'), /valid email/i);
  await assert.rejects(() => auth.handleSignup(uniq('short'), 'abc'), /at least 8/i);
});

check('signup then link produces exactly the same shape as a migrated account', async () => {
  const email = uniq('signup-link');
  await auth.handleSignup(email, 'a-real-password');
  const uid = db.getUserByEmail(email).id;
  await auth.linkGymAccount(uid, 'psycle-london', 'gym@test.local', GYM_PASSWORD);
  assert.strictEqual(db.isGymLinked(uid, 'psycle-london'), true);
  assert.strictEqual(db.resolveActiveGymId(uid), 'psycle-london');
  assert.ok(db.getUserById(uid).encrypted_password, 'credential resolves through user_gyms');
});

// --- 4. recovery -------------------------------------------------------------
//
// The gym-login-as-recovery-credential mechanism was REMOVED 2026-08-31 (it
// re-coupled the account to the gym, defeating Decision D4), so its tests are
// gone with it. What survives is the credential-reset primitive any replacement
// will still need, plus a guard that the removed surface stays removed.

check('the gym-login recovery surface is gone, not merely unrouted', () => {
  for (const fn of ['getRecoveryOptions', 'completeRecovery']) {
    assert.strictEqual(typeof auth[fn], 'undefined',
      `auth.${fn} must not come back without a deliberate decision — see Documentation/Workstreams/C6-accounts-auth.md`);
  }
});

check('resetGymCredentials clears every credential but keeps the links', async () => {
  const email = uniq('reset-all');
  const uid = testkit.createUser(db, email, 'encrypted-blob');
  await auth.linkGymAccount(uid, 'psycle-london', 'gym@test.local', GYM_PASSWORD);
  await auth.linkGymAccount(uid, 'jab-boxing', 'jab@test.local', GYM_PASSWORD);
  db.upsertUserGym(uid, 'jab-boxing', { ...db.getUserGym(uid, 'jab-boxing'), priority: 10 });

  const reset = db.resetGymCredentials(uid);
  assert.deepStrictEqual(reset.sort(), ['jab-boxing', 'psycle-london'],
    'with no gym proven in the flow, recovery resets ALL of them');

  for (const gymId of ['psycle-london', 'jab-boxing']) {
    const link = db.getUserGym(uid, gymId);
    assert.strictEqual(link.encrypted_password, null, `${gymId}: credential cleared`);
    assert.strictEqual(link.session_json, null, `${gymId}: session cleared`);
    assert.strictEqual(link.status, 'needs_relogin', `${gymId}: flagged for re-auth`);
    assert.ok(db.isGymLinked(uid, gymId), `${gymId}: the link itself survives`);
  }
  assert.strictEqual(db.getUserGym(uid, 'jab-boxing').priority, 10,
    'and the priority tier is not lost — the user re-authenticates, they are not re-created');
});

// --- runner ------------------------------------------------------------------

(async () => {
  console.log('\n🧪 Account identity + gym linking (WP-C2 slice 1b)\n');
  let failed = 0, passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (err) { failed++; console.error(`❌ ${name}\n   ${err.message}`); }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} identity checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
