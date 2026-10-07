// C3-5 — push notification titles/bodies must name the RIGHT gym.
//
// Every builder in notifications.js (buildBooking, buildUpgrade,
// buildCreditWarning, buildCancellationReminder, buildBookingWindow)
// hardcoded "Psycle" — true only for a single-gym build. A JAB user's
// notifications said "Psycle: Spot Booked" and "speak to Psycle to cancel".
//
// Fixed by threading `ctx.gymId` through every notify() call site (scheduler,
// poller, server.js) into a shared `gymShortName(gymId)` helper that reads
// gyms.config.js, mirroring the pattern buildProviderThrottled already used.
// This stubs pushService.sendNotification to capture the rendered title/body
// per call and asserts both gyms render correctly, and that a JAB
// notification never contains the word "Psycle".

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const notifications = require('./notifications');
const pushService = require('./push');

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let captured;
const originalSend = pushService.sendNotification;
function installSpy() {
  captured = null;
  pushService.sendNotification = async (userId, title, body, data) => {
    captured = { userId, title, body, data };
  };
}
function restoreSpy() { pushService.sendNotification = originalSend; }

let seq = 0;
function makeUser() {
  return testkit.createUser(db, `notif-${Date.now()}-${seq++}@test.local`, 'enc:pw');
}

const CASES = [
  {
    type: 'booking',
    ctx: { gymId: null, source: 'autobook', startAt: new Date(Date.now() + 864e5).toISOString(), groupName: 'BOXING', className: 'Core', instructorName: 'Coach', slots: [3] },
  },
  {
    type: 'upgrade',
    ctx: { gymId: null, slot: 3, startAt: new Date(Date.now() + 864e5).toISOString(), groupName: 'BOXING', className: 'Core', instructorName: 'Coach', keptOriginal: true },
  },
  {
    type: 'creditWarning',
    ctx: { gymId: null, kind: 'autobook', startAt: new Date(Date.now() + 864e5).toISOString(), groupName: 'BOXING', className: 'Core', instructorName: 'Coach', spots: 1, creditsShort: 1 },
  },
  {
    type: 'cancellationReminder',
    ctx: { gymId: null, startAt: new Date(Date.now() + 20 * 3600 * 1000).toISOString(), groupName: 'BOXING', className: 'Core', instructorName: 'Coach', slot: 3 },
  },
  {
    type: 'bookingWindow',
    ctx: { gymId: null, tip: 'Test tip' },
  },
];

for (const { type, ctx } of CASES) {
  check(`${type}: names Psycle for a psycle-london context, never JAB`, async () => {
    installSpy();
    try {
      const uid = makeUser();
      await notifications.notify(uid, type, { ...ctx, gymId: 'psycle-london' });
      assert.ok(captured, `${type} must send a notification`);
      const text = `${captured.title} ${captured.body}`;
      assert.ok(/Psycle/.test(text), `expected "Psycle" to appear: ${JSON.stringify(captured)}`);
      assert.ok(!/JAB/.test(text), `must not mention JAB: ${JSON.stringify(captured)}`);
    } finally { restoreSpy(); }
  });

  check(`${type}: names JAB for a jab-boxing context, never Psycle`, async () => {
    installSpy();
    try {
      const uid = makeUser();
      await notifications.notify(uid, type, { ...ctx, gymId: 'jab-boxing' });
      assert.ok(captured, `${type} must send a notification`);
      const text = `${captured.title} ${captured.body}`;
      assert.ok(/JAB/.test(text), `expected "JAB" to appear: ${JSON.stringify(captured)}`);
      assert.ok(!/Psycle/.test(text), `must NOT hardcode "Psycle" for a JAB notification: ${JSON.stringify(captured)}`);
    } finally { restoreSpy(); }
  });
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-5: notification gym naming\n');
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
  }
  restoreSpy();
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} notification gym-naming checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} notification gym-naming checks passed.`);
})();
