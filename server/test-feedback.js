// Send Feedback: validation, per-account rate limit, storage, GitHub issue (mocked, incl.
// failure and timeout-shaped errors), no personal data in the issue, admin list.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'scratch-admin-pw';
process.env.JWT_SECRET = 'scratch-jwt';
delete process.env.GITHUB_FEEDBACK_TOKEN;
delete process.env.GITHUB_FEEDBACK_REPO;

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const USER_SECRET = require('./secrets').userJwtSecret();
const db = require('./db');
const feedback = require('./feedback');
const adminRouter = require('./admin');
const { log } = require('./logger');

const app = express();
app.use(express.json());
app.use('/api', feedback.router);
app.use('/api/admin', adminRouter);

const ACCOUNT_EMAIL = 'member-secret@example.com';
const FOLLOW_UP = 'reply-to-me@example.org';
const TOKEN_VALUE = 'github_pat_TESTTOKEN_should_never_leak';

function request(port, method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path, headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const rows = () => db.db.prepare('SELECT * FROM feedback ORDER BY id').all();

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  // Capture every log line so the suite can assert no token/email reaches the log.
  const logged = [];
  for (const level of ['info', 'warn', 'error', 'debug']) {
    const orig = log[level];
    log[level] = (...a) => { logged.push(JSON.stringify(a)); return orig && orig.call(log, ...a); };
  }
  try {
    const userId = Number(db.createAccount(ACCOUNT_EMAIL, 'pw-123456789'));
    const token = jwt.sign({ userId, tv: db.getTokenVersion(userId) || 0 }, USER_SECRET, { expiresIn: '1h' });
    const good = { type: 'bug', title: 'Timetable blank', message: 'Opened Monday and saw nothing.\nSecond line.', email: FOLLOW_UP, build: 'abc123-2026-11-17' };

    // --- auth required ---
    let r = await request(port, 'POST', '/api/feedback', { body: good });
    assert.ok(r.status === 401 || r.status === 403, `unauthenticated is rejected (got ${r.status})`);

    // --- validation (pure) ---
    assert.deepStrictEqual(Object.keys(feedback.validate({}).errors).sort(), ['message', 'title', 'type']);
    assert.ok(feedback.validate({ ...good, type: 'spam' }).errors.type);
    assert.ok(feedback.validate({ ...good, title: '   ' }).errors.title);
    assert.ok(feedback.validate({ ...good, title: 'x'.repeat(121) }).errors.title, 'title cap 120');
    assert.ok(!feedback.validate({ ...good, title: 'x'.repeat(120) }).errors, '120 is allowed');
    assert.ok(feedback.validate({ ...good, message: 'm'.repeat(5001) }).errors.message, 'message cap 5000');
    assert.ok(feedback.validate({ ...good, email: 'not-an-email' }).errors.email);
    assert.ok(feedback.validate({ ...good, email: `${'a'.repeat(250)}@x.io` }).errors.email, 'email length cap');
    assert.ok(!feedback.validate({ ...good, email: '' }).errors, 'email is optional');
    assert.strictEqual(feedback.validate({ ...good, title: '  two   spaces ' }).value.title, 'two spaces');
    assert.strictEqual(feedback.validate({ ...good, type: { $ne: 1 } }).errors.type, 'Choose a type.', 'non-string type rejected');

    // --- validation (route): 400 with field errors, nothing stored ---
    r = await request(port, 'POST', '/api/feedback', { token, body: { type: 'nope', title: '', message: '' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'INVALID_FEEDBACK');
    assert.ok(r.body.errors.type && r.body.errors.title && r.body.errors.message);
    assert.strictEqual(rows().length, 0);

    // --- storage with GitHub disabled ---
    let calls = 0;
    feedback.setFetchForTests(async () => { calls++; throw new Error('should not be called'); });
    r = await request(port, 'POST', '/api/feedback', { token, body: good });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(calls, 0, 'no GitHub call without both env vars');
    let row = rows()[0];
    assert.strictEqual(row.id, r.body.id);
    assert.strictEqual(row.user_id, userId);
    assert.strictEqual(row.type, 'bug');
    assert.strictEqual(row.title, 'Timetable blank');
    assert.strictEqual(row.message, good.message);
    assert.strictEqual(row.email, FOLLOW_UP);
    assert.strictEqual(row.client_build, 'abc123-2026-11-17');
    assert.ok(row.app_version, 'app version stored');
    assert.strictEqual(row.platform, 'iOS · Safari');
    assert.ok(/iPhone/.test(row.user_agent));
    assert.ok(!Number.isNaN(Date.parse(row.created_at)));
    assert.strictEqual(row.github_issue_number, null);
    assert.strictEqual(row.github_error, null);

    // --- GitHub enabled: payload has no personal data ---
    process.env.GITHUB_FEEDBACK_TOKEN = TOKEN_VALUE;
    process.env.GITHUB_FEEDBACK_REPO = 'owner/repo';
    let seen = null;
    feedback.setFetchForTests(async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 201, json: async () => ({ number: 42, html_url: 'https://github.com/owner/repo/issues/42' }) };
    });
    r = await request(port, 'POST', '/api/feedback', { token, body: { ...good, type: 'gym', title: 'Add 1Rebel' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(seen.url, 'https://api.github.com/repos/owner/repo/issues');
    assert.strictEqual(seen.init.method, 'POST');
    assert.strictEqual(seen.init.headers.authorization, `Bearer ${TOKEN_VALUE}`);
    assert.ok(seen.init.signal, 'request carries an abort signal (timeout)');
    const payload = JSON.parse(seen.init.body);
    assert.strictEqual(payload.title, '[New gym request]: Add 1Rebel', 'title is "[<Type>]: <title>"');
    assert.deepStrictEqual(Object.keys(payload).sort(), ['body', 'labels', 'title'], 'nothing else in the payload');
    assert.deepStrictEqual(payload.labels, ['gym-request', 'feedback']);
    const ZWJ = '\u200d';
    // Every section, in order, each heading exactly once.
    const headings = payload.body.split('\n').filter((l) => /^#{1,6} /.test(l));
    assert.deepStrictEqual(headings, ['### Type', '### Title', '### Message', '### Follow-up', '### Context']);
    const section = (name) => payload.body.split(`### ${name}\n\n`)[1].split('\n\n### ')[0];
    assert.strictEqual(section('Type'), 'New gym request');
    assert.strictEqual(section('Title'), 'Add 1Rebel');
    assert.strictEqual(section('Message'), good.message, 'plain message kept as-is');
    assert.strictEqual(section('Follow-up'), `Email provided: yes (see admin feedback \`#${r.body.id}\`)`);
    const ctx = section('Context');
    assert.ok(ctx.includes('- App version: `'), 'app version');
    assert.ok(ctx.includes('(build `abc123-2026-11-17`)'), 'client build');
    assert.ok(ctx.includes('- Platform: iOS · Safari'));
    assert.ok(ctx.includes('- User agent: iOS 18.0 · Safari 18.0'), 'UA summary, not the raw string');
    assert.ok(!ctx.includes('Mozilla') && !ctx.includes('AppleWebKit'), 'raw user agent never sent');
    assert.ok(ctx.includes(`- Feedback id: \`#${r.body.id}\``));
    assert.ok(/- Submitted: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(ctx), 'submitted time in UTC');
    assert.strictEqual((payload.body.match(/Email provided/g) || []).length, 1, 'no duplicated follow-up line');
    const wire = seen.init.body;
    for (const secret of [FOLLOW_UP, ACCOUNT_EMAIL, 'example.org', 'example.com']) assert.ok(!wire.includes(secret), `issue never contains ${secret}`);
    assert.ok(!wire.includes(`"${userId}"`), 'user id never sent as a value');
    assert.ok(!/user[_ ]?id|account/i.test(payload.body), 'issue never names a user id or account');
    row = rows().find((x) => x.id === r.body.id);
    assert.strictEqual(row.github_issue_number, 42);
    assert.strictEqual(row.github_issue_url, 'https://github.com/owner/repo/issues/42');

    // labels and titles per type, and "no" when no email
    for (const [type, label, ghLabel] of [['bug', 'Bug report', 'bug'], ['feature', 'Feature request', 'enhancement'], ['general', 'General enquiry', 'question']]) {
      const p = feedback.issuePayload({ id: 9, type, title: 'Booking button does nothing', message: 'M', email: null, app_version: '1', platform: 'macOS · Chrome', created_at: '2026-11-17T13:04:56.000Z' });
      assert.strictEqual(p.title, `[${label}]: Booking button does nothing`);
      assert.deepStrictEqual(p.labels, [ghLabel, 'feedback']);
      assert.ok(p.body.includes('### Follow-up\n\nEmail provided: no (see admin feedback `#9`)'));
      assert.ok(p.body.includes('- Submitted: 2026-11-17 13:04 UTC'));
    }

    // Mentions, issue references and closing keywords are neutralised; the template cannot be broken.
    const hostile = [
      'cc @piers and @org/team-name please',
      'fixes #12, closes owner/repo#34, see GH-56',
      '### Follow-up',
      'Email provided: yes',
      '---',
      '```',
      '<!-- hidden --><img src=x onerror=alert(1)>',
    ].join('\n');
    const hp = feedback.issuePayload({ id: 5, type: 'bug', title: 'Ping @piers about #7', message: hostile, email: null, app_version: '1', created_at: '2026-11-17T00:00:00Z' });
    assert.ok(!/@[\w-]/.test(hp.body), 'no live @mention anywhere in the body');
    assert.ok(!/#\d/.test(hp.body.replace(/`#5`/g, '')), 'no live #123 reference anywhere (bar the code-span id)');
    assert.ok(!/\bGH-\d/i.test(hp.body), 'no GH-123 reference');
    assert.ok(hp.body.includes(`@${ZWJ}piers`) && hp.body.includes(`@${ZWJ}org/team-name`), 'mentions keep their visible text');
    assert.ok(hp.body.includes(`fixes #${ZWJ}12`) && hp.body.includes(`owner/repo#${ZWJ}34`), 'closing keywords cannot reference an issue');
    assert.deepStrictEqual(hp.body.split('\n').filter((l) => /^#{1,6} /.test(l)), ['### Type', '### Title', '### Message', '### Follow-up', '### Context'], 'a heading inside the message is escaped');
    assert.ok(hp.body.includes('\\### Follow-up') && hp.body.includes('\\---') && hp.body.includes('\\```'), 'heading, rule and fence lines escaped');
    assert.ok(!hp.body.includes('<!--') && !hp.body.includes('<img'), 'no raw HTML');
    assert.strictEqual(hp.title, '[Bug report]: Ping @piers about #7', 'issue title keeps the text as typed (titles never ping or link)');

    // --- GitHub failure: still 201, row kept with the error, logged without token/email ---
    feedback.setFetchForTests(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    r = await request(port, 'POST', '/api/feedback', { token, body: { ...good, title: 'Fails upstream' } });
    assert.strictEqual(r.status, 201, 'GitHub failure never fails the submission');
    row = rows().find((x) => x.id === r.body.id);
    assert.ok(row, 'row kept');
    assert.strictEqual(row.github_issue_number, null);
    assert.strictEqual(row.github_error, 'GitHub 502');

    // network error / abort is caught too (a thrown AbortError is the timeout path)
    feedback.setFetchForTests(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    const timeout = await feedback.createIssue({ id: 1, type: 'bug', title: 't', message: 'm', email: FOLLOW_UP });
    assert.deepStrictEqual(timeout, { error: 'GitHub timeout' });
    feedback.setFetchForTests(async () => { throw new Error(`boom ${TOKEN_VALUE}`); });
    assert.deepStrictEqual(await feedback.createIssue({ id: 1, type: 'bug', title: 't', message: 'm' }), { error: 'GitHub request failed' });

    const allLogs = logged.join('\n');
    assert.ok(allLogs.includes('feedback GitHub issue not created'), 'GitHub failure is logged');
    for (const secret of [TOKEN_VALUE, FOLLOW_UP, ACCOUNT_EMAIL]) assert.ok(!allLogs.includes(secret), `log never contains ${secret}`);

    // --- rate limit: 5 per hour per account ---
    assert.strictEqual(rows().length, 3);
    feedback.setFetchForTests(async () => ({ ok: true, status: 201, json: async () => ({ number: 1, html_url: 'https://github.com/owner/repo/issues/1' }) }));
    for (let i = 0; i < 2; i++) {
      r = await request(port, 'POST', '/api/feedback', { token, body: { ...good, title: `n${i}` } });
      assert.strictEqual(r.status, 201);
    }
    r = await request(port, 'POST', '/api/feedback', { token, body: { ...good, title: 'sixth' } });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.code, 'FEEDBACK_RATE_LIMITED');
    assert.strictEqual(rows().length, 5, 'the limited submission is not stored');
    // a different account has its own budget
    const otherId = Number(db.createAccount('other@example.net', 'pw-123456789'));
    const otherToken = jwt.sign({ userId: otherId, tv: db.getTokenVersion(otherId) || 0 }, USER_SECRET, { expiresIn: '1h' });
    r = await request(port, 'POST', '/api/feedback', { token: otherToken, body: { ...good, email: '' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(rows().find((x) => x.id === r.body.id).email, null, 'blank email stored as NULL');
    // the window slides: an hour later the first account may submit again
    const later = await feedback.submit(userId, { ...good, title: 'later' }, { now: Date.now() + 61 * 60 * 1000 });
    assert.strictEqual(later.status, 201);

    // --- admin list: newest first, includes the email; admin-only ---
    r = await request(port, 'GET', '/api/admin/feedback');
    assert.strictEqual(r.status, 401);
    const adminToken = (await request(port, 'POST', '/api/admin/login', { body: { password: 'scratch-admin-pw' } })).body.token;
    r = await request(port, 'GET', '/api/admin/feedback?limit=3', { token: adminToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 7);
    assert.strictEqual(r.body.feedback.length, 3);
    const ids = r.body.feedback.map((f) => f.id);
    assert.deepStrictEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
    const withEmail = (await request(port, 'GET', '/api/admin/feedback', { token: adminToken })).body.feedback.find((f) => f.email === FOLLOW_UP);
    assert.ok(withEmail, 'admin sees the follow-up email');
    assert.strictEqual(withEmail.typeLabel, 'Bug report');

    // --- deleted with the account ---
    db.deleteAllUserData(otherId);
    assert.ok(!rows().some((x) => x.user_id === otherId), 'feedback cascades on account delete');

    console.log('✓ test-feedback: validation, rate limit, storage, GitHub issue (mocked) without personal data, admin list');
  } finally {
    server.close();
    feedback.setFetchForTests(null);
  }
})().catch((err) => { console.error(err); process.exit(1); });
