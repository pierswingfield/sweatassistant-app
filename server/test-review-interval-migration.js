const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-migration-'));
const env = { ...process.env, DB_PATH: path.join(dir, 'legacy.db'), ENCRYPTION_KEY: 'a'.repeat(64) };
const run = code => execFileSync(process.execPath, ['-e', code], { cwd: __dirname, env, stdio: 'pipe' });
try {
  run(`const db=require('./db'); const u=require('./testkit').createUser(db,'legacy@test.local','enc'); db.db.prepare("UPDATE user_gyms SET account_enabled_at='2030-01-01T11:00:00.000Z', account_enabled_queue_cutoff=10 WHERE user_id=?").run(u); db.db.exec('DROP TABLE gym_disabled_intervals');`);
  run(`const assert=require('assert'); const db=require('./db'); const row=db.db.prepare('SELECT * FROM gym_disabled_intervals').get(); assert.equal(row.queue_cutoff,10); assert.equal(row.enabled_at,'2030-01-01T11:00:00.000Z'); assert(db.getUserById(row.user_id));`);
  console.log('Existing database interval migration passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
