// Per-gym notification defaults — the booking-window reminder.
//
// "Booking opens in an hour" is only meaningful where booking opens at ONE
// moment: Psycle releases weekly (Monday noon), so it is a real event worth a
// push. JAB rolls continuously — every class opens at its own instant — so the
// same notification there would be both untrue and unactionable.
//
// The default therefore belongs to the GYM, set in gyms.config.js, with the
// member free to override it per gym.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const db = require('./db');
const notifications = require('./notifications');
const { getGymConfig } = require('./gyms.config');
const { isRollingWeekly } = require('./providers/booking-window');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let seq = 0;
function twoGymUser() {
  const uid = db.createUser(`notif-${++seq}@test.local`, 'x');
  db.upsertUserGym(uid, PSYCLE, { gym_email: 'a@test.local' });
  db.upsertUserGym(uid, JAB, { gym_email: 'b@test.local' });
  return uid;
}

check('a weekly-release gym defaults the booking-window reminder ON', () => {
  const uid = twoGymUser();
  assert.strictEqual(notifications.bookingWindowEnabledForGym(uid, PSYCLE), true);
});

check('a rolling gym defaults it OFF', () => {
  const uid = twoGymUser();
  assert.strictEqual(notifications.bookingWindowEnabledForGym(uid, JAB), false,
    'JAB has no single weekly release moment, so there is nothing to announce');
});

check('the config default, not the window kind, is what is read', () => {
  // The kind is only the FALLBACK for a gym that omits the setting. A gym could
  // release weekly and still not want the push, so the explicit value wins.
  assert.strictEqual(getGymConfig(PSYCLE).notifications.bookingWindowReminder, true);
  assert.strictEqual(getGymConfig(JAB).notifications.bookingWindowReminder, false);
  // …and the fallback agrees with them, so an omitted setting stays sensible.
  assert.strictEqual(isRollingWeekly(getGymConfig(PSYCLE)), true);
  assert.strictEqual(isRollingWeekly(getGymConfig(JAB)), false);
});

check('a member can override either gym in either direction', () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, {
    notifications: { bookingWindow: { enabled: true, byGym: { [JAB]: true, [PSYCLE]: false } } },
  });
  assert.strictEqual(notifications.bookingWindowEnabledForGym(uid, JAB), true,
    'opting IN to a rolling gym\'s reminder must be possible');
  assert.strictEqual(notifications.bookingWindowEnabledForGym(uid, PSYCLE), false,
    'opting OUT of a weekly gym\'s reminder must be possible');
});

check('the account-level switch still turns every gym off', () => {
  const uid = twoGymUser();
  db.setUserSettings(uid, {
    notifications: { bookingWindow: { enabled: false, byGym: { [PSYCLE]: true } } },
  });
  assert.strictEqual(notifications.bookingWindowEnabledForGym(uid, PSYCLE), false,
    'the master switch outranks a per-gym opt-in, or "all off" would not mean all off');
});

check('an unknown gym is never notified', () => {
  const uid = twoGymUser();
  assert.strictEqual(notifications.bookingWindowEnabledForGym(uid, 'not-a-real-gym'), false);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${checks.length} notification-default checks FAILED.`);
  process.exit(1);
}
console.log(`\n🎉 ${checks.length}/${checks.length} notification-default checks passed.`);
