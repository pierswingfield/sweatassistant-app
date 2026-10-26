// Shared app mutation contract: isolated account, mocked provider, no network.
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
process.env.JAB_BOXING_ENABLED = 'true';
const assert = require('node:assert/strict');
const db = require('./db');
const { getProvider } = require('./providers');
const { listGyms } = require('./gyms.config');
const service = require('./normalized-mutations');
const calendar = require('./calendar');
const userId = db.createAccount('shared-mutation@example.test', 'fixture-password');
const gymId = listGyms().find(g => g.enabled && g.capabilities.atomicSwap).id;
db.linkGym(userId, gymId);
db.runWithGymContext(userId, gymId, () => db.updateUserJWT(userId, 'fixture-session', new Date(Date.now() + 600000).toISOString()));
const provider = getProvider(gymId);
const originals = new Map();
function stub(key, value) { originals.set(key, provider[key]); provider[key] = value; }
const originalRefresh = calendar.scheduleRefresh;
calendar.scheduleRefresh = () => {};
let mutations = 0;
(async () => {
  stub('listBookings', async () => []);
  stub('getBookingEntitlement', async () => ({ selfBookingLimit: 2 }));
  stub('bookSlot', async () => { mutations++; return { ok: false, status: 401 }; });
  await db.runWithGymContext(userId, gymId, async () => {
    const r = await service.book(userId, { eventId: 'fixture-class', slotIds: ['one'] }, { retryAuth: false });
    assert.equal(r.status, 401); assert.equal(mutations, 1, 'guarded mutation never retries an authentication refusal');
  });
  stub('swapSpots', async (_id, _from, _to, _session, options) => {
    mutations++; assert.deepEqual(options, { allowCancelRebook: false }); return { ok: true };
  });
  await db.runWithGymContext(userId, gymId, () => service.swap(userId, { bookingId: 'own', currentSlotId: 'one', targetSlotId: 'two' }, { atomicOnly: true, retryAuth: false }));
  stub('listBookings', async () => [{ bookingId: 'own', eventId: 'event' }, { bookingId: 'guest', eventId: 'event', isGuest: true }]);
  stub('cancelBooking', async () => { mutations++; return true; });
  const before = mutations;
  await assert.rejects(() => db.runWithGymContext(userId, gymId, () => service.cancel(userId, { bookingId: 'own' }, { singleOnly: true, retryAuth: false })), e => e.code === 'SINGLE_BOOKING_REQUIRED');
  assert.equal(mutations, before, 'guarded cancellation cannot fan out to guests');
  await assert.rejects(() => db.runWithGymContext(userId, gymId, () => service.cancel(userId, { bookingId: 'not-owned' }, { singleOnly: true, retryAuth: false })), e => e.code === 'SINGLE_BOOKING_REQUIRED');
  assert.equal(mutations, before, 'unknown booking cannot reach cancellation');
  provider.listBookings = async () => [{ bookingId: 'own', eventId: 'event' }];
  const cancelled = await db.runWithGymContext(userId, gymId, () => service.cancel(userId, { bookingId: 'own' }, { singleOnly: true, retryAuth: false }));
  assert.equal(cancelled.ok, true); assert.equal(mutations, before + 1);
  const MarianaTek = require('./providers/marianatek');
  const paymentProvider = Object.create(MarianaTek.prototype);
  paymentProvider.getClassPaymentOptions = async () => ({ user: [
    { id: 'purchase-option', card_payment: {} }, { id: 'existing-pass', membership_payment: {} },
  ], guest: [] });
  assert.equal(await paymentProvider.resolvePaymentOption('event', {}), 'purchase-option', 'native selection behavior is preserved');
  assert.equal(await paymentProvider.resolvePaymentOption('event', {}, { existingCreditOnly: true }), 'existing-pass', 'guarded booking uses an existing entitlement');
  paymentProvider.getClassPaymentOptions = async () => ({ user: [{ id: 'purchase-option', card_payment: {} }], guest: [] });
  assert.equal(await paymentProvider.resolvePaymentOption('event', {}, { existingCreditOnly: true }), null, 'guarded booking cannot select monetary or unknown payment types');
  console.log('PASS normalized mutation boundary: no auth retry, atomic-only edit, owned single cancellation');
})().catch(err => { console.error('FAIL normalized mutations:', err.message); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of originals) provider[key] = value;
  calendar.scheduleRefresh = originalRefresh;
});
