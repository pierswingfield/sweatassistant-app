// Cross-gym data isolation tests (WP-D6).
//
// Every other suite in this repo is single-gym, so none of them can fail when a
// query forgets its gym predicate. That is the whole point of this file: it is
// the only place a missing `AND gym_id = ?` shows up as red.
//
// Two opposite failure modes are pinned, because fixing one by reflex creates
// the other:
//
//   1. UNDER-SCOPED per-user reads — a request-scoped accessor that filters on
//      user_id alone merges both gyms' rows. Several of these tables key on
//      PROVIDER ids (studio_id, event_id) that are only unique within a gym, so
//      "merged" can mean "Psycle's spot map handed to a JAB booking".
//
//   2. OVER-SCOPED background scanners — a cross-user scanner that filters to the
//      user's ACTIVE gym silently stops all background work for every other gym.
//      A user's JAB auto-book must fire while they are looking at Psycle.
//
// The replace*Cache writers get their own checks: their DELETE is the dangerous
// half. An unscoped "replace this user's cache" wipes the other gym's rows on
// every sync, so whichever gym synced last would be the only one with reminders.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');

const testkit = require('./testkit');
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const GYM_A = 'psycle-london';
const GYM_B = 'jab-boxing';

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(GYM_B);

let seq = 0;
// A user linked to BOTH gyms. GYM_A (the default gym) is what a gym-less
// accessor resolves to with no per-request context — no "starting gym" needs
// to be set any more (stage 4 of the active-gym audit removed the persisted
// choice; resolution is deterministic).
function twoGymUser() {
  const uid = testkit.createUser(db, `iso-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  db.upsertUserGym(uid, GYM_B, { gym_email: 'b@test.local', encrypted_password: 'enc:b' });
  return uid;
}
// A gym-less accessor's default is now the DETERMINISTIC one (GYM_A), never a
// remembered "current gym". To reach GYM_B's data through one of those
// accessors, wrap the read in the same request-scoped context production code
// uses for a real `x-gym-id` header — `on(uid, GYM_B, () => { ...reads... })`.
const on = (uid, gym, fn) => db.runWithGymContext(uid, gym, fn);

// --- 1. studio_preferences — provider-keyed, the sharpest collision -----------

check('a spot map saved for one gym is invisible to the other', () => {
  const uid = twoGymUser();
  // The SAME studio id at both gyms — different rooms, different floor plans.
  db.setStudioPreference(uid, 138, { preferredSlots: [1, 2], preferredRows: [] }, GYM_A);

  on(uid, GYM_B, () => {
    assert.strictEqual(db.getStudioPreference(uid, 138), null,
      'studio 138 at JAB is a different room from studio 138 at Psycle');
    assert.deepStrictEqual(db.getStudioPreferences(uid), []);
  });

  db.setStudioPreference(uid, 138, { preferredSlots: [9], preferredRows: [] }, GYM_B);
  on(uid, GYM_B, () => {
    assert.deepStrictEqual(db.getStudioPreference(uid, 138).preferredSlots, [9]);
  });

  assert.deepStrictEqual(db.getStudioPreference(uid, 138).preferredSlots, [1, 2],
    'and writing the JAB map must not have overwritten the Psycle one (GYM_A is the default, no context needed)');
});

// --- 2. auto_bookings / auto_upgrades ---------------------------------------

check('auto-book queues do not leak across gyms, and quotas count per gym', () => {
  const uid = twoGymUser();
  db.addAutoBooking(uid, 'evt-a', 'Ride 45', 'Ins', 'Studio', 'Loc', '2026-09-01T10:00:00Z', {}, null, null, null, GYM_A);

  on(uid, GYM_B, () => {
    assert.deepStrictEqual(db.getUserAutoBookings(uid), []);
  });
  assert.strictEqual(db.countPendingAutoBookings(uid, GYM_B), 0,
    'a Psycle queue entry must not consume the JAB allowance');

  db.addAutoBooking(uid, 'evt-b', 'Boxing', 'Ins', 'Studio', 'Loc', '2026-09-01T18:00:00Z', {}, null, null, null, GYM_B);
  assert.strictEqual(db.countPendingAutoBookings(uid, GYM_B), 1);

  assert.strictEqual(db.countPendingAutoBookings(uid, GYM_A), 1);
  assert.strictEqual(db.getUserAutoBookings(uid)[0].event_id, 'evt-a',
    'GYM_A is the default gym, so this needs no context');
});

check('auto-upgrade monitors do not leak across gyms', () => {
  const uid = twoGymUser();
  db.addAutoUpgrade(uid, 'evt-a', 'bk1', 5, 'Ride', 'Ins', 'St', 'Loc', '2026-09-01T10:00:00Z', {}, null, null, GYM_A);

  on(uid, GYM_B, () => {
    assert.deepStrictEqual(db.getUserAutoUpgrades(uid), []);
    assert.deepStrictEqual(db.getUserAutoUpgradesByEvent(uid), {},
      'the calendar annotator must not label a JAB class with a Psycle upgrade');
  });
  assert.strictEqual(db.countActiveAutoUpgrades(uid, GYM_B), 0);

  assert.strictEqual(db.countActiveAutoUpgrades(uid, GYM_A), 1);
});

check('an event id shared by two gyms marks only its own queue entry executed', () => {
  const uid = twoGymUser();
  db.addAutoBooking(uid, 'shared-id', 'Ride', 'I', 'S', 'L', '2026-09-01T10:00:00Z', {}, null, null, null, GYM_A);
  db.addAutoBooking(uid, 'shared-id', 'Boxing', 'I', 'S', 'L', '2026-09-01T18:00:00Z', {}, null, null, null, GYM_B);

  // The scheduler passes the gym from the ROW it is executing, not any "current" gym.
  db.markAutoBookingExecuted('shared-id', uid, GYM_A, 'success', 'booked', new Date().toISOString());

  assert.strictEqual(db.getUserAutoBookings(uid)[0].status, 'success', 'GYM_A needs no context, it is the default');
  on(uid, GYM_B, () => {
    assert.strictEqual(db.getUserAutoBookings(uid)[0].status, 'pending',
      'the JAB entry with the same provider event id must be untouched');
  });
});

check('markAutoBookingExecuted refuses to guess a gym', () => {
  const uid = twoGymUser();
  db.addAutoBooking(uid, 'evt', 'Ride', 'I', 'S', 'L', '2026-09-01T10:00:00Z', {}, null, null, null, GYM_A);
  assert.throws(() => db.markAutoBookingExecuted('evt', uid, null, 'success', 'x', 'now'),
    /requires the gym_id/,
    'silently resolving the active gym here would fail to mark exactly the rows background work is for');
});

// --- 3. the cache writers — the DELETE is the dangerous half ------------------

check('syncing one gym\'s bookings does not wipe the other gym\'s cache', () => {
  const uid = twoGymUser();
  db.replaceBookingCache(uid, [{ bookingId: 'a1', gymId: GYM_A, eventId: 'ea', startAt: '2026-09-01T10:00:00Z', slotLabel: '12' }], [GYM_A]);
  db.replaceBookingCache(uid, [{ bookingId: 'b1', gymId: GYM_B, eventId: 'eb', startAt: '2026-09-01T18:00:00Z', slotLabel: '3' }], [GYM_B]);

  on(uid, GYM_B, () => {
    assert.deepStrictEqual(db.getBookingCacheForUser(uid).map(r => r.booking_id), ['b1']);
  });
  assert.deepStrictEqual(db.getBookingCacheForUser(uid).map(r => r.booking_id), ['a1'],
    'an unscoped DELETE here would leave only whichever gym synced last with reminders (GYM_A: no context needed)');
});

check('syncing one gym\'s waitlists does not wipe the other gym\'s cache', () => {
  const uid = twoGymUser();
  // `replaceWaitlistCache` still resolves its gym via context/default (it has
  // not been migrated to an explicit-gymId signature — see the active-gym
  // audit's stage 3 note on this), so both the write and the read need it.
  db.replaceWaitlistCache(uid, [{ eventId: 'wa', startAt: '2026-09-01T10:00:00Z' }]);
  on(uid, GYM_B, () => {
    db.replaceWaitlistCache(uid, [{ eventId: 'wb', startAt: '2026-09-01T18:00:00Z' }]);
    assert.deepStrictEqual(db.getWaitlistCacheForUser(uid).map(r => r.event_id), ['wb']);
  });
  assert.deepStrictEqual(db.getWaitlistCacheForUser(uid).map(r => r.event_id), ['wa']);
});

// --- 4. calendar_classes -----------------------------------------------------

check('calendar rows are stored per gym, read account-wide, and reconciled per gym', () => {
  const uid = twoGymUser();
  const mk = (eventId, startAt) => ({ eventId, startAt, status: 'CONFIRMED', contentHash: 'h-' + eventId });
  db.upsertCalendarClass(uid, mk('ca', '2099-01-01T10:00:00Z'));
  on(uid, GYM_B, () => {
    db.upsertCalendarClass(uid, mk('cb', '2099-01-01T18:00:00Z'));
  });

  // STORAGE stays per gym...
  assert.deepStrictEqual(db.getCalendarClasses(uid, GYM_A).map(r => r.event_id), ['ca']);
  assert.deepStrictEqual(db.getCalendarClasses(uid, GYM_B).map(r => r.event_id), ['cb']);

  // ...but the READ with no gym is account-wide, because the .ics feed is
  // account-level (2026-09-14): one subscription, every gym's classes. This
  // deliberately inverts the old assertion, which required the active gym only
  // — that shape is what gave a two-gym member a calendar showing half a week.
  assert.deepStrictEqual(db.getCalendarClasses(uid).map(r => r.event_id).sort(), ['ca', 'cb']);

  // Reconcile JAB down to nothing. Psycle's row must survive — a single gym's
  // live list never authorises deleting another gym's classes.
  db.reconcileFutureCalendarClasses(uid, new Date().toISOString(), [], GYM_B);
  assert.deepStrictEqual(db.getCalendarClasses(uid, GYM_B), []);
  assert.deepStrictEqual(db.getCalendarClasses(uid, GYM_A).map(r => r.event_id), ['ca'],
    'reconciling one gym\'s feed must not delete the other gym\'s classes');
});

// --- 5. background scanners must NOT be gym-filtered --------------------------

check('the auto-book scanner sees every gym, and tags each row with its own', () => {
  const uid = twoGymUser();
  db.addAutoBooking(uid, 'bg-a', 'Ride', 'I', 'S', 'L', '2026-09-01T10:00:00Z', {}, null, null, null, GYM_A);
  db.addAutoBooking(uid, 'bg-b', 'Boxing', 'I', 'S', 'L', '2026-09-01T18:00:00Z', {}, null, null, null, GYM_B);
  // getPendingAutoBookings takes no gym at all — it is a cross-user background
  // scanner, deliberately unfiltered — so both entries must appear regardless
  // of any request context.
  const pending = db.getPendingAutoBookings().filter(r => r.user_id === uid);
  const byGym = Object.fromEntries(pending.map(r => [r.gym_id, r.event_id]));
  assert.deepStrictEqual(byGym, { [GYM_A]: 'bg-a', [GYM_B]: 'bg-b' },
    'filtering this to the active gym would silently stop background work for the other');
});

check('the upgrade and reminder scanners see every gym too', () => {
  const uid = twoGymUser();
  db.addAutoUpgrade(uid, 'ug-a', 'bk', 1, 'Ride', 'I', 'S', 'L', '2026-09-01T10:00:00Z', {}, null, null, GYM_A);
  db.replaceBookingCache(uid, [{ bookingId: 'rc-a', gymId: GYM_A, eventId: 'ea', startAt: '2026-09-01T10:00:00Z', slotLabel: '1' }], [GYM_A]);
  db.addAutoUpgrade(uid, 'ug-b', 'bk', 1, 'Boxing', 'I', 'S', 'L', '2026-09-01T18:00:00Z', {}, null, null, GYM_B);
  db.replaceBookingCache(uid, [{ bookingId: 'rc-b', gymId: GYM_B, eventId: 'eb', startAt: '2026-09-01T18:00:00Z', slotLabel: '2' }], [GYM_B]);

  const ug = db.getActiveAutoUpgrades().filter(r => r.user_id === uid).map(r => r.gym_id).sort();
  assert.deepStrictEqual(ug, [GYM_B, GYM_A].sort(), 'both gyms\' monitors must be polled');

  const rc = db.getAllBookingCache().filter(r => r.user_id === uid).map(r => r.gym_id).sort();
  assert.deepStrictEqual(rc, [GYM_B, GYM_A].sort(), 'both gyms\' bookings must get reminders');
});

// --- 6. the settings scope split ---------------------------------------------
//
// One flat blob to every caller, two rows underneath. The split must be
// invisible above db.js — server.js, the scheduler, the poller and the client
// all treat settings as a single object.

check('account-scoped settings survive a gym switch; gym-scoped ones do not', () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, { notifications: { booking: { enabled: false } }, detectedBookingOffset: 14 }, GYM_A);

  on(uid, GYM_B, () => {
    const atB = db.getUserSettings(uid);
    assert.deepStrictEqual(atB.notifications, { booking: { enabled: false } },
      'notification prefs belong to the person — switching gyms must not reset them');
    assert.strictEqual(atB.detectedBookingOffset, undefined,
      "a Psycle booking window driving JAB's countdown is the exact silent-wrong bug this phase removes");
  });

  db.setUserSettings(uid, { detectedBookingOffset: 3 }, GYM_B);
  on(uid, GYM_B, () => {
    assert.strictEqual(db.getUserSettings(uid).detectedBookingOffset, 3);
  });

  assert.strictEqual(db.getUserSettings(uid).detectedBookingOffset, 14,
    "Psycle's window is intact — GYM_A is the default, no context needed");
  assert.deepStrictEqual(db.getUserSettings(uid).notifications, { booking: { enabled: false } },
    'and the shared account keys are still shared');
});

check('Auto-Upgrade settings are gym-scoped while prefetch range stays account-scoped', () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, {
    autoUpgradeEnabled: false,
    autoUpgradeByDefault: true,
    autoUpgradeInterval: '1min',
    autoUpgradeKeepOriginalByDefault: true,
    prefetchWeeks: 6,
  }, GYM_A);

  on(uid, GYM_B, () => {
    const atB = db.getUserSettings(uid);
    assert.strictEqual(atB.autoUpgradeEnabled, undefined, 'engine enablement must not leak to another gym');
    assert.strictEqual(atB.autoUpgradeInterval, undefined, 'polling interval must not leak to another gym');
    assert.strictEqual(atB.prefetchWeeks, 6, 'timetable prefetch range belongs to the app/account');
  });
});

check('the Auto-Upgrade scope migration backfills every linked gym and preserves gym overrides', () => {
  const uid = twoGymUser();
  db.db.prepare(`
    INSERT INTO account_settings (user_id, preferences) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences
  `).run(uid, JSON.stringify({
    notifications: { booking: { enabled: false } },
    autoUpgradeEnabled: true,
    autoUpgradeByDefault: true,
    autoUpgradeInterval: '15min',
  }));
  db.db.prepare(`
    INSERT INTO settings (user_id, gym_id, preferences) VALUES (?, ?, ?)
    ON CONFLICT(user_id, gym_id) DO UPDATE SET preferences = excluded.preferences
  `).run(uid, GYM_A, JSON.stringify({ autoUpgradeInterval: '1min', autoUpgradeKeepOriginalByDefault: true }));

  db.migrateAutoUpgradeSettingsScope();

  const account = JSON.parse(db.db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(uid).preferences);
  const gymA = JSON.parse(db.db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?').get(uid, GYM_A).preferences);
  const gymB = JSON.parse(db.db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?').get(uid, GYM_B).preferences);
  assert.deepStrictEqual(account, { notifications: { booking: { enabled: false } } }, 'account copies are removed');
  assert.strictEqual(gymA.autoUpgradeInterval, '1min', 'an existing per-gym override wins');
  assert.strictEqual(gymA.autoUpgradeKeepOriginalByDefault, true, 'the already-gym-scoped key survives');
  assert.strictEqual(gymB.autoUpgradeEnabled, true, 'account value is backfilled to the second gym');
  assert.strictEqual(gymB.autoUpgradeInterval, '15min', 'every linked gym receives the old account default');

  db.migrateAutoUpgradeSettingsScope();
  const gymBAgain = JSON.parse(db.db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?').get(uid, GYM_B).preferences);
  assert.deepStrictEqual(gymBAgain, gymB, 'the migration is idempotent');
});

check('an unknown key defaults to gym-scoped, not account-scoped', () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, { someFutureProviderKey: 'psycle-value' }, GYM_A);
  on(uid, GYM_B, () => {
    // `|| {}` because a settings save now writes only the halves the patch
    // actually touches — this account has nothing at all stored for GYM_B, so
    // getUserSettings legitimately returns null rather than an empty object.
    assert.strictEqual((db.getUserSettings(uid) || {}).someFutureProviderKey, undefined,
      'a new provider-derived key must fail visibly (set it twice), never leak across gyms');
  });
});

check('`calendar` stays gym-scoped so the feed cron still finds its users', () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, { calendar: { enabled: true } });
  db.setCalendarToken(uid, 'tok-' + uid);
  assert.ok(db.getCalendarEnabledUserIds().includes(uid),
    'the feed token lives on user_gyms, so calendar.enabled describes ONE gym\'s feed — ' +
    'classifying it account-scoped would make this scan find nobody and silently stop the cron');
});

check('settings with nothing stored still reads as null, not an empty object', () => {
  const uid = twoGymUser();
  assert.strictEqual(db.getUserSettings(uid), null,
    'callers distinguish "never configured" from "configured empty"');
});

// --- 7. the schema itself refuses to guess -----------------------------------

check('no gym-scoped table still defaults gym_id to Psycle', () => {
  const tables = ['studio_preferences', 'settings', 'booking_cache',
    'waitlist_cache', 'calendar_classes', 'auto_bookings', 'auto_upgrades'];
  const q = db.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?");
  const offenders = tables.filter((t) => /DEFAULT\s+'psycle-london'/i.test((q.get(t) || {}).sql || ''));
  assert.deepStrictEqual(offenders, [],
    'a DDL default makes a forgotten gym_id file the row under Psycle instead of erroring — ' +
    'silent mis-filing is the exact failure this phase exists to remove');
});

check('an INSERT that forgets its gym is rejected, not filed under Psycle', () => {
  const uid = twoGymUser();
  assert.throws(
    () => db.db.prepare('INSERT INTO settings (user_id, preferences) VALUES (?, ?)').run(uid, '{}'),
    /NOT NULL constraint failed: settings.gym_id/,
    'the database, not code review, is what has to catch the next unscoped write');
});

// --- 8. in-memory runtime state, not just the database (WP-G) ----------------
//
// Sections 1-7 pin the DB. But the scheduler and poller coordinate through
// PROCESS-LOCAL Maps and Sets keyed on provider ids, and a provider id is only
// unique within a gym. No DB predicate can catch that, which is why it survived
// six work packages: every suite was single-gym, and the one multi-gym suite
// only looked at SQL.

const scheduler = require('./scheduler');

check('the shared event cache does not serve one gym\'s slots as another\'s', () => {
  // The same provider event id at both gyms — different classes, different rooms.
  const EVENT_ID = 999001;
  const payloadA = { data: { id: EVENT_ID }, slots: [1, 2, 3] };
  const payloadB = { data: { id: EVENT_ID }, slots: [77] };

  scheduler.setCachedEvent(GYM_A, EVENT_ID, payloadA, 30000);

  assert.strictEqual(scheduler.getCachedEvent(GYM_B, EVENT_ID), null,
    'a cache hit across gyms hands the scheduler the WRONG floor plan and it books ' +
    'against slots that do not exist in the room it is booking');
  assert.deepStrictEqual(scheduler.getCachedEvent(GYM_A, EVENT_ID).slots, [1, 2, 3]);

  scheduler.setCachedEvent(GYM_B, EVENT_ID, payloadB, 30000);
  assert.deepStrictEqual(scheduler.getCachedEvent(GYM_B, EVENT_ID).slots, [77]);
  assert.deepStrictEqual(scheduler.getCachedEvent(GYM_A, EVENT_ID).slots, [1, 2, 3],
    'writing gym B must not evict or overwrite gym A');
});

check('an expired entry does not resurrect via the other gym\'s key', () => {
  const EVENT_ID = 999002;
  scheduler.setCachedEvent(GYM_A, EVENT_ID, { slots: [5] }, -1); // already expired
  assert.strictEqual(scheduler.getCachedEvent(GYM_A, EVENT_ID), null);
  assert.strictEqual(scheduler.getCachedEvent(GYM_B, EVENT_ID), null);
});

check('the scheduler\'s cross-user claim keys are gym-qualified', () => {
  // claimedSlots/burnedSlots are module-private, so this is a source assertion —
  // the same technique test-no-gym-privilege.js uses. An unqualified claim key
  // means one gym's in-flight claim silently suppresses another gym's POST, and
  // the victim's auto-book just never fires with no error anywhere.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'scheduler.js'), 'utf8');
  const assignments = src.match(/claimKey\s*=\s*`[^`]*`/g) || [];
  assert.ok(assignments.length > 0, 'expected to find the claimKey template in scheduler.js');
  for (const a of assignments) {
    assert.ok(/\$\{gymId\}/.test(a),
      `claim key is not gym-qualified: ${a} — provider slot ids collide across gyms`);
  }
});

check('the poller\'s claim keys are gym-qualified too (C3-23)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'poller.js'), 'utf8');
  const assignments = src.match(/claimKey\s*=\s*`[^`]*`/g) || [];
  assert.ok(assignments.length > 0, 'expected to find the claimKey template in poller.js');
  for (const a of assignments) {
    assert.ok(/\$\{gymId\}/.test(a),
      `poller claim key is not gym-qualified: ${a} — two gyms can both publish event 12345 slot 7`);
  }
});

// --- run --------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of checks) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks.length} gym-isolation checks FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${passed}/${checks.length} gym-isolation checks passed.`);
