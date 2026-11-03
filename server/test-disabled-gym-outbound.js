// Disabled gyms: cached activity still counts, and the server never talks to them.
//
// A gym is "disabled" when its registry row says `enabled = 0` (the mirror of
// gyms.config.js `enabled`, see server/gym-outbound.js) or when one account's
// link to it has `status = 'disabled'`. Its stored data survives and must keep
// counting on Home ("Your activity" total) — served from class_history — while
// every outbound path (routes, relogin, history sync, scheduler, poller,
// calendar) short-circuits before the provider adapter.
//
// The spy wraps every async adapter method on the MarianaTek prototype (and the
// GymProvider base) and records calls made for the disabled gym. Zero is the
// only acceptable count.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-disabled-gym-outbound-secret';

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const testkit = require('./testkit');
const auth = require('./auth');
const history = require('./class-history');
const scheduler = require('./scheduler');
const poller = require('./poller');
const calendar = require('./calendar');
const { getProvider } = require('./providers');
const GymProvider = require('./providers/base').GymProvider || Object.getPrototypeOf(require('./providers/marianatek'));
const MarianaTekProvider = require('./providers/marianatek');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

// --- provider spy -----------------------------------------------------------
const calls = [];
const restores = [];
function spyAsyncMethods(proto) {
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') continue;
    const fn = desc.value;
    const isAsync = fn.constructor && fn.constructor.name === 'AsyncFunction';
    if (!isAsync && !['request', 'publicRequest', 'classListRequest', 'sharedClassList'].includes(name)) continue;
    proto[name] = function spied(...args) {
      const gymId = this && this.gym && this.gym.id;
      if (gymId === JAB) calls.push(name);
      return fn.apply(this, args);
    };
    restores.push(() => { proto[name] = fn; });
  }
}
spyAsyncMethods(MarianaTekProvider.prototype);
if (GymProvider && GymProvider.prototype) spyAsyncMethods(GymProvider.prototype);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let seq = 0;
function userWithDisabledJab(label, { linkDisabled = false } = {}) {
  const uid = testkit.createUser(db, `disabled-${label}-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  db.linkGym(uid, JAB, { encryptedPassword: 'enc:pw' });
  db.upsertUserGym(uid, JAB, { gym_email: 'jab@test.local', encrypted_password: 'enc:pw' });
  db.setGymSession(uid, PSYCLE, { accessToken: 'mock-jwt-token' });
  db.setGymSession(uid, JAB, { accessToken: 'mock-mt-token' });
  // Three past JAB classes already in the store (one multi-spot booking pair).
  const past = (d) => new Date(Date.now() - d * 864e5).toISOString();
  history.upsertEntries(uid, JAB, [
    { bookingId: 'b1', eventId: 'e1', status: 'attended', startAt: past(3), durationMin: 50, instructorId: 'i1', instructorName: 'A' },
    { bookingId: 'b2', eventId: 'e2', status: 'unconfirmed', startAt: past(10), durationMin: 50, instructorId: 'i1', instructorName: 'A' },
    { bookingId: 'b3', eventId: 'e3', status: 'attended', startAt: past(20), durationMin: 45, instructorId: 'i2', instructorName: 'B' },
    { bookingId: 'b4', eventId: 'e4', status: 'cancelled', startAt: past(25), durationMin: 45 },
  ]);
  if (linkDisabled) {
    db.setUserGymStatus(uid, JAB, 'disabled');
  } else {
    db.db.prepare('UPDATE gyms SET enabled = 0 WHERE id = ?').run(JAB);
  }
  return uid;
}
function reenable(uid) {
  db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);
  if (uid) db.deleteUser(uid);
}

async function withRoutes(fn) {
  const router = require('./routes-normalized');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

for (const mode of ['registry', 'link']) {
  const linkDisabled = mode === 'link';

  check(`[${mode}-disabled] cached history counts in the activity total; routes make no provider call`, async () => {
    const uid = userWithDisabledJab(`routes-${mode}`, { linkDisabled });
    calls.length = 0;
    try {
      const token = jwt.sign({ userId: uid, email: 'x@test.local' }, process.env.JWT_SECRET);
      await withRoutes(async (base) => {
        const get = (path) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-gym-id': JAB } });

        const totals = await get('/api/attendance-totals');
        assert.strictEqual(totals.status, 200, 'attendance totals answer from the store');
        const body = await totals.json();
        assert.strictEqual(body.gymId, JAB);
        assert.strictEqual(body.attendedTotal, 3, 'attended + unconfirmed classes from class_history');
        assert.strictEqual(body.source, 'stored');

        const hist = await get('/api/history?days=365');
        assert.strictEqual(hist.status, 200, 'history serves stored rows');
        const h = await hist.json();
        assert.strictEqual(h.summary.classCount, 3);
        assert.strictEqual(h.history.length, 4);

        for (const path of ['/api/timetable', '/api/bookings', '/api/waitlists', '/api/profile', '/api/credits', '/api/membership', '/api/eligibility', '/api/metadata']) {
          const res = await get(path);
          assert.strictEqual(res.status, 409, `${path} refuses a disabled gym`);
          assert.strictEqual((await res.json()).code, 'GYM_DISABLED', `${path} code`);
        }
      });
      assert.deepStrictEqual(calls, [], `no provider calls for the disabled gym (got ${calls.join(', ')})`);
    } finally { reenable(uid); }
  });

  check(`[${mode}-disabled] relogin, history sync, scheduler, poller and calendar make no provider call`, async () => {
    const uid = userWithDisabledJab(`bg-${mode}`, { linkDisabled });
    calls.length = 0;
    try {
      const before = db.getUserGym(uid, JAB);

      await assert.rejects(() => auth.triggerAutoRelogin(uid, JAB), (e) => e.code === 'GYM_DISABLED');
      const after = db.getUserGym(uid, JAB);
      assert.strictEqual(after.relogin_failures, before.relogin_failures, 'no relogin failure recorded');
      assert.strictEqual(after.status, before.status, 'link status untouched');
      assert.ok(after.session_json, 'session not cleared');

      const sync = await history.syncUserGym(uid, JAB, { full: true });
      assert.strictEqual(sync.ok, false);
      await history.syncStale({ maxAgeMs: 0 });

      // Scheduler: a pending JAB auto-book stays pending and is never dispatched.
      const start = new Date(Date.now() + 3 * 864e5).toISOString();
      db.addAutoBooking(uid, 'evt-1', 'Boxing', 'Coach', 'Ring', 'NYC', start,
        { preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true }, 'studio-1', 'Boxing',
        new Date(Date.now() - 1000).toISOString(), JAB);
      const row = db.getPendingAutoBookings().find((b) => b.user_id === uid && b.gym_id === JAB);
      assert.ok(row, 'fixture: pending JAB auto-book');
      await scheduler.prefetchAutoBookSlots([row], 1);
      await scheduler.executeAutoBookForClass(row);
      scheduler.checkAndRunImmediateBookings(uid);
      scheduler.runAllPendingBookings(uid);
      await new Promise((r) => setTimeout(r, 400));
      const stillPending = db.getPendingAutoBookings().find((b) => b.id === row.id);
      assert.ok(stillPending, 'disabled-gym auto-book is left pending, not burned');

      // Poller: an active JAB auto-upgrade monitor and the booking-cache sweep.
      db.addAutoUpgrade(uid, 'evt-2', 'bk-2', 'slot-1', 'Boxing', 'Coach', 'Ring', 'NYC', start,
        { preferredSlots: ['slot-2'], preferredRows: [] }, 'studio-1', 'Boxing', JAB);
      await poller.executeAutoUpgradeChecks();
      db.addPushSubscription(uid, { endpoint: `https://push.invalid/${uid}`, keys: { p256dh: 'x', auth: 'y' } });
      await poller.refreshBookingCaches();

      // Calendar: the feed fan-out for an account with the feed on.
      db.setUserSettings(uid, { calendar: { enabled: true } });
      await calendar.refreshUser(uid);

      assert.deepStrictEqual(calls, [], `no provider calls for the disabled gym (got ${calls.join(', ')})`);
    } finally { reenable(uid); }
  });
}

check('provider backstop: any adapter I/O for a disabled gym rejects with GYM_DISABLED', async () => {
  db.db.prepare('UPDATE gyms SET enabled = 0 WHERE id = ?').run(JAB);
  calls.length = 0;
  try {
    const p = getProvider(JAB);
    await assert.rejects(() => p.fetchTimetable({}, { accessToken: 'mock-mt-token' }), (e) => e.code === 'GYM_DISABLED');
    await assert.rejects(() => p.login({ email: 'a@b.c', password: 'x' }), (e) => e.code === 'GYM_DISABLED');
    await assert.rejects(() => p.refreshSession({ accessToken: 'x' }, null), (e) => e.code === 'GYM_DISABLED');
    await assert.rejects(() => p.request('/classes', { token: 'mock-mt-token' }), (e) => e.code === 'GYM_DISABLED');
    assert.strictEqual(typeof p.capabilities, 'object', 'pure members stay readable');
    assert.deepStrictEqual(calls, []);
  } finally {
    db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);
  }
  // Re-enabled: the same instance works again without a restart.
  const rows = await getProvider(JAB).listBookingHistory({ accessToken: 'mock-mt-token' });
  assert.ok(rows.length > 0, 'enabled gym reaches its provider again');
});

(async () => {
  let passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
  }
  restores.forEach((r) => r());
  console.log(`${passed}/${checks.length} disabled-gym outbound checks passed`);
  process.exit(process.exitCode || 0);
})();
