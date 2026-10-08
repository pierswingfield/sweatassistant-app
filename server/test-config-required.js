// PUBLIC_HOST and VAPID_EMAIL identify the deployment, so production must supply
// them (no invented default); dev/test fall back to inert localhost values.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const CONFIG = path.join(__dirname, 'config.js');
function load(env) {
  const clean = { PATH: process.env.PATH };
  return spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({h:c.publicHost,v:c.vapidEmail}))`],
    { env: { ...clean, ...env }, encoding: 'utf8' });
}

let n = 0;
function check(name, fn) { fn(); n += 1; console.log(`  ok  ${name}`); }

check('production without PUBLIC_HOST fails with a named error', () => {
  const r = load({ NODE_ENV: 'production', VAPID_EMAIL: 'mailto:a@b.co' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(/PUBLIC_HOST is required/.test(r.stderr), r.stderr);
});
check('production without VAPID_EMAIL fails with a named error', () => {
  const r = load({ NODE_ENV: 'production', PUBLIC_HOST: 'app.example.com' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(/VAPID_EMAIL is required/.test(r.stderr), r.stderr);
});
check('production with both set uses them verbatim', () => {
  const r = load({ NODE_ENV: 'production', PUBLIC_HOST: 'app.example.com', VAPID_EMAIL: 'mailto:ops@example.com' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { h: 'app.example.com', v: 'mailto:ops@example.com' });
});
check('non-production falls back to localhost, never a real domain', () => {
  const r = load({});
  assert.strictEqual(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.strictEqual(c.h, 'localhost');
  assert.ok(!/psycle|wingfield/.test(r.stdout));
});
check('a malformed VAPID_EMAIL is rejected', () => {
  const r = load({ VAPID_EMAIL: 'admin@example.com' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(/mailto:/.test(r.stderr));
});
console.log(`🎉 ${n}/${n} config-required checks passed.`);
