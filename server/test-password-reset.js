// Self-service password reset (C6-1): forgot + reset + the "password changed" notice.
// Boots the real server with a preload that captures outgoing mail (nothing is ever sent),
// RATE_LIMIT_TEST_FORCE=1 so the limiters are live.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-password-reset.db');
const SECRET = 'password-reset-secret';
const OUTBOX = path.join(os.tmpdir(), `outbox-reset-${process.pid}.jsonl`);
const PRELOAD = path.join(os.tmpdir(), `capture-mail-reset-${process.pid}.js`);
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`, OUTBOX, PRELOAD]) { try { fs.unlinkSync(f); } catch (_) {} }
};
const json = (method, p, token, body) => fetch(`${BASE}${p}`, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (n) => { for (let i = 0; i < 60 && outbox().length < n; i++) await wait(50); return outbox(); };
const tokenOf = (msg) => new URL(msg.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function run() {
  cleanup();
  const prep = spawnSync(process.execPath, ['-e', `
    const db = require('./db'); const { createUser } = require('./testkit');
    const a = createUser(db, 'reset@example.com', 'enc-gym-secret');
    db.setAccountPassword(a, 'old-password-1', { revokeTokens: false });
    db.db.prepare("UPDATE user_gyms SET session_json = 'x', status = 'active' WHERE user_id = ?").run(a);
    db.db.prepare("INSERT INTO studio_preferences (user_id, gym_id, studio_id, preferences) VALUES (?, 'psycle-london', 7, '{}')").run(a);
    for (const e of ['b@example.com', 'c@example.com']) db.createAccount(e, 'old-password-1');
    db.db.pragma('wal_checkpoint(TRUNCATE)');
  `], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, DB_PATH, JWT_SECRET: SECRET } });
  assert.strictEqual(prep.status, 0, `${prep.stdout}${prep.stderr}`);

  fs.writeFileSync(PRELOAD, `require(${JSON.stringify(path.join(__dirname, 'email.js'))})._setTransportForTests((m) => require('fs').appendFileSync(${JSON.stringify(OUTBOX)}, JSON.stringify(m) + '\\n'));`);
  child = spawn('node', ['-r', PRELOAD, 'server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', RATE_LIMIT_TEST_FORCE: '1', JWT_SECRET: SECRET, ADMIN_PASSWORD: 'scratch-admin-pw', ENCRYPTION_KEY: process.env.ENCRYPTION_KEY } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {} await wait(150); }
  const raw = new Database(DB_PATH);

  const oldLogin = await json('POST', '/api/auth/login', null, { email: 'reset@example.com', password: 'old-password-1' });
  assert.strictEqual(oldLogin.status, 200, JSON.stringify(oldLogin.body));
  const oldJwt = oldLogin.body.token;
  assert.strictEqual(oldLogin.body.user.emailVerified, false, 'starts unverified');

  // --- forgot: identical answer for unknown and known; mail only for the known one ---
  const unknown = await json('POST', '/api/auth/forgot', null, { email: 'nobody@example.com' });
  const known = await json('POST', '/api/auth/forgot', null, { email: '  Reset@Example.com ' });
  assert.strictEqual(unknown.status, 200); assert.strictEqual(known.status, 200);
  assert.deepStrictEqual(unknown.body, known.body, 'same body whether or not the account exists');
  const junk = await json('POST', '/api/auth/forgot', null, { email: 12345 });
  assert.deepStrictEqual(junk.body, known.body, 'malformed input gets the same answer');
  await waitFor(1); await wait(300);
  let mails = outbox();
  assert.strictEqual(mails.length, 1, 'one mail, for the known account only');
  assert.deepStrictEqual(mails[0].to, ['reset@example.com'], 'case/space normalised');
  assert.ok(mails[0].text.includes('/reset-password?token='));
  const tok1 = tokenOf(mails[0]);

  // --- stored hashed only, 30 minutes ---
  const rows = raw.prepare("SELECT token_hash, expires_at, created_at FROM account_email_tokens WHERE purpose = 'reset'").all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].token_hash, sha(tok1));
  assert.ok(!JSON.stringify(rows).includes(tok1), 'raw token never stored');
  assert.strictEqual(rows[0].expires_at - rows[0].created_at, 30 * 60 * 1000);

  // --- a GET of the landing path never consumes ---
  await fetch(`${BASE}/reset-password?token=${tok1}`);
  assert.strictEqual(raw.prepare('SELECT used_at FROM account_email_tokens').get().used_at, null);

  // --- a second request supersedes the first ---
  await json('POST', '/api/auth/forgot', null, { email: 'reset@example.com' });
  mails = await waitFor(2);
  const tok2 = tokenOf(mails[1]);
  assert.notStrictEqual(tok1, tok2);
  assert.strictEqual((await json('POST', '/api/auth/reset', null, { token: tok1, password: 'new-password-9' })).status, 400, 'superseded token rejected');

  // --- weak password is rejected WITHOUT burning the token ---
  const weak = await json('POST', '/api/auth/reset', null, { token: tok2, password: 'short' });
  assert.strictEqual(weak.status, 400); assert.strictEqual(weak.body.code, 'WEAK_PASSWORD');
  assert.strictEqual(raw.prepare('SELECT used_at FROM account_email_tokens WHERE token_hash = ?').get(sha(tok2)).used_at, null, 'token survives a weak-password attempt');

  // --- reset succeeds once ---
  const before = outbox().length;
  const done = await json('POST', '/api/auth/reset', null, { token: tok2, password: 'new-password-9' });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.token && done.body.user.email === 'reset@example.com' && done.body.user.emailVerified === true, 'signed in, verified');
  assert.strictEqual(done.body.gymsReset, 1);
  assert.strictEqual((await json('GET', '/api/auth/status', done.body.token)).status, 200, 'fresh token works');
  assert.strictEqual((await json('GET', '/api/auth/status', oldJwt)).status, 403, 'old JWTs revoked (token_version)');
  assert.strictEqual((await json('POST', '/api/auth/login', null, { email: 'reset@example.com', password: 'old-password-1' })).status, 401, 'old password dead');
  assert.strictEqual((await json('POST', '/api/auth/login', null, { email: 'reset@example.com', password: 'new-password-9' })).status, 200, 'new password works');
  assert.strictEqual((await json('POST', '/api/auth/reset', null, { token: tok2, password: 'another-pass-1' })).status, 400, 'single use');

  // --- gym credentials wiped; link, queue data, spot maps survive ---
  const g = raw.prepare('SELECT encrypted_password, session_json, status FROM user_gyms WHERE gym_id = ?').get('psycle-london');
  assert.strictEqual(g.encrypted_password, null); assert.strictEqual(g.session_json, null); assert.strictEqual(g.status, 'needs_relogin');
  assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM studio_preferences').get().n, 1, 'spot maps survive');

  // --- notice mail: neutral, no token ---
  mails = await waitFor(before + 1);
  const notice = mails[before];
  assert.ok(/password was changed/i.test(notice.subject) && !/token=/.test(notice.text + notice.html), 'notice carries no reset token');
  assert.ok(notice.text.includes('/reset-password') , 'notice links to the request page');

  // --- expired token ---
  await json('POST', '/api/auth/forgot', null, { email: 'reset@example.com' });
  mails = await waitFor(before + 2);
  const tok3 = tokenOf(mails[before + 1]);
  raw.prepare('UPDATE account_email_tokens SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, sha(tok3));
  assert.strictEqual((await json('POST', '/api/auth/reset', null, { token: tok3, password: 'new-password-9' })).status, 400, 'expired rejected');
  for (const bad of ['', 'garbage', null, 42, { a: 1 }, 'x'.repeat(43)]) {
    const r = await json('POST', '/api/auth/reset', null, { token: bad, password: 'new-password-9' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_TOKEN');
  }

  // --- notice on self-service change, and on admin reset ---
  const n0 = outbox().length;
  const chg = await json('POST', '/api/account/password', done.body.token, { currentPassword: 'new-password-9', newPassword: 'third-password-3' });
  assert.strictEqual(chg.status, 200);
  mails = await waitFor(n0 + 1);
  assert.ok(/password was changed/i.test(mails[n0].subject) && mails[n0].to[0] === 'reset@example.com');
  const adm = await json('POST', '/api/admin/login', null, { password: 'scratch-admin-pw' });
  const uid = raw.prepare("SELECT id FROM users WHERE email = 'c@example.com'").get().id;
  const ar = await fetch(`${BASE}/api/admin/users/${uid}/reset-password`, { method: 'POST', headers: { authorization: `Bearer ${adm.body.token}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  mails = await waitFor(n0 + 2);
  assert.ok(/password was changed/i.test(mails[n0 + 1].subject) && !JSON.stringify(mails[n0 + 1]).includes(ar.tempPassword), 'admin reset notifies without the temp password');

  // --- per-account cap: 3 reset mails per hour, still 200 ---
  const n1 = outbox().length;
  for (let i = 0; i < 4; i++) assert.strictEqual((await json('POST', '/api/auth/forgot', null, { email: 'b@example.com' })).status, 200);
  await waitFor(n1 + 3); await wait(300);
  assert.strictEqual(outbox().length, n1 + 3, 'fourth request within the hour sends nothing');
  assert.strictEqual(raw.prepare("SELECT COUNT(*) n FROM account_email_tokens WHERE purpose = 'reset' AND user_id = (SELECT id FROM users WHERE email='b@example.com')").get().n, 3);

  // --- per-IP limits (forgot 10/hour, reset 20/15min), separate from the login limiter ---
  let forgotLimited = 0;
  for (let i = 0; i < 12; i++) if ((await json('POST', '/api/auth/forgot', null, { email: 'nobody@example.com' })).status === 429) forgotLimited++;
  assert.ok(forgotLimited > 0, 'forgot is IP rate limited');
  let resetLimited = 0;
  for (let i = 0; i < 25; i++) if ((await json('POST', '/api/auth/reset', null, { token: 'z'.repeat(43), password: 'new-password-9' })).status === 429) resetLimited++;
  assert.ok(resetLimited > 0, 'reset is IP rate limited');
  assert.notStrictEqual((await json('POST', '/api/auth/login', null, { email: 'reset@example.com', password: 'third-password-3' })).status, 429, 'login limiter is separate');

  raw.close();
  child.kill(); child = null;
}

run().then(() => { cleanup(); console.log('PASS password reset: forgot (uniform), single-use hashed 30-min tokens, revocation, gym creds cleared, notices, limits.'); })
  .catch((e) => { cleanup(); console.error(e); process.exit(1); });
