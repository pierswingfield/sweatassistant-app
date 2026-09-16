// Regression coverage for QA-03: importing db.js must preserve a D4 account's
// intentional no-gym state, but still migrate a pre-D4 account into its proven
// default-gym link. Uses a disk DB and a genuine module reload, the failure mode
// observed on server restart / DB import.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const dbPath = path.join(os.tmpdir(), `backfill-user-gyms-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

function removeDbFiles() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${suffix}`)) fs.unlinkSync(`${dbPath}${suffix}`);
  }
}

function reloadDb(previous) {
  previous.db.close();
  delete require.cache[require.resolve('./db')];
  return require('./db');
}

try {
  removeDbFiles();
  let db = require('./db');

  const d4AccountId = db.createAccount('d4-gym-less@test.local', 'a-real-password');
  const legacyId = db.db.prepare(
    'INSERT INTO users (email, encrypted_password, priority) VALUES (?, ?, ?)'
  ).run('legacy-needs-backfill@test.local', 'legacy-encrypted-credential', 200).lastInsertRowid;

  assert.deepStrictEqual(db.getUserGyms(d4AccountId), [], 'precondition: D4 account has no gym');
  assert.deepStrictEqual(db.getUserGyms(legacyId), [], 'precondition: legacy row predates user_gyms');

  db = reloadDb(db);

  assert.deepStrictEqual(db.getUserGyms(d4AccountId), [],
    'D4 account stays gym-less after db.js reload/import');
  assert.strictEqual(db.hasAccountPassword(d4AccountId), true,
    'the D4 marker remains intact after reload');

  const legacyLinks = db.getUserGyms(legacyId);
  assert.strictEqual(legacyLinks.length, 1, 'a genuine legacy account is still backfilled');
  assert.strictEqual(legacyLinks[0].gym_id, 'psycle-london');
  assert.strictEqual(legacyLinks[0].gym_email, 'legacy-needs-backfill@test.local');
  assert.strictEqual(legacyLinks[0].encrypted_password, 'legacy-encrypted-credential');

  console.log('🎉 QA-03 backfill guard passed: D4 gym-less account preserved; legacy account backfilled.');
  db.db.close();
} finally {
  removeDbFiles();
}
