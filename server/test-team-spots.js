// D13 (ii), owner 2026-11-06 (PLAN-teams.md §8.1): a teammate's shared spot reaches a
// viewer ONLY when the viewer is booked into, waitlisted for or queued for the SAME
// gym-qualified class (`gymId:eventId`). Enforced in team-projection.js; this suite drives
// it through teams.js (the payloads the routes return verbatim) on a real in-memory DB and
// checks every surface a spot could reach: dashboard attendee rows (which the member cards
// read), timetable chips and their popover, the Home/Teams list, and push bodies.
//
// Each spot label is a unique marker, so absence is a substring check on the JSON.
//
// The viewer's own attendance is strict: only rows the viewer cannot mint from the client
// count. A client-pushed-only booking (booking_cache.origin = 'client'), an unconfirmed
// `missing_since` row, a late-cancelled booking and a booking at a gym whose link is
// switched off all count as NOT attending.

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
const { viewerAttendance } = require('./team-projection');

const PSY = 'psycle-london';
const JAB = 'jab-boxing';
const NOW = Date.parse('2026-11-10T10:00:00Z'); // Tuesday; London on GMT
teams.__setNow(() => NOW);
const at = (h, m = 0, d = 0) => new Date(Date.UTC(2026, 10, 10 + d, h, m)).toISOString();

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function mkUser(first, gyms) {
  const email = `spot-${first.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@spots.test`;
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email).lastInsertRowid;
  db.setUserSettings(id, { firstName: first, lastName: 'Zed' });
  for (const g of gyms) db.upsertUserGym(id, g, { gym_email: `${first.toLowerCase()}@${g}.test` });
  return id;
}
const row = (id, gym, event, start, slot = '') => ({ bookingId: id, gymId: gym, eventId: event, startAt: start, className: `Class ${event}`, slotLabel: slot, durationMin: 45 });
function serverRows(uid, gym, rows) {
  db.replaceBookingCache(uid, rows, [gym], { origin: 'server' });
  db.setBookingSyncState(uid, gym, { lastSyncedAt: new Date(NOW - 30 * 60000).toISOString() });
}
const share = (over = {}) => ({ ...sharing.defaultShare(), ...over });

const V = mkUser('Viewer', [PSY, JAB]);
const V2 = mkUser('Bystander', [PSY, JAB]); // attends nothing
const A = mkUser('Ana', [PSY, JAB]);        // shares spots
const N = mkUser('Nospot', [PSY, JAB]);     // spots off (the default)

const { team, inviteToken } = teams.createTeam(V, { name: 'Spot Crew', share: share() });
const TEAM = team.id;
for (const [uid, s] of [[V2, share()], [A, share({ spots: true })], [N, share()]]) {
  teams.decideRequest(V, TEAM, teams.requestJoin(uid, inviteToken, s).requestId, 'approve');
}

// Ana's (and Nospot's) bookings, one class per case.
serverRows(A, PSY, [
  row(1500, PSY, 500, at(12), 'SPOT-SAME-BOOKED'),
  row(1501, PSY, 501, at(12, 30), 'SPOT-NOT-ATTENDING'),
  row(1510, PSY, 510, at(13), 'SPOT-SAME-WAITLIST'),
  row(1520, PSY, 520, at(9, 0, 7), 'SPOT-SAME-QUEUE'),
  row(1530, PSY, 530, at(14), 'SPOT-VIEWER-CLIENT-ONLY'),
  row(1540, PSY, 540, at(14, 30), 'SPOT-VIEWER-MISSING'),
  row(1560, PSY, 560, at(15), 'SPOT-VIEWER-LATECANCEL'),
]);
serverRows(A, JAB, [
  row(2600, JAB, 600, at(16), 'SPOT-OTHER-GYM'),       // V is in PSY:600, not JAB:600
  row(2550, JAB, 550, at(17), 'SPOT-VIEWER-LINK-OFF'),
]);
serverRows(N, PSY, [row(3500, PSY, 500, at(12), 'SPOT-SHARING-OFF')]);

// The viewer's own rows.
serverRows(V, PSY, [
  row(9500, PSY, 500, at(12), 'VSPOT-1'),
  row(9600, PSY, 600, at(16)),
  row(9540, PSY, 540, at(14, 30)),
  row(9560, PSY, 560, at(15)),
]);
serverRows(V, JAB, [row(9550, JAB, 550, at(17))]);
// A booking for 530 that only the viewer's client claims (merged with the server's list,
// so the server rows above survive the push).
bookingSync.acceptClientBookings(V, [
  row(9500, PSY, 500, at(12), 'VSPOT-1'), row(9600, PSY, 600, at(16)), row(9540, PSY, 540, at(14, 30)), row(9560, PSY, 560, at(15)),
  row(9530, PSY, 530, at(14)),
], [PSY], NOW + 3600e3);
db.setBookingSyncState(V, PSY, { lastSyncedAt: new Date(NOW - 30 * 60000).toISOString() });
// The latest sync no longer lists 9540 and history has not confirmed it.
db.db.prepare('UPDATE booking_cache SET missing_since = ? WHERE user_id = ? AND gym_id = ? AND booking_id = ?').run(new Date(NOW - 600e3).toISOString(), V, PSY, '9540');
history.upsertEntries(V, PSY, [{ bookingId: '9560', eventId: 560, status: 'late-cancel', startAt: at(15), timeZone: 'Europe/London', durationMin: 45, name: 'x' }]);
db.replaceWaitlistCache(V, [{ gymId: PSY, eventId: 510, startAt: at(13), className: 'Class 510' }], [PSY]);
db.addAutoBooking(V, 520, 'Class 520', 'Inst', 'Studio', 'Loc', at(9, 0, 7), {}, null, null, null, PSY);
db.setUserGymEnabled(V, JAB, false);

const todayOf = (uid) => teams.getTeamToday(uid, TEAM, { zone: 'Europe/London' });
const payloadsFor = (uid) => ({
  today: JSON.stringify(todayOf(uid)),
  list: JSON.stringify(teams.listTeams(uid, { zone: 'Europe/London' })),
  chips: JSON.stringify(teams.timetableChips(uid)),
});
const anaRef = () => todayOf(V).members.find((m) => m.name.startsWith('Ana')).memberRef;
const spotOf = (p, key, ref) => {
  const c = (p.classes || []).find((x) => x.key === key);
  const a = c && c.attendees.find((x) => x.memberRef === ref);
  return a ? (a.spot || null) : undefined;
};

check('same class, booked: the viewer sees the teammate\'s spot on the dashboard', () => {
  assert.strictEqual(spotOf(todayOf(V), `${PSY}:500`, anaRef()), 'SPOT-SAME-BOOKED');
});
check('same class, waitlisted: the viewer sees it', () => {
  assert.strictEqual(spotOf(todayOf(V), `${PSY}:510`, anaRef()), 'SPOT-SAME-WAITLIST');
});
check('same class, queued to auto-book: the viewer sees it', () => {
  assert.strictEqual(spotOf(todayOf(V), `${PSY}:520`, anaRef()), 'SPOT-SAME-QUEUE');
});
check('a different class: no spot, though the class itself is shown', () => {
  assert.strictEqual(spotOf(todayOf(V), `${PSY}:501`, anaRef()), null);
  for (const json of Object.values(payloadsFor(V))) assert.ok(!json.includes('SPOT-NOT-ATTENDING'));
});
check('a different gym with the same event id: no spot (keys are gym-qualified)', () => {
  assert.strictEqual(spotOf(todayOf(V), `${JAB}:600`, anaRef()), null);
  for (const json of Object.values(payloadsFor(V))) assert.ok(!json.includes('SPOT-OTHER-GYM'));
});
check('not attending anything: a bystander never sees a spot on any surface', () => {
  for (const [k, json] of Object.entries(payloadsFor(V2))) assert.ok(!/SPOT-|VSPOT-/.test(json), `spot leaked into bystander ${k}`);
  assert.strictEqual(spotOf(todayOf(V2), `${PSY}:500`, anaRef()), null, 'the class is listed, the spot is not');
});
check('share.spots off: never seen, even by a viewer in the same class', () => {
  for (const json of Object.values(payloadsFor(V))) assert.ok(!json.includes('SPOT-SHARING-OFF'));
  teams.updateMe(A, TEAM, { share: { spots: false } });
  try {
    for (const json of Object.values(payloadsFor(V))) assert.ok(!/SPOT-SAME/.test(json), 'Ana turned spots off');
  } finally { teams.updateMe(A, TEAM, { share: { spots: true } }); }
});
check('strict attendance: client-only, unconfirmed missing, late-cancelled and link-off rows do not count', () => {
  const all = Object.values(payloadsFor(V)).join('\n');
  for (const m of ['SPOT-VIEWER-CLIENT-ONLY', 'SPOT-VIEWER-MISSING', 'SPOT-VIEWER-LATECANCEL', 'SPOT-VIEWER-LINK-OFF']) {
    assert.ok(!all.includes(m), `${m} reached the viewer`);
  }
});
check('timetable chip popover: the teammate\'s spot only on the class the viewer is in', () => {
  const chips = teams.timetableChips(V).classes;
  const same = chips.find((c) => c.key === `${PSY}:500`);
  const ana = same.teams[0].members.find((m) => m.name.startsWith('Ana'));
  assert.strictEqual(ana.spot, 'SPOT-SAME-BOOKED');
  assert.ok(!same.teams[0].members.some((m) => m.name.startsWith('Viewer')), 'the viewer is never their own teammate');
  const other = chips.find((c) => c.key === `${PSY}:501`);
  assert.ok(other.teams[0].members.every((m) => !('spot' in m)));
});
check('Home and the Teams list carry no spot at all (no attendee rows)', () => {
  for (const uid of [V, V2, A]) assert.ok(!/SPOT-|VSPOT-/.test(payloadsFor(uid).list));
});
check('the viewer\'s own spot follows the same rule (they are in their own class)', () => {
  teams.updateMe(V, TEAM, { share: { spots: true } });
  try {
    const vRef = todayOf(V).members.find((m) => m.isMe).memberRef;
    assert.strictEqual(spotOf(todayOf(V), `${PSY}:500`, vRef), 'VSPOT-1');
    assert.strictEqual(spotOf(todayOf(A), `${PSY}:500`, vRef), 'VSPOT-1', 'Ana is in 500 too');
    assert.ok(!payloadsFor(V2).today.includes('VSPOT-1'), 'the bystander is not');
  } finally { teams.updateMe(V, TEAM, { share: { spots: false } }); }
});
check('push bodies never carry a spot, even for a teammate in the same class', async () => {
  const pushService = require('./push');
  const teamNotify = require('./team-notify');
  const sent = [];
  const orig = pushService.sendNotification;
  pushService.sendNotification = async (userId, title, body, data) => { sent.push({ userId, title, body, data }); };
  try {
    teams.updateMe(V, TEAM, { alertsEnabled: true });
    const r = await teamNotify.newServerBookings(A, PSY, [{ bookingId: 1500, eventId: 500, startAt: at(12) }]);
    assert.ok(r.some((x) => x.recipientId === V && x.outcome === 'sent'), JSON.stringify(r));
    assert.ok(sent.length >= 1);
    assert.ok(!/SPOT-|VSPOT-/.test(JSON.stringify(sent)), JSON.stringify(sent));
  } finally { pushService.sendNotification = orig; }
});
check('viewerAttendance (pure): exactly the rows that count', () => {
  const links = [{ gym_id: 'g', account_enabled: 1 }, { gym_id: 'off', account_enabled: 0 }];
  const s = viewerAttendance({
    links,
    bookings: [
      { gym_id: 'g', booking_id: 1, event_id: 10, origin: 'server', start_at: at(12) },
      { gym_id: 'g', booking_id: 2, event_id: 11, origin: 'client', start_at: at(12) },
      { gym_id: 'g', booking_id: 3, event_id: 12, origin: 'server', start_at: at(12), missing_since: 'x' },
      { gym_id: 'g', booking_id: 4, event_id: 13, origin: 'server', start_at: at(8), missing_since: 'x' }, // confirmed below
      { gym_id: 'g', booking_id: 5, event_id: 14, origin: 'server', start_at: at(12) },                    // no-show below
      { gym_id: 'off', booking_id: 6, event_id: 15, origin: 'server', start_at: at(12) },
    ],
    waitlists: [{ gym_id: 'g', event_id: 20, start_at: at(12) }, { gym_id: 'g', event_id: 21, start_at: at(8) }],
    queue: [
      { gym_id: 'g', event_id: 30, start_at: at(12), status: 'pending' },
      { gym_id: 'g', event_id: 31, start_at: at(12), status: 'executed', executed_at: 'x' },
    ],
    history: [{ gym_id: 'g', booking_id: 4, status: 'attended' }, { gym_id: 'g', booking_id: 5, status: 'no-show' }],
  }, NOW);
  assert.deepStrictEqual([...s].sort(), ['g:10', 'g:13', 'g:20', 'g:30']);
  assert.strictEqual(viewerAttendance(null, NOW).size, 0);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
