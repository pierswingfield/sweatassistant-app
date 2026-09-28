// C3-28: resolveContext fell back to the ambient default gym when a request had no
// `x-gym-id`, so on a two-gym account a call that forgot its gym was answered for
// whichever gym the server happens to default to. Now: 400 GYM_REQUIRED for a
// multi-gym account, unchanged for a single-gym one, and an explicit gym works.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3093;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-gymreq.db');
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};

async function run() {
  cleanup();
  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const H = (t, g) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}`, ...(g ? { 'x-gym-id': g } : {}) });
  const get = async (p, t, g) => { const r = await fetch(`${BASE}${p}`, { headers: H(t, g) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  const gyms = async () => (await get('/api/my-gyms', t)).body.gyms.map((g) => g.gym_id);

  // Single gym: no header is fine (unambiguous).
  if ((await gyms()).includes('jab-boxing')) await fetch(`${BASE}/api/my-gyms/jab-boxing`, { method: 'DELETE', headers: H(t) });
  assert.deepStrictEqual(await gyms(), ['psycle-london']);
  for (const p of ['/api/profile', '/api/credits', '/api/eligibility']) {
    assert.strictEqual((await get(p, t)).status, 200, `single gym, no header: ${p}`);
  }

  // Two gyms: no header is refused, an explicit gym is answered.
  await fetch(`${BASE}/api/my-gyms/link`, { method: 'POST', headers: H(t),
    body: JSON.stringify({ gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }) });
  assert.strictEqual((await gyms()).length, 2);
  for (const p of ['/api/profile', '/api/credits', '/api/eligibility', '/api/bookings', '/api/waitlists', '/api/metadata', '/api/timetable']) {
    const r = await get(p, t);
    assert.strictEqual(r.status, 400, `two gyms, no header: ${p} -> ${r.status}`);
    assert.strictEqual(r.body.code, 'GYM_REQUIRED', p);
    for (const g of ['psycle-london', 'jab-boxing']) {
      const ok = await get(p, t, g);
      assert.strictEqual(ok.status, 200, `two gyms, x-gym-id ${g}: ${p} -> ${ok.status}`);
    }
  }
  console.log('✅ Gym-scoped routes require an explicit gym on multi-gym accounts.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-28: gym required on multi-gym accounts\n');
  try { await run(); console.log('\n🎉 C3-28 PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ C3-28 FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
