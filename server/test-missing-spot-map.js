// A removed/never-set shared spot map: Auto-Book follows the LIVE map only (no
// snapshot fallback) and says so by push; Auto-Upgrade stops; removal counts.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const scheduler = require('./scheduler');
const poller = require('./poller');
const notifications = require('./notifications');
const MarianaTekProvider = require('./providers/marianatek');

const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);
const STUDIO = 'mock-room-BOXING';
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const origBook = MarianaTekProvider.prototype.bookSlot;
const origRequest = MarianaTekProvider.prototype.request;
const origNotify = notifications.notify;
let sent = [];
let booked = [];
notifications.notify = async (userId, type, ctx) => { sent.push({ userId, type, ctx }); };
MarianaTekProvider.prototype.bookSlot = async function (_e, slotIds) { booked.push(slotIds[0]); return { ok: true, bookingId: 'b1', slotId: slotIds[0] }; };
MarianaTekProvider.prototype.request = async function () { return { ok: true, status: 200, json: async () => ({}) }; };

let seq = 0;
function setup(label) {
  const uid = testkit.createUser(db, `nomap-${label}-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  db.linkGym(uid, JAB, { encryptedPassword: 'enc:pw' });
  db.setGymSession(uid, JAB, { accessToken: `T-${uid}` });
  sent = []; booked = [];
  return uid;
}
function cacheEvent(eventId) {
  scheduler.setCachedEvent(JAB, eventId, {
    event: { id: eventId },
    slots: [
      { id: 'snap', label: 'Bag 1', y: 0, isAvailable: true },
      { id: 'live', label: 'Bag 2', y: 0, isAvailable: true },
      { id: 'other', label: 'Bag 3', y: 0, isAvailable: true },
    ],
    objects: [],
  }, 60000);
}
const row = (uid, eventId, prefs) => ({
  user_id: uid, gym_id: JAB, event_id: eventId, studio_id: STUDIO,
  start_at: new Date(Date.now() + 3 * 864e5).toISOString(), group_name: 'BOXING', class_name: 'BOXING Core',
  instructor_name: 'Coach', studio_name: 'Boxing Studio', preferences: JSON.stringify(prefs),
});

check('release uses the LIVE shared map, not the stale snapshot', async () => {
  const uid = setup('live'); cacheEvent('7001');
  db.setStudioPreference(uid, STUDIO, { preferredSlots: ['live'], preferredRows: [] }, JAB);
  await scheduler.executeAutoBookForClass(row(uid, '7001', { preferredSlots: ['snap'], requiredCount: 1, bookAny: false }));
  assert.deepStrictEqual(booked, ['live']);
  assert.ok(!sent.some((s) => s.ctx.kind === 'noSpotMap'), 'a live map needs no explanation');
});

check('no map + bookAny: books any spot and notifies once', async () => {
  const uid = setup('any'); cacheEvent('7002');
  const r = row(uid, '7002', { preferredSlots: ['snap'], requiredCount: 1, bookAny: true });
  await scheduler.executeAutoBookForClass(r);
  assert.strictEqual(booked.length, 1, 'still books');
  assert.notStrictEqual(booked[0], undefined);
  const n = sent.filter((s) => s.ctx.kind === 'noSpotMap');
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].type, 'booking');
  assert.strictEqual(n[0].ctx.bookAny, true);
  await scheduler.executeAutoBookForClass(r);
  assert.strictEqual(sent.filter((s) => s.ctx.kind === 'noSpotMap').length, 1, 'deduped per class');
});

check('no map, no bookAny: does not book (snapshot ignored) and notifies', async () => {
  const uid = setup('none'); cacheEvent('7003');
  await scheduler.executeAutoBookForClass(row(uid, '7003', { preferredSlots: ['snap'], requiredCount: 1, bookAny: false }));
  assert.deepStrictEqual(booked, [], 'the snapshot must not drive a booking');
  const n = sent.filter((s) => s.ctx.kind === 'noSpotMap');
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].ctx.bookAny, false);
});

check('auto-upgrade with no map stops and notifies once', async () => {
  const uid = setup('upg');
  scheduler.setCachedEvent(JAB, '7004', { slots: [{ id: 'a', label: 'a', isAvailable: true, y: 0 }] }, 60000);
  db.addAutoUpgrade(uid, '7004', 'bk', 'a', 'BOXING Core', 'Coach', 'Boxing Studio', 'SW1',
    new Date(Date.now() + 2 * 864e5).toISOString(), { preferredSlots: ['a'] }, STUDIO, 'BOXING', JAB);
  const up = db.getUserAutoUpgrades(uid, JAB)[0];
  await poller.executeAutoUpgradeChecks();
  assert.strictEqual(db.getUserAutoUpgrades(uid, JAB)[0].status, 'stopped');
  const n = sent.filter((s) => s.ctx.kind === 'noSpotMap');
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].type, 'upgrade');
});

check('removal counts are scoped to the gym + studio and to live rows', () => {
  const uid = setup('count');
  const add = (studio, gym = JAB) => db.addAutoBooking(uid, `e${Math.random()}`, 'C', '', '', '', new Date().toISOString(), {}, studio, null, null, gym);
  add(STUDIO); add(STUDIO); add('other-studio');
  db.addAutoUpgrade(uid, '8001', 'bk', 'a', 'C', 'I', 'S', 'L', new Date(Date.now() + 864e5).toISOString(), {}, STUDIO, 'BOXING', JAB);
  assert.deepStrictEqual(db.countStudioMapDependents(uid, STUDIO, JAB), { autoBooks: 2, autoUpgrades: 1 });
  assert.deepStrictEqual(db.countStudioMapDependents(uid, 'nothing', JAB), { autoBooks: 0, autoUpgrades: 0 });
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  }
  notifications.notify = origNotify;
  MarianaTekProvider.prototype.bookSlot = origBook;
  MarianaTekProvider.prototype.request = origRequest;
  if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
  console.log(`🎉 ${checks.length}/${checks.length} missing-spot-map checks passed.`);
  process.exit(0);
})();
