// Security audit part 2: JWT revocation (users.token_version), SSE tickets, admin
// secret separation, login timing parity. Boots the real server.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-revoke.db');
const SECRET = 'revoke-test-secret';
const ADMIN_PW = 'admin-pw-for-test';
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};
const json = (method, p, token, body, extra = {}) => fetch(`${BASE}${p}`, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function run() {
  cleanup();
  // Seed a LEGACY account (token_version 0, token signed with no `tv` claim) BEFORE boot,
  // exactly what a live prod DB looks like on deploy.
  process.env.DB_PATH = DB_PATH; process.env.JWT_SECRET = SECRET;
  const db = require('./db');
  const legacyId = db.createAccount('legacy@example.com', 'legacy-password-1');
  assert.strictEqual(db.getTokenVersion(legacyId), 0, 'a freshly created account starts at version 0');
  const legacyToken = jwt.sign({ userId: legacyId, email: 'legacy@example.com' }, SECRET, { expiresIn: '30d' });
  db.db.pragma('wal_checkpoint(TRUNCATE)');

  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: SECRET,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, ADMIN_PASSWORD: ADMIN_PW } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 150)); }

  // 1. Deploy does not log anyone out: an old token with no `tv` claim still works.
  assert.strictEqual((await json('GET', '/api/auth/status', legacyToken)).status, 200, 'legacy token (no tv) valid at version 0');

  // 2. Login issues a token carrying tv.
  const login = await json('POST', '/api/auth/login', null, { email: 'legacy@example.com', password: 'legacy-password-1' });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(jwt.decode(login.body.token).tv, 0, 'new tokens embed tv');
  const t0 = login.body.token;

  // 3. Self-service password change: old tokens (incl. the legacy one) die, the response carries a fresh one.
  const change = await json('POST', '/api/account/password', t0, { currentPassword: 'legacy-password-1', newPassword: 'brand-new-password-2' });
  assert.strictEqual(change.status, 200);
  assert.ok(change.body.token, 'password change returns a fresh token');
  assert.strictEqual((await json('GET', '/api/auth/status', change.body.token)).status, 200, 'fresh token works');
  assert.strictEqual((await json('GET', '/api/auth/status', t0)).status, 403, 'pre-change token rejected');
  assert.strictEqual((await json('GET', '/api/auth/status', legacyToken)).status, 403, 'legacy token (no tv) rejected after a bump');
  assert.strictEqual((await json('POST', '/api/auth/login', null, { email: 'legacy@example.com', password: 'brand-new-password-2' })).status, 200, 'new password logs in');

  // 4. Admin reset-password revokes too.
  const adminLogin = await json('POST', '/api/admin/login', null, { password: ADMIN_PW });
  assert.strictEqual(adminLogin.status, 200);
  const adminToken = adminLogin.body.token;
  const before = (await json('POST', '/api/auth/login', null, { email: 'legacy@example.com', password: 'brand-new-password-2' })).body.token;
  assert.strictEqual((await json('GET', '/api/auth/status', before)).status, 200);
  const reset = await json('POST', `/api/admin/users/${legacyId}/reset-password`, adminToken, {});
  assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));
  assert.strictEqual((await json('GET', '/api/auth/status', before)).status, 403, 'token rejected after admin reset');
  const after = (await json('POST', '/api/auth/login', null, { email: 'legacy@example.com', password: reset.body.tempPassword })).body.token;
  assert.strictEqual((await json('GET', '/api/auth/status', after)).status, 200, 'temp password issues a working token');

  // 5. Account deletion revokes (the row is gone).
  assert.strictEqual((await json('DELETE', '/api/auth/me', after)).status, 200);
  assert.strictEqual((await json('GET', '/api/auth/status', after)).status, 403, 'token rejected after account deletion');

  // 6. Admin secret is separate: a user-secret-signed admin token is refused, and a user token is not an admin.
  const forged = jwt.sign({ admin: true }, SECRET, { expiresIn: '1h' });
  assert.strictEqual((await json('GET', '/api/admin/users', forged)).status, 403, 'admin token signed with the user secret rejected');
  assert.strictEqual((await json('GET', '/api/admin/users', adminToken)).status, 200, 'real admin token accepted');
  assert.strictEqual((await json('GET', '/api/admin/users', t0)).status, 403, 'user token is not an admin');
  assert.strictEqual((await json('GET', '/api/auth/status', adminToken)).status, 403, 'admin token is not a user token');

  // 7. SSE tickets: single-use, short-lived, and the ticket (not the JWT) opens the stream.
  const sign = await json('POST', '/api/auth/signup', null, { email: 'sse@example.com', password: 'sse-password-3' });
  const ut = sign.body.token;
  assert.strictEqual((await json('POST', '/api/auth/sse-ticket', null)).status, 401, 'minting needs auth');
  const tk = await json('POST', '/api/auth/sse-ticket', ut);
  assert.strictEqual(tk.status, 200);
  assert.ok(tk.body.ticket.length >= 40 && tk.body.expiresInSec <= 60);
  const open = async (qs) => {
    const ctl = new AbortController();
    const r = await fetch(`${BASE}/api/auto-book/stream?${qs}`, { signal: ctl.signal });
    const status = r.status; ctl.abort(); return status;
  };
  assert.notStrictEqual(await open(`ticket=${tk.body.ticket}`), 403, 'ticket accepted');
  assert.strictEqual(await open(`ticket=${tk.body.ticket}`), 403, 'ticket is single use');
  assert.strictEqual(await open('ticket=garbage'), 403, 'unknown ticket rejected');
  assert.notStrictEqual(await open(`token=${ut}`), 403, 'legacy ?token= still works for one release');
  // a revoked JWT no longer opens the legacy path either
  await json('POST', '/api/account/password', ut, { currentPassword: 'sse-password-3', newPassword: 'sse-password-4' });
  assert.strictEqual(await open(`token=${ut}`), 403, 'revoked JWT rejected on the SSE legacy path');

  // 8. Login timing: an unknown email pays the same scrypt cost as a wrong password.
  const time = async (email) => { const t = process.hrtime.bigint(); await json('POST', '/api/auth/login', null, { email, password: 'whatever-123' }); return Number(process.hrtime.bigint() - t) / 1e6; };
  await time('warm@example.com');
  const unknown = Math.min(await time('nobody1@example.com'), await time('nobody2@example.com'), await time('nobody3@example.com'));
  const known = Math.min(await time('sse@example.com'), await time('sse@example.com'), await time('sse@example.com'));
  assert.ok(unknown > known * 0.5, `unknown-email login (${unknown.toFixed(1)}ms) is as slow as a real check (${known.toFixed(1)}ms)`);
  assert.ok(unknown > 5, 'unknown-email login runs a scrypt (>5ms)');

  console.log('token-revocation: all assertions passed');
}
run().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error(e); cleanup(); process.exit(1); });
