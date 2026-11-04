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

const { db } = dbm;

const DAY_MS = 864e5;
const LIMITS = Object.freeze({
  MAX_MEMBERS: 16,            // D6
  MAX_TEAMS_PER_ACCOUNT: 20,
  MAX_PENDING_PER_TEAM: 50,
  MAX_REQUESTS_PER_HOUR: 10,  // per account, counted from stored request rows
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
const canApprove = (team, me) => me.is_captain === 1 || team.approval_policy === 'any';
function requireApprover(userId, teamId) {
  const ctx = requireMember(userId, teamId);
  if (!canApprove(ctx.team, ctx.me)) throw new TeamError('APPROVER_REQUIRED', 403, 'Only a Captain can review requests in this Team.');
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
function nameParts(userId) {
  let first = '';
  let full = '';
  try {
    const acct = dbm.getAccountSettings(userId) || {};
    if (typeof acct.firstName === 'string') first = acct.firstName.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  } catch (_) { /* no settings row */ }
  try {
    const g = dbm.getUserGyms(userId).find((x) => x.display_name && String(x.display_name).trim());
    if (g) full = String(g.display_name).replace(/\s+/g, ' ').trim();
  } catch (_) { /* no gyms */ }
  const words = full ? full.split(' ') : [];
  if (!first) first = words[0] || 'Member';
  const initial = words.length > 1 ? words[words.length - 1][0].toUpperCase() : '';
  return { first, initial };
}

// Unique names within one Team: a clash adds the last initial, a remaining clash a number.
function resolveNames(userIds) {
  const parts = userIds.map((id) => ({ id, ...nameParts(id) }));
  const byFirst = new Map();
  for (const p of parts) {
    const k = p.first.toLowerCase();
    if (!byFirst.has(k)) byFirst.set(k, []);
    byFirst.get(k).push(p);
  }
  const out = new Map();
  for (const group of byFirst.values()) {
    if (group.length === 1) { out.set(group[0].id, group[0].first); continue; }
    const labels = group.map((p) => (p.initial ? `${p.first} ${p.initial}.` : p.first));
    const seen = new Map();
    group.forEach((p, i) => {
      const n = (seen.get(labels[i].toLowerCase()) || 0) + 1;
      seen.set(labels[i].toLowerCase(), n);
      const dupes = labels.filter((l) => l.toLowerCase() === labels[i].toLowerCase()).length;
      out.set(p.id, dupes > 1 ? `${labels[i]} ${n}` : labels[i]);
    });
  }
  return out;
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
    approvalPolicy: team.approval_policy,
    competitionEnabled: team.competition_enabled === 1,
    inviteEnabled: team.invite_enabled === 1,
    memberCount: memberCount(team.id),
  };
}

function myState(me) {
  return { myShare: sharing.resolveShare(me.share_json), pausedUntil: isPaused(me) ? me.paused_until : null, paused: isPaused(me) };
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

function listTeams(userId) {
  expireStale();
  const rows = db.prepare(`SELECT t.*, m.is_captain, m.paused_until, m.joined_at AS my_joined_at
    FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY m.joined_at ASC, m.id ASC`).all(userId);
  return rows.map((t) => {
    const me = { is_captain: t.is_captain, paused_until: t.paused_until };
    const out = { ...teamSummary(t), myRole: t.is_captain === 1 ? 'captain' : 'member', paused: isPaused(me) };
    if (canApprove(t, me)) out.pendingRequestCount = pendingCount(t.id);
    return out;
  });
}

function getTeam(userId, teamId) {
  expireStale();
  const { team, me } = requireMember(userId, teamId);
  const rows = memberRows(team.id);
  const names = resolveNames(rows.map((r) => r.user_id));
  const approver = canApprove(team, me);
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
  if (patch.approvalPolicy !== undefined) {
    if (!['captains', 'any'].includes(patch.approvalPolicy)) throw invalid('approvalPolicy must be "captains" or "any".');
    sets.approval_policy = patch.approvalPolicy;
  }
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

// Blocked reads exactly like declined to the requester (§5.6).
function myRequestStatus(teamId, userId) {
  if (memberRow(teamId, userId)) return 'member';
  const last = latestRequest(teamId, userId);
  if (last && last.status === 'pending') return 'pending';
  if (isBlocked(teamId, userId) || inCooldown(last)) return 'declined';
  if (last && last.status === 'expired') return 'expired';
  return 'none';
}

function previewInvite(userId, token) {
  expireStale();
  const team = teamByToken(token);
  if (!team) throw notFound();
  return { name: team.name, emoji: team.emoji || null, myRequestStatus: myRequestStatus(team.id, userId) };
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
  const { team } = requireApprover(userId, teamId);
  expireStale();
  const rows = db.prepare("SELECT id, user_id, created_at FROM team_join_requests WHERE team_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC")
    .all(team.id);
  return rows.map((r) => ({
    id: r.id,
    name: resolveNames([r.user_id]).get(r.user_id),
    colourIndex: requestColour(r.id),
    requestedAt: r.created_at,
  }));
}

function decideRequest(userId, teamId, requestId, decision) {
  const { team, me } = requireApprover(userId, teamId);
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
    return { status: 'approved' };
  }
  db.prepare("UPDATE team_join_requests SET status = 'declined', blocked = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(decision === 'block' ? 1 : 0, userId, now, req.id);
  if (decision === 'block') audit('team.request.block', userId, req.user_id, { teamId: team.id });
  return { status: decision === 'block' ? 'blocked' : 'declined' };
}

// --- my membership ----------------------------------------------------------------------

function updateMe(userId, teamId, { share, pause } = {}) {
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
  const pending = db.prepare(`SELECT r.id, t.name, t.emoji, r.share_json, r.created_at
    FROM team_join_requests r JOIN teams t ON t.id = r.team_id WHERE r.user_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`).all(userId);
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
    pendingRequests: pending.map((r) => ({
      requestId: r.id, name: r.name, emoji: r.emoji || null, requestedAt: r.created_at, share: sharing.resolveShare(r.share_json),
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
  createTeam, listTeams, getTeam, updateTeam, deleteTeam,
  rotateInvite, setInviteEnabled, getInvite, withdrawRequestById,
  previewInvite, requestJoin, withdrawRequest, listRequests, decideRequest,
  updateMe, leaveTeam, setCaptain, removeMember,
  privacyOverview, beforeAccountDelete, teamCountsByUser, exportMyShares, importMyShares,
  __setNow(fn) { nowFn = typeof fn === 'function' ? fn : () => Date.now(); },
};
