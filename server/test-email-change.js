// Change account email (C6-2): re-auth, confirmation link to the NEW address, notices to the OLD,
// single-use 30-minute hashed token, uniqueness without disclosure, session revocation, gym_email
// untouched, DB-counted limits. Boots the real server with a mail-capturing preload (nothing is sent).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = 3096;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-email-change.db');
const SECRET = 'email-change-secret';
const OUTBOX = path.join(os.tmpdir(), `outbox-change-${process.pid}.jsonl`);
const PRELOAD = path.join(os.tmpdir(), `capture-mail-change-${process.pid}.js`);
const PW = 'old-password-1';
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
const change = (jwt, newEmail, password = PW) => json('POST', '/api/account/email', jwt, { newEmail, password });

async function run() {
  cleanup();
  const prep = spawnSync(process.execPath, ['-e', `
    const db = require('./db'); const { createUser } = require('./testkit');
    const a = createUser(db, 'owner@example.com', 'enc-gym-secret');
    db.db.prepare("UPDATE user_gyms SET gym_email = 'gymlogin@example.com' WHERE user_id = ?").run(a);
    db.setAccountPassword(a, '${PW}', { revokeTokens: false });
    for (const e of ['taken@example.com', 'racer@example.com', 'limit@example.com']) db.createAccount(e, '${PW}');
    db.db.pragma('wal_checkpoint(TRUNCATE)');
  `], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, DB_PATH, JWT_SECRET: SECRET } });
  assert.strictEqual(prep.status, 0, `${prep.stdout}${prep.stderr}`);

  fs.writeFileSync(PRELOAD, `require(${JSON.stringify(path.join(__dirname, 'email.js'))})._setTransportForTests((m) => require('fs').appendFileSync(${JSON.stringify(OUTBOX)}, JSON.stringify(m) + '\\n'));`);
  child = spawn('node', ['-r', PRELOAD, 'server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: SECRET, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {} await wait(150); }
  const raw = new Database(DB_PATH);
  const login = async (email) => (await json('POST', '/api/auth/login', null, { email, password: PW })).body.token;
  const jwt = await login('owner@example.com');
  assert.ok(jwt, 'owner can log in');

  // --- auth + re-auth + validation ---
  assert.strictEqual((await json('POST', '/api/account/email', null, { newEmail: 'x@example.com', password: PW })).status, 401, 'needs auth');
  const wrong = await change(jwt, 'n1@example.com', 'not-the-password');
  assert.strictEqual(wrong.status, 403, 'wrong current password is refused');            // attempt 1
  await wait(150);
  assert.strictEqual(outbox().length, 0, 'wrong password sends nothing');
  assert.strictEqual((await json('POST', '/api/account/email', jwt, { newEmail: 'n1@example.com' })).status, 403, 'missing password is refused'); // attempt 2
  assert.strictEqual((await change(jwt, 'Owner@Example.com ')).status, 400, 'same address (case/space-insensitive) rejected');
  for (const bad of ['', 'nope', 'a@b', 'a b@c.de', null, 5]) assert.strictEqual((await change(jwt, bad)).status, 400, `rejects ${JSON.stringify(bad)}`);
  assert.strictEqual(outbox().length, 0, 'invalid input sends nothing');

  // --- a taken address answers exactly like a free one, and mails nobody ---
  const takenRes = await change(jwt, ' TAKEN@Example.com ');                            // attempt 3
  await wait(200);
  assert.strictEqual(outbox().length, 0, 'taken address: nothing to the holder, nothing to the old address');
  const ok1 = await change(jwt, ' N1@Example.com ');                                    // attempt 4
  assert.strictEqual(ok1.status, 200);
  assert.deepStrictEqual(ok1, takenRes, 'success and taken responses are identical');
  let mails = await waitFor(2);
  assert.strictEqual(mails.length, 2);
  const toNew = mails.find((m) => m.to[0] === 'n1@example.com');
  const toOld = mails.find((m) => m.to[0] === 'owner@example.com');
  assert.ok(toNew && toOld, 'one mail to the new address, one to the old');
  const t1 = tokenOf(toNew);
  assert.ok(toNew.text.includes('/confirm-email?token='), 'confirmation link');
  assert.ok(!toOld.text.includes('token='), 'the notice to the old address carries no token');
  assert.ok(toOld.text.includes('n***@e***.com') && !toOld.text.includes('n1@example.com'), 'new address is masked in the notice');
  assert.ok(toOld.text.includes('/reset-password'), 'notice points at reset');
  const rows = raw.prepare("SELECT token_hash, new_email, expires_at, created_at, used_at FROM account_email_tokens WHERE purpose = 'email_change' AND new_email = 'n1@example.com'").all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].token_hash, sha(t1));
  assert.strictEqual(rows[0].expires_at - rows[0].created_at, 30 * 60 * 1000, 'valid for 30 minutes');
  assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM account_email_tokens').all()).includes(t1), 'raw token is not stored');
  assert.ok(!/confirm-email/.test(JSON.stringify(raw.prepare('SELECT * FROM users').all())), 'no link in users');
  assert.strictEqual(raw.prepare("SELECT email FROM users WHERE email = 'n1@example.com'").get(), undefined, 'nothing changes before confirmation');

  // --- a newer request supersedes the older pending one ---
  const ok2 = await change(jwt, 'n2@example.com');                                      // attempt 5
  assert.strictEqual(ok2.status, 200);
  mails = await waitFor(4);
  const t2 = tokenOf(mails.find((m) => m.to[0] === 'n2@example.com'));
  assert.strictEqual((await json('POST', '/api/auth/confirm-email', null, { token: t1 })).status, 400, 'older pending change is dead');
  for (const bad of ['', 'garbage', 'x'.repeat(43), null, 12345, { a: 1 }]) {
    assert.strictEqual((await json('POST', '/api/auth/confirm-email', null, { token: bad })).status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.ok(/app\.get\('\/confirm-email'[\s\S]{0,200}no-referrer/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'landing route is served with no-referrer');
  assert.strictEqual((await json('POST', '/api/auth/verify-email', null, { token: t2 })).status, 400, 'a change token is not a verify token');
  assert.strictEqual((await json('POST', '/api/auth/reset', null, { token: t2, password: 'brand-new-pw-1' })).status, 400, 'nor a reset token');

  // --- limit: every attempt counted (5/hour), including the wrong passwords above ---
  const limited = await change(jwt, 'n3@example.com');
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.body.code, 'EMAIL_CHANGE_RATE_LIMITED');
  assert.strictEqual((await change(jwt, 'n3@example.com', 'not-the-password')).status, 429, 'limit applies before the password check');

  // --- confirm: consumes once, moves only users.email, revokes old sessions, signs in ---
  const gymEmailBefore = raw.prepare('SELECT gym_email FROM user_gyms WHERE user_id = (SELECT id FROM users WHERE email = ?)').get('owner@example.com').gym_email;
  const conf = await json('POST', '/api/auth/confirm-email', null, { token: t2 });
  assert.strictEqual(conf.status, 200, JSON.stringify(conf.body));
  assert.strictEqual(conf.body.user.email, 'n2@example.com');
  assert.strictEqual(conf.body.user.emailVerified, true);
  const row = raw.prepare("SELECT id, email, email_verified_at FROM users WHERE email = 'n2@example.com'").get();
  assert.ok(row && row.email_verified_at, 'new email is stamped verified');
  assert.strictEqual(raw.prepare('SELECT gym_email FROM user_gyms WHERE user_id = ?').get(row.id).gym_email, gymEmailBefore, 'gym_email untouched');
  assert.strictEqual(gymEmailBefore, 'gymlogin@example.com');
  assert.ok([401, 403].includes((await json('GET', '/api/auth/status', jwt)).status), 'old JWT is revoked');
  const st = await json('GET', '/api/auth/status', conf.body.token);
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.body.email, 'n2@example.com');
  assert.strictEqual((await json('POST', '/api/auth/confirm-email', null, { token: t2 })).status, 400, 'reuse rejected');
  assert.strictEqual((await json('POST', '/api/auth/login', null, { email: 'owner@example.com', password: PW })).status, 401, 'old address no longer logs in');
  assert.strictEqual((await json('POST', '/api/auth/login', null, { email: 'n2@example.com', password: PW })).status, 200, 'new address logs in');
  mails = await waitFor(5);
  const changed = mails[4];
  assert.deepStrictEqual(changed.to, ['owner@example.com'], 'final notice goes to the OLD address');
  assert.ok(changed.text.includes('n***@e***.com') && !changed.text.includes('token='));

  // --- expiry: a pending token past 30 minutes is dead ---
  const racer = await login('racer@example.com');
  assert.strictEqual((await change(racer, 'late@example.com')).status, 200);
  mails = await waitFor(7);
  const tLate = tokenOf(mails.find((m) => m.to[0] === 'late@example.com'));
  raw.prepare("UPDATE account_email_tokens SET expires_at = ? WHERE new_email = 'late@example.com'").run(Date.now() - 1000);
  assert.strictEqual((await json('POST', '/api/auth/confirm-email', null, { token: tLate })).status, 400, 'expired link rejected');

  // --- race: the address is taken between request and confirm ---
  assert.strictEqual((await change(racer, 'race@example.com')).status, 200);
  mails = await waitFor(9);
  const tRace = tokenOf(mails.find((m) => m.to[0] === 'race@example.com'));
  raw.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES ('race@example.com', '', 200)").run();
  const lost = await json('POST', '/api/auth/confirm-email', null, { token: tRace });
  assert.strictEqual(lost.status, 400, 'uniqueness is re-checked at confirm');
  assert.strictEqual(lost.body.code, 'INVALID_TOKEN', 'generic error');
  assert.strictEqual(raw.prepare("SELECT email FROM users WHERE email = 'racer@example.com'").get().email, 'racer@example.com', 'account unchanged');
  assert.strictEqual((await json('GET', '/api/auth/status', racer)).status, 200, 'failed confirm does not revoke sessions');
  const before = outbox().length;
  await wait(200);
  assert.strictEqual(outbox().length, before, 'no "changed" notice for a failed confirm');

  // --- wrong passwords count toward the limit too ---
  const lim = await login('limit@example.com');
  for (let i = 0; i < 5; i++) assert.strictEqual((await change(lim, 'z@example.com', 'wrong-wrong-1')).status, 403);
  assert.strictEqual((await change(lim, 'z@example.com')).status, 429, 'sixth attempt (even with the right password) is limited');
  await wait(200);
  assert.ok(!outbox().some((m) => m.to[0] === 'z@example.com'), 'nothing mailed to a limited request');

  raw.close();
  child.kill(); child = null;
}

run().then(() => { cleanup(); console.log('PASS email change: re-auth, hashed single-use 30-minute links, taken-address silence, notices, revocation, gym_email untouched, limits.'); })
  .catch((e) => { cleanup(); console.error(e); process.exit(1); });
