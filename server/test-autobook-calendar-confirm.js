// Auto-book success must trigger a real calendar refresh (scheduleRefresh) so the
// class is CONFIRMED in the feed without waiting for the 3-hourly poll.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const scheduler = require('./scheduler');
const calendar = require('./calendar');
const notifications = require('./notifications');
const MarianaTekProvider = require('./providers/marianatek');

const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);
notifications.notify = async () => {};
MarianaTekProvider.prototype.bookSlot = async function (_e, slotIds) { return { ok: true, bookingId: 'b1', slotId: slotIds[0] }; };
MarianaTekProvider.prototype.request = async function () { return { ok: true, status: 200, json: async () => ({}) }; };

const refreshes = [];
calendar.scheduleRefresh = (userId, delay) => { refreshes.push({ userId, delay }); };

(async () => {
  const uid = testkit.createUser(db, `calconfirm-${Date.now()}@test.local`, 'enc:pw');
  db.linkGym(uid, JAB, { encryptedPassword: 'enc:pw' });
  db.setGymSession(uid, JAB, { accessToken: `T-${uid}` });
  scheduler.setCachedEvent(JAB, '7101', {
    event: { id: '7101' },
    slots: [{ id: 's1', label: 'Bag 1', y: 0, isAvailable: true }],
    objects: [],
  }, 60000);
  await scheduler.executeAutoBookForClass({
    user_id: uid, gym_id: JAB, event_id: '7101', studio_id: 'mock-room-BOXING',
    start_at: new Date(Date.now() + 3 * 864e5).toISOString(), group_name: 'BOXING', class_name: 'BOXING Core',
    instructor_name: 'Coach', studio_name: 'Boxing Studio',
    preferences: JSON.stringify({ preferredSlots: ['s1'], requiredCount: 1, bookAny: true }),
  });
  assert.ok(refreshes.some((r) => r.userId === uid && r.delay <= 5000), 'auto-book success must schedule a calendar refresh');
  console.log('🎉 1/1 autobook-calendar-confirm checks passed.');
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
