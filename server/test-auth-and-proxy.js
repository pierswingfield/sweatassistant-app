const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Set mock environment variables for test
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex characters (32 bytes)
process.env.DB_PATH = path.join(__dirname, 'test-sqlite.db');

// Clean up old test database if it exists
if (fs.existsSync(process.env.DB_PATH)) {
  fs.unlinkSync(process.env.DB_PATH);
}

const db = require('./db');
const testkit = require('./testkit');
const crypto = require('./crypto');
const scheduler = require('./scheduler');

console.log('--- PSYCLE SERVER TEST SUITE ---');

// Test 1: Cryptography
try {
  console.log('Running Test 1: Cryptography (AES-256-GCM)...');
  const password = 'my-secure-psycle-password-123!';
  const encrypted = crypto.encrypt(password);
  
  assert.ok(encrypted, 'Encryption output should not be null');
  assert.notStrictEqual(encrypted, password, 'Encrypted output should not match plaintext');
  assert.strictEqual(encrypted.split(':').length, 3, 'Encrypted output format should be iv:authTag:ciphertext');
  
  const decrypted = crypto.decrypt(encrypted);
  assert.strictEqual(decrypted, password, 'Decrypted output should match original plaintext');
  
  console.log('✅ Test 1 Passed: Cryptography works perfectly.');
} catch (err) {
  console.error('❌ Test 1 Failed:', err.message);
  process.exit(1);
}

// Test 2: Database Schema & Operations
try {
  console.log('Running Test 2: Database schema and basic CRUD operations...');
  
  // Key-Value Store
  db.setKV('test-key', 'test-value-content');
  const kvVal = db.getKV('test-key');
  assert.strictEqual(kvVal, 'test-value-content', 'KV store should save and retrieve values');

  // User management
  const email = 'user@example.com';
  const pass = crypto.encrypt('password123');
  const userId = testkit.createUser(db, email, pass);
  
  assert.ok(userId > 0, 'Created user should return valid row ID');
  
  const user = db.getUserById(userId);
  assert.strictEqual(user.email, email, 'Fetched user should match created email');
  assert.strictEqual(user.encrypted_password, pass, 'Fetched user should match encrypted password');

  // User settings
  const settings = { advancedBooking: true, autoUpgradeEnabled: false };
  db.setUserSettings(userId, settings);
  const retrievedSettings = db.getUserSettings(userId);
  assert.deepStrictEqual(retrievedSettings, settings, 'Fetched settings should match updated preferences');

  console.log('✅ Test 2 Passed: Database tables and queries work perfectly.');
} catch (err) {
  console.error('❌ Test 2 Failed:', err.message);
  process.exit(1);
}

// Test 3: Precision Scheduler Release Time Calculations
try {
  console.log('Running Test 3: Precision Scheduler Release Time calculations...');
  
  // Test case: Class on Wednesday, June 24, 2026.
  //
  // UPDATED 2026-08-31: Psycle's standard window moved from 8 days to a
  // fortnight, so the legacy no-toggles offset is now 14, not 8. A 14-day
  // window reaches back one Monday further than an 8-day one:
  //   Mon 15 Jun + 14d = Mon 29 Jun >= 24 Jun  ✓  (this is the release Monday)
  //   Mon  8 Jun + 14d = Mon 22 Jun <  24 Jun  ✗
  // Day-granular member tiers are covered separately in test-booking-window.js.
  const classDate = '2026-06-24T18:30:00.000Z';
  
  const standardSettings = { advancedBooking: false, advancedBookingCredit: false };
  const standardRelease = scheduler.getClassReleaseTime({ start_at: classDate, gym_id: 'psycle-london' }, standardSettings);
  
  // London time check: should represent Monday June 15, 12:00 PM
  assert.strictEqual(standardRelease.year, 2026);
  assert.strictEqual(standardRelease.month, 6);
  assert.strictEqual(standardRelease.day, 15);
  assert.strictEqual(standardRelease.hour, 12);
  assert.strictEqual(standardRelease.minute, 0);

  // Advanced booking user (+7 days, legacy offset = 14 + 7 = 21 days):
  // Mon 8 Jun + 21d = Mon 29 Jun >= 24 Jun → released Monday June 8, 12:00 PM
  const advSettings = { advancedBooking: true, advancedBookingCredit: false };
  const advRelease = scheduler.getClassReleaseTime({ start_at: classDate, gym_id: 'psycle-london' }, advSettings);
  
  assert.strictEqual(advRelease.year, 2026);
  assert.strictEqual(advRelease.month, 6);
  assert.strictEqual(advRelease.day, 8);
  assert.strictEqual(advRelease.hour, 12);
  
  console.log('✅ Test 3 Passed: Release time arithmetic aligns with London timezone.');
} catch (err) {
  console.error('❌ Test 3 Failed:', err.message);
  process.exit(1);
}

// Cleanup database files
db.db.close();
if (fs.existsSync(process.env.DB_PATH)) {
  fs.unlinkSync(process.env.DB_PATH);
}
const dbJournal = `${process.env.DB_PATH}-journal`;
if (fs.existsSync(dbJournal)) {
  fs.unlinkSync(dbJournal);
}
const dbWal = `${process.env.DB_PATH}-wal`;
if (fs.existsSync(dbWal)) {
  fs.unlinkSync(dbWal);
}
const dbShm = `${process.env.DB_PATH}-shm`;
if (fs.existsSync(dbShm)) {
  fs.unlinkSync(dbShm);
}

console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
process.exit(0);
