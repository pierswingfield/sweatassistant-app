// T-2 (Teams projection): the privacy matrix. PLAN-teams.md §2, §3, §4, §7.3.
//
// The Teams counterpart of test-gym-isolation.js: a multi-user, multi-gym Team on a real
// in-memory database, driven through teams.js (the functions the routes return verbatim),
// asserting that every item a member did NOT share, or the viewer may NOT see, is ABSENT
// from the serialized payload. Each withheld item carries a unique marker string in its
// class name (or spot label), so absence is a substring check on the JSON, not a check of
// one field that a future refactor could rename around.
//
// Viewer V links Psycle + JAB; viewer V2 links Psycle only (the "+N at other gyms" rule).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.JAB_BOXING_ENABLED = 'true';

const assert = require('assert');
const crypto = require('crypto');

const db = require('./db');
const teams = require('./teams');
const bookingSync = require('./booking-sync');
const history = require('./class-history');
const sharing = require('./team-sharing');

const PSY = 'psycle-london';
const JAB = 'jab-boxing';
const NOW = Date.parse('2026-11-10T10:00:00Z'); // a Tuesday; London is on GMT
teams.__setNow(() => NOW);
const at = (h, m = 0, dayOffset = 0) => new Date(Date.UTC(2026, 10, 10 + dayOffset, h, m)).toISOString();

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- fixture --------------------------------------------------------------------

const emails = [];
function mkUser(first, gyms) {
  const email = `leak-${first.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@privacy.test`;
  emails.push(email);
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email).lastInsertRowid;
  db.setUserSettings(id, { firstName: first, lastName: 'Zed' });
  for (const g of gyms) db.upsertUserGym(id, g, { gym_email: `gymlogin-${first.toLowerCase()}@${g}.test` });
  return id;
}

const pending = new Map(); // `${uid}|${gym}` -> rows
function book(uid, gym, { id, event, start, name, slot = '', dur = 45, origin = 'server' }) {
  const k = `${uid}|${gym}|${origin}`;
  if (!pending.has(k)) pending.set(k, []);
  pending.get(k).push({ bookingId: id, gymId: gym, eventId: event, startAt: start, className: name, slotLabel: slot, durationMin: dur, locationName: `${gym} Studio` });
}
function flush() {
  for (const [k, rows] of pending) {
    const [uid, gym, origin] = k.split('|');
    db.replaceBookingCache(Number(uid), rows, [gym], { origin });
    db.setBookingSyncState(Number(uid), gym, { lastSyncedAt: new Date(NOW - 30 * 60000).toISOString() });
  }
  pending.clear();
}
const hist = (uid, gym, rows) => history.upsertEntries(uid, gym, rows.map((r) => ({ timeZone: 'Europe/London', durationMin: 45, ...r })));

function shareWith(over = {}) { return { ...sharing.defaultShare(), ...over }; }

const V = mkUser('Viewer', [PSY, JAB]);
const V2 = mkUser('Psyonly', [PSY]);
const A = mkUser('Alice', [PSY, JAB]);
const B = mkUser('Bruno', [PSY, JAB]);
const U1 = mkUser('Upoff', [PSY]);
const W1 = mkUser('Wloff', [PSY]);
const Q1 = mkUser('Queueon', [PSY]);
const SP1 = mkUser('Spotson', [PSY]);
const AC1 = mkUser('Actoff', [PSY]);
const R1 = mkUser('Recoff', [PSY]);
const P1 = mkUser('Pausey', [PSY]);
const G1 = mkUser('Gymsub', [PSY, JAB]);
const D1 = mkUser('Linkoff', [PSY, JAB]);
const RM1 = mkUser('Removedname', [PSY]);
const LF1 = mkUser('Leftname', [PSY]);
const PD1 = mkUser('Pendingname', [PSY]);
const BL1 = mkUser('Blockedname', [PSY]);
const OUT = mkUser('Outsider', [PSY]);

const { team, inviteToken } = teams.createTeam(V, { name: 'Privacy Crew', share: shareWith({ spots: true, autoBookQueue: true }) });
const TEAM = team.id;
function join(uid, share, decision = 'approve') {
  const r = teams.requestJoin(uid, inviteToken, share);
  if (decision) teams.decideRequest(V, TEAM, r.requestId, decision);
}
join(V2, shareWith());
join(A, shareWith());
join(B, shareWith());
join(U1, shareWith({ upcoming: false }));
join(W1, shareWith({ waitlists: false }));
join(Q1, shareWith({ autoBookQueue: true }));
join(SP1, shareWith({ spots: true }));
join(AC1, shareWith({ activity: false }));
join(R1, shareWith({ recent: false }));
join(P1, shareWith());
join(G1, shareWith({ gyms: [PSY] }));
join(D1, shareWith());
join(RM1, shareWith());
join(LF1, shareWith());
join(PD1, shareWith(), null);         // stays pending
join(BL1, shareWith(), null);         // then blocked below
const blReq = teams.listRequests(V, TEAM).find((r) => r.name && r.name.startsWith('Blockedname'));
teams.decideRequest(V, TEAM, blReq.requestId || blReq.id, 'block');

// Positive controls (must be PRESENT) and withheld items (must be ABSENT).
book(A, PSY, { id: 9100, event: 100, start: at(7), name: 'POS-a-done-today' });
book(A, PSY, { id: 9101, event: 101, start: at(12), name: 'POS-hot-class', slot: 'SPOT-A-77' });
book(B, PSY, { id: 9201, event: 101, start: at(12), name: 'POS-hot-class', slot: 'SPOT-B-55' });
book(A, JAB, { id: 9102, event: 201, start: at(18), name: 'MARK-jab-a' });
book(A, PSY, { id: 9103, event: 5555, start: at(9, 0, 1), name: 'POS-coll-psy' });
book(B, JAB, { id: 9203, event: 5555, start: at(9, 0, 1), name: 'POS-coll-jab' });
book(U1, PSY, { id: 9301, event: 301, start: at(14), name: 'MARK-upcoming-off' });
book(SP1, PSY, { id: 9401, event: 401, start: at(15), name: 'POS-spots-on', slot: 'SPOT-ON-12' });
book(AC1, PSY, { id: 9501, event: 501, start: at(16), name: 'POS-activity-off-class' });
book(P1, PSY, { id: 9601, event: 601, start: at(13), name: 'MARK-paused' });
book(G1, PSY, { id: 9701, event: 701, start: at(13, 30), name: 'POS-gym-shared' });
book(G1, JAB, { id: 9702, event: 702, start: at(19), name: 'MARK-gym-unshared' });
book(D1, PSY, { id: 9801, event: 801, start: at(11), name: 'POS-link-on' });
book(D1, JAB, { id: 9802, event: 802, start: at(19, 30), name: 'MARK-link-off' });
book(RM1, PSY, { id: 9901, event: 901, start: at(14, 30), name: 'MARK-removed' });
book(LF1, PSY, { id: 9911, event: 911, start: at(14, 45), name: 'MARK-left' });
book(PD1, PSY, { id: 9921, event: 921, start: at(15, 30), name: 'MARK-pending' });
book(BL1, PSY, { id: 9931, event: 931, start: at(15, 45), name: 'MARK-blocked' });
book(OUT, PSY, { id: 9941, event: 941, start: at(16, 30), name: 'MARK-outsider' });
book(A, PSY, { id: 9104, event: 104, start: at(6), name: 'MARK-noshow-booking' }); // history says no-show
flush();
// Client-only rows: pushed by the member's own client, never synced by the server.
bookingSync.acceptClientBookings(A, [
  { bookingId: 9100, gymId: PSY, eventId: 100, startAt: at(7), className: 'POS-a-done-today' },
  { bookingId: 9101, gymId: PSY, eventId: 101, startAt: at(12), className: 'MARK-tampered', slotLabel: 'SPOT-A-77' },
  { bookingId: 9102, gymId: PSY, eventId: 102, startAt: at(17), className: 'MARK-client-only', origin: 'server' },
  { bookingId: 9103, gymId: PSY, eventId: 5555, startAt: at(9, 0, 1), className: 'POS-coll-psy' },
  { bookingId: 9104, gymId: PSY, eventId: 104, startAt: at(6), className: 'MARK-noshow-booking' },
], [PSY], NOW + 3600e3);
db.setBookingSyncState(A, PSY, { lastSyncedAt: new Date(NOW - 3 * 3600e3).toISOString() }); // stale for "Updated 3 h ago"

db.replaceWaitlistCache(A, [{ gymId: PSY, eventId: 111, startAt: at(18, 30), className: 'POS-wl-on' }], [PSY]);
db.replaceWaitlistCache(W1, [{ gymId: PSY, eventId: 112, startAt: at(18, 45), className: 'MARK-wl-off' }], [PSY]);
db.addAutoBooking(A, 121, 'MARK-queue-default-off', 'Inst', 'Studio', 'Loc', at(9, 0, 7), {}, null, null, null, PSY);
db.addAutoBooking(Q1, 122, 'POS-queue-on', 'Inst', 'Studio', 'Loc', at(9, 30, 7), {}, null, null, null, PSY);

hist(A, PSY, [
  { bookingId: 'h1', eventId: 131, status: 'attended', startAt: at(8, 0, -2), name: 'POS-recent-on' },
  { bookingId: 'h2', eventId: 132, status: 'attended', startAt: at(8, 0, -40), name: 'MARK-recent-old' },
  { bookingId: 'h3', eventId: 133, status: 'cancelled', startAt: at(8, 0, -3), name: 'MARK-cancelled' },
  { bookingId: 'h4', eventId: 134, status: 'late-cancel', startAt: at(8, 0, -4), name: 'MARK-late-cancel' },
  { bookingId: 'h5', eventId: 135, status: 'no-show', startAt: at(8, 0, -5), name: 'MARK-no-show' },
  { bookingId: 'h6', eventId: 136, status: 'class-cancelled', startAt: at(8, 0, -6), name: 'MARK-class-cancelled' },
  { bookingId: '9104', eventId: 104, status: 'no-show', startAt: at(6), name: 'MARK-noshow-booking' },
]);
hist(R1, PSY, [{ bookingId: 'r1', eventId: 141, status: 'attended', startAt: at(8, 0, -2), name: 'MARK-recent-off' }]);
hist(A, JAB, [{ bookingId: 'hj', eventId: 151, status: 'attended', startAt: at(8, 0, -1), name: 'MARK-recent-jab' }]);

// State changes after the data exists: pause, link off, remove, leave.
teams.updateMe(P1, TEAM, { pause: '7d' });
db.setUserGymEnabled(D1, JAB, false);
const refOf = (name) => teams.getTeam(V, TEAM).members.find((m) => m.name.startsWith(name)).memberRef;
teams.removeMember(V, TEAM, refOf('Removedname'));
teams.leaveTeam(LF1, TEAM);

const payloads = () => ({
  vList: JSON.stringify(teams.listTeams(V, { zone: 'Europe/London' })),
  vToday: JSON.stringify(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' })),
  v2List: JSON.stringify(teams.listTeams(V2, { zone: 'Europe/London' })),
  v2Today: JSON.stringify(teams.getTeamToday(V2, TEAM, { zone: 'Europe/London' })),
  // T-5: the timetable Team chips (GET /api/teams/timetable) go through every check below.
  vChips: JSON.stringify(teams.timetableChips(V)),
  v2Chips: JSON.stringify(teams.timetableChips(V2)),
});
const P = payloads();
const today = JSON.parse(P.vToday);
const today2 = JSON.parse(P.v2Today);
const absentEverywhere = (marker) => {
  for (const [k, json] of Object.entries(P)) assert.ok(!json.includes(marker), `${marker} leaked into ${k}`);
};
const presentFor = (json, marker, label) => assert.ok(json.includes(marker), `${marker} missing from ${label} (positive control)`);

// --- the matrix -------------------------------------------------------------------

check('positive controls are present (the absence checks below can fail)', () => {
  for (const m of ['POS-hot-class', 'POS-coll-psy', 'POS-coll-jab', 'POS-spots-on', 'POS-gym-shared', 'POS-link-on',
    'POS-wl-on', 'POS-queue-on', 'POS-recent-on', 'POS-a-done-today', 'MARK-jab-a', 'POS-activity-off-class']) {
    presentFor(P.vToday, m, 'V today');
  }
  presentFor(P.vList, 'POS-hot-class', 'V list (hottest line)');
  presentFor(P.vToday, 'MARK-recent-jab', 'V today (V has JAB)');
});
check('upcoming off: the booking is absent', () => absentEverywhere('MARK-upcoming-off'));
check('waitlists off: the waitlist is absent', () => absentEverywhere('MARK-wl-off'));
check('autoBookQueue off (the default): the queued class is absent', () => absentEverywhere('MARK-queue-default-off'));
check('spots off (the default): spot labels are absent; spots on shows only that member\'s', () => {
  absentEverywhere('SPOT-A-77');
  absentEverywhere('SPOT-B-55');
  const hot = today.classes.find((c) => c.key === `${PSY}:101`);
  assert.ok(hot.attendees.every((a) => !('spot' in a)));
});
check('D13 (ii): spots on, but the viewer is not in that class: the spot is absent everywhere', () => {
  // SP1 shares spots; neither V nor V2 is booked, waitlisted or queued for event 401.
  // The full same-class matrix is test-team-spots.js.
  absentEverywhere('SPOT-ON-12');
  presentFor(P.vToday, 'POS-spots-on', 'V today (the class itself still shows)');
});
check('activity off: no counts, and the class is not in the Team\'s day totals', () => {
  const ac = today.members.find((m) => m.name.startsWith('Actoff'));
  assert.strictEqual(ac.counts, null);
  // Today's activity-counted distinct classes: A 100, 101(+B), A JAB 201, SP1 401,
  // G1 701, D1 801 (P1 paused, AC1 activity off, U1 upcoming off still counts: activity on).
  const keys = ['100', '101', '201', '401', '701', '801', '301'];
  assert.strictEqual(today.today.total, keys.length, JSON.stringify(today.today));
});
check('recent off: history is absent; recent older than 30 days is absent', () => {
  absentEverywhere('MARK-recent-off');
  absentEverywhere('MARK-recent-old');
});
check('cancelled, late-cancel, no-show and class-cancelled are never shared', () => {
  for (const m of ['MARK-cancelled', 'MARK-late-cancel', 'MARK-no-show', 'MARK-class-cancelled', 'MARK-noshow-booking']) absentEverywhere(m);
});
check('paused member: no items, no counts, no freshness', () => {
  absentEverywhere('MARK-paused');
  const p = today.members.find((m) => m.name.startsWith('Pausey'));
  assert.ok(p, 'a paused member is still listed by name');
  assert.strictEqual(p.counts, null);
  assert.strictEqual(p.updatedAt, null);
});
check('gym not in share.gyms: absent, and not counted at "other gyms" either', () => {
  absentEverywhere('MARK-gym-unshared');
  assert.ok(!today.classes.some((c) => c.key === `${JAB}:702`));
});
check('member\'s gym link disabled: absent and not counted', () => {
  absentEverywhere('MARK-link-off');
  assert.ok(!today.classes.some((c) => c.key === `${JAB}:802`));
});
check('viewer lacks the gym: details absent (no gym id anywhere), count present', () => {
  for (const json of [P.v2List, P.v2Today]) {
    for (const m of ['MARK-jab-a', 'POS-coll-jab', 'MARK-recent-jab']) assert.ok(!json.includes(m), `${m} leaked to V2`);
    assert.ok(!json.includes(JAB), 'the unlinked gym id leaked to V2');
  }
  for (const json of [P.v2Chips]) {
    assert.ok(!json.includes(JAB), 'the unlinked gym id leaked to V2');
  }
  assert.strictEqual(today2.otherGyms.upcoming, 2, 'A 201 today + B 5555 tomorrow at JAB');
  assert.strictEqual(today2.today.otherGyms, 1);
  assert.strictEqual(today2.otherGyms.recent, 1);
  assert.strictEqual(today2.today.total, today.today.total, 'the Team\'s day counts the same for both viewers (§4)');
  assert.deepStrictEqual(today2.mascot, today.mascot);
});
check('removed member: name and items absent', () => { absentEverywhere('MARK-removed'); absentEverywhere('Removedname'); });
check('left member: name and items absent', () => { absentEverywhere('MARK-left'); absentEverywhere('Leftname'); });
check('pending requester: name and items absent', () => { absentEverywhere('MARK-pending'); absentEverywhere('Pendingname'); });
check('blocked requester: name and items absent', () => { absentEverywhere('MARK-blocked'); absentEverywhere('Blockedname'); });
check('a non-member\'s items are absent', () => absentEverywhere('MARK-outsider'));
check('client-pushed-only rows never reach a Team; a client cannot rename a server row', () => {
  absentEverywhere('MARK-client-only');
  absentEverywhere('MARK-tampered');
  const row = db.db.prepare('SELECT origin, class_name FROM booking_cache WHERE user_id = ? AND gym_id = ? AND booking_id = ?').get(A, PSY, 9102);
  assert.strictEqual(row.origin, 'client', 'a body-supplied origin is ignored');
  const kept = db.db.prepare('SELECT origin, class_name FROM booking_cache WHERE user_id = ? AND gym_id = ? AND booking_id = ?').get(A, PSY, 9101);
  assert.deepStrictEqual(kept, { origin: 'server', class_name: 'POS-hot-class' });
});
check('key collision: the same event id at two gyms stays two classes', () => {
  const psy = today.classes.find((c) => c.key === `${PSY}:5555`);
  const jab = today.classes.find((c) => c.key === `${JAB}:5555`);
  assert.ok(psy && jab);
  assert.strictEqual(psy.className, 'POS-coll-psy');
  assert.strictEqual(jab.className, 'POS-coll-jab');
  assert.strictEqual(psy.attendees.length, 1);
  assert.strictEqual(jab.attendees.length, 1);
  assert.notStrictEqual(psy.attendees[0].memberRef, jab.attendees[0].memberRef);
});
check('no user ids, emails, gym logins or tokens in any payload', () => {
  const banned = /^(user_?id|userIds?|email|gym_?email|gymLogin|password|token|inviteToken|share_json)$/i;
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        assert.ok(!banned.test(k), `banned key ${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  for (const [k, json] of Object.entries(P)) {
    walk(JSON.parse(json), k);
    for (const e of emails) assert.ok(!json.includes(e), `${e} in ${k}`);
    assert.ok(!/gymlogin-|@privacy\.test|\.test"/.test(json), `a login identity in ${k}`);
  }
});
check('non-members, removed and left people get NOT_FOUND, never data', () => {
  for (const uid of [OUT, RM1, LF1, PD1, BL1]) {
    assert.throws(() => teams.getTeamToday(uid, TEAM), (e) => e.code === 'NOT_FOUND');
    assert.ok(!JSON.stringify(teams.listTeams(uid)).includes('Privacy Crew'));
  }
});
check('a viewer\'s own hidden items follow their own share (V sees what the Team sees)', () => {
  const vRef = today.members.find((m) => m.isMe).memberRef;
  assert.ok(vRef && !today.members.some((m) => m.isMe && m.memberRef !== vRef));
});
check('freshness: updatedAt from the server sync, stale past the 2 h cadence', () => {
  const a = today.members.find((m) => m.name.startsWith('Alice'));
  assert.strictEqual(a.updatedAt, new Date(NOW - 3 * 3600e3).toISOString());
  assert.strictEqual(a.stale, true);
  const g = today.members.find((m) => m.name.startsWith('Gymsub'));
  assert.strictEqual(g.stale, false, 'only the shared gym (Psycle) is considered');
});
check('list card: hottest line names the shared class, members active today, no class lists', () => {
  const card = JSON.parse(P.vList).find((t) => t.id === TEAM);
  assert.strictEqual(card.today.hottest.count, 2);
  assert.strictEqual(card.today.hottest.className, 'POS-hot-class');
  assert.ok(!('classes' in card) && !('recent' in card));
  assert.ok(card.activeToday.length >= 3);
  assert.ok(card.mascot && card.mascot.asset.startsWith('/characters/team-'));
});
check('pause takes effect at once: unpausing restores, pausing removes, with no cached copy', () => {
  teams.updateMe(A, TEAM, { pause: '24h' });
  const json = JSON.stringify(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' }));
  assert.ok(!json.includes('POS-a-done-today') && !json.includes('MARK-jab-a'));
  teams.updateMe(A, TEAM, { pause: null });
  assert.ok(JSON.stringify(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' })).includes('MARK-jab-a'));
});
check('share toggled off later removes at once', () => {
  teams.updateMe(A, TEAM, { share: { waitlists: false } });
  assert.ok(!JSON.stringify(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' })).includes('POS-wl-on'));
  teams.updateMe(A, TEAM, { share: { waitlists: true } });
  // spots toggled off with the viewer in the same class: test-team-spots.js.
});
check('unlinking a gym removes its items on the next request', () => {
  const C = mkUser('Unlinker', [PSY, JAB]);
  join(C, shareWith());
  book(C, JAB, { id: 9991, event: 991, start: at(20), name: 'MARK-unlinked-later' });
  flush();
  assert.ok(JSON.stringify(teams.getTeamToday(V, TEAM)).includes('MARK-unlinked-later'));
  db.unlinkGym(C, JAB);
  assert.ok(!JSON.stringify(teams.getTeamToday(V, TEAM)).includes('MARK-unlinked-later'));
});
check('T-B priority set: Team members sharing upcoming classes, not paused, not solo', () => {
  const ids = teams.priorityMemberIds();
  assert.ok(ids.has(A) && ids.has(V));
  assert.ok(!ids.has(U1), 'upcoming off');
  assert.ok(!ids.has(P1), 'paused');
  for (const uid of [OUT, RM1, LF1, PD1, BL1]) assert.ok(!ids.has(uid));
  const solo = mkUser('Solo', [PSY]);
  teams.createTeam(solo, { name: 'Just me' });
  assert.ok(!teams.priorityMemberIds().has(solo), 'nobody else can see a one-member Team');
  bookingSync.setPriorityPredicate(() => teams.priorityMemberIds());
  assert.strictEqual(bookingSync.cadenceFor(A), bookingSync.PRIORITY_CADENCE_MS);
  assert.strictEqual(bookingSync.cadenceFor(U1), bookingSync.DEFAULT_CADENCE_MS);
});
check('server.js installs the Team priority predicate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  assert.ok(/setPriorityPredicate\(\(\) => require\('\.\/teams'\)\.priorityMemberIds\(\)\)/.test(src));
});
check('a re-sync keeps today\'s started server rows (done classes) but drops cancelled future ones', () => {
  const E = mkUser('Resync', [PSY]);
  db.replaceBookingCache(E, [
    { bookingId: 1, gymId: PSY, eventId: 1, startAt: new Date(Date.now() - 2 * 3600e3).toISOString(), className: 'started' },
    { bookingId: 2, gymId: PSY, eventId: 2, startAt: new Date(Date.now() + 5 * 3600e3).toISOString(), className: 'future' },
  ], [PSY], { origin: 'server' });
  db.replaceBookingCache(E, [], [PSY], { origin: 'server', retainStartedMs: bookingSync.RETAIN_STARTED_MS });
  const names = db.db.prepare('SELECT class_name FROM booking_cache WHERE user_id = ?').all(E).map((r) => r.class_name);
  assert.deepStrictEqual(names, ['started']);
});
check('booking-id collision across gyms: a client push to gym B never inherits gym A\'s server origin', () => {
  const X = mkUser('Collider', [PSY, JAB]);
  join(X, shareWith());
  book(X, PSY, { id: 7777, event: 7001, start: at(20, 15), name: 'POS-collide-server' });
  flush();
  bookingSync.acceptClientBookings(X, [
    { bookingId: 7777, gymId: PSY, eventId: 7001, startAt: at(20, 15), className: 'POS-collide-server' },
    { bookingId: 7777, gymId: JAB, eventId: 7002, startAt: at(20, 30), className: 'MARK-collide-client' },
  ], [PSY, JAB], NOW + 3600e3);
  const origin = (gym) => db.db.prepare('SELECT origin FROM booking_cache WHERE user_id = ? AND gym_id = ? AND booking_id = ?').get(X, gym, 7777).origin;
  assert.strictEqual(origin(PSY), 'server');
  assert.strictEqual(origin(JAB), 'client', 'the JAB push was marked server because Psycle holds booking 7777');
  const json = JSON.stringify(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' }));
  assert.ok(json.includes('POS-collide-server'));
  assert.ok(!json.includes('MARK-collide-client'), 'a client-only JAB row reached the Team');
});
check('a started server row missing from the next sync is hidden from Teams until class history confirms it', () => {
  const Y = mkUser('Retainer', [PSY]);
  join(Y, shareWith());
  const total = () => teams.getTeamToday(V, TEAM, { zone: 'Europe/London' }).today.total;
  const base = total();
  const rows = [
    { bookingId: 8801, gymId: PSY, eventId: 8801, startAt: at(8), className: 'MARK-retained-unconfirmed', durationMin: 45 },
    { bookingId: 8802, gymId: PSY, eventId: 8802, startAt: at(8, 15), className: 'POS-retained-confirmed', durationMin: 45 },
  ];
  db.replaceBookingCache(Y, rows, [PSY], { origin: 'server', now: NOW });
  db.setBookingSyncState(Y, PSY, { lastSyncedAt: new Date(NOW - 30 * 60000).toISOString() });
  assert.strictEqual(total(), base + 2, 'present in the latest sync: shown');
  // The next sync no longer lists either (started, or late-cancelled: the list cannot say which).
  db.replaceBookingCache(Y, [], [PSY], { origin: 'server', retainStartedMs: bookingSync.RETAIN_STARTED_MS, now: NOW });
  hist(Y, PSY, [{ bookingId: '8802', eventId: '8802', status: 'unconfirmed', startAt: at(8, 15), name: 'POS-retained-confirmed' }]);
  const t = teams.getTeamToday(V, TEAM, { zone: 'Europe/London' });
  const json = JSON.stringify(t) + JSON.stringify(teams.listTeams(V, { zone: 'Europe/London' }));
  assert.ok(!json.includes('MARK-retained-unconfirmed'), 'an unconfirmed retained row was shown');
  assert.ok(!t.classes.some((c) => c.key === `${PSY}:8801`));
  assert.ok(json.includes('POS-retained-confirmed'), 'history-confirmed row is shown');
  assert.strictEqual(t.today.total, base + 1, 'only the confirmed class counts toward the day and the mascot');
  const yc = t.members.find((m) => m.name.startsWith('Retainer')).counts;
  assert.strictEqual(yc.week, 1);
  // The member's own (non-Team) views still see the retained row, as before.
  const own = db.getBookingCacheAllGyms(Y).map((r) => r.class_name).sort();
  assert.deepStrictEqual(own, ['MARK-retained-unconfirmed', 'POS-retained-confirmed']);
});
// ---- T-3 dashboard fields ----------------------------------------------------------

const memberIn = (payload, name) => payload.members.find((m) => m.name.startsWith(name));
check('T-3 member gym chips: only gyms the viewer has linked; an unlinked one is never named or flagged', () => {
  assert.deepStrictEqual(memberIn(today, 'Alice').gyms, [JAB, PSY].sort());
  const a2 = memberIn(today2, 'Alice');
  assert.deepStrictEqual(a2.gyms, [PSY], 'V2 has not linked JAB');
  assert.ok(!P.v2Today.includes(JAB), 'the unlinked gym id leaked to V2 via member chips');
  for (const m of [...today.members, ...today2.members]) assert.ok(!('otherGym' in m), `per-member otherGym flag sent for ${m.name}`);
});
check('T-3 review: a member sharing only a gym the viewer has not linked shows no chips, flag or freshness', () => {
  teams.updateMe(A, TEAM, { share: shareWith({ gyms: [JAB] }) });
  try {
    const seen = memberIn(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' }), 'Alice');
    assert.deepStrictEqual(seen.gyms, [JAB], 'control: V has JAB linked');
    assert.ok(seen.updatedAt, 'control: V sees JAB freshness');
    const hidden = memberIn(teams.getTeamToday(V2, TEAM, { zone: 'Europe/London' }), 'Alice');
    assert.deepStrictEqual(hidden.gyms, []);
    assert.ok(!('otherGym' in hidden));
    assert.deepStrictEqual([hidden.updatedAt, hidden.stale], [null, false], 'JAB sync time leaked to a viewer without JAB');
  } finally {
    teams.updateMe(A, TEAM, { share: shareWith() });
  }
});
check('T-3 member gym chips follow share.gyms, the member\'s link state, pause and an all-off share', () => {
  assert.deepStrictEqual(memberIn(today, 'Gymsub').gyms, [PSY], 'JAB is not in share.gyms');
  assert.deepStrictEqual(memberIn(today, 'Linkoff').gyms, [PSY], 'the JAB link is disabled');
  assert.deepStrictEqual(memberIn(today, 'Pausey').gyms, [], 'a paused member shows no gyms');
  const allOff = { upcoming: false, waitlists: false, activity: false, recent: false, spots: false, autoBookQueue: false };
  teams.updateMe(U1, TEAM, { share: allOff });
  try {
    for (const viewer of [V, V2]) {
      const n = memberIn(teams.getTeamToday(viewer, TEAM, { zone: 'Europe/London' }), 'Upoff');
      assert.deepStrictEqual(n.gyms, [], 'sharing nothing shows no gyms');
    }
  } finally {
    teams.updateMe(U1, TEAM, { share: shareWith({ upcoming: false }) });
  }
});
check('T-3 pending request count reaches Captains only, never members', () => {
  assert.strictEqual(today.pendingRequestCount, 1, 'Pendingname waits; Blockedname was decided');
  const asMember = teams.getTeamToday(A, TEAM, { zone: 'Europe/London' });
  assert.ok(!('pendingRequestCount' in asMember));
  assert.ok(!('pendingRequestCount' in today2), 'V2 is a member, not a Captain');
  assert.ok(!JSON.stringify(asMember).includes('Pendingname'));
});
check('T-3 every class attendee is a current member by memberRef; no attendee carries a name or id', () => {
  const refs = new Set(today.members.map((m) => m.memberRef));
  for (const c of [...today.classes, ...today.recent]) {
    for (const a of c.attendees) {
      assert.ok(refs.has(a.memberRef), `unknown attendee ${a.memberRef}`);
      assert.deepStrictEqual(Object.keys(a).filter((k) => !['memberRef', 'kind', 'spot'].includes(k)), []);
    }
  }
});

// ---- T-4 Team stats -----------------------------------------------------------------
// A separate Team so the T-2/T-3 totals above stay as they are. NOW is Tuesday 10 Nov
// 10:00 London; the week began Monday 9 Nov; "last week up to now" ends Tue 3 Nov 10:00.
// Every withheld class lands on a day or in a bucket that would change an exact number.
const S1 = mkUser('Statsall', [PSY, JAB]);
const S2 = mkUser('Statsnorecent', [PSY]);
const S3 = mkUser('Statsnoactivity', [PSY]);
const S4 = mkUser('Statspaused', [PSY]);
const { team: statsTeam, inviteToken: statsTok } = teams.createTeam(V, { name: 'Stats Crew', share: shareWith() });
const joinStats = (uid, share) => teams.decideRequest(V, statsTeam.id, teams.requestJoin(uid, statsTok, share).requestId, 'approve');
joinStats(V2, shareWith());
joinStats(S1, shareWith());
joinStats(S2, shareWith({ recent: false }));
joinStats(S3, shareWith({ activity: false }));
joinStats(S4, shareWith());
hist(S1, PSY, [
  { bookingId: 's1a', eventId: 1, status: 'attended', startAt: at(9, 0, -8), name: 'S1 Mon last week' },
  { bookingId: 's1b', eventId: 2, status: 'unconfirmed', startAt: at(8, 0, -7), name: 'S1 Tue last week' },
  { bookingId: 's1c', eventId: 3, status: 'attended', startAt: at(8, 0, -1), name: 'S1 Mon' },
  { bookingId: 's1x', eventId: 4, status: 'late-cancel', startAt: at(12, 0, -1), name: 'S1 late cancel' },
  { bookingId: 's1y', eventId: 5, status: 'cancelled', startAt: at(9, 0, -3), name: 'S1 cancelled Sat' },
]);
hist(S1, JAB, [{ bookingId: 's1j', eventId: 6, status: 'attended', startAt: at(18, 0, -2), name: 'S1 Sun JAB' }]);
// A done server booking today (counts), a started one the next sync dropped and history
// never confirmed (missing_since: must not count), and a client-only done row (never).
db.replaceBookingCache(S1, [
  { bookingId: 5101, gymId: PSY, eventId: 5101, startAt: at(7), className: 'S1 today', durationMin: 45 },
  { bookingId: 5103, gymId: PSY, eventId: 5103, startAt: at(8), className: 'S1 dropped', durationMin: 45 },
], [PSY], { origin: 'server', now: NOW });
db.replaceBookingCache(S1, [{ bookingId: 5101, gymId: PSY, eventId: 5101, startAt: at(7), className: 'S1 today', durationMin: 45 }],
  [PSY], { origin: 'server', retainStartedMs: bookingSync.RETAIN_STARTED_MS, now: NOW });
db.setBookingSyncState(S1, PSY, { lastSyncedAt: new Date(NOW - 30 * 60000).toISOString() });
bookingSync.acceptClientBookings(S1, [
  { bookingId: 5101, gymId: PSY, eventId: 5101, startAt: at(7), className: 'S1 today' },
  { bookingId: 5102, gymId: PSY, eventId: 5102, startAt: at(6), className: 'S1 client only' },
], [PSY], NOW + 3600e3);
hist(S2, PSY, [
  { bookingId: 's2a', eventId: 7, status: 'attended', startAt: at(12, 0, -1), name: 'S2 Mon' },
  { bookingId: 's2b', eventId: 8, status: 'attended', startAt: at(11, 0, -3), name: 'S2 Sat' },
]);
hist(S3, PSY, [
  { bookingId: 's3a', eventId: 9, status: 'attended', startAt: at(10, 0, -3), name: 'S3 Sat' },
  { bookingId: 's3b', eventId: 11, status: 'attended', startAt: at(10, 0, -1), name: 'S3 Mon' }, // this week: would move the week total
]);
hist(S4, PSY, [{ bookingId: 's4a', eventId: 10, status: 'attended', startAt: at(9, 0, -3), name: 'S4 Sat' }]);
teams.updateMe(S4, statsTeam.id, { pause: '7d' });
const statsFor = (uid) => teams.getTeamToday(uid, statsTeam.id, { zone: 'Europe/London' });

check('T-4 fixture: the excluded rows exist in storage (so their absence below is meaningful)', () => {
  const rows = db.db.prepare('SELECT booking_id, origin, missing_since FROM booking_cache WHERE user_id = ? ORDER BY booking_id').all(S1);
  assert.ok(rows.some((r) => String(r.booking_id) === '5102' && r.origin === 'client'), JSON.stringify(rows));
  assert.ok(rows.some((r) => String(r.booking_id) === '5103' && r.missing_since), JSON.stringify(rows));
});
check('T-4 classes this week: activity sharers, every shared gym; client-only, unconfirmed, cancelled and paused never count', () => {
  // This week: S1 Mon 08:00, S1 today 07:00 (booking), S2 Mon 12:00. Last week up to now: S1 Mon 2, Tue 3 Nov.
  // A leak of 5102 (client), 5103 (missing_since), s1x (late cancel), S3 Mon (activity off) or S4 (paused) changes 3 or 2.
  assert.deepStrictEqual(statsFor(V).stats.week, { thisWeek: 3, lastWeek: 2, delta: 1 });
});
check('T-4 Team streak: activity AND recent sharers at gyms the viewer has linked only', () => {
  // S1: Sun 8 (JAB), Mon 9, Tue 10 = 3 days. Saturday 7 Nov is offered only by S2 (recent off),
  // S3 (activity off), S4 (paused) and S1's cancelled row: any leak makes it 4.
  const expected = { days: 3, since: '2026-11-08', capped: false };
  assert.deepStrictEqual(statsFor(V).stats.streak, expected);
  // V2 lacks JAB: the JAB Sunday must not hold the run (it would date S1's JAB visit).
  assert.deepStrictEqual(statsFor(V2).stats.streak, { days: 2, since: '2026-11-09', capped: false });
});
check('T-4 charts: recent sharers at gyms the viewer has linked only', () => {
  const c = statsFor(V).stats.charts;
  // S1: Mon 2 09h, Tue 3 08h, Sun 8 18h (JAB), Mon 9 08h, Tue 10 07h; S3 Sat 7 and Mon 9 10h (recent on, activity off).
  assert.strictEqual(c.total, 7);
  assert.deepStrictEqual(c.busiestDays, [3, 2, 0, 0, 0, 1, 1]);
  assert.deepStrictEqual([c.busiestTimes[7], c.busiestTimes[8], c.busiestTimes[9], c.busiestTimes[10], c.busiestTimes[18]], [1, 2, 1, 2, 1]);
  assert.strictEqual(c.busiestTimes[11] + c.busiestTimes[12], 0, 'S2 (recent off) is not charted');
  assert.deepStrictEqual(c.gymMix, [{ gymId: PSY, count: 6 }, { gymId: JAB, count: 1 }]);
});
check('T-4 viewer without the gym: no gym id or name, and the unlinked gym never moves the gym mix or the charts', () => {
  const p = statsFor(V2);
  const json = JSON.stringify(p);
  assert.ok(!json.includes(JAB), 'the unlinked gym id reached V2');
  assert.ok(!/JAB/i.test(json.replace(/"name":"[^"]*"/g, '')), 'a JAB name reached V2');
  assert.deepStrictEqual(p.stats.charts.gymMix, [{ gymId: PSY, count: 6 }], 'only V2\'s gyms, and the JAB class is not folded in');
  assert.strictEqual(p.stats.charts.total, 6);
  assert.deepStrictEqual(p.stats.charts.busiestDays, [3, 2, 0, 0, 0, 1, 0], 'the JAB Sunday is not charted for V2');
  assert.deepStrictEqual(p.stats.week, statsFor(V).stats.week, 'D2: totals still count the unlinked gym');
});
check('T-4 stats carry no member identity: no memberRef, name, user id or class detail', () => {
  const json = JSON.stringify(statsFor(V).stats);
  assert.ok(!/memberRef|name|userId|email|className|eventId|booking/i.test(json), json);
  for (const n of ['Statsall', 'Statsnorecent', 'S1 ', 'S2 ']) assert.ok(!json.includes(n), n);
});
check('T-4 small Team: a member who hides history cannot be recovered by subtracting the viewer\'s own classes', () => {
  const DV = mkUser('Duoviewer', [PSY]);
  const DM = mkUser('Duohider', [PSY]);
  const { team: duo, inviteToken: duoTok } = teams.createTeam(DV, { name: 'Duo', share: shareWith() });
  teams.decideRequest(DV, duo.id, teams.requestJoin(DM, duoTok, shareWith({ recent: false })).requestId, 'approve');
  hist(DV, PSY, [{ bookingId: 'dv1', eventId: 1, status: 'attended', startAt: at(8, 0, -1), name: 'DV Mon' }]);
  hist(DM, PSY, [
    { bookingId: 'dm1', eventId: 2, status: 'attended', startAt: at(8, 0, -2), name: 'DM Sun' },
    { bookingId: 'dm2', eventId: 3, status: 'attended', startAt: at(18, 0, -1), name: 'DM Mon' },
  ]);
  const p = teams.getTeamToday(DV, duo.id, { zone: 'Europe/London' });
  // Charts and streak are exactly DV's own: nothing of DM's day or hour pattern.
  assert.strictEqual(p.stats.charts.total, 1);
  assert.strictEqual(p.stats.charts.busiestTimes[18], 0);
  assert.deepStrictEqual(p.stats.streak, { days: 1, since: '2026-11-09', capped: false }, 'DM\'s Sunday must not extend the streak');
  // The week total includes DM, but only as much as DM's own shared activity count already says.
  const dm = p.members.find((m) => m.name.startsWith('Duohider'));
  const dv = p.members.find((m) => m.isMe);
  assert.strictEqual(p.stats.week.thisWeek, dm.counts.week + dv.counts.week);
  // With activity off too, DM contributes nothing at all.
  teams.updateMe(DM, duo.id, { share: { activity: false } });
  const q = teams.getTeamToday(DV, duo.id, { zone: 'Europe/London' });
  assert.strictEqual(q.stats.week.thisWeek, 1);
});
check('T-4 small Team: the streak cannot date a teammate\'s classes at a gym the viewer has not linked', () => {
  const DV = mkUser('Trioviewer', [PSY]);
  const DM = mkUser('Triojab', [PSY, JAB]);
  const { team: duo, inviteToken: duoTok } = teams.createTeam(DV, { name: 'Duo JAB', share: shareWith() });
  teams.decideRequest(DV, duo.id, teams.requestJoin(DM, duoTok, shareWith()).requestId, 'approve');
  hist(DV, PSY, [{ bookingId: 'tv1', eventId: 1, status: 'attended', startAt: at(8, 0, -1), name: 'TV Mon' }]);
  hist(DM, JAB, [
    { bookingId: 'tj1', eventId: 2, status: 'attended', startAt: at(18, 0, -2), name: 'TJ Sun' },
    { bookingId: 'tj2', eventId: 3, status: 'attended', startAt: at(18, 0, -3), name: 'TJ Sat' },
  ]);
  const p = teams.getTeamToday(DV, duo.id, { zone: 'Europe/London' });
  assert.deepStrictEqual(p.stats.streak, { days: 1, since: '2026-11-09', capped: false }, 'DM\'s JAB weekend extended the streak');
  assert.strictEqual(p.stats.charts.total, 1);
});
check('T-4 a non-member gets NOT_FOUND for the stats-bearing payload', () => {
  for (const uid of [OUT, PD1]) assert.throws(() => teams.getTeamToday(uid, statsTeam.id), (e) => e.code === 'NOT_FOUND');
});
check('T-4 the list payload (GET /api/teams) carries no stats', () => {
  const card = teams.listTeams(V, { zone: 'Europe/London' }).find((t) => t.id === statsTeam.id);
  assert.ok(card && !('stats' in card));
});

check('GET /api/teams resolves each member\'s name once per request, across all Teams', () => {
  const { team: t2, inviteToken: tok2 } = teams.createTeam(V, { name: 'Second Crew' });
  for (const uid of [A, B, V2]) {
    const r = teams.requestJoin(uid, tok2, shareWith());
    teams.decideRequest(V, t2.id, r.requestId, 'approve');
  }
  const orig = db.getAccountSettings;
  const calls = new Map();
  db.getAccountSettings = function (uid) { calls.set(uid, (calls.get(uid) || 0) + 1); return orig.apply(this, arguments); };
  try { teams.listTeams(V, { zone: 'Europe/London' }); } finally { db.getAccountSettings = orig; }
  assert.ok(calls.size > 0, 'the name resolver was not observed');
  for (const [uid, n] of calls) assert.strictEqual(n, 1, `user ${uid} resolved ${n} times`);
});

// --- T-5: timetable chips and pushes -----------------------------------------------------
// Chips carry no class names (only gym-qualified keys, Team names and member names), so
// the withheld items are identified by their event ids: the chip key set must be EXACTLY
// the classes V may see a teammate BOOKED into, upcoming, at a gym V has linked.

const chipKeys = (json) => JSON.parse(json).classes.map((c) => c.key).sort();
check('T-5 chips: exactly the upcoming classes a teammate is booked into that the viewer may see', () => {
  const want = [`${PSY}:101`, `${JAB}:201`, `${PSY}:5555`, `${JAB}:5555`, `${PSY}:401`, `${PSY}:501`, `${PSY}:701`, `${PSY}:801`].sort();
  assert.deepStrictEqual(chipKeys(P.vChips), want);
  // upcoming off 301, paused 601, gym not shared 702, link off 802, removed/left/pending/
  // blocked/outsider 901-941, no-show 104, client-only 102, done 100, waitlist 111/112 and
  // queue 121/122 (chips are booked teammates only) are all absent by construction above.
});
check('T-5 chips: a viewer without the gym gets no chip there, no gym id, no count', () => {
  assert.deepStrictEqual(chipKeys(P.v2Chips), [`${PSY}:101`, `${PSY}:5555`, `${PSY}:401`, `${PSY}:501`, `${PSY}:701`, `${PSY}:801`].sort());
  assert.ok(!P.v2Chips.includes(JAB));
});
check('T-5 chips: members are teammates only (never the viewer), with no spot, id or class detail', () => {
  const chips = JSON.parse(P.vChips);
  const hot = chips.classes.find((c) => c.key === `${PSY}:101`);
  assert.deepStrictEqual(hot.teams.map((t) => t.name), ['Privacy Crew']);
  assert.deepStrictEqual(hot.teams[0].members.map((m) => m.name.split(' ')[0]).sort(), ['Alice', 'Bruno']);
  for (const c of chips.classes) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['eventId', 'gymId', 'key', 'teams']);
    for (const t of c.teams) {
      assert.deepStrictEqual(Object.keys(t).sort(), ['emoji', 'members', 'name', 'pinned', 'teamId']);
      for (const m of t.members) {
        assert.deepStrictEqual(Object.keys(m).sort(), ['colourIndex', 'lastInitial', 'memberRef', 'name']);
        assert.ok(!m.name.startsWith('Viewer'), 'the viewer is never their own teammate');
      }
    }
  }
  assert.ok(!/SPOT-/.test(P.vChips), 'spot labels never reach a chip (spots-on member included)');
});
check('T-5 chips: an outsider, a pending requester and a removed member get no chips', () => {
  for (const uid of [OUT, PD1, RM1, LF1, BL1]) assert.deepStrictEqual(teams.timetableChips(uid), { classes: [] });
});
check('T-5 chips: one batched row load per request, not one per class or Team', () => {
  const teamData = require('./team-data');
  const orig = teamData.rowsForUsers;
  let calls = 0;
  teamData.rowsForUsers = function () { calls++; return orig.apply(this, arguments); };
  try { teams.timetableChips(V); } finally { teamData.rowsForUsers = orig; }
  assert.strictEqual(calls, 1);
});

// Pushes: captured at the push service, never sent. Each body is checked for what it must
// never carry (another member's data beyond their share, emails, ids, places, spots).
const pushService = require('./push');
const teamNotify = require('./team-notify');
const sent = [];
pushService.sendNotification = async (userId, title, body, data) => { sent.push({ userId, title, body, data }); };
// T-5b: Team pushes are opt-in per Team (team_members.alerts_enabled, off by default).
const allowAlerts = (uid, teamId) => teams.updateMe(uid, teamId, { alertsEnabled: true });
const pushJson = () => JSON.stringify(sent);
const assertCleanPush = (p) => {
  assert.deepStrictEqual(Object.keys(p.data).sort(), ['type', 'url']);
  assert.match(p.data.url, /^\/teams\/[A-Za-z0-9_-]+$/);
  const text = `${p.title} ${p.body}`;
  assert.ok(!/@|gymlogin|Studio|SPOT-|memberRef|userId/.test(text), `push text leaks: ${text}`);
  for (const e of emails) assert.ok(!text.includes(e));
};

check('T-5 push "teammate booked": only a visible, sharing, unpaused, server-synced booker reaches a teammate in the class', async () => {
  sent.length = 0;
  const PV = mkUser('Pushview', [PSY]);
  const PA = mkUser('Pushann', [PSY]);
  const PU = mkUser('Pushupoff', [PSY]);
  const PP = mkUser('Pushpaused', [PSY]);
  const PG = mkUser('Pushgymjab', [PSY, JAB]);
  const PL = mkUser('Pushlinkoff', [PSY]);
  const PC = mkUser('Pushclient', [PSY]);
  const { team: pt, inviteToken: ptok } = teams.createTeam(PV, { name: 'Push Crew', share: shareWith() });
  const add = (uid, share) => teams.decideRequest(PV, pt.id, teams.requestJoin(uid, ptok, share).requestId, 'approve');
  add(PA, shareWith()); add(PU, shareWith({ upcoming: false })); add(PP, shareWith());
  add(PG, shareWith({ gyms: [JAB] })); add(PL, shareWith()); add(PC, shareWith());
  teams.updateMe(PP, pt.id, { pause: '24h' });
  allowAlerts(PV, pt.id);
  const ev = 7001;
  const start = at(9, 0, 2);
  book(PV, PSY, { id: 77000, event: ev, start, name: 'Push class', slot: 'SPOT-PV-1' });
  for (const [uid, id] of [[PA, 77001], [PU, 77002], [PP, 77003], [PG, 77004], [PL, 77005]]) {
    book(uid, PSY, { id, event: ev, start, name: 'Push class', slot: `SPOT-X-${id}` });
  }
  flush();
  db.setUserGymEnabled(PL, PSY, false);
  bookingSync.acceptClientBookings(PC, [{ bookingId: 77006, gymId: PSY, eventId: ev, startAt: start, className: 'Push class' }], [PSY], NOW + 3600e3);
  const rows = [{ bookingId: 1, eventId: ev, startAt: start }];
  for (const uid of [PU, PP, PG, PL, PC]) {
    const r = await teamNotify.newServerBookings(uid, PSY, rows);
    assert.deepStrictEqual(r, [], `user ${uid} should not notify anyone`);
  }
  assert.strictEqual(sent.length, 0, pushJson());
  const r = await teamNotify.newServerBookings(PA, PSY, rows);
  // PV opted in; the other teammates in the class keep the default (off); PP is paused.
  assert.deepStrictEqual(r.filter((x) => x.outcome === 'sent').map((x) => x.recipientId), [PV]);
  assert.ok(!r.some((x) => x.recipientId === PP), 'a paused member gets no Team pushes');
  assert.strictEqual(sent.length, 1);
  const p = sent[0];
  assert.strictEqual(p.userId, PV, 'only the teammate who is in the class');
  assert.strictEqual(p.title, 'Push Crew');
  assert.match(p.body, /^Pushann booked .* a class you're in\.$/);
  assert.strictEqual(p.data.url, `/teams/${pt.id}`);
  assertCleanPush(p);
  // The same class on PV's timetable: a chip with Pushann only, never PV, no spot.
  const chip = teams.timetableChips(PV).classes.find((c) => c.key === `${PSY}:${ev}`);
  assert.deepStrictEqual(chip.teams.map((t) => t.members.map((m) => m.name.split(' ')[0])), [['Pushann']]);
  assert.ok(!JSON.stringify(chip).includes('SPOT-'));
  // The others' names never ride along (PU, PP, PG, PL, PC are all in the class).
  for (const n of ['Pushupoff', 'Pushpaused', 'Pushgymjab', 'Pushlinkoff', 'Pushclient']) assert.ok(!pushJson().includes(n), n);
});
check('T-5 push "teammate booked": off by default, and a viewer without the gym is never told', async () => {
  sent.length = 0;
  const QV = mkUser('Quietview', [PSY, JAB]);
  const QJ = mkUser('Quietjab', [PSY, JAB]);
  const QN = mkUser('Quietnojab', [PSY]);
  const { team: qt, inviteToken: qtok } = teams.createTeam(QV, { name: 'Quiet Crew', share: shareWith() });
  for (const uid of [QJ, QN]) teams.decideRequest(QV, qt.id, teams.requestJoin(uid, qtok, shareWith()).requestId, 'approve');
  allowAlerts(QN, qt.id);
  const start = at(9, 0, 3);
  book(QV, JAB, { id: 78001, event: 7101, start, name: 'Quiet jab' });
  book(QJ, JAB, { id: 78002, event: 7101, start, name: 'Quiet jab' });
  // QN holds a stray row for the same JAB event id without a JAB link (cannot see JAB).
  book(QN, PSY, { id: 78003, event: 7101, start, name: 'Psy same id' });
  flush();
  const r = await teamNotify.newServerBookings(QJ, JAB, [{ bookingId: 78002, eventId: 7101, startAt: start }]);
  // QV keeps the per-Team default (off), so is not even a candidate; QN is at the other gym.
  assert.deepStrictEqual(r, []);
  assert.strictEqual(sent.length, 0);
});
check('T-5 push "join request": to unpaused Captains only, with no requester name', async () => {
  sent.length = 0;
  const C1 = mkUser('Capone', [PSY]);
  const C2 = mkUser('Captwo', [PSY]);
  const C3 = mkUser('Capthree', [PSY]);
  const M1 = mkUser('Memberonly', [PSY]);
  const RQ = mkUser('Requesterzed', [PSY]);
  const { team: ct, inviteToken: ctok } = teams.createTeam(C1, { name: 'Cap Crew', share: shareWith() });
  for (const uid of [C2, C3, M1]) teams.decideRequest(C1, ct.id, teams.requestJoin(uid, ctok, shareWith()).requestId, 'approve');
  const ref = (n) => teams.getTeam(C1, ct.id).members.find((m) => m.name.startsWith(n)).memberRef;
  teams.setCaptain(C1, ct.id, ref('Captwo'), true);
  teams.setCaptain(C1, ct.id, ref('Capthree'), true);
  teams.updateMe(C3, ct.id, { pause: 'indefinite' });
  for (const uid of [C1, C2, C3, M1]) allowAlerts(uid, ct.id); // opted in: the paused Captain and the member still get nothing
  teams.requestJoin(RQ, ctok, shareWith());
  await teamNotify.joinRequested(ct.id);
  assert.deepStrictEqual(sent.map((p) => p.userId).sort((a, b) => a - b), [C1, C2].sort((a, b) => a - b));
  for (const p of sent) {
    assertCleanPush(p);
    assert.strictEqual(p.title, 'Cap Crew');
    assert.ok(!pushJson().includes('Requesterzed'), 'the requester is not named on a lock screen');
  }
});
check('T-5 push "approved": to the requester only, naming only the Team', async () => {
  sent.length = 0;
  const C1 = mkUser('Appcap', [PSY]);
  const RQ = mkUser('Appreq', [PSY]);
  const { team: at_, inviteToken: atok } = teams.createTeam(C1, { name: 'Approve Crew', share: shareWith() });
  const { requestId } = teams.requestJoin(RQ, atok, shareWith());
  teams.decideRequest(C1, at_.id, requestId, 'approve');
  assert.strictEqual(await teamNotify.requestApproved(at_.id, RQ, requestId), 'sent');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].userId, RQ);
  assert.strictEqual(sent[0].body, 'Your request to join Approve Crew was approved.');
  assertCleanPush(sent[0]);
  assert.ok(!pushJson().includes('Appcap'));
  // Removed before the push goes out: nothing is sent.
  sent.length = 0;
  const RQ2 = mkUser('Appgone', [PSY]);
  const r2 = teams.requestJoin(RQ2, atok, shareWith());
  teams.decideRequest(C1, at_.id, r2.requestId, 'approve');
  teams.removeMember(C1, at_.id, teams.getTeam(C1, at_.id).members.find((m) => m.name.startsWith('Appgone')).memberRef);
  assert.strictEqual(await teamNotify.requestApproved(at_.id, RQ2, r2.requestId), 'gone');
  assert.strictEqual(sent.length, 0);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
