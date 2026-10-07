// Active-gym resolution tests (WP-C2 slice 1a; revised 2026-09-15 for stage 4
// of the active-gym audit — Documentation/Archive/2026-09-26/Backlog/active-gym-audit.md).
//
// resolveActiveGymId() used to be a two-line stub returning DEFAULT_GYM_ID. It is
// called from ~10 places inside db.js — every auth, session, credential, priority
// and calendar-token read — so getting it wrong doesn't produce a wrong page, it
// produces the WRONG ACCOUNT'S SESSION. Pinned here:
//
//   1. It is a no-op for every account that exists today (all single-gym).
//   2. The `x-gym-id` header can never select a gym the account isn't linked to,
//      and never leaks across users inside one request (the admin-reads-another-
//      account case).
//   3. There is no persisted "choice" any more. `setActiveGym`/`getActiveGymId`/
//      `POST /api/my-gyms/active` were removed — the switcher they served was
//      already gone, and every real write now names its own gym explicitly.
//      A multi-gym account with no per-request gym resolves to the DEFAULT
//      gym, deterministically, every time — never a remembered one.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');
const auth = require('./auth');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const DEFAULT_GYM = 'psycle-london';
const OTHER_GYM = 'jab-boxing';

// jab-boxing ships `enabled: false` (the WP-T4 rollout gate, now enforced only
// at LINK time). Enable it in the test DB so the multi-gym paths below exercise
// what a real second gym does once the gate lifts.
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(OTHER_GYM);

function makeUser(email) {
  const id = db.createUser(email, 'enc:' + email);
  return typeof id === 'object' ? id.id : id;
}

// --- 1. behaviour-preservation for existing accounts -------------------------

check('a single-gym account resolves to its one gym, with no stored choice', () => {
  const uid = makeUser(`solo-${Date.now()}@test.local`);
  const links = db.getUserGyms(uid);
  assert.strictEqual(links.length, 1, 'createUser links exactly one gym (the D3 bootstrap)');
  assert.strictEqual(links[0].gym_id, DEFAULT_GYM);
  assert.strictEqual(db.resolveActiveGymId(uid), DEFAULT_GYM,
    'no stored choice + one link = that link — the pre-WP-C2 behaviour exactly');
});

check('getUserById still resolves the default gym for a single-gym account', () => {
  const uid = makeUser(`merge-${Date.now()}@test.local`);
  const user = db.getUserById(uid);
  assert.strictEqual(user.gym_id, DEFAULT_GYM, 'mergeUserWithGym resolved the right link');
  assert.strictEqual(user.encrypted_password, 'enc:' + user.email,
    'and read the credential from user_gyms, not a stale users column');
});

check('an unknown user id degrades to the default gym rather than throwing', () => {
  assert.strictEqual(db.resolveActiveGymId(999999), DEFAULT_GYM);
  assert.strictEqual(db.resolveActiveGymId(null), DEFAULT_GYM);
});

// --- 2. no stored choice any more (removed 2026-09-15, stage 4) -------------
//
// `setActiveGym`/`getActiveGymId`/`POST /api/my-gyms/active` are gone: the
// client switcher they served was already deleted, and every real write now
// names its own gym explicitly (stages 1-3). `resolveActiveGymId` on a
// multi-gym account with no per-request gym now falls straight to the
// deterministic default — never a remembered choice.

check('two links, no per-request gym → the default gym wins deterministically', () => {
  const uid = makeUser(`switch-${Date.now()}@test.local`);
  db.linkGym(uid, OTHER_GYM);
  assert.strictEqual(db.resolveActiveGymId(uid), DEFAULT_GYM,
    'not "first alphabetically", not a remembered choice — the same answer every time');
});

// --- 3. the per-request context ----------------------------------------------

check('request context overrides the default for the duration of the request', () => {
  const uid = makeUser(`ctx-${Date.now()}@test.local`);
  db.linkGym(uid, OTHER_GYM);

  db.runWithGymContext(uid, OTHER_GYM, () => {
    assert.strictEqual(db.resolveActiveGymId(uid), OTHER_GYM, 'header wins inside the request');
    assert.strictEqual(db.getUserById(uid).gym_id, OTHER_GYM, 'and flows through mergeUserWithGym');
  });
  assert.strictEqual(db.resolveActiveGymId(uid), DEFAULT_GYM, 'and does not leak past the request');
});

check('request context does NOT leak across users (the admin-reads-another-account case)', () => {
  const admin = makeUser(`admin-${Date.now()}@test.local`);
  const victim = makeUser(`victim-${Date.now()}@test.local`);
  db.linkGym(admin, OTHER_GYM);

  db.runWithGymContext(admin, OTHER_GYM, () => {
    assert.strictEqual(db.resolveActiveGymId(admin), OTHER_GYM, 'the requester gets their own gym');
    assert.strictEqual(db.resolveActiveGymId(victim), DEFAULT_GYM,
      "another account read inside the same request must resolve ITS OWN gym, not the requester's");
    assert.strictEqual(db.getUserById(victim).gym_id, DEFAULT_GYM);
  });
});

check('context survives an await boundary (handlers are async)', async () => {
  const uid = makeUser(`async-${Date.now()}@test.local`);
  db.linkGym(uid, OTHER_GYM);
  await db.runWithGymContext(uid, OTHER_GYM, async () => {
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(db.resolveActiveGymId(uid), OTHER_GYM,
      'AsyncLocalStorage must carry the gym across the awaits a real handler does');
  });
});

check('background work (no context, several links) resolves deterministically', () => {
  const uid = makeUser(`bg-${Date.now()}@test.local`);
  db.linkGym(uid, OTHER_GYM);
  // No runWithGymContext — this is what the scheduler/poller cron sees. With no
  // stored choice to fall back to any more, this is the default gym, always —
  // never a remembered "last selected" one, since that concept is gone.
  assert.strictEqual(db.resolveActiveGymId(uid), DEFAULT_GYM);
});

check('WP-T4 rollout gate: linking a DISABLED gym is refused', () => {
  // `setActiveGym`'s own enabled-check is gone with it, but the rollout gate
  // still has to live somewhere — it is now enforced only at LINK time
  // (linkGymAccount), which was untested on its own before this rewrite.
  const uid = makeUser(`gated-${Date.now()}@test.local`);
  db.db.prepare('UPDATE gyms SET enabled = 0 WHERE id = ?').run(OTHER_GYM);
  try {
    assert.rejects(() => auth.linkGymAccount(uid, OTHER_GYM, 'x@test.local', 'irrelevant'), /not available/i);
  } finally {
    db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(OTHER_GYM);
  }
});

check('disabling a gym does NOT silently move an account already on it', () => {
  const uid = makeUser(`ongated-${Date.now()}@test.local`);
  db.linkGym(uid, OTHER_GYM);
  db.db.prepare('UPDATE gyms SET enabled = 0 WHERE id = ?').run(OTHER_GYM);
  try {
    // Deliberate: resolveActiveGymId does not consult `enabled`. Falling back
    // would silently serve a DIFFERENT gym's bookings and credentials than a
    // request explicitly asked for — worse than surfacing an error at provider
    // construction. The gate belongs at link time, not resolution time.
    // (There is no more "selection" to disable-out-from-under; this now
    // exercises the request-context path, the surviving way to be resolved
    // onto a specific linked gym.)
    db.runWithGymContext(uid, OTHER_GYM, () => {
      assert.strictEqual(db.resolveActiveGymId(uid), OTHER_GYM);
    });
  } finally {
    db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(OTHER_GYM);
  }
});

// --- 4. isGymLinked, the authorisation primitive -----------------------------

check('isGymLinked is the boundary the x-gym-id header is checked against', () => {
  const uid = makeUser(`linked-${Date.now()}@test.local`);
  assert.strictEqual(db.isGymLinked(uid, DEFAULT_GYM), true);
  assert.strictEqual(db.isGymLinked(uid, OTHER_GYM), false);
  assert.strictEqual(db.isGymLinked(uid, 'not-a-real-gym'), false);
  assert.strictEqual(db.isGymLinked(uid, null), false);
  assert.strictEqual(db.isGymLinked(uid, undefined), false);
  db.linkGym(uid, OTHER_GYM);
  assert.strictEqual(db.isGymLinked(uid, OTHER_GYM), true);
});

// --- 5. The app account identity (Decision D4) -----------------------
//
// The SA credential is what makes the account survive a cancelled membership.
// The migration path matters most: every existing account has password_hash NULL
// and must keep working, then silently gain an SA password on next login.

check('a fresh account starts with no SA password (legacy shape)', () => {
  const uid = makeUser(`nopw-${Date.now()}@test.local`);
  assert.strictEqual(db.hasAccountPassword(uid), false);
  assert.strictEqual(db.verifyAccountPassword(uid, 'anything'), false,
    'and verification of a non-existent password is false, never true-by-default');
});

check('setAccountPassword hashes; the plaintext is never stored', () => {
  const uid = makeUser(`hash-${Date.now()}@test.local`);
  db.setAccountPassword(uid, 'correct-horse-battery');
  const row = db.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid);
  assert.ok(row.password_hash.startsWith('scrypt$'), 'stored in the versioned scrypt format');
  assert.ok(!row.password_hash.includes('correct-horse-battery'), 'plaintext must not appear');
  assert.strictEqual(db.verifyAccountPassword(uid, 'correct-horse-battery'), true);
  assert.strictEqual(db.verifyAccountPassword(uid, 'Correct-horse-battery'), false, 'case sensitive');
  assert.strictEqual(db.verifyAccountPassword(uid, ''), false);
  assert.strictEqual(db.verifyAccountPassword(uid, null), false);
});

check('each account gets its own salt — identical passwords hash differently', () => {
  const a = makeUser(`salt-a-${Date.now()}@test.local`);
  const b = makeUser(`salt-b-${Date.now()}@test.local`);
  db.setAccountPassword(a, 'the-same-password');
  db.setAccountPassword(b, 'the-same-password');
  const ha = db.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(a).password_hash;
  const hb = db.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(b).password_hash;
  assert.notStrictEqual(ha, hb, 'salted — two accounts sharing a password must not share a hash');
  assert.ok(db.verifyAccountPassword(a, 'the-same-password') && db.verifyAccountPassword(b, 'the-same-password'));
});

check('a corrupt or truncated hash verifies false rather than throwing', () => {
  const uid = makeUser(`corrupt-${Date.now()}@test.local`);
  for (const bad of ['', 'garbage', 'scrypt$only$four$parts', 'bcrypt$1$2$3$4$5']) {
    db.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bad, uid);
    assert.strictEqual(db.verifyAccountPassword(uid, 'whatever'), false, `bad hash: ${JSON.stringify(bad)}`);
  }
});

check('setAccountPassword refuses a password too short to be worth hashing', () => {
  const uid = makeUser(`short-${Date.now()}@test.local`);
  assert.throws(() => db.setAccountPassword(uid, 'short'), /at least 8/i);
  assert.strictEqual(db.hasAccountPassword(uid), false, 'and leaves the account unchanged');
});

// --- 6. unlinking ------------------------------------------------------------

check('unlinkGym removes the link but keeps the account (the D4 promise)', () => {
  const uid = makeUser(`unlink-${Date.now()}@test.local`);
  db.linkGym(uid, OTHER_GYM);
  db.unlinkGym(uid, OTHER_GYM);
  assert.ok(db.getUserById(uid), 'the app account still exists');
  assert.strictEqual(db.isGymLinked(uid, OTHER_GYM), false);
  assert.strictEqual(db.resolveActiveGymId(uid), DEFAULT_GYM,
    'and resolution falls back rather than pointing at a dead link');
});

check('unlinking the LAST gym is allowed — the account outlives the membership', () => {
  const uid = makeUser(`last-${Date.now()}@test.local`);
  db.setAccountPassword(uid, 'survives-the-gym');
  db.unlinkGym(uid, DEFAULT_GYM);
  assert.deepStrictEqual(db.getUserGyms(uid), [], 'no gyms left');
  assert.ok(db.getUserById(uid), 'account survives');
  assert.strictEqual(db.verifyAccountPassword(uid, 'survives-the-gym'), true,
    'and can still log in — cancelling a membership must not cost you the account');
});

// --- runner ------------------------------------------------------------------

(async () => {
  console.log('\n🧪 Active-gym resolution (WP-C2 slice 1a)\n');
  let failed = 0, passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (err) { failed++; console.error(`❌ ${name}\n   ${err.message}`); }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} active-gym checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
