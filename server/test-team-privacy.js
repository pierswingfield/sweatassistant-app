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
    'POS-wl-on', 'POS-queue-on', 'POS-recent-on', 'POS-a-done-today', 'MARK-jab-a', 'SPOT-ON-12', 'POS-activity-off-class']) {
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
  teams.updateMe(SP1, TEAM, { share: { spots: false } });
  assert.ok(!JSON.stringify(teams.getTeamToday(V, TEAM, { zone: 'Europe/London' })).includes('SPOT-ON-12'));
  teams.updateMe(SP1, TEAM, { share: { spots: true } });
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

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
