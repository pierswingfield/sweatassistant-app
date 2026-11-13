// MarianaTek: studio-cancelled reservations and free classes (mock-backed).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `mt-cancel-free-${process.pid}.db`);

const assert = require('assert');
const { getProvider } = require('./providers');
const mock = require('./mock-marianatek');
const { makeBooking, makeEvent } = require('./providers/normalize');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const session = { accessToken: 'mock-mt-token' };
const mt = () => getProvider('jab-boxing');

check('normalizers carry isCancelled / isFree', async () => {
  assert.strictEqual(makeBooking({ bookingId: 1, isCancelled: true }).isCancelled, true);
  assert.strictEqual(makeEvent({ id: 1, isCancelled: true, isFree: true }).isFree, true);
  assert.strictEqual(mt().mapClassToEvent({ id: 5, is_free_class: true, is_cancelled: true }).isCancelled, true);
  // No price fields exist on the live payload: price/cost never imply free.
  assert.notStrictEqual(mt().mapClassToEvent({ id: 5, price: '0.00', cost: 0 }).isFree, true);
  assert.notStrictEqual(mt().mapClassToEvent({ id: 5 }).isFree, true);
  assert.notStrictEqual(mt().mapClassToEvent({ id: 5, is_free_class: false }).isFree, true);
});

check('studio-cancelled reservation is flagged on listBookings', async () => {
  const timetable = await mt().fetchTimetable({}, session);
  const target = timetable.find((e) => !e.isUserBooked);
  const r = mock.seedCancelledReservation(String(target.id));
  const list = await mt().listBookings(session);
  const row = list.find((b) => String(b.bookingId) === String(r.id));
  assert.ok(row, 'cancelled reservation listed');
  assert.strictEqual(row.isCancelled, true);
  assert.strictEqual(row.event.isCancelled, true);
});

check('background sync does not cache a cancelled booking', async () => {
  const bookingSync = require('./booking-sync');
  const db = require('./db');
  const testkit = require('./testkit');
  const provider = mt();
  const start = new Date(Date.now() + 864e5).toISOString();
  const ev = (id) => ({ id, name: 'X', startAt: start, instructors: [] });
  const orig = provider.listBookings;
  provider.listBookings = async () => [
    { bookingId: 'live1', eventId: '9001', isWaitlist: false, event: ev('9001') },
    { bookingId: 'dead1', eventId: '9002', isWaitlist: false, isCancelled: true, event: ev('9002') },
  ];
  try {
    const uid = testkit.createUser(db, 'cancel-free@test.local', 'x');
    db.upsertUserGym(uid, 'jab-boxing', { gym_email: 'dev@jabboxing.mock', encrypted_password: 'x',
      session_json: JSON.stringify({ accessToken: 'mock-mt-token' }) });
    const rows = await bookingSync.bookingRowsFor(uid, 'jab-boxing');
    assert.deepStrictEqual(rows.map((r) => String(r.bookingId)), ['live1']);
  } finally { provider.listBookings = orig; void db; }
});

check('free class books with empty payment_options', async () => {
  const opts = await mt().getClassPaymentOptions(mock.FREE_CLASS_ID, session);
  assert.strictEqual(opts.user.length, 0);
  const res = await mt().bookSlot(mock.FREE_CLASS_ID, [], session);
  assert.strictEqual(res.ok, true, res.error);
  assert.notStrictEqual(res.code, 'NOT_ELIGIBLE');
});

check('free class entitlement is not blocked by empty options', async () => {
  const ent = await mt().getBookingEntitlement(mock.FREE_CLASS_ID, session);
  assert.notStrictEqual(ent.selfReason, 'NO_VALID_PAYMENT_OPTION');
});

check('paid class with no payment option is NOT_ELIGIBLE and sends nothing', async () => {
  const provider = mt();
  const origRes = provider.resolvePaymentOption;
  const origReq = provider.request;
  provider.resolvePaymentOption = async () => null;
  let posted = false;
  provider.request = async (path, opts) => {
    if (path === '/me/reservations' && opts && opts.method === 'POST') posted = true;
    return origReq.call(provider, path, opts);
  };
  try {
    const timetable = await provider.fetchTimetable({}, session);
    const paid = timetable.find((e) => !e.isUserBooked && !e.isFree);
    const res = await provider.bookSlot(paid.id, [], session);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'NOT_ELIGIBLE');
    assert.strictEqual(posted, false);
  } finally { provider.resolvePaymentOption = origRes; provider.request = origReq; }
});

check('live fixture: free and cancelled markers (sanitized capture)', async () => {
  const fx = require('./fixtures/marianatek/free-and-cancelled-2026-11-13.json');
  assert.strictEqual(mt().mapClassToEvent(fx.freeClass).isFree, true);
  assert.notStrictEqual(mt().mapClassToEvent(fx.paidClass).isFree, true);
  assert.strictEqual(fx.freeReservation.payment_option, null);
  assert.strictEqual(mt()._historyStatus(fx.cancelledReservation), 'class-cancelled');
  assert.strictEqual(mt().mapClassToEvent(fx.cancelledReservation.class_session).isCancelled, true);
});

check('client push never persists a cancelled booking (Teams/calendar read booking_cache)', async () => {
  const bookingSync = require('./booking-sync');
  const db = require('./db');
  const testkit = require('./testkit');
  const uid = testkit.createUser(db, 'cancel-push@test.local', 'x');
  db.upsertUserGym(uid, 'jab-boxing', { gym_email: 'dev@jabboxing.mock', encrypted_password: 'x',
    session_json: JSON.stringify({ accessToken: 'mock-mt-token' }) });
  const startAt = new Date(Date.now() + 864e5).toISOString();
  const row = (id, extra) => ({ bookingId: id, gymId: 'jab-boxing', eventId: `e${id}`, startAt, className: 'X', ...extra });
  bookingSync.acceptClientBookings(uid, [row('a1'), row('a2', { isCancelled: true })], ['jab-boxing']);
  const ids = db.db.prepare('SELECT booking_id FROM booking_cache WHERE user_id = ?').all(uid).map((r) => String(r.booking_id));
  assert.deepStrictEqual(ids, ['a1']);
  // Teams read only origin='server' booking_cache rows via team-data.
  const td = require('./team-data').rowsForUsers([uid]);
  assert.ok(!td.get(uid).bookings.some((r) => String(r.booking_id) === 'a2'));
});

check('studio-cancelled class retires pending auto-book + upgrade monitor and leaves Teams queue', async () => {
  const bookingSync = require('./booking-sync');
  const db = require('./db');
  const testkit = require('./testkit');
  const provider = mt();
  const uid = testkit.createUser(db, 'cancel-queue@test.local', 'x');
  db.upsertUserGym(uid, 'jab-boxing', { gym_email: 'dev@jabboxing.mock', encrypted_password: 'x',
    session_json: JSON.stringify({ accessToken: 'mock-mt-token' }) });
  const start = new Date(Date.now() + 3 * 864e5).toISOString();
  db.addAutoBooking(uid, 9002, 'X', 'I', 'S', 'L', start, { preferredSlots: [], preferredRows: [] }, null, null, null, 'jab-boxing');
  db.addAutoBooking(uid, 9003, 'Y', 'I', 'S', 'L', start, { preferredSlots: [], preferredRows: [] }, null, null, null, 'jab-boxing');
  db.db.prepare(`INSERT INTO auto_upgrades (user_id, gym_id, event_id, booking_id, current_slot_id, preferences, status, start_at)
    VALUES (?, 'jab-boxing', 9002, 5555, 1, '{}', 'active', ?)`).run(uid, start);
  const orig = provider.listBookings;
  provider.listBookings = async () => [{ bookingId: 5555, eventId: '9002', isWaitlist: false, isCancelled: true, event: { id: '9002', startAt: start } }];
  try { await bookingSync.bookingRowsFor(uid, 'jab-boxing', []); } finally { provider.listBookings = orig; }
  const cancelled = [{ bookingId: 5555, eventId: '9002' }];
  // exercise the retire path through a real sync of the stubbed list
  provider.listBookings = async () => [{ bookingId: 5555, eventId: '9002', isWaitlist: false, isCancelled: true, event: { id: '9002', startAt: start } }];
  try { await bookingSync.syncUserGym(uid, 'jab-boxing', { force: true }); } finally { provider.listBookings = orig; void cancelled; }
  const rows = db.db.prepare('SELECT event_id, status, executed_at FROM auto_bookings WHERE user_id = ? ORDER BY event_id').all(uid);
  assert.strictEqual(rows[0].status, 'cancelled');
  assert.ok(rows[0].executed_at);
  assert.strictEqual(rows[1].status, 'pending');
  assert.strictEqual(db.db.prepare('SELECT status FROM auto_upgrades WHERE user_id = ?').get(uid).status, 'stopped');
  const q = require('./team-data').rowsForUsers([uid]).get(uid).queue;
  assert.deepStrictEqual(q.map((r) => r.event_id), [9003]);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ok   ${c.name}`); }
    catch (e) { failed++; console.log(`  FAIL ${c.name}: ${e.message}`); }
  }
  console.log(`${checks.length - failed}/${checks.length} passed`);
  for (const f of [process.env.DB_PATH, `${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) { try { require('fs').unlinkSync(f); } catch (_) {} }
  process.exit(failed ? 1 : 0);
})();
