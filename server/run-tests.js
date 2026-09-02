#!/usr/bin/env node
// Server test runner.
//
// The suites are standalone scripts rather than a framework, because they each
// boot db.js against an in-memory database and assert against it — a shared
// runner process would have them fighting over one schema. So this spawns each
// in its own process, which is also what makes DB_PATH=':memory:' safe.
//
// Discovery is by filename, deliberately: a new server/test-*.js is picked up
// with no registration step, so a suite cannot be silently left out of CI.

const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
}
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const files = readdirSync(__dirname)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  .sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`  ${f.replace(/^test-|\.js$/g, '').padEnd(26)} `);
  const res = spawnSync(process.execPath, [join(__dirname, f)], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0) {
    const last = out.trim().split('\n').filter(Boolean).pop() || '';
    console.log(`PASS  ${last.slice(0, 46)}`);
  } else {
    failed++;
    console.log('FAIL');
    for (const line of out.trim().split('\n').slice(-14)) console.log(`      ${line}`);
  }
}

console.log('');
if (failed) {
  console.error(`✗ ${failed}/${files.length} server suites FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${files.length}/${files.length} server suites passed.`);
