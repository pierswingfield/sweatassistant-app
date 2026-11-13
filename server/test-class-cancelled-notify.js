// classCancelled notification: text, prefs, dedupe, no flood (past / first sync).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `cancel-notify-${process.pid}.db`);

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const push = require('./push');
const notifications = require('./notifications');
const bookingSync = require('./booking-sync');
const { getProvider } = require('./providers');

const GYM = 'jab-boxing';
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const sent = [];
push.sendNotification = async (userId, title, body, data) => { sent.push({ userId, title, body, data }); };

const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
const cancelledBooking = (id, startAt) => ({ bookingId: id, eventId: `e${id}`, isWaitlist: false, isCancelled: true,
  event: { id: `e${id}`, name: 'TRAIN - Lower', startAt, instructors: [] } });
let seq = 0;
function user() {
  const uid = testkit.createUser(db, `cn-${++seq}@test.local`, 'x');
  db.upsertUserGym(uid, GYM, { gym_email: 'dev@jabboxing.mock', encrypted_password: 'x', session_json: JSON.stringify({ accessToken: 'mock-mt-token' }) });
  return uid;
}

check('default pref is on and text names class, gym-zone time and gym', () => {
  assert.strictEqual(notifications.DEFAULT_PREFS.classCancelled.enabled, true);
  const zone = require('./providers/timezone').zoneOfGym(GYM);
  const startAt = require('luxon').DateTime.fromISO('2030-01-07T18:00:00', { zone }).toISO();
  const b = notifications.buildClassCancelled({ gymId: GYM, className: 'TRAIN - Lower', startAt });
  const gymName = require('./gyms.config').getGymConfig(GYM).name;
  assert.ok(b.body.startsWith('TRAIN - Lower on ') && b.body.includes('18:00') && b.body.endsWith(`has been cancelled by ${gymName}.`), b.body);
  assert.ok(notifications.buildSample('classCancelled'));
});

check('notify honours the pref and deep-links to My Bookings', async () => {
  const uid = user();
  sent.length = 0;
  await notifications.notify(uid, 'classCancelled', { gymId: GYM, className: 'X', startAt: inDays(2), url: '/bookings' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.type, 'classCancelled');
  assert.strictEqual(sent[0].data.url, '/bookings');
  db.setUserSettings(uid, { notifications: { classCancelled: { enabled: false } } });
  await notifications.notify(uid, 'classCancelled', { gymId: GYM, className: 'X', startAt: inDays(2) });
  assert.strictEqual(sent.length, 1, 'disabled pref sends nothing');
});

check('future cancelled class notifies once; past never; first sync silent', async () => {
  const uid = user();
  sent.length = 0;
  const future = cancelledBooking(7001, inDays(2));
  const past = cancelledBooking(7002, inDays(-3));
  await bookingSync.notifyStudioCancelled(uid, GYM, [future, past]);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].body.includes('TRAIN - Lower'));
  await bookingSync.notifyStudioCancelled(uid, GYM, [future, past]);
  assert.strictEqual(sent.length, 1, 'deduped');
  await bookingSync.notifyStudioCancelled(uid, GYM, [cancelledBooking(7003, inDays(2))], { firstSync: true });
  assert.strictEqual(sent.length, 1, 'first sync is silent');
  await bookingSync.notifyStudioCancelled(uid, GYM, [cancelledBooking(7003, inDays(2))]);
  assert.strictEqual(sent.length, 1, 'first-sync item was recorded, so still silent');
});

check('through a real sync: first sync silent, later newly-cancelled notifies', async () => {
  const uid = user();
  const provider = getProvider(GYM);
  const orig = provider.listBookings;
  sent.length = 0;
  try {
    provider.listBookings = async () => [cancelledBooking(8001, inDays(2))];
    await bookingSync.syncUserGym(uid, GYM, { force: true });
    assert.strictEqual(sent.length, 0, 'already-cancelled on first sync');
    provider.listBookings = async () => [cancelledBooking(8001, inDays(2)), cancelledBooking(8002, inDays(3))];
    await bookingSync.syncUserGym(uid, GYM, { force: true });
    assert.strictEqual(sent.length, 1);
    await bookingSync.syncUserGym(uid, GYM, { force: true });
    assert.strictEqual(sent.length, 1, 'no repeat');
  } finally { provider.listBookings = orig; }
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
