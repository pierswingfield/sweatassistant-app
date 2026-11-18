// Mail copy for the "I did not create this account" flow: the signup mail and the one-off notice carry a
// /not-me link (14-day single-use token, hashed), and NO mail anywhere tells the reader to reply
// (hello@mail.dibs.fit is not monitored). In-process, in-memory DB, test transport: nothing is sent.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const crypto = require('crypto');
const dbm = require('./db');
const email = require('./email');
const tokens = require('./account-email-tokens');
const notice = require('./account-created-notice');

(async () => {
  const sent = [];
  email._setTransportForTests(async (m) => { sent.push(m); });
  const acct = dbm.createAccount('nm@example.com', 'a-long-password-1');
  const u = { id: typeof acct === 'object' ? acct.id : acct };

  // signup mail
  await email.issueAndSendVerification(u.id, 'nm@example.com', { welcome: true });
  const welcome = sent[0];
  const notMeUrl = welcome.text.match(/https?:\/\/\S*\/not-me\?token=\S+/)[0];
  assert.ok(/Didn't create this account\?/.test(welcome.text) && welcome.html.includes('/not-me?token='), 'link in text and html');
  const tok = new URL(notMeUrl).searchParams.get('token');
  const row = dbm.db.prepare("SELECT token_hash, expires_at, created_at FROM account_email_tokens WHERE purpose = 'not_me'").get();
  assert.strictEqual(row.token_hash, crypto.createHash('sha256').update(tok).digest('hex'), 'stored hashed');
  assert.strictEqual(row.expires_at - row.created_at, tokens.NOT_ME_TTL_MS);
  assert.strictEqual(tokens.NOT_ME_TTL_MS, 14 * 24 * 60 * 60 * 1000);

  // a later mail of the same purpose does not kill the earlier link
  const second = tokens.issue(u.id, 'not_me');
  assert.ok(tokens.peek(tok, 'not_me') && tokens.peek(second.token, 'not_me'), 'both links live');
  // expires after 14 days, not before
  assert.ok(tokens.peek(tok, 'not_me', { now: Date.now() + 13 * 86400000 }), 'alive on day 13');
  assert.strictEqual(tokens.peek(tok, 'not_me', { now: Date.now() + 15 * 86400000 }), null, 'dead on day 15');
  assert.strictEqual(tokens.consume(tok, 'reset'), null, 'purpose-bound');

  // verification resend has no not-me link; one-off notice does
  await email.issueAndSendVerification(u.id, 'nm@example.com');
  assert.ok(!sent[1].text.includes('/not-me'));
  const r = await notice.run({ since: '2000-01-01', send: true, sleep: async () => {}, gapMs: 0 });
  assert.strictEqual(r.sent, 1);
  const n = sent[sent.length - 1];
  assert.ok(n.text.includes('/not-me?token=') && n.html.includes('/not-me?token='));

  // every mail: no "reply" instruction anywhere
  await email.sendPasswordReset({ to: 'x@example.com', resetUrl: 'https://x/r' });
  await email.sendPasswordChanged({ to: 'x@example.com', helpUrl: 'https://x/h' });
  await email.sendEmailChangeConfirm({ to: 'x@example.com', confirmUrl: 'https://x/c' });
  await email.sendEmailChangeRequested({ to: 'x@example.com', maskedNew: 'a***@e***.com', helpUrl: 'https://x/h' });
  await email.sendEmailChanged({ to: 'x@example.com', maskedNew: 'a***@e***.com', helpUrl: 'https://x/h' });
  assert.ok(sent.length >= 8);
  for (const m of sent) assert.ok(!/\breply\b|\breplies\b.*to this|contact support/i.test(m.text.replace(/does not receive replies/, '')), `no reply instruction: ${m.subject}`);
  for (const m of sent.filter((x) => /Welcome|Your Dibs account|password was changed|email was changed/.test(x.subject))) {
    assert.ok(/Send Feedback/.test(m.text), `points to Send Feedback: ${m.subject}`);
  }
})().then(() => console.log('PASS not-me mail copy: link + 14-day hashed token, no reply instruction.'))
  .catch((e) => { console.error(e); process.exit(1); });
