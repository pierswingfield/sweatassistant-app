// C3-14: POST /api/calendar/enable|disable returned 500 "no gym specified" on a
// two-gym account. The routes read the MERGED settings blob (account keys plus the
// default gym's gym-scoped keys) and wrote all of it back, so setUserSettings saw
// gym-scoped keys and, with two gyms and no gym named, refused to guess.
// `calendar` is account-scoped, so the routes must write `{ calendar }` only.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-calsettings.db');
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
  assert.strictEqual((await get('/api/my-gyms', t)).gyms.length, 2, 'fixture: two linked gyms');

  // Give the default gym a gym-scoped key so the merged blob really is mixed
  // (this is what a real account has after any gym-scoped save).
  const put = await fetch(`${BASE}/api/settings`, { method: 'PUT',
    headers: { ...H(t), 'x-gym-id': 'psycle-london' },
    body: JSON.stringify({ detectedBookingOffset: 15 }) });
  assert.strictEqual(put.status, 200, `fixture: gym-scoped save ${put.status} ${await put.text()}`);
  const seen = await get('/api/settings', t);
  assert.ok(seen && (seen.detectedBookingOffset === 15 || JSON.stringify(seen).includes('15')), 'fixture: gym key present in merged read');

  let r = await post('/api/calendar/enable', { includeTentative: true }, t);
  assert.strictEqual(r.status, 200, `enable on 2 gyms: ${r.status} ${await r.clone().text()}`);
  let st = await get('/api/calendar/status', t);
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.includeTentative, true, 'includeTentative persisted');

  r = await post('/api/calendar/enable', { includeTentative: false }, t);
  assert.strictEqual(r.status, 200, `toggle on 2 gyms: ${r.status}`);
  st = await get('/api/calendar/status', t);
  assert.strictEqual(st.includeTentative, false, 'toggle persisted');

  r = await post('/api/calendar/disable', {}, t);
  assert.strictEqual(r.status, 200, `disable on 2 gyms: ${r.status} ${await r.clone().text()}`);
  st = await get('/api/calendar/status', t);
  assert.strictEqual(st.enabled, false);
  console.log('✅ Calendar enable/toggle/disable work on a two-gym account and persist.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-14: calendar settings on a two-gym account\n');
  try { await run(); console.log('\n🎉 C3-14 PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ C3-14 FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
