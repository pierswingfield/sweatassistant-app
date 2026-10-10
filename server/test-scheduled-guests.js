process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const { normalizeAutoBookPreferences, participantsForPreferences } = require('./auto-book-preferences');
const { validateScheduledGuestEligibility } = require('./auto-book-guests');

const GYM = 'jab-boxing';
let n = 0;
function queue(preferences) {
  const userId = testkit.createUser(db, `scheduled-guest-${Date.now()}-${n++}@test.local`, 'enc');
  db.upsertUserGym(userId, GYM, { gym_email: `scheduled-${n}@test.local`, encrypted_password: 'enc' });
  const id = db.addAutoBooking(userId, `event-${n}`, 'Class', '', '', '', new Date().toISOString(), preferences, null, null, null, GYM);
  db.replaceAutoBookingParticipants(id, userId, GYM, `event-${n}`, participantsForPreferences(preferences));
  return { userId, id };
}

(async () => {
  const preferences = normalizeAutoBookPreferences({ requiredCount: 2, guests: [{ email: 'Guest@Example.test', name: 'Sam' }], bookAny: false, prioritizeTogether: true });
  assert.deepStrictEqual(preferences.guests, [{ email: 'guest@example.test', name: 'Sam' }]);
  assert.strictEqual(preferences.requiredCount, 2); assert.strictEqual(preferences.selfCount, 1);
  assert.strictEqual(preferences.bookAny, true, 'togetherness forces fallback');
  const row = queue(preferences);
  assert.deepStrictEqual(db.getAutoBookingParticipants(row.id, row.userId).map(({ participant_key, status }) => [participant_key, status]), [['self', 'pending'], ['guest:guest@example.test', 'pending']]);
  db.markAutoBookingParticipant(row.id, row.userId, 'self', { status: 'success', bookingId: 'host-1', slotId: 'a' });
  db.markAutoBookingParticipant(row.id, row.userId, 'guest:guest@example.test', { status: 'success', bookingId: 'guest-1', slotId: 'b' });
  assert.throws(() => db.replaceAutoBookingParticipants(row.id, row.userId, GYM, `event-${n}`, participantsForPreferences(normalizeAutoBookPreferences({ requiredCount: 2, guests: [{ email: 'other@example.test', name: 'Alex' }] }))), /successful reservation/, 'a successful participant identity is immutable');

  await assert.rejects(() => validateScheduledGuestEligibility({ provider: { getBookingEntitlement: async () => ({ guestSupported: false }) }, eventId: 'e', session: {}, guestCount: 1 }), (err) => err.code === 'GUEST_BOOKING_UNSUPPORTED');
  const temporary = await validateScheduledGuestEligibility({ provider: { getBookingEntitlement: async () => ({ guestSupported: true, guestEligible: false, guestReason: 'NO_GUEST_PASSES', maxGuestBookings: 0 }) }, eventId: 'e', session: {}, guestCount: 1 });
  assert.strictEqual(temporary.warning.code, 'NO_GUEST_PASSES', 'a future guest pass remains queueable with a truthful warning');
  const beforeWindow = await validateScheduledGuestEligibility({ provider: { getBookingEntitlement: async () => ({ guestSupported: true, guestEligible: false, guestReason: 'NO_VALID_GUEST_PAYMENT_OPTION', maxGuestBookings: 0 }) }, eventId: 'future', session: {}, guestCount: 1 });
  assert.strictEqual(beforeWindow.warning.code, 'NO_VALID_GUEST_PAYMENT_OPTION', 'a closed-window guest option remains queueable for runtime recheck');
  const afterPrimary = await validateScheduledGuestEligibility({ provider: { getBookingEntitlement: async () => ({ guestSupported: true, guestEligible: false, guestReason: 'PRIMARY_RESERVATION_REQUIRED', maxGuestBookings: 0 }) }, eventId: 'future', session: {}, guestCount: 1 });
  assert.strictEqual(afterPrimary.warning.code, 'PRIMARY_RESERVATION_REQUIRED', 'a guest that requires the primary remains queueable');
  const unknown = await validateScheduledGuestEligibility({ provider: { getBookingEntitlement: async () => ({ guestSupported: true, guestEligible: true, guestReason: 'GUEST_ALLOWANCE_UNKNOWN', maxGuestBookings: 1 }) }, eventId: 'e', session: {}, guestCount: 1 });
  assert.strictEqual(unknown.warning.code, 'GUEST_ALLOWANCE_UNKNOWN'); // unknown allowance: allowed, re-checked at run time
  assert.throws(() => normalizeAutoBookPreferences({ requiredCount: 3, guests: [{ email: 'a@example.test' }, { email: 'b@example.test' }] }), /one named guest/);

  const atomicUser = testkit.createUser(db, `atomic-${Date.now()}@test.local`, 'enc');
  db.upsertUserGym(atomicUser, GYM, { gym_email: 'atomic@test.local', encrypted_password: 'enc' });
  const atomicPrefs = normalizeAutoBookPreferences({ requiredCount: 2, guests: [{ email: 'atomic-guest@example.test', name: 'Pat' }] });
  const atomicId = db.saveAutoBookingWithStudioDraft({
    mode: 'create', userId: atomicUser, gymId: GYM, eventId: 'atomic-event', preferences: atomicPrefs,
    participants: participantsForPreferences(atomicPrefs), studioDraft: { gymId: GYM, studioId: 'studio-a', preferences: { preferredSlots: ['s1'], preferredRows: [] } },
    booking: { studioId: 'studio-a', className: 'Class', instructorName: '', instructorImageUrl: null, studioName: 'Studio', locationName: '', startAt: new Date().toISOString(), groupName: null, releaseAt: null, durationMin: null },
  });
  assert.deepStrictEqual(db.getStudioPreference(atomicUser, 'studio-a', GYM).preferredSlots, ['s1']);
  assert.strictEqual(db.getAutoBookingParticipants(atomicId, atomicUser).length, 2);
  const before = db.getUserAutoBookings(atomicUser, GYM).find((item) => Number(item.id) === Number(atomicId)).preferences;
  assert.throws(() => db.saveAutoBookingWithStudioDraft({
    mode: 'edit', id: atomicId, userId: atomicUser, gymId: GYM, eventId: 'atomic-event', preferences: { ...atomicPrefs, bookAny: false }, participants: participantsForPreferences(atomicPrefs),
    studioDraft: { gymId: GYM, studioId: 'other-studio', preferences: { preferredSlots: ['bad'], preferredRows: [] } }, booking: { studioId: 'studio-a' },
  }), /class studio/);
  assert.strictEqual(db.getUserAutoBookings(atomicUser, GYM).find((item) => Number(item.id) === Number(atomicId)).preferences, before, 'failed draft edit leaves queue untouched');
  assert.deepStrictEqual(db.getStudioPreference(atomicUser, 'studio-a', GYM).preferredSlots, ['s1'], 'failed draft edit leaves shared map untouched');
  console.log('✅ scheduled guest normalization, durable participant state, immutable successes, eligibility distinctions, and atomic map drafts passed.');
})().catch((err) => { console.error(err); process.exit(1); });
