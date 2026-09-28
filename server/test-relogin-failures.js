// C6-4 — background relogin failures are tracked per user AND gym, surfaced to
// the admin, and stop hitting the upstream gym after repeated credential
// rejections.
//
// Basis: auth.js triggerAutoRelogin() only set status 'needs_relogin' on
// failure. Nothing counted attempts, so (a) the admin could not tell a one-off
// blip from an account failing every minute, and (b) the scheduler/poller/
// calendar kept re-trying the stored credential on every 401 — with a bad
// password that is a steady stream of failed logins against the member's real
// gym account, which is how an upstream lockout happens.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const auth = require('./auth');
const { encrypt } = require('./crypto');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let seq = 0;
function user() {
  const uid = db.createUser(`relogin-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  db.upsertUserGym(uid, PSYCLE, { gym_email: 'p@test.local', encrypted_password: encrypt('pw-psycle') });
  db.linkGym(uid, JAB, { encryptedPassword: encrypt('pw-jab') });
  db.upsertUserGym(uid, JAB, { gym_email: 'j@test.local', priority: 200 });
  db.setGymSession(uid, PSYCLE, { accessToken: 'old-p', expiresAt: null });
  db.setGymSession(uid, JAB, { accessToken: 'old-j', expiresAt: null });
  return uid;
}
const link = (uid, gym) => db.getUserGymsPublic(uid).find((g) => g.gym_id === gym);

const origCf = CodexFitProvider.prototype.refreshSession;
const origMt = MarianaTekProvider.prototype.refreshSession;
let cfCalls = 0;
function stubCf(impl) { CodexFitProvider.prototype.refreshSession = async function (...a) { cfCalls++; return impl(...a); }; }
const reject = () => { throw new Error('Psycle rejected your login: bad password'); };
const outage = () => { throw new Error('fetch failed'); };
const ok = () => ({ accessToken: 'new-token' });
async function relogin(uid, gym) { try { return await auth.triggerAutoRelogin(uid, gym); } catch (e) { return e; } }

check('failures are counted per user AND gym, and reset on success', async () => {
  const uid = user(); cfCalls = 0;
  stubCf(reject);
  await relogin(uid, PSYCLE); await relogin(uid, PSYCLE);
  assert.strictEqual(link(uid, PSYCLE).relogin_failures, 2);
  assert.strictEqual(link(uid, JAB).relogin_failures, 0, 'the other gym is untouched');
  assert.ok(link(uid, PSYCLE).last_relogin_failure_at, 'timestamp recorded');
  assert.match(link(uid, PSYCLE).last_relogin_error, /rejected your login/);
  // A second user's same gym is independent too.
  const other = user();
  assert.strictEqual(link(other, PSYCLE).relogin_failures, 0);

  stubCf(ok);
  db.upsertUserGym(uid, PSYCLE, { status: 'active' });
  const token = await auth.triggerAutoRelogin(uid, PSYCLE);
  assert.strictEqual(token, 'new-token');
  assert.strictEqual(link(uid, PSYCLE).relogin_failures, 0, 'success resets the count');
  assert.strictEqual(link(uid, PSYCLE).relogin_rejections, 0);
  assert.strictEqual(link(uid, PSYCLE).last_relogin_error, null);
});

check('after N consecutive credential rejections the upstream gym is no longer contacted', async () => {
  const uid = user(); cfCalls = 0;
  stubCf(reject);
  for (let i = 0; i < auth.RELOGIN_MAX_REJECTIONS; i++) await relogin(uid, PSYCLE);
  assert.strictEqual(cfCalls, auth.RELOGIN_MAX_REJECTIONS);
  assert.strictEqual(link(uid, PSYCLE).relogin_suspended, 1, 'flagged suspended');

  const err = await relogin(uid, PSYCLE);
  assert.strictEqual(cfCalls, auth.RELOGIN_MAX_REJECTIONS, 'no further upstream login attempt');
  assert.strictEqual(err.code, 'GYM_SESSION_EXPIRED');
  assert.strictEqual(err.status, 401);
  assert.strictEqual(err.reloginSuspended, true);

  // Another gym on the same account still works.
  const origMtRefresh = MarianaTekProvider.prototype.refreshSession;
  MarianaTekProvider.prototype.refreshSession = async () => ({ accessToken: 'jab-new' });
  assert.strictEqual(await auth.triggerAutoRelogin(uid, JAB), 'jab-new');
  MarianaTekProvider.prototype.refreshSession = origMtRefresh;
});

check('a provider outage counts as a failure but never suspends retries', async () => {
  const uid = user(); cfCalls = 0;
  stubCf(outage);
  for (let i = 0; i < auth.RELOGIN_MAX_REJECTIONS + 3; i++) await relogin(uid, PSYCLE);
  assert.strictEqual(cfCalls, auth.RELOGIN_MAX_REJECTIONS + 3, 'still trying: an outage is not a bad password');
  assert.strictEqual(link(uid, PSYCLE).relogin_failures, auth.RELOGIN_MAX_REJECTIONS + 3);
  assert.strictEqual(link(uid, PSYCLE).relogin_suspended, 0);
});

check('re-linking with fresh credentials clears the count and the suspension', async () => {
  const uid = user(); cfCalls = 0;
  stubCf(reject);
  for (let i = 0; i < auth.RELOGIN_MAX_REJECTIONS; i++) await relogin(uid, PSYCLE);
  assert.strictEqual(link(uid, PSYCLE).relogin_suspended, 1);
  db.clearReloginFailures(uid, PSYCLE); // what linkGymAccount / resetGymCredentials call
  assert.strictEqual(link(uid, PSYCLE).relogin_failures, 0);
  assert.strictEqual(link(uid, PSYCLE).relogin_suspended, 0);
  cfCalls = 0;
  await relogin(uid, PSYCLE);
  assert.strictEqual(cfCalls, 1, 'retries resume after re-link');
});

check('admin user list is gym-aware: names each gym with failures, for accounts on any active gym', async () => {
  const uid = user();
  stubCf(reject);
  await relogin(uid, PSYCLE);
  MarianaTekProvider.prototype.refreshSession = async () => { throw new Error('JAB rejected your login: nope'); };
  for (let i = 0; i < auth.RELOGIN_MAX_REJECTIONS; i++) await relogin(uid, JAB);
  MarianaTekProvider.prototype.refreshSession = origMt;

  const row = db.getAllUsers().find((u) => u.id === uid);
  assert.ok(Array.isArray(row.relogin_issues), 'list rows carry relogin_issues');
  const byGym = Object.fromEntries(row.relogin_issues.map((i) => [i.gym_id, i]));
  assert.strictEqual(byGym[PSYCLE].failures, 1);
  assert.strictEqual(byGym[PSYCLE].suspended, false);
  assert.strictEqual(byGym[JAB].failures, auth.RELOGIN_MAX_REJECTIONS);
  assert.strictEqual(byGym[JAB].suspended, true);
  assert.ok(byGym[JAB].gym_name, 'gym named');

  const clean = user();
  assert.deepStrictEqual(db.getAllUsers().find((u) => u.id === clean).relogin_issues, [], 'healthy account -> empty');

  const detail = db.getUserDetail(uid);
  const g = detail.gyms.find((x) => x.gym_id === JAB);
  assert.strictEqual(g.relogin_failures, auth.RELOGIN_MAX_REJECTIONS);
  assert.strictEqual(g.relogin_suspended, 1);
});

(async () => {
  console.log('\n🧪 Background relogin failure tracking (C6-4)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  CodexFitProvider.prototype.refreshSession = origCf;
  if (failed) { console.error(`\n✗ ${failed}/${checks.length} failed`); process.exit(1); }
  console.log(`\n🎉 ${checks.length}/${checks.length} passed`);
  process.exit(0);
})();
