// Teams security review (low, approved 2026-11-06): POST /api/notify/booking-success fans a
// push out to every device and schedules a calendar refresh, so it now carries
// bookingMutationLimiter (10/min per user, production; RATE_LIMIT_TEST_FORCE=1 here).
// Booted against the dev mock gyms on a throwaway DB and port; push sends are stubbed.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3091;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-limit-'));
const DB_PATH = path.join(DIR, 'app.db');
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
};

async function run() {
  const boot = "const p=require('./push');p.sendNotification=async()=>{};require('./server');";
  child = spawn('node', ['-e', boot], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', RATE_LIMIT_TEST_FORCE: '1', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/config`)).ok; } catch (_) {}
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, 'server booted');
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  assert.ok(login.token, 'dev mock login');
  const notify = () => fetch(`${BASE}/api/notify/booking-success`, { method: 'POST', headers: H(login.token),
    body: JSON.stringify({ eventId: 'e1', className: 'Ride', startAt: new Date(Date.now() + 864e5).toISOString(), slots: [], source: 'manual', gymId: 'psycle-london' }) });
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await notify()).status);
  assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(200), `first ten allowed: ${statuses}`);
  assert.strictEqual(statuses[10], 429, 'the eleventh in a minute is refused');
  // The budget is per user: a second account is unaffected.
  const signup = await (await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: `other-${Date.now()}@limit.test`, password: 'correct horse battery 9' }) })).json();
  if (signup.token) {
    const r = await fetch(`${BASE}/api/notify/booking-success`, { method: 'POST', headers: H(signup.token), body: JSON.stringify({ eventId: 'e1' }) });
    assert.notStrictEqual(r.status, 429, 'another account has its own budget');
  }
  console.log('✅ booking-success is limited to 10/min per user.');
}

(async () => {
  let failed = 0;
  try { await run(); console.log('\n1/1 passed'); }
  catch (err) { failed = 1; console.error('\n❌ booking-success limiter FAILED:\n', err); }
  finally { cleanup(); }
  process.exit(failed);
})();
