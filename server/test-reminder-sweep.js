// The cancellation-reminder sweep covers EVERY linked gym (active-gym audit, stage 3).
//
// `refreshBookingCaches` used to read one gym per user — whichever
// `db.resolveActiveGymId` happened to return — over a hardcoded CodexFit path
// (`/bookings?limit=100&page=1`) with CodexFit-shaped normalisation. So a
// two-gym member got cancellation reminders for one gym and silence for the
// other, and the gym it did read was only ever right for a CodexFit gym.
//
// It now loops the account's links and goes through each gym's own adapter.
//
// The per-gym builder is asserted directly rather than through the whole sweep:
// the sweep ends by pruning past classes, and the mock fixtures are past-dated,
// so a cache-contents assertion after a full run passes on an empty table and
// proves nothing. (Found the hard way — the first version of this file did
// exactly that.)

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `reminder-sweep-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('./db');
const poller = require('./poller');
const { getProvider } = require('./providers');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
// Each adapter routes to its own mock on its own sentinel token.
const CODEXFIT_MOCK_TOKEN = 'mock-jwt-token';
const MARIANATEK_MOCK_TOKEN = 'mock-mt-token';

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function cleanup() {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
}

let seq = 0;
function twoGymUser() {
  // Each adapter routes to its mock on the session TOKEN, so the account's own
  // email can be unique per check; the per-gym `gym_email` is what identifies
  // the member to each mock.
  const userId = db.createUser(`sweep-${++seq}@test.local`, 'x');
  db.upsertUserGym(userId, PSYCLE, {
    gym_email: 'dev@psycle.com', encrypted_password: 'x',
    session_json: JSON.stringify({ accessToken: CODEXFIT_MOCK_TOKEN }),
  });
  db.upsertUserGym(userId, JAB, {
    gym_email: 'dev@jabboxing.mock', encrypted_password: 'x',
    session_json: JSON.stringify({ accessToken: MARIANATEK_MOCK_TOKEN }),
  });
  return userId;
}

check('a CodexFit gym yields rows tagged with ITS OWN gym, each with a start time', async () => {
  const userId = twoGymUser();
  const rows = await poller.bookingCacheRowsFor(userId, PSYCLE);
  assert.ok(rows.length > 0, 'the CodexFit mock should return bookings');
  assert.ok(rows.every((r) => r.gymId === PSYCLE), 'every row carries the gym it was read from');
  assert.ok(rows.every((r) => !!r.startAt), 'a reminder cannot fire without a start time');
});

check('a MarianaTek gym is read through its OWN adapter, not a CodexFit URL', async () => {
  const userId = twoGymUser();
  // The mock's reservation list starts empty (it fills on booking), so asserting
  // on returned rows would pass vacuously. The property that actually regressed
  // is WHICH code path this gym is read through: the old sweep sent CodexFit's
  // `/bookings?limit=100&page=1` and parsed CodexFit shapes for every gym.
  const provider = getProvider(JAB);
  const original = provider.listBookings.bind(provider);
  let calledWith = null;
  provider.listBookings = async (session) => { calledWith = session; return original(session); };
  try {
    const rows = await poller.bookingCacheRowsFor(userId, JAB);
    assert.ok(calledWith, 'JAB must be read via the MarianaTek adapter\'s listBookings');
    assert.strictEqual(calledWith.accessToken, MARIANATEK_MOCK_TOKEN,
      'and with THAT gym\'s session, not the account\'s resolved one');
    assert.ok(rows.every((r) => r.gymId === JAB), 'any row carries the gym it was read from');
  } finally {
    provider.listBookings = original;
  }
});

check('a gym that cannot authenticate throws for ITSELF only', async () => {
  const userId = twoGymUser();
  db.upsertUserGym(userId, JAB, { session_json: null });

  await assert.rejects(
    () => poller.bookingCacheRowsFor(userId, JAB),
    'a gym with no session must surface as an error for that gym',
  );
  // …and the other gym is unaffected, which is what lets the sweep scope its
  // write to the gyms that actually answered.
  const psycleRows = await poller.bookingCacheRowsFor(userId, PSYCLE);
  assert.ok(psycleRows.length > 0, 'the healthy gym still returns its bookings');
});

check('the full sweep survives a broken gym without throwing', async () => {
  const userId = twoGymUser();
  db.addPushSubscription(userId, JSON.stringify({ endpoint: 'https://example.test/x', keys: {} }));
  db.upsertUserGym(userId, JAB, { session_json: null });
  await poller.refreshBookingCaches(); // must not reject
});

(async () => {
  let failed = 0;
  console.log('\n🧪 Cancellation-reminder sweep — every linked gym\n');
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  cleanup();
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} reminder-sweep checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} reminder-sweep checks passed.`);
  process.exit(0);
})();
