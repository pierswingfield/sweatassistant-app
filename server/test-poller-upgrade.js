// Sweat Assistant — poller auto-upgrade regression test (WP-N3 poller wiring).
//
// The auto-upgrade path had NO automated coverage (unlike auto-book, which the
// Psycle regression harness exercises via /api/simulate-release). This is the
// safety net for wiring poller.js's booking attempt through the CodexFit adapter
// (bookSlotWithRelogin -> codexfit.bookSlot).
//
// In-process integration test: seed an auto-upgrade monitor sitting on a worse
// slot than an available preferred slot, run the real cron worker body
// (executeAutoUpgradeChecks) against the dev CodexFit mock, and assert the
// monitor upgraded to the better slot — proving the adapter path books
// end-to-end and the monitor state updates identically to before.
//
// SAFETY: booking against the mock mutates the git-tracked mock_bookings.dbjson
// fixture, so this backs it up before and restores it after — the same
// discipline test-regression-psycle.js uses. The DB is an isolated temp file so
// the real dev/prod sqlite is never touched.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test'; // skip rate limiters etc. (parity with other harnesses)

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Isolated temp DB — set before requiring db.js so it opens the temp file.
const tmpDb = path.join(os.tmpdir(), `poller-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

// Back up the git-tracked mock fixture the booking write will mutate.
const mockPath = path.join(__dirname, 'mock_bookings.dbjson');
const mockBackup = fs.existsSync(mockPath) ? fs.readFileSync(mockPath) : null;

const db = require('./db');
const poller = require('./poller');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

// The poller verifies the original booking still exists before upgrading. By
// default the member still holds every seeded monitor's booking; the cancel
// regression below flips `cancelled` to model a member who cancelled it.
let cancelled = false;
const heldFromDb = async () => cancelled ? [] : db.db.prepare('SELECT booking_id, event_id FROM auto_upgrades')
  .all().map(r => ({ bookingId: String(r.booking_id), eventId: String(r.event_id), isWaitlist: false }));
CodexFitProvider.prototype.listBookings = heldFromDb;
MarianaTekProvider.prototype.listBookings = heldFromDb;

function cleanup() {
  try {
    if (mockBackup !== null) fs.writeFileSync(mockPath, mockBackup);
    else if (fs.existsSync(mockPath)) fs.unlinkSync(mockPath);
  } catch (_) { /* best effort */ }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
}

(async () => {
  let failed = 0;
  console.log('\n🧪 Poller auto-upgrade regression (WP-N3 poller wiring)\n');
  try {
    // Seed a dev user: email dev@psycle.com routes fetchCodexFit (profile) to the
    // mock; jwt 'mock-jwt-token' routes codexfit.bookSlot() to the mock. Both are
    // needed because the two halves of attemptUpgradeSlot use different call paths.
    const userId = db.createUser('dev@psycle.com', 'x');
    db.updateUserJWT(userId, 'mock-jwt-token', new Date(Date.now() + 864e5).toISOString());
    assert.strictEqual(db.getUserById(userId).jwt, 'mock-jwt-token', 'dev jwt resolves through user_gyms merge');

    // Mock event 1000 is in studio 138 and reports slots 11..88 available, with a
    // 40-spot layout (slots 11..58). Seat the monitor on slot 25 (worse) with a
    // single preferred slot 11 (best + available). start_at >12h away → not cutoff.
    const startAt = new Date(Date.now() + 2 * 864e5).toISOString();
    const prefs = { preferredSlots: [11], preferredRows: [] };
    db.addAutoUpgrade(userId, 1000, 123456, 25, 'Ride 45', 'Instructor', 'Ride Studio', 'Mortimer Street', startAt, prefs, 138, 'Ride');
    // The shared live studio map is the real source of truth the poller reads.
    db.setStudioPreference(userId, 138, prefs);

    let [row] = db.getUserAutoUpgrades(userId);
    assert.strictEqual(row.status, 'active', 'monitor starts active');
    assert.strictEqual(Number(row.current_slot_id), 25, 'monitor starts on slot 25');
    console.log('✅ Seeded active upgrade monitor on slot 25 (preferred: 11).');

    // Run the exact function the every-minute cron tick runs.
    await poller.executeAutoUpgradeChecks();

    [row] = db.getUserAutoUpgrades(userId);
    assert.strictEqual(Number(row.current_slot_id), 11, 'upgraded to the better preferred slot 11 via the adapter');
    assert.strictEqual(row.status, 'active', 'still active, monitoring for further upgrades');
    assert.strictEqual(Number(row.upgraded_slot_id), 11, 'upgraded_slot_id recorded');
    console.log('✅ Monitor upgraded 25 → 11 through bookSlotWithRelogin → codexfit.bookSlot → mock.');

    // Latent-bug fix: the old inline code read bookData?.id (never present in
    // CodexFit's { bookings: { id: slot } } response) so new_booking_id was always
    // 0. The adapter now yields the real booking id.
    const jabUserId = db.createAccount('dev@jabboxing.mock', 'password123');
    db.upsertUserGym(jabUserId, 'jab-boxing', {
      gym_email: 'dev@jabboxing.mock',
      session_json: JSON.stringify({ accessToken: 'mock-mt-token', refreshToken: 'mock-mt-refresh' }),
      status: 'active'
    });

    const { getProvider } = require('./providers');
    const bookRes = await getProvider('jab-boxing').bookSlot('9000', ['mock-bag-3'], { accessToken: 'mock-mt-token' });
    const jabBookingId = bookRes.bookingId;

    const jabStartAt = new Date(Date.now() + 2 * 864e5).toISOString();
    const jabPrefs = { preferredSlots: ['mock-bag-1'], preferredRows: [] };
    db.runWithGymContext(jabUserId, 'jab-boxing', () => {
      db.addAutoUpgrade(jabUserId, '9000', jabBookingId, 'mock-bag-3', 'BOXING Core', 'George Davies', 'BOXING', 'SW1', jabStartAt, jabPrefs, 'mock-room-BOXING', 'BOXING');
      db.setStudioPreference(jabUserId, 'mock-room-BOXING', jabPrefs);
    });

    let [jabRow] = db.getUserAutoUpgrades(jabUserId);
    assert.strictEqual(jabRow.status, 'active');
    assert.strictEqual(jabRow.current_slot_id, 'mock-bag-3');
    console.log('✅ Seeded JAB active upgrade monitor on mock-bag-3 (preferred: mock-bag-1).');

    await poller.executeAutoUpgradeChecks();

    [jabRow] = db.getUserAutoUpgrades(jabUserId);
    assert.strictEqual(jabRow.current_slot_id, 'mock-bag-1', 'upgraded JAB monitor to mock-bag-1 via atomic swap');
    assert.strictEqual(jabRow.upgraded_slot_id, 'mock-bag-1');
    console.log('✅ JAB monitor upgraded mock-bag-3 → mock-bag-1 through atomic swapSpots.');

    // Regression: cancel a booking, then the monitor must NOT re-book the class.
    cancelled = true;
    db.addAutoUpgrade(userId, 1000, 424242, 25, 'Ride 45', 'Instructor', 'Ride Studio', 'Mortimer Street', startAt, prefs, 138, 'Ride');
    const before = db.getUserAutoUpgrades(userId).find(r => Number(r.booking_id) === 424242);
    await poller.executeAutoUpgradeChecks();
    const after = db.getUserAutoUpgrades(userId).find(r => Number(r.booking_id) === 424242);
    assert.strictEqual(before.status, 'active');
    assert.strictEqual(after.status, 'stopped', 'monitor for a cancelled booking must stop');
    assert.strictEqual(Number(after.current_slot_id), 25, 'and must NOT have booked a better slot');
    assert.ok(!after.upgraded_slot_id, 'no upgrade recorded');
    // Server-side cancel stops live monitors for that booking id only.
    const live = db.addAutoUpgrade(userId, 1000, 515151, 25, 'Ride 45', 'I', 'S', 'L', startAt, prefs, 138, 'Ride');
    assert.strictEqual(db.stopAutoUpgradesForBooking(userId, 'psycle-london', 515151), 1);
    assert.strictEqual(db.getUserAutoUpgrades(userId).find(r => r.id === Number(live)).status, 'stopped');
    console.log('✅ Cancelled booking: monitor stopped, no re-book, stopAutoUpgradesForBooking works.');

    console.log('\n🎉 POLLER AUTO-UPGRADE CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ Poller auto-upgrade test FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
