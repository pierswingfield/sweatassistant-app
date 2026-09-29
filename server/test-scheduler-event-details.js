// Auto-book must use the provider's normalized event-details contract. The
// provider endpoint differs across platforms (CodexFit /events, MarianaTek
// /classes), and provider ids may collide between gyms.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const scheduler = require('./scheduler');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function makeUser(label) {
  const userId = db.createUser(`scheduler-details-${label}-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(userId, JAB, { encryptedPassword: 'enc:pw' });
  db.setGymSession(userId, JAB, { accessToken: `jab-token-${userId}` });
  return userId;
}

const originalCfDetails = CodexFitProvider.prototype.fetchEventDetails;
const originalMtDetails = MarianaTekProvider.prototype.fetchEventDetails;
const originalCfBook = CodexFitProvider.prototype.bookSlot;
const originalMtBook = MarianaTekProvider.prototype.bookSlot;

function restore() {
  CodexFitProvider.prototype.fetchEventDetails = originalCfDetails;
  MarianaTekProvider.prototype.fetchEventDetails = originalMtDetails;
  CodexFitProvider.prototype.bookSlot = originalCfBook;
  MarianaTekProvider.prototype.bookSlot = originalMtBook;
}

const normalized = (id) => ({
  event: { id: String(id), name: 'Boxing', credits: undefined },
  slots: [
    { id: 'available', label: 'Bag 1', y: 0, isAvailable: true },
    { id: 'taken', label: 'Bag 2', y: 0, isAvailable: false },
  ],
  objects: [],
});

check('prefetch calls each gym provider independently when provider event ids collide', async () => {
  const calls = [];
  CodexFitProvider.prototype.fetchEventDetails = async function (eventId) {
    calls.push({ gymId: this.gym.id, eventId: String(eventId) });
    return normalized(eventId);
  };
  MarianaTekProvider.prototype.fetchEventDetails = async function (eventId) {
    calls.push({ gymId: this.gym.id, eventId: String(eventId) });
    return normalized(eventId);
  };

  try {
    await scheduler.prefetchAutoBookSlots([
      { user_id: 1, gym_id: PSYCLE, event_id: '93001' },
      { user_id: 2, gym_id: JAB, event_id: '93001' },
    ], 0);

    assert.deepStrictEqual(calls.sort((a, b) => a.gymId.localeCompare(b.gymId)), [
      { gymId: JAB, eventId: '93001' },
      { gymId: PSYCLE, eventId: '93001' },
    ]);
    assert.deepStrictEqual(scheduler.getCachedEvent(PSYCLE, '93001').slots.map((s) => s.id), ['available', 'taken']);
    assert.deepStrictEqual(scheduler.getCachedEvent(JAB, '93001').slots.map((s) => s.id), ['available', 'taken']);
  } finally {
    restore();
  }
});

check('JAB auto-book reads normalized MarianaTek event details and books an available slot', async () => {
  const userId = makeUser('execute');
  const calls = [];
  let bookedSlot = null;
  MarianaTekProvider.prototype.fetchEventDetails = async function (eventId) {
    calls.push(String(eventId));
    return normalized(eventId);
  };
  MarianaTekProvider.prototype.bookSlot = async function (_eventId, slotIds) {
    bookedSlot = slotIds[0];
    return { ok: true, bookingId: 'jab-booking-1', slotId: bookedSlot };
  };

  try {
    await scheduler.executeAutoBookForClass({
      user_id: userId,
      gym_id: JAB,
      event_id: '93002',
      studio_id: null,
      start_at: new Date(Date.now() + 3 * 864e5).toISOString(),
      group_name: 'BOXING',
      class_name: 'Boxing',
      instructor_name: 'Coach',
      preferences: JSON.stringify({ preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true }),
    });

    assert.deepStrictEqual(calls, ['93002'], 'scheduler should request details through the JAB provider');
    assert.strictEqual(bookedSlot, 'available', 'scheduler should derive availability from normalized slots');
  } finally {
    restore();
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.stack || err.message}`);
    }
  }
  restore();
  if (failed) process.exit(1);
  console.log(`\n${checks.length} checks passed.`);
})();
