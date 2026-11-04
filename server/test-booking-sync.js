// T-B: universal background booking sync (PLAN-teams.md §7.2).
//
// Every account's upcoming bookings AND waitlists are refreshed in the
// background for every enabled gym link, whether or not the member has push,
// cancellation reminders or the calendar feed. Before T-B the sweep covered
// only push subscribers with reminders on, and calendar users were fetched by
// a second, separate job — so a member with neither feature who booked on the
// gym's own website showed no upcoming classes at all.
//
// The provider list methods are stubbed with FUTURE classes: the mock fixtures
// are past-dated and the cycle prunes past rows, so asserting on mock data
// would pass on an empty table (see test-reminder-sweep.js for that lesson).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `booking-sync-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('./db');
const testkit = require('./testkit');
const bookingSync = require('./booking-sync');
const calendar = require('./calendar');
const backoff = require('./rate-limit-backoff');
const { getProvider } = require('./providers');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
const TOKENS = { [PSYCLE]: 'mock-jwt-token', [JAB]: 'mock-mt-token' };

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function cleanup() {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
}

// ── provider stubs: future classes, per-gym call counters, injectable failure ──
const future = (days) => new Date(Date.now() + days * 864e5).toISOString();
const calls = { [PSYCLE]: { listBookings: 0, listWaitlists: 0 }, [JAB]: { listBookings: 0, listWaitlists: 0 } };
const failing = new Set(); // gym ids whose list calls throw
const originals = {};
function ev(gymId, id, days) {
  return { id, startAt: future(days), name: `${gymId} class ${id}`, discipline: 'Ride', durationMin: 45,
    instructors: [{ name: 'Coach' }], studioName: 'Studio', studioId: 's1', locationName: 'Loc', locationAddress: '1 Road' };
}
function installStubs() {
  for (const gymId of [PSYCLE, JAB]) {
    const p = getProvider(gymId);
    originals[gymId] = { listBookings: p.listBookings, listWaitlists: p.listWaitlists };
    p.listBookings = async () => {
      calls[gymId].listBookings++;
      if (failing.has(gymId)) { const e = new Error('upstream 500'); e.status = 500; throw e; }
      return [{ bookingId: `${gymId}-b${calls[gymId].listBookings}`, eventId: `${gymId}-e1`, slotLabel: '7', event: ev(gymId, `${gymId}-e1`, 3) }];
    };
    p.listWaitlists = async () => {
      calls[gymId].listWaitlists++;
      if (failing.has(gymId)) { const e = new Error('upstream 500'); e.status = 500; throw e; }
      return [{ bookingId: `${gymId}-w1`, eventId: `${gymId}-w1`, isWaitlist: true, event: ev(gymId, `${gymId}-w1`, 4) }];
    };
  }
}
function restoreStubs() {
  for (const gymId of Object.keys(originals)) Object.assign(getProvider(gymId), originals[gymId]);
}
function resetCalls() { for (const g of Object.keys(calls)) { calls[g].listBookings = 0; calls[g].listWaitlists = 0; } }

let seq = 0;
// A bare account: no push subscription, no calendar, no reminder settings.
function twoGymUser() {
  const userId = testkit.createUser(db, `bsync-${++seq}@test.local`, 'x');
  db.upsertUserGym(userId, PSYCLE, { gym_email: 'dev@psycle.com', encrypted_password: 'x',
    session_json: JSON.stringify({ accessToken: TOKENS[PSYCLE] }) });
  db.upsertUserGym(userId, JAB, { gym_email: 'dev@jabboxing.mock', encrypted_password: 'x',
    session_json: JSON.stringify({ accessToken: TOKENS[JAB] }) });
  return userId;
}
const bookingRows = (uid, gymId) => db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?').all(uid, gymId);
const waitlistRows = (uid, gymId) => db.db.prepare('SELECT * FROM waitlist_cache WHERE user_id = ? AND gym_id = ?').all(uid, gymId);
function seedRows(uid, gymId, tag) {
  db.replaceBookingCache(uid, [{ bookingId: `old-${tag}`, gymId, eventId: 'old', startAt: future(5), slotLabel: '1' }], [gymId]);
  db.replaceWaitlistCache(uid, [{ eventId: `oldw-${tag}`, gymId, startAt: future(6) }], [gymId]);
}
// Only the users named in `only` are due: everyone else is marked freshly synced,
// so assertions about one account are not disturbed by the others in the DB.
function onlyDue(only) {
  const now = new Date().toISOString();
  for (const l of db.db.prepare('SELECT user_id, gym_id FROM user_gyms').all()) {
    if (!only.includes(l.user_id)) db.setBookingSyncState(l.user_id, l.gym_id, { lastSyncedAt: now, lastAttemptAt: now, lastError: null });
  }
}
const cycle = () => bookingSync.runCycle({ jitter: false });

check('an account with no push, no calendar and no reminders gets bookings AND waitlists refreshed', async () => {
  const uid = twoGymUser();
  onlyDue([uid]);
  resetCalls();
  await cycle();
  for (const gymId of [PSYCLE, JAB]) {
    const b = bookingRows(uid, gymId);
    const w = waitlistRows(uid, gymId);
    assert.strictEqual(b.length, 1, `${gymId}: one booking_cache row`);
    assert.strictEqual(b[0].class_name, `${gymId} class ${gymId}-e1`, 'enriched from the event');
    assert.strictEqual(b[0].location_address, '1 Road');
    assert.strictEqual(w.length, 1, `${gymId}: one waitlist_cache row`);
    const st = db.getBookingSyncState(uid, gymId);
    assert.ok(st && st.last_synced_at, `${gymId}: a per-(user,gym) synced timestamp is recorded`);
    assert.strictEqual(st.last_error, null);
  }
});

check('a gym synced within its cadence is not fetched again', async () => {
  const uid = twoGymUser();
  onlyDue([uid]);
  await cycle();
  resetCalls();
  await cycle();
  assert.strictEqual(calls[PSYCLE].listBookings + calls[JAB].listBookings, 0, 'not due yet: no provider calls');
});

check('disabled (link or gym), throttled and needs-relogin gyms are skipped and keep their rows', async () => {
  const cases = [
    ['link switched off', (uid) => db.setUserGymEnabled(uid, JAB, false), (uid) => db.setUserGymEnabled(uid, JAB, true)],
    ['gym disabled', () => db.db.prepare('UPDATE gyms SET enabled = 0 WHERE id = ?').run(JAB),
      () => db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB)],
    ['throttled', () => backoff.applyRateLimitBackoff(JAB, 60000), () => backoff._resetRateLimitBackoffForTests()],
    ['needs_relogin', (uid) => db.setUserGymStatus(uid, JAB, 'needs_relogin'), () => {}],
    ['relogin suspended', (uid) => db.db.prepare('UPDATE user_gyms SET relogin_suspended = 1 WHERE user_id = ? AND gym_id = ?').run(uid, JAB), () => {}],
  ];
  for (const [label, arm, disarm] of cases) {
    const uid = twoGymUser();
    seedRows(uid, JAB, label);
    onlyDue([uid]);
    arm(uid);
    resetCalls();
    try { await cycle(); } finally { disarm(uid); }
    assert.strictEqual(calls[JAB].listBookings + calls[JAB].listWaitlists, 0, `${label}: JAB never fetched`);
    assert.deepStrictEqual(bookingRows(uid, JAB).map((r) => r.booking_id), [`old-${label}`], `${label}: JAB bookings kept`);
    assert.deepStrictEqual(waitlistRows(uid, JAB).map((r) => r.event_id), [`oldw-${label}`], `${label}: JAB waitlists kept`);
    assert.strictEqual(bookingRows(uid, PSYCLE).length, 1, `${label}: the other gym still synced`);
  }
});

check("one gym's failure keeps its last good rows and leaves the other gym's sync intact", async () => {
  const uid = twoGymUser();
  seedRows(uid, JAB, 'fail');
  onlyDue([uid]);
  failing.add(JAB);
  try { await cycle(); } finally { failing.delete(JAB); }
  assert.deepStrictEqual(bookingRows(uid, JAB).map((r) => r.booking_id), ['old-fail'], 'failed gym keeps its bookings');
  assert.deepStrictEqual(waitlistRows(uid, JAB).map((r) => r.event_id), ['oldw-fail'], 'failed gym keeps its waitlists');
  assert.ok(db.getBookingSyncState(uid, JAB).last_error, 'the failure is recorded');
  assert.ok(!db.getBookingSyncState(uid, JAB).last_synced_at, 'and is not passed off as a sync');
  assert.strictEqual(bookingRows(uid, PSYCLE).length, 1, 'healthy gym refreshed');
  assert.strictEqual(waitlistRows(uid, PSYCLE).length, 1);
});

check('calendar users are fetched once per gym: the feed builds from the sync, never its own fetch', async () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, { calendar: { enabled: true } });
  calendar.ensureToken(uid);
  onlyDue([uid]);
  resetCalls();
  await cycle();
  await calendar.pollAndPublishAll();
  for (const gymId of [PSYCLE, JAB]) {
    assert.strictEqual(calls[gymId].listBookings, 1, `${gymId}: bookings listed exactly once`);
    assert.strictEqual(calls[gymId].listWaitlists, 1, `${gymId}: waitlists listed exactly once`);
  }
  const snap = db.getCalendarSnapshot(uid);
  assert.ok(snap && /psycle-london class psycle-london-e1/i.test(snap.ics.replace(/\r\n /g, '')),
    'the feed carries the synced (enriched) class');
});

check('the priority predicate selects the 2 h cadence; everyone else stays on 6 h', async () => {
  const pri = twoGymUser();
  const normal = twoGymUser();
  onlyDue([pri, normal]);
  const threeHoursAgo = new Date(Date.now() - 3 * 3600e3).toISOString();
  for (const uid of [pri, normal]) for (const g of [PSYCLE, JAB]) {
    db.setBookingSyncState(uid, g, { lastSyncedAt: threeHoursAgo, lastAttemptAt: threeHoursAgo, lastError: null });
  }
  bookingSync.setPriorityPredicate(() => new Set([pri]));
  try {
    assert.strictEqual(bookingSync.cadenceFor(pri), bookingSync.PRIORITY_CADENCE_MS);
    assert.strictEqual(bookingSync.cadenceFor(normal), bookingSync.DEFAULT_CADENCE_MS);
    assert.strictEqual(bookingSync.PRIORITY_CADENCE_MS, 2 * 3600e3);
    assert.strictEqual(bookingSync.DEFAULT_CADENCE_MS, 6 * 3600e3);
    resetCalls();
    await cycle();
    assert.strictEqual(bookingRows(pri, PSYCLE).length, 1, 'priority user (3 h stale) refreshed');
    assert.strictEqual(bookingRows(normal, PSYCLE).length, 0, 'normal user (3 h stale) not yet due');
    assert.strictEqual(calls[PSYCLE].listBookings, 1, 'exactly one account fetched');
  } finally {
    bookingSync.setPriorityPredicate(null);
  }
  assert.strictEqual(bookingSync.cadenceFor(pri), bookingSync.DEFAULT_CADENCE_MS, 'default predicate is empty');
});

check('cycle counters are exposed (aggregate only)', async () => {
  const s = bookingSync.getStats();
  for (const k of ['cycles', 'usersSynced', 'gymsSynced', 'gymsFailed', 'gymsSkipped']) {
    assert.strictEqual(typeof s[k], 'number', `stats.${k} is a number`);
  }
  assert.ok(s.cycles >= 1 && s.gymsSynced >= 1 && s.gymsFailed >= 1 && s.gymsSkipped >= 1);
});

(async () => {
  let failed = 0;
  console.log('\n🧪 Universal background booking sync (T-B)\n');
  installStubs();
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  restoreStubs();
  cleanup();
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} booking-sync checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} booking-sync checks passed.`);
  process.exit(0);
})();
