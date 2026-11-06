// T-1 Teams membership core (Documentation/Workstreams/PLAN-teams.md §5.6, §6, §7).
//
// The ONLY reader and writer of `teams`, `team_members` and `team_join_requests`
// (test-team-membership.js scans for any other module touching them).
//
// Privacy rules this module enforces, not the routes:
//  - Every failure that would tell a non-member something (unknown Team, not a member,
//    bad or rotated token, disabled link) is the SAME error: NOT_FOUND (404). A member
//    asking for a Captain-only action on their own Team gets 403; that reveals nothing
//    they cannot already see.
//  - Payloads never carry a user id, email or gym identity. Members are addressed by
//    `memberRef`, a random per-Team handle; requests by a random request id.
//  - The invite token is 128 random bits. Its SHA-256 is stored for lookup, and an
//    AES-256-GCM copy (crypto.js, ENCRYPTION_KEY) lets a Captain re-copy the CURRENT link
//    (getInvite, Captains only). A database read alone cannot reconstruct a working link;
//    the token never reaches logs or audit rows.
//  - A pending requester learns the Team's name, emoji and their own status. Nothing else.

const crypto = require('crypto');
const dbm = require('./db');
const sharing = require('./team-sharing');
const { encrypt, decrypt } = require('./crypto');
const config = require('./config');
const { checkPersonName, skeleton } = require('./user-text');
const { projectTeam } = require('./team-projection');
const teamData = require('./team-data');
const { zoneOfGym, isValidZone } = require('./providers/timezone');

// T-2: "Updated 3 h ago" once a member's rows are older than the 2 h Team cadence
// (booking-sync.js PRIORITY_CADENCE_MS; not required here to keep the module graph flat).
const TEAM_STALE_AFTER_MS = 2 * 3600 * 1000;

const { db } = dbm;

const DAY_MS = 864e5;
const LIMITS = Object.freeze({
  MAX_MEMBERS: 16,            // D6
  MAX_TEAMS_PER_ACCOUNT: 20,
  MAX_PENDING_PER_TEAM: 50,
  MAX_REQUESTS_PER_HOUR: 10,  // per account, counted from stored request rows
  // D13 Team goal (§8.1 option B): a weekly target a Captain sets. At most two classes a
  // day for every member of a full Team (16 x 14); the CHECK in db.js says the same.
  GOAL_MIN: 1,
  GOAL_MAX: 224,
});
const DECLINE_COOLDOWN_MS = 7 * DAY_MS;
const REQUEST_TTL_MS = 14 * DAY_MS;
// The client owns the actual colours (contrast-checked in both themes); the server only
// hands out a stable index. Equal to MAX_MEMBERS so a full Team never has to reuse one.
const COLOUR_PALETTE_SIZE = 16;
const NAME_MAX = 40;
const EMOJI_MAX = 16;
const PAUSE_FOREVER = '9999-12-31T23:59:59.999Z';
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

let nowFn = () => Date.now();
const nowIso = () => new Date(nowFn()).toISOString();
const isoAgo = (ms) => new Date(nowFn() - ms).toISOString();

// T-5: Team events for push notifications (team-notify.js installs the listener in
// server.js). Fire-and-forget: a failing listener never fails the Team action.
let eventListener = null;
function setEventListener(fn) { eventListener = typeof fn === 'function' ? fn : null; }
function emit(evt) {
  if (!eventListener) return;
  try {
    const r = eventListener(evt);
    if (r && typeof r.catch === 'function') r.catch((err) => console.error('[Teams] event listener failed:', err && err.message));
  } catch (err) { console.error('[Teams] event listener failed:', err && err.message); }
}

class TeamError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}
const notFound = () => new TeamError('NOT_FOUND', 404, 'Not found');
const invalid = (msg) => new TeamError('INVALID', 400, msg);

const randomId = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// C7-3 audit. `actor` is 'user:<id>' for a member's own action and 'system' for an
// automatic one (auto-promotion, account deletion). Detail never holds a token or hash.
function audit(action, actorUserId, targetUserId, detail) {
  dbm.recordAdminAudit({
    action,
    actor: actorUserId == null ? 'system' : `user:${actorUserId}`,
    targetUserId: targetUserId == null ? null : Number(targetUserId),
    detail,
  });
}

// --- row access ---------------------------------------------------------------------

const teamRow = (teamId) => db.prepare('SELECT * FROM teams WHERE id = ?').get(String(teamId));
const memberRow = (teamId, userId) => db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
const memberRows = (teamId) => db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at ASC, id ASC').all(teamId);
const memberCount = (teamId) => db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id = ?').get(teamId).c;
const captainCount = (teamId) => db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id = ? AND is_captain = 1').get(teamId).c;
const teamCountFor = (userId) => db.prepare('SELECT COUNT(*) c FROM team_members WHERE user_id = ?').get(userId).c;
const pendingCount = (teamId) => db.prepare("SELECT COUNT(*) c FROM team_join_requests WHERE team_id = ? AND status = 'pending'").get(teamId).c;

function teamByToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return db.prepare('SELECT * FROM teams WHERE invite_token_hash = ? AND invite_enabled = 1').get(hashToken(token)) || null;
}

function requireMember(userId, teamId) {
  const team = teamRow(teamId);
  const me = team && memberRow(team.id, userId);
  if (!me) throw notFound();
  return { team, me };
}
function requireCaptain(userId, teamId) {
  const ctx = requireMember(userId, teamId);
  if (ctx.me.is_captain !== 1) throw new TeamError('CAPTAIN_REQUIRED', 403, 'Only a Captain can do that.');
  return ctx;
}

// Lazy 14-day expiry: run before anything reads pending requests.
function expireStale() {
  db.prepare("UPDATE team_join_requests SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?")
    .run(nowIso(), isoAgo(REQUEST_TTL_MS));
}

// --- validation ---------------------------------------------------------------------

function cleanName(name) {
  if (typeof name !== 'string') throw invalid('A Team name is required.');
  const v = name.replace(/\s+/g, ' ').trim();
  // Defence in depth only: the client MUST still escape the name on render (T-3 does).
  if (/[<>]/.test(v)) throw invalid('A Team name cannot contain < or >.');
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(v)) throw invalid(`A Team name must be 1 to ${NAME_MAX} characters.`);
  return v;
}
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** D13 Team goal: null clears it; otherwise a whole number of classes in [GOAL_MIN, GOAL_MAX]. */
function cleanGoal(goal) {
  if (goal === null) return null;
  if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < LIMITS.GOAL_MIN || goal > LIMITS.GOAL_MAX) {
    throw invalid(`weeklyGoal must be a whole number from ${LIMITS.GOAL_MIN} to ${LIMITS.GOAL_MAX}, or null to clear it.`);
  }
  return goal;
}

function cleanEmoji(emoji) {
  if (emoji == null || emoji === '') return null;
  if (typeof emoji !== 'string') throw invalid('Emoji must be text.');
  const v = emoji.trim();
  // Exactly one emoji grapheme (a ZWJ family or flag is one grapheme), nothing else.
  if (!v || v.length > EMOJI_MAX || !/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u.test(v) || [...GRAPHEMES.segment(v)].length !== 1) {
    throw invalid('Emoji must be a single emoji.');
  }
  return v;
}
// No share supplied -> the D3 defaults (what the consent sheet starts from). A supplied
// share is the member's consent as sent: any key it omits is PRIVATE (team-sharing.js).
function shareFromInput(share) {
  if (share === undefined || share === null) return sharing.defaultShare();
  const v = sharing.validateShare(share);
  if (!v.ok) throw invalid(v.error);
  return sharing.resolveShare(v.value);
}

// --- identity (§5.5) -------------------------------------------------------------------

// First name: the account `firstName` setting; else the first word of a linked gym's
// profile name; else "Member". Never the email.
// Last initial (shown only on a clash, §5.5): the account `lastName` setting (§5.8).
// When that was never captured (not a string), fall back to the linked gym profile's
// last word; an explicitly EMPTY lastName means the member chose none, so no initial.
function nameParts(userId) {
  // Stored text is re-validated at read time: whatever predates the validator (or came in by
  // a path that skipped it) must not reach teammates. Invalid values fall to the next source.
  const valid = (v, label) => {
    if (typeof v !== 'string') return null;
    const r = checkPersonName(v, { label });
    return r.ok ? r.value : null;
  };
  let first = '';
  let last = null;
  let full = '';
  try {
    const acct = dbm.getAccountSettings(userId) || {};
    first = valid(acct.firstName, 'First name') || '';
    last = valid(acct.lastName, 'Last name');
  } catch (_) { /* no settings row */ }
  try {
    const g = dbm.getUserGyms(userId).find((x) => x.display_name && valid(String(x.display_name), 'Name'));
    if (g) full = valid(String(g.display_name), 'Name') || '';
  } catch (_) { /* no gyms */ }
  const words = full ? full.split(' ') : [];
  if (!first) first = words[0] || 'Member';
  let initial = '';
  if (last !== null) initial = last ? [...last][0].toLocaleUpperCase() : '';
  else if (words.length > 1) initial = [...words[words.length - 1]][0].toLocaleUpperCase();
  return { first, initial };
}

// Unique names within one Team: a clash adds the last initial, a remaining clash a number.
// Clashes are judged on skeleton() (case, accents, width, Cyrillic/Greek lookalikes), so a
// lookalike of a teammate's name is always disambiguated.
// `partsOf` lets a caller spanning several Teams share one memo (namePartsMemo), so each
// unique user is looked up once per request, not once per Team they appear in.
function resolveNames(userIds, partsOf = nameParts) {
  const parts = userIds.map((id) => ({ id, ...partsOf(id) }));
  const byFirst = new Map();
  for (const p of parts) {
    const k = skeleton(p.first);
    if (!byFirst.has(k)) byFirst.set(k, []);
    byFirst.get(k).push(p);
  }
  const out = new Map();
  for (const group of byFirst.values()) {
    if (group.length === 1) { out.set(group[0].id, group[0].first); continue; }
    const labels = group.map((p) => (p.initial ? `${p.first} ${p.initial}.` : p.first));
    const keys = labels.map(skeleton);
    const seen = new Map();
    group.forEach((p, i) => {
      const n = (seen.get(keys[i]) || 0) + 1;
      seen.set(keys[i], n);
      const dupes = keys.filter((k) => k === keys[i]).length;
      out.set(p.id, dupes > 1 ? `${labels[i]} ${n}` : labels[i]);
    });
  }
  return out;
}

function namePartsMemo() {
  const memo = new Map();
  return (id) => {
    if (!memo.has(id)) memo.set(id, nameParts(id));
    return memo.get(id);
  };
}

// Deterministic, clash-free: start at a slot derived from the Team id, take the first free.
function pickColour(teamId) {
  const used = new Set(db.prepare('SELECT colour_index FROM team_members WHERE team_id = ?').all(teamId).map((r) => r.colour_index));
  const start = parseInt(crypto.createHash('sha256').update(teamId).digest('hex').slice(0, 8), 16) % COLOUR_PALETTE_SIZE;
  for (let i = 0; i < COLOUR_PALETTE_SIZE; i++) {
    const c = (start + i) % COLOUR_PALETTE_SIZE;
    if (!used.has(c)) return c;
  }
  throw new TeamError('TEAM_FULL', 409, 'Team is full.');
}
const requestColour = (rid) => parseInt(crypto.createHash('sha256').update(String(rid)).digest('hex').slice(0, 8), 16) % COLOUR_PALETTE_SIZE;

function addMember(teamId, userId, { captain, shareJson }) {
  db.prepare(`INSERT INTO team_members (team_id, user_id, member_ref, is_captain, colour_index, share_json, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(teamId, userId, randomId(9), captain ? 1 : 0, pickColour(teamId),
    sharing.serializeShare(shareJson), nowIso());
}

const isPaused = (m) => !!(m.paused_until && m.paused_until > nowIso());

// --- payload shapes (no user ids, ever) ------------------------------------------------

function teamSummary(team) {
  return {
    id: team.id,
    name: team.name,
    emoji: team.emoji || null,
    competitionEnabled: team.competition_enabled === 1,
    weeklyGoal: Number.isInteger(team.weekly_goal) ? team.weekly_goal : null,
    inviteEnabled: team.invite_enabled === 1,
    memberCount: memberCount(team.id),
  };
}

function myState(me) {
  return {
    myShare: sharing.resolveShare(me.share_json),
    pausedUntil: isPaused(me) ? me.paused_until : null,
    paused: isPaused(me),
    // T-5b: this member's pushes from this Team (§5.3 "opt-in per Team", off by default).
    alertsEnabled: me.alerts_enabled === 1,
  };
}

// --- Teams ----------------------------------------------------------------------------

function createTeam(userId, { name, emoji, share } = {}) {
  const cleanN = cleanName(name);
  const cleanE = cleanEmoji(emoji);
  const myShare = shareFromInput(share);
  if (teamCountFor(userId) >= LIMITS.MAX_TEAMS_PER_ACCOUNT) {
    throw new TeamError('TEAM_LIMIT', 409, `You can be in at most ${LIMITS.MAX_TEAMS_PER_ACCOUNT} Teams.`);
  }
  const id = randomId(12);
  const inviteToken = randomId(16);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(`INSERT INTO teams (id, invite_token_hash, invite_token_enc, invite_enabled, invite_rotated_at, name, emoji, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(id, hashToken(inviteToken), encrypt(inviteToken), now, cleanN, cleanE, userId, now, now);
    addMember(id, userId, { captain: true, shareJson: myShare });
  })();
  audit('team.create', userId, userId, { teamId: id });
  return { team: teamSummary(teamRow(id)), inviteToken };
}

// --- T-2 projection ------------------------------------------------------------------
// Every Team payload that carries class data goes through projectTeam (team-projection.js),
// with members taken from team_members only: a pending requester, a declined, removed,
// blocked or departed person is not a row there, so nothing of theirs can be projected.

/** The viewer's zone for "today": a valid IANA name from the client, else their first gym's. */
function viewerZone(userId, requested) {
  if (isValidZone(requested)) return requested;
  const gyms = teamData.linkedGymIds(userId);
  return gyms.length ? zoneOfGym(gyms[0]) : 'UTC';
}

// `preload` (T-5 review) lets a caller projecting the SAME Teams for several viewers
// (teammateBookingAlerts) load member rows, stored rows and names once for all of them
// instead of once per viewer: { members: Map(teamId -> team_members rows), data:
// rowsForUsers() result covering every member, partsOf: namePartsMemo() }.
function projectionsFor(userId, teamIds, { zone, includeDetail, preload = null }) {
  const now = nowFn();
  const byTeam = new Map(teamIds.map((id) => [id, (preload && preload.members.get(id)) || memberRows(id)]));
  const allIds = [...new Set([...byTeam.values()].flat().map((r) => r.user_id))];
  const data = preload && allIds.every((id) => preload.data.has(id)) ? preload.data : teamData.rowsForUsers(allIds, { now });
  const linked = preload && preload.data.has(userId)
    ? preload.data.get(userId).links.map((l) => l.gym_id)
    : teamData.linkedGymIds(userId);
  const partsOf = (preload && preload.partsOf) || namePartsMemo(); // one name lookup per unique user across every Team
  const out = new Map();
  for (const [teamId, rows] of byTeam) {
    const names = resolveNames(rows.map((r) => r.user_id), partsOf);
    out.set(teamId, projectTeam({
      viewer: { userId, linkedGymIds: linked },
      team: { id: teamId },
      members: rows.map((r) => ({
        userId: r.user_id, memberRef: r.member_ref, name: names.get(r.user_id), colourIndex: r.colour_index,
        isCaptain: r.is_captain === 1, share: r.share_json, pausedUntil: r.paused_until,
        ...data.get(r.user_id),
      })),
      now, zone, zoneOf: zoneOfGym, staleAfterMs: TEAM_STALE_AFTER_MS, includeDetail,
    }));
  }
  return out;
}

// The list card's slice of the projection (§5.2): today line inputs, hottest class,
// mascot, and the avatars of members active today. No class lists.
function listCard(p) {
  const byRef = new Map(p.members.map((m) => [m.memberRef, m]));
  const avatar = (ref) => { const m = byRef.get(ref); return m ? { memberRef: m.memberRef, name: m.name, colourIndex: m.colourIndex } : null; };
  return {
    today: p.today,
    mascot: p.mascot,
    activeToday: p.today.activeToday.map(avatar).filter(Boolean),
    members: p.members.map((m) => ({ memberRef: m.memberRef, name: m.name, colourIndex: m.colourIndex })),
  };
}

function listTeams(userId, { zone } = {}) {
  expireStale();
  const rows = db.prepare(`SELECT t.*, m.is_captain, m.paused_until, m.pinned, m.joined_at AS my_joined_at
    FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY m.pinned DESC, m.joined_at ASC, m.id ASC`).all(userId);
  const projections = projectionsFor(userId, rows.map((t) => t.id), { zone: viewerZone(userId, zone), includeDetail: false });
  const list = rows.map((t, i) => {
    const me = { is_captain: t.is_captain, paused_until: t.paused_until };
    const p = projections.get(t.id);
    return {
      ...teamSummary(t), myRole: t.is_captain === 1 ? 'captain' : 'member', paused: isPaused(me), pausedUntil: isPaused(me) ? t.paused_until : null,
      pinned: t.pinned === 1, ...listCard(p), _order: i, _soonest: p.soonestAt ? Date.parse(p.soonestAt) : Infinity,
    };
  });
  // §5.2: pinned first, then by the soonest upcoming shared class, then join order.
  list.sort((a, b) => (b.pinned - a.pinned) || (a._soonest - b._soonest) || (a._order - b._order));
  return list.map(({ _order, _soonest, ...t }) => t);
}

/** The dashboard's class data for one Team (T-3 builds its widgets on this). */
function getTeamToday(userId, teamId, { zone } = {}) {
  expireStale();
  const { team, me } = requireMember(userId, teamId);
  const p = projectionsFor(userId, [team.id], { zone: viewerZone(userId, zone), includeDetail: true }).get(team.id);
  const { soonestAt, teamId: _t, ...rest } = p;
  const out = { team: teamSummary(team), myRole: me.is_captain === 1 ? 'captain' : 'member', ...myState(me), ...rest };
  // T-3: Captains see the waiting-request count on the dashboard's Manage button (the
  // requests themselves stay in Manage, §5.7). Members never receive the key.
  if (me.is_captain === 1) out.pendingRequestCount = pendingCount(team.id);
  // D13 Team goal (§8.1 option B): cooperative, no ranking and no names. The count is the
  // SAME total as "classes this week" (stats.week.thisWeek: activity sharers, every shared
  // gym, team-stats.js), so it needs no new consent and can never say more than that tile.
  const target = out.team.weeklyGoal;
  out.goal = target && out.stats ? { target, count: out.stats.week.thisWeek } : null;
  return out;
}

/**
 * T-B priority set (booking-sync.js, 2 h cadence): members whose upcoming classes some
 * OTHER member of a Team can see — not paused, sharing upcoming classes, with at least
 * one gym shared, in a Team of two or more.
 */
function priorityMemberIds() {
  const now = nowIso();
  const rows = db.prepare(`SELECT m.user_id, m.share_json, m.paused_until FROM team_members m
    WHERE (SELECT COUNT(*) FROM team_members o WHERE o.team_id = m.team_id) >= 2`).all();
  const out = new Set();
  for (const r of rows) {
    if (r.paused_until && r.paused_until > now) continue;
    const share = sharing.resolveShare(r.share_json);
    if (!share.upcoming) continue;
    if (share.gyms !== 'all' && !(Array.isArray(share.gyms) && share.gyms.length)) continue;
    out.add(r.user_id);
  }
  return out;
}

// --- T-5: timetable Team chips -----------------------------------------------------------
// One call per timetable load (GET /api/teams/timetable), never one per event: every Team
// the viewer is in is projected in ONE projectionsFor pass (one batched row load for all
// members of all Teams). The chip data is a slice of the projection's `classes`, so every
// §7.3 rule (share keys, paused, share.gyms, enabled links, server-origin rows, confirmed
// missing_since rows, penalised statuses) has already been applied; this adds:
//   - only teammates BOOKED in (not waitlisted or queued), never the viewer;
//   - only classes that have not started;
//   - only gyms the viewer has linked (the projection already hides others' details;
//     re-checked here so the chip can never name an unlinked gym);
//   - a teammate's spot only as the projection attached it: D13 (ii), when the viewer is
//     booked into, waitlisted for or queued for this same class and the teammate shares
//     spots (team-projection.js viewerAttendance). Never decided here.
function timetableChips(userId) {
  expireStale();
  const rows = db.prepare(`SELECT t.id, t.name, t.emoji, m.pinned FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE m.user_id = ?`).all(userId);
  if (!rows.length) return { classes: [] };
  const projections = projectionsFor(userId, rows.map((t) => t.id), { zone: viewerZone(userId), includeDetail: true });
  const linked = new Set(teamData.linkedGymIds(userId));
  const byKey = new Map();
  for (const t of rows) {
    const p = projections.get(t.id);
    if (!p) continue;
    const meRef = (p.members.find((m) => m.isMe) || {}).memberRef;
    const byRef = new Map(p.members.map((m) => [m.memberRef, m]));
    for (const c of p.classes || []) {
      if (c.status !== 'upcoming' || !linked.has(c.gymId)) continue;
      const mates = c.attendees
        .filter((a) => a.kind === 'booked' && a.memberRef !== meRef && byRef.has(a.memberRef))
        .map((a) => {
          const m = byRef.get(a.memberRef);
          const mate = { memberRef: m.memberRef, name: m.name, colourIndex: m.colourIndex };
          if (a.spot) mate.spot = a.spot;
          return mate;
        });
      if (!mates.length) continue;
      if (!byKey.has(c.key)) byKey.set(c.key, { key: c.key, gymId: c.gymId, eventId: c.eventId, teams: [] });
      byKey.get(c.key).teams.push({ teamId: t.id, name: t.name, emoji: t.emoji || null, pinned: t.pinned === 1, members: mates });
    }
  }
  // §5.3: Teams ordered by pin, then name.
  const classes = [...byKey.values()];
  for (const c of classes) c.teams.sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId));
  return { classes };
}

// --- T-5: push targets (team-notify.js decides prefs, dedupe and rate limits) ------------

/**
 * Captains to tell about a new join request: not paused in that Team. No requester data.
 * Each carries `alertsEnabled`, that Captain's per-Team push opt-in (T-5b), which
 * team-notify.js checks.
 */
function joinRequestTargets(teamId) {
  const team = teamRow(teamId);
  if (!team) return null;
  const now = nowIso();
  const captains = db.prepare('SELECT user_id, paused_until, alerts_enabled FROM team_members WHERE team_id = ? AND is_captain = 1').all(team.id)
    .filter((r) => !(r.paused_until && r.paused_until > now))
    .map((r) => ({ userId: r.user_id, alertsEnabled: r.alerts_enabled === 1 }));
  return { teamId: team.id, teamName: team.name, emoji: team.emoji || null, pending: pendingCount(team.id), captains };
}

/** T-5b: is this member's push opt-in on for this Team? false for a non-member. */
function alertsEnabledFor(userId, teamId) {
  const me = memberRow(teamId, userId);
  return !!(me && me.alerts_enabled === 1);
}

/** The requester's approval: only while they are still a member. */
function approvalTarget(teamId, userId) {
  const team = teamRow(teamId);
  if (!team || !memberRow(team.id, userId)) return null;
  return { teamId: team.id, teamName: team.name, emoji: team.emoji || null };
}

/**
 * "Ana booked 08:30 Train, a class you're in" (§5.3). For the booker's NEW server-synced
 * bookings at one gym, every teammate who is booked into the same class and may see the
 * booker there. Visibility is decided by the projection itself (the recipient's own
 * projection of each shared Team must list the booker as a BOOKED attendee of that class
 * key), so a push can never say more than the recipient's Team page already shows.
 * Recipients paused in a Team get nothing from that Team.
 *
 * T-5b (§5.3 "opt-in per Team"): only Teams in which the RECIPIENT has turned Team alerts on
 * are considered, both for whether to alert and for which Team the alert names. A booking
 * the recipient could see only through a Team they have opted out of is never pushed; with
 * several qualifying Teams the alert is still one per (recipient, class).
 * @returns {{recipientId, teamId, teamName, bookerName, others, cls}[]}
 */
function teammateBookingAlerts(bookerId, gymId, eventIds) {
  const events = [...new Set((eventIds || []).filter((e) => e != null).map(String))];
  if (!events.length || !gymId) return [];
  const bookerTeams = db.prepare('SELECT team_id, member_ref FROM team_members WHERE user_id = ?').all(bookerId);
  if (!bookerTeams.length) return [];
  const refInTeam = new Map(bookerTeams.map((r) => [r.team_id, r.member_ref]));
  const teamIds = [...refInTeam.keys()];
  const now = nowIso();
  const mateRows = db.prepare(`SELECT m.team_id, m.user_id, m.pinned, m.paused_until, t.name FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE m.team_id IN (${teamIds.map(() => '?').join(', ')}) AND m.user_id != ? AND m.alerts_enabled = 1`).all(...teamIds, bookerId)
    .filter((r) => !(r.paused_until && r.paused_until > now));
  if (!mateRows.length) return [];
  const mateIds = [...new Set(mateRows.map((r) => r.user_id))];
  // T-5 review: every recipient's projection covers a subset of the booker's Teams, so the
  // member rows, stored rows and names are loaded ONCE here, not once per recipient (N+1).
  const preloadMembers = new Map(teamIds.map((id) => [id, memberRows(id)]));
  const allMemberIds = [...new Set([...preloadMembers.values()].flat().map((r) => r.user_id))];
  const preload = { members: preloadMembers, data: teamData.rowsForUsers(allMemberIds, { now: nowFn() }), partsOf: namePartsMemo() };
  const zoneOfViewer = (uid) => {
    const links = (preload.data.get(uid) || { links: [] }).links;
    return links.length ? zoneOfGym(links[0].gym_id) : 'UTC';
  };
  // Who is in the class themselves (their own rows, any origin: it is their own booking),
  // in one query for every candidate.
  const own = db.prepare(`SELECT user_id, event_id FROM booking_cache WHERE gym_id = ? AND missing_since IS NULL
    AND user_id IN (${mateIds.map(() => '?').join(', ')})`).all(gymId, ...mateIds);
  const inClass = new Map();
  for (const r of own) {
    const e = String(r.event_id);
    if (!events.includes(e)) continue;
    if (!inClass.has(r.user_id)) inClass.set(r.user_id, new Set());
    inClass.get(r.user_id).add(e);
  }
  const out = [];
  for (const [recipientId, evs] of inClass) {
    const theirTeams = mateRows.filter((r) => r.user_id === recipientId)
      .sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name) || a.team_id.localeCompare(b.team_id));
    const projections = projectionsFor(recipientId, theirTeams.map((r) => r.team_id), { zone: zoneOfViewer(recipientId), includeDetail: true, preload });
    for (const eventId of evs) {
      const key = `${gymId}:${eventId}`;
      for (const tr of theirTeams) {
        const p = projections.get(tr.team_id);
        const cls = p && (p.classes || []).find((c) => c.key === key);
        const bookerRef = refInTeam.get(tr.team_id);
        if (!cls || cls.status !== 'upcoming') continue;
        const booked = cls.attendees.filter((a) => a.kind === 'booked');
        if (!booked.some((a) => a.memberRef === bookerRef)) continue;
        const meRef = (p.members.find((m) => m.isMe) || {}).memberRef;
        const booker = p.members.find((m) => m.memberRef === bookerRef);
        out.push({
          recipientId,
          teamId: tr.team_id,
          teamName: tr.name,
          bookerName: booker ? booker.name : 'A teammate',
          others: booked.filter((a) => a.memberRef !== bookerRef && a.memberRef !== meRef).length,
          cls: { key, gymId, eventId, className: cls.className, discipline: cls.discipline, startAt: cls.startAt, timeZone: cls.timeZone },
        });
        break; // one Team per (recipient, class): the first by pin, then name
      }
    }
  }
  return out;
}

function getTeam(userId, teamId) {
  expireStale();
  const { team, me } = requireMember(userId, teamId);
  const rows = memberRows(team.id);
  const names = resolveNames(rows.map((r) => r.user_id));
  const approver = me.is_captain === 1;
  const out = {
    team: teamSummary(team),
    myRole: me.is_captain === 1 ? 'captain' : 'member',
    canApprove: approver,
    ...myState(me),
    members: rows.map((r) => ({
      memberRef: r.member_ref,
      name: names.get(r.user_id),
      colourIndex: r.colour_index,
      isCaptain: r.is_captain === 1,
      isMe: r.user_id === me.user_id,
      joinedAt: r.joined_at,
    })),
  };
  if (approver) out.pendingRequestCount = pendingCount(team.id);
  return out;
}

function updateTeam(userId, teamId, patch = {}) {
  const { team } = requireCaptain(userId, teamId);
  const sets = {};
  if (patch.name !== undefined) sets.name = cleanName(patch.name);
  if (patch.emoji !== undefined) sets.emoji = cleanEmoji(patch.emoji);
  if (patch.weeklyGoal !== undefined) sets.weekly_goal = cleanGoal(patch.weeklyGoal);
  if (patch.competitionEnabled !== undefined) {
    if (typeof patch.competitionEnabled !== 'boolean') throw invalid('competitionEnabled must be true or false.');
    sets.competition_enabled = patch.competitionEnabled ? 1 : 0;
  }
  const keys = Object.keys(sets);
  if (keys.length) {
    db.prepare(`UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => sets[k]), nowIso(), team.id);
  }
  return { team: teamSummary(teamRow(team.id)) };
}

function deleteTeam(userId, teamId) {
  const { team } = requireCaptain(userId, teamId);
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  audit('team.delete', userId, userId, { teamId: team.id, reason: 'captain' });
  return { deleted: true };
}

// --- invite link ------------------------------------------------------------------------

function rotateInvite(userId, teamId) {
  const { team } = requireCaptain(userId, teamId);
  const inviteToken = randomId(16);
  db.prepare('UPDATE teams SET invite_token_hash = ?, invite_token_enc = ?, invite_rotated_at = ?, updated_at = ? WHERE id = ?')
    .run(hashToken(inviteToken), encrypt(inviteToken), nowIso(), nowIso(), team.id);
  return { inviteToken };
}

// §5.6 "copy link": the CURRENT link, for Captains only. Never logged or audited.
function getInvite(userId, teamId) {
  const { team } = requireCaptain(userId, teamId);
  const token = team.invite_token_enc ? decrypt(team.invite_token_enc) : null;
  return { url: token ? `https://${config.publicHost}/t/${token}` : null, enabled: team.invite_enabled === 1 };
}

function setInviteEnabled(userId, teamId, enabled) {
  const { team } = requireCaptain(userId, teamId);
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false.');
  db.prepare('UPDATE teams SET invite_enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), team.id);
  return { inviteEnabled: enabled };
}

// --- join requests ----------------------------------------------------------------------

const latestRequest = (teamId, userId) => db.prepare(
  'SELECT * FROM team_join_requests WHERE team_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
).get(teamId, userId);
const isBlocked = (teamId, userId) => !!db.prepare(
  'SELECT 1 FROM team_join_requests WHERE team_id = ? AND user_id = ? AND blocked = 1 LIMIT 1',
).get(teamId, userId);
const inCooldown = (req) => req && req.status === 'declined' && req.decided_at && req.decided_at > isoAgo(DECLINE_COOLDOWN_MS);

// Declined, blocked and removed-in-cooldown all read as the neutral 'notMember' (§5.6).
function myRequestStatus(teamId, userId) {
  if (memberRow(teamId, userId)) return 'member';
  const last = latestRequest(teamId, userId);
  if (last && last.status === 'pending') return 'pending';
  if (isBlocked(teamId, userId) || inCooldown(last)) return 'notMember';
  if (last && last.status === 'expired') return 'expired';
  return 'none';
}

function previewInvite(userId, token) {
  expireStale();
  const team = teamByToken(token);
  if (!team) throw notFound();
  const myRequestStatus_ = myRequestStatus(team.id, userId);
  const out = { name: team.name, emoji: team.emoji || null, myRequestStatus: myRequestStatus_ };
  // An existing member already knows the Team; its id lets the client open it exactly.
  if (myRequestStatus_ === 'member') out.teamId = team.id;
  return out;
}

function requestJoin(userId, token, share) {
  expireStale();
  const team = teamByToken(token);
  if (!team) throw notFound();
  if (memberRow(team.id, userId)) return { status: 'member' };
  const consent = shareFromInput(share);
  const last = latestRequest(team.id, userId);
  if (last && last.status === 'pending') {
    // Idempotent: re-opening the link re-sends the same request; it may refresh the share.
    if (share !== undefined && share !== null) {
      db.prepare('UPDATE team_join_requests SET share_json = ? WHERE id = ?').run(sharing.serializeShare(consent), last.id);
    }
    return { status: 'pending', requestId: last.id };
  }
  if (isBlocked(team.id, userId) || inCooldown(last)) {
    throw new TeamError('REQUEST_DECLINED', 409, "Your request wasn't accepted.");
  }
  if (teamCountFor(userId) >= LIMITS.MAX_TEAMS_PER_ACCOUNT) {
    throw new TeamError('TEAM_LIMIT', 409, `You can be in at most ${LIMITS.MAX_TEAMS_PER_ACCOUNT} Teams.`);
  }
  if (pendingCount(team.id) >= LIMITS.MAX_PENDING_PER_TEAM) {
    throw new TeamError('PENDING_LIMIT', 409, 'This Team has too many open requests. Try again later.');
  }
  const recent = db.prepare('SELECT COUNT(*) c FROM team_join_requests WHERE user_id = ? AND created_at > ?')
    .get(userId, isoAgo(60 * 60 * 1000)).c;
  if (recent >= LIMITS.MAX_REQUESTS_PER_HOUR) {
    throw new TeamError('RATE_LIMITED', 429, 'Too many join requests. Try again later.');
  }
  const requestId = randomId(9);
  db.prepare(`INSERT INTO team_join_requests (id, team_id, user_id, status, share_json, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?)`).run(requestId, team.id, userId, sharing.serializeShare(consent), nowIso());
  emit({ type: 'joinRequested', teamId: team.id });
  return { status: 'pending', requestId };
}

function withdrawRequest(userId, token) {
  const team = teamByToken(token);
  if (!team) throw notFound();
  db.prepare("UPDATE team_join_requests SET status = 'withdrawn', decided_at = ? WHERE team_id = ? AND user_id = ? AND status = 'pending'")
    .run(nowIso(), team.id, userId);
  return { status: myRequestStatus(team.id, userId) };
}

// Withdraw by request id: works after the link was rotated or disabled (a pending
// request outlives the link). Own, still-pending requests only; anything else is 404.
function withdrawRequestById(userId, requestId) {
  expireStale();
  const req = db.prepare("SELECT * FROM team_join_requests WHERE id = ? AND user_id = ? AND status = 'pending'").get(String(requestId), userId);
  if (!req) throw notFound();
  db.prepare("UPDATE team_join_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?").run(nowIso(), req.id);
  return { status: myRequestStatus(req.team_id, userId) };
}

function listRequests(userId, teamId) {
  const { team } = requireCaptain(userId, teamId);
  expireStale();
  const rows = db.prepare("SELECT id, user_id, created_at FROM team_join_requests WHERE team_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC")
    .all(team.id);
  const partsOf = namePartsMemo();
  return rows.map((r) => ({
    id: r.id,
    name: resolveNames([r.user_id], partsOf).get(r.user_id),
    colourIndex: requestColour(r.id),
    requestedAt: r.created_at,
  }));
}

function decideRequest(userId, teamId, requestId, decision) {
  const { team, me } = requireCaptain(userId, teamId);
  if (!['approve', 'decline', 'block'].includes(decision)) throw invalid('decision must be approve, decline or block.');
  if (decision === 'block' && me.is_captain !== 1) throw new TeamError('CAPTAIN_REQUIRED', 403, 'Only a Captain can block.');
  expireStale();
  const req = db.prepare("SELECT * FROM team_join_requests WHERE id = ? AND team_id = ? AND status = 'pending'").get(String(requestId), team.id);
  if (!req) throw notFound();
  const now = nowIso();
  if (decision === 'approve') {
    if (memberCount(team.id) >= LIMITS.MAX_MEMBERS) throw new TeamError('TEAM_FULL', 409, 'Team is full.');
    if (teamCountFor(req.user_id) >= LIMITS.MAX_TEAMS_PER_ACCOUNT) {
      throw new TeamError('TEAM_LIMIT', 409, 'That person is already in the maximum number of Teams.');
    }
    db.transaction(() => {
      addMember(team.id, req.user_id, { captain: false, shareJson: sharing.resolveShare(req.share_json) });
      db.prepare("UPDATE team_join_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(userId, now, req.id);
    })();
    emit({ type: 'requestApproved', teamId: team.id, userId: req.user_id, requestId: req.id });
    return { status: 'approved' };
  }
  db.prepare("UPDATE team_join_requests SET status = 'declined', blocked = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(decision === 'block' ? 1 : 0, userId, now, req.id);
  if (decision === 'block') audit('team.request.block', userId, req.user_id, { teamId: team.id });
  return { status: decision === 'block' ? 'blocked' : 'declined' };
}

// --- my membership ----------------------------------------------------------------------

function updateMe(userId, teamId, { share, pause, alertsEnabled } = {}) {
  const { team, me } = requireMember(userId, teamId);
  const sets = {};
  if (share !== undefined) {
    const v = sharing.validateShare(share);
    if (!v.ok) throw invalid(v.error);
    sets.share_json = sharing.serializeShare(sharing.mergeShare(me.share_json, v.value));
  }
  if (pause !== undefined) {
    if (pause === null || pause === false || pause === 'off') sets.paused_until = null;
    else if (pause === '24h') sets.paused_until = new Date(nowFn() + DAY_MS).toISOString();
    else if (pause === '7d') sets.paused_until = new Date(nowFn() + 7 * DAY_MS).toISOString();
    else if (pause === 'indefinite') sets.paused_until = PAUSE_FOREVER;
    else throw invalid('pause must be "24h", "7d", "indefinite" or null.');
  }
  if (alertsEnabled !== undefined) {
    if (typeof alertsEnabled !== 'boolean') throw invalid('alertsEnabled must be true or false.');
    sets.alerts_enabled = alertsEnabled ? 1 : 0;
  }
  const keys = Object.keys(sets);
  if (keys.length) {
    db.prepare(`UPDATE team_members SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k]), me.id);
  }
  return myState(memberRow(team.id, userId));
}

// "There is always at least one Captain" (§6): if the departing member is the last
// Captain, the longest-standing remaining member becomes one. Caller holds a transaction.
function handOverIfLastCaptain(teamId, departingUserId, reason) {
  const dep = memberRow(teamId, departingUserId);
  if (!dep || dep.is_captain !== 1) return;
  const others = db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id = ? AND is_captain = 1 AND user_id != ?')
    .get(teamId, departingUserId).c;
  if (others > 0) return;
  const heir = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id != ? ORDER BY joined_at ASC, id ASC LIMIT 1')
    .get(teamId, departingUserId);
  if (!heir) return;
  db.prepare('UPDATE team_members SET is_captain = 1 WHERE id = ?').run(heir.id);
  audit('team.captain.auto-promote', null, heir.user_id, { teamId, memberRef: heir.member_ref, reason });
}

function departAndMaybeDelete(teamId, userId, reason) {
  db.transaction(() => {
    handOverIfLastCaptain(teamId, userId, reason);
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
    if (memberCount(teamId) === 0) {
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      audit('team.delete', null, userId, { teamId, reason: `empty-after-${reason}` });
    }
  })();
}

// Per-member pin (§5.2, §7.4): at most 2, and only meaningful when in more than 3 Teams.
function setPinned(userId, teamId, pinned) {
  const { team, me } = requireMember(userId, teamId);
  if (typeof pinned !== 'boolean') throw invalid('pinned must be true or false.');
  if (pinned && me.pinned !== 1) {
    if (teamCountFor(userId) <= 3) throw new TeamError('PIN_LIMIT', 409, 'You can pin Teams once you are in more than 3.');
    const n = db.prepare('SELECT COUNT(*) c FROM team_members WHERE user_id = ? AND pinned = 1').get(userId).c;
    if (n >= 2) throw new TeamError('PIN_LIMIT', 409, 'You can pin at most 2 Teams.');
  }
  db.prepare('UPDATE team_members SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, me.id);
  return { teamId: team.id, pinned };
}

function leaveTeam(userId, teamId) {
  const { team } = requireMember(userId, teamId);
  departAndMaybeDelete(team.id, userId, 'leave');
  return { left: true };
}

// --- Captains and members ---------------------------------------------------------------

function targetByRef(teamId, memberRef) {
  const t = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND member_ref = ?').get(teamId, String(memberRef));
  if (!t) throw notFound();
  return t;
}

function setCaptain(userId, teamId, memberRef, captain) {
  const { team } = requireCaptain(userId, teamId);
  if (typeof captain !== 'boolean') throw invalid('captain must be true or false.');
  const target = targetByRef(team.id, memberRef);
  if ((target.is_captain === 1) === captain) return { memberRef: target.member_ref, isCaptain: captain };
  if (!captain && captainCount(team.id) <= 1) {
    throw new TeamError('LAST_CAPTAIN', 409, 'A Team needs at least one Captain. Make someone else a Captain first.');
  }
  db.prepare('UPDATE team_members SET is_captain = ? WHERE id = ?').run(captain ? 1 : 0, target.id);
  audit(captain ? 'team.captain.grant' : 'team.captain.revoke', userId, target.user_id, { teamId: team.id, memberRef: target.member_ref });
  return { memberRef: target.member_ref, isCaptain: captain };
}

function removeMember(userId, teamId, memberRef, { block = false } = {}) {
  const { team } = requireCaptain(userId, teamId);
  const target = targetByRef(team.id, memberRef);
  if (target.user_id === userId) throw new TeamError('USE_LEAVE', 409, 'To remove yourself, leave the Team.');
  // The actor is a Captain and is not the target, so removing a Captain never leaves
  // the Team without one; the guard is kept explicit for the invariant's sake.
  if (target.is_captain === 1 && captainCount(team.id) <= 1) throw new TeamError('LAST_CAPTAIN', 409, 'A Team needs at least one Captain.');
  if (typeof block !== 'boolean') throw invalid('block must be true or false.');
  const now = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM team_members WHERE id = ?').run(target.id);
    // Same cooldown as a decline (or a permanent block), recorded as a decided request.
    db.prepare(`INSERT INTO team_join_requests (id, team_id, user_id, status, blocked, created_at, decided_by, decided_at)
      VALUES (?, ?, ?, 'declined', ?, ?, ?, ?)`).run(randomId(9), team.id, target.user_id, block ? 1 : 0, now, userId, now);
  })();
  audit('team.member.remove', userId, target.user_id, { teamId: team.id, memberRef: target.member_ref, block });
  return { removed: true };
}

// --- account-level ------------------------------------------------------------------------

// Settings -> Privacy, "Who can see my classes" (§3).
function privacyOverview(userId) {
  expireStale();
  const rows = db.prepare(`SELECT t.id, t.name, t.emoji, m.share_json, m.paused_until
    FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY m.joined_at ASC, m.id ASC`).all(userId);
  return {
    teams: rows.map((r) => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji || null,
      memberCount: memberCount(r.id),
      share: sharing.resolveShare(r.share_json),
      pausedUntil: isPaused(r) ? r.paused_until : null,
      paused: isPaused(r),
    })),
  };
}

// §7.5: called by db.deleteAllUserData / db.deleteUser BEFORE the cascade.
function beforeAccountDelete(userId) {
  const teamIds = db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').all(userId).map((r) => r.team_id);
  for (const teamId of teamIds) departAndMaybeDelete(teamId, userId, 'account-delete');
}

// Admin panel: a count only (§7.4), never member data.
function teamCountsByUser() {
  const out = new Map();
  for (const r of db.prepare('SELECT user_id, COUNT(*) c FROM team_members GROUP BY user_id').all()) out.set(r.user_id, r.c);
  return out;
}

// Config export/import (§7.5): the member's OWN share settings only.
function exportMyShares(userId) {
  return db.prepare(`SELECT t.id, t.name, m.share_json FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?`)
    .all(userId).map((r) => ({ teamId: r.id, teamName: r.name, share: sharing.resolveShare(r.share_json) }));
}
function importMyShares(userId, list) {
  const skipped = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.teamId !== 'string') continue;
    const me = memberRow(item.teamId, userId);
    if (!me) { skipped.push(`Sharing for Team "${item.teamName || 'unknown'}" was skipped: you are not a member.`); continue; }
    const v = sharing.validateShare(item.share);
    if (!v.ok) { skipped.push(`Sharing for Team "${item.teamName || 'unknown'}" was skipped: ${v.error}.`); continue; }
    // Restore the exported record as a whole: a key missing from it stays private.
    db.prepare('UPDATE team_members SET share_json = ? WHERE id = ?').run(sharing.serializeShare(v.value), me.id);
  }
  return { skipped };
}

module.exports = {
  TeamError, LIMITS, COLOUR_PALETTE_SIZE, TOKEN_RE,
  createTeam, listTeams, getTeam, getTeamToday, priorityMemberIds, updateTeam, deleteTeam,
  rotateInvite, setInviteEnabled, getInvite, withdrawRequestById,
  previewInvite, requestJoin, withdrawRequest, listRequests, decideRequest,
  updateMe, setPinned, leaveTeam, setCaptain, removeMember,
  privacyOverview, beforeAccountDelete, teamCountsByUser, exportMyShares, importMyShares,
  timetableChips, joinRequestTargets, approvalTarget, teammateBookingAlerts, alertsEnabledFor, setEventListener,
  __now: () => nowFn(),
  __setNow(fn) { nowFn = typeof fn === 'function' ? fn : () => Date.now(); },
};
