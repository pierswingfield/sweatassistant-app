// Security audit part 2: user_gyms.session_json encryption at rest (+ legacy plaintext
// migration), admin never returning tokens, ENCRYPTION_KEY length gate, .ics CR escaping.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'part2-secret';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const db = require('./db');
const testkit = require('./testkit');
const cryptoMod = require('./crypto');

const raw = (uid, gym) => db.db.prepare('SELECT session_json FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(uid, gym).session_json;
const TOKEN = 'SECRET-ACCESS-TOKEN-abc123';
const REFRESH = 'SECRET-REFRESH-TOKEN-xyz789';

// --- writers seal, readers open -------------------------------------------------
const uid = testkit.createUser(db, 'enc@example.com', cryptoMod.encrypt('gympw'));
db.setGymSession(uid, 'psycle-london', { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: '2030-01-01T00:00:00Z' });
let stored = raw(uid, 'psycle-london');
assert.ok(stored.startsWith('s2:'), 'stored with the s2: version marker');
assert.ok(!stored.includes(TOKEN) && !stored.includes(REFRESH), 'no token text in the column');
assert.deepStrictEqual(db.getUserSession(uid, 'psycle-london'), { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: '2030-01-01T00:00:00Z' }, 'round-trips (refresh token kept)');
assert.strictEqual(db.getUserById(uid).jwt, TOKEN, 'merged user.jwt for the active gym');
assert.strictEqual(JSON.parse(db.getUserGym(uid, 'psycle-london').session_json).refreshToken, REFRESH, 'getUserGym hands callers plaintext JSON');
assert.strictEqual(JSON.parse(db.getUserGyms(uid)[0].session_json).accessToken, TOKEN, 'getUserGyms too');
const vestige = db.db.prepare('SELECT jwt FROM users WHERE id = ?').get(uid).jwt;
assert.strictEqual(vestige, null, 'the plaintext users.jwt copy is no longer written');

// updateUserJWT / updateUserCredentials paths seal as well
db.updateUserJWT(uid, 'ANOTHER-TOKEN-777', '2031-01-01T00:00:00Z', 'psycle-london');
assert.ok(!raw(uid, 'psycle-london').includes('ANOTHER-TOKEN-777') && raw(uid, 'psycle-london').startsWith('s2:'));
assert.strictEqual(db.getUserSession(uid, 'psycle-london').accessToken, 'ANOTHER-TOKEN-777');
// an unrelated upsert (e.g. profile update) must not corrupt or re-expose the sealed value
db.upsertUserGym(uid, 'psycle-london', { display_name: 'Someone' });
assert.ok(raw(uid, 'psycle-london').startsWith('s2:'), 'unrelated upsert keeps the column sealed');
assert.strictEqual(db.getUserSession(uid, 'psycle-london').accessToken, 'ANOTHER-TOKEN-777');

// Clearing works
db.setGymSession(uid, 'psycle-london', null);
assert.strictEqual(raw(uid, 'psycle-london'), null);

// --- AAD binding: the ciphertext only opens for its own purpose ------------------
const ct = cryptoMod.encryptV2('{"accessToken":"x"}', db.SESSION_AAD);
assert.throws(() => cryptoMod.decryptV2(ct, 'some-other-context'), 'wrong AAD fails authentication');
assert.throws(() => cryptoMod.decryptV2(ct.slice(0, -2) + '00', db.SESSION_AAD), 'tampered ciphertext fails');
assert.strictEqual(cryptoMod.decrypt(cryptoMod.encrypt('legacy')), 'legacy', 'the old unversioned format still decrypts');

// --- legacy plaintext rows: readable BEFORE migration, sealed by it, idempotent ----
const uid2 = testkit.createUser(db, 'legacy@example.com', cryptoMod.encrypt('gympw'));
const legacyJson = JSON.stringify({ accessToken: 'LEGACY-PLAINTEXT-TOKEN', refreshToken: 'LEGACY-REFRESH' });
db.db.prepare('UPDATE user_gyms SET session_json = ? WHERE user_id = ?').run(legacyJson, uid2);
db.db.prepare('UPDATE users SET jwt = ? WHERE id = ?').run('LEGACY-PLAINTEXT-TOKEN', uid2);
assert.strictEqual(db.getUserSession(uid2, 'psycle-london').accessToken, 'LEGACY-PLAINTEXT-TOKEN', 'legacy plaintext still reads');
assert.strictEqual(db.getUserById(uid2).jwt, 'LEGACY-PLAINTEXT-TOKEN');
assert.strictEqual(db.migrateSessionEncryption(), 1, 'migration seals the one plaintext row');
assert.ok(raw(uid2, 'psycle-london').startsWith('s2:') && !raw(uid2, 'psycle-london').includes('LEGACY'));
assert.strictEqual(db.getUserSession(uid2, 'psycle-london').refreshToken, 'LEGACY-REFRESH', 'still readable after migration');
assert.strictEqual(db.db.prepare('SELECT jwt FROM users WHERE id = ?').get(uid2).jwt, null, 'plaintext users.jwt copy cleared');
const sealedOnce = raw(uid2, 'psycle-london');
assert.strictEqual(db.migrateSessionEncryption(), 0, 'second run is a no-op');
assert.strictEqual(raw(uid2, 'psycle-london'), sealedOnce, 'and does not re-encrypt');

// --- the admin views never carry tokens -------------------------------------------
db.setGymSession(uid, 'psycle-london', { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: '2030-01-01T00:00:00Z' });
const adminBlob = JSON.stringify([db.getUserDetail(uid), db.getAllUsers(), db.getUserGymsPublic(uid)]);
for (const secret of [TOKEN, REFRESH, 's2:']) assert.ok(!adminBlob.includes(secret), `admin payloads contain no ${secret.slice(0, 10)}...`);
assert.strictEqual(db.getUserDetail(uid).user.jwt_expires_at, '2030-01-01T00:00:00Z', 'expiry (not the token) is still shown');

// --- no module outside db.js touches the column format ----------------------------
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && !n.startsWith('test-') && n !== 'db.js' && n !== 'testkit.js')) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert.ok(!/SELECT[^;`']*session_json[^;`']*FROM user_gyms/i.test(src), `${f} does not read session_json directly`);
}

// --- ENCRYPTION_KEY length gate ------------------------------------------------------
const boot = (key) => spawnSync(process.execPath, ['-e', "require('./crypto')"], { cwd: __dirname, env: { ...process.env, ENCRYPTION_KEY: key }, encoding: 'utf8' });
assert.strictEqual(boot('a'.repeat(64)).status, 0, '64 hex chars accepted');
assert.strictEqual(boot(Buffer.alloc(32, 7).toString('base64')).status, 0, '32-byte base64 accepted');
assert.strictEqual(boot('x'.repeat(32)).status, 0, 'raw 32-byte string accepted');
for (const bad of ['short', 'a'.repeat(32 + 2) , 'a'.repeat(62), 'b'.repeat(66), 'not-32-bytes-at-all!']) {
  const r = boot(bad);
  assert.strictEqual(r.status, 1, `"${bad}" refused`);
  assert.match(r.stderr, /exactly 32 bytes/);
}

// --- .ics text escaping: lone CR is normalised like CRLF ---------------------------------
const { escapeIcsText } = require('./calendar');
assert.strictEqual(escapeIcsText('a\rb'), 'a\\nb', 'lone CR -> \\n');
assert.strictEqual(escapeIcsText('a\r\nb\nc\rd'), 'a\\nb\\nc\\nd', 'CRLF, LF and CR all -> \\n');
assert.ok(!/[\r\n]/.test(escapeIcsText('x\ry;z,\\')), 'no raw CR/LF survives');

console.log('security-part2: all assertions passed');
