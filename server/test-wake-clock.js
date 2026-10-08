// The auto-book orchestrator's WAKE CLOCK (layer I).
//
// Every other scheduler test enters through runAllPendingBookings() or
// checkAndRunImmediateBookings(), which take the queue as given. So nothing
// asserted *when the orchestrator chooses to wake* — and that is precisely where
// Psycle's policy survived WP-D8: `getNextMondayNoonLondon()` was the only armed
// instant, hardcoded weekday 1 / 12:00 / Europe/London.
//
// The consequence was not "late", it was "never": a JAB class releasing Saturday
// 09:47 measured 50.2 hours from the armed instant, and the dispatch filter then
// rejected it for not matching the wrong time. Two independent failures
// compounding, both invisible to a queue-driven test.
//
// So this file asserts the one thing that was never asserted: given a queue,
// which instant does the scheduler arm, and which bookings dispatch at it.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const { DateTime } = require('luxon');
const db = require('./db');
const testkit = require('./testkit');
const scheduler = require('./scheduler');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const LDN = 'Europe/London';
const now = () => DateTime.now().setZone(LDN);

let seq = 0;
function twoGymUser() {
  const uid = testkit.createUser(db, `wake-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  db.upsertUserGym(uid, JAB, { gym_email: 'b@test.local', encrypted_password: 'enc:b' });
  return uid;
}

// The gym is passed EXPLICITLY. This used to flip the account's active gym and
// let addAutoBooking infer it, which is the very thing the active-gym audit
// removed — a multi-gym write with no named gym now throws.
function queueFor(uid, gymId, { eventId, startAt, releaseAt = null }) {
  return db.addAutoBooking(uid, eventId, 'Class', 'Coach', 'Studio', 'Location',
    startAt, { preferredSlots: [1], requiredCount: 1 }, 100, 'Group', releaseAt, gymId);
}

function clearQueue() {
  db.db.prepare('DELETE FROM auto_bookings').run();
}

// A Psycle class start far enough ahead that its rolling-weekly release Monday
// has not happened yet. Psycle's release is roughly the class date minus the
// 15-day window, so ~10 days out is already open — 30 leaves a clear margin
// whatever weekday the suite happens to run on. Returned in CodexFit's
// timezone-naive format, which is what the real rows carry.
function PSYCLE_FUTURE_RELEASE_START() {
  return now().plus({ days: 30 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

// --- 1. the empty case -------------------------------------------------------

check('an empty queue arms nothing (rather than defaulting to Monday noon)', () => {
  clearQueue();
  assert.strictEqual(scheduler.getNextReleaseInstant(), null,
    'with nothing queued there is no instant worth waking for; a weekly default here ' +
    'is what made the clock gym-specific in the first place');
});

// --- 2. Psycle is unchanged (the regression that matters most) ---------------

check('a Psycle entry still arms its rolling-weekly Monday noon', () => {
  clearQueue();
  const uid = twoGymUser();
  // No release_at: force the rolling-weekly policy path, not a stored stamp.
  // Far enough out that its release Monday is still AHEAD of us — a class only
  // ~10 days out has already released (release ≈ class minus the 15-day window),
  // so it belongs to the missed/immediate path, not the wake clock.
  const startAt = PSYCLE_FUTURE_RELEASE_START();
  queueFor(uid, PSYCLE, { eventId: 4001, startAt });

  const armed = scheduler.getNextReleaseInstant();
  assert.ok(armed, 'a queued Psycle class must arm something');
  assert.strictEqual(armed.weekday, 1, `expected a Monday, got ${armed.weekdayLong}`);
  assert.strictEqual(armed.hour, 12, `expected 12:00, got ${armed.hour}`);
  assert.strictEqual(armed.minute, 0);
  assert.strictEqual(armed.zoneName, LDN);
});

// --- 3. the bug: a per-class gym arms its OWN instant ------------------------

check('a JAB per-class release arms that exact instant, not Monday noon', () => {
  clearQueue();
  const uid = twoGymUser();
  // Deliberately neither a Monday nor noon — the shape the old clock could not
  // represent at all.
  const release = now().plus({ days: 3 }).set({ hour: 9, minute: 47, second: 0, millisecond: 0 });
  queueFor(uid, JAB, {
    eventId: 5001,
    startAt: release.plus({ days: 14 }).toISO(),
    releaseAt: release.toISO(),
  });

  const armed = scheduler.getNextReleaseInstant();
  assert.ok(armed, 'a queued JAB class must arm something');
  assert.strictEqual(armed.toISO(), release.toISO(),
    'the published per-class release IS the wake instant — MarianaTek resolves the ' +
    'rule server-side, so it is read, never computed');
  assert.ok(!(armed.weekday === 1 && armed.hour === 12),
    'arming Monday noon for a per-class gym is the original bug');
});

// --- 4. a mixed queue: soonest wins -----------------------------------------

check('with both gyms queued, the SOONEST release is armed', () => {
  clearQueue();
  const uid = twoGymUser();

  // A Psycle class releasing on some future Monday noon, plus a JAB class
  // releasing an hour from now — sooner than any Monday can be.
  queueFor(uid, PSYCLE, { eventId: 4002, startAt: PSYCLE_FUTURE_RELEASE_START() });
  const jabRelease = now().plus({ hours: 1 }).set({ second: 0, millisecond: 0 });
  queueFor(uid, JAB, {
    eventId: 5002,
    startAt: jabRelease.plus({ days: 14 }).toISO(),
    releaseAt: jabRelease.toISO(),
  });

  const armed = scheduler.getNextReleaseInstant();
  assert.strictEqual(armed.toISO(), jabRelease.toISO(),
    'the old clock would have slept through this and woken at Monday noon instead');
});

check('the far gym is NOT dropped — it is armed once the near one has passed', () => {
  // Same queue as above minus the JAB entry: the Psycle Monday must still be
  // reachable. A "soonest wins" clock that forgets the rest is a new bug.
  db.db.prepare('DELETE FROM auto_bookings WHERE event_id = ?').run(5002);
  const armed = scheduler.getNextReleaseInstant();
  assert.ok(armed, 'the remaining Psycle entry must still arm');
  assert.strictEqual(armed.weekday, 1);
  assert.strictEqual(armed.hour, 12);
});

// --- 5. dispatch groups by instant, and does not mix gyms -------------------

check('only the bookings releasing at the armed instant dispatch', () => {
  clearQueue();
  const uid = twoGymUser();

  const soon = now().plus({ hours: 2 }).set({ second: 0, millisecond: 0 });
  const later = now().plus({ days: 2 }).set({ second: 0, millisecond: 0 });

  queueFor(uid, JAB, { eventId: 5010, startAt: soon.plus({ days: 14 }).toISO(), releaseAt: soon.toISO() });
  queueFor(uid, JAB, { eventId: 5011, startAt: soon.plus({ days: 14 }).toISO(), releaseAt: soon.toISO() });
  queueFor(uid, JAB, { eventId: 5012, startAt: later.plus({ days: 14 }).toISO(), releaseAt: later.toISO() });

  const armed = scheduler.getNextReleaseInstant();
  assert.strictEqual(armed.toISO(), soon.toISO());

  const group = scheduler.bookingsReleasingAt(armed);
  assert.deepStrictEqual(group.map(b => Number(b.event_id)).sort(), [5010, 5011],
    'a release group is every entry sharing that instant — and nothing else; ' +
    'the 2-day-out class must not be dragged in early');
});

check('two gyms releasing at the same instant dispatch together', () => {
  clearQueue();
  const uid = twoGymUser();
  // Contrived but the right invariant: grouping is by INSTANT, not by gym. If a
  // Psycle Monday noon and a JAB per-class release coincide, both must fire.
  const shared = now().plus({ hours: 5 }).set({ second: 0, millisecond: 0 });
  queueFor(uid, JAB, { eventId: 5020, startAt: shared.plus({ days: 14 }).toISO(), releaseAt: shared.toISO() });
  queueFor(uid, PSYCLE, { eventId: 4020, startAt: shared.plus({ days: 14 }).toISO(), releaseAt: shared.toISO() });

  const group = scheduler.bookingsReleasingAt(shared);
  assert.deepStrictEqual(group.map(b => Number(b.event_id)).sort(), [4020, 5020]);
  assert.deepStrictEqual([...new Set(group.map(b => b.gym_id))].sort(), [JAB, PSYCLE],
    'both gyms, one instant — the dispatch group is keyed on time, not tenancy');
});

// --- 6. an unresolvable release is dropped, never treated as "now" ----------

check('a past release is not armed (it is the missed-release path, not the clock)', () => {
  clearQueue();
  const uid = twoGymUser();
  const past = now().minus({ hours: 3 }).set({ second: 0, millisecond: 0 });
  queueFor(uid, JAB, { eventId: 5030, startAt: past.plus({ days: 14 }).toISO(), releaseAt: past.toISO() });

  assert.strictEqual(scheduler.getNextReleaseInstant(), null,
    'arming an instant already gone would spin the precision loop immediately');
});

check('an entry with no resolvable release is skipped, not fired now', () => {
  clearQueue();
  const uid = twoGymUser();
  // No start_at and no release_at. getClassReleaseTime must not invent one:
  // assuming a class is open fires auto-book immediately and burns the entry.
  //
  // This check found a live bug: getClassReleaseTime used to `return
  // DateTime.now()` here, which armed the precision loop instantly under the
  // queue-driven clock. It failed only ~1 run in 3 — whether the invented "now"
  // landed side of the caller's own `now` decided it — so assert on null, never
  // on a distance from now, which is what made it flaky in the first place.
  queueFor(uid, JAB, { eventId: 5040, startAt: null, releaseAt: null });

  assert.strictEqual(scheduler.getClassReleaseTime({ gym_id: JAB, event_id: 5040 }), null,
    'no release_at and no start_at must resolve to null, not to "now"');
  assert.strictEqual(scheduler.getNextReleaseInstant(), null,
    'an unresolvable entry must not arm the clock at all');
});

// --- 7. the KV the health endpoint reports ----------------------------------

check('scheduleReleaseWindow publishes the armed instant, and clears it when idle', () => {
  clearQueue();
  const uid = twoGymUser();
  const release = now().plus({ hours: 6 }).set({ second: 0, millisecond: 0 });
  queueFor(uid, JAB, { eventId: 5050, startAt: release.plus({ days: 14 }).toISO(), releaseAt: release.toISO() });

  scheduler.scheduleReleaseWindow();
  assert.strictEqual(db.getKV('scheduler_next_release'), release.toISO(),
    '/api/health reports this — it must name the instant actually armed, so a ' +
    'wrong clock is visible from outside the process');

  clearQueue();
  scheduler.scheduleReleaseWindow();
  assert.ok(!db.getKV('scheduler_next_release'),
    'an empty queue must not keep advertising a stale release');
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
  console.error(`✗ ${failures.length}/${checks.length} wake-clock checks FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${passed}/${checks.length} wake-clock checks passed.`);
process.exit(0);
