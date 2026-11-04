// T-1 (PLAN-teams.md §5.5, §5.8): first AND last name capture.
// (1) server/user-text.js, the one person-name validator (pure);
// (2) teams.js display names: first name alone, plus the initial of the REAL last name on a
//     clash, graceful fallbacks when lastName is empty or was never captured;
// (3) db: lastName is account-scoped and /api/my-gyms rows carry the gym profile's
//     first_name/last_name; (4) HTTP: PUT /api/settings validates and normalises names,
//     config import drops invalid ones.

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

// --- 1. validator ------------------------------------------------------------------

check('checkPersonName: trims, collapses whitespace, allows empty and non-Latin names', () => {
  const { checkPersonName } = require('./user-text');
  assert.deepStrictEqual(checkPersonName('  Mary   Ann '), { ok: true, value: 'Mary Ann' });
  assert.deepStrictEqual(checkPersonName(''), { ok: true, value: '' });
  assert.deepStrictEqual(checkPersonName(undefined), { ok: true, value: '' });
  assert.deepStrictEqual(checkPersonName("O'Brien-Smith"), { ok: true, value: "O'Brien-Smith" });
  assert.deepStrictEqual(checkPersonName('Zoë'), { ok: true, value: 'Zoë' });
  assert.deepStrictEqual(checkPersonName('李'), { ok: true, value: '李' });
});

check('checkPersonName: rejects < >, control, bidi and zero-width characters, and overlong names', () => {
  const { checkPersonName, PERSON_NAME_MAX } = require('./user-text');
  const bad = ['<b>Sam', 'Sam>', 'Sa\u0000m', 'Sa\u0007m', 'Sam\u0085', 'Sam‮evil', 'Sam⁦x⁩',
    'Sam‏', 'Sa​m', 'Sam‍', 'Sam﻿', 'Sa⁠m', '؜Sam'];
  for (const v of bad) assert.strictEqual(checkPersonName(v).ok, false, JSON.stringify(v));
  assert.strictEqual(checkPersonName(42).ok, false);
  assert.strictEqual(checkPersonName('x'.repeat(PERSON_NAME_MAX)).ok, true);
  assert.strictEqual(checkPersonName('x'.repeat(PERSON_NAME_MAX + 1)).ok, false);
  // Code points, not UTF-16 units: 40 emoji-free astral letters still fit.
  assert.strictEqual(checkPersonName('𝒜'.repeat(PERSON_NAME_MAX)).ok, true);
});

check('normaliseNameSettings throws 400 INVALID_NAME; dropInvalidNameSettings drops instead', () => {
  const { normaliseNameSettings, dropInvalidNameSettings } = require('./user-text');
  const p = normaliseNameSettings({ firstName: ' Ana ', lastName: ' de  Souza ', theme: 'dark' });
  assert.deepStrictEqual(p, { firstName: 'Ana', lastName: 'de Souza', theme: 'dark' });
  let err = null;
  try { normaliseNameSettings({ lastName: '<script>' }); } catch (e) { err = e; }
  assert.ok(err && err.status === 400 && err.code === 'INVALID_NAME' && /Last name/.test(err.message));
  assert.deepStrictEqual(dropInvalidNameSettings({ firstName: 'A‮b', lastName: 'Lee' }), { lastName: 'Lee' });
  assert.deepStrictEqual(normaliseNameSettings({ theme: 'x' }), { theme: 'x' }, 'absent keys stay absent');
});

// --- 2. Teams display names -----------------------------------------------------------

function mkUser(db, { first, last, gymName } = {}) {
  const email = `u-${crypto.randomBytes(4).toString('hex')}@test.local`;
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email).lastInsertRowid;
  const s = {};
  if (first !== undefined) s.firstName = first;
  if (last !== undefined) s.lastName = last;
  if (Object.keys(s).length) db.setUserSettings(id, s);
  if (gymName) db.upsertUserGym(id, 'psycle-london', { display_name: gymName, gym_email: email });
  return id;
}
function teamOf(teams, members) {
  const [captain, ...rest] = members;
  const { team, inviteToken } = teams.createTeam(captain, { name: `T${crypto.randomBytes(3).toString('hex')}` });
  for (const u of rest) {
    teams.requestJoin(u, inviteToken);
    const r = teams.listRequests(captain, team.id).find((q) => q.requestedAt);
    teams.decideRequest(captain, team.id, r.id, 'approve');
  }
  return teams.getTeam(captain, team.id).members.map((m) => m.name).sort();
}

check('Teams: unique first name shows alone; a clash adds the initial of the REAL last name', () => {
  const db = require('./db'); const teams = require('./teams');
  // The gym profile says "Sam Wilson" but the member set their last name to Taylor: Taylor wins.
  const a = mkUser(db, { first: 'Sam', last: 'Taylor', gymName: 'Sam Wilson' });
  const b = mkUser(db, { first: 'Sam', last: 'okafor' });
  const c = mkUser(db, { first: 'Ana', last: 'Lee' });
  assert.deepStrictEqual(teamOf(teams, [a, b, c]), ['Ana', 'Sam O.', 'Sam T.']);
});

check('Teams: lastName never captured falls back to the gym profile; empty lastName means no initial', () => {
  const db = require('./db'); const teams = require('./teams');
  const legacy = mkUser(db, { first: 'Jo', gymName: 'Jo Bloggs' });      // pre-T-1 account
  const none = mkUser(db, { first: 'Jo', last: '', gymName: 'Jo Smith' }); // chose no last name
  const other = mkUser(db, { first: 'Jo', last: 'Brown' });
  assert.deepStrictEqual(teamOf(teams, [legacy, none, other]), ['Jo', 'Jo B. 1', 'Jo B. 2']);
});

check('Teams: no account name at all uses the gym profile, then "Member"', () => {
  const db = require('./db'); const teams = require('./teams');
  const g = mkUser(db, { gymName: 'Priya Raman' });
  const m = mkUser(db, {});
  assert.deepStrictEqual(teamOf(teams, [g, m]), ['Member', 'Priya']);
});

// --- 3. db -------------------------------------------------------------------------

check('db: lastName is account-scoped; my-gyms rows expose the gym profile first/last name', () => {
  const db = require('./db');
  assert.deepStrictEqual(db.splitSettingsByScope({ firstName: 'A', lastName: 'B' }), { account: { firstName: 'A', lastName: 'B' }, gym: {} });
  const id = mkUser(db, {});
  db.upsertUserGym(id, 'psycle-london', { display_name: 'Mary Ann Smith', gym_email: 'x@y.z',
    profile_json: JSON.stringify({ id: 1, first_name: 'Mary Ann', last_name: 'Smith' }) });
  db.upsertUserGym(id, 'jab-boxing', { display_name: 'Mary Smith', gym_email: 'x@y.z',
    profile_json: JSON.stringify({ data: { first_name: 'Mary', last_name: 'Smith' } }) });
  const rows = db.getUserGymsPublic(id);
  const byGym = Object.fromEntries(rows.map((r) => [r.gym_id, r]));
  assert.strictEqual(byGym['psycle-london'].first_name, 'Mary Ann');
  assert.strictEqual(byGym['psycle-london'].last_name, 'Smith');
  assert.strictEqual(byGym['jab-boxing'].first_name, 'Mary', 'enveloped profile');
  db.upsertUserGym(id, 'psycle-london', { display_name: 'X', gym_email: 'x@y.z', profile_json: '{not json' });
  const broken = db.getUserGymsPublic(id).find((r) => r.gym_id === 'psycle-london');
  assert.strictEqual(broken.first_name, null, 'invalid profile_json is null, not an error');
});

// --- 4. HTTP ---------------------------------------------------------------------------

const children = [];
const tmpFiles = [];
const cleanup = () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  for (const f of tmpFiles) { for (const x of [f, `${f}-wal`, `${f}-shm`]) { try { fs.rmSync(x, { force: true }); } catch (_) {} } }
};

check('HTTP: PUT /api/settings validates and normalises names; import drops invalid ones', async () => {
  const PORT = 4300 + (process.pid % 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const dbPath = path.join(os.tmpdir(), `test-person-names-${process.pid}.db`);
  tmpFiles.push(dbPath);
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), DB_PATH: dbPath, JWT_SECRET: 't', ADMIN_PASSWORD: 'x',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const call = async (method, p, t, body) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const su = await call('POST', '/api/auth/signup', null, { email: `n-${process.pid}@test.local`, password: 'password123' });
  const t = su.body.token;
  assert.ok(t);
  let r = await call('PUT', '/api/settings', t, { firstName: '  Ada ', lastName: ' Love  lace ' });
  assert.strictEqual(r.status, 200);
  let s = (await call('GET', '/api/settings', t)).body;
  assert.strictEqual(s.firstName, 'Ada');
  assert.strictEqual(s.lastName, 'Love lace');
  for (const bad of [{ lastName: '<img>' }, { firstName: 'A‮b' }, { lastName: 'x'.repeat(41) }, { firstName: 7 }]) {
    r = await call('PUT', '/api/settings', t, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual(r.body.code, 'INVALID_NAME');
  }
  s = (await call('GET', '/api/settings', t)).body;
  assert.strictEqual(s.lastName, 'Love lace', 'a rejected patch changes nothing');
  r = await call('POST', '/api/config/import', t, { accountSettings: { firstName: 'Bad​', lastName: 'Byron' } });
  assert.strictEqual(r.status, 200);
  s = (await call('GET', '/api/settings', t)).body;
  assert.strictEqual(s.firstName, 'Ada', 'invalid imported first name dropped');
  assert.strictEqual(s.lastName, 'Byron');
});

(async () => {
  let failed = 0;
  console.log('\nT-1: person names\n');
  for (const c of checks) {
    try { await c.fn(); console.log(`  ok  ${c.name}`); }
    catch (err) { failed++; console.error(`  FAIL ${c.name}\n`, err && err.stack ? err.stack : err); }
  }
  cleanup();
  if (failed) { console.error(`\n${failed} failed\n`); process.exit(1); }
  console.log(`\nperson names PASSED (${checks.length} checks).\n`);
  process.exit(0);
})();
