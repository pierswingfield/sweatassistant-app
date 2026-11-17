// Header gyms: POST /api/calendar/enable|disable returned 500 "no gym specified" on a
// two-gym account. The routes read the MERGED settings blob (account keys plus the
// default gym's gym-scoped keys) and wrote all of it back, so setUserSettings saw
// gym-scoped keys and, with two gyms and no gym named, refused to guess.
// `calendar` is account-scoped, so the routes must write `{ calendar }` only.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-headergyms.db');
let child;

function cleanup() {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
}

async function run() {
  cleanup();
  child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
  const post = (p, body, t) => fetch(`${BASE}${p}`, { method: 'POST', headers: H(t), body: JSON.stringify(body) });
  const get = async (p, t) => (await fetch(`${BASE}${p}`, { headers: H(t) })).json();

  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  const link = await post('/api/my-gyms/link', { gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }, t);
  assert.strictEqual(link.status, 200, await link.text());
  const put = (v) => fetch(`${BASE}/api/settings`, { method: 'PUT', headers: H(t), body: JSON.stringify({ headerGyms: v }) });
  assert.strictEqual((await get('/api/settings', t)).headerGyms, undefined, 'unset by default (client defaults to auto)');
  let r = await put('sideways');
  assert.strictEqual(r.status, 400, 'invalid value rejected');
  assert.strictEqual((await r.json()).code, 'INVALID_SETTING');
  for (const v of ['always', 'never', 'auto']) {
    r = await put(v);
    assert.strictEqual(r.status, 200, `${v} accepted on a two-gym account (account-scoped, no gym named)`);
    assert.strictEqual((await get('/api/settings', t)).headerGyms, v, `${v} round-trips`);
  }
  await put('never');
  for (const gym of ['psycle-london', 'jab-boxing']) {
    const s = await (await fetch(`${BASE}/api/settings`, { headers: { ...H(t), 'x-gym-id': gym } })).json();
    assert.strictEqual(s.headerGyms, 'never', `same value seen from ${gym}`);
  }
  assert.strictEqual((await get('/api/config/export', t)).accountSettings.headerGyms, 'never', 'in export');
  console.log('header gyms setting validated, account-scoped');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 headerGyms setting\n');
  try { await run(); console.log('\n🎉 headerGyms PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ headerGyms FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
