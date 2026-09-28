// U1-16 — a booking push must carry the real class and instructor, and must
// never render the placeholder "CLASS with your instructor".
//
// Root cause (client): quickBookClass built the payload from `event.raw`. For
// Psycle `.raw` is the CodexFit event (event_type / instructor / start_at) with
// no `name`, `discipline`, `instructors` or `startAt`, so the server received
// nothing to name. JAB's raw carries those names, which is why only Psycle broke.
// The client now builds from the normalized event (client/src/ui/booking-notify.js);
// this suite pins the server half: both gyms' payload shapes render properly, and
// a payload with no instructor drops the "with …" clause instead of inventing one.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const db = require('./db');
const notifications = require('./notifications');
const pushService = require('./push');

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');

let captured;
const originalSend = pushService.sendNotification;
pushService.sendNotification = async (userId, title, body) => { captured = { title, body }; };

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const uid = db.createUser(`text-${Date.now()}@test.local`, 'enc:pw');
const startAt = new Date(Date.now() + 2 * 864e5).toISOString();

async function send(type, ctx) {
  captured = null;
  await notifications.notify(uid, type, ctx);
  assert.ok(captured, `${type} sent nothing`);
  return captured.body;
}

check('Psycle payload (normalized shape) names class group and instructor', async () => {
  const body = await send('booking', { gymId: 'psycle-london', source: 'quickbook', className: 'Signature 45', groupName: 'RIDE', instructorName: 'Aanya Smith', startAt, slots: ['5'] });
  assert.ok(/RIDE with Aanya - Spot 5\.$/.test(body), body);
});

check('JAB payload names group and instructor', async () => {
  const body = await send('booking', { gymId: 'jab-boxing', source: 'manual', className: 'TRAIN - Upper (Focus)', groupName: 'TRAIN', instructorName: 'Coach K', startAt, slots: ['3'] });
  assert.ok(/TRAIN with Coach - Spot 3\.$/.test(body), body);
});

check('an empty payload never says "with your instructor"', async () => {
  const body = await send('booking', { gymId: 'psycle-london', source: 'quickbook', className: '', groupName: '', instructorName: '', startAt, slots: ['5'] });
  assert.ok(!/your instructor/.test(body), body);
  assert.ok(!/ with /.test(body), body);
});

check('no instructor: every builder drops the clause and leaves no double space', async () => {
  const base = { gymId: 'psycle-london', className: 'Core', groupName: 'BOXING', instructorName: null, startAt, slot: 4, slots: [4], spots: 1, creditsShort: 1 };
  for (const [type, extra] of [['booking', {}], ['upgrade', {}], ['creditWarning', { kind: 'autobook' }], ['creditWarning', { kind: 'autoupgrade' }], ['cancellationReminder', { startAt: new Date(Date.now() + 20 * 36e5).toISOString() }]]) {
    const body = await send(type, { ...base, ...extra });
    assert.ok(!/with|your instructor/.test(body.replace(/Auto-Book was set up/, '')), `${type}: ${body}`);
    assert.ok(!/ {2}/.test(body), `${type} double space: ${body}`);
  }
});

check('withInstructor uses the first name only', () => {
  assert.strictEqual(notifications.withInstructor('Aanya Smith'), ' with Aanya');
  assert.strictEqual(notifications.withInstructor('  '), '');
  assert.strictEqual(notifications.withInstructor(undefined), '');
});

(async () => {
  let failed = 0;
  console.log('\n🧪 U1-16: notification text\n');
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
  }
  pushService.sendNotification = originalSend;
  if (failed) { console.error(`\n${failed}/${checks.length} notification text checks FAILED.`); process.exit(1); }
  console.log(`\n🎉 ${checks.length}/${checks.length} notification text checks passed.`);
})();
