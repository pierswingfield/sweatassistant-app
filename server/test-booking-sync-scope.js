// Test that booking cache sync scope respects failed gym fetches (C3-x, 2026-10-06)
// Bug: when one gym's fetch fails, the client returns merged data without that gym,
// and the server was clearing all gyms' caches. Now the client passes gymIds and
// the server only clears successful gyms.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');

const testkit = require('./testkit');
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const GYM_A = 'psycle-london';
const GYM_B = 'jab-boxing';

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(GYM_B);

check('sync with gymIds clears only those gyms', () => {
  // Create a test user linked to both gyms
  const userId = testkit.createUser(db, 'sync-test-a@test.local', 'password');
  db.upsertUserGym(userId, GYM_B, { gym_email: 'b@test.local', encrypted_password: 'enc:b' });

  // Seed booking caches for both gyms
  db.db.prepare(`
    INSERT INTO booking_cache
      (user_id, gym_id, booking_id, event_id, start_at, class_name, slot_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, GYM_A, 'booking-a1', 'event-a1', '2026-10-10T08:00:00Z', 'Class A1', 'Spot 1');
  db.db.prepare(`
    INSERT INTO booking_cache
      (user_id, gym_id, booking_id, event_id, start_at, class_name, slot_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, GYM_B, 'booking-b1', 'event-b1', '2026-10-10T09:00:00Z', 'Class B1', 'Spot 1');

  // Verify both caches exist
  let aCount = db.db.prepare('SELECT COUNT(*) as cnt FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .get(userId, GYM_A).cnt;
  let bCount = db.db.prepare('SELECT COUNT(*) as cnt FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .get(userId, GYM_B).cnt;
  assert.strictEqual(aCount, 1, 'Gym A cache should have 1 booking');
  assert.strictEqual(bCount, 1, 'Gym B cache should have 1 booking');

  // Sync only gym A's bookings (simulating gym B's fetch failed)
  const bookingsA = [{
    bookingId: 'booking-a2',
    eventId: 'event-a2',
    startAt: '2026-10-11T08:00:00Z',
    className: 'Class A2',
    gymId: GYM_A,
  }];

  db.replaceBookingCache(userId, bookingsA, [GYM_A]);

  // Gym A should be replaced with the new booking
  const aCache = db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .all(userId, GYM_A);
  assert.strictEqual(aCache.length, 1, 'Gym A should have 1 booking after sync');
  assert.strictEqual(aCache[0].booking_id, 'booking-a2', 'Gym A booking should be the new one');

  // Gym B should be untouched (still has booking-b1)
  const bCache = db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .all(userId, GYM_B);
  assert.strictEqual(bCache.length, 1, 'Gym B cache should still have 1 booking');
  assert.strictEqual(bCache[0].booking_id, 'booking-b1', 'Gym B booking should be untouched');
});

check('sync without gymIds falls back to payload gyms', () => {
  // Create a test user linked to both gyms
  const userId = testkit.createUser(db, 'sync-test-b@test.local', 'password');
  db.upsertUserGym(userId, GYM_B, { gym_email: 'b@test.local', encrypted_password: 'enc:b' });

  // Seed booking caches for both gyms
  db.db.prepare(`
    INSERT INTO booking_cache
      (user_id, gym_id, booking_id, event_id, start_at, class_name, slot_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, GYM_A, 'booking-a3', 'event-a3', '2026-10-12T08:00:00Z', 'Class A3', 'Spot 1');
  db.db.prepare(`
    INSERT INTO booking_cache
      (user_id, gym_id, booking_id, event_id, start_at, class_name, slot_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, GYM_B, 'booking-b2', 'event-b2', '2026-10-12T09:00:00Z', 'Class B2', 'Spot 1');

  // Sync without gymIds — only gym A's data sent (gym B's part of the payload is empty)
  const bookingsA = [{
    bookingId: 'booking-a4',
    eventId: 'event-a4',
    startAt: '2026-10-13T08:00:00Z',
    className: 'Class A4',
    gymId: GYM_A,
  }];

  db.replaceBookingCache(userId, bookingsA); // No scopeGymIds

  // Without scopeGymIds, only the gym in the payload is cleared
  const aCache = db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .all(userId, GYM_A);
  assert.strictEqual(aCache.length, 1, 'Gym A should have 1 booking');
  assert.strictEqual(aCache[0].booking_id, 'booking-a4', 'Gym A booking should be the new one');

  // Gym B should still have its old booking (not affected by a sync that only had gym A)
  const bCache = db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .all(userId, GYM_B);
  assert.strictEqual(bCache.length, 1, 'Gym B cache should still have 1 booking');
  assert.strictEqual(bCache[0].booking_id, 'booking-b2', 'Gym B booking should be untouched');
});

check('sync with unlinked gym in gymIds ignores it', () => {
  // Create a test user linked to gym A only
  const userId = testkit.createUser(db, 'sync-test-c@test.local', 'password');

  // Seed booking cache for gym A
  db.db.prepare(`
    INSERT INTO booking_cache
      (user_id, gym_id, booking_id, event_id, start_at, class_name, slot_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, GYM_A, 'booking-a5', 'event-a5', '2026-10-14T08:00:00Z', 'Class A5', 'Spot 1');

  // Try to sync with both an existing gym and a fake unlinked gym
  const bookingsA = [{
    bookingId: 'booking-a6',
    eventId: 'event-a6',
    startAt: '2026-10-15T08:00:00Z',
    className: 'Class A6',
    gymId: GYM_A,
  }];

  // Simulate server-side filtering of unlinked gyms
  const linkedGymIds = db.db.prepare('SELECT gym_id FROM user_gyms WHERE user_id = ?')
    .all(userId).map(r => r.gym_id);
  const sanitizedGymIds = [GYM_A, 'gym-fake'].filter(id => linkedGymIds.includes(id));

  db.replaceBookingCache(userId, bookingsA, sanitizedGymIds);

  // Only the existing gym should be affected
  const aCache = db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?')
    .all(userId, GYM_A);
  assert.strictEqual(aCache.length, 1, 'Gym A should have 1 booking');
  assert.strictEqual(aCache[0].booking_id, 'booking-a6', 'Gym A booking should be the new one');
});

// Run all checks
let passed = 0;
let failed = 0;
check('resolveSyncScope: route scope rules', () => {
  const { resolveSyncScope } = require('./booking-sync-scope');
  const linked = ['gym-a', 'gym-b'];
  assert.deepStrictEqual(resolveSyncScope(['gym-a'], linked), { scope: ['gym-a'], skip: false }, 'only loaded gym');
  assert.deepStrictEqual(resolveSyncScope(undefined, linked), { scope: linked, skip: false }, 'absent = legacy, all linked');
  assert.deepStrictEqual(resolveSyncScope([], linked), { scope: [], skip: true }, 'explicit empty = nothing loaded, skip');
  assert.deepStrictEqual(resolveSyncScope(['gym-z'], linked), { scope: [], skip: true }, 'unlinked ignored, nothing left = skip');
  assert.deepStrictEqual(resolveSyncScope(['gym-a', 'gym-z', 'gym-a'], linked).scope, ['gym-a'], 'dedupes and filters');
});

console.log(`\n🔍 booking-sync-scope           ${checks.length} checks`);
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
console.log(
  `\n${failed === 0 ? '✨' : '❌'} ${passed}/${checks.length} booking-sync-scope checks ${failed === 0 ? 'passed' : 'failed'}.`
);
process.exit(failed === 0 ? 0 : 1);
