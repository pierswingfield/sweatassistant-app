// C7-3 step 1 — admin actions must leave a durable audit record.
// Before: admin.js only console.log'd a password reset; nothing else was recorded.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'scratch-admin-pw';
process.env.JWT_SECRET = 'scratch-jwt';

const assert = require('assert');
const http = require('http');
const express = require('express');
const db = require('./db');
const testkit = require('./testkit');
const adminRouter = require('./admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

function call(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path, headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : {} }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const bad = await call(port, 'POST', '/api/admin/login', { password: 'nope-SECRETVALUE' });
    assert.strictEqual(bad.status, 401);
    const ok = await call(port, 'POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD });
    const token = ok.json.token;
    assert.ok(token);

    const uid = testkit.createUser(db, 'audit-target@test.local', 'enc:pw');
    assert.strictEqual((await call(port, 'PUT', `/api/admin/users/${uid}/priority`, { priority: 7 }, token)).status, 200);
    const reset = await call(port, 'POST', `/api/admin/users/${uid}/reset-password`, {}, token);
    assert.strictEqual(reset.status, 200);
    assert.strictEqual((await call(port, 'POST', `/api/admin/users/${uid}/link-gym`, { gymId: 'jab-boxing' }, token)).status, 200);
    assert.strictEqual((await call(port, 'DELETE', `/api/admin/users/${uid}`, null, token)).status, 200);

    const audit = await call(port, 'GET', '/api/admin/audit?limit=100', null, token);
    assert.strictEqual(audit.status, 200);
    const actions = audit.json.entries.map((e) => e.action);
    for (const a of ['login.failure', 'login.success', 'user.priority', 'user.reset-password', 'user.link-gym', 'user.delete']) {
      assert.ok(actions.includes(a), `missing audit action ${a}; got ${actions}`);
    }
    assert.strictEqual(actions[0], 'user.delete', 'newest first');
    const pri = audit.json.entries.find((e) => e.action === 'user.priority');
    assert.strictEqual(pri.target_user_id, uid);
    assert.strictEqual(pri.detail.priority, 7);

    // Never any secret material, anywhere in the stored rows.
    const raw = JSON.stringify(db.db.prepare('SELECT * FROM admin_audit_log').all());
    for (const secret of [reset.json.tempPassword, token, 'nope-SECRETVALUE', process.env.ADMIN_PASSWORD]) {
      assert.ok(!raw.includes(secret), 'audit log leaked a secret');
    }

    // Pagination and cap, and auth gating.
    const page = await call(port, 'GET', '/api/admin/audit?limit=2&offset=1', null, token);
    assert.strictEqual(page.json.entries.length, 2);
    const huge = await call(port, 'GET', '/api/admin/audit?limit=999999', null, token);
    assert.ok(huge.json.entries.length <= 500);
    assert.strictEqual((await call(port, 'GET', '/api/admin/audit')).status, 401);

    // Redaction backstop in the helper itself.
    db.recordAdminAudit({ action: 'test', detail: { password: 'hunter2', nested: { token: 'abc' }, ok: 1 } });
    const last = db.listAdminAudit({ limit: 1 })[0];
    assert.strictEqual(last.detail.ok, 1);
    assert.ok(!JSON.stringify(last.detail).includes('hunter2') && !JSON.stringify(last.detail).includes('abc'));

    console.log('test-admin-audit: all checks passed');
  } catch (e) {
    console.error('FAIL', e.message); process.exitCode = 1;
  } finally { server.close(); }
})();
