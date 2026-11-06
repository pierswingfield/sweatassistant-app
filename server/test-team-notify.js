// T-5 Teams pushes: preferences, dedupe through sent_notifications, rate limits and the
// booking-sync hook (PLAN-teams.md §5.3 "Pushes"). Privacy of each push BODY lives in
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
const optIn = (uid) => db.setUserSettings(uid, { notifications: { teamBooked: { enabled: true } } });
function serverBook(uid, rows) {
  db.replaceBookingCache(uid, rows.map((r) => ({ gymId: PSY, className: 'Ride 45', durationMin: 45, ...r })), [PSY], { origin: 'server' });
}
function team(name, captain, members) {
  const { team: t, inviteToken } = teams.createTeam(captain, { name, share: sharing.defaultShare() });
  for (const uid of members) teams.decideRequest(captain, t.id, teams.requestJoin(uid, inviteToken, sharing.defaultShare()).requestId, 'approve');
  return { id: t.id, inviteToken };
}

check('defaults: requests and approvals on, teammate-booked off (opt-in)', () => {
  assert.deepStrictEqual(
    { r: notifications.DEFAULT_PREFS.teamRequest, a: notifications.DEFAULT_PREFS.teamApproved, b: notifications.DEFAULT_PREFS.teamBooked },
    { r: { enabled: true }, a: { enabled: true }, b: { enabled: false } },
  );
  const fresh = mkUser('Fresh');
  assert.strictEqual(notifications.getPrefs(fresh).teamBooked.enabled, false);
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
  assert.deepStrictEqual(r.map((x) => x.outcome), ['off']);
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
  // Turned off: nothing, and nothing recorded.
  db.setUserSettings(C, { notifications: { teamRequest: { enabled: false } } });
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
