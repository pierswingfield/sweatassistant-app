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
const override = {}; // gymId -> async (n) => list, replaces the default listBookings body
const originals = {};
function ev(gymId, id, days) {
  return { id, startAt: future(days), name: `${gymId} class ${id}`, discipline: 'Ride', durationMin: 45,
    instructors: [{ name: 'Coach' }], studioName: 'Studio', studioId: 's1', locationName: 'Loc', locationAddress: '1 Road' };
}
function installStubs() {
  for (const gymId of [PSYCLE, JAB]) {
    const p = getProvider(gymId);
    originals[gymId] = { listBookings: p.listBookings, listWaitlists: p.listWaitlists };
    p.listBookings = async function () {
      calls[gymId].listBookings++;
      if (failing.has(gymId)) { const e = new Error('upstream 500'); e.status = 500; throw e; }
      if (override[gymId]) return override[gymId](calls[gymId].listBookings, arguments[0]);
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


// ── review fixes (T-B review) ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const booking = (gymId, id) => ({ bookingId: id, eventId: `${gymId}-${id}`, slotLabel: '7', event: ev(gymId, `${gymId}-${id}`, 3) });
const stale = (uid, gymId, msAgo, extra = {}) => {
  const t = new Date(Date.now() - msAgo).toISOString();
  db.setBookingSyncState(uid, gymId, { lastSyncedAt: t, lastAttemptAt: t, lastError: null, ...extra });
};

check('calendar-feed users are on the 3 h cadence: 4 h stale is due for them, not for others', async () => {
  const cal = twoGymUser();
  const plain = twoGymUser();
  db.setUserSettings(cal, { calendar: { enabled: true } });
  onlyDue([cal, plain]);
  for (const uid of [cal, plain]) for (const g of [PSYCLE, JAB]) stale(uid, g, 4 * 3600e3);
  assert.strictEqual(bookingSync.cadenceFor(cal), bookingSync.CALENDAR_CADENCE_MS);
  assert.strictEqual(bookingSync.CALENDAR_CADENCE_MS, 3 * 3600e3);
  await cycle();
  assert.strictEqual(bookingRows(cal, PSYCLE).length, 1, 'calendar user refreshed');
  assert.strictEqual(bookingRows(plain, PSYCLE).length, 0, 'plain user not yet due');
});

check('a failed gym is retried no sooner than 30 min after the failed attempt', async () => {
  const uid = twoGymUser();
  onlyDue([uid]);
  stale(uid, PSYCLE, 10 * 3600e3);
  stale(uid, JAB, 10 * 3600e3, { lastAttemptAt: new Date(Date.now() - 10 * 60e3).toISOString(), lastError: 'boom' });
  resetCalls();
  await cycle();
  assert.strictEqual(calls[JAB].listBookings, 0, '10 min after a failure: not retried');
  assert.strictEqual(calls[PSYCLE].listBookings, 1, 'the healthy, due gym is fetched');
  stale(uid, JAB, 10 * 3600e3, { lastAttemptAt: new Date(Date.now() - 31 * 60e3).toISOString(), lastError: 'boom' });
  resetCalls();
  await cycle();
  assert.strictEqual(calls[JAB].listBookings, 1, '31 min after a failure: retried');
  assert.strictEqual(db.getBookingSyncState(uid, JAB).last_error, null, 'and the error clears on success');
});

check('a forced sync ignores the cadence', async () => {
  const uid = twoGymUser();
  onlyDue([]);
  resetCalls();
  await bookingSync.syncUser(uid, { force: true });
  assert.strictEqual(calls[PSYCLE].listBookings, 1);
  assert.strictEqual(calls[JAB].listBookings, 1);
});

check('concurrent syncs of one (user, gym) share the fetch in flight', async () => {
  const uid = twoGymUser();
  resetCalls();
  override[PSYCLE] = async () => { await sleep(40); return [booking(PSYCLE, 'shared')]; };
  try {
    await Promise.all([bookingSync.syncUserGym(uid, PSYCLE), bookingSync.syncUserGym(uid, PSYCLE)]);
  } finally { delete override[PSYCLE]; }
  assert.strictEqual(calls[PSYCLE].listBookings, 1, 'one provider call for two callers');
});

check('a forced sync arriving during an in-flight fetch runs again after it, so the newest fetch writes last', async () => {
  const uid = twoGymUser();
  resetCalls();
  // Call 1 (the cycle) is slow and returns the pre-mutation list; call 2 (forced,
  // after a cancel) is fast and returns the post-mutation list.
  override[PSYCLE] = async (n) => {
    if (n === 1) { await sleep(60); return [booking(PSYCLE, 'before-cancel')]; }
    return [booking(PSYCLE, 'after-cancel')];
  };
  try {
    const cyclePass = bookingSync.syncUserGym(uid, PSYCLE);
    await sleep(5);
    const forced = bookingSync.syncUserGym(uid, PSYCLE, { force: true });
    await Promise.all([cyclePass, forced]);
  } finally { delete override[PSYCLE]; }
  assert.strictEqual(calls[PSYCLE].listBookings, 2, 'the forced request fetched again');
  assert.deepStrictEqual(bookingRows(uid, PSYCLE).map((r) => r.booking_id), ['after-cancel'], 'newest rows win');
});

check('a 401 re-authenticates through the gym and retries with the new token', async () => {
  const uid = twoGymUser();
  const auth = require('./auth');
  const orig = auth.triggerAutoRelogin;
  const relogins = [];
  auth.triggerAutoRelogin = async (u, g) => { relogins.push([u, g]); return 'fresh-token'; };
  const seen = [];
  override[JAB] = async (n, session) => {
    seen.push(session && session.accessToken);
    if (n === 1) { const e = new Error('unauthorised'); e.status = 401; throw e; }
    return [booking(JAB, 'after-relogin')];
  };
  resetCalls();
  try { await bookingSync.syncUserGym(uid, JAB); }
  finally { auth.triggerAutoRelogin = orig; delete override[JAB]; }
  assert.deepStrictEqual(relogins, [[uid, JAB]], 'relogin for the ROW gym');
  assert.deepStrictEqual(seen, [TOKENS[JAB], 'fresh-token']);
  assert.deepStrictEqual(bookingRows(uid, JAB).map((r) => r.booking_id), ['after-relogin']);
});

check('a mutation refresh syncs only the mutated gym (debounced, gyms coalesced)', async () => {
  const uid = twoGymUser();
  onlyDue([]);
  resetCalls();
  await calendar.refreshUser(uid, JAB);
  assert.strictEqual(calls[JAB].listBookings, 1, 'mutated gym synced');
  assert.strictEqual(calls[PSYCLE].listBookings, 0, 'other gym untouched');
  resetCalls();
  calendar.scheduleRefresh(uid, 30, JAB);
  calendar.scheduleRefresh(uid, 30, JAB); // burst: one timer
  await sleep(120);
  assert.strictEqual(calls[JAB].listBookings, 1, 'debounced to one sync');
  assert.strictEqual(calls[PSYCLE].listBookings, 0, 'scheduled refresh scoped to the mutated gym');
  resetCalls();
  calendar.scheduleRefresh(uid, 30); // no gym named (explicit feed refresh): every gym
  await sleep(120);
  assert.strictEqual(calls[JAB].listBookings + calls[PSYCLE].listBookings, 2);
});

check("the client's booking push never clobbers the sync's enriched rows", async () => {
  const uid = twoGymUser();
  onlyDue([]);
  await bookingSync.syncUser(uid, { force: true, gymIds: [PSYCLE] });
  const id = bookingRows(uid, PSYCLE)[0].booking_id;
  const clientRow = { bookingId: id, gymId: PSYCLE, eventId: `${PSYCLE}-e1`, startAt: future(3), className: 'X', slotLabel: '7' };
  // 1) a server sync just happened: the server's rows win outright
  bookingSync.acceptClientBookings(uid, [], [PSYCLE]);
  assert.strictEqual(bookingRows(uid, PSYCLE).length, 1, 'recent server sync is authoritative');
  // 2) server sync older than the window: client rows are merged, enrichment kept
  stale(uid, PSYCLE, 3600e3);
  bookingSync.acceptClientBookings(uid, [clientRow], [PSYCLE]);
  const r = bookingRows(uid, PSYCLE);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].duration_min, 45, 'duration kept');
  assert.strictEqual(r[0].location_address, '1 Road', 'address kept');
  assert.ok(db.getBookingSyncState(uid, PSYCLE).last_synced_at < new Date(Date.now() - 1800e3).toISOString(),
    'a client push is not recorded as a server sync');
  const src = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(!/replaceBookingCache\s*\(/.test(src), 'admin warm-up and client route do not write booking_cache directly');
});

check('a started server row the next sync omits is kept and stamped missing_since; relisting clears it', async () => {
  const uid = twoGymUser();
  const started = new Date(Date.now() - 2 * 3600e3).toISOString();
  const row = { bookingId: 4242, gymId: PSYCLE, eventId: 4242, startAt: started, className: 'Kept' };
  db.replaceBookingCache(uid, [row], [PSYCLE], { origin: 'server' });
  assert.strictEqual(bookingRows(uid, PSYCLE)[0].missing_since, null);
  db.replaceBookingCache(uid, [], [PSYCLE], { origin: 'server', retainStartedMs: bookingSync.RETAIN_STARTED_MS });
  const kept = bookingRows(uid, PSYCLE);
  assert.strictEqual(kept.length, 1, 'kept for the member\'s own views');
  assert.ok(kept[0].missing_since, 'stamped as missing from the latest sync');
  db.replaceBookingCache(uid, [row], [PSYCLE], { origin: 'server', retainStartedMs: bookingSync.RETAIN_STARTED_MS });
  assert.strictEqual(bookingRows(uid, PSYCLE)[0].missing_since, null, 'listed again: cleared');
});

check('a client push keys server rows by gym: the same booking id at another gym stays client', async () => {
  const uid = twoGymUser();
  db.replaceBookingCache(uid, [{ bookingId: 5150, gymId: PSYCLE, eventId: 1, startAt: future(2), className: 'P' }], [PSYCLE], { origin: 'server' });
  stale(uid, PSYCLE, 3600e3);
  bookingSync.acceptClientBookings(uid, [
    { bookingId: 5150, gymId: PSYCLE, eventId: 1, startAt: future(2), className: 'P' },
    { bookingId: 5150, gymId: JAB, eventId: 2, startAt: future(2), className: 'J' },
  ], [PSYCLE, JAB]);
  assert.strictEqual(bookingRows(uid, PSYCLE)[0].origin, 'server');
  assert.strictEqual(bookingRows(uid, JAB)[0].origin, 'client');
});

check('a cycle runs gyms in parallel lanes, never two concurrent calls to one gym', async () => {
  const a = twoGymUser();
  const b = twoGymUser();
  onlyDue([a, b]);
  const active = { [PSYCLE]: 0, [JAB]: 0 };
  const peak = { [PSYCLE]: 0, [JAB]: 0, total: 0 };
  const slow = (g) => async (n) => {
    active[g]++; peak[g] = Math.max(peak[g], active[g]);
    peak.total = Math.max(peak.total, active[PSYCLE] + active[JAB]);
    await sleep(30); active[g]--; return [booking(g, `lane-${n}`)];
  };
  override[PSYCLE] = slow(PSYCLE); override[JAB] = slow(JAB);
  try { await cycle(); } finally { delete override[PSYCLE]; delete override[JAB]; }
  assert.strictEqual(peak[PSYCLE], 1, 'one call at a time to Psycle');
  assert.strictEqual(peak[JAB], 1, 'one call at a time to JAB');
  assert.strictEqual(peak.total, 2, 'the two gyms ran concurrently');
  for (const uid of [a, b]) for (const g of [PSYCLE, JAB]) assert.strictEqual(bookingRows(uid, g).length, 1);
});

check('an overlapping tick is skipped while a cycle runs', async () => {
  const uid = twoGymUser();
  onlyDue([uid]);
  resetCalls();
  const before = bookingSync.getStats();
  const first = cycle();
  const second = cycle();
  await Promise.all([first, second]);
  const after = bookingSync.getStats();
  assert.strictEqual(after.cycles - before.cycles, 1, 'one pass');
  assert.strictEqual(after.ticksSkipped - before.ticksSkipped, 1, 'the overlapping tick is counted as skipped');
  assert.strictEqual(calls[PSYCLE].listBookings, 1);
});

check('the boot cycle staggers each lane by a random delay', async () => {
  const delays = bookingSync._laneStartDelays({ boot: true, lanes: 4, maxMs: 1000, rand: () => 0.5 });
  assert.deepStrictEqual(delays, [500, 500, 500, 500]);
  assert.deepStrictEqual(bookingSync._laneStartDelays({ boot: false, lanes: 2, maxMs: 1000 }), [0, 0]);
});

check('T-5 new-booking listener: never on a link\'s first sync; afterwards only rows new as server rows', async () => {
  const seen = [];
  bookingSync.setNewBookingsListener((uid, gymId, rows) => { seen.push({ uid, gymId, ids: rows.map((r) => String(r.bookingId)) }); });
  try {
    const uid = twoGymUser();
    resetCalls();
    await bookingSync.syncUserGym(uid, PSYCLE, { force: true }); // first ever sync: everything is "new", so silence
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(seen, []);
    await bookingSync.syncUserGym(uid, PSYCLE, { force: true }); // the stub hands out a fresh booking id each call
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(seen, [{ uid, gymId: PSYCLE, ids: [`${PSYCLE}-b2`] }]);
  } finally { bookingSync.setNewBookingsListener(null); }
});

check('T-5 review: a re-import of a booking a client push dropped is not a new booking', async () => {
  const seen = [];
  bookingSync.setNewBookingsListener((uid, gymId, rows) => { seen.push(rows.map((r) => String(r.bookingId))); });
  const fixed = [{ bookingId: 'keep-1', eventId: `${PSYCLE}-e1`, slotLabel: '7', event: ev(PSYCLE, `${PSYCLE}-e1`, 3) }];
  override[PSYCLE] = async () => fixed;
  try {
    const uid = twoGymUser();
    await bookingSync.syncUserGym(uid, PSYCLE, { force: true }); // first sync: silent, but the id is now known
    // A stale client list (or a gym answering a short list once) drops the server row...
    db.replaceBookingCache(uid, [], [PSYCLE]);
    assert.strictEqual(bookingRows(uid, PSYCLE).length, 0);
    // ...and the next server sync puts it back. Same booking, so no "booked" push.
    await bookingSync.syncUserGym(uid, PSYCLE, { force: true });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(seen, []);
    // A genuinely new id still counts.
    fixed.push({ bookingId: 'new-2', eventId: `${PSYCLE}-e2`, slotLabel: '8', event: ev(PSYCLE, `${PSYCLE}-e2`, 4) });
    await bookingSync.syncUserGym(uid, PSYCLE, { force: true });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(seen, [['new-2']]);
  } finally { bookingSync.setNewBookingsListener(null); delete override[PSYCLE]; }
});

check('cycle counters are exposed (aggregate only)', async () => {
  const s = bookingSync.getStats();
  for (const k of ['cycles', 'usersSynced', 'gymsSynced', 'gymsFailed', 'gymsSkipped']) {
    assert.strictEqual(typeof s[k], 'number', `stats.${k} is a number`);
  }
  assert.ok(s.cycles >= 1 && s.gymsSynced >= 1 && s.gymsFailed >= 1 && s.gymsSkipped >= 1);
});


check('forced syncs are budgeted per (user, gym): FORCED_MAX per window, then skipped as forceLimited', async () => {
  const uid = twoGymUser();
  const other = twoGymUser();
  let t = Date.now();
  bookingSync._setClock(() => t);
  bookingSync._resetForcedLog();
  resetCalls();
  try {
    const before = bookingSync.getStats().skipped.forceLimited;
    for (let i = 0; i < bookingSync.FORCED_MAX + 2; i++) await bookingSync.syncUser(uid, { force: true, gymIds: [PSYCLE] });
    assert.strictEqual(calls[PSYCLE].listBookings, bookingSync.FORCED_MAX, 'only FORCED_MAX forced fetches reach the gym');
    assert.strictEqual(bookingSync.getStats().skipped.forceLimited - before, 2);
    assert.ok(bookingRows(uid, PSYCLE).length > 0, 'a skipped forced sync keeps the stored rows');
    // Another gym of the same account, and another account, have their own budgets.
    await bookingSync.syncUser(uid, { force: true, gymIds: [JAB] });
    assert.strictEqual(calls[JAB].listBookings, 1);
    await bookingSync.syncUser(other, { force: true, gymIds: [PSYCLE] });
    assert.strictEqual(calls[PSYCLE].listBookings, bookingSync.FORCED_MAX + 1);
    // The regular (cadence) path is never limited by it.
    db.setBookingSyncState(uid, PSYCLE, { lastSyncedAt: new Date(0).toISOString(), lastAttemptAt: new Date(0).toISOString(), lastError: null });
    await bookingSync.syncUser(uid, { gymIds: [PSYCLE], now: Date.now() });
    assert.strictEqual(calls[PSYCLE].listBookings, bookingSync.FORCED_MAX + 2, 'a due non-forced sync still runs');
    // Once the window has passed, forced syncs are allowed again.
    t += bookingSync.FORCED_WINDOW_MS + 1;
    await bookingSync.syncUser(uid, { force: true, gymIds: [PSYCLE] });
    assert.strictEqual(calls[PSYCLE].listBookings, bookingSync.FORCED_MAX + 3);
  } finally {
    bookingSync._setClock(null);
    bookingSync._resetForcedLog();
  }
});

check('a forced sync past the budget is deferred, not lost: one trailing sync when the window frees a slot', async () => {
  const uid = twoGymUser();
  let t = Date.now();
  const timers = [];
  bookingSync._setClock(() => t);
  bookingSync._setTimer((fn, ms) => { timers.push({ fn, ms }); return 0; });
  bookingSync._resetForcedLog();
  resetCalls();
  try {
    for (let i = 0; i < bookingSync.FORCED_MAX; i++) { await bookingSync.syncUser(uid, { force: true, gymIds: [PSYCLE] }); t += 1000; }
    const deferredBefore = bookingSync.getStats().forceDeferred;
    // Three more asks inside the window (a burst of book/cancel): skipped quietly, ONE deferral.
    for (let i = 0; i < 3; i++) {
      const synced = await bookingSync.syncUser(uid, { force: true, gymIds: [PSYCLE] });
      assert.deepStrictEqual(synced, [], 'a limited forced sync resolves quietly with nothing synced');
    }
    assert.strictEqual(calls[PSYCLE].listBookings, bookingSync.FORCED_MAX);
    assert.strictEqual(timers.length, 1, 'skipped calls coalesce into one trailing sync');
    assert.strictEqual(bookingSync._deferredForcedCount(), 1);
    assert.strictEqual(bookingSync.getStats().forceDeferred - deferredBefore, 1);
    // It is timed for the moment the oldest forced fetch leaves the window (never sooner).
    const firstAt = t - bookingSync.FORCED_MAX * 1000;
    assert.ok(t + timers[0].ms >= firstAt + bookingSync.FORCED_WINDOW_MS, `deferred until a slot frees (${timers[0].ms} ms)`);
    // When it fires, the gym is fetched once (the latest booking lands) and the budget holds.
    t = firstAt + bookingSync.FORCED_WINDOW_MS + 1;
    timers[0].fn();
    for (let i = 0; i < 20 && calls[PSYCLE].listBookings === bookingSync.FORCED_MAX; i++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(calls[PSYCLE].listBookings, bookingSync.FORCED_MAX + 1, 'the trailing sync reached the gym once');
    assert.strictEqual(bookingSync._deferredForcedCount(), 0);
  } finally {
    bookingSync._setClock(null);
    bookingSync._setTimer(null);
    bookingSync._resetForcedLog();
  }
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
