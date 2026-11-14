// T-1 (Teams membership core). Pins PLAN-teams.md §2 privacy principles, §3 share
// defaults, §5.6 flows, §6 roles and limits, §7.1 data model and §7.4 API.
//
// Sections: (1) team-sharing.js, the share schema (pure); (2) teams.js against an
// in-memory db with an injected clock (roles, last-Captain guard, limits, cooldown,
// block, expiry, token handling, account deletion, audit); (3) the HTTP contract on a
// dev server (404-not-403, opaque refs, no ids/emails in any payload, tokens never
// logged); (4) production mode: invite rate limits and the generic /t/:token shell.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- 1. share schema -----------------------------------------------------------

check('share defaults: everything on except spots, autoBookQueue and competition; gyms = all', () => {
  const s = require('./team-sharing');
  assert.deepStrictEqual(s.defaultShare(), {
    gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true,
    spots: false, autoBookQueue: false, competition: false,
  });
});

check('share: a MISSING key resolves to private, unknown keys are dropped, bad values rejected', () => {
  const s = require('./team-sharing');
  const r = s.resolveShare({ upcoming: true, bogus: true });
  assert.deepStrictEqual(r, {
    gyms: [], upcoming: true, waitlists: false, activity: false, recent: false,
    spots: false, autoBookQueue: false, competition: false,
  });
  assert.ok(!('bogus' in r));
  assert.deepStrictEqual(s.resolveShare(null), s.privateShare());
  assert.deepStrictEqual(s.resolveShare('{not json'), s.privateShare());
  // A wrongly typed stored value is private, never truthy-coerced.
  assert.strictEqual(s.resolveShare({ spots: 'yes' }).spots, false);
  assert.strictEqual(s.validateShare({ spots: 'yes' }).ok, false);
  assert.strictEqual(s.validateShare({ gyms: 'some' }).ok, false);
  assert.strictEqual(s.validateShare([]).ok, false);
  const v = s.validateShare({ gyms: ['psycle-london', 'psycle-london', 'not-a-gym'], spots: true, extra: 1 });
  assert.ok(v.ok);
  assert.deepStrictEqual(v.value, { gyms: ['psycle-london'], spots: true });
  // A patch merges over the current share; the result is always complete.
  const merged = s.mergeShare(s.defaultShare(), { spots: true });
  assert.strictEqual(merged.spots, true);
  assert.strictEqual(merged.upcoming, true);
});

// --- 2. teams.js -----------------------------------------------------------------

const DAY = 864e5;
let clock = Date.parse('2026-11-04T09:00:00Z');
const advance = (ms) => { clock += ms; };

function mkUser(db, first, gymName) {
  const email = `${first.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@test.local`;
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email).lastInsertRowid;
  if (first) db.setUserSettings(id, { firstName: first });
  if (gymName) db.upsertUserGym(id, 'psycle-london', { display_name: gymName, gym_email: email });
  return id;
}

function boot() {
  const db = require('./db');
  const teams = require('./teams');
  teams.__setNow(() => clock);
  return { db, teams };
}

const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const statusOf = (fn) => { try { fn(); } catch (e) { return e.status; } return 200; };

check('create: creator is the first Captain; the invite token is 128-bit and stored only as a hash', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana');
  const { team, inviteToken } = teams.createTeam(a, { name: '  Morning crew ', emoji: '🚴' });
  assert.strictEqual(team.name, 'Morning crew');
  assert.match(inviteToken, /^[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(Buffer.from(inviteToken, 'base64url').length, 16);
  const row = db.db.prepare('SELECT * FROM teams WHERE id = ?').get(team.id);
  assert.strictEqual(row.invite_token_hash, crypto.createHash('sha256').update(inviteToken).digest('hex'));
  // The raw token appears nowhere in the three tables.
  for (const t of ['teams', 'team_members', 'team_join_requests']) {
    assert.ok(!JSON.stringify(db.db.prepare(`SELECT * FROM ${t}`).all()).includes(inviteToken), `raw token found in ${t}`);
  }
  const view = teams.getTeam(a, team.id);
  assert.strictEqual(view.myRole, 'captain');
  assert.strictEqual(view.members.length, 1);
  assert.strictEqual(view.members[0].isCaptain, true);
  assert.deepStrictEqual(view.myShare, require('./team-sharing').defaultShare());
  assert.strictEqual(codeOf(() => teams.createTeam(a, { name: '' })), 'INVALID');
  assert.strictEqual(codeOf(() => teams.createTeam(a, { name: 'x'.repeat(41) })), 'INVALID');
});

check('preview leaks nothing beyond name, emoji and my request status; rotation and disable kill old links', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana');
  const b = mkUser(db, 'Ben');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew', emoji: '🥊' });
  const p = teams.previewInvite(b, inviteToken);
  assert.deepStrictEqual(Object.keys(p).sort(), ['emoji', 'myRequestStatus', 'name']);
  assert.deepStrictEqual(p, { name: 'Crew', emoji: '🥊', myRequestStatus: 'none' });
  const own = teams.previewInvite(a, inviteToken);
  assert.strictEqual(own.myRequestStatus, 'member');
  assert.strictEqual(own.teamId, team.id, 'a member gets the exact team id; a non-member never does');
  assert.strictEqual(codeOf(() => teams.previewInvite(b, 'A'.repeat(22))), 'NOT_FOUND');
  assert.strictEqual(codeOf(() => teams.previewInvite(b, 'short')), 'NOT_FOUND');

  const { inviteToken: t2 } = teams.rotateInvite(a, team.id);
  assert.notStrictEqual(t2, inviteToken);
  assert.strictEqual(codeOf(() => teams.previewInvite(b, inviteToken)), 'NOT_FOUND', 'old link must die on rotate');
  assert.strictEqual(codeOf(() => teams.requestJoin(b, inviteToken)), 'NOT_FOUND');
  assert.strictEqual(teams.previewInvite(b, t2).name, 'Crew');

  teams.setInviteEnabled(a, team.id, false);
  assert.strictEqual(codeOf(() => teams.previewInvite(b, t2)), 'NOT_FOUND');
  teams.setInviteEnabled(a, team.id, true);
  assert.strictEqual(teams.previewInvite(b, t2).name, 'Crew');
  assert.strictEqual(teams.getTeam(a, team.id).members.length, 1, 'rotation does not disturb members');
});

check('request is idempotent, carries its share, can be withdrawn; approval applies the share', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana');
  const b = mkUser(db, 'Ben');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  const r1 = teams.requestJoin(b, inviteToken, { upcoming: true, spots: true });
  const r2 = teams.requestJoin(b, inviteToken, { upcoming: true, spots: true });
  assert.strictEqual(r1.status, 'pending');
  assert.strictEqual(r2.status, 'pending');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM team_join_requests WHERE team_id = ?').get(team.id).c, 1);
  assert.strictEqual(teams.previewInvite(b, inviteToken).myRequestStatus, 'pending');
  // A pending requester sees nothing of the Team itself.
  assert.strictEqual(codeOf(() => teams.getTeam(b, team.id)), 'NOT_FOUND');

  teams.withdrawRequest(b, inviteToken);
  assert.strictEqual(teams.previewInvite(b, inviteToken).myRequestStatus, 'none');
  assert.deepStrictEqual(teams.listRequests(a, team.id), []);

  teams.requestJoin(b, inviteToken, { upcoming: true, spots: true });
  const reqs = teams.listRequests(a, team.id);
  assert.strictEqual(reqs.length, 1);
  assert.deepStrictEqual(Object.keys(reqs[0]).sort(), ['colourIndex', 'id', 'lastInitial', 'name', 'requestedAt']);
  assert.strictEqual(reqs[0].name, 'Ben');
  teams.decideRequest(a, team.id, reqs[0].id, 'approve');
  const vb = teams.getTeam(b, team.id);
  assert.strictEqual(vb.myRole, 'member');
  // Request share with missing keys -> private (spec §7.1), explicit keys honoured.
  assert.deepStrictEqual(vb.myShare, { ...require('./team-sharing').privateShare(), upcoming: true, spots: true });
  assert.strictEqual(teams.previewInvite(b, inviteToken).myRequestStatus, 'member');
  assert.strictEqual(teams.requestJoin(b, inviteToken).status, 'member');
  // No share sent at all -> the §3 defaults (the consent sheet's starting state).
  const c = mkUser(db, 'Cat');
  teams.requestJoin(c, inviteToken);
  const rc = teams.listRequests(a, team.id)[0];
  teams.decideRequest(a, team.id, rc.id, 'approve');
  assert.deepStrictEqual(teams.getTeam(c, team.id).myShare, require('./team-sharing').defaultShare());
});

check('approval is Captains-only: members get 403 on requests, no approvalPolicy exists', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  teams.requestJoin(b, inviteToken);
  teams.decideRequest(a, team.id, teams.listRequests(a, team.id)[0].id, 'approve');
  teams.requestJoin(c, inviteToken);
  assert.strictEqual(statusOf(() => teams.listRequests(b, team.id)), 403);
  assert.strictEqual(codeOf(() => teams.listRequests(b, team.id)), 'CAPTAIN_REQUIRED');
  const rid = teams.listRequests(a, team.id)[0].id;
  for (const d of ['approve', 'decline', 'block']) assert.strictEqual(statusOf(() => teams.decideRequest(b, team.id, rid, d)), 403);
  const vb = teams.getTeam(b, team.id);
  assert.strictEqual(vb.canApprove, false);
  assert.strictEqual(vb.pendingRequestCount, undefined);
  assert.strictEqual(teams.getTeam(a, team.id).canApprove, true);
  // The setting is gone: no field in any payload, and a patch for it changes nothing.
  assert.ok(!('approvalPolicy' in teams.getTeam(a, team.id).team));
  teams.updateTeam(a, team.id, { approvalPolicy: 'any' });
  assert.strictEqual(statusOf(() => teams.listRequests(b, team.id)), 403);
  assert.strictEqual(db.db.prepare("SELECT COUNT(*) c FROM pragma_table_info('teams') WHERE name = 'approval_policy'").get().c, 0);
  // Pending requests: never in the Teams list, never in the privacy overview (§7.4).
  assert.ok(!('pendingRequestCount' in teams.listTeams(a)[0]));
  assert.ok(!('pendingRequests' in teams.privacyOverview(c)));
  assert.strictEqual(teams.previewInvite(c, inviteToken).myRequestStatus, 'pending');
  teams.decideRequest(a, team.id, rid, 'approve');
  assert.strictEqual(teams.getTeam(c, team.id).myRole, 'member');
  // A member cannot do Captain-only actions.
  assert.strictEqual(statusOf(() => teams.rotateInvite(b, team.id)), 403);
  assert.strictEqual(statusOf(() => teams.deleteTeam(b, team.id)), 403);
  // Non-members get 404 for everything, including Captain actions.
  const x = mkUser(db, 'Xan');
  for (const fn of [
    () => teams.getTeam(x, team.id), () => teams.updateTeam(x, team.id, { name: 'y' }), () => teams.deleteTeam(x, team.id),
    () => teams.rotateInvite(x, team.id), () => teams.setInviteEnabled(x, team.id, false), () => teams.listRequests(x, team.id),
    () => teams.decideRequest(x, team.id, rid, 'approve'), () => teams.updateMe(x, team.id, { pause: '24h' }),
    () => teams.leaveTeam(x, team.id), () => teams.getTeam(x, 'nope'),
  ]) assert.strictEqual(statusOf(fn), 404);
});

function joinVia(teams, captain, teamId, token, userId, share) {
  teams.requestJoin(userId, token, share);
  const r = teams.listRequests(captain, teamId).find((q) => q.requestedAt);
  return teams.decideRequest(captain, teamId, r.id, 'approve');
}

check('decline starts a 7-day cooldown; block refuses for good and looks like a decline', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  teams.requestJoin(b, inviteToken);
  teams.requestJoin(c, inviteToken);
  const byName = Object.fromEntries(teams.listRequests(a, team.id).map((r) => [r.name, r.id]));
  teams.decideRequest(a, team.id, byName.Ben, 'decline');
  teams.decideRequest(a, team.id, byName.Cat, 'block');
  assert.strictEqual(teams.previewInvite(b, inviteToken).myRequestStatus, 'notMember');
  assert.strictEqual(teams.previewInvite(c, inviteToken).myRequestStatus, 'notMember');
  assert.strictEqual(codeOf(() => teams.requestJoin(b, inviteToken)), 'REQUEST_DECLINED');
  assert.strictEqual(codeOf(() => teams.requestJoin(c, inviteToken)), 'REQUEST_DECLINED');
  advance(6 * DAY);
  assert.strictEqual(codeOf(() => teams.requestJoin(b, inviteToken)), 'REQUEST_DECLINED');
  advance(1 * DAY + 1000);
  assert.strictEqual(teams.requestJoin(b, inviteToken).status, 'pending', 'cooldown over');
  assert.strictEqual(codeOf(() => teams.requestJoin(c, inviteToken)), 'REQUEST_DECLINED', 'block outlives the cooldown');
  // A decided request cannot be decided again.
  assert.strictEqual(statusOf(() => teams.decideRequest(a, team.id, byName.Cat, 'approve')), 404);
});

check('pending requests expire after 14 days', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  teams.requestJoin(b, inviteToken);
  advance(14 * DAY + 1000);
  assert.deepStrictEqual(teams.listRequests(a, team.id), []);
  assert.strictEqual(teams.previewInvite(b, inviteToken).myRequestStatus, 'expired');
  assert.strictEqual(teams.requestJoin(b, inviteToken).status, 'pending', 'can ask again after expiry');
});

check('limits: TEAM_FULL at 16, 50 pending per team, 20 Teams per account, 10 join requests/hour', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Big' });
  for (let i = 1; i < 16; i++) joinVia(teams, a, team.id, inviteToken, mkUser(db, `M${i}`));
  const view = teams.getTeam(a, team.id);
  assert.strictEqual(view.members.length, 16);
  // Colours are unique within the Team even when it is full.
  assert.strictEqual(new Set(view.members.map((m) => m.colourIndex)).size, 16);
  assert.ok(view.members.every((m) => m.colourIndex >= 0 && m.colourIndex < teams.COLOUR_PALETTE_SIZE));
  const late = mkUser(db, 'Late');
  teams.requestJoin(late, inviteToken);
  const rid = teams.listRequests(a, team.id)[0].id;
  assert.strictEqual(codeOf(() => teams.decideRequest(a, team.id, rid, 'approve')), 'TEAM_FULL');
  assert.strictEqual(teams.listRequests(a, team.id).length, 1, 'the refused request stays pending');

  // 50 pending.
  const { team: t2, inviteToken: tok2 } = teams.createTeam(a, { name: 'Queue' });
  for (let i = 0; i < 50; i++) teams.requestJoin(mkUser(db, `Q${i}`), tok2);
  assert.strictEqual(codeOf(() => teams.requestJoin(mkUser(db, 'Q50'), tok2)), 'PENDING_LIMIT');
  assert.strictEqual(teams.listRequests(a, t2.id).length, 50);

  // 20 Teams per account (create, and approval into a 21st).
  const z = mkUser(db, 'Zed');
  for (let i = 0; i < 20; i++) teams.createTeam(z, { name: `T${i}` });
  assert.strictEqual(codeOf(() => teams.createTeam(z, { name: 'T20' })), 'TEAM_LIMIT');
  assert.strictEqual(codeOf(() => teams.requestJoin(z, inviteToken)), 'TEAM_LIMIT');

  // 10 join requests per hour per account (idempotent repeats do not count).
  const r = mkUser(db, 'Req');
  const toks = [];
  for (let i = 0; i < 11; i++) toks.push(teams.createTeam(mkUser(db, `C${i}`), { name: `R${i}` }).inviteToken);
  for (let i = 0; i < 10; i++) { teams.requestJoin(r, toks[i]); teams.requestJoin(r, toks[i]); }
  assert.strictEqual(codeOf(() => teams.requestJoin(r, toks[10])), 'RATE_LIMITED');
  advance(61 * 60 * 1000);
  assert.strictEqual(teams.requestJoin(r, toks[10]).status, 'pending');
});

check('Captains: grant/revoke, last-Captain guard, removal, and auto-promotion on leave', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  joinVia(teams, a, team.id, inviteToken, b);
  advance(1000);
  joinVia(teams, a, team.id, inviteToken, c);
  const ref = (viewer, name) => teams.getTeam(viewer, team.id).members.find((m) => m.name === name).memberRef;

  // The last Captain cannot be demoted or removed.
  assert.strictEqual(codeOf(() => teams.setCaptain(a, team.id, ref(a, 'Ana'), false)), 'LAST_CAPTAIN');
  assert.strictEqual(statusOf(() => teams.setCaptain(b, team.id, ref(b, 'Ben'), true)), 403);
  teams.setCaptain(a, team.id, ref(a, 'Ben'), true);
  assert.strictEqual(teams.getTeam(b, team.id).myRole, 'captain');
  // Equal Captains: Ben may demote Ana, then Ben is the last and is guarded.
  teams.setCaptain(b, team.id, ref(b, 'Ana'), false);
  assert.strictEqual(teams.getTeam(a, team.id).myRole, 'member');
  assert.strictEqual(codeOf(() => teams.removeMember(b, team.id, ref(b, 'Ben'))), 'USE_LEAVE');
  assert.strictEqual(statusOf(() => teams.removeMember(a, team.id, ref(a, 'Cat'))), 403);
  teams.removeMember(b, team.id, ref(b, 'Cat'));
  assert.strictEqual(codeOf(() => teams.getTeam(c, team.id)), 'NOT_FOUND', 'removal is immediate');
  assert.strictEqual(codeOf(() => teams.removeMember(b, team.id, 'unknownref')), 'NOT_FOUND');

  // Cat was removed: she is in the 7-day cooldown until it passes.
  advance(7 * DAY + 1000);
  // Ben (last Captain) leaves: Ana, the longest-standing remaining member, is promoted.
  joinVia(teams, b, team.id, inviteToken, c);
  teams.leaveTeam(b, team.id);
  assert.strictEqual(teams.getTeam(a, team.id).myRole, 'captain');
  assert.strictEqual(teams.getTeam(c, team.id).myRole, 'member');
  // Last members leave: the empty Team is deleted.
  teams.leaveTeam(c, team.id);
  teams.leaveTeam(a, team.id);
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM teams WHERE id = ?').get(team.id).c, 0);
});

check('account deletion (self and admin) auto-promotes before the cascade; audit rows written', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  joinVia(teams, a, team.id, inviteToken, b);
  advance(1000);
  joinVia(teams, a, team.id, inviteToken, c);
  const { team: solo } = teams.createTeam(a, { name: 'Solo' });
  db.deleteAllUserData(a);
  assert.strictEqual(teams.getTeam(b, team.id).myRole, 'captain');
  assert.strictEqual(teams.getTeam(c, team.id).myRole, 'member');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM teams WHERE id = ?').get(solo.id).c, 0, 'a Team left empty is deleted');
  db.deleteUser(b); // the admin path
  assert.strictEqual(teams.getTeam(c, team.id).myRole, 'captain');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM team_members WHERE user_id IN (?, ?)').get(a, b).c, 0);

  const actions = db.listAdminAudit({ limit: 500 }).map((r) => r.action);
  for (const want of ['team.create', 'team.delete', 'team.captain.grant', 'team.captain.revoke',
    'team.captain.auto-promote', 'team.member.remove', 'team.request.block']) {
    assert.ok(actions.includes(want), `audit action ${want} missing`);
  }
  for (const row of db.listAdminAudit({ limit: 500 }).filter((x) => x.action.startsWith('team.'))) {
    assert.ok(row.detail && row.detail.teamId, `${row.action} names its Team`);
    assert.ok(!Object.keys(row.detail).some((k) => /token|hash/i.test(k)), `${row.action} detail must not carry a token`);
  }
  assert.ok(db.listAdminAudit({ limit: 500 }).some((x) => x.action === 'team.captain.auto-promote' && x.actor === 'system'));
});

check('pause, share update, privacy overview, display-name clash gets a last initial', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Sam', 'Sam Wilson'); const b = mkUser(db, 'Sam', 'Sam Okafor');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  joinVia(teams, a, team.id, inviteToken, b);
  const names = teams.getTeam(a, team.id).members.map((m) => m.name).sort();
  assert.deepStrictEqual(names, ['Sam O.', 'Sam W.']);
  teams.updateMe(b, team.id, { share: { spots: true, nope: 1 }, pause: '24h' });
  let vb = teams.getTeam(b, team.id);
  assert.strictEqual(vb.myShare.spots, true);
  assert.strictEqual(vb.myShare.upcoming, true, 'a patch keeps the other keys');
  assert.strictEqual(vb.paused, true);
  const ov = teams.privacyOverview(b);
  assert.strictEqual(ov.teams.length, 1);
  assert.deepStrictEqual(Object.keys(ov.teams[0]).sort(), ['emoji', 'id', 'memberCount', 'name', 'paused', 'pausedUntil', 'share']);
  advance(DAY + 1000);
  assert.strictEqual(teams.getTeam(b, team.id).paused, false, '24 h pause lapses');
  teams.updateMe(b, team.id, { pause: 'indefinite' });
  assert.strictEqual(teams.getTeam(b, team.id).paused, true);
  teams.updateMe(b, team.id, { pause: null });
  assert.strictEqual(teams.getTeam(b, team.id).paused, false);
  assert.strictEqual(codeOf(() => teams.updateMe(b, team.id, { pause: 'forever-ish' })), 'INVALID');
  assert.strictEqual(codeOf(() => teams.updateMe(b, team.id, { share: { spots: 'yes' } })), 'INVALID');
});

// --- T-1 review fixes ---------------------------------------------------------------

check('review: Team names reject < and > (XSS), still trimmed and length-capped', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana');
  assert.strictEqual(codeOf(() => teams.createTeam(a, { name: '<img src=x onerror=1>' })), 'INVALID');
  assert.strictEqual(codeOf(() => teams.createTeam(a, { name: 'a>b' })), 'INVALID');
  const { team } = teams.createTeam(a, { name: '  Fish & Chips  ' });
  assert.strictEqual(team.name, 'Fish & Chips');
  assert.strictEqual(codeOf(() => teams.updateTeam(a, team.id, { name: 'x<y' })), 'INVALID');
});

check('review: emoji must be exactly one emoji grapheme', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana');
  for (const bad of ['abc', 'a', '🚴🚴', '🚴x', '12', '😀😀😀']) {
    assert.strictEqual(codeOf(() => teams.createTeam(a, { name: 'E', emoji: bad })), 'INVALID', `emoji ${bad}`);
  }
  for (const good of ['🚴', '👨‍👩‍👧', '🇬🇧', '❤️', '👍🏽']) {
    assert.doesNotThrow(() => teams.createTeam(a, { name: 'E', emoji: good }), `emoji ${good}`);
  }
});

check('review: a requester can withdraw by request id after the link is rotated or disabled; the request stays approvable', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat'); const d = mkUser(db, 'Dee');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  const rb = teams.requestJoin(b, inviteToken);
  const rc = teams.requestJoin(c, inviteToken);
  assert.ok(rb.requestId && rc.requestId);
  teams.rotateInvite(a, team.id);
  teams.setInviteEnabled(a, team.id, false);
  assert.strictEqual(codeOf(() => teams.withdrawRequest(b, inviteToken)), 'NOT_FOUND', 'token no longer works');
  // Captain can still approve Cat after rotate + disable.
  assert.strictEqual(teams.decideRequest(a, team.id, rc.requestId, 'approve').status, 'approved');
  // Ben withdraws by id.
  assert.strictEqual(teams.withdrawRequestById(b, rb.requestId).status, 'none');
  assert.strictEqual(teams.listRequests(a, team.id).length, 0);
  // Someone else's request, a decided one, and an unknown id are all 404.
  assert.strictEqual(codeOf(() => teams.withdrawRequestById(d, rb.requestId)), 'NOT_FOUND');
  assert.strictEqual(codeOf(() => teams.withdrawRequestById(b, rb.requestId)), 'NOT_FOUND');
  assert.strictEqual(codeOf(() => teams.withdrawRequestById(c, rc.requestId)), 'NOT_FOUND');
  assert.strictEqual(codeOf(() => teams.withdrawRequestById(b, 'nope')), 'NOT_FOUND');
  // The privacy overview exposes the id of one's own pending request.
  teams.setInviteEnabled(a, team.id, true);
  const tok = teams.getInvite(a, team.id).url.split('/t/')[1];
  const rd = teams.requestJoin(d, tok);
  assert.ok(!('pendingRequests' in teams.privacyOverview(d)));
  assert.ok(rd.requestId);
});

check('review: removal applies the 7-day cooldown; { block: true } blocks for good', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  joinVia(teams, a, team.id, inviteToken, b);
  joinVia(teams, a, team.id, inviteToken, c);
  const refs = Object.fromEntries(teams.getTeam(a, team.id).members.map((m) => [m.name, m.memberRef]));
  teams.removeMember(a, team.id, refs.Ben);
  teams.removeMember(a, team.id, refs.Cat, { block: true });
  assert.strictEqual(teams.previewInvite(b, inviteToken).myRequestStatus, 'notMember');
  assert.strictEqual(codeOf(() => teams.requestJoin(b, inviteToken)), 'REQUEST_DECLINED');
  advance(7 * DAY + 1000);
  assert.strictEqual(teams.requestJoin(b, inviteToken).status, 'pending', 'cooldown over');
  assert.strictEqual(codeOf(() => teams.requestJoin(c, inviteToken)), 'REQUEST_DECLINED', 'block outlives the cooldown');
  // Leaving on one's own carries no cooldown.
  const { team: t2, inviteToken: tk2 } = teams.createTeam(a, { name: 'Two' });
  joinVia(teams, a, t2.id, tk2, b);
  teams.leaveTeam(b, t2.id);
  assert.strictEqual(teams.requestJoin(b, tk2).status, 'pending');
});

check('review: a promoted Captain can block; a plain member can decide nothing', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben'); const c = mkUser(db, 'Cat'); const d = mkUser(db, 'Dee');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  joinVia(teams, a, team.id, inviteToken, b);
  const rc = teams.requestJoin(c, inviteToken);
  const rd = teams.requestJoin(d, inviteToken);
  assert.strictEqual(codeOf(() => teams.decideRequest(b, team.id, rc.requestId, 'block')), 'CAPTAIN_REQUIRED');
  assert.strictEqual(statusOf(() => teams.decideRequest(b, team.id, rc.requestId, 'decline')), 403);
  assert.strictEqual(teams.decideRequest(a, team.id, rc.requestId, 'decline').status, 'declined');
  assert.strictEqual(teams.decideRequest(a, team.id, rd.requestId, 'block').status, 'blocked');
});

check('pin: per-member, max 2, only with more than 3 Teams, pinned first in the list', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben');
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(teams.createTeam(a, { name: `T${i}` }).team.id);
  assert.strictEqual(codeOf(() => teams.setPinned(a, ids[0], true)), 'PIN_LIMIT', '3 Teams or fewer: refused');
  assert.strictEqual(statusOf(() => teams.setPinned(a, ids[0], true)), 409);
  ids.push(teams.createTeam(a, { name: 'T3' }).team.id);
  assert.strictEqual(teams.setPinned(a, ids[3], true).pinned, true);
  teams.setPinned(a, ids[2], true);
  assert.strictEqual(codeOf(() => teams.setPinned(a, ids[1], true)), 'PIN_LIMIT', 'third pin refused');
  assert.strictEqual(teams.setPinned(a, ids[3], true).pinned, true, 'idempotent re-pin');
  const list = teams.listTeams(a);
  assert.deepStrictEqual(list.map((t) => t.pinned), [true, true, false, false]);
  assert.deepStrictEqual(list.slice(0, 2).map((t) => t.name).sort(), ['T2', 'T3']);
  assert.deepStrictEqual(list.slice(2).map((t) => t.name), ['T0', 'T1']);
  assert.strictEqual(teams.setPinned(a, ids[3], false).pinned, false);
  assert.strictEqual(teams.setPinned(a, ids[3], false).pinned, false);
  assert.strictEqual(codeOf(() => teams.setPinned(a, ids[0], 'yes')), 'INVALID');
  // Per member: Ben's pins are his own; a non-member gets 404.
  assert.strictEqual(statusOf(() => teams.setPinned(b, ids[0], true)), 404);
  assert.ok(!('pinned' in teams.getTeam(a, ids[0]).members[0]));
});

check('review: account deletion runs handover + delete in ONE transaction (rolls back together)', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  joinVia(teams, a, team.id, inviteToken, b);
  db.db.exec('CREATE TEMP TRIGGER boom BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, \'boom\'); END');
  assert.throws(() => db.deleteAllUserData(a), /boom/);
  assert.strictEqual(teams.getTeam(b, team.id).myRole, 'member', 'handover rolled back with the failed delete');
  assert.throws(() => db.deleteUser(a), /boom/);
  assert.strictEqual(teams.getTeam(b, team.id).myRole, 'member');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM team_members WHERE user_id = ?').get(a).c, 1);
  db.db.exec('DROP TRIGGER boom');
  db.deleteAllUserData(a);
  assert.strictEqual(teams.getTeam(b, team.id).myRole, 'captain');
});

check('review: Captains can re-copy the CURRENT invite link (encrypted at rest, hash for lookup)', () => {
  const { db, teams } = boot();
  const a = mkUser(db, 'Ana'); const b = mkUser(db, 'Ben');
  const { team, inviteToken } = teams.createTeam(a, { name: 'Crew' });
  let inv = teams.getInvite(a, team.id);
  assert.ok(inv.url.endsWith(`/t/${inviteToken}`), inv.url);
  assert.strictEqual(inv.enabled, true);
  assert.ok(!JSON.stringify(db.db.prepare('SELECT * FROM teams').all()).includes(inviteToken), 'token not stored in clear');
  assert.ok(db.db.prepare('SELECT invite_token_enc e FROM teams WHERE id = ?').get(team.id).e);
  // Members and strangers cannot read it.
  joinVia(teams, a, team.id, inviteToken, b);
  assert.strictEqual(codeOf(() => teams.getInvite(b, team.id)), 'CAPTAIN_REQUIRED');
  assert.strictEqual(codeOf(() => teams.getInvite(mkUser(db, 'Zed'), team.id)), 'NOT_FOUND');
  // Rotation replaces both; disabling is reflected.
  const { inviteToken: t2 } = teams.rotateInvite(a, team.id);
  inv = teams.getInvite(a, team.id);
  assert.ok(inv.url.endsWith(`/t/${t2}`));
  teams.setInviteEnabled(a, team.id, false);
  assert.strictEqual(teams.getInvite(a, team.id).enabled, false);
  // No token or hash in the audit trail.
  assert.ok(!JSON.stringify(db.listAdminAudit({ limit: 500 })).includes(t2));
});

check('module boundary: only teams.js touches the three tables', () => {
  const offenders = [];
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith('.js') || f.startsWith('test-') || f === 'teams.js' || f === 'db.js') continue;
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    if (/\b(FROM|INTO|UPDATE|JOIN)\s+(teams|team_members|team_join_requests)\b/i.test(src)) offenders.push(f);
  }
  // db.js may only DECLARE them (schema block).
  const dbSrc = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
  if (/\b(FROM|INTO|UPDATE|JOIN)\s+(teams|team_members|team_join_requests)\b/i.test(dbSrc)) offenders.push('db.js');
  assert.deepStrictEqual(offenders, []);
});

check('expireStale\'s pending-expiry scan uses idx_team_requests_status_created(status, created_at)', () => {
  const { db } = boot();
  const idx = db.db.prepare("PRAGMA index_info('idx_team_requests_status_created')").all().map((c) => c.name);
  assert.deepStrictEqual(idx, ['status', 'created_at']);
  const plan = db.db.prepare("EXPLAIN QUERY PLAN UPDATE team_join_requests SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?")
    .all('x', 'y').map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_team_requests_status_created/, plan);
  // The query in teams.js is the one planned here.
  assert.ok(fs.readFileSync(path.join(__dirname, 'teams.js'), 'utf8').includes("WHERE status = 'pending' AND created_at < ?"));
});

// --- 3. HTTP contract (dev server) ---------------------------------------------------

function bootServer(port, env, dbPath) {
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 't', ADMIN_PASSWORD: 'x',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ...env } });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.out += d; });
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}
function client(base) {
  const call = async (method, p, t, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const signup = async (first) => {
    const email = `${first.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}@test.local`;
    const r = await call('POST', '/api/auth/signup', null, { policyAcceptance: require('./policies').CURRENT_ACCEPTANCE, email, password: 'password123' });
    assert.ok(r.body && r.body.token, `signup failed: ${r.text}`);
    await call('PUT', '/api/settings', r.body.token, { firstName: first });
    return { token: r.body.token, email };
  };
  return { call, signup };
}

const children = [];
const tmpFiles = [];
const cleanup = () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  for (const f of tmpFiles) { for (const x of [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]) { try { fs.rmSync(x, { recursive: true, force: true }); } catch (_) {} } }
};

check('HTTP: full flow, 404-not-403, no user ids / emails in any payload, tokens never logged', async () => {
  const PORT = 3000 + 600 + (process.pid % 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const dbPath = path.join(os.tmpdir(), `test-teams-${process.pid}.db`);
  tmpFiles.push(dbPath);
  const child = bootServer(PORT, { NODE_ENV: 'development' }, dbPath);
  children.push(child);
  await waitUp(BASE);
  const { call, signup } = client(BASE);
  const ana = await signup('Ana'); const ben = await signup('Ben'); const eve = await signup('Eve');
  const emails = [ana.email, ben.email, eve.email];
  const seen = [];
  const rec = async (...args) => { const r = await call(...args); seen.push(r.text); return r; };

  let r = await rec('POST', '/api/teams', ana.token, { name: 'Crew', emoji: '🚴' });
  assert.strictEqual(r.status, 201, r.text);
  const teamId = r.body.team.id;
  const token = r.body.inviteToken;
  assert.ok(token);

  r = await rec('GET', `/api/teams/invite/${token}`, ben.token);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { name: 'Crew', emoji: '🚴', myRequestStatus: 'none' });
  r = await rec('POST', `/api/teams/invite/${token}/request`, ben.token, { share: { upcoming: true } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'pending');
  r = await rec('POST', `/api/teams/invite/${token}/request`, ben.token, { share: { upcoming: true } });
  assert.strictEqual(r.body.status, 'pending', 'idempotent');
  r = await rec('GET', `/api/teams/${teamId}`, ben.token);
  assert.strictEqual(r.status, 404, 'pending requester sees nothing');

  r = await rec('GET', `/api/teams/${teamId}/requests`, ana.token);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.requests.length, 1);
  const rid = r.body.requests[0].id;
  r = await rec('POST', `/api/teams/${teamId}/requests/${rid}`, ana.token, { decision: 'approve' });
  assert.strictEqual(r.status, 200, r.text);

  r = await rec('GET', `/api/teams/${teamId}`, ben.token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.myRole, 'member');
  assert.deepStrictEqual(r.body.members.map((m) => m.name).sort(), ['Ana', 'Ben']);
  for (const m of r.body.members) {
    assert.deepStrictEqual(Object.keys(m).sort(), ['colourIndex', 'isCaptain', 'isMe', 'joinedAt', 'lastInitial', 'memberRef', 'name']);
  }
  const anaRef = r.body.members.find((m) => m.name === 'Ana').memberRef;
  const benRef = r.body.members.find((m) => m.name === 'Ben').memberRef;

  // Member attempting a Captain-only action on their own Team: 403.
  for (const [m, p, b] of [['PATCH', `/api/teams/${teamId}`, { name: 'X' }], ['DELETE', `/api/teams/${teamId}`],
    ['POST', `/api/teams/${teamId}/invite/rotate`], ['PUT', `/api/teams/${teamId}/invite`, { enabled: false }],
    ['GET', `/api/teams/${teamId}/requests`], ['PUT', `/api/teams/${teamId}/members/${anaRef}`, { captain: false }],
    ['DELETE', `/api/teams/${teamId}/members/${anaRef}`]]) {
    r = await rec(m, p, ben.token, b);
    assert.strictEqual(r.status, 403, `${m} ${p} -> ${r.status}`);
  }
  // A non-member gets 404 for every Team route, and so does an unknown Team.
  for (const [m, p, b] of [['GET', `/api/teams/${teamId}`], ['PATCH', `/api/teams/${teamId}`, { name: 'X' }],
    ['DELETE', `/api/teams/${teamId}`], ['POST', `/api/teams/${teamId}/invite/rotate`], ['PUT', `/api/teams/${teamId}/invite`, { enabled: false }],
    ['GET', `/api/teams/${teamId}/requests`], ['POST', `/api/teams/${teamId}/requests/${rid}`, { decision: 'approve' }],
    ['PUT', `/api/teams/${teamId}/me`, { pause: '24h' }], ['DELETE', `/api/teams/${teamId}/me`],
    ['PUT', `/api/teams/${teamId}/members/${anaRef}`, { captain: false }], ['DELETE', `/api/teams/${teamId}/members/${benRef}`],
    ['GET', '/api/teams/doesnotexist'], ['GET', '/api/teams/invite/AAAAAAAAAAAAAAAAAAAAAA'],
    ['POST', '/api/teams/invite/AAAAAAAAAAAAAAAAAAAAAA/request', {}]]) {
    r = await rec(m, p, eve.token, b);
    assert.strictEqual(r.status, 404, `${m} ${p} -> ${r.status} (non-member must get 404)`);
  }
  // Unauthenticated: 401, never data.
  assert.strictEqual((await call('GET', '/api/teams')).status, 401);

  r = await rec('PUT', `/api/teams/${teamId}/me`, ben.token, { share: { spots: true }, pause: '7d' });
  assert.strictEqual(r.status, 200, r.text);
  r = await rec('GET', '/api/privacy/sharing', ben.token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.teams[0].paused, true);
  assert.strictEqual(r.body.teams[0].share.spots, true);
  r = await rec('GET', '/api/teams', ana.token);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.teams.length, 1);
  r = await rec('PUT', `/api/teams/${teamId}/members/${benRef}`, ana.token, { captain: true });
  assert.strictEqual(r.status, 200);
  r = await rec('PATCH', `/api/teams/${teamId}`, ana.token, { name: 'Crew 2', competitionEnabled: true });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.team.name, 'Crew 2');
  r = await rec('PUT', `/api/teams/${teamId}/pin`, ana.token, { pinned: true });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'PIN_LIMIT');
  r = await rec('GET', `/api/teams/${teamId}/requests`, ben.token);
  assert.strictEqual(r.status, 200, 'Ben was made Captain above');
  r = await rec('POST', `/api/teams/${teamId}/invite/rotate`, ana.token);
  assert.strictEqual(r.status, 200); const token2 = r.body.inviteToken;
  r = await rec('GET', `/api/teams/invite/${token}`, eve.token);
  assert.strictEqual(r.status, 404, 'rotated link is dead');
  r = await rec('PUT', `/api/teams/${teamId}/invite`, ana.token, { enabled: false });
  assert.strictEqual(r.status, 200);
  r = await rec('GET', `/api/teams/invite/${token2}`, eve.token);
  assert.strictEqual(r.status, 404, 'disabled link is dead');
  r = await rec('PUT', `/api/teams/${teamId}/invite`, ana.token, { enabled: true });
  r = await rec('POST', `/api/teams/invite/${token2}/request`, eve.token, {});
  r = await rec('DELETE', `/api/teams/invite/${token2}/request`, eve.token);
  assert.strictEqual(r.status, 200);
  r = await rec('GET', '/api/config/export', ben.token);
  assert.ok(Array.isArray(r.body.teamSharing) && r.body.teamSharing.length === 1);
  const exported = r.body.teamSharing;
  r = await rec('POST', '/api/config/import', ben.token, { teamSharing: [
    { ...exported[0], share: { upcoming: true } }, { teamId: 'notmyteam', teamName: 'X', share: {} }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.skipped.length, 1, 'a Team you are not in is skipped');
  r = await rec('GET', `/api/teams/${teamId}`, ben.token);
  assert.deepStrictEqual(r.body.myShare, { ...require('./team-sharing').privateShare(), upcoming: true });
  // Admin panel: a Team count per user, nothing else about Teams.
  const adm = await call('POST', '/api/admin/login', null, { password: 'x' });
  const au = await call('GET', '/api/admin/users', adm.body.token);
  const anaRow = au.body.users.find((u) => u.email === ana.email);
  assert.strictEqual(anaRow.team_count, 1);
  assert.ok(!/memberRef|share|"teams"/.test(au.text), 'admin list carries a count only');
  // Review fixes over HTTP: Captain-only invite copy, withdraw by id, bad name.
  r = await rec('GET', `/api/teams/${teamId}/invite`, ana.token);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.url.endsWith(`/t/${token}`) || r.body.url.includes('/t/'));
  assert.strictEqual(r.body.enabled, true);
  r = await rec('PUT', `/api/teams/${teamId}/members/${benRef}`, ana.token, { captain: false });
  assert.strictEqual(r.status, 200);
  r = await rec('GET', `/api/teams/${teamId}/invite`, ben.token);
  assert.strictEqual(r.status, 403);
  r = await rec('GET', `/api/teams/${teamId}/invite`, eve.token);
  assert.strictEqual(r.status, 404);
  r = await rec('POST', '/api/teams', ana.token, { name: '<b>x</b>' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID');
  r = await rec('DELETE', '/api/teams/requests/nonexistent', eve.token);
  assert.strictEqual(r.status, 404);
  r = await rec('DELETE', '/api/teams/requests/me', eve.token);
  assert.strictEqual(r.status, 404, 'not mistaken for /teams/:id/me');
  r = await rec('DELETE', `/api/teams/${teamId}/members/${benRef}`, ana.token, { block: true });
  assert.strictEqual(r.status, 200);
  r = await rec('DELETE', `/api/teams/${teamId}`, ana.token);
  assert.strictEqual(r.status, 200);

  // No payload carries a user id, an email or a gym login identity.
  const all = seen.join('\n');
  for (const e of emails) assert.ok(!all.includes(e), 'an email leaked into a Teams payload');
  assert.ok(!/"(userId|user_id|email|gym_email|created_by|decided_by|createdBy|decidedBy)"\s*:/.test(all), 'an id/email key leaked into a Teams payload');
  // The raw invite tokens never reach the log.
  await new Promise((res) => setTimeout(res, 200));
  for (const t of [token, token2]) assert.ok(!child.out.includes(t), 'an invite token was logged');
  assert.ok(child.out.includes('/api/teams/invite/:token'), 'invite paths are logged scrubbed');
});

// --- 4. production mode: rate limits + the generic /t/:token shell ------------------

check('production: /t/:token serves a generic shell with no-referrer; invite endpoints are rate limited', async () => {
  const PORT = 3000 + 900 + (process.pid % 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-prod-'));
  tmpFiles.push(tmp);
  const pub = path.join(tmp, 'public');
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><html><head><title>__APP_NAME__</title><link rel="manifest" href="/manifest.json"></head><body>SHELL</body></html>');
  const child = bootServer(PORT, { NODE_ENV: 'production', PUBLIC_DIR: pub, PUBLIC_HOST: 'app.test.example',
    VAPID_EMAIL: 'mailto:test@example.com', APP_NAME: 'Dibs' }, path.join(tmp, 'p.db'));
  children.push(child);
  await waitUp(BASE);
  const { call, signup } = client(BASE);
  const ana = await signup('Ana');
  const r0 = await call('POST', '/api/teams', ana.token, { name: 'Secret Squad' });
  const token = r0.body.inviteToken;

  const page = await fetch(`${BASE}/t/${token}`);
  const html = await page.text();
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.ok(html.includes('SHELL'));
  assert.ok(!html.includes('Secret Squad'), 'the Team name must not be in the unfurl');
  assert.ok(/og:title/.test(html) && /invited to a Team on Dibs/.test(html), 'generic Open Graph title');
  const href = html.match(/href="(\/api\/teams\/install-manifest\/[A-Za-z0-9_-]{43})"/)[1];
  assert.ok(!html.includes(token));
  const manifest = await (await fetch(BASE + href)).json();
  assert.equal(manifest.id, '/'); assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, `/?teamContinuation=${href.split('/').pop()}`);
  assert.ok(!JSON.stringify(manifest).includes(token));
  const redeemed = await call('POST', `/api/teams/continuation/${href.split('/').pop()}`);
  assert.equal(redeemed.body.inviteToken, token);
  assert.equal((await call('POST', `/api/teams/continuation/${href.split('/').pop()}`)).body.inviteToken, null);
  const bogus = await (await fetch(`${BASE}/t/AAAAAAAAAAAAAAAAAAAAAA`)).text();
  const normalize = (s) => s.replace(/(install-manifest\/)[A-Za-z0-9_-]{43}/g, `$1${'x'.repeat(43)}`).replace(/(data-team-invite-hash=")[a-f0-9]{64}/g, `$1${'x'.repeat(64)}`);
  assert.strictEqual(normalize(bogus), normalize(html));
  const bogusHref = bogus.match(/href="(\/api\/teams\/install-manifest\/[A-Za-z0-9_-]{43})"/)[1];
  assert.equal((await (await fetch(BASE + bogusHref)).json()).start_url, '/');
  assert.equal((await call('POST', `/api/teams/continuation/${bogusHref.split('/').pop()}`)).body.inviteToken, null);

  const bob = await signup('Bob');
  let limited = false;
  for (let i = 0; i < 80 && !limited; i++) {
    const r = await call('GET', `/api/teams/invite/${token}`, bob.token);
    if (r.status === 429) limited = true;
  }
  assert.ok(limited, 'invite preview must be rate limited');
});

(async () => {
  let failed = 0;
  console.log('\nT-1: Teams membership core\n');
  for (const c of checks) {
    try { await c.fn(); console.log(`  ok  ${c.name}`); }
    catch (err) { failed++; console.error(`  FAIL ${c.name}\n`, err && err.stack ? err.stack : err); }
  }
  cleanup();
  if (failed) { console.error(`\n${failed} failed\n`); process.exit(1); }
  console.log(`\nT-1 PASSED (${checks.length} checks).\n`);
  process.exit(0);
})();
