// "Remove" on a studio-cancelled MarianaTek booking: hidden server-side per
// user + gym + booking id, no call to the gym, lifted if the provider stops
// reporting it cancelled. Display-only: sync/calendar/notifications unaffected.
//
// HTTP section boots the real server with a preload that seeds the mock's
// cancelled reservation (and can reinstate it) on file-flag commands.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('db: dismissals are scoped to user + gym and cleared on unlink', () => {
  const db = require('./db');
  const testkit = require('./testkit');
  db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');
  const a = testkit.createUser(db, `dc-a-${Date.now()}@test.local`, 'enc:pw');
  const b = testkit.createUser(db, `dc-b-${Date.now()}@test.local`, 'enc:pw');
  for (const u of [a, b]) db.upsertUserGym(u, 'jab-boxing', { gym_email: 'x@test.local', encrypted_password: 'enc:x' });
  db.dismissCancelledBookings(a, 'jab-boxing', ['77', '78']);
  db.dismissCancelledBookings(a, 'jab-boxing', ['77']); // idempotent
  assert.deepStrictEqual([...db.getDismissedCancelledBookingIds(a, 'jab-boxing')].sort(), ['77', '78']);
  assert.strictEqual(db.getDismissedCancelledBookingIds(a, 'psycle-london').size, 0, 'other gym unaffected');
  assert.strictEqual(db.getDismissedCancelledBookingIds(b, 'jab-boxing').size, 0, 'other user unaffected');
  db.undismissBookings(a, 'jab-boxing', ['78']);
  assert.deepStrictEqual([...db.getDismissedCancelledBookingIds(a, 'jab-boxing')], ['77']);
  assert.throws(() => db.db.prepare("INSERT INTO dismissed_cancelled_bookings (user_id, booking_id) VALUES (?, 'x')").run(a), /NOT NULL/);
  db.unlinkGym(a, 'jab-boxing');
  assert.strictEqual(db.getDismissedCancelledBookingIds(a, 'jab-boxing').size, 0, 'unlink clears');
});

const PORT = 3096;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-dismiss-cancelled.db');
const CTL = fs.mkdtempSync(path.join(os.tmpdir(), 'dismiss-ctl-'));
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  try { fs.rmSync(CTL, { recursive: true, force: true }); } catch (_) {}
};

check('HTTP: hide, persist, no gym call, reinstated booking reappears, isolation', async () => {
  cleanup();
  fs.mkdirSync(CTL, { recursive: true });
  const preload = path.join(CTL, 'preload.js');
  fs.writeFileSync(preload, `
    const fs = require('fs'), path = require('path');
    const mock = require(${JSON.stringify(path.join(__dirname, 'mock-marianatek.js'))});
    const ctl = ${JSON.stringify(CTL)};
    let seeded = null;
    setInterval(() => {
      try {
        const seed = path.join(ctl, 'seed');
        if (fs.existsSync(seed) && !seeded) {
          seeded = mock.seedCancelledReservation(fs.readFileSync(seed, 'utf8').trim());
          fs.writeFileSync(path.join(ctl, 'seeded'), String(seeded.id));
        }
        if (seeded && fs.existsSync(path.join(ctl, 'revive'))) {
          seeded.status = 'pending';
          seeded.class_session = { ...seeded.class_session, is_cancelled: false, status: 'Scheduled' };
          fs.unlinkSync(path.join(ctl, 'revive'));
        }
      } catch (_) {}
    }, 50);`);
  child = spawn('node', ['-r', preload, 'server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = (t, g) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}`, ...(g ? { 'x-gym-id': g } : {}) });
  const call = async (method, p, t, g, body) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: H(t, g), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email, password: 'x' }) })).json()).token;
  const JAB = 'jab-boxing', PS = 'psycle-london';
  const t = await login('dev@psycle.com');
  await call('POST', '/api/my-gyms/link', t, null, { gymId: JAB, email: 'dev@jabboxing.mock', password: 'x' });

  const tt = await call('GET', '/api/timetable', t, JAB);
  assert.strictEqual(tt.status, 200);
  const target = tt.body.events.find((e) => !e.isUserBooked) || tt.body.events[0];
  fs.writeFileSync(path.join(CTL, 'seed'), String(target.id));
  for (let i = 0; i < 40 && !fs.existsSync(path.join(CTL, 'seeded')); i++) await sleep(50);
  const rid = fs.readFileSync(path.join(CTL, 'seeded'), 'utf8');

  const listed = async (tok = t, g = JAB) => (await call('GET', '/api/bookings', tok, g)).body.bookings;
  let row = (await listed()).find((b) => b.bookingId === rid);
  assert.ok(row && row.isCancelled === true, 'cancelled booking is listed before removal');

  // Remove: succeeds, never reaches the gym's cancel endpoint (which would 409).
  let r = await call('POST', '/api/bookings/dismiss-cancelled', t, JAB, { bookingIds: [rid] });
  assert.strictEqual(r.status, 200);
  assert.ok(!(await listed()).some((b) => b.bookingId === rid), 'hidden after Remove');
  assert.ok(!(await listed()).some((b) => b.bookingId === rid), 'and stays hidden on the next load');

  // Validation.
  assert.strictEqual((await call('POST', '/api/bookings/dismiss-cancelled', t, JAB, { bookingIds: [] })).status, 400);
  assert.strictEqual((await call('POST', '/api/bookings/dismiss-cancelled', t, JAB, {})).status, 400);

  // Another account with the same gym sees its own list (its booking id space is its own).
  const t2 = await login('dev@jabboxing.mock'); // dev login: a second, separate account
  assert.ok(t2 && t2 !== t, 'second account');
  const other = await listed(t2, JAB);
  assert.ok(other.some((b) => b.bookingId === rid), 'a different user still sees it');

  // Studio reinstates the class: it reappears and the dismissal is deleted.
  fs.writeFileSync(path.join(CTL, 'revive'), '1');
  for (let i = 0; i < 40 && fs.existsSync(path.join(CTL, 'revive')); i++) await sleep(50);
  row = (await listed()).find((b) => b.bookingId === rid);
  assert.ok(row, 'reinstated booking reappears');
  assert.ok(!row.isCancelled);
  const Database = require('better-sqlite3');
  const peek = new Database(DB_PATH, { readonly: true });
  assert.strictEqual(peek.prepare('SELECT COUNT(*) c FROM dismissed_cancelled_bookings WHERE booking_id = ?').get(rid).c, 0,
    'stale dismissal is removed once the booking is live again');
  peek.close();
  await call('DELETE', `/api/my-gyms/${JAB}`, t);
  void PS;
});

(async () => {
  let failed = 0;
  console.log('\nDismiss studio-cancelled booking\n');
  for (const c of checks) {
    try { await c.fn(); console.log(`  ok  ${c.name}`); }
    catch (err) { failed++; console.error(`  FAIL ${c.name}\n`, err && err.message ? err.message : err); }
  }
  cleanup();
  if (failed) { console.error(`\n${failed} failed\n`); process.exit(1); }
  console.log(`\nDismiss-cancelled PASSED (${checks.length} checks).\n`);
  process.exit(0);
})();
