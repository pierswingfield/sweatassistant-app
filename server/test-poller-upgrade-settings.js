// per-gym auto-upgrade settings drive EXISTING monitors, and
// the 12h / 1h stop rules hold regardless of polling interval.
//
//  - polling OFF for the monitor's gym -> 'paused_disabled' (row survives, not polled)
//  - polling back ON -> resumes to 'active'
//  - the gym's current interval applies to existing monitors
//  - <12h without keepOriginalOnCutoff -> stopped (even with a 1hr interval)
//  - <12h with keepOriginalOnCutoff -> exactly one final attempt, then stopped
//  - <1h -> stopped even with keepOriginalOnCutoff
//  - a paused_disabled monitor still stops when its window closes

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `poller-upgrade-settings-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const mockPath = path.join(__dirname, 'mock_bookings.dbjson');
const mockBackup = fs.existsSync(mockPath) ? fs.readFileSync(mockPath) : null;

const db = require('./db');
const testkit = require('./testkit');
const poller = require('./poller');
const CodexFitProvider = require('./providers/codexfit');
const heldFromDb = async () => db.db.prepare('SELECT booking_id, event_id FROM auto_upgrades')
  .all().map(r => ({ bookingId: String(r.booking_id), eventId: String(r.event_id), isWaitlist: false }));
CodexFitProvider.prototype.listBookings = heldFromDb;

function cleanup() {
  try {
    if (mockBackup !== null) fs.writeFileSync(mockPath, mockBackup);
    else if (fs.existsSync(mockPath)) fs.unlinkSync(mockPath);
  } catch (_) { /* best effort */ }
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
}

const GYM = 'psycle-london';
const row = (userId, id) => db.getUserAutoUpgrades(userId).find(r => r.id === id);

(async () => {
  let failed = 0;
  console.log('\n🧪 Auto-upgrade settings vs existing monitors + cutoff rules\n');
  try {
    const userId = testkit.createUser(db, 'dev@psycle.com', 'x');
    db.updateUserJWT(userId, 'mock-jwt-token', new Date(Date.now() + 864e5).toISOString());
    // Slot 99 is not in the mock layout: an attempt finds nothing better, so
    // status transitions and last_checked_at are all that is observable.
    const prefs = { preferredSlots: [99], preferredRows: [] };
    db.setStudioPreference(userId, 138, prefs);
    const add = (eventId, hoursAway, p = prefs) => {
      db.addAutoUpgrade(userId, eventId, 200000 + eventId, 25, 'Ride 45', 'Instructor', 'Ride Studio', 'Mortimer Street',
        new Date(Date.now() + hoursAway * 3600e3).toISOString(), p, 138, 'Ride');
      return db.getUserAutoUpgrades(userId).find(r => Number(r.event_id) === eventId).id;
    };
    const setGym = (patch) => db.setUserSettings(userId, patch, GYM);
    const longAgo = () => new Date(Date.now() - 2 * 3600e3).toISOString();
    const recent = () => new Date(Date.now() - 2 * 60e3).toISOString();

    // 1. Polling OFF pauses; row and prefs survive; no poll (last_checked unchanged).
    const a = add(1000, 72);
    db.updateAutoUpgrade(a, userId, 'active', 'm', { lastCheckedAt: longAgo() });
    setGym({ autoUpgradeEnabled: false });
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, a).status, 'paused_disabled');
    assert.ok(/polling is off/i.test(row(userId, a).status_message));
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, a).status, 'paused_disabled', 'stays paused while off');
    console.log('✅ Polling off: monitor paused_disabled, not deleted.');

    // 2. Polling ON resumes and polls.
    setGym({ autoUpgradeEnabled: true });
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, a).status, 'active', 'resumes when polling is turned back on');
    console.log('✅ Polling on: monitor resumes to active.');

    // 3. Interval applies to existing monitors (read from the row's gym).
    db.updateAutoUpgrade(a, userId, 'active', 'm', { lastCheckedAt: recent() });
    setGym({ autoUpgradeInterval: '1hr' });
    await poller.executeAutoUpgradeChecks();
    const before = row(userId, a).last_checked_at;
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, a).last_checked_at, before, '1hr interval: checked 2min ago is not re-polled');
    setGym({ autoUpgradeInterval: '1min' });
    await poller.executeAutoUpgradeChecks();
    assert.notStrictEqual(row(userId, a).last_checked_at, before, '1min interval: polled again');
    console.log('✅ Interval change applies to existing monitors.');

    // 4. 12h cutoff: stops without the option, even when the interval gate would skip it.
    setGym({ autoUpgradeInterval: '1hr' });
    const b = add(1001, 11.9);
    db.updateAutoUpgrade(b, userId, 'active', 'm', { lastCheckedAt: recent() });
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, b).status, 'stopped');
    assert.ok(/12h cutoff/.test(row(userId, b).status_message));
    console.log('✅ <12h without keepOriginalOnCutoff: stopped (not interval-gated).');

    // 5. keepOriginalOnCutoff: one final attempt, then stopped.
    const c = add(1002, 11.9, { ...prefs, keepOriginalOnCutoff: true });
    db.updateAutoUpgrade(c, userId, 'active', 'm', { lastCheckedAt: recent() });
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(JSON.parse(row(userId, c).preferences).cutoffAttempted, true, 'final attempt made');
    assert.notStrictEqual(row(userId, c).status, 'stopped', 'still alive right after the final attempt');
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, c).status, 'stopped', 'stops after the one final attempt');
    console.log('✅ keepOriginalOnCutoff: one final attempt then stopped.');

    // 6. <1h: hard stop even with keepOriginalOnCutoff.
    const d = add(1003, 0.5, { ...prefs, keepOriginalOnCutoff: true });
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, d).status, 'stopped');
    assert.ok(/1 hour/.test(row(userId, d).status_message));
    console.log('✅ <1h: hard stop.');

    // 7. Polling off + keepOriginalOnCutoff: no final attempt, stopped at cutoff.
    setGym({ autoUpgradeEnabled: false });
    const e = add(1004, 11.9, { ...prefs, keepOriginalOnCutoff: true });
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, e).status, 'stopped');
    assert.notStrictEqual(JSON.parse(row(userId, e).preferences).cutoffAttempted, true, 'no attempt while polling is off');
    console.log('✅ Polling off: no cutoff attempt is made.');

    // 8. A paused_disabled monitor stops when its window closes.
    const f = add(1005, 72);
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, f).status, 'paused_disabled');
    db.db.prepare('UPDATE auto_upgrades SET start_at = ? WHERE id = ?').run(new Date(Date.now() + 6 * 3600e3).toISOString(), f);
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(row(userId, f).status, 'stopped');
    console.log('✅ paused_disabled monitor stops at the cutoff.');

    console.log('\n🎉 AUTO-UPGRADE SETTINGS CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
