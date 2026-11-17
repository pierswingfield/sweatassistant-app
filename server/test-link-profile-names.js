// Link-time name capture. CodexFit's LIVE login response is { access_token } with no
// `user`, so a login-derived profile has no first/last name and onboarding could not
// prefill them (a brand-new account stored profile_json '{}'). linkGymAccount must read
// the enveloped /profile when the login profile lacks names, and must never fail the
// link because that read failed. The mock login mirrors the live shape (no names), so
// these checks go red if the extra read is removed.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const providers = require('./providers');
const provider = providers.getProvider('psycle-london');
const db = require('./db');
const testkit = require('./testkit');
const auth = require('./auth');
const gymsConfig = require('./gyms.config');

const MOCK_EMAIL = (gymsConfig.gyms || gymsConfig).find?.((g) => g.id === 'psycle-london')?.devMock?.email || 'dev@psycle.com';
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const uniq = (p) => `${p}-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}@test.local`;
const newUser = () => testkit.createUser(db, uniq('names'), 'encrypted-blob', 'jab-boxing');

check('mock login mirrors the live login: no names on the login-derived profile', async () => {
  const { profile } = await provider.login({ email: MOCK_EMAIL, password: 'x' });
  assert.ok(!profile.firstName && !profile.lastName, 'live login has no user, so no names');
  assert.deepStrictEqual(profile.raw, {});
});

check('link with a login profile lacking names stores the names read from /profile', async () => {
  const uid = newUser();
  const link = await auth.linkGymAccount(uid, 'psycle-london', MOCK_EMAIL, 'pw', true);
  assert.ok(link.first_name, 'first_name stored from /profile');
  assert.ok(link.last_name, 'last_name stored from /profile');
  assert.ok(link.display_name && link.display_name.includes(link.first_name));
});

check('a /profile failure still links, with null names', async () => {
  const uid = newUser();
  const orig = provider.getProfile;
  provider.getProfile = async () => { throw Object.assign(new Error('profile fetch failed: 500'), { status: 500 }); };
  try {
    const link = await auth.linkGymAccount(uid, 'psycle-london', MOCK_EMAIL, 'pw', true);
    assert.ok(link, 'link succeeded');
    assert.strictEqual(link.status, 'active');
    assert.ok(!link.first_name && !link.last_name && !link.display_name, 'names stay empty');
  } finally { provider.getProfile = orig; }
});

check('a login profile that already has names does not trigger a /profile read', async () => {
  const uid = newUser();
  const origLogin = provider.login; const origGet = provider.getProfile;
  let reads = 0;
  provider.login = async () => ({ session: { accessToken: 't1' }, profile: { firstName: 'Ada', lastName: 'Lovelace', raw: { first_name: 'Ada', last_name: 'Lovelace' } } });
  provider.getProfile = async () => { reads++; return {}; };
  try {
    const link = await auth.linkGymAccount(uid, 'psycle-london', 'a@test.local', 'pw', false);
    assert.strictEqual(link.first_name, 'Ada');
    assert.strictEqual(reads, 0);
  } finally { provider.login = origLogin; provider.getProfile = origGet; }
});

(async () => {
  console.log('\n🧪 Link-time profile names\n');
  let failed = 0, passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (err) { failed++; console.error(`❌ ${name}\n   ${err.stack || err.message}`); }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
