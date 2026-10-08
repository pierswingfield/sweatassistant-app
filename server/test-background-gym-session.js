// C3-12 — background auto-book/auto-upgrade must use the ROW'S gym session,
// never the user's ambient "active" gym.
//
// scheduler.js's bookSlotWithRelogin/fetchFromGym and poller.js's
// bookSlotWithRelogin/swapSpotsWithRelogin/fetchFromGym all read the session
// token via `db.getUserById(userId).jwt` — which resolves through
// `mergeUserWithGym(user, resolveActiveGymId(userId))`, i.e. the user's ACTIVE
// gym (default gym when no request context, which background work never has —
// see db.js's own comment on gymContext and test-active-gym.js's "background
// work (no context, several links) resolves deterministically" case).
//
// Every one of these call sites is handed the ROW's own gymId as an explicit
// argument already — the bug is that they then throw it away and read the
// session for a DIFFERENT gym. A two-gym user whose active gym is
// psycle-london with a pending jab-boxing auto-book/auto-upgrade row gets
// Psycle's token sent to MarianaTek.
//
// Fix: read the session via `db.getUserSession(userId, gymId)`, the existing
// per-gym-explicit accessor already used correctly elsewhere in both files
// (poller.js's attemptUpgradeSlot event-details fetch, listBookingsWithRelogin,
// bookingCacheRowsFor, sendBookingWindowTip).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const scheduler = require('./scheduler');
const poller = require('./poller');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

const PSYCLE = 'psycle-london'; // codexfit — the user's ACTIVE (default) gym
const JAB = 'jab-boxing';       // marianatek — the ROW's gym
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let seq = 0;
function twoGymUser(label) {
  const uid = testkit.createUser(db, `bgsession-${label}-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  assert.strictEqual(db.resolveActiveGymId(uid), PSYCLE, 'sanity: the earliest-linked gym (psycle) is the active one');
  db.linkGym(uid, JAB, { encryptedPassword: 'enc:pw' });
  // Distinct tokens per gym so a cross-read is unmistakable.
  db.setGymSession(uid, PSYCLE, { accessToken: `PSYCLE-TOKEN-${uid}` });
  db.setGymSession(uid, JAB, { accessToken: `JAB-TOKEN-${uid}` });
  // No runWithGymContext anywhere in this test — this is exactly what the
  // scheduler/poller cron sees: no request, no per-request gym.
  assert.strictEqual(db.resolveActiveGymId(uid), PSYCLE, 'active gym is still Psycle (the default) with no context');
  return uid;
}

const originalMTBookSlot = MarianaTekProvider.prototype.bookSlot;
const originalMTSwapSpots = MarianaTekProvider.prototype.swapSpots;
const originalMTRequest = MarianaTekProvider.prototype.request;
const originalMTListBookings = MarianaTekProvider.prototype.listBookings;

function restoreAll() {
  MarianaTekProvider.prototype.bookSlot = originalMTBookSlot;
  MarianaTekProvider.prototype.swapSpots = originalMTSwapSpots;
  MarianaTekProvider.prototype.request = originalMTRequest;
  MarianaTekProvider.prototype.listBookings = originalMTListBookings;
}

// --- 1. scheduler.js: bookSlotWithRelogin (auto-book) ------------------------

check('scheduler auto-book for a JAB queue row uses the JAB session, not the active (Psycle) one', async () => {
  const uid = twoGymUser('sched');
  const eventId = '9100';
  const slotId = 'mock-bag-1';
  scheduler.setCachedEvent(JAB, eventId, {
    event: { id: eventId },
    slots: [{ id: slotId, label: 'Bag 1', isAvailable: true }],
    objects: [],
  }, 60000);

  let capturedToken = null;
  MarianaTekProvider.prototype.bookSlot = async function (evId, slotIds, session) {
    capturedToken = session && session.accessToken;
    return { ok: true, bookingId: 'mt-book-1', slotId: slotIds[0] };
  };

  try {
    await scheduler.executeAutoBookForClass({
      user_id: uid,
      gym_id: JAB,
      event_id: eventId,
      studio_id: null,
      start_at: new Date(Date.now() + 3 * 864e5).toISOString(),
      group_name: 'BOXING',
      class_name: 'BOXING Core',
      instructor_name: 'Coach',
      preferences: JSON.stringify({ preferredSlots: [slotId], requiredCount: 1, bookAny: true }),
    });

    assert.ok(capturedToken, 'provider.bookSlot must have been called');
    assert.strictEqual(capturedToken, `JAB-TOKEN-${uid}`,
      `expected the JAB row to be booked with JAB's own session token, got ${JSON.stringify(capturedToken)} `
      + '(if this is the Psycle token, the scheduler read the ACTIVE gym\'s session instead of the row\'s own gym)');
  } finally {
    MarianaTekProvider.prototype.bookSlot = originalMTBookSlot;
  }
});

// --- 2. poller.js: swapSpotsWithRelogin (auto-upgrade, atomic-swap gym) ------

check('poller auto-upgrade atomic swap for a JAB monitor uses the JAB session, not the active (Psycle) one', async () => {
  const uid = twoGymUser('atomic');
  const eventId = '9200';
  const studioId = 'mock-room-BOXING';
  const currentSlot = 'mock-bag-3';
  const preferredSlot = 'mock-bag-1';

  scheduler.setCachedEvent(JAB, eventId, {
    slots: [
      { id: preferredSlot, label: 'Bag 1', isAvailable: true, y: 0 },
      { id: currentSlot, label: 'Bag 3', isAvailable: false, y: 0 },
    ],
  }, 60000);

  const prefs = { preferredSlots: [preferredSlot], preferredRows: [] };
  db.addAutoUpgrade(uid, eventId, 'mt-orig-booking', currentSlot, 'BOXING Core', 'Coach', 'BOXING', 'SW1',
    new Date(Date.now() + 2 * 864e5).toISOString(), prefs, studioId, 'BOXING', JAB);
  db.setStudioPreference(uid, studioId, prefs, JAB);

  let listToken = null;
  MarianaTekProvider.prototype.listBookings = async function (session) {
    listToken = session && session.accessToken;
    return [{ bookingId: 'mt-orig-booking', eventId, isWaitlist: false }];
  };
  let capturedToken = null;
  MarianaTekProvider.prototype.swapSpots = async function (bookingId, curSlot, targetSlot, session) {
    capturedToken = session && session.accessToken;
    return { ok: true, bookingId: 'mt-swap-1' };
  };

  try {
    await poller.executeAutoUpgradeChecks();

    assert.strictEqual(listToken, `JAB-TOKEN-${uid}`, 'the still-booked check must use the row\'s own gym session');
    assert.ok(capturedToken, 'provider.swapSpots must have been called');
    assert.strictEqual(capturedToken, `JAB-TOKEN-${uid}`,
      `expected the JAB monitor to swap with JAB's own session token, got ${JSON.stringify(capturedToken)} `
      + '(if this is the Psycle token, the poller read the ACTIVE gym\'s session instead of the row\'s own gym)');
  } finally {
    MarianaTekProvider.prototype.swapSpots = originalMTSwapSpots;
    MarianaTekProvider.prototype.listBookings = originalMTListBookings;
  }
});

// --- 3. poller.js: fetchFromGym (exported directly) --------------------------

check('poller.fetchFromGym for JAB uses the JAB session, not the active (Psycle) one', async () => {
  const uid = twoGymUser('fetch');

  let capturedToken = null;
  MarianaTekProvider.prototype.request = async function (path, opts = {}) {
    capturedToken = opts.token;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    await poller.fetchFromGym(uid, JAB, '/profile');
    assert.strictEqual(capturedToken, `JAB-TOKEN-${uid}`,
      `expected fetchFromGym(JAB) to use JAB's own session token, got ${JSON.stringify(capturedToken)}`);
  } finally {
    MarianaTekProvider.prototype.request = originalMTRequest;
  }
});

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-12: background gym-session routing\n');
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err.stack || err.message}`);
    }
  }
  restoreAll();
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} background-gym-session checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} background-gym-session checks passed.`);
})();
