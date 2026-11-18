// Step 4: the one-off "account created" service notice. In-process, in-memory DB, email.js
// test transport (nothing is ever sent).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const dbm = require('./db');
const email = require('./email');
const notice = require('./account-created-notice');

(async () => {
  const mk = (addr, created) => {
    const u = dbm.createAccount(addr, 'a-long-password-1');
    dbm.db.prepare('UPDATE users SET created_at = ? WHERE email = ?').run(created, addr);
    return u;
  };
  mk('old@example.com', '2026-09-01 10:00:00');
  mk('a@example.com', '2026-10-05 10:00:00');
  mk('b@example.com', '2026-10-20 23:59:59');
  mk('c@example.com', '2026-11-10 08:00:00');
  const sent = [];
  let failWith = null;
  email._setTransportForTests(async (m) => { if (failWith) throw new Error(failWith); sent.push(m); });
  const fast = { sleep: async () => {}, gapMs: 0 };

  // dry run sends nothing, writes nothing, masks addresses
  let r = await notice.run({ since: '2026-10-01' });
  assert.strictEqual(r.mode, 'dry-run'); assert.strictEqual(r.matched, 3); assert.strictEqual(sent.length, 0);
  assert(r.preview.every((p) => !p.to.includes('example.com') || p.to.includes('***')));
  assert.strictEqual(dbm.db.prepare('SELECT COUNT(*) c FROM sent_notifications').get().c, 0);

  // --send needs --since; bad dates refused
  r = await notice.run({ send: true }); assert(r.refused && /since/.test(r.refused)); assert.strictEqual(sent.length, 0);
  r = await notice.run({ send: true, since: 'yesterday' }); assert(r.refused); assert.strictEqual(sent.length, 0);

  // date filter (until inclusive of the whole day) and --only
  assert.strictEqual((await notice.run({ since: '2026-10-01', until: '2026-10-20' })).matched, 2);
  assert.strictEqual((await notice.run({ since: '2026-10-21' })).matched, 1);
  assert.strictEqual((await notice.run({ since: '2026-10-01', only: 'C@example.com' })).matched, 1);

  // cap: refuses before sending anything
  r = await notice.run({ send: true, since: '2026-10-01', max: 2, ...fast });
  assert(r.refused && /max/.test(r.refused)); assert.strictEqual(sent.length, 0);

  // real send: neutral content, idempotency key, ledger
  r = await notice.run({ send: true, since: '2026-10-01', ...fast });
  assert.strictEqual(r.sent, 3); assert.strictEqual(sent.length, 3);
  const m = sent[0];
  assert(/account has been created/.test(m.text) && m.text.includes('/reset-password') && m.text.includes('/not-me?token=') && !/reset-password\?token=/.test(m.text));
  assert(!/reply/i.test(m.text + m.html), 'no reply instruction: the sender address is not monitored');
  assert(m.idempotencyKey.startsWith('account-created-notice-v1-'));
  assert(!/promo|offer|discount|new feature/i.test(m.text));

  // re-run mails nobody
  r = await notice.run({ send: true, since: '2026-10-01', ...fast });
  assert.strictEqual(r.matched, 0); assert.strictEqual(r.sent, 0); assert.strictEqual(sent.length, 3);

  // repeated errors stop the run and record nothing
  mk('d@example.com', '2026-11-11 08:00:00'); mk('e@example.com', '2026-11-11 09:00:00');
  mk('f@example.com', '2026-11-11 10:00:00'); mk('g@example.com', '2026-11-11 11:00:00');
  failWith = 'boom';
  r = await notice.run({ send: true, since: '2026-11-11', ...fast });
  assert.strictEqual(r.failed, 3); assert(/consecutive/.test(r.aborted)); assert.strictEqual(r.sent, 0);
  assert.strictEqual(notice.candidates({ since: '2026-11-11' }).length, 4);

  // CLI: refuses --send without --since (exit 2), nothing sent
  email._setTransportForTests(null);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'send-account-created-notice.js'), '--send'],
    { encoding: 'utf8', env: { ...process.env, DB_PATH: ':memory:', RESEND_API_KEY: '' } });
  assert.strictEqual(cli.status, 2); assert(/REFUSED/.test(cli.stderr));
  console.log('account-created-notice: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
