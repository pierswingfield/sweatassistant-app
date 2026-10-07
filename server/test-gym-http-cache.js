// C2-4: gym-scoped, per-user GETs differ only by the x-gym-id / Authorization
// request headers, so every HTTP cache must key on them (Vary) and never share
// the response across users. Chrome serialised the per-gym requests behind one
// cache entry before this (cold 13/23/34 s instead of ~11 s parallel).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-gymhttpcache.db');
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
  const H = (t, gym) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}`, ...(gym ? { 'x-gym-id': gym } : {}) });
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  await fetch(`${BASE}/api/my-gyms/link`, { method: 'POST', headers: H(t, 'jab-boxing'),
    body: JSON.stringify({ gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }) });

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const paths = [`/api/timetable?startDate=${from}&endDate=${to}`, `/api/metadata?startDate=${from}&endDate=${to}`,
    '/api/bookings', '/api/profile', '/api/credits'];
  for (const p of paths) {
    const res = await fetch(`${BASE}${p}`, { headers: H(t, 'jab-boxing') });
    assert.ok(res.status < 500, `${p} responds (${res.status})`);
    const vary = String(res.headers.get('vary') || '').toLowerCase();
    assert.ok(vary.includes('x-gym-id'), `${p}: Vary must include x-gym-id (got "${vary}")`);
    assert.ok(vary.includes('authorization'), `${p}: Vary must include authorization (got "${vary}")`);
    const cc = String(res.headers.get('cache-control') || '').toLowerCase();
    assert.ok(cc.includes('private') || cc.includes('no-store'), `${p}: must not be publicly cacheable (got "${cc}")`);
  }
  // The studio-layout response is cached by the browser for an hour: it must be keyed per gym too.
  const lay = await fetch(`${BASE}/api/studios/1/layout`, { headers: H(t, 'jab-boxing') });
  assert.ok(String(lay.headers.get('vary') || '').toLowerCase().includes('x-gym-id'), 'layout: Vary x-gym-id');
  console.log('✅ gym-scoped GETs carry Vary: x-gym-id, Authorization and a private cache policy.');
}

(async () => {
  let failed = 0;
  try { await run(); } catch (e) { failed = 1; console.error('❌', e.stack || e.message); }
  cleanup();
  process.exit(failed);
})();
