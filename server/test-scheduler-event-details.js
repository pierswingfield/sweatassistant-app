// Auto-book must use the provider's normalized event-details contract. The
// provider endpoint differs across platforms (CodexFit /events, MarianaTek
// /classes), and provider ids may collide between gyms.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const scheduler = require('./scheduler');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');
const { normalizeAutoBookPreferences, participantsForPreferences } = require('./auto-book-preferences');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function makeUser(label, gymId = JAB) {
  const userId = testkit.createUser(db, `scheduler-details-${label}-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(userId, gymId, { encryptedPassword: 'enc:pw' });
  db.setGymSession(userId, gymId, { accessToken: `${gymId}-token-${userId}` });
  return userId;
}

const originalCfDetails = CodexFitProvider.prototype.fetchEventDetails;
const originalMtDetails = MarianaTekProvider.prototype.fetchEventDetails;
const originalCfBook = CodexFitProvider.prototype.bookSlot;
const originalMtBook = MarianaTekProvider.prototype.bookSlot;

function restore() {
  CodexFitProvider.prototype.fetchEventDetails = originalCfDetails;
  MarianaTekProvider.prototype.fetchEventDetails = originalMtDetails;
  CodexFitProvider.prototype.bookSlot = originalCfBook;
  MarianaTekProvider.prototype.bookSlot = originalMtBook;
}

const normalized = (id) => ({
  event: { id: String(id), name: 'Boxing', credits: undefined },
  slots: [
    { id: 'available', label: 'Bag 1', y: 0, isAvailable: true },
    { id: 'taken', label: 'Bag 2', y: 0, isAvailable: false },
  ],
  objects: [],
});

check('prefetch calls each gym provider independently when provider event ids collide', async () => {
  const calls = [];
  CodexFitProvider.prototype.fetchEventDetails = async function (eventId) {
    calls.push({ gymId: this.gym.id, eventId: String(eventId) });
    return normalized(eventId);
  };
  MarianaTekProvider.prototype.fetchEventDetails = async function (eventId) {
    calls.push({ gymId: this.gym.id, eventId: String(eventId) });
    return normalized(eventId);
  };

  try {
    await scheduler.prefetchAutoBookSlots([
      { user_id: 1, gym_id: PSYCLE, event_id: '93001' },
      { user_id: 2, gym_id: JAB, event_id: '93001' },
    ], 0);

    assert.deepStrictEqual(calls.sort((a, b) => a.gymId.localeCompare(b.gymId)), [
      { gymId: JAB, eventId: '93001' },
      { gymId: PSYCLE, eventId: '93001' },
    ]);
    assert.deepStrictEqual(scheduler.getCachedEvent(PSYCLE, '93001').slots.map((s) => s.id), ['available', 'taken']);
    assert.deepStrictEqual(scheduler.getCachedEvent(JAB, '93001').slots.map((s) => s.id), ['available', 'taken']);
  } finally {
    restore();
  }
});

check('JAB auto-book reads normalized MarianaTek event details and books an available slot', async () => {
  const userId = makeUser('execute');
  const calls = [];
  let bookedSlot = null;
  MarianaTekProvider.prototype.fetchEventDetails = async function (eventId) {
    calls.push(String(eventId));
    return normalized(eventId);
  };
  MarianaTekProvider.prototype.bookSlot = async function (_eventId, slotIds) {
    bookedSlot = slotIds[0];
    return { ok: true, bookingId: 'jab-booking-1', slotId: bookedSlot };
  };

  try {
    await scheduler.executeAutoBookForClass({
      user_id: userId,
      gym_id: JAB,
      event_id: '93002',
      studio_id: null,
      start_at: new Date(Date.now() + 3 * 864e5).toISOString(),
      group_name: 'BOXING',
      class_name: 'Boxing',
      instructor_name: 'Coach',
      preferences: JSON.stringify({ preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true }),
    });

    assert.deepStrictEqual(calls, ['93002'], 'scheduler should request details through the JAB provider');
    assert.strictEqual(bookedSlot, 'available', 'scheduler should derive availability from normalized slots');
  } finally {
    restore();
  }
});

check('multi-spot booking keeps a failed preferred attempt in the same spatial plan before nearby fallback', async () => {
  const userId = makeUser('spatial-fallback', PSYCLE);
  const calls = [];
  CodexFitProvider.prototype.fetchEventDetails = async () => ({
    event: { id: '93004', name: 'Ride' },
    slots: [
      { id: 'alpha', label: '99', x: 0, y: 0, isAvailable: true },
      { id: 'bravo', label: '1', x: 1, y: 0, isAvailable: false },
      { id: 'charlie', label: '2', x: 2, y: 0, isAvailable: true },
      { id: 'foxtrot', label: '3', x: 0, y: 1, isAvailable: true },
      { id: 'golf', label: '4', x: 1, y: 1, isAvailable: true },
      { id: 'hotel', label: '5', x: 2, y: 1, isAvailable: true },
    ], objects: [],
  });
  CodexFitProvider.prototype.bookSlot = async function (_eventId, slotIds) {
    const slotId = slotIds[0];
    calls.push(slotId);
    if (slotId === 'alpha') return { ok: false, message: 'just taken' };
    return { ok: true, bookingId: `psycle-${slotId}`, slotId };
  };

  try {
    await scheduler.executeAutoBookForClass({
      user_id: userId, gym_id: PSYCLE, event_id: '93004', studio_id: null,
      start_at: new Date(Date.now() + 3 * 864e5).toISOString(), group_name: 'RIDE',
      class_name: 'Ride', instructor_name: 'Coach',
      preferences: JSON.stringify({ preferredSlots: ['alpha', 'charlie'], preferredRows: [], requiredCount: 2, bookAny: true }),
    });
    assert.deepStrictEqual(calls, ['alpha', 'charlie', 'foxtrot'], 'after a failed preferred slot, preserve map order then choose a nearby fallback');
  } finally {
    restore();
  }
});

check('multi-spot auto-book with Auto-Upgrade registers ONE group monitor carrying the together flag', async () => {
  const userId = makeUser('group-upgrade', PSYCLE);
  CodexFitProvider.prototype.fetchEventDetails = async () => ({
    event: { id: '93006', name: 'Ride' },
    slots: [
      { id: 'p1', label: '1', x: 0, y: 0, isAvailable: true },
      { id: 'p2', label: '2', x: 1, y: 0, isAvailable: true },
      { id: 'p3', label: '3', x: 2, y: 0, isAvailable: true },
    ], objects: [],
  });
  let n = 0;
  CodexFitProvider.prototype.bookSlot = async function (_e, slotIds) { return { ok: true, bookingId: `${7000 + ++n}`, slotId: slotIds[0] }; };
  try {
    await scheduler.executeAutoBookForClass({
      user_id: userId, gym_id: PSYCLE, event_id: '93006', studio_id: 55,
      start_at: new Date(Date.now() + 3 * 864e5).toISOString(), group_name: 'RIDE',
      class_name: 'Ride', instructor_name: 'Coach',
      preferences: JSON.stringify({ preferredSlots: ['p1', 'p2'], preferredRows: [], requiredCount: 2, bookAny: true, autoUpgrade: true, prioritizeTogether: true }),
    });
    const monitors = db.db.prepare("SELECT * FROM auto_upgrades WHERE user_id = ? AND event_id = '93006'").all(userId);
    assert.strictEqual(monitors.length, 1, 'one monitor for the whole group, not one per seat');
    assert.strictEqual(monitors[0].gym_id, PSYCLE);
    assert.strictEqual(db.getAutoUpgradeMembers(monitors[0].id).length, 2, 'both reservations are members');
    assert.strictEqual(JSON.parse(monitors[0].preferences).prioritizeTogether, true, 'together flag carried over');
  } finally {
    restore();
  }
});

check('scheduled named guest uses the primary first, persists both outcomes, and does not spend a second self place', async () => {
  const userId = makeUser('scheduled-guest');
  const preferences = normalizeAutoBookPreferences({ requiredCount: 2, guests: [{ email: 'guest@example.test', name: 'Sam' }], bookAny: true });
  const queueId = db.addAutoBooking(userId, '93005', 'Boxing', 'Coach', 'Studio', '', new Date(Date.now() + 3 * 864e5).toISOString(), preferences, null, 'BOXING', null, JAB);
  db.replaceAutoBookingParticipants(queueId, userId, JAB, '93005', participantsForPreferences(preferences));
  const calls = [];
  MarianaTekProvider.prototype.fetchEventDetails = async () => ({ event: { id: '93005', name: 'Boxing' }, slots: [
    { id: 'self-slot', label: '1', x: 0, y: 0, isAvailable: true },
    { id: 'guest-slot', label: '2', x: 1, y: 0, isAvailable: true },
    { id: 'spacing-slot', label: '3', x: 2, y: 0, isAvailable: true },
  ], objects: [] });
  MarianaTekProvider.prototype.bookSlot = async (_eventId, slotIds) => { calls.push(`self:${slotIds[0]}`); return { ok: true, bookingId: 'primary-93005', slotId: slotIds[0] }; };
  MarianaTekProvider.prototype.bookGuestSlot = async (_eventId, slotId, email) => { calls.push(`guest:${slotId}:${email}`); return { ok: true, bookingId: 'guest-93005', slotId }; };
  try {
    const booking = db.getUserAutoBookings(userId, JAB).find((row) => Number(row.id) === Number(queueId));
    await scheduler.executeAutoBookForClass(booking);
    assert.deepStrictEqual(calls, ['self:self-slot', 'guest:guest-slot:guest@example.test']);
    assert.deepStrictEqual(db.getAutoBookingParticipants(queueId, userId).map((row) => [row.participant_key, row.status, row.booking_id]), [['self', 'success', 'primary-93005'], ['guest:guest@example.test', 'success', 'guest-93005']]);
    assert.deepStrictEqual(db.getGuestBookingIdsForPrimary(userId, JAB, 'primary-93005'), ['guest-93005']);
    await scheduler.executeAutoBookForClass(db.getUserAutoBookings(userId, JAB).find((row) => Number(row.id) === Number(queueId)));
    assert.deepStrictEqual(calls, ['self:self-slot', 'guest:guest-slot:guest@example.test'], 'durable successes are not retried after re-entry');
  } finally { restore(); }
});

check('JAB Auto-Book clamps a stale multi-attendee preference to one reservation', async () => {
  const userId = makeUser('single-attendee');
  const calls = [];
  MarianaTekProvider.prototype.fetchEventDetails = async () => normalized('93003');
  MarianaTekProvider.prototype.bookSlot = async function (eventId, slotIds) {
    calls.push({ eventId: String(eventId), slotId: slotIds[0] });
    return { ok: true, bookingId: `jab-${calls.length}`, slotId: slotIds[0] };
  };

  try {
    await scheduler.executeAutoBookForClass({
      user_id: userId,
      gym_id: JAB,
      event_id: '93003',
      studio_id: null,
      start_at: new Date(Date.now() + 3 * 864e5).toISOString(),
      group_name: 'BOXING',
      class_name: 'Boxing',
      instructor_name: 'Coach',
      preferences: JSON.stringify({ preferredSlots: [], preferredRows: [], requiredCount: 4, bookAny: true }),
    });
    assert.strictEqual(calls.length, 1, 'JAB capability maxSpotsPerClass=1 must cap stale queue preferences');
  } finally {
    restore();
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.stack || err.message}`);
    }
  }
  restore();
  if (failed) process.exit(1);
  console.log(`\n${checks.length} checks passed.`);
})();
