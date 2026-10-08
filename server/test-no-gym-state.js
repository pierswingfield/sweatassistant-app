// An account with NO gym is legitimate (signup is gym-less, and an account may
// outlive every membership). With DEFAULT_GYM_ID gone nothing invents a gym for it:
// gym-scoped routes answer 409 NO_GYM_LINKED, per-gym reads match nothing, and the
// app login is the account's own credential only (no gym-login bootstrap).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-nogymstate.db');
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
  const send = async (method, p, body, token) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 1. Login never creates an account or bootstraps a gym.
  const ghost = await send('POST', '/api/auth/login', { email: 'ghost@test.local', password: 'whatever-123' });
  assert.strictEqual(ghost.status, 401, 'unknown email: rejected');
  const again = await send('POST', '/api/auth/signup', { email: 'ghost@test.local', password: 'whatever-123' });
  assert.strictEqual(again.status, 200, 'and it was NOT created by the failed login, so signup still succeeds');
  const token = again.body.token;
  assert.strictEqual(again.body.needsGym, true);

  // 2. A gym-less account: gym-scoped routes say so, rather than guessing a gym.
  for (const [method, p, body] of [
    ['GET', '/api/timetable'], ['GET', '/api/bookings'], ['GET', '/api/credits'],
    ['POST', '/api/auto-book', { eventId: 1, preferences: { requiredCount: 1 } }],
    ['POST', '/api/auto-upgrade', { eventId: 1, bookingId: 1, currentSlotId: 1, preferences: {} }],
  ]) {
    const r = await send(method, p, body, token);
    assert.strictEqual(r.status, 409, `${method} ${p} -> 409 (got ${r.status})`);
    assert.strictEqual(r.body.code, 'NO_GYM_LINKED', `${method} ${p} names the state`);
  }
  const mine = await send('GET', '/api/my-gyms', null, token);
  assert.deepStrictEqual(mine.body.gyms, [], 'and the account really has no gym');

  // 3a. Account-scoped settings still save with no gym; a gym-scoped key cannot.
  const acct = await send('PUT', '/api/settings', { theme: 'dark' }, token);
  assert.strictEqual(acct.status, 200, 'account-scoped settings need no gym');
  const gymKey = await send('PUT', '/api/settings', { detectedBookingOffset: 14 }, token);
  assert.strictEqual(gymKey.status, 409, 'a gym-scoped key has no gym to land in');
  assert.strictEqual(gymKey.body.code, 'NO_GYM_LINKED');

  // 3. Per-gym reads for it are empty, not another gym's data.
  const queue = await send('GET', '/api/auto-book', null, token);
  assert.strictEqual(queue.status, 200);
  assert.deepStrictEqual(Array.isArray(queue.body) ? queue.body : queue.body.autoBookings || [], []);

  // 3b. Admin: the user list and detail pages tolerate a gym-less account.
  const adm = await send('POST', '/api/admin/login', { password: 'x' });
  assert.strictEqual(adm.status, 200, 'admin login');
  const list = await send('GET', '/api/admin/users', null, adm.body.token);
  assert.strictEqual(list.status, 200);
  const me = (list.body.users || list.body).find((u) => u.email === 'ghost@test.local');
  assert.ok(me, 'gym-less user is listed');
  const detail = await send('GET', `/api/admin/users/${me.id}`, null, adm.body.token);
  assert.strictEqual(detail.status, 200, `admin detail for a gym-less account (got ${detail.status}: ${JSON.stringify(detail.body).slice(0, 200)})`);

  // 4. The dev mock login (non-production) still creates a working account with gyms.
  const dev = await send('POST', '/api/auth/login', { email: 'dev@psycle.com', password: 'x' });
  assert.strictEqual(dev.status, 200, 'dev mock login works in development');
  const devGyms = await send('GET', '/api/my-gyms', null, dev.body.token);
  assert.ok(devGyms.body.gyms.length >= 1, 'and seeds the mock gyms');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 no-gym state: 409 NO_GYM_LINKED, no gym-login bootstrap\n');
  try { await run(); console.log('\n🎉 no-gym-state PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ no-gym-state FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
