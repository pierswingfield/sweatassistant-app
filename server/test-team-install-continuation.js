// Invite intent crosses an install through a short-lived, single-use bearer, never
// through an account or a membership mutation. Public previews reveal name/emoji only.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dbm = require('./db');
const teams = require('./teams');
const { router } = require('./teams-routes');
const { createLogger, requestLogger } = require('./logger');
const { db } = dbm;

let now = Date.parse('2026-11-12T10:00:00Z');
teams.__setNow(() => now);
const owner = db.prepare("INSERT INTO users (email, encrypted_password) VALUES ('install@test.local', '')").run().lastInsertRowid;
dbm.setUserSettings(owner, { firstName: 'Install' });
const { team, inviteToken } = teams.createTeam(owner, { name: 'Install Crew', emoji: '🚴' });
const app = express();
app.use(express.json());
const logs = [];
app.use(requestLogger(createLogger({ level: 'debug', write: (_level, line) => logs.push(line) })));
app.use('/api', router);

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path) => {
    const res = await fetch(`${base}${path}`, { method });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* a missing route may be HTML */ }
    return { status: res.status, headers: res.headers, body };
  };
  try {
    const capacity = teams.INSTALL_CONTINUATION_LIMIT;
    assert.ok(Number.isInteger(capacity) && capacity > 0);
    const insert = db.prepare('INSERT INTO team_install_continuations (continuation_hash, team_id, invite_token_hash, expires_at) VALUES (?, ?, ?, ?)');
    const inviteHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
    db.transaction(() => { for (let i = 0; i < capacity; i++) insert.run(`capacity-${i}`, team.id, inviteHash, now + 60000); })();
    const dummy = teams.createInitialInstallContinuation(inviteToken);
    assert.match(dummy, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM team_install_continuations').get().c, capacity);
    assert.equal(teams.consumeInstallContinuation(dummy).inviteToken, null);
    assert.throws(() => teams.createInstallContinuation(inviteToken), (e) => e.code === 'CONTINUATION_CAPACITY');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM team_install_continuations').get().c, capacity);
    db.prepare('UPDATE team_install_continuations SET expires_at = ? WHERE continuation_hash = ?').run(now, 'capacity-0');
    const allocated = teams.createInitialInstallContinuation(inviteToken);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM team_install_continuations').get().c, capacity);
    assert.equal(teams.consumeInstallContinuation(allocated).inviteToken, inviteToken);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM team_install_continuations').get().c, capacity - 1);
    db.prepare("DELETE FROM team_install_continuations WHERE continuation_hash LIKE 'capacity-%'").run();
    console.log('PASS capacity fails closed without evicting live handoffs and prunes expiry');
    const preview = await call('GET', `/api/teams/invite/${inviteToken}/preview`);
    assert.strictEqual(preview.status, 200, 'signed-out Team preview must be public');
    assert.deepStrictEqual(preview.body, { name: 'Install Crew', emoji: '🚴' });
    assert.match(preview.headers.get('cache-control'), /no-store/);
    console.log('PASS public preview exposes only name and emoji, without authentication');

    const issue = await call('POST', `/api/teams/invite/${inviteToken}/continuation`);
    assert.strictEqual(issue.status, 201);
    const { continuation, manifestUrl } = issue.body;
    assert.match(continuation, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(Buffer.from(continuation, 'base64url').length, 32);
    const rows = db.prepare('SELECT * FROM team_install_continuations').all();
    assert.strictEqual(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(continuation));
    assert.ok(!JSON.stringify(rows).includes(inviteToken));
    assert.strictEqual(rows[0].continuation_hash, crypto.createHash('sha256').update(continuation).digest('hex'));

    const manifest = await call('GET', manifestUrl);
    assert.strictEqual(manifest.status, 200);
    assert.strictEqual(manifest.body.id, '/');
    assert.strictEqual(manifest.body.scope, '/');
    assert.strictEqual(manifest.body.name, require('./config').appName);
    assert.strictEqual(manifest.body.start_url, `/?teamContinuation=${continuation}`);
    assert.ok(!JSON.stringify(manifest.body).includes(inviteToken));
    assert.match(manifest.headers.get('cache-control'), /no-store/);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    console.log('PASS install manifest keeps stable identity, root scope, and opaque start URL');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-continuation-'));
    try {
      const file = path.join(directory, 'saved.db');
      await db.backup(file);
      const program = `const teams = require('./teams'); teams.__setNow(() => Number(process.env.TEST_NOW)); console.log(JSON.stringify(teams.consumeInstallContinuation(process.env.TEST_CONTINUATION)))`;
      const env = { ...process.env, DB_PATH: file, TEST_CONTINUATION: continuation, TEST_NOW: String(now) };
      for (const expected of [inviteToken, null]) {
        const child = spawnSync(process.execPath, ['-e', program], { cwd: __dirname, env, encoding: 'utf8' });
        assert.strictEqual(child.status, 0, child.stderr);
        assert.deepStrictEqual(JSON.parse(child.stdout.trim().split('\n').pop()), { inviteToken: expected });
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    console.log('PASS continuation survives server restart and stays consumed after another restart');

    const take = () => call('POST', `/api/teams/continuation/${continuation}`);
    assert.strictEqual((await call('GET', `/api/teams/continuation/${continuation}`)).status, 404, 'prefetching cannot consume intent');
    const pair = await Promise.all([take(), take()]);
    assert.deepStrictEqual(pair.map((r) => r.body.inviteToken).sort(), [null, inviteToken].sort());
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM team_join_requests').get().c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM team_members').get().c, 1);
    const staleManifest = await call('GET', manifestUrl);
    assert.strictEqual(staleManifest.body.start_url, '/');
    console.log('PASS concurrent redemption consumes once, replays silently ignored, no joining');

    const expired = teams.createInstallContinuation(inviteToken).continuation;
    now += teams.INSTALL_CONTINUATION_TTL_MS;
    assert.deepStrictEqual(teams.consumeInstallContinuation(expired), { inviteToken: null });
    assert.deepStrictEqual(teams.consumeInstallContinuation('invalid'), { inviteToken: null });
    const rotated = teams.createInstallContinuation(inviteToken).continuation;
    const nextToken = teams.rotateInvite(owner, team.id).inviteToken;
    assert.deepStrictEqual(teams.consumeInstallContinuation(rotated), { inviteToken: null });
    const disabled = teams.createInstallContinuation(nextToken).continuation;
    teams.setInviteEnabled(owner, team.id, false);
    assert.deepStrictEqual(teams.consumeInstallContinuation(disabled), { inviteToken: null });
    assert.strictEqual((await call('GET', `/api/teams/invite/${nextToken}/preview`)).status, 404);
    console.log('PASS expiry, malformed, rotated, and disabled continuations reveal no invite');

    assert.ok(!logs.join('\n').includes(inviteToken), 'invite token reached logs');
    assert.ok(!logs.join('\n').includes(continuation), 'continuation token reached logs');
    assert.ok(logs.some((line) => line.includes('/api/teams/continuation/:token')), 'redaction test must capture redemption requests');
    assert.ok(logs.some((line) => line.includes('/api/teams/install-manifest/:token')), 'redaction test must capture manifest requests');
    console.log('PASS request logs redact invite and continuation tokens');

    process.env.RATE_LIMIT_TEST_FORCE = '1';
    const paths = [
      ['GET', `/api/teams/invite/${nextToken}/preview`],
      ['GET', manifestUrl],
      ['POST', `/api/teams/continuation/${continuation}`],
      ['POST', `/api/teams/invite/${nextToken}/continuation`],
    ];
    for (let i = 0; i < 120; i++) assert.notStrictEqual((await call(...paths[i % paths.length])).status, 429);
    assert.strictEqual((await call(...paths[0])).status, 429);
    console.log('PASS public preview, issuance, manifest and redemption share the IP rate limit');
    console.log('7/7 Team install continuation checks passed');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
