// C3-16: config export/import was gym-blind. Export emitted the MERGED settings
// blob and import wrote it back with no gym, so on a two-gym account import
// returned 500 "no gym specified", and on one gym it wrote whichever gym
// resolved. Now: account keys + a per-gym block, imported with explicit gymIds;
// an OLD flat export keeps working on a single-gym account and skips (with a
// message) its gym keys on a multi-gym one.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3096;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-cfgio.db');
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
  const req = async (method, p, t, body, g) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: H(t, g), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  const gyms = async () => (await req('GET', '/api/my-gyms', t)).body.gyms.map((g) => g.gym_id).sort();

  // dev login may already link JAB; normalise to exactly ONE gym first.
  if ((await gyms()).includes('jab-boxing')) await req('DELETE', '/api/my-gyms/jab-boxing', t);
  assert.deepStrictEqual(await gyms(), ['psycle-london'], 'fixture: single gym');

  // ---- single gym: an OLD flat export still imports, gym keys go to the sole gym
  let r = await req('POST', '/api/config/import', t, {
    version: '1.1.0',
    psycleSettings: { theme: 'dark', detectedBookingOffset: 17, prefetchWeeks: 3 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.skipped || [], [], 'nothing skipped on a single gym');
  let s = (await req('GET', '/api/settings', t)).body;
  assert.strictEqual(s.theme, 'dark');
  assert.strictEqual(s.detectedBookingOffset, 17, 'gym key landed on the sole gym');

  // ---- link JAB -> two gyms
  const link = await req('POST', '/api/my-gyms/link', t, { gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' });
  assert.strictEqual(link.status, 200, JSON.stringify(link.body));
  assert.deepStrictEqual(await gyms(), ['jab-boxing', 'psycle-london']);

  // ---- export shape: account keys + a per-gym block, each with its gymId
  await req('PUT', '/api/settings', t, { detectedBookingOffset: 21 }, 'jab-boxing');
  const exp = await req('GET', '/api/config/export', t);
  assert.strictEqual(exp.status, 200);
  assert.strictEqual(exp.body.accountSettings.theme, 'dark');
  assert.ok(!('detectedBookingOffset' in exp.body.accountSettings), 'account block holds no gym keys');
  const byGym = Object.fromEntries(exp.body.gymSettings.map((g) => [g.gymId, g.settings]));
  assert.strictEqual(byGym['psycle-london'].detectedBookingOffset, 17);
  assert.strictEqual(byGym['jab-boxing'].detectedBookingOffset, 21);

  // ---- new-format import on two gyms: each block lands on ITS gym
  r = await req('POST', '/api/config/import', t, {
    version: '1.2.0',
    accountSettings: { theme: 'light' },
    gymSettings: [
      { gymId: 'psycle-london', settings: { detectedBookingOffset: 5 } },
      { gymId: 'jab-boxing', settings: { detectedBookingOffset: 6 } },
      { gymId: 'not-linked-gym', settings: { detectedBookingOffset: 7 } },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.skipped.some((m) => /not-linked-gym/.test(m)), `unlinked gym block skipped with a message: ${JSON.stringify(r.body.skipped)}`);
  const after = Object.fromEntries((await req('GET', '/api/config/export', t)).body.gymSettings.map((g) => [g.gymId, g.settings]));
  assert.strictEqual(after['psycle-london'].detectedBookingOffset, 5);
  assert.strictEqual(after['jab-boxing'].detectedBookingOffset, 6);
  assert.strictEqual((await req('GET', '/api/config/export', t)).body.accountSettings.theme, 'light');

  // ---- OLD flat export on two gyms: account keys applied, gym keys skipped with a clear message, no 500
  r = await req('POST', '/api/config/import', t, { psycleSettings: { theme: 'dark', detectedBookingOffset: 99 } });
  assert.strictEqual(r.status, 200, `old flat blob on 2 gyms: ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body.skipped.length >= 1 && /detectedBookingOffset/.test(r.body.skipped.join(' ')), JSON.stringify(r.body.skipped));
  const after2 = await req('GET', '/api/config/export', t);
  assert.strictEqual(after2.body.accountSettings.theme, 'dark', 'account keys still applied');
  assert.strictEqual(Object.fromEntries(after2.body.gymSettings.map((g) => [g.gymId, g.settings]))['psycle-london'].detectedBookingOffset, 5, 'gym key NOT written anywhere');
  console.log('✅ Config export/import is per-gym; old flat exports import safely.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-16: config export/import per gym\n');
  try { await run(); console.log('\n🎉 C3-16 PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ C3-16 FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
