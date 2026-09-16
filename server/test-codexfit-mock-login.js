// CodexFit dev-login mock routing (QA-02).
//
// A fresh account links Psycle through provider.login(), before it has a
// session token. Guard that path as well as the direct adapter call: neither
// may reach the live CodexFit login endpoint for dev@psycle.com.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `codexfit-mock-login-${process.pid}.db`);
process.env.NODE_ENV = 'development';
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = 'codexfit-mock-login-test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

// Any call here would be a live HTTP request, because server/mock.js returns
// its Response-like object directly from provider.request().
const originalFetch = global.fetch;
let liveFetchCalls = 0;
global.fetch = async (url) => {
  liveFetchCalls++;
  throw new Error(`Unexpected live fetch during CodexFit mock login: ${url}`);
};

const { getProvider } = require('./providers');
const db = require('./db');
const auth = require('./auth');

async function run() {
  try {
    const provider = getProvider('psycle-london');
    const login = await provider.login({ email: 'dev@psycle.com', password: 'any-password' });
    assert.strictEqual(login.session.accessToken, 'mock-jwt-token');
    assert.strictEqual(login.profile.email, 'dev@psycle.com');
    assert.strictEqual(login.profile.firstName, 'Dev');
    assert.strictEqual(liveFetchCalls, 0, 'adapter login must not fetch the live Psycle API');

    await auth.handleSignup('fresh-codexfit-link@test.local', 'a-safe-password');
    const account = db.getUserByEmail('fresh-codexfit-link@test.local');
    const linked = await auth.linkGymAccount(
      account.id,
      'psycle-london',
      'dev@psycle.com',
      'any-password',
    );
    assert.strictEqual(linked.gym_id, 'psycle-london');
    assert.strictEqual(db.isGymLinked(account.id, 'psycle-london'), true);
    assert.strictEqual(JSON.parse(db.getUserGym(account.id, 'psycle-london').session_json).accessToken, 'mock-jwt-token');
    assert.strictEqual(liveFetchCalls, 0, 'linkGymAccount must use mock data without a live fetch');

    process.env.NODE_ENV = 'production';
    global.fetch = async (url) => {
      liveFetchCalls++;
      assert.strictEqual(url, 'https://psycle.codexfit.com/api/v1/customer/auth/login');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'production-response-token',
          user: { id: 1, email: 'dev@psycle.com', first_name: 'Production', last_name: 'Path' },
        }),
      };
    };
    const productionLogin = await provider.login({ email: 'dev@psycle.com', password: 'any-password' });
    assert.strictEqual(productionLogin.session.accessToken, 'production-response-token');
    assert.strictEqual(productionLogin.profile.firstName, 'Production');
    assert.strictEqual(liveFetchCalls, 1, 'production must use the real login branch, never the mock sentinel');

    console.log('✅ CodexFit dev login and fresh Psycle link use server/mock.js with zero live fetches; production uses the real login branch.');
  } finally {
    global.fetch = originalFetch;
    for (const file of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.unlinkSync(file); } catch (_) { /* absent is fine */ }
    }
  }
}

run().catch((err) => {
  console.error(`❌ ${err.stack || err.message}`);
  process.exit(1);
});
