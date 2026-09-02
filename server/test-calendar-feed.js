// Sweat Assistant — calendar.js adapter-routing regression test (WP-N3, calendar half).
//
// calendar.js's fetchUserBookings/fetchUserWaitlists used to call raw
// poller.fetchCodexFit() for the /bookings and /waitlists LIST endpoints. This
// swaps that list call onto codexfit.listBookings()/listWaitlists() (WP-T1's
// new adapter methods) behind a 401-triggers-relogin ladder (listWithRelogin),
// exactly mirroring scheduler.js's/poller.js's bookSlotWithRelogin pattern.
// Deliberately UNCHANGED: fetchEventDetail's per-event enrichment fetch (still
// raw poller.fetchCodexFit — the adapter's own fetchEventDetails is
// intentionally minimal for CodexFit, see its doc comment) and the exact
// downstream field reads (b.slot for slotLabel, etc).
//
// This test proves the adapter-routing swap itself works, independent of the
// mock's own /events/{id} limitation (mock.js's GET /events/{id} doesn't
// populate start_at/name — a PRE-EXISTING gap unrelated to this change, which
// means fetchUserBookings/fetchUserWaitlists' end-to-end result is legitimately
// empty in dev mode even on a real active booking, since the enrichment step
// filters `if (!ev || !ev.startAt) continue`). So this test verifies:
//   1. listWithRelogin('listBookings') returns the correctly normalized array
//      for an active mock booking (proves the adapter-routing swap itself).
//   2. The 401→relogin→retry ladder fires and retries exactly once (isolated,
//      same technique as the N3 scheduler/poller handoffs used, since the mock
//      never naturally produces a 401).
//   3. fetchUserWaitlists (empty waitlist, mock has no /waitlists handler)
//      resolves cleanly to [] with no crash.
//   4. refreshUser() + regenerateSnapshot() run end-to-end without throwing
//      and produce a valid .ics snapshot — proving the full pipeline (incl.
//      the untouched enrichment step) still works after the swap.
//
// SAFETY: same discipline as test-poller-upgrade.js — isolated temp DB,
// mock_bookings.dbjson backed up/restored around the run.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `calendar-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const mockPath = path.join(__dirname, 'mock_bookings.dbjson');
const mockBackup = fs.existsSync(mockPath) ? fs.readFileSync(mockPath) : null;

const db = require('./db');
const calendar = require('./calendar');
const { encrypt } = require('./crypto');
const { getProvider } = require('./providers');
const codexfit = getProvider('psycle-london');

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
  console.log('\n🧪 Calendar feed adapter-routing regression (WP-N3, calendar half)\n');
  try {
    // A real encrypted password (not a placeholder string) — triggerAutoRelogin's
    // 401-retry path below decrypt()s this for real, so it must be valid ciphertext.
    const userId = db.createUser('dev@psycle.com', encrypt('dev-password'));
    db.updateUserJWT(userId, 'mock-jwt-token', new Date(Date.now() + 864e5).toISOString());
    db.setUserSettings(userId, { calendar: { enabled: true, includeTentative: false } });

    // Seed one active mock booking via the real adapter write path (bookSlot),
    // matching how a real user's booking would land in mock_bookings.dbjson.
    const session = { accessToken: 'mock-jwt-token' };
    const booked = await codexfit.bookSlot('1000', ['53'], session);
    assert.strictEqual(booked.ok, true, 'seed booking succeeds against the mock');
    console.log(`✅ Seeded a mock booking (id ${booked.bookingId}) for event 1000.`);

    // --- 1. listWithRelogin('listBookings') proves the adapter-routing swap ---
    const normalized = await calendar.listWithRelogin(userId, 'listBookings');
    assert.ok(Array.isArray(normalized) && normalized.length > 0, 'listWithRelogin returns a non-empty array');
    const entry = normalized.find((nb) => nb.bookingId === booked.bookingId);
    assert.ok(entry, 'the seeded booking is present in the normalized list');
    assert.strictEqual(entry.eventId, '1000', 'eventId correctly normalized');
    assert.strictEqual(entry.isWaitlist, false);
    assert.ok(entry.raw, 'raw booking preserved for downstream field reads (e.g. slotLabel)');
    console.log('✅ calendar.listWithRelogin(\'listBookings\') routes through the adapter and returns the seeded booking.');

    // --- 2. 401 → relogin → retry ladder ---------------------------------------
    // calendar.js destructures `const { triggerAutoRelogin } = require('./auth')`
    // at load time (same pattern scheduler.js/poller.js use), so patching
    // auth.triggerAutoRelogin from outside wouldn't reach calendar.js's already-
    // bound copy. Instead, stub the actual network boundary triggerAutoRelogin
    // itself calls — codexfit.login() (the same singleton this test already holds
    // via getProvider) — so the REAL triggerAutoRelogin runs end-to-end (decrypts
    // the real encrypted password, calls login, persists the new JWT via
    // db.updateUserJWT) with only the outbound HTTP login call faked. A stronger
    // test than stubbing triggerAutoRelogin away: it proves auth.js's real ladder
    // logic works too, not just calendar.js's glue around it.
    const originalListBookings = codexfit.listBookings;
    const originalLogin = codexfit.login;
    let callCount = 0;
    codexfit.listBookings = async (s) => {
      callCount += 1;
      if (callCount === 1) { const err = new Error('mock 401'); err.status = 401; throw err; }
      assert.strictEqual(s.accessToken, 'fresh-mock-token', 'retry uses the freshly-relogged-in token');
      return [];
    };
    codexfit.login = async () => ({
      session: { accessToken: 'fresh-mock-token' },
      profile: {},
      raw: { access_token: 'fresh-mock-token', user: {} },
    });
    try {
      const result = await calendar.listWithRelogin(userId, 'listBookings');
      assert.deepStrictEqual(result, [], 'retry succeeds and returns the (stubbed) result');
      assert.strictEqual(callCount, 2, 'listBookings called exactly twice: stale-token 401, then fresh-token success');
      assert.strictEqual(db.getUserById(userId).jwt, 'fresh-mock-token', 'triggerAutoRelogin persisted the fresh token via db.updateUserJWT');
      console.log('✅ 401 on listBookings triggers the real triggerAutoRelogin ladder and retries exactly once with the fresh token.');
    } finally {
      codexfit.listBookings = originalListBookings;
      codexfit.login = originalLogin;
      // The real triggerAutoRelogin persisted 'fresh-mock-token' via db.updateUserJWT
      // above — a faithful side effect, but 'fresh-mock-token' isn't the mock
      // sentinel ('mock-jwt-token'), so it would silently fall through to a REAL
      // network fetch on the next call. Restore the sentinel so the remaining
      // steps keep routing through the mock, same discipline as every other
      // test's mock-token seeding.
      db.updateUserJWT(userId, 'mock-jwt-token', new Date(Date.now() + 864e5).toISOString());
    }

    // --- 3. fetchUserWaitlists resolves cleanly (mock has no active waitlists) ---
    const waitlists = await calendar.fetchUserWaitlists(userId);
    assert.deepStrictEqual(waitlists, [], 'no waitlist entries — resolves to an empty array without throwing');
    console.log('✅ calendar.fetchUserWaitlists resolves cleanly to [] via the adapter.');

    // --- 4. Full pipeline: refreshUser + regenerateSnapshot produce a real feed -
    // mock.js's GET /events/{id} was enriched 2026-07-03 (from a real browser
    // capture, since deleted) to actually return start_at/instructor/etc — closing
    // the gap that used to make this step's class count legitimately-but-silently
    // 0. Now asserted for real: the seeded booking should survive
    // fetchEventDetail's enrichment and appear as a confirmed class.
    await calendar.refreshUser(userId);
    const snapshot = calendar.regenerateSnapshot(userId);
    assert.ok(snapshot && typeof snapshot.ics === 'string' && snapshot.etag, 'regenerateSnapshot produces a valid .ics snapshot');
    assert.ok(snapshot.ics.startsWith('BEGIN:VCALENDAR'), 'snapshot is a well-formed iCalendar document');
    assert.ok(snapshot.count > 0, 'the seeded booking survives enrichment and appears as a confirmed class (mock.js now returns real event metadata)');
    assert.ok(snapshot.ics.includes('CONFIRMED') || snapshot.ics.includes('SUMMARY'), 'feed contains a real VEVENT, not just an empty calendar shell');
    console.log(`✅ refreshUser + regenerateSnapshot produce a real feed with ${snapshot.count} class(es) — mock.js's event-detail fidelity fix confirmed end-to-end.`);

    console.log('\n🎉 CALENDAR FEED ADAPTER-ROUTING CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ Calendar feed test FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
