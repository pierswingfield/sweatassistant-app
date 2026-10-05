// Guest reservations are separate MarianaTek records, but must never survive
// their member reservation. These tests pin persistence, guest-first ordering,
// direct guest cancellation and the provider-list recovery path.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');
const { cancelReservationGroup } = require('./routes-normalized');

const GYM = 'jab-boxing';
let sequence = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const user = () => {
  const id = db.createUser(`guest-group-${Date.now()}-${sequence++}@test.local`, 'enc');
  db.upsertUserGym(id, GYM, { gym_email: `guest-${sequence}@test.local`, encrypted_password: 'enc' });
  return id;
};
const booking = (bookingId, eventId, isGuest = false) => ({ bookingId, eventId, isGuest });

check('persists guest-to-primary relationship scoped by gym', () => {
  const uid = user();
  db.upsertGuestBookingGroup(uid, GYM, 'class-1', 'primary-1', 'guest-1');
  assert.deepStrictEqual(db.getGuestBookingIdsForPrimary(uid, GYM, 'primary-1'), ['guest-1']);
  assert.strictEqual(db.getGuestBookingIdsForPrimary(uid, 'psycle-london', 'primary-1').length, 0);
});

check('primary cancellation cancels guest first and removes the durable edge', async () => {
  const uid = user();
  db.upsertGuestBookingGroup(uid, GYM, 'class-2', 'primary-2', 'guest-2');
  const calls = [];
  const provider = {
    listBookings: async () => [booking('primary-2', 'class-2'), booking('guest-2', 'class-2', true)],
    cancelBooking: async (id) => { calls.push(id); return true; },
  };
  const result = await cancelReservationGroup({ userId: uid, gymId: GYM, provider, session: {}, bookingId: 'primary-2' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(calls, ['guest-2', 'primary-2']);
  assert.deepStrictEqual(db.getGuestBookingIdsForPrimary(uid, GYM, 'primary-2'), []);
});

check('a guest cancellation failure retains the primary reservation', async () => {
  const uid = user();
  db.upsertGuestBookingGroup(uid, GYM, 'class-3', 'primary-3', 'guest-3');
  const calls = [];
  const provider = {
    listBookings: async () => [booking('primary-3', 'class-3'), booking('guest-3', 'class-3', true)],
    cancelBooking: async (id) => { calls.push(id); return false; },
  };
  const result = await cancelReservationGroup({ userId: uid, gymId: GYM, provider, session: {}, bookingId: 'primary-3' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'GUEST_CANCELLATION_FAILED');
  assert.deepStrictEqual(calls, ['guest-3']);
  assert.deepStrictEqual(db.getGuestBookingIdsForPrimary(uid, GYM, 'primary-3'), ['guest-3']);
});

check('direct guest cancellation removes only the guest edge', async () => {
  const uid = user();
  db.upsertGuestBookingGroup(uid, GYM, 'class-4', 'primary-4', 'guest-4');
  const calls = [];
  const provider = {
    listBookings: async () => [booking('primary-4', 'class-4'), booking('guest-4', 'class-4', true)],
    cancelBooking: async (id) => { calls.push(id); return true; },
  };
  const result = await cancelReservationGroup({ userId: uid, gymId: GYM, provider, session: {}, bookingId: 'guest-4' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(calls, ['guest-4']);
  assert.deepStrictEqual(db.getGuestBookingIdsForPrimary(uid, GYM, 'primary-4'), []);
});

check('provider list recovers a legacy unpersisted guest before primary cancellation', async () => {
  const uid = user();
  const calls = [];
  const provider = {
    listBookings: async () => [booking('primary-5', 'class-5'), booking('guest-5', 'class-5', true)],
    cancelBooking: async (id) => { calls.push(id); return true; },
  };
  const result = await cancelReservationGroup({ userId: uid, gymId: GYM, provider, session: {}, bookingId: 'primary-5' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(calls, ['guest-5', 'primary-5']);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
  }
  process.exit(failed ? 1 : 0);
})();
