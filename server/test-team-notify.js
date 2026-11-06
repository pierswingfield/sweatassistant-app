// T-5 Teams pushes: preferences, dedupe through sent_notifications, rate limits and the
// booking-sync hook (PLAN-teams.md §5.3 "Pushes, opt-in per Team and conservative by
// default"). T-5b: join requests and teammate-booked follow a per-Team switch
// (team_members.alerts_enabled, off by default); "request approved" stays an account switch. Privacy of each push BODY lives in
// test-team-privacy.js; this suite is about how often and to whom.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const crypto = require('crypto');
const db = require('./db');
const teams = require('./teams');
const sharing = require('./team-sharing');
const bookingSync = require('./booking-sync');
const notifications = require('./notifications');
const pushService = require('./push');
const teamNotify = require('./team-notify');

const PSY = 'psycle-london';
let NOW = Date.parse('2026-11-10T10:00:00Z');
teams.__setNow(() => NOW);
const at = (h, dayOffset = 2) => new Date(Date.UTC(2026, 10, 10 + dayOffset, h, 0)).toISOString();

const sent = [];
pushService.sendNotification = async (userId, title, body, data) => { sent.push({ userId, title, body, data }); };

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function mkUser(first) {
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)")
    .run(`n-${first}-${crypto.randomBytes(3).toString('hex')}@notify.test`).lastInsertRowid;
  db.setUserSettings(id, { firstName: first, lastName: 'Q' });
  db.upsertUserGym(id, PSY, {});
  return id;
}
// Opt a member in to Team alerts in one Team, or in every Team they are in.
const optIn = (uid, teamId) => {
  const ids = teamId ? [teamId] : teams.listTeams(uid).map((t) => t.id);
  for (const id of ids) teams.updateMe(uid, id, { alertsEnabled: true });
};
function serverBook(uid, rows) {
  db.replaceBookingCache(uid, rows.map((r) => ({ gymId: PSY, className: 'Ride 45', durationMin: 45, ...r })), [PSY], { origin: 'server' });
}
function team(name, captain, members) {
  const { team: t, inviteToken } = teams.createTeam(captain, { name, share: sharing.defaultShare() });
  for (const uid of members) teams.decideRequest(captain, t.id, teams.requestJoin(uid, inviteToken, sharing.defaultShare()).requestId, 'approve');
  return { id: t.id, inviteToken };
}

check('defaults: per-Team alerts OFF for creator and joiner; only "approved" is an account switch (ON)', () => {
  assert.deepStrictEqual(notifications.DEFAULT_PREFS.teamApproved, { enabled: true });
  assert.ok(!('teamRequest' in notifications.DEFAULT_PREFS) && !('teamBooked' in notifications.DEFAULT_PREFS),
    'join requests and teammate-booked are per Team, not account switches');
  const C = mkUser('Fresh'); const J = mkUser('Joined');
  const t = team('Fresh Crew', C, [J]);
  assert.strictEqual(teams.getTeam(C, t.id).alertsEnabled, false);
  assert.strictEqual(teams.getTeam(J, t.id).alertsEnabled, false);
  assert.strictEqual(teams.alertsEnabledFor(C, t.id), false);
  // An old account-level opt-in stored before T-5b does not switch a Team on.
  db.setUserSettings(J, { notifications: { teamBooked: { enabled: true }, teamRequest: { enabled: true } } });
  assert.strictEqual(teams.alertsEnabledFor(J, t.id), false);
});

check('per-Team switch: saved per membership, validated, and returned in my state', () => {
  const C = mkUser('Switcher'); const M = mkUser('Other');
  const t1 = team('Switch One', C, [M]); const t2 = team('Switch Two', C, [M]);
  assert.strictEqual(teams.updateMe(C, t1.id, { alertsEnabled: true }).alertsEnabled, true);
  assert.strictEqual(teams.alertsEnabledFor(C, t1.id), true);
  assert.strictEqual(teams.alertsEnabledFor(C, t2.id), false, 'another Team is untouched');
  assert.strictEqual(teams.alertsEnabledFor(M, t1.id), false, 'another member is untouched');
  assert.throws(() => teams.updateMe(C, t1.id, { alertsEnabled: 'yes' }), (e) => e.status === 400);
  assert.strictEqual(teams.updateMe(C, t1.id, { alertsEnabled: false }).alertsEnabled, false);
});

check('per-Team switch: 404 for a non-member, and gone when the member leaves or is removed', () => {
  const C = mkUser('Owner'); const L = mkUser('Leaver'); const R = mkUser('Removed'); const X = mkUser('Outsider');
  const t = team('Prefs Crew', C, [L, R]);
  optIn(L, t.id); optIn(R, t.id);
  assert.throws(() => teams.updateMe(X, t.id, { alertsEnabled: true }), (e) => e.status === 404);
  assert.throws(() => teams.getTeam(X, t.id), (e) => e.status === 404);
  assert.strictEqual(teams.alertsEnabledFor(X, t.id), false);
  teams.leaveTeam(L, t.id);
  const ref = teams.getTeam(C, t.id).members.find((m) => m.name.startsWith('Removed')).memberRef;
  teams.removeMember(C, t.id, ref);
  for (const uid of [L, R]) {
    assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id = ? AND user_id = ?').get(t.id, uid).c, 0);
    assert.strictEqual(teams.alertsEnabledFor(uid, t.id), false);
    assert.throws(() => teams.updateMe(uid, t.id, { alertsEnabled: true }), (e) => e.status === 404);
  }
});

check('per-Team gating: a booking alert follows the Team switch, and opted out means no push', async () => {
  sent.length = 0;
  const V = mkUser('Gated'); const A = mkUser('Gater');
  const t = team('Gate Crew', V, [A]);
  serverBook(V, [{ bookingId: 1, eventId: 1700, startAt: at(9) }, { bookingId: 2, eventId: 1701, startAt: at(11) }]);
  serverBook(A, [{ bookingId: 3, eventId: 1700, startAt: at(9) }, { bookingId: 4, eventId: 1701, startAt: at(11) }]);
  assert.deepStrictEqual(await teamNotify.newServerBookings(A, PSY, [{ bookingId: 3, eventId: 1700, startAt: at(9) }]), []);
  assert.ok(!db.wasNotificationSent(V, `team:booked:${PSY}:1700:u${A}`), 'an opted-out push is not even recorded');
  optIn(V, t.id);
  const r = await teamNotify.newServerBookings(A, PSY, [{ bookingId: 4, eventId: 1701, startAt: at(11) }]);
  assert.deepStrictEqual(r.map((x) => [x.recipientId, x.outcome]), [[V, 'sent']]);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, 'Gate Crew');
});

check('multi-Team booked: one push, named after an opted-in Team; never via an opted-out Team only', async () => {
  sent.length = 0;
  const V = mkUser('Multi'); const A = mkUser('Mover');
  const muted = team('Aaa Muted Crew', V, [A]); // sorts first by name
  const loud = team('Zzz Loud Crew', V, [A]);
  optIn(V, loud.id);
  serverBook(V, [{ bookingId: 1, eventId: 1800, startAt: at(9) }, { bookingId: 2, eventId: 1801, startAt: at(11) }]);
  serverBook(A, [{ bookingId: 3, eventId: 1800, startAt: at(9) }]);
  const r = await teamNotify.newServerBookings(A, PSY, [{ bookingId: 3, eventId: 1800, startAt: at(9) }]);
  assert.deepStrictEqual(r.map((x) => [x.recipientId, x.outcome]), [[V, 'sent']], 'one push, not one per Team');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, 'Zzz Loud Crew', 'the opted-in Team, even though the muted one sorts first');
  assert.strictEqual(sent[0].data.url, `/teams/${loud.id}`);
  assert.ok(!JSON.stringify(sent).includes(muted.id));
  // Now A hides upcoming classes from the opted-in Team: the booking is visible to V only
  // through the muted Team, so nothing is sent.
  sent.length = 0;
  teams.updateMe(A, loud.id, { share: { upcoming: false } });
  serverBook(A, [{ bookingId: 3, eventId: 1800, startAt: at(9) }, { bookingId: 5, eventId: 1801, startAt: at(11) }]);
  assert.deepStrictEqual(await teamNotify.newServerBookings(A, PSY, [{ bookingId: 5, eventId: 1801, startAt: at(11) }]), []);
  assert.strictEqual(sent.length, 0);
  assert.ok(teams.timetableChips(V).classes.some((c) => c.key === `${PSY}:1801`), 'V can still see it on the muted Team');
});

check('teammate booked: deduped per (recipient, booker, class) across repeated syncs', async () => {
  sent.length = 0;
  const V = mkUser('Vee'); const A = mkUser('Ann');
  team('Dedupe Crew', V, [A]);
  optIn(V);
  serverBook(V, [{ bookingId: 1, eventId: 500, startAt: at(9) }]);
  serverBook(A, [{ bookingId: 2, eventId: 500, startAt: at(9) }]);
  const rows = [{ bookingId: 2, eventId: 500, startAt: at(9) }];
  assert.deepStrictEqual((await teamNotify.newServerBookings(A, PSY, rows)).map((r) => r.outcome), ['sent']);
  NOW += 7 * 3600e3; // past the per-class cooldown: still never twice for the same booker
  assert.deepStrictEqual((await teamNotify.newServerBookings(A, PSY, rows)).map((r) => r.outcome), ['duplicate']);
  assert.strictEqual(sent.length, 1);
  assert.ok(db.wasNotificationSent(V, `team:booked:${PSY}:500:u${A}`));
});

check('teammate booked: 15 teammates piling into one class make ONE push per cooldown window', async () => {
  sent.length = 0;
  const V = mkUser('Spamless');
  const mates = Array.from({ length: 15 }, (_, i) => mkUser(`Mate${String.fromCharCode(65 + i)}`));
  team('Big Crew', V, mates);
  optIn(V);
  serverBook(V, [{ bookingId: 10, eventId: 600, startAt: at(9) }]);
  const outcomes = [];
  for (const [i, uid] of mates.entries()) {
    serverBook(uid, [{ bookingId: 100 + i, eventId: 600, startAt: at(9) }]);
    for (const r of await teamNotify.newServerBookings(uid, PSY, [{ bookingId: 100 + i, eventId: 600, startAt: at(9) }])) {
      if (r.recipientId === V) outcomes.push(r.outcome);
    }
  }
  assert.strictEqual(outcomes.filter((o) => o === 'sent').length, 1, outcomes.join(','));
  assert.strictEqual(outcomes.filter((o) => o === 'cooldown').length, 14);
  assert.strictEqual(sent.filter((p) => p.userId === V).length, 1);
  // A held-back booking is marked too: a later sync can never replay it.
  NOW += teamNotify.BOOKED_CLASS_COOLDOWN_MS + 1;
  const again = await teamNotify.newServerBookings(mates[5], PSY, [{ bookingId: 105, eventId: 600, startAt: at(9) }]);
  assert.strictEqual(again.find((r) => r.recipientId === V).outcome, 'duplicate');
});

check('teammate booked: the body counts the teammates going, never names the others', async () => {
  sent.length = 0;
  const V = mkUser('Counter'); const A = mkUser('Abe'); const B = mkUser('Bea'); const C = mkUser('Cal');
  team('Count Crew', V, [A, B, C]);
  optIn(V);
  serverBook(V, [{ bookingId: 1, eventId: 700, startAt: at(9) }]);
  serverBook(A, [{ bookingId: 2, eventId: 700, startAt: at(9) }]);
  serverBook(B, [{ bookingId: 3, eventId: 700, startAt: at(9) }]);
  serverBook(C, [{ bookingId: 4, eventId: 700, startAt: at(9) }]);
  await teamNotify.newServerBookings(C, PSY, [{ bookingId: 4, eventId: 700, startAt: at(9) }]);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body, /^Cal booked .*, a class you're in\. 3 teammates are going\.$/);
  assert.ok(!/Abe|Bea/.test(sent[0].body));
});

check('teammate booked: a daily cap per recipient across classes', async () => {
  sent.length = 0;
  const V = mkUser('Capped'); const A = mkUser('Busy');
  team('Busy Crew', V, [A]);
  optIn(V);
  const n = teamNotify.TEAM_DAILY_CAP + 3;
  const evs = Array.from({ length: n }, (_, i) => 800 + i);
  serverBook(V, evs.map((e, i) => ({ bookingId: 1000 + i, eventId: e, startAt: at(9 + (i % 10)) })));
  serverBook(A, evs.map((e, i) => ({ bookingId: 2000 + i, eventId: e, startAt: at(9 + (i % 10)) })));
  const r = await teamNotify.newServerBookings(A, PSY, evs.map((e, i) => ({ bookingId: 2000 + i, eventId: e, startAt: at(9 + (i % 10)) })));
  assert.strictEqual(r.filter((x) => x.outcome === 'sent').length, teamNotify.TEAM_DAILY_CAP);
  assert.strictEqual(r.filter((x) => x.outcome === 'capped').length, 3);
  NOW += 25 * 3600e3; // the window rolls; the capped ones stay deduped
  const later = await teamNotify.newServerBookings(A, PSY, evs.map((e, i) => ({ bookingId: 2000 + i, eventId: e, startAt: at(9 + (i % 10), 5) })));
  assert.ok(later.every((x) => x.outcome === 'duplicate' || x.outcome === undefined), JSON.stringify(later));
});

check('teammate booked: a started class, or a recipient who opted out, gets nothing', async () => {
  sent.length = 0;
  const V = mkUser('Late'); const A = mkUser('Early');
  team('Late Crew', V, [A]);
  const past = new Date(NOW - 3600e3).toISOString();
  serverBook(V, [{ bookingId: 1, eventId: 900, startAt: past }, { bookingId: 3, eventId: 901, startAt: at(9) }]);
  serverBook(A, [{ bookingId: 2, eventId: 900, startAt: past }, { bookingId: 4, eventId: 901, startAt: at(9) }]);
  assert.deepStrictEqual(await teamNotify.newServerBookings(A, PSY, [{ bookingId: 2, eventId: 900, startAt: past }]), []);
  const r = await teamNotify.newServerBookings(A, PSY, [{ bookingId: 4, eventId: 901, startAt: at(9) }]);
  assert.deepStrictEqual(r, [], 'not opted in to this Team: not a candidate at all');
  assert.ok(!db.wasNotificationSent(V, `team:booked:${PSY}:901:u${A}`), 'an opted-out push is not even recorded');
  assert.strictEqual(sent.length, 0);
});

check('teammate booked: stored rows load ONCE for all recipients, not once per recipient (no N+1)', async () => {
  const teamData = require('./team-data');
  const B = mkUser('Booker');
  const mates = Array.from({ length: 6 }, (_, i) => mkUser(`Recip${String.fromCharCode(65 + i)}`));
  team('Load Crew', B, mates);
  for (const [i, uid] of mates.entries()) { optIn(uid); serverBook(uid, [{ bookingId: 3000 + i, eventId: 1500, startAt: at(9) }]); }
  serverBook(B, [{ bookingId: 3100, eventId: 1500, startAt: at(9) }]);
  const orig = teamData.rowsForUsers;
  let calls = 0;
  teamData.rowsForUsers = function () { calls++; return orig.apply(this, arguments); };
  let alerts;
  try { alerts = teams.teammateBookingAlerts(B, PSY, ['1500']); } finally { teamData.rowsForUsers = orig; }
  assert.strictEqual(alerts.length, mates.length);
  assert.strictEqual(calls, 1, `rowsForUsers ran ${calls} times for ${mates.length} recipients`);
  assert.ok(alerts.every((a) => a.bookerName === 'Booker' && a.others === mates.length - 1));
});

check('join request: one push per Captain per Team per hour; the next one says how many wait', async () => {
  sent.length = 0;
  const C = mkUser('Captain');
  const { id, inviteToken } = team('Request Crew', C, []);
  optIn(C, id);
  const r1 = mkUser('ReqOne'); const r2 = mkUser('ReqTwo'); const r3 = mkUser('ReqThree');
  teams.requestJoin(r1, inviteToken, sharing.defaultShare());
  assert.deepStrictEqual(await teamNotify.joinRequested(id), ['sent']);
  teams.requestJoin(r2, inviteToken, sharing.defaultShare());
  assert.deepStrictEqual(await teamNotify.joinRequested(id), ['cooldown']);
  NOW += teamNotify.REQUEST_COOLDOWN_MS + 1000;
  teams.requestJoin(r3, inviteToken, sharing.defaultShare());
  assert.deepStrictEqual(await teamNotify.joinRequested(id), ['sent']);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].body, 'Someone asked to join. Open the Team to approve or decline.');
  assert.strictEqual(sent[1].body, '3 people are waiting to join. Open the Team to approve or decline.');
  // Turned off on this Team: nothing, and nothing recorded.
  teams.updateMe(C, id, { alertsEnabled: false });
  NOW += teamNotify.REQUEST_COOLDOWN_MS + 1000;
  assert.deepStrictEqual(await teamNotify.joinRequested(id), ['off']);
});

check('approval: once per request, even if the event fires twice', async () => {
  sent.length = 0;
  const C = mkUser('Approver'); const R = mkUser('Approved');
  const { id, inviteToken } = team('Approve Crew', C, []);
  const { requestId } = teams.requestJoin(R, inviteToken, sharing.defaultShare());
  teams.decideRequest(C, id, requestId, 'approve');
  assert.strictEqual(await teamNotify.requestApproved(id, R, requestId), 'sent');
  assert.strictEqual(await teamNotify.requestApproved(id, R, requestId), 'duplicate');
  assert.strictEqual(sent.length, 1);
});

check('teams.js emits joinRequested and requestApproved to the installed listener', () => {
  const events = [];
  teams.setEventListener((e) => { events.push(e.type); });
  try {
    const C = mkUser('Emitter'); const R = mkUser('Joiner');
    const { id, inviteToken } = team('Emit Crew', C, []);
    const { requestId } = teams.requestJoin(R, inviteToken, sharing.defaultShare());
    teams.decideRequest(C, id, requestId, 'approve');
  } finally { teams.setEventListener(null); }
  assert.deepStrictEqual(events, ['joinRequested', 'requestApproved']);
});

check('a throwing listener never fails the Team action', () => {
  teams.setEventListener(() => { throw new Error('boom'); });
  try {
    const C = mkUser('Sturdy'); const R = mkUser('Asker');
    const { inviteToken } = team('Sturdy Crew', C, []);
    assert.strictEqual(teams.requestJoin(R, inviteToken, sharing.defaultShare()).status, 'pending');
  } finally { teams.setEventListener(null); }
});

check('booking-sync: only rows that were not already SERVER rows are new', () => {
  const prev = [{ booking_id: 1, origin: 'server' }, { booking_id: 2, origin: 'client' }];
  const incoming = [{ bookingId: 1 }, { bookingId: 2 }, { bookingId: 3 }];
  assert.deepStrictEqual(bookingSync._newServerBookings(prev, incoming, PSY).map((b) => b.bookingId), [2, 3]);
});

check('server.js installs the Team push listeners', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  assert.ok(/setNewBookingsListener\(.*team-notify/.test(src));
  assert.ok(/teams'\)\.setEventListener/.test(src));
});

check('push payload data carries only the type and a Team route', async () => {
  const captured = [];
  const realGetSubs = db.getPushSubscriptions;
  const orig = pushService.sendNotification;
  pushService.sendNotification = async (userId, title, body, data) => { captured.push(data); };
  try {
    await notifications.notify(mkUser('Payload'), 'teamApproved', { teamName: 'X', url: '/teams/abcdefghijklmnop', userId: 99, memberRef: 'zz' });
  } finally { pushService.sendNotification = orig; db.getPushSubscriptions = realGetSubs; }
  assert.deepStrictEqual(captured, [{ type: 'teamApproved', url: '/teams/abcdefghijklmnop' }]);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
