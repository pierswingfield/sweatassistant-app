// C3-22: linking or unlinking a gym did not regenerate the calendar snapshot, so
// the .ics kept an unlinked gym's classes (or lacked a new gym's) until the
// 3-hourly cron. The link and unlink routes now regenerate it (and schedule a
// refresh so a newly linked gym's bookings are pulled in).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3094;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-calregen.db');
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  cleanup();
  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await sleep(150);
  }
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
  const call = async (method, p, t, body) => (await fetch(`${BASE}${p}`, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined }));
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  const gymsNow = async () => (await (await call('GET', '/api/my-gyms', t)).json()).gyms.map((g) => g.gym_id);
  const stamp = async () => (await (await call('GET', '/api/calendar/status', t)).json()).generatedAt;

  // Normalise to one linked gym with the calendar on.
  if ((await gymsNow()).includes('jab-boxing')) await call('DELETE', '/api/my-gyms/jab-boxing', t);
  assert.strictEqual((await call('POST', '/api/calendar/enable', t, {})).status, 200);
  await sleep(4000); // let enable's own debounced refresh land, so it cannot be mistaken for the link's
  let last = await stamp();
  assert.ok(last, 'fixture: a snapshot exists');

  await sleep(1200); // generated_at has one-second resolution
  let r = await call('POST', '/api/my-gyms/link', t, { gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' });
  assert.strictEqual(r.status, 200);
  let now = await stamp();
  assert.ok(now > last, `link must regenerate the snapshot (was ${last}, now ${now})`);
  last = now;

  await sleep(1200);
  r = await call('DELETE', '/api/my-gyms/jab-boxing', t);
  assert.strictEqual(r.status, 200);
  now = await stamp();
  assert.ok(now > last, `unlink must regenerate the snapshot (was ${last}, now ${now})`);
  console.log('✅ Link and unlink regenerate the calendar snapshot.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-22: calendar snapshot regenerates on link/unlink\n');
  try { await run(); console.log('\n🎉 C3-22 PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ C3-22 FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
