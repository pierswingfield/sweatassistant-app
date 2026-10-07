// C5-1: paused_no_credits auto-upgrade monitors resume.
//
// poller.js sets status 'paused_no_credits' when a metered gym's balance is
// empty, but getActiveAutoUpgrades() only selects 'active', so a paused monitor
// stayed dead after the member topped up. executeAutoUpgradeChecks() now
// re-checks paused monitors against THEIR OWN gym's credits, once per
// user+gym per cycle, and resumes them when the class is affordable.
//
// Credits are stubbed on the real provider instance (getProvider caches one per
// gym), so the poller's real code path runs and only the network read is faked.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `poller-resume-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

// Booking against the mock mutates a git-tracked fixture: back up + restore.
const mockPath = path.join(__dirname, 'mock_bookings.dbjson');
const mockBackup = fs.existsSync(mockPath) ? fs.readFileSync(mockPath) : null;

const db = require('./db');
const poller = require('./poller');
const scheduler = require('./scheduler');
const { getProvider } = require('./providers');

function cleanup() {
  try {
    if (mockBackup !== null) fs.writeFileSync(mockPath, mockBackup);
    else if (fs.existsSync(mockPath)) fs.unlinkSync(mockPath);
  } catch (_) { /* best effort */ }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
}

const provider = getProvider('psycle-london');
let creditsNow = [];
let creditsThrows = false;
let creditReads = 0;
provider.getCredits = async () => {
  creditReads++;
  if (creditsThrows) throw new Error('boom');
  return creditsNow;
};

const statusOf = (userId, id) => db.getUserAutoUpgrades(userId).find(r => r.id === id).status;

(async () => {
  let failed = 0;
  console.log('\n🧪 C5-1: paused_no_credits monitors resume\n');
  try {
    const userId = db.createUser('dev@psycle.com', 'x');
    db.updateUserJWT(userId, 'mock-jwt-token', new Date(Date.now() + 864e5).toISOString());

    // Preferred slot 99 is not in the mock layout, so a RESUMED monitor finds
    // nothing to upgrade to: these cases test the status transition only.
    const prefs = { preferredSlots: [99], preferredRows: [] };
    db.setStudioPreference(userId, 138, prefs);
    const far = () => new Date(Date.now() + 3 * 864e5).toISOString();
    const add = (eventId, startAt, p = prefs) => {
      db.addAutoUpgrade(userId, eventId, 100000 + eventId, 25, 'Ride 45', 'Instructor', 'Ride Studio', 'Mortimer Street', startAt, p, 138, 'Ride');
      return db.getUserAutoUpgrades(userId).find(r => Number(r.event_id) === eventId).id;
    };
    const pause = (id) => db.updateAutoUpgrade(id, userId, 'paused_no_credits', 'No credits available to claim upgraded slot.',
      { lastCheckedAt: new Date(Date.now() - 3600e3).toISOString() });

    // 1. Still broke: stays paused.
    const a = add(1000, far());
    pause(a);
    creditsNow = [{ typeId: '3', typeName: 'Ride Only', count: 0 }];
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, a), 'paused_no_credits', 'zero balance stays paused');
    console.log('✅ Zero credits: monitor stays paused_no_credits.');

    // 2. Only guest-only credits: still broke.
    pause(a);
    creditsNow = [{ typeId: '2', typeName: 'Guest', count: 4, isGuestOnly: true }];
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, a), 'paused_no_credits', 'guest-only credits do not resume');
    console.log('✅ Guest-only credits: stays paused.');

    // 3. Credit read fails: "not loaded" is not zero and not enough — unchanged.
    pause(a);
    creditsThrows = true;
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, a), 'paused_no_credits', 'failed read leaves it paused');
    creditsThrows = false;
    console.log('✅ Credit read failure: stays paused (no false resume).');

    // 4. Topped up: resumes.
    pause(a);
    creditsNow = [{ typeId: '3', typeName: 'Ride Only', count: 2 }];
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, a), 'active', 'monitor resumes once credits exist');
    console.log('✅ Credits added: monitor resumes to active.');

    // 5. Rate-limited gym: no credit read at all, stays paused.
    pause(a);
    scheduler.applyRateLimitBackoff('psycle-london', 60000);
    creditReads = 0;
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(creditReads, 0, 'no provider read while the gym is backed off');
    assert.strictEqual(statusOf(userId, a), 'paused_no_credits');
    scheduler._resetRateLimitBackoffForTests();
    console.log('✅ C2-3 backoff respected: no credits read, stays paused.');

    // 6. One credits read per user+gym per cycle across several paused monitors.
    const b = add(1001, far()), c = add(1002, far());
    pause(a); pause(b); pause(c);
    creditReads = 0;
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(creditReads, 1, 'one credits read for three paused monitors of one user+gym');
    for (const id of [a, b, c]) assert.strictEqual(statusOf(userId, id), 'active');
    console.log('✅ Three paused monitors, one credits read.');

    // 7. Recently checked paused monitor is not re-polled every minute.
    db.updateAutoUpgrade(a, userId, 'paused_no_credits', 'x', { lastCheckedAt: new Date().toISOString() });
    creditReads = 0;
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(creditReads, 0, 'paused monitor checked <15min ago is skipped');
    assert.strictEqual(statusOf(userId, a), 'paused_no_credits');
    console.log('✅ Paused monitors respect the polling interval.');

    // 8. Cutoff passed: never resumes (stopped instead of left paused forever).
    const soon = add(1003, new Date(Date.now() + 6 * 3600e3).toISOString());
    pause(soon);
    await poller.executeAutoUpgradeChecks();
    assert.notStrictEqual(statusOf(userId, soon), 'active', '<12h without keepOriginalOnCutoff must not resume');
    assert.strictEqual(statusOf(userId, soon), 'stopped');
    const imminent = add(1004, new Date(Date.now() + 30 * 60e3).toISOString(), { ...prefs, keepOriginalOnCutoff: true });
    pause(imminent);
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, imminent), 'stopped', '<1h never resumes');
    console.log('✅ Cutoff-passed monitors do not resume (stopped).');

    // 9. Inside 12h but opted in to the final attempt: resumes so it can run.
    const keep = add(1005, new Date(Date.now() + 6 * 3600e3).toISOString(), { ...prefs, keepOriginalOnCutoff: true });
    pause(keep);
    await poller.executeAutoUpgradeChecks();
    assert.notStrictEqual(statusOf(userId, keep), 'paused_no_credits', 'keepOriginalOnCutoff monitor gets its final attempt');
    console.log('✅ keepOriginalOnCutoff monitor inside 12h resumes for its final attempt.');

    // 10. Accepted-type awareness: a cached event that only accepts type 8.
    const d = add(1006, far());
    scheduler.setCachedEvent('psycle-london', '1006', { event: { id: '1006', credits: { required: 1, acceptedTypeIds: ['8'] } }, slots: [] }, 60000);
    pause(d);
    creditsNow = [{ typeId: '3', typeName: 'Ride Only', count: 5 }];
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, d), 'paused_no_credits', 'credits of a type the class does not accept do not resume it');
    pause(d);
    creditsNow = [{ typeId: '8', typeName: 'Extended Booking', count: 1 }];
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(statusOf(userId, d), 'active', 'accepted type resumes');
    console.log('✅ Accepted credit types honoured where the event is known.');

    console.log('\n🎉 C5-1 PAUSED-UPGRADE RESUME CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ C5-1 test FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
