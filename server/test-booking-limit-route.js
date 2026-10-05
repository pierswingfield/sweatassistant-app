// Edit-modal eligibility, server layer: POST /api/book must reject a second
// self reservation for a one-per-class gym (JAB) even if the client is stale.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-booklimit.db');
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
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}`, 'x-gym-id': 'jab-boxing' });
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  await fetch(`${BASE}/api/my-gyms/link`, { method: 'POST', headers: H(t),
    body: JSON.stringify({ gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }) });

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const events = await (await fetch(`${BASE}/api/timetable?from=${from}&to=${to}`, { headers: H(t) })).json();
  const list = Array.isArray(events) ? events : events.events || [];
  assert.ok(list.length, 'fixture: JAB mock timetable has classes');
  const ev = list[0];
  const detail = await (await fetch(`${BASE}/api/events/${ev.id}`, { headers: H(t) })).json();
  const free = (detail.slots || []).filter((s) => s.isAvailable).map((s) => s.id);
  assert.ok(free.length >= 2, 'fixture: two free spots');

  const book = (slotIds) => fetch(`${BASE}/api/book`, { method: 'POST', headers: H(t), body: JSON.stringify({ eventId: ev.id, slotIds }) });
  const over = await book([free[0], free[1]]);
  assert.strictEqual(over.status, 400, 'two self spots in one request exceeds one-per-class');
  assert.strictEqual((await over.json()).code, 'ATTENDEE_LIMIT_EXCEEDED');

  const first = await book([free[0]]);
  assert.ok(first.status < 300, `first self booking allowed (got ${first.status})`);
  const second = await book([free[1]]);
  assert.strictEqual(second.status, 400, 'second self booking rejected even from a stale client');
  assert.strictEqual((await second.json()).code, 'ATTENDEE_LIMIT_EXCEEDED');
  console.log('✅ /api/book enforces the self-booking limit server-side.');
}

(async () => {
  let failed = 0;
  try { await run(); } catch (e) { failed = 1; console.error('❌', e.stack || e.message); }
  cleanup();
  process.exit(failed);
})();
