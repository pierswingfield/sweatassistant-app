// email.js sends Reply-To (reply_to) on the Resend payload; EMAIL_REPLY_TO overrides, empty disables.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

if (process.argv[2] === 'child') {
  process.env.RESEND_API_KEY = 'test-key-not-real';
  let body = null;
  global.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return { ok: true }; };
  const email = require('./email');
  email.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' }).then((r) => {
    assert.strictEqual(r.ok, true);
    console.log(JSON.stringify({ replyTo: body.reply_to, has: 'reply_to' in body }));
  });
} else {
  const run = (env) => {
    const e = { ...process.env, ...env };
    if (env.EMAIL_REPLY_TO === undefined) delete e.EMAIL_REPLY_TO;
    const r = spawnSync(process.execPath, [__filename, 'child'], { env: e, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  assert.strictEqual(run({}).replyTo, 'hello@dibs.fit', 'default Reply-To');
  assert.strictEqual(run({ EMAIL_REPLY_TO: 'x@example.com' }).replyTo, 'x@example.com', 'override');
  assert.strictEqual(run({ EMAIL_REPLY_TO: '' }).has, false, 'empty disables');
  console.log('PASS email Reply-To: default, override, disabled.');
}
