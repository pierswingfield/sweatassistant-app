// C3-19: POST /api/notify/booking-success named the gym with
// db.resolveActiveGymId(), and no client caller sent one, so on a two-gym account
// a manual JAB booking produced a push titled "Psycle: Spot Booked". The route
// now uses the booking's own gymId (validated as linked); a caller that sends
// none keeps the old fallback so an out-of-date PWA still notifies.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3095;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-notifygym.db');
const PUSH_LOG = path.join(__dirname, 'test-notifygym-push.log');
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`, PUSH_LOG]) { try { fs.unlinkSync(f); } catch (_) {} }
};
const pushes = () => (fs.existsSync(PUSH_LOG) ? fs.readFileSync(PUSH_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function run() {
  cleanup();
  // Stub the push fan-out BEFORE the server loads it, so the rendered title is observable.
  const boot = `const p=require('./push');p.sendNotification=async(u,t,b)=>{require('fs').appendFileSync(${JSON.stringify(PUSH_LOG)},JSON.stringify({t,b})+'\\n')};require('./server');`;
  child = spawn('node', ['-e', boot], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  await fetch(`${BASE}/api/my-gyms/link`, { method: 'POST', headers: H(t),
    body: JSON.stringify({ gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }) });
  const gymCount = (await (await fetch(`${BASE}/api/my-gyms`, { headers: H(t) })).json()).gyms.length;
  assert.strictEqual(gymCount, 2, 'fixture: two linked gyms');

  const notify = async (extra) => {
    const before = pushes().length;
    const r = await fetch(`${BASE}/api/notify/booking-success`, { method: 'POST', headers: H(t),
      body: JSON.stringify({ eventId: 'e1', className: 'Boxing', groupName: 'BOXING', instructorName: 'George Davies',
        startAt: new Date(Date.now() + 864e5).toISOString(), slots: [], source: 'manual', ...extra }) });
    return { status: r.status, sent: pushes().slice(before) };
  };

  let r = await notify({ gymId: 'jab-boxing' });
  assert.strictEqual(r.status, 200);
  assert.ok(/^JAB/.test(r.sent[0].t) && !/Psycle/.test(r.sent[0].t), `JAB booking must be titled JAB, got "${r.sent[0]?.t}"`);

  r = await notify({ gymId: 'psycle-london' });
  assert.ok(/^Psycle/.test(r.sent[0].t), `got "${r.sent[0]?.t}"`);

  r = await notify({ gymId: 'not-a-linked-gym' });
  assert.strictEqual(r.status, 403, 'a gym the account is not linked to is refused');
  assert.strictEqual(r.sent.length, 0);
  console.log('✅ Booking-success push names the booking\'s own gym.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-19: booking-success push carries the gym\n');
  try { await run(); console.log('\n🎉 C3-19 PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ C3-19 FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
