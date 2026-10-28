process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'gym-enabled-test-secret';
const assert = require('assert');
const db = require('./db');
const { createUser } = require('./testkit');

const gym = 'psycle-london';
const alice = createUser(db, 'gym-toggle-a@test.local', 'enc');
const bob = createUser(db, 'gym-toggle-b@test.local', 'enc');
const addBooking = db.db.prepare("INSERT INTO auto_bookings (user_id, gym_id, event_id, preferences) VALUES (?, ?, ?, '{}')");
const addUpgrade = db.db.prepare("INSERT INTO auto_upgrades (user_id, gym_id, event_id, booking_id, current_slot_id, preferences) VALUES (?, ?, ?, ?, ?, '{}')");
for (const id of [alice, bob]) {
  addBooking.run(id, gym, id);
  addUpgrade.run(id, gym, id, id, id);
}
assert.strictEqual(db.getUserGym(alice, gym).account_enabled, 1);
assert.strictEqual(db.setUserGymEnabled(alice, gym, false), true);
assert.strictEqual(db.isUserGymEnabled(alice, gym), false);
assert.strictEqual(db.isUserGymEnabled(bob, gym), true);
assert.deepStrictEqual(db.getPendingAutoBookings().map(x => x.user_id), [bob]);
assert.deepStrictEqual(db.getActiveAutoUpgrades().map(x => x.user_id), [bob]);
assert.strictEqual(db.getUserAutoBookings(alice, gym).length, 1);
assert.strictEqual(db.getUserAutoUpgrades(alice, gym).length, 1);
assert.strictEqual(db.setUserGymEnabled(alice, gym, true), true);
assert.strictEqual(db.getPendingAutoBookings().length, 2);
assert.strictEqual(db.getActiveAutoUpgrades().length, 2);
assert.strictEqual(db.setUserGymEnabled(alice, 'not-linked', false), false);
// A release missed while disabled must not be picked up by a later re-arm or
// startup recovery. A fresh queue entry created after re-enabling remains valid.
const { DateTime } = require('luxon');
const scheduler = require('./scheduler');
const release = DateTime.utc().minus({ minutes: 1 });
db.db.prepare('INSERT INTO auto_bookings (user_id, gym_id, event_id, preferences, start_at, release_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(alice, gym, 987, '{}', DateTime.utc().plus({ days: 2 }).toISO(), release.toISO(), '2020-01-01 00:00:00');
db.setUserGymEnabled(alice, gym, false);
db.setUserGymEnabled(alice, gym, true);
assert.strictEqual(scheduler.bookingsReleasingAt(release).some(x => x.event_id === 987), false);
assert.strictEqual(db.getUserAutoBookings(alice, gym).some(x => x.event_id === 987), true);
db.db.prepare('INSERT INTO auto_bookings (user_id, gym_id, event_id, preferences, start_at, release_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run(alice, gym, 988, '{}', DateTime.utc().plus({ days: 2 }).toISO(), release.toISO());
assert.strictEqual(scheduler.bookingsReleasingAt(release).some(x => x.event_id === 988), true);
// A stored tentative class leaves the published calendar when its gym is off,
// without deleting the queued row, and returns when the gym is re-enabled.
db.db.prepare('UPDATE auto_bookings SET class_name = ? WHERE user_id = ? AND event_id = ?').run('Toggle fixture class', alice, 987);
db.setUserSettings(alice, { calendar: { enabled: true, includeAutoBook: true } });
const calendar = require('./calendar');
assert.ok(calendar.regenerateSnapshot(alice).ics.includes('UID:app-1-987@'));
db.setUserGymEnabled(alice, gym, false);
assert.ok(!calendar.regenerateSnapshot(alice).ics.includes('UID:app-1-987@'));
db.setUserGymEnabled(alice, gym, true);
assert.ok(calendar.regenerateSnapshot(alice).ics.includes('UID:app-1-987@'));
console.log('Gym enablement isolation and queue retention passed');

// A stale client cannot keep reading a switched-off gym, while its Settings
// endpoint remains available to restore the switch.
(async () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { authenticateToken } = require('./auth');
  const app = express();
  app.get('/api/timetable', authenticateToken, (req, res) => res.json({ ok: true }));
  app.get('/api/settings', authenticateToken, (req, res) => res.json({ ok: true }));
  db.setUserGymEnabled(alice, gym, false);
  assert.strictEqual((await require('./class-history').syncUserGym(alice, gym)).error, 'gym turned off');
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const headers = { authorization: `Bearer ${jwt.sign({ userId: alice, email: 'fixture@test.local' }, process.env.JWT_SECRET)}`, 'x-gym-id': gym };
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual((await fetch(`${base}/api/timetable`, { headers })).status, 409);
    assert.strictEqual((await fetch(`${base}/api/settings`, { headers })).status, 200);
  } finally { server.close(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
