// "I did NOT create this account" (/not-me) + the pending change-of-address hint.
// Boots the REAL server (dev mode; mail, Cloudflare siteverify and GitHub are stubbed by a preload, so
// nothing leaves the machine) and a production-mode server for the 503 and the CSP scoping.
// Covers: preview never consumes; Turnstile failure rejected and leaves the link usable; success creates
// ONE request and ONE issue call carrying only the masked address; reuse rejected; a second link for the
// same account does not duplicate; expiry; GitHub failure never fails the request; admin list / delete /
// done; per-IP limit; production without a secret is 503; CSP Turnstile allowance on /not-me only;
// pending hint + cancel.
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
const DB_PATH = path.join(__dirname, 'test-not-me.db');
const SECRET = 'not-me-secret';
const PW = 'old-password-1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'not-me-'));
const LOG = path.join(TMP, 'calls.jsonl');
const FAIL_GH = path.join(TMP, 'fail-gh');
const PRELOAD = path.join(TMP, 'preload.js');
const children = new Set();
const cleanup = () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  fs.rmSync(TMP, { recursive: true, force: true });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (method, p, token, body, base = BASE) => fetch(`${base}${p}`, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const calls = (kind) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((c) => !kind || c.kind === kind);
const waitFor = async (kind, n) => { for (let i = 0; i < 60 && calls(kind).length < n; i++) await wait(50); return calls(kind); };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const GOOD = 'pass';

async function bootProd(extraEnv) {
  const pub = path.join(TMP, 'public');
  fs.mkdirSync(path.join(pub, 'policies'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>__APP_NAME__</title><script>var a = 1;</script>');
  fs.writeFileSync(path.join(pub, 'manifest.json'), '{"name":"__APP_NAME__"}');
  fs.writeFileSync(path.join(pub, 'sw.js'), '// sw');
  const port = 22000 + ((process.pid + Math.floor(Math.random() * 1000)) % 20000);
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: ':memory:', PUBLIC_DIR: pub, JWT_SECRET: 'prod-nm',
    ADMIN_PASSWORD: 'x', PUBLIC_HOST: 'app.test.example', VAPID_EMAIL: 'mailto:t@example.com',
    RESEND_API_KEY: '', TURNSTILE_SECRET_KEY: '', TURNSTILE_SITE_KEY: '', ...extraEnv } });
  children.add(child);
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/config`)).ok) break; } catch (_) {} await wait(150); }
  return { base, child };
}

async function run() {
  cleanup(); fs.mkdirSync(TMP, { recursive: true });
  const prep = spawnSync(process.execPath, ['-e', `
    const db = require('./db'); const tokens = require('./account-email-tokens');
    const out = {};
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'pend@example.com']) {
      const u = db.createAccount(e, '${PW}'); out[e] = typeof u === 'object' ? u.id : u;
    }
    out.tokA = tokens.issue(out['a@example.com'], 'not_me').token;
    out.tokA2 = tokens.issue(out['a@example.com'], 'not_me').token;
    out.tokB = tokens.issue(out['b@example.com'], 'not_me').token;
    out.tokC = tokens.issue(out['c@example.com'], 'not_me').token;
    out.tokD = tokens.issue(out['d@example.com'], 'not_me').token;
    db.db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(JSON.stringify(out));
  `], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, DB_PATH, JWT_SECRET: SECRET } });
  assert.strictEqual(prep.status, 0, `${prep.stdout}${prep.stderr}`);
  const P = JSON.parse(prep.stdout.trim().split('\n').pop());

  fs.writeFileSync(PRELOAD, `
    const fs = require('fs'); const LOG = ${JSON.stringify(LOG)}; const FAIL = ${JSON.stringify(FAIL_GH)};
    const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\\n');
    require(${JSON.stringify(path.join(__dirname, 'email.js'))})._setTransportForTests((m) => log({ kind: 'mail', to: m.to, text: m.text }));
    const realFetch = global.fetch; let n = 900;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/turnstile/v0/siteverify')) {
        const p = new URLSearchParams(opts.body);
        log({ kind: 'ts', response: p.get('response'), remoteip: p.get('remoteip'), hasSecret: !!p.get('secret') });
        return { ok: true, json: async () => ({ success: p.get('response') === 'pass' }) };
      }
      if (u.includes('api.github.com')) {
        log({ kind: 'gh', body: JSON.parse(opts.body), auth: !!(opts.headers || {}).authorization });
        if (fs.existsSync(FAIL)) return { ok: false, status: 500, json: async () => ({}) };
        n += 1; return { ok: true, json: async () => ({ number: n, html_url: 'https://github.com/o/r/issues/' + n }) };
      }
      return realFetch(url, opts);
    };`);
  const child = spawn('node', ['-r', PRELOAD, 'server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', RATE_LIMIT_TEST_FORCE: '1', JWT_SECRET: SECRET,
      ADMIN_PASSWORD: 'scratch-admin-pw', GITHUB_FEEDBACK_TOKEN: 'test-gh-token', GITHUB_FEEDBACK_REPO: 'o/r',
      RESEND_API_KEY: '', TURNSTILE_SECRET_KEY: '', TURNSTILE_SITE_KEY: '' } });
  children.add(child);
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {} await wait(150); }
  const raw = new Database(DB_PATH);
  const requests = () => raw.prepare('SELECT * FROM account_deletion_requests ORDER BY id').all();
  const used = (tok) => raw.prepare('SELECT used_at FROM account_email_tokens WHERE token_hash = ?').get(sha(tok)).used_at;

  // dev config: Cloudflare's always-pass test site key when none is set
  const cfg = await json('GET', '/api/config');
  assert.ok(cfg.body.turnstileSiteKey, 'dev falls back to the test site key');

  // --- preview: names the address, never consumes ---
  for (let i = 0; i < 2; i++) {
    const pv = await json('POST', '/api/auth/not-me/preview', null, { token: P.tokA });
    assert.strictEqual(pv.status, 200); assert.deepStrictEqual(pv.body, { email: 'a@example.com' });
  }
  assert.strictEqual(used(P.tokA), null, 'preview does not consume');
  assert.strictEqual((await json('POST', '/api/auth/not-me/preview', null, { token: 'z'.repeat(43) })).status, 400);
  assert.strictEqual((await json('POST', '/api/auth/not-me/preview', null, { token: P.tokA, junk: 1 })).status, 200);

  // --- Turnstile failure / missing is rejected and the link stays usable ---
  let r = await json('POST', '/api/auth/not-me', null, { token: P.tokA, turnstileToken: 'fail' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'TURNSTILE_FAILED');
  r = await json('POST', '/api/auth/not-me', null, { token: P.tokA });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(used(P.tokA), null, 'failed check leaves the token unspent');
  assert.strictEqual(requests().length, 0); assert.strictEqual(calls('gh').length, 0);

  // --- success: one request, one issue, masked address only ---
  r = await json('POST', '/api/auth/not-me', null, { token: P.tokA, turnstileToken: GOOD });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { ok: true });
  const ts = calls('ts').filter((c) => c.response === GOOD);
  assert.ok(ts[0].hasSecret && ts[0].remoteip, 'siteverify got a secret and the client IP');
  let gh = await waitFor('gh', 1);
  assert.strictEqual(gh.length, 1);
  assert.strictEqual(gh[0].body.title, `[User data]: deletion request #${requests()[0].id}`);
  assert.deepStrictEqual(gh[0].body.labels, ['user-data-urgent']);
  const ghText = JSON.stringify(gh[0].body);
  assert.ok(ghText.includes('a***@example.com') && ghText.includes('/admin'));
  assert.ok(!ghText.includes('a@example.com') && !ghText.includes(`"user_id"`), 'full address never reaches the issue');
  assert.strictEqual(requests().length, 1);
  const row = requests()[0];
  assert.deepStrictEqual([row.email, row.source, row.status, row.user_id], ['a@example.com', 'not_me', 'open', P['a@example.com']]);
  assert.ok(Object.keys(row).every((k) => !/ip/i.test(k)), 'no IP column');
  await wait(200);
  assert.strictEqual(requests()[0].github_issue_number, 901, 'issue number recorded');

  // --- reuse rejected; a second link for the same account does not duplicate ---
  assert.strictEqual((await json('POST', '/api/auth/not-me', null, { token: P.tokA, turnstileToken: GOOD })).status, 400, 'single use');
  assert.strictEqual((await json('POST', '/api/auth/not-me/preview', null, { token: P.tokA })).status, 400, 'spent token no longer previews');
  r = await json('POST', '/api/auth/not-me', null, { token: P.tokA2, turnstileToken: GOOD });
  assert.strictEqual(r.status, 200);
  await wait(300);
  assert.strictEqual(requests().length, 1, 'idempotent per account');
  assert.strictEqual(calls('gh').length, 1, 'no second issue');

  // --- expiry ---
  raw.prepare('UPDATE account_email_tokens SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, sha(P.tokB));
  assert.strictEqual((await json('POST', '/api/auth/not-me/preview', null, { token: P.tokB })).status, 400);
  assert.strictEqual((await json('POST', '/api/auth/not-me', null, { token: P.tokB, turnstileToken: GOOD })).status, 400, 'expired');
  const life = raw.prepare("SELECT expires_at - created_at AS d FROM account_email_tokens WHERE token_hash = ?").get(sha(P.tokC)).d;
  assert.strictEqual(life, 14 * 24 * 60 * 60 * 1000, 'not_me lives 14 days');
  assert.strictEqual(requests().length, 1);

  // --- GitHub failing never fails the request ---
  fs.writeFileSync(FAIL_GH, '1');
  r = await json('POST', '/api/auth/not-me', null, { token: P.tokC, turnstileToken: GOOD });
  assert.strictEqual(r.status, 200);
  await wait(400);
  assert.strictEqual(requests().length, 2);
  assert.strictEqual(requests()[1].github_error, 'GitHub 500'); fs.unlinkSync(FAIL_GH);

  // --- admin: list (full address), delete account, mark done ---
  const adm = await json('POST', '/api/admin/login', null, { password: 'scratch-admin-pw' });
  assert.strictEqual(adm.status, 200);
  const A = adm.body.token;
  assert.strictEqual((await json('GET', '/api/admin/deletion-requests')).status, 401);
  const list = (await json('GET', '/api/admin/deletion-requests', A)).body.requests;
  assert.deepStrictEqual(list.map((x) => x.email).sort(), ['a@example.com', 'c@example.com']);
  const idA = list.find((x) => x.email === 'a@example.com').id;
  assert.strictEqual((await json('POST', `/api/admin/deletion-requests/${idA}/delete-account`, A)).status, 200);
  assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('a@example.com').n, 0, 'account deleted');
  const doneA = raw.prepare('SELECT * FROM account_deletion_requests WHERE id = ?').get(idA);
  assert.deepStrictEqual([doneA.status, doneA.email, doneA.user_id], ['done', 'a***@example.com', null], 'done, address masked, user link cleared');
  assert.ok(raw.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action = 'user.delete'").get().n >= 1, 'delete is audit-logged');
  const idC = list.find((x) => x.email === 'c@example.com').id;
  assert.strictEqual((await json('POST', `/api/admin/deletion-requests/${idC}/done`, A)).status, 200);
  assert.strictEqual(raw.prepare('SELECT status FROM account_deletion_requests WHERE id = ?').get(idC).status, 'done');
  assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('c@example.com').n, 1, 'Mark done alone keeps the account');
  assert.strictEqual((await json('POST', '/api/admin/deletion-requests/99999/done', A)).status, 404);

  // --- pending change-of-address hint and cancel ---
  const login = await json('POST', '/api/auth/login', null, { email: 'pend@example.com', password: PW });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  const U = login.body.token;
  assert.strictEqual((await json('GET', '/api/account/email/pending')).status, 401, 'auth required');
  assert.deepStrictEqual((await json('GET', '/api/account/email/pending', U)).body, { pending: null });
  assert.strictEqual((await json('POST', '/api/account/email', U, { newEmail: 'Next@Example.com', password: PW })).status, 200);
  const pend = (await json('GET', '/api/account/email/pending', U)).body.pending;
  assert.strictEqual(pend.newEmail, 'next@example.com'); assert.ok(pend.expiresAt > Date.now());
  const mailed = (await waitFor('mail', 1)).find((m) => m.to.includes('next@example.com'));
  const changeTok = new URL(mailed.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  assert.strictEqual((await json('DELETE', '/api/account/email/pending', U)).status, 200);
  assert.deepStrictEqual((await json('GET', '/api/account/email/pending', U)).body, { pending: null });
  assert.strictEqual((await json('POST', '/api/auth/confirm-email', null, { token: changeTok })).status, 400, 'cancelled link is dead');
  assert.strictEqual(raw.prepare('SELECT email FROM users WHERE id = ?').get(P['pend@example.com']).email, 'pend@example.com', 'email unchanged');
  await json('POST', '/api/account/email', U, { newEmail: 'later@example.com', password: PW });
  raw.prepare("UPDATE account_email_tokens SET expires_at = ? WHERE purpose = 'email_change' AND used_at IS NULL").run(Date.now() - 1);
  assert.deepStrictEqual((await json('GET', '/api/account/email/pending', U)).body, { pending: null }, 'expired change is not shown');

  // --- per-IP limit (shared by preview and submit) ---
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await json('POST', '/api/auth/not-me/preview', null, { token: 'z'.repeat(43) })).status === 429) limited++;
  assert.ok(limited > 0, 'not-me is IP rate limited');
  raw.close(); child.kill();

  // --- production, no Turnstile secret: feature unavailable ---
  let prod = await bootProd({});
  assert.strictEqual((await json('GET', '/api/config', null, null, prod.base)).body.turnstileSiteKey, null);
  const off = await json('POST', '/api/auth/not-me', null, { token: 'z'.repeat(43), turnstileToken: GOOD }, prod.base);
  assert.strictEqual(off.status, 503); assert.strictEqual(off.body.code, 'NOT_ME_UNAVAILABLE');
  prod.child.kill();
  // secret without a site key is still unavailable
  prod = await bootProd({ TURNSTILE_SECRET_KEY: 'prod-secret' });
  assert.strictEqual((await json('GET', '/api/config', null, null, prod.base)).body.turnstileSiteKey, null);
  prod.child.kill();

  // --- production, configured: CSP allows Turnstile on /not-me ONLY ---
  prod = await bootProd({ TURNSTILE_SECRET_KEY: 'prod-secret', TURNSTILE_SITE_KEY: '0xPUBLICSITEKEY' });
  assert.strictEqual((await json('GET', '/api/config', null, null, prod.base)).body.turnstileSiteKey, '0xPUBLICSITEKEY');
  const page = await fetch(`${prod.base}/not-me?token=${'a'.repeat(43)}`);
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  const csp = Object.fromEntries(page.headers.get('content-security-policy').split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
  assert.ok(csp['script-src'].includes('https://challenges.cloudflare.com') && !csp['script-src'].includes("'unsafe-inline'"));
  assert.deepStrictEqual(csp['frame-src'], ['https://challenges.cloudflare.com']);
  assert.ok(!csp['connect-src'].includes('https://challenges.cloudflare.com'), 'nothing else widened');
  assert.ok(csp['script-src'].some((s) => s.startsWith("'sha256-")), 'inline script hashes still present');
  for (const other of ['/reset-password', '/verify-email', '/confirm-email', '/settings']) {
    const o = await fetch(`${prod.base}${other}`);
    const c = o.headers.get('content-security-policy');
    assert.ok(!c.includes('challenges.cloudflare.com') && c.includes("frame-src 'none'"), `${other} keeps the strict CSP`);
  }
  prod.child.kill();
}

run().then(() => { cleanup(); console.log('PASS not-me: preview, Turnstile, one request + one masked issue, reuse/expiry, admin, 503, CSP scope, pending hint.'); })
  .catch((e) => { cleanup(); console.error(e); process.exit(1); });
