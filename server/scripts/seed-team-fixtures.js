#!/usr/bin/env node
// Demo Teams fixtures: fake members the owner can see in Teams, that the server NEVER
// contacts a gym about (users.is_fixture + the sentinel session token, see
// server/gym-outbound.js). Idempotent and re-runnable: a re-run rewrites the fixtures'
// rows so dates roll forward to "now".
//
//   node server/scripts/seed-team-fixtures.js [--dry-run] [--remove] [--owner-email <email>]
//
// Runs against DB_PATH (in the container: /data/app.db). --dry-run does the whole run
// inside a transaction, prints the summary, then rolls everything back. --remove deletes
// every fixture account and the Teams a fixture created (and nothing else).
// --owner-email <email>: the owner's Team is only accepted when its Captain is that account
// (case-insensitive). Without it, the first real Captain of a Team named "Lesbian Wednesdays".
// Exits 3 when no matching Team is found, 1 when a fixture email collides with a real account
// (an existing row with a password set is never flagged as a fixture).
//
// Event ids: real ones are taken from rows already in this DB (the owner's bookings first,
// then other members' bookings, waitlists and queue rows for upcoming classes); only the
// shortfall is synthesised, with stable fake ids >= 9,000,000 so they never collide.

const { DateTime } = require('luxon');
const dbm = require('../db');
const teams = require('../teams');
const sharing = require('../team-sharing');
const history = require('../class-history');
const gymOutbound = require('../gym-outbound');
const { listEnabledGyms } = require('../gyms.config');
const { zoneOfGym } = require('../providers/timezone');

const { db } = dbm;
const OWNER_TEAM = 'Lesbian Wednesdays';
const SECOND_TEAM = { name: 'Burpee Brunch Club', emoji: '🥞' };
const EMAIL_DOMAIN = 'fixture.invalid';
const KV_TEAMS = 'fixture_team_ids';
const FAKE_BASE = 9000000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

class DryRun extends Error {}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const share = (over = {}) => ({ ...sharing.defaultShare(), ...over });

// Gym slots: A0/A1 = gyms the owner has linked, X = an enabled gym the owner has not.
// idx values index each gym's event list (owner's real classes first).
const MEMBERS = [
  { key: 'ana', first: 'Ana', last: 'Okafor', gyms: ['A0', 'A1', 'X'], share: share({ spots: true, autoBookQueue: true }),
    book: { A0: [0, 1, 3], A1: [0, 2], X: [0, 1] }, wait: { A0: [4] }, queue: { A0: [6] }, past: [-1, -2, -3, -4] },
  { key: 'sam', first: 'Sam', last: 'Whitfield', gyms: ['A0'], share: share({ autoBookQueue: true }),
    book: { A0: [0, 2, 5] }, wait: { A0: [3] }, queue: { A0: [7] }, past: [-1, -2, -3] },
  { key: 'jordan', first: 'Jordan', last: 'Lee', gyms: ['A0', 'A1'], shareGyms: ['A0'], share: share(),
    book: { A0: [1, 4], A1: [1] }, wait: {}, queue: {}, past: [-1, -5] },
  { key: 'zoe', first: 'Zoe', last: 'Hartley', gyms: ['A0'], share: share(), hidden: true,
    book: { A0: [0, 5] }, wait: {}, queue: {}, past: [-2] },
  { key: 'priya', first: 'Priya', last: 'Raman', gyms: ['X'], share: share({ spots: true }),
    book: { X: [0, 2, 3] }, wait: { X: [1] }, queue: { X: [4] }, past: [-1, -2] },
  { key: 'mia', first: 'Mia', last: 'Chen', gyms: ['A0'], share: share(),
    book: { A0: [6] }, wait: {}, queue: {}, past: [-3] },
  { key: 'ravi', first: 'Ravi', last: 'Patel', gyms: ['A0', 'X'], share: share({ spots: true }),
    book: { A0: [2, 3, 5] }, wait: {}, queue: {}, past: [-1, -3, -5] },
];
const TEAM1_ACTIVE = ['ana', 'sam', 'jordan', 'zoe'];
const TEAM1_PENDING = ['priya', 'mia'];
const TEAM2_CAPTAIN = 'ravi';
const TEAM2_MEMBERS = ['ana', 'sam', 'priya'];

const emailOf = (m) => `fixture-${m.first}-${m.last}@${EMAIL_DOMAIN}`.toLowerCase();
const fixtureUsers = () => db.prepare('SELECT id, email FROM users WHERE is_fixture = 1').all();

// --- finding the owner ------------------------------------------------------------------

/** The owner's Team and its real Captain. With `ownerEmail`, only that account counts as the Captain. */
function findOwnerTeam(ownerEmail = null) {
  const want = ownerEmail ? String(ownerEmail).trim().toLowerCase() : null;
  const rows = db.prepare('SELECT id, name FROM teams').all().filter((t) => norm(t.name) === norm(OWNER_TEAM));
  for (const t of rows) {
    const caps = db.prepare(`SELECT tm.user_id, u.email FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ? AND tm.is_captain = 1 AND u.is_fixture = 0 ORDER BY tm.joined_at, tm.id`).all(t.id);
    const cap = want ? caps.find((c) => String(c.email).toLowerCase() === want) : caps[0];
    if (cap) return { teamId: t.id, ownerId: cap.user_id, name: t.name };
  }
  return null;
}

// --- event pool -------------------------------------------------------------------------

const keyOf = (gymId, eventId) => `${gymId}:${eventId}`;
const gymLabel = (gymId) => { const g = require('../gyms.config').getGymConfig(gymId); return (g && (g.shortName || g.name)) || gymId; };
const CLASS_NAMES = ['Rhythm Ride', 'Power Intervals', 'Strength Lab', 'Boxing Fundamentals', 'Sunrise Flow', 'Core Burn', 'Hill Climb', 'Sculpt & Stretch'];
const INSTRUCTORS = ['Maya', 'Leo', 'Tasha', 'Dom', 'Iris', 'Kofi', 'Nina', 'Theo'];

function zoned(gymId, ms) { return DateTime.fromMillis(ms, { zone: zoneOfGym(gymId) }); }

/** Upcoming classes already in the DB (non-fixture rows), owner's first. */
function realUpcoming(gymId, ownerId, nowMs) {
  const from = new Date(nowMs).toISOString();
  const to = new Date(nowMs + 11 * DAY).toISOString();
  const out = [];
  const seen = new Set();
  const add = (r, mine) => {
    if (!r.event_id || !r.start_at) return;
    const t = Date.parse(r.start_at);
    if (!Number.isFinite(t) || t <= nowMs + 30 * 60000 || t > nowMs + 11 * DAY) return;
    const k = String(r.event_id);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ eventId: Number(r.event_id), startAt: r.start_at, startMs: t, className: r.class_name || 'Class', groupName: r.group_name || null,
      instructorName: r.instructor_name || null, studioName: r.studio_name || null, locationName: r.location_name || null,
      durationMin: r.duration_min || 45, real: true, mine });
  };
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  for (const r of q(`SELECT b.* FROM booking_cache b JOIN users u ON u.id = b.user_id WHERE b.gym_id = ? AND b.user_id = ? AND u.is_fixture = 0
    AND b.start_at > ? AND b.start_at < ? ORDER BY b.start_at`, gymId, ownerId, from, to)) add(r, true);
  for (const r of q(`SELECT w.*, NULL AS duration_min FROM waitlist_cache w WHERE w.gym_id = ? AND w.user_id = ? AND w.start_at > ? AND w.start_at < ?`, gymId, ownerId, from, to)) add(r, true);
  for (const r of q(`SELECT a.* FROM auto_bookings a WHERE a.gym_id = ? AND a.user_id = ? AND a.status = 'pending' AND a.start_at > ? AND a.start_at < ?`, gymId, ownerId, from, to)) add(r, true);
  for (const r of q(`SELECT b.* FROM booking_cache b JOIN users u ON u.id = b.user_id WHERE b.gym_id = ? AND u.is_fixture = 0
    AND b.start_at > ? AND b.start_at < ? ORDER BY b.start_at`, gymId, from, to)) add(r, false);
  for (const r of q(`SELECT w.*, NULL AS duration_min FROM waitlist_cache w JOIN users u ON u.id = w.user_id WHERE w.gym_id = ? AND u.is_fixture = 0 AND w.start_at > ? AND w.start_at < ?`, gymId, from, to)) add(r, false);
  for (const r of q(`SELECT a.* FROM auto_bookings a JOIN users u ON u.id = a.user_id WHERE a.gym_id = ? AND u.is_fixture = 0 AND a.status = 'pending' AND a.start_at > ? AND a.start_at < ?`, gymId, from, to)) add(r, false);
  return out;
}

const SYNTH_SLOTS = [[0, 0], [1, 7], [1, 18], [2, 12], [3, 18], [4, 7], [5, 19], [7, 18], [8, 12], [9, 7]];
const SYNTH_TIMES = { 0: '00:00', 7: '07:15', 12: '12:30', 18: '18:30', 19: '19:00' };

/** A gym's event list: real classes first, then stable fake ones until there are at least 10. */
function eventsFor(gymId, gymIdx, ownerId, nowMs, eventPools = null) {
  const list = eventPools?.[gymId] ? [...eventPools[gymId]] : realUpcoming(gymId, ownerId, nowMs);
  const have = new Set(list.map((e) => e.startMs));
  let n = 0;
  while (list.length < 10) {
    const [dayOff, hour] = SYNTH_SLOTS[(list.length + n) % SYNTH_SLOTS.length];
    const base = zoned(gymId, nowMs).startOf('day').plus({ days: dayOff });
    let start = dayOff === 0 ? zoned(gymId, nowMs).plus({ hours: 2 }).startOf('hour').plus({ hours: 0 }) : base.set({ hour, minute: SYNTH_TIMES[hour] ? Number(SYNTH_TIMES[hour].split(':')[1]) : 0 });
    if (start.toMillis() <= nowMs + 30 * 60000) start = start.plus({ days: 1 });
    n++;
    if (have.has(start.toMillis())) continue;
    have.add(start.toMillis());
    const i = list.length;
    list.push({
      eventId: FAKE_BASE + gymIdx * 1000 + i, startAt: start.toISO(), startMs: start.toMillis(),
      className: CLASS_NAMES[i % CLASS_NAMES.length], groupName: null, instructorName: INSTRUCTORS[i % INSTRUCTORS.length],
      studioName: `Studio ${1 + (i % 2)}`, locationName: gymLabel(gymId), durationMin: 45, real: false, mine: false,
    });
  }
  return list;
}

function pastEvent(gymId, gymIdx, dayOff, nowMs) {
  const hour = dayOff % 2 === 0 ? 7 : 18;
  const start = zoned(gymId, nowMs).startOf('day').plus({ days: dayOff }).set({ hour, minute: 30 });
  const i = Math.abs(dayOff);
  return { eventId: FAKE_BASE + 500 + gymIdx * 100 + i, startAt: start.toISO(), startMs: start.toMillis(), className: CLASS_NAMES[(i + 2) % CLASS_NAMES.length],
    instructorName: INSTRUCTORS[(i + 3) % INSTRUCTORS.length], studioName: 'Studio 1', locationName: gymLabel(gymId), durationMin: 45 };
}

// --- writing fixtures -------------------------------------------------------------------

function ensureFixtureUser(m, gymIds) {
  const email = emailOf(m);
  let row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!row) {
    // No password_hash: nobody can log in as this account (db.verifyAccountPassword also refuses is_fixture).
    const id = db.prepare("INSERT INTO users (email, encrypted_password, priority, is_fixture) VALUES (?, '', 200, 1)").run(email).lastInsertRowid;
    row = { id };
  } else {
    // Only an account with no password is adopted. One that has a password is a real account
    // that happens to share the address: flagging it would silently hide a real member.
    if (row.password_hash != null) {
      throw Object.assign(new Error(`${email} belongs to an existing account with a password set, so it is not a fixture. `
        + 'Rename or delete that account, or change the fixture name in seed-team-fixtures.js, then re-run.'), { code: 'FIXTURE_EMAIL_IS_REAL_ACCOUNT' });
    }
    db.prepare('UPDATE users SET is_fixture = 1 WHERE id = ?').run(row.id);
  }
  const id = row.id;
  db.prepare(`DELETE FROM user_gyms WHERE user_id = ? AND gym_id NOT IN (${gymIds.map(() => '?').join(',')})`).run(id, ...gymIds);
  for (const g of gymIds) {
    dbm.upsertUserGym(id, g, {
      display_name: `${m.first} ${m.last}`, status: 'active',
      // The sentinel the provider layer refuses; no gym login and no credential, ever.
      session_json: JSON.stringify({ accessToken: gymOutbound.FIXTURE_TOKEN }),
      gym_email: null, encrypted_password: null,
    });
  }
  dbm.setUserSettings(id, { firstName: m.first, lastName: m.last });
  return id;
}

function wipeFixtureData(uid) {
  for (const t of ['booking_cache', 'waitlist_cache', 'auto_bookings', 'class_history', 'class_history_sync', 'booking_sync_state']) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
  }
}

function writeData(uid, m, gymBySlot, eventsByGym, gymIdxOf, nowMs, counts, bookingSeq) {
  const syncedAt = new Date(nowMs - 20 * 60000).toISOString();
  const byGymBookings = new Map();
  for (const [slot, idxs] of Object.entries(m.book)) {
    const gymId = gymBySlot[slot];
    if (!gymId) continue;
    const evs = eventsByGym[gymId];
    byGymBookings.set(gymId, [...new Set(idxs)].map((i) => {
      const e = evs[i % evs.length];
      return { bookingId: bookingSeq(), gymId, eventId: e.eventId, startAt: e.startAt, className: e.className, groupName: e.groupName,
        instructorName: e.instructorName, studioName: e.studioName, locationName: e.locationName, durationMin: e.durationMin,
        slotLabel: m.share.spots && (i % 2 === 0) ? (e.demoSpot || `Bike ${10 + ((i * 7) % 20)}`) : '' };
    }));
  }
  for (const gymId of gymBySlotValues(gymBySlot, m)) {
    const rows = byGymBookings.get(gymId) || [];
    dbm.replaceBookingCache(uid, rows, [gymId], { origin: 'server' });
    counts.bookings += rows.length;
  }
  for (const [slot, idxs] of Object.entries(m.wait)) {
    const gymId = gymBySlot[slot];
    if (!gymId) continue;
    const evs = eventsByGym[gymId];
    const list = [...new Set(idxs)].map((i) => { const e = evs[i % evs.length]; return { gymId, eventId: e.eventId, startAt: e.startAt, className: e.className,
      groupName: e.groupName, instructorName: e.instructorName, studioName: e.studioName, locationName: e.locationName }; });
    dbm.replaceWaitlistCache(uid, list, [gymId]);
    counts.waitlists += list.length;
  }
  for (const [slot, idxs] of Object.entries(m.queue)) {
    const gymId = gymBySlot[slot];
    if (!gymId) continue;
    const evs = eventsByGym[gymId];
    for (const i of new Set(idxs)) {
      const e = evs[i % evs.length];
      dbm.addAutoBooking(uid, e.eventId, e.className, e.instructorName, e.studioName, e.locationName, e.startAt, { preferredSlots: [], preferredRows: [] },
        null, e.groupName, new Date(e.startMs - 14 * DAY).toISOString(), gymId, null, e.durationMin);
      counts.queue++;
    }
  }
  // Past attended classes (class_history), one gym per day round-robin over this member's gyms.
  const gyms = gymBySlotValues(gymBySlot, m);
  const entries = new Map();
  m.past.forEach((dayOff, n) => {
    const gymId = gyms[n % gyms.length];
    const e = pastEvent(gymId, gymIdxOf(gymId), dayOff, nowMs);
    if (e.startMs >= nowMs) return;
    if (!entries.has(gymId)) entries.set(gymId, []);
    entries.get(gymId).push({ bookingId: `fx-${uid}-${Math.abs(dayOff)}`, eventId: String(e.eventId), status: 'attended', startAt: e.startAt,
      timeZone: zoneOfGym(gymId), durationMin: e.durationMin, name: e.className, discipline: null, instructorName: e.instructorName,
      studioName: e.studioName, locationName: e.locationName });
  });
  for (const gymId of gyms) {
    const list = entries.get(gymId) || [];
    if (list.length) { history.upsertEntries(uid, gymId, list); counts.past += list.length; }
    db.prepare(`INSERT INTO class_history_sync (user_id, gym_id, last_synced_at, last_attempt_at, row_count) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, gym_id) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_attempt_at = excluded.last_attempt_at, row_count = excluded.row_count`)
      .run(uid, gymId, syncedAt, syncedAt, list.length);
    dbm.setBookingSyncState(uid, gymId, { lastSyncedAt: syncedAt, lastAttemptAt: syncedAt });
  }
}
const gymBySlotValues = (gymBySlot, m) => [...new Set(m.gyms.map((s) => gymBySlot[s]).filter(Boolean))];

// --- teams --------------------------------------------------------------------------------

function inviteTokenOf(captainId, teamId) {
  const url = teams.getInvite(captainId, teamId).url;
  return url.split('/t/').pop();
}

/**
 * Make `uid` an active member of the Team (idempotent); `pending` leaves a join request instead.
 * Returns 'member' | 'pending' | 'declined'. A fixture that an earlier run's Captain declined (or
 * blocked) is refused by requestJoin with REQUEST_DECLINED; that is skipped, not fatal, because
 * throwing would roll back the whole seed transaction.
 */
function joinTeam({ teamId, captainId, token, uid, shareObj, pending, pause }) {
  let r;
  try {
    r = teams.requestJoin(uid, token, shareObj);
  } catch (err) {
    if (err && err.code === 'REQUEST_DECLINED') return 'declined';
    throw err;
  }
  if (r.status === 'pending' && !pending) {
    teams.decideRequest(captainId, teamId, r.requestId, 'approve');
  } else if (r.status === 'member' && shareObj) {
    teams.updateMe(uid, teamId, { share: shareObj });
  }
  if (!pending && pause !== undefined) teams.updateMe(uid, teamId, { pause });
  return r.status === 'member' ? 'member' : (pending ? 'pending' : 'member');
}

// --- main ---------------------------------------------------------------------------------

function remove() {
  const fx = fixtureUsers();
  const ids = fx.map((u) => u.id);
  const kv = (dbm.getKV(KV_TEAMS) || '').split(',').filter(Boolean);
  const teamIds = new Set(kv);
  for (const id of ids) for (const t of db.prepare('SELECT id FROM teams WHERE created_by = ?').all(id)) teamIds.add(t.id);
  let teamsRemoved = 0;
  // Teams first, so deleting a fixture Captain never hands a fixture Team over to the owner.
  for (const tid of teamIds) teamsRemoved += db.prepare('DELETE FROM teams WHERE id = ?').run(tid).changes;
  for (const id of ids) dbm.deleteUser(id);
  db.prepare('DELETE FROM server_kv WHERE key = ?').run(KV_TEAMS);
  return { fixturesRemoved: ids.length, teamsRemoved };
}

function create({ nowMs, ownerEmail = null, eventPools = null }) {
  const found = findOwnerTeam(ownerEmail);
  if (!found) {
    const who = ownerEmail ? ` whose Captain is ${ownerEmail}` : ' with a real (non-fixture) Captain';
    const e = new Error(`Could not find a Team named "${OWNER_TEAM}"${who}. Create it first, then re-run.`);
    e.code = 'OWNER_NOT_FOUND';
    throw e;
  }
  const { teamId, ownerId } = found;
  const enabled = listEnabledGyms().map((g) => g.id);
  const ownerLinked = db.prepare('SELECT gym_id FROM user_gyms WHERE user_id = ?').all(ownerId).map((r) => r.gym_id).filter((g) => enabled.includes(g));
  if (eventPools) ownerLinked.sort((a, b) => enabled.indexOf(a) - enabled.indexOf(b));
  const notes = [];
  const A = ownerLinked.length ? ownerLinked : enabled.slice(0, 1);
  if (!A.length) throw Object.assign(new Error('No gym is enabled in gyms.config.js.'), { code: 'NO_GYMS' });
  let X = enabled.filter((g) => !ownerLinked.includes(g));
  if (!X.length) notes.push('Every enabled gym is linked by the owner: no hidden-gym case was seeded.');
  const gymBySlot = { A0: A[0], A1: A[1] || A[0], X: X[0] || null };
  if (!X.length) gymBySlot.X = null;
  if (!A[1]) notes.push('Owner has a single gym linked: members share that gym only.');

  const usedGyms = [...new Set(Object.values(gymBySlot).filter(Boolean))];
  const gymIdxOf = (g) => usedGyms.indexOf(g);
  const eventsByGym = {};
  usedGyms.forEach((g, i) => { eventsByGym[g] = eventsFor(g, i, ownerId, nowMs, eventPools); });
  const ownerOverlap = Object.values(eventsByGym).flat().filter((e) => e.mine).length;
  const realCount = Object.values(eventsByGym).flat().filter((e) => e.real).length;
  const synthCount = Object.values(eventsByGym).flat().filter((e) => !e.real).length;

  let seq = FAKE_BASE;
  const bookingSeq = () => ++seq;
  const counts = { bookings: 0, waitlists: 0, queue: 0, past: 0 };
  const ids = {};
  for (const m of MEMBERS) {
    const slots = m.gyms.filter((s) => gymBySlot[s]);
    // Priya lives at the hidden gym; with no such gym she falls back to the owner's first gym.
    const gyms = [...new Set((slots.length ? slots : ['A0']).map((s) => gymBySlot[s]))];
    const uid = ensureFixtureUser(m, gyms);
    ids[m.key] = uid;
    wipeFixtureData(uid);
    const mm = slots.length ? m : { ...m, gyms: ['A0'], book: { A0: Object.values(m.book).flat() }, wait: {}, queue: {} };
    writeData(uid, mm, gymBySlot, eventsByGym, gymIdxOf, nowMs, counts, bookingSeq);
  }

  const shareOf = (m) => ({ ...m.share, gyms: m.shareGyms ? m.shareGyms.map((s) => gymBySlot[s]).filter(Boolean) : 'all' });
  const byKey = Object.fromEntries(MEMBERS.map((m) => [m.key, m]));

  // Team 1: the owner's Team.
  const token1 = inviteTokenOf(ownerId, teamId);
  const t1 = { active: [], pending: [] };
  const skipDeclined = (k, where) => notes.push(`Skipped ${byKey[k].first} for ${where}: a join request was declined earlier (REQUEST_DECLINED). Un-decline or re-create the fixture to restore them.`);
  for (const k of TEAM1_ACTIVE) {
    const st = joinTeam({ teamId, captainId: ownerId, token: token1, uid: ids[k], shareObj: shareOf(byKey[k]), pending: false, pause: byKey[k].hidden ? 'indefinite' : null });
    if (st === 'declined') { skipDeclined(k, found.name); continue; }
    t1.active.push(`${byKey[k].first}${byKey[k].hidden ? ' (hidden)' : ''}`);
  }
  for (const k of TEAM1_PENDING) {
    const st = joinTeam({ teamId, captainId: ownerId, token: token1, uid: ids[k], shareObj: shareOf(byKey[k]), pending: true });
    if (st === 'declined') { skipDeclined(k, found.name); continue; }
    t1.pending.push(byKey[k].first);
  }

  // Team 2: captained by a fixture; the owner is an ordinary member with the default share.
  const captainId = ids[TEAM2_CAPTAIN];
  let team2 = db.prepare('SELECT id FROM teams WHERE created_by = ? AND name = ?').get(captainId, SECOND_TEAM.name);
  let team2Id;
  let token2;
  if (team2) { team2Id = team2.id; token2 = inviteTokenOf(captainId, team2Id); }
  else {
    const created = teams.createTeam(captainId, { name: SECOND_TEAM.name, emoji: SECOND_TEAM.emoji, share: shareOf(byKey[TEAM2_CAPTAIN]) });
    team2Id = created.team.id;
    token2 = created.inviteToken;
  }
  const known = new Set((dbm.getKV(KV_TEAMS) || '').split(',').filter(Boolean));
  known.add(team2Id);
  dbm.setKV(KV_TEAMS, [...known].join(','));
  teams.updateMe(captainId, team2Id, { share: shareOf(byKey[TEAM2_CAPTAIN]) });
  for (const k of TEAM2_MEMBERS) {
    if (joinTeam({ teamId: team2Id, captainId, token: token2, uid: ids[k], shareObj: shareOf(byKey[k]), pending: false }) === 'declined') {
      skipDeclined(k, SECOND_TEAM.name);
    }
  }
  if (joinTeam({ teamId: team2Id, captainId, token: token2, uid: ownerId, shareObj: undefined, pending: false }) === 'declined') {
    notes.push(`Skipped the owner for ${SECOND_TEAM.name}: a join request was declined earlier (REQUEST_DECLINED).`);
  }

  return {
    ownerTeam: found.name, ownerGyms: ownerLinked, hiddenGym: gymBySlot.X, fixtures: MEMBERS.length,
    team1: t1, team2: { name: `${SECOND_TEAM.emoji} ${SECOND_TEAM.name}`, captain: byKey[TEAM2_CAPTAIN].first, members: TEAM2_MEMBERS.map((k) => byKey[k].first) },
    rows: counts, events: { real: realCount, synthesised: synthCount, ownerOverlap }, notes,
  };
}

function seed({ dryRun = false, remove: doRemove = false, nowMs = Date.now(), ownerEmail = null, eventPools = null } = {}) {
  let result;
  try {
    db.transaction(() => {
      result = doRemove ? remove() : create({ nowMs, ownerEmail, eventPools });
      if (dryRun) throw new DryRun();
    })();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return { ...result, dryRun, removed: doRemove };
}

function printSummary(r) {
  const out = [];
  if (r.removed) {
    out.push(`Removed ${r.fixturesRemoved} fixture account(s) and ${r.teamsRemoved} fixture Team(s).`);
  } else {
    out.push(`Owner Team: ${r.ownerTeam}. Owner gyms: ${r.ownerGyms.join(', ') || '(none)'}; gym hidden from owner: ${r.hiddenGym || '(none)'}.`);
    out.push(`${r.fixtures} fixture accounts. ${r.ownerTeam}: active ${r.team1.active.join(', ')}; pending ${r.team1.pending.join(', ')}.`);
    out.push(`${r.team2.name} (Captain ${r.team2.captain}; members ${r.team2.members.join(', ')}; owner is an ordinary member).`);
    out.push(`Rows: ${r.rows.bookings} bookings, ${r.rows.waitlists} waitlists, ${r.rows.queue} queue, ${r.rows.past} past attended.`);
    out.push(`Events: ${r.events.real} real (from this DB), ${r.events.synthesised} synthesised; ${r.events.ownerOverlap} are the owner's own classes.`);
    for (const n of r.notes) out.push(`Note: ${n}`);
  }
  if (r.dryRun) out.push('DRY RUN: everything above was rolled back.');
  console.log(out.join('\n'));
}

/** Explicit development-only lane: fixture ids come from the mock adapters, so
 * teammate chips and shared spot numbers match the actual local timetable.
 * Every link is checked BEFORE fetching, and an outbound fetch is forbidden. */
async function loadMockTimetable(ownerEmail, nowMs = Date.now()) {
  if (process.env.NODE_ENV === 'production') throw new Error('--mock-timetable is development-only.');
  const found = findOwnerTeam(ownerEmail);
  if (!found) throw Object.assign(new Error('Create the owner Team before seeding mock timetable data.'), { code: 'OWNER_NOT_FOUND' });
  const { getProvider } = require('../providers');
  const links = db.prepare('SELECT gym_id, session_json FROM user_gyms WHERE user_id = ?').all(found.ownerId);
  const sources = links.map((link) => {
    const provider = getProvider(link.gym_id);
    const session = dbm.getUserSession(found.ownerId, link.gym_id);
    if (!provider.gym.devMock || !provider.mockToken || session?.accessToken !== provider.mockToken) throw new Error('--mock-timetable requires every owner gym link to use its dev mock.');
    return { gymId: link.gym_id, provider, session };
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Outbound network is forbidden while seeding mock timetable data.'); };
  try {
    const pools = {};
    for (const { gymId, provider, session } of sources) {
      const day = DateTime.fromMillis(nowMs, { zone: zoneOfGym(gymId) }).startOf('day');
      const [events, bookings] = await Promise.all([
        provider.fetchTimetable({ startDate: day.toISODate(), endDate: day.plus({ days: 8 }).toISODate() }, session),
        provider.listBookings(session),
      ]);
      const bookedIds = new Set(bookings.map((b) => String(b.eventId || b.event?.id)));
      const selected = events.filter((e) => Date.parse(e.startAt) > nowMs).sort((a, b) => Number(bookedIds.has(String(b.id))) - Number(bookedIds.has(String(a.id))) || Date.parse(a.startAt) - Date.parse(b.startAt));
      pools[gymId] = selected.slice(0, 10).map((e) => ({ eventId: e.id, startAt: e.startAt, startMs: Date.parse(e.startAt), className: e.name,
        groupName: e.discipline, instructorName: e.instructors?.[0]?.name || '', studioName: e.studioName || e.studio?.name || '', locationName: e.locationName || e.studio?.location?.name || '',
        durationMin: e.durationMin || 45, real: true, mine: bookedIds.has(String(e.id)), demoSpot: 'Bike 12' }));
    }
    return pools;
  } finally { global.fetch = originalFetch; }
}

const USAGE = 'Usage: seed-team-fixtures.js [--dry-run] [--remove] [--owner-email <email>] [--mock-timetable]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  let ownerEmail = null;
  const at = argv.indexOf('--owner-email');
  if (at !== -1) {
    ownerEmail = argv[at + 1];
    if (!ownerEmail || ownerEmail.startsWith('--')) { console.error(`--owner-email needs an address.\n${USAGE}`); process.exit(2); }
    argv.splice(at, 2);
  }
  const args = new Set(argv);
  const bad = [...args].filter((a) => !['--dry-run', '--remove', '--mock-timetable'].includes(a));
  if (bad.length) { console.error(`Unknown option(s): ${bad.join(' ')}\n${USAGE}`); process.exit(2); }
  (async () => {
    const eventPools = args.has('--mock-timetable') && !args.has('--remove') ? await loadMockTimetable(ownerEmail) : null;
    printSummary(seed({ dryRun: args.has('--dry-run'), remove: args.has('--remove'), ownerEmail, eventPools }));
  })().then(() => process.exit(0)).catch((err) => {
    console.error(`seed-team-fixtures: ${err.message}`);
    process.exit(err.code === 'OWNER_NOT_FOUND' ? 3 : 1);
  });
}

module.exports = { seed, printSummary, loadMockTimetable, MEMBERS, OWNER_TEAM, SECOND_TEAM };
