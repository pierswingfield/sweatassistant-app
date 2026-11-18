// Account emails (step 1): verification mail, single-use hashed tokens, resend limit,
// existing-account migration, no-op without RESEND_API_KEY. Boots the real server with a
// preload that captures outgoing mail (nothing is ever sent).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-account-email.db');
const SECRET = 'account-email-secret';
const OUTBOX = path.join(os.tmpdir(), `outbox-${process.pid}.jsonl`);
const PRELOAD = path.join(os.tmpdir(), `capture-mail-${process.pid}.js`);
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
const tokenOf = (msg) => new URL(msg.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
const AGREE = require('./policies').CURRENT_ACCEPTANCE;

async function run() {
  cleanup();
  const config = require('./config');
  // --- migration: a DB from before the column exists marks every existing account verified ---
  // Build the schema with the real db.js, then strip the column + add two accounts, as a pre-feature prod DB looks.
  const prep = require('child_process').spawnSync(process.execPath, ['-e', `
    const db = require('./db');
    db.createAccount('old1@example.com', 'a-long-password'); db.createAccount('old2@example.com', 'a-long-password');
    db.db.exec('ALTER TABLE users DROP COLUMN email_verified_at');
    db.db.pragma('wal_checkpoint(TRUNCATE)');
  `], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, DB_PATH, JWT_SECRET: SECRET } });
  assert.strictEqual(prep.status, 0, `${prep.stdout}${prep.stderr}`);

  // --- no key, no transport: a silent no-op ---
  delete process.env.RESEND_API_KEY;
  const email = require('./email');
  assert.deepStrictEqual(await email.send({ to: 'x@example.com', subject: 's', text: 't' }), { skipped: true }, 'no-op while RESEND_API_KEY is unset');

  fs.writeFileSync(PRELOAD, `require(${JSON.stringify(path.join(__dirname, 'email.js'))})._setTransportForTests((m) => require('fs').appendFileSync(${JSON.stringify(OUTBOX)}, JSON.stringify(m) + '\\n'));`);
  child = spawn('node', ['-r', PRELOAD, 'server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: SECRET, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {} await wait(150); }

  const raw = new Database(DB_PATH, { readonly: true });
  const verifiedAt = (email) => raw.prepare('SELECT email_verified_at v FROM users WHERE email = ?').get(email).v;
  assert.ok(verifiedAt('old1@example.com') && verifiedAt('old2@example.com'), 'pre-existing accounts are marked verified by the migration');

  // --- signup: continues normally, one mail with a link ---
  const su = await json('POST', '/api/auth/signup', null, { email: 'New@Example.com', password: 'a-long-password', policyAcceptance: AGREE });
  assert.strictEqual(su.status, 200, JSON.stringify(su.body));
  assert.ok(su.body.token && su.body.needsGym, 'signup behaves as before');
  assert.strictEqual(su.body.user.emailVerified, false);
  for (let i = 0; i < 40 && outbox().length < 1; i++) await wait(50);
  const mails = outbox();
  assert.strictEqual(mails.length, 1, 'exactly one mail captured');
  assert.deepStrictEqual(mails[0].to, ['new@example.com']);
  assert.ok(mails[0].from.endsWith('<hello@mail.dibs.fit>') && mails[0].from.startsWith(config.appName), 'default sender');
  assert.ok(mails[0].subject.includes(config.appName) && mails[0].html.includes('Confirm your email'));
  assert.ok(mails[0].text.startsWith(`Your ${config.appName} account`), 'built from config.appName');
  const link = mails[0].text.match(/https?:\/\/\S+/)[0];
  assert.ok(link.startsWith(`${config.publicOrigin}/verify-email?token=`), `link: ${link.split('?')[0]}`);
  assert.strictEqual(config.publicOrigin, 'http://localhost:5173', 'dev links point at the Vite dev server');
  const token = tokenOf(mails[0]);

  // --- token stored hashed only ---
  const stored = raw.prepare("SELECT token_hash, purpose, expires_at, created_at, used_at FROM account_email_tokens WHERE purpose = 'verify'").all();
  assert.strictEqual(raw.prepare("SELECT COUNT(*) n FROM account_email_tokens WHERE purpose = 'not_me'").get().n, 1, 'signup also minted the not-me link');
  assert.ok(mails[0].text.includes('/not-me?token=') && !/reply/i.test(mails[0].text), 'not-me link, no reply instruction');
  assert.strictEqual(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(token), 'raw token is not in the DB');
  assert.strictEqual(stored[0].token_hash, require('crypto').createHash('sha256').update(token).digest('hex'));
  assert.strictEqual(stored[0].expires_at - stored[0].created_at, 30 * 60 * 1000, 'valid for 30 minutes');
  assert.strictEqual(verifiedAt('new@example.com'), null, 'new signups start unverified');
  const st = await json('GET', '/api/auth/status', su.body.token);
  assert.strictEqual(st.body.emailVerified, false);
  assert.strictEqual(st.body.email, 'new@example.com');

  // --- GET never consumes; garbage rejected ---
  await fetch(`${BASE}/verify-email?token=${token}`);
  assert.strictEqual(verifiedAt('new@example.com'), null, 'a GET of the landing path does not verify');
  for (const bad of ['', 'garbage', 'x'.repeat(43), null, 12345, { a: 1 }]) {
    const r = await json('POST', '/api/auth/verify-email', null, { token: bad });
    assert.strictEqual(r.status, 400, `rejects ${JSON.stringify(bad)}`);
  }

  // --- resend: supersedes the first token ---
  const rs = await json('POST', '/api/account/verify-email/resend', su.body.token);
  assert.deepStrictEqual(rs.body, { ok: true, sent: true });
  for (let i = 0; i < 40 && outbox().length < 2; i++) await wait(50);
  const token2 = tokenOf(outbox()[1]);
  assert.notStrictEqual(token2, token);
  assert.strictEqual((await json('POST', '/api/auth/verify-email', null, { token })).status, 400, 'older token was superseded');
  assert.strictEqual((await json('POST', '/api/account/verify-email/resend')).status, 401, 'resend needs auth');

  // --- verify consumes once ---
  const ok = await json('POST', '/api/auth/verify-email', null, { token: token2 });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(verifiedAt('new@example.com'));
  assert.strictEqual((await json('POST', '/api/auth/verify-email', null, { token: token2 })).status, 400, 'reuse rejected');
  assert.strictEqual((await json('GET', '/api/auth/status', su.body.token)).body.emailVerified, true);
  const again = await json('POST', '/api/account/verify-email/resend', su.body.token);
  assert.deepStrictEqual(again.body, { ok: true, alreadyVerified: true });
  assert.strictEqual(outbox().length, 2, 'no mail for an already-verified account');

  // --- resend rate limit: signup mail + 3 resends per hour, then 429 ---
  const su2 = await json('POST', '/api/auth/signup', null, { email: 'limit@example.com', password: 'a-long-password', policyAcceptance: AGREE });
  for (let i = 0; i < 3; i++) assert.strictEqual((await json('POST', '/api/account/verify-email/resend', su2.body.token)).status, 200);
  const limited = await json('POST', '/api/account/verify-email/resend', su2.body.token);
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.body.code, 'VERIFY_EMAIL_RATE_LIMITED');
  assert.strictEqual((await json('POST', '/api/account/verify-email/resend', su.body.token)).status, 200, 'limit is per account');

  raw.close();
  child.kill(); child = null;
}

// Expiry and replay straight against the module (own in-memory DB, controlled clock).
function moduleChecks() {
  const r = require('child_process').spawnSync(process.execPath, ['-e', `
    process.env.DB_PATH=':memory:'; process.env.ENCRYPTION_KEY=${JSON.stringify(process.env.ENCRYPTION_KEY)};
    const assert=require('assert'); const db=require('./db'); const t=require('./account-email-tokens');
    const uid=db.createAccount('m@example.com','a-long-password');
    const now=1_000_000;
    const a=t.issue(uid,'verify',{now});
    assert.strictEqual(t.consume(a.token,'reset',{now:now+1}),null,'wrong purpose');
    assert.strictEqual(t.consume(a.token,'verify',{now:now+30*60*1000}),null,'expired at 30 minutes');
    const b=t.issue(uid,'verify',{now});
    assert.deepStrictEqual(t.consume(b.token,'verify',{now:now+30*60*1000-1}),{userId:uid,newEmail:null},'valid just inside the window');
    assert.strictEqual(t.consume(b.token,'verify',{now:now+1}),null,'single use');
    const e=t.issue(uid,'email_change',{now,newEmail:'n@example.com'});
    t.issue(uid,'verify',{now});
    assert.deepStrictEqual(t.consume(e.token,'email_change',{now:now+5}),{userId:uid,newEmail:'n@example.com'},'purposes do not supersede each other; new_email returned');
    assert.strictEqual(t.countRecent(uid,'verify',now),3);
    db.db.prepare('DELETE FROM users WHERE id=?').run(uid);
    assert.strictEqual(db.db.prepare('SELECT COUNT(*) n FROM account_email_tokens').get().n,0,'tokens cascade with the account');
  `], { cwd: __dirname, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
}

run().then(() => { moduleChecks(); cleanup(); console.log('PASS account email: no-op, signup mail, hashed single-use tokens, resend limit, migration.'); })
  .catch((e) => { cleanup(); console.error(e); process.exit(1); });
