// C7-3 step 2 — structured JSON logging. Before: ~450 free-text console.* calls,
// no request log at all, and no way to count upstream /events calls from the logs.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { createLogger, requestLogger } = require('./logger');

const lines = [];
const mk = (level) => createLogger({ level, write: (_lvl, line) => lines.push(line) });

// 1. Level gating + shape
let log = mk('info');
log.debug('hidden'); log.info('shown', { userId: 5, gymId: 'g', durationMs: 12 });
assert.strictEqual(lines.length, 1);
let rec = JSON.parse(lines[0]);
assert.strictEqual(rec.level, 'info'); assert.strictEqual(rec.msg, 'shown');
assert.strictEqual(rec.userId, 5); assert.ok(!isNaN(Date.parse(rec.ts)));
lines.length = 0;
mk('debug').debug('visible'); assert.strictEqual(lines.length, 1);
lines.length = 0;
mk('error').warn('x'); assert.strictEqual(lines.length, 0);

// 2. Redaction + Error serialisation (message only, no stack) + child context
lines.length = 0; log = mk('info').child({ route: '/r' });
log.error('boom', { password: 'hunter2', headers: { authorization: 'Bearer abc' }, err: new Error('bad thing') });
rec = JSON.parse(lines[0]);
assert.strictEqual(rec.route, '/r'); assert.strictEqual(rec.err, 'bad thing');
assert.ok(!/hunter2|Bearer abc/.test(lines[0]));

// 3. Request log never leaks bodies, headers, tokens, query strings
(async () => {
  lines.length = 0;
  const app = express();
  app.use(express.json());
  app.use(requestLogger(mk('info')));
  app.use((req, _res, next) => { if (req.headers.authorization) req.userId = 42; next(); });
  app.post('/api/thing', (_req, res) => res.json({ ok: true }));
  app.get('/api/calendar/:token.ics', (_req, res) => res.send('x'));
  const server = app.listen(0);
  const port = server.address().port;
  const hit = (method, path, body) => new Promise((resolve) => {
    const r = http.request({ port, method, path, headers: { 'content-type': 'application/json', authorization: 'Bearer SECRETJWT' } }, (res) => { res.resume(); res.on('end', resolve); });
    if (body) r.write(JSON.stringify(body)); r.end();
  });
  await hit('POST', '/api/thing?token=QUERYSECRET&x=1', { password: 'BODYSECRET' });
  await hit('GET', '/api/calendar/CALTOKEN123.ics');
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(lines.length, 2);
  const all = lines.join('\n');
  for (const s of ['SECRETJWT', 'QUERYSECRET', 'BODYSECRET', 'CALTOKEN123', 'x=1']) assert.ok(!all.includes(s), `leaked ${s}`);
  const r1 = JSON.parse(lines[0]);
  assert.deepStrictEqual([r1.method, r1.path, r1.status, r1.userId], ['POST', '/api/thing', 200, 42]);
  assert.strictEqual(typeof r1.durationMs, 'number');
  console.log('test-logger: all checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
