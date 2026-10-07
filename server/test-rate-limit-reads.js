// C7-1 — rate-limit the normalized read routes.
//
// Before this test existed, `/timetable`, `/metadata`, `/bookings`,
// `/waitlists`, `/profile`, `/credits`, `/eligibility`, `/membership`,
// `/my-gyms`, `/events/:id`, `/studios/:id/layout` and
// `/cancel-penalty/:bookingId` had NO rate limiter at all — only
// `extrasLimiter`'s three routes (/bundles, /bookmarks, /profile/update) did.
// Confirmed 2026-09-27 by grepping routes-normalized.js for `Limiter` (no
// hits on any of the routes above) and by looping 150 authenticated
// GET /api/timetable requests against a local dev-mode server: 150/150 came
// back 200, none 429.
//
// This boots the REAL server as a child process (mirrors
// test-regression-psycle.js), logs in as dev@psycle.com (mock CodexFit
// backend, no network), and asserts:
//   1. the new `readLimiter` is mounted on the previously-unlimited routes
//      and returns 429 once its budget is exceeded;
//   2. the budget is per-USER and SHARED across all those routes (hitting
//      one repeatedly burns the same counter another draws from);
//   3. the tighter `refreshLimiter` on `?refresh=1` trips independently, and
//      well below the general read budget;
//   4. in normal (non-production) mode, neither limiter is active — matches
//      every other limiter in this codebase (production-only).
//
// Testability note: the real limiters are `skip: NODE_ENV !== 'production'`.
// Running the child with NODE_ENV=production would also disable the
// dev@psycle.com mock login (providers/codexfit.js gates DEV_EMAIL on
// `NODE_ENV !== 'production'`), making this route untestable at all without
// live CodexFit credentials. So routes-normalized.js's readLimiter/
// refreshLimiter also check `RATE_LIMIT_TEST_FORCE === '1'` — set below —
// which forces them on while NODE_ENV stays 'development' and the mock login
// keeps working. Test 4 (the "normal mode leaves them off" case) reruns the
// server WITHOUT that flag to prove the override is opt-in, not a permanent
// bypass.
//
// Usage: node server/test-rate-limit-reads.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Unique per-process port/DB/mock file so concurrent runs cannot collide.
const PORT = 20000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(require('os').tmpdir(), `test-rate-limit-reads-${process.pid}.db`);

const MOCK_BOOKINGS_PATH = path.join(require('os').tmpdir(), `test-rate-limit-reads-${process.pid}.dbjson`);

for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

let child;
let failed = false;

function log(msg) { console.log(msg); }

function spawnServer(extraEnv) {
  return spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      MOCK_BOOKINGS_PATH,
      NODE_ENV: 'development', // keeps dev@psycle.com mock login alive
      JWT_SECRET: 'test-rate-limit-reads-jwt-secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      APP_NAME: 'Rate Limit Test App',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/config`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not become ready in time.');
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'anything' }),
  });
  const data = await res.json();
  assert.strictEqual(res.status, 200, `login failed: ${JSON.stringify(data)}`);
  return data.token;
}

async function run() {
  // --- Part A: limiter FORCED on (NODE_ENV stays development, mock login works) ---
  child = spawnServer({ RATE_LIMIT_TEST_FORCE: '1' });
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  await waitForServer();
  log('✅ Server booted (dev mock backend, RATE_LIMIT_TEST_FORCE=1).');

  const token = await login();
  // (C3-28) two-gym dev account: name the gym, or the route answers 400.
  const authed = () => ({ headers: { authorization: `Bearer ${token}`, 'x-gym-id': 'psycle-london' } });
  log('✅ Logged in as dev@psycle.com.');

  // --- 1. The general read budget trips at 429 once exceeded -----------------
  {
    let sawStatuses = new Set();
    let firstTripAt = null;
    for (let i = 1; i <= 320; i++) {
      const res = await fetch(`${BASE}/api/timetable`, authed());
      sawStatuses.add(res.status);
      if (res.status === 429 && firstTripAt === null) firstTripAt = i;
    }
    assert.ok(sawStatuses.has(200), 'some requests should succeed before the budget trips');
    assert.ok(sawStatuses.has(429), 'the read limiter should return 429 once its budget is exceeded');
    assert.ok(firstTripAt > 250 && firstTripAt <= 301,
      `budget should trip just above 300/min (tripped at request #${firstTripAt}) — generous headroom, not hair-trigger`);
    log(`✅ GET /api/timetable returns 429 after exceeding the read budget (tripped at request #${firstTripAt}).`);
  }

  // --- 2. The budget is per-user and SHARED across the protected routes -------
  // (request #1 above already burned the whole per-user counter for /timetable;
  // a DIFFERENT route in the same family must already be blocked too.)
  {
    const res = await fetch(`${BASE}/api/bookings`, authed());
    assert.strictEqual(res.status, 429, '/api/bookings should already be rate-limited — it shares the SAME per-user counter as /api/timetable, not a separate one');
    log('✅ /api/bookings and /api/timetable share one per-user read counter (a burst on one route blocks the other).');
  }
  {
    const res = await fetch(`${BASE}/api/my-gyms`, authed());
    assert.strictEqual(res.status, 429, '/api/my-gyms should also share the same counter');
    log('✅ /api/my-gyms shares the same counter too.');
  }

  await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });

  // --- 3. The refresh limiter trips independently, and below the general budget ---
  child = spawnServer({ RATE_LIMIT_TEST_FORCE: '1' });
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  await waitForServer();
  const token2 = await login();
  const authed2 = () => ({ headers: { authorization: `Bearer ${token2}`, 'x-gym-id': 'psycle-london' } });

  {
    let firstTripAt = null;
    for (let i = 1; i <= 40; i++) {
      const res = await fetch(`${BASE}/api/timetable?refresh=1`, authed2());
      if (res.status === 429 && firstTripAt === null) { firstTripAt = i; break; }
    }
    assert.ok(firstTripAt !== null, 'the refresh limiter should trip well before the general read budget (30/min)');
    assert.ok(firstTripAt <= 31, `refresh limiter should trip around 30/min (tripped at #${firstTripAt})`);
    log(`✅ GET /api/timetable?refresh=1 trips its own tighter budget (at request #${firstTripAt}), independent of the general read budget.`);
  }

  await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });

  // --- 4. Without the force flag, neither limiter is active in dev mode -------
  child = spawnServer({});
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  await waitForServer();
  const token3 = await login();
  const authed3 = () => ({ headers: { authorization: `Bearer ${token3}`, 'x-gym-id': 'psycle-london' } });

  {
    let sawNon200 = false;
    for (let i = 0; i < 150; i++) {
      const res = await fetch(`${BASE}/api/timetable`, authed3());
      if (res.status !== 200) sawNon200 = true;
    }
    assert.strictEqual(sawNon200, false, 'without RATE_LIMIT_TEST_FORCE, dev mode must remain unlimited (production-only, like every other limiter)');
    log('✅ Without RATE_LIMIT_TEST_FORCE, dev mode stays unlimited — 150/150 requests returned 200.');
  }

  log('\n🎉 ALL RATE-LIMIT-READS CHECKS PASSED.');
}

async function main() {
  try {
    await run();
  } catch (err) {
    failed = true;
    console.error('\n❌ RATE-LIMIT-READS FAILURE:', err.message);
    console.error(err.stack);
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
    for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(MOCK_BOOKINGS_PATH)) fs.unlinkSync(MOCK_BOOKINGS_PATH);
    process.exit(failed ? 1 : 0);
  }
}

main();
