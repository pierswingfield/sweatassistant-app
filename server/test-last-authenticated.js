// Sweat Assistant — U1-9: "Last authenticated" was always "Not recorded".
//
// Root cause: db.upsertUserGym() enumerated its columns in the INSERT and in the
// ON CONFLICT ... DO UPDATE, and `last_authenticated_at` was in neither. So every
// caller that passed it (setGymSession, auth.linkGymAccount) had the value
// silently dropped, and the two login writers (updateUserCredentials,
// updateUserJWT) never passed it at all. The read side (getUserGymsPublic ->
// GET /api/my-gyms -> Settings) was always correct: it faithfully returned NULL.
// On the dev twin, 0 of 677 user_gyms rows had a value.
//
// Part 1 pins the db write paths. Part 2 pins the whole path over real HTTP: a
// login and a gym link must each surface a timestamp on GET /api/my-gyms, which
// is the payload the Settings table renders.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let seq = 0;
const uniq = (p) => `${p}-${Date.now()}-${seq++}@test.local`;
const GYM = 'psycle-london';
const OTHER = 'jab-boxing';
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function unit() {
  const db = require('./db');
  db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(OTHER);
  const read = (uid, gym) => db.getUserGym(uid, gym).last_authenticated_at;

  // 1. The column itself round-trips through the upsert (the actual root cause).
  let uid = db.createUser(uniq('upsert'), 'enc:pw');
  assert.strictEqual(read(uid, GYM), null, 'a link that has never authenticated records nothing');
  const stamp = '2026-09-01T10:00:00.000Z';
  db.upsertUserGym(uid, GYM, { last_authenticated_at: stamp });
  assert.strictEqual(read(uid, GYM), stamp, 'upsertUserGym must persist last_authenticated_at');
  // ...and an unrelated upsert must not wipe it.
  db.upsertUserGym(uid, GYM, { priority: 150 });
  assert.strictEqual(read(uid, GYM), stamp, 'an unrelated upsert preserves the stamp');
  console.log('✅ upsertUserGym persists last_authenticated_at and preserves it across other writes.');

  // 2. Background session renewal stamps; clearing a session does not.
  uid = db.createUser(uniq('renew'), 'enc:pw');
  db.setGymSession(uid, GYM, { accessToken: 'tok', expiresAt: null });
  const afterRenew = read(uid, GYM);
  assert.ok(isIso(afterRenew), `setGymSession must stamp (got ${afterRenew})`);
  db.setGymSession(uid, GYM, null);
  assert.strictEqual(read(uid, GYM), afterRenew, 'a failed renewal (session cleared) must not look like authentication');
  console.log('✅ setGymSession stamps a issued session and leaves the stamp alone when clearing one.');

  // 3. The primary login writers.
  uid = db.createUser(uniq('login'), 'enc:pw');
  db.updateUserJWT(uid, 'jwt-1', null, GYM);
  assert.ok(isIso(read(uid, GYM)), 'updateUserJWT (new-user login) must stamp');
  uid = db.createUser(uniq('login2'), 'enc:pw');
  db.updateUserCredentials(uid, 'enc:pw2', 'jwt-2', null, GYM);
  assert.ok(isIso(read(uid, GYM)), 'updateUserCredentials (existing-user login) must stamp');
  // Storing a credential with no session is not an authentication.
  uid = db.createUser(uniq('nosession'), 'enc:pw');
  db.updateUserCredentials(uid, 'enc:pw3', null, null, GYM);
  assert.strictEqual(read(uid, GYM), null, 'no session issued -> nothing recorded');
  console.log('✅ Login writers stamp only when a session was actually issued.');

  // 4. Stamps are per gym.
  uid = db.createUser(uniq('pergym'), 'enc:pw');
  db.upsertUserGym(uid, OTHER, { gym_email: 'x@jab.example', encrypted_password: 'enc:jab' });
  db.setGymSession(uid, OTHER, { accessToken: 'jab-tok' });
  assert.ok(isIso(read(uid, OTHER)));
  assert.strictEqual(read(uid, GYM), null, 'authenticating one gym must not stamp another');
  console.log('✅ The stamp is per (account, gym).');

  // 5. The read side hands it to the API payload under the name the client reads.
  const pub = db.getUserGymsPublic(uid).find((g) => g.gym_id === OTHER);
  assert.ok(isIso(pub.last_authenticated_at), 'getUserGymsPublic exposes last_authenticated_at');
  console.log('✅ getUserGymsPublic exposes last_authenticated_at.');
}

// ---------------------------------------------------------------- HTTP part
const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-lastauth.db');
let child;

function cleanup() {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
}

async function http() {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const json = (r) => r.json();
  const post = (p, body, token) => fetch(`${BASE}${p}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const myGyms = async (token) => (await json(await fetch(`${BASE}/api/my-gyms`, { headers: { authorization: `Bearer ${token}` } }))).gyms;

  const before = Date.now() - 2000;
  const login = await json(await post('/api/auth/login', { email: 'dev@psycle.com', password: 'x' }));
  let gyms = await myGyms(login.token);
  const psycle = gyms.find((g) => g.gym_id === GYM);
  assert.ok(isIso(psycle.last_authenticated_at), `GET /api/my-gyms after login: got ${psycle.last_authenticated_at}`);
  assert.ok(Date.parse(psycle.last_authenticated_at) >= before, 'and it is recent, not a stale placeholder');
  console.log('✅ Login surfaces last_authenticated_at on GET /api/my-gyms.');

  const link = await post('/api/my-gyms/link', { gymId: OTHER, email: 'dev@jabboxing.mock', password: 'x' }, login.token);
  assert.strictEqual(link.status, 200, await link.text());
  gyms = await myGyms(login.token);
  assert.ok(isIso(gyms.find((g) => g.gym_id === OTHER).last_authenticated_at), 'linking a gym stamps that gym');
  console.log('✅ Linking a gym surfaces last_authenticated_at for it.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 U1-9: last authenticated is recorded and surfaced\n');
  try {
    unit();
    await http();
    console.log('\n🎉 U1-9 LAST-AUTHENTICATED CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ U1-9 test FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
