// D13 Team goal (PLAN-teams.md §8.1 option B, owner 2026-11-06): a cooperative weekly
// target a Captain sets ("14 of 20 this week"). No ranking, no names. Its count is the same
// total as "classes this week" (team-stats.js week.thisWeek), so it follows the T-4 share
// gates and gyms rule. Stored on teams.weekly_goal (canonical CREATE TABLE plus an
// idempotent PRAGMA-guarded ALTER), written only through teams.js.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const db = require('./db');
const teams = require('./teams');
const history = require('./class-history');
const sharing = require('./team-sharing');

const PSY = 'psycle-london';
const NOW = Date.parse('2026-11-10T10:00:00Z'); // Tuesday; the week began Monday 9 Nov
teams.__setNow(() => NOW);
const at = (h, m = 0, d = 0) => new Date(Date.UTC(2026, 10, 10 + d, h, m)).toISOString();

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function mkUser(first) {
  const email = `goal-${first.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@goal.test`;
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email).lastInsertRowid;
  db.setUserSettings(id, { firstName: first, lastName: 'Zed' });
  db.upsertUserGym(id, PSY, { gym_email: `${first.toLowerCase()}@psy.test` });
  return id;
}
const share = (over = {}) => ({ ...sharing.defaultShare(), ...over });
const attended = (uid, id, startAt) => history.upsertEntries(uid, PSY, [{ bookingId: id, eventId: Number(id.replace(/\D/g, '')) || 1, status: 'attended', startAt, timeZone: 'Europe/London', durationMin: 45, name: 'Ride' }]);

const C = mkUser('Captain');
const M = mkUser('Member');
const AO = mkUser('Actoff');
const PZ = mkUser('Pausey');
const OUT = mkUser('Outsider');
const { team, inviteToken } = teams.createTeam(C, { name: 'Goal Crew', share: share() });
const TEAM = team.id;
for (const [uid, s] of [[M, share()], [AO, share({ activity: false })], [PZ, share()]]) {
  teams.decideRequest(C, TEAM, teams.requestJoin(uid, inviteToken, s).requestId, 'approve');
}
attended(C, 'c1', at(8, 0, -1));   // Monday
attended(M, 'm1', at(7));          // Tuesday morning
attended(M, 'm2', at(8, 0, -1));   // Monday
attended(M, 'm3', at(8, 0, -3));   // last Saturday: not this week
attended(AO, 'a1', at(7, 30));     // activity off: never counted
attended(PZ, 'p1', at(7, 15));     // paused below: never counted
teams.updateMe(PZ, TEAM, { pause: '7d' });

const today = (uid) => teams.getTeamToday(uid, TEAM, { zone: 'Europe/London' });
const errOf = (fn) => { try { fn(); } catch (e) { return e; } return null; };

check('no goal by default: goal is null and the summary says weeklyGoal null', () => {
  const t = today(C);
  assert.strictEqual(t.goal, null);
  assert.strictEqual(t.team.weeklyGoal, null);
});
check('a Captain sets it; every member sees "count of target" with the classes-this-week count', () => {
  const r = teams.updateTeam(C, TEAM, { weeklyGoal: 20 });
  assert.strictEqual(r.team.weeklyGoal, 20);
  for (const uid of [C, M, AO, PZ]) {
    const t = today(uid);
    assert.deepStrictEqual(t.goal, { target: 20, count: 3 }, `viewer ${uid}`);
    assert.strictEqual(t.goal.count, t.stats.week.thisWeek, 'the same total as Classes this week');
  }
});
check('the count follows the share gates: activity off and paused members never move it', () => {
  assert.strictEqual(today(C).goal.count, 3, 'c1, m1, m2 (a1 activity off, p1 paused, m3 last week)');
  teams.updateMe(M, TEAM, { share: { activity: false } });
  try { assert.strictEqual(today(C).goal.count, 1, 'Member turned Activity off'); }
  finally { teams.updateMe(M, TEAM, { share: { activity: true } }); }
});
check('the goal payload carries no names, refs or ranking', () => {
  const g = today(M).goal;
  assert.deepStrictEqual(Object.keys(g).sort(), ['count', 'target']);
});
check('only a Captain can set it: a member gets 403, a non-member 404 (and learns nothing)', () => {
  const asMember = errOf(() => teams.updateTeam(M, TEAM, { weeklyGoal: 5 }));
  assert.strictEqual(asMember && asMember.status, 403);
  const asOutsider = errOf(() => teams.updateTeam(OUT, TEAM, { weeklyGoal: 5 }));
  assert.strictEqual(asOutsider && asOutsider.status, 404);
  assert.strictEqual(asOutsider.code, 'NOT_FOUND');
  assert.strictEqual(errOf(() => teams.getTeamToday(OUT, TEAM)).status, 404);
  assert.strictEqual(today(C).goal.target, 20, 'unchanged');
});
check('input range: whole numbers 1 to 224 only; null clears', () => {
  for (const bad of [0, -1, 225, 1.5, '10', true, NaN, Infinity, {}, []]) {
    const e = errOf(() => teams.updateTeam(C, TEAM, { weeklyGoal: bad }));
    assert.ok(e && e.status === 400 && e.code === 'INVALID', `accepted ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(teams.updateTeam(C, TEAM, { weeklyGoal: 1 }).team.weeklyGoal, 1);
  assert.strictEqual(teams.updateTeam(C, TEAM, { weeklyGoal: 224 }).team.weeklyGoal, 224);
  assert.strictEqual(teams.LIMITS.GOAL_MAX, teams.LIMITS.MAX_MEMBERS * 14);
});
check('the database refuses an out-of-range value written around teams.js', () => {
  assert.throws(() => db.db.prepare('UPDATE teams SET weekly_goal = 225 WHERE id = ?').run(TEAM), /CHECK/);
  assert.throws(() => db.db.prepare('UPDATE teams SET weekly_goal = 0 WHERE id = ?').run(TEAM), /CHECK/);
});
check('clearing it (null) hides the widget: goal is null again', () => {
  teams.updateTeam(C, TEAM, { weeklyGoal: 12 });
  assert.ok(today(M).goal);
  teams.updateTeam(C, TEAM, { weeklyGoal: null });
  assert.strictEqual(today(M).goal, null);
  assert.strictEqual(today(M).team.weeklyGoal, null);
});
check('the Teams list carries the target only, never a count', () => {
  teams.updateTeam(C, TEAM, { weeklyGoal: 9 });
  const card = teams.listTeams(M, { zone: 'Europe/London' }).find((t) => t.id === TEAM);
  assert.strictEqual(card.weeklyGoal, 9);
  assert.ok(!('goal' in card));
});
check('the competition switches stay reserved: setting a goal does not read or change them', () => {
  const before = db.db.prepare('SELECT competition_enabled FROM teams WHERE id = ?').get(TEAM).competition_enabled;
  teams.updateTeam(C, TEAM, { weeklyGoal: 10 });
  assert.strictEqual(db.db.prepare('SELECT competition_enabled FROM teams WHERE id = ?').get(TEAM).competition_enabled, before);
  assert.ok(!('leaderboard' in today(C)));
});
check('migration: a database whose teams table predates weekly_goal gains it, twice-safe', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goal-mig-')), 'old.db');
  const Database = require('better-sqlite3');
  const old = new Database(file);
  old.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY, invite_token_hash TEXT UNIQUE, invite_token_enc TEXT,
    invite_enabled INTEGER NOT NULL DEFAULT 1, invite_rotated_at TEXT, name TEXT NOT NULL, emoji TEXT,
    competition_enabled INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO teams (id, name, created_at, updated_at) VALUES ('old1', 'Old Team', 'x', 'x');`);
  old.close();
  const boot = `const d = require(${JSON.stringify(path.join(__dirname, 'db.js'))});
    const cols = d.db.prepare('PRAGMA table_info(teams)').all().map((c) => c.name);
    const idx = d.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_team_requests_status_created'").get();
    console.log(JSON.stringify({ has: cols.includes('weekly_goal'), idx: !!idx, row: d.db.prepare("SELECT weekly_goal FROM teams WHERE id = 'old1'").get() }));`;
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, ['-e', boot], { env: { ...process.env, DB_PATH: file }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(out, { has: true, idx: true, row: { weekly_goal: null } }, `boot ${i + 1}`);
  }
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
