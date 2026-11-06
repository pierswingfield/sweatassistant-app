// Demo fixture accounts (users.is_fixture; server/scripts/seed-team-fixtures.js).
//
// A fixture looks like a member in Teams, but the server must never contact a gym for it:
//  (a) the provider boundary refuses any call carrying the fixture session before network
//      I/O (fetch is stubbed and counted; the adapter's own request() refuses too);
//  (b) every background scanner (relogin, scheduler, poller, booking sync, class-history
//      sync, calendar) skips a fixture's rows quietly: no call, no needs_relogin flag, no
//      error log, rows untouched;
//  (c) a teammate sees a fixture's shared bookings, waitlists and queue exactly as they
//      would a real member's;
//  (d) nobody can log in as a fixture.
// The seed script itself is exercised at the end against this in-memory DB.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JAB_BOXING_ENABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-fixture-accounts-secret';

const assert = require('assert');
const db = require('./db');
const auth = require('./auth');
const teams = require('./teams');
const sharing = require('./team-sharing');
const history = require('./class-history');
const scheduler = require('./scheduler');
const poller = require('./poller');
const calendar = require('./calendar');
const bookingSync = require('./booking-sync');
const gymOutbound = require('./gym-outbound');
const { getProvider } = require('./providers');
const { getGymConfig } = require('./gyms.config');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

const PSY = 'psycle-london';
const JAB = 'jab-boxing';
const FIX = gymOutbound.FIXTURE_TOKEN;
const NOW = Date.now();
teams.__setNow(() => NOW);
const iso = (offMs) => new Date(NOW + offMs).toISOString();

// --- network + adapter spies --------------------------------------------------------
let fetchCalls = [];
const realFetch = global.fetch;
global.fetch = async (url) => {
  fetchCalls.push(String(url));
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ data: [] }), text: async () => '{}' };
};
const adapterCalls = [];
const restores = [];
function spyAsync(proto) {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (name === 'constructor' || !desc || typeof desc.value !== 'function') continue;
    const fn = desc.value;
    if (!(fn.constructor && fn.constructor.name === 'AsyncFunction')) continue;
    proto[name] = function spied(...a) { adapterCalls.push(`${this && this.gym && this.gym.id}.${name}`); return fn.apply(this, a); };
    restores.push(() => { proto[name] = fn; });
  }
}
spyAsync(CodexFitProvider.prototype);
spyAsync(MarianaTekProvider.prototype);

const errorLogs = [];
const realError = console.error;
console.error = (...a) => { errorLogs.push(a.map(String).join(' ')); };

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- fixtures ---------------------------------------------------------------------------
let seq = 0;
function mkUser(first, { fixture = false, gyms = [PSY] } = {}) {
  const email = `${first.toLowerCase()}-${seq++}@fixture-test.invalid`;
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority, is_fixture) VALUES (?, '', 200, ?)").run(email, fixture ? 1 : 0).lastInsertRowid;
  for (const g of gyms) {
    db.upsertUserGym(id, g, fixture
      ? { display_name: first, session_json: JSON.stringify({ accessToken: FIX }), gym_email: null, encrypted_password: null }
      : { display_name: first, gym_email: `${first}@gym.test` });
  }
  db.setUserSettings(id, { firstName: first, lastName: 'Zed' });
  return id;
}
const F = mkUser('Fixie', { fixture: true, gyms: [PSY, JAB] });

function seedFixtureRows(uid) {
  db.replaceBookingCache(uid, [
    { bookingId: 7001, gymId: PSY, eventId: 701, startAt: iso(2 * 3600e3), className: 'FX-booking', slotLabel: 'Bike 14', durationMin: 45 },
    { bookingId: 7002, gymId: JAB, eventId: 702, startAt: iso(5 * 3600e3), className: 'FX-jab-booking', durationMin: 45 },
  ], [PSY, JAB], { origin: 'server' });
  db.replaceWaitlistCache(uid, [{ gymId: PSY, eventId: 703, startAt: iso(26 * 3600e3), className: 'FX-waitlist' }], [PSY]);
  db.addAutoBooking(uid, 704, 'FX-queue', 'Inst', 'Studio', 'Loc', iso(3 * 864e5), { preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true }, 9, 'RIDE', iso(-1000), PSY);
  db.addAutoUpgrade(uid, 705, 7005, 3, 'FX-upgrade', 'Inst', 'Studio', 'Loc', iso(3 * 864e5), { preferredSlots: [4], preferredRows: [] }, 9, 'RIDE', PSY);
  db.setBookingSyncState(uid, PSY, { lastSyncedAt: iso(-10 * 3600e3) }); // stale on purpose: a cycle would fetch a real member
  db.setBookingSyncState(uid, JAB, { lastSyncedAt: iso(-10 * 3600e3) });
}
seedFixtureRows(F);

// --- (a) the provider boundary -------------------------------------------------------------

check('a provider call carrying a fixture session is refused before any network I/O (both platforms)', async () => {
  fetchCalls = []; adapterCalls.length = 0;
  const session = { accessToken: FIX };
  for (const gymId of [PSY, JAB]) {
    const p = getProvider(gymId);
    for (const call of [
      () => p.listBookings(session), () => p.listWaitlists(session), () => p.getProfile(session),
      () => p.listBookingHistory(session), () => p.fetchTimetable({}, session),
      () => p.refreshSession(session, null), () => p.request('/bookings', { token: FIX }),
      () => p.bookSlot(1, [1], session), () => p.cancelBooking(1, session),
    ]) {
      await assert.rejects(call, (e) => e.code === 'FIXTURE_ACCOUNT', `${gymId}: not refused as FIXTURE_ACCOUNT`);
    }
  }
  assert.deepStrictEqual(adapterCalls, [], `no adapter method ran (got ${adapterCalls.join(', ')})`);
  assert.deepStrictEqual(fetchCalls, [], `zero network calls (got ${fetchCalls.join(', ')})`);
});

check('the adapter itself refuses the fixture token (backstop if the proxy were bypassed)', async () => {
  fetchCalls = [];
  const psy = new CodexFitProvider(getGymConfig(PSY));
  const jab = new MarianaTekProvider(getGymConfig(JAB));
  await assert.rejects(() => psy.request('/bookings', { token: FIX }), (e) => e.code === 'FIXTURE_ACCOUNT');
  await assert.rejects(() => psy.requestV2('/cart', { token: FIX }), (e) => e.code === 'FIXTURE_ACCOUNT');
  await assert.rejects(() => jab.request('/bookings', { token: FIX }), (e) => e.code === 'FIXTURE_ACCOUNT');
  assert.deepStrictEqual(fetchCalls, []);
});

check('positive control: a real token still reaches the (stubbed) network', async () => {
  fetchCalls = [];
  await getProvider(PSY).request('/bookings', { token: 'real-token' });
  assert.strictEqual(fetchCalls.length, 1, 'the fetch stub is live, so the zero counts above mean something');
});

// --- (b) background scanners ---------------------------------------------------------------

check('relogin, history sync, scheduler, poller, booking sync and calendar skip a fixture quietly', async () => {
  fetchCalls = []; adapterCalls.length = 0; errorLogs.length = 0;
  const countRows = () => ({
    bookings: db.db.prepare('SELECT COUNT(*) c FROM booking_cache WHERE user_id = ?').get(F).c,
    waitlists: db.db.prepare('SELECT COUNT(*) c FROM waitlist_cache WHERE user_id = ?').get(F).c,
    queue: db.db.prepare("SELECT COUNT(*) c FROM auto_bookings WHERE user_id = ? AND status = 'pending'").get(F).c,
    upgrades: db.db.prepare("SELECT COUNT(*) c FROM auto_upgrades WHERE user_id = ? AND status = 'active'").get(F).c,
    syncRows: db.db.prepare('SELECT COUNT(*) c FROM booking_sync_state WHERE user_id = ? AND last_error IS NOT NULL').get(F).c,
  });
  const before = countRows();
  const linkBefore = db.getUserGym(F, PSY);

  await assert.rejects(() => auth.triggerAutoRelogin(F, PSY), (e) => e.status === 409);
  await assert.rejects(() => auth.triggerAutoRelogin(F, JAB), (e) => e.status === 409);

  assert.deepStrictEqual(await history.ensureHistory(F, PSY), { ok: true, cached: true, disabled: true });
  assert.strictEqual((await history.syncUserGym(F, JAB, { full: true })).ok, false);
  await history.syncStale({ maxAgeMs: 0 });

  const row = db.getPendingAutoBookingsAllGyms(F).find((b) => b.gym_id === PSY);
  assert.ok(row, 'fixture queue row exists');
  await scheduler.prefetchAutoBookSlots([row], 1);
  await scheduler.executeAutoBookForClass(row);
  scheduler.checkAndRunImmediateBookings(F);
  scheduler.runAllPendingBookings(F);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(scheduler.getNextReleaseInstant ? scheduler.getNextReleaseInstant() : null, null, 'a fixture queue never arms the wake clock');

  await poller.executeAutoUpgradeChecks();
  db.addPushSubscription(F, { endpoint: `https://push.invalid/${F}`, keys: { p256dh: 'x', auth: 'y' } });
  await poller.refreshBookingCaches();
  await bookingSync.runCycle({ jitter: false });
  await bookingSync.syncUser(F, { force: true });
  db.setUserSettings(F, { calendar: { enabled: true } });
  await calendar.refreshUser(F);

  assert.deepStrictEqual(fetchCalls, [], `zero network calls (got ${fetchCalls.join(', ')})`);
  assert.deepStrictEqual(adapterCalls, [], `no adapter method ran (got ${adapterCalls.join(', ')})`);
  assert.deepStrictEqual(countRows(), before, 'rows untouched (no wipe, no burn, no sync error)');
  const linkAfter = db.getUserGym(F, PSY);
  assert.strictEqual(linkAfter.status, linkBefore.status, 'link status untouched');
  assert.notStrictEqual(linkAfter.status, 'needs_relogin');
  assert.strictEqual(linkAfter.relogin_failures || 0, 0, 'no relogin failure recorded');
  assert.strictEqual(linkAfter.relogin_suspended || 0, 0, 'relogin not suspended');
  assert.ok(linkAfter.session_json, 'session not cleared');
  assert.deepStrictEqual(errorLogs.filter((l) => /fixie|user \d+|fixture/i.test(l) || l.includes(`user ${F}`)), [], 'no error logged for the fixture');
});

check('user-facing reads as a fixture hit no provider (refused, never fetched)', async () => {
  const jwt = require('jsonwebtoken');
  const express = require('express');
  const router = require('./routes-normalized');
  fetchCalls = []; adapterCalls.length = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const token = jwt.sign({ userId: F, email: 'x@fixture-test.invalid', tv: db.getTokenVersion(F) }, process.env.JWT_SECRET);
    for (const path of ['/api/timetable', '/api/bookings', '/api/waitlists', '/api/profile', '/api/credits']) {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-gym-id': PSY } });
      assert.ok(res.status >= 400, `${path} answers ${res.status}`);
    }
  } finally { server.close(); }
  assert.deepStrictEqual(fetchCalls.filter((u) => !u.startsWith('http://127.0.0.1')), [], 'no outbound fetch');
  assert.deepStrictEqual(adapterCalls, [], 'no adapter call');
});

// --- (d) no login ---------------------------------------------------------------------------

check('nobody can log in as a fixture, even with a password hash set', async () => {
  const email = db.db.prepare('SELECT email FROM users WHERE id = ?').get(F).email;
  await assert.rejects(() => auth.handleLogin(email, 'any-password'), /Invalid email or password/);
  db.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('scrypt$1$1$1$AAAA$BBBB', F);
  assert.strictEqual(db.hasAccountPassword(F), false);
  assert.strictEqual(db.verifyAccountPassword(F, 'x'), false);
  await assert.rejects(() => auth.handleLogin(email, 'any-password'), /Invalid email or password/);
  db.db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(F);
});

// --- (c) Team projection treats a fixture like a real member -----------------------------------

check('a teammate sees a fixture member\'s shared bookings, waitlists, queue and spots exactly like a real member\'s', async () => {
  const V = mkUser('Viewer', { gyms: [PSY] });
  const R = mkUser('Realy', { gyms: [PSY] });
  const FX = mkUser('Fakey', { fixture: true, gyms: [PSY] });
  const { team, inviteToken } = teams.createTeam(V, { name: 'Projection Crew', share: sharing.defaultShare() });
  const all = { ...sharing.defaultShare(), spots: true, autoBookQueue: true };
  for (const uid of [R, FX]) teams.decideRequest(V, team.id, teams.requestJoin(uid, inviteToken, all).requestId, 'approve');

  const start = (h) => iso(h * 3600e3);
  const give = (uid, tag, bookingBase) => {
    db.replaceBookingCache(uid, [
      { bookingId: bookingBase + 1, gymId: PSY, eventId: 8800, startAt: start(3), className: 'SHARED-CLASS', slotLabel: `${tag}-SEAT`, durationMin: 45 },
      { bookingId: bookingBase + 2, gymId: PSY, eventId: 10000 + bookingBase, startAt: start(6), className: `${tag}-BOOKING`, durationMin: 45 },
    ], [PSY], { origin: 'server' });
    db.replaceWaitlistCache(uid, [{ gymId: PSY, eventId: 11000 + bookingBase, startAt: start(9), className: `${tag}-WAITLIST` }], [PSY]);
    db.addAutoBooking(uid, 12000 + bookingBase, `${tag}-QUEUE`, 'I', 'S', 'L', start(72), {}, null, null, null, PSY);
    db.setBookingSyncState(uid, PSY, { lastSyncedAt: iso(-600e3) });
  };
  // The viewer attends the shared class (server-synced), which unlocks spots (D13 ii).
  db.replaceBookingCache(V, [{ bookingId: 6001, gymId: PSY, eventId: 8800, startAt: start(3), className: 'SHARED-CLASS', slotLabel: 'V-SEAT', durationMin: 45 }], [PSY], { origin: 'server' });
  db.setBookingSyncState(V, PSY, { lastSyncedAt: iso(-600e3) });
  give(R, 'REAL', 100);
  give(FX, 'FAKE', 200);

  const json = JSON.stringify(teams.getTeamToday(V, team.id, { zone: 'UTC' }));
  for (const kind of ['BOOKING', 'WAITLIST', 'QUEUE']) {
    assert.ok(json.includes(`REAL-${kind}`), `fixture precondition: real member's ${kind} shows`);
    assert.ok(json.includes(`FAKE-${kind}`), `fixture member's ${kind} shows like a real member's`);
  }
  assert.ok(json.includes('REAL-SEAT') && json.includes('FAKE-SEAT'), 'both members\' spots show (viewer is in the same class)');
  // Same shape: replacing the tag makes the two members' payload fragments identical.
  const today = teams.getTeamToday(V, team.id, { zone: 'UTC' });
  const strip = (s, tag) => s.replace(new RegExp(`${tag}-`, 'g'), 'X-');
  const itemsOf = (tag) => JSON.stringify(
    (today.classes || []).filter((c) => JSON.stringify(c).includes(`${tag}-`)).map((c) => JSON.parse(strip(JSON.stringify({ ...c, key: undefined, attendees: undefined }), tag))),
  );
  assert.strictEqual(itemsOf('FAKE').length > 2, true, 'fixture items present in the dashboard payload');
  const listFor = (tag) => JSON.parse(strip(JSON.stringify(
    teams.getTeam(V, team.id).members.filter((m) => m.name.startsWith(tag === 'REAL' ? 'Realy' : 'Fakey')).map((m) => ({ ...m, memberRef: null, name: null, colourIndex: null })),
  ), tag));
  assert.deepStrictEqual(listFor('FAKE'), listFor('REAL'), 'the Members entry has the same shape for a fixture and a real member');
});

// --- the seed script ----------------------------------------------------------------------------

check('seed script: dry run changes nothing; a run seeds; a re-run is idempotent; fixtures never hit a provider; --remove cleans up', async () => {
  const { seed } = require('./scripts/seed-team-fixtures');
  const owner = mkUser('Owner', { gyms: [PSY] });
  const { team: lw } = teams.createTeam(owner, { name: '🌈 Lesbian Wednesdays' });
  // The owner's own upcoming class so the seed has a real event to overlap with.
  db.replaceBookingCache(owner, [{ bookingId: 5001, gymId: PSY, eventId: 4242, startAt: iso(30 * 3600e3), className: 'OWNER-REAL-CLASS', studioName: 'Studio A', locationName: 'Oxford', durationMin: 45 }], [PSY], { origin: 'server' });
  const count = (sql) => db.db.prepare(sql).get().c;
  const snapshot = () => ({ users: count('SELECT COUNT(*) c FROM users'), teams: count('SELECT COUNT(*) c FROM teams'), members: count('SELECT COUNT(*) c FROM team_members'),
    bc: count('SELECT COUNT(*) c FROM booking_cache'), req: count('SELECT COUNT(*) c FROM team_join_requests') });
  const base = snapshot();
  const dry = seed({ dryRun: true });
  assert.strictEqual(dry.dryRun, true);
  assert.deepStrictEqual(snapshot(), base, 'dry run rolled everything back');

  fetchCalls = []; adapterCalls.length = 0;
  const r = seed({});
  assert.ok(r.fixtures >= 6);
  assert.ok(r.events.ownerOverlap >= 1 && r.events.real >= 1, 'used the owner\'s real cached class');
  const fx = db.db.prepare("SELECT id FROM users WHERE is_fixture = 1 AND email LIKE '%@fixture.invalid'").all();
  assert.strictEqual(fx.length, r.fixtures);
  assert.ok(fx.every((u) => !db.hasAccountPassword(u.id)), 'no fixture has a password');
  assert.strictEqual(count("SELECT COUNT(*) c FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = '" + lw.id + "' AND u.is_fixture = 1"), 4);
  assert.strictEqual(count("SELECT COUNT(*) c FROM team_join_requests WHERE status = 'pending' AND team_id = '" + lw.id + "'"), 2);
  const lwToday = JSON.stringify(teams.getTeamToday(owner, lw.id, { zone: 'UTC' }));
  assert.ok(lwToday.includes('OWNER-REAL-CLASS'), 'the owner\'s real class carries fixture teammates');
  const second = db.db.prepare("SELECT t.id FROM teams t JOIN users u ON u.id = t.created_by WHERE u.is_fixture = 1").get();
  assert.ok(second && db.db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND is_captain = 0').get(second.id, owner), 'owner is an ordinary member of the fixture Team');

  const once = snapshot();
  seed({});
  assert.deepStrictEqual(snapshot(), once, 're-run is idempotent');

  await poller.refreshBookingCaches(); await bookingSync.runCycle({ jitter: false }); await history.syncStale({ maxAgeMs: 0 });
  assert.deepStrictEqual(fetchCalls, [], 'seeded fixtures never reach the network');
  assert.deepStrictEqual(adapterCalls, []);

  const rm = seed({ remove: true });
  assert.ok(rm.fixturesRemoved >= r.fixtures && rm.teamsRemoved >= 1);
  assert.strictEqual(count('SELECT COUNT(*) c FROM users WHERE is_fixture = 1'), 0, 'every fixture account is gone');
  assert.ok(db.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(lw.id), 'the owner\'s Team survives');
  assert.ok(db.db.prepare('SELECT 1 FROM booking_cache WHERE user_id = ?').get(owner), 'the owner\'s data survives');
  assert.strictEqual(count("SELECT COUNT(*) c FROM team_join_requests WHERE team_id = '" + lw.id + "'"), 0);
});

check('seed script: exits clearly when the owner\'s Team does not exist', async () => {
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, [require('path').join(__dirname, 'scripts', 'seed-team-fixtures.js'), '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, DB_PATH: ':memory:' } });
  assert.strictEqual(res.status, 3);
  assert.ok(/Lesbian Wednesdays/.test(res.stderr));
});

check('seed script: never adopts an existing account that has a password (rolls back; a passwordless row is adopted)', async () => {
  const { seed } = require('./scripts/seed-team-fixtures');
  const lw = db.db.prepare("SELECT id FROM teams WHERE name LIKE '%Lesbian Wednesdays%'").get();
  assert.ok(lw, 'the owner\'s Team survived the previous removal');
  const EMAIL = 'fixture-ana-okafor@fixture.invalid';
  const HASH = 'scrypt$1$1$1$AAAA$BBBB';
  const clash = db.db.prepare("INSERT INTO users (email, encrypted_password, password_hash, priority, is_fixture) VALUES (?, '', ?, 100, 0)").run(EMAIL, HASH).lastInsertRowid;
  const fixturesBefore = db.db.prepare('SELECT COUNT(*) c FROM users WHERE is_fixture = 1').get().c;

  assert.throws(() => seed({}), (e) => e.code === 'FIXTURE_EMAIL_IS_REAL_ACCOUNT' && /password set/.test(e.message), 'refused with a clear message');
  const kept = db.db.prepare('SELECT is_fixture, password_hash FROM users WHERE id = ?').get(clash);
  assert.strictEqual(kept.is_fixture, 0, 'the real account was not flagged as a fixture');
  assert.strictEqual(kept.password_hash, HASH, 'its password is untouched');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM users WHERE is_fixture = 1').get().c, fixturesBefore, 'the aborted run rolled back every other write');
  await assert.rejects(() => auth.handleLogin(EMAIL, 'anything'), /Invalid email or password/, 'the real account still cannot be logged into by the seed');

  // Same address, no password: this is an orphaned fixture row, so it is adopted.
  db.db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(clash);
  const r = seed({});
  assert.ok(r.fixtures >= 6);
  assert.strictEqual(db.db.prepare('SELECT is_fixture FROM users WHERE id = ?').get(clash).is_fixture, 1, 'a passwordless row with the fixture address is adopted');
  seed({ remove: true });
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(clash).c, 0, 'the adopted fixture is removed with the others');
});

check('seed script: a fixture whose join request the owner declined is skipped with a printed note, not fatal', async () => {
  const { seed, printSummary } = require('./scripts/seed-team-fixtures');
  const lw = db.db.prepare("SELECT id FROM teams WHERE name LIKE '%Lesbian Wednesdays%'").get().id;
  const owner = db.db.prepare('SELECT user_id FROM team_members WHERE team_id = ? AND is_captain = 1').get(lw).user_id;
  seed({});
  const priya = db.db.prepare("SELECT id FROM users WHERE email = 'fixture-priya-raman@fixture.invalid'").get().id;
  const req = db.db.prepare("SELECT id FROM team_join_requests WHERE team_id = ? AND user_id = ? AND status = 'pending'").get(lw, priya);
  assert.ok(req, 'precondition: Priya has an open request to the owner\'s Team');
  teams.decideRequest(owner, lw, req.id, 'decline');

  // Re-run: requestJoin now throws REQUEST_DECLINED for Priya. It must not abort the transaction.
  let r;
  assert.doesNotThrow(() => { r = seed({}); }, 'a declined fixture does not abort the run');
  assert.ok(r.fixtures >= 6, 'the rest of the fixtures were still written');
  assert.ok(r.notes.some((n) => /Priya/.test(n) && /declined/.test(n)), 'the skip is recorded as a note');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id = ? AND user_id = ?').get(lw, priya).c, 0, 'the declined fixture is not a member');
  assert.ok(db.db.prepare('SELECT COUNT(*) c FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND u.is_fixture = 1').get(lw).c >= 1, 'other fixtures still joined the owner\'s Team');
  const printed = [];
  const realLog = console.log;
  console.log = (...a) => printed.push(a.join(' '));
  try { printSummary(r); } finally { console.log = realLog; }
  assert.ok(printed.some((l) => /Note: .*Priya.*declined/.test(l)), 'the note is printed in the run summary');
  seed({ remove: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { process.stdout.write(`  FAIL ${name}\n${e.stack}\n`); process.exitCode = 1; }
  }
  restores.forEach((r) => r());
  console.error = realError;
  console.log(`${passed}/${checks.length} fixture-account checks passed`);
  process.exit(process.exitCode || 0);
})();
