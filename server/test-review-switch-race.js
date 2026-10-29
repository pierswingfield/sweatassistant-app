process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const assert = require('assert');
const db = require('./db');
const { createUser } = require('./testkit');
const scheduler = require('./scheduler');
const Provider = require('./providers/codexfit');
const user = createUser(db, 'switch-race@test.local', 'enc');
const gym = 'psycle-london';
db.setGymSession(user, gym, { accessToken: 'fixture' });
let mutations = 0;
Provider.prototype.fetchEventDetails = async () => {
  db.setUserGymEnabled(user, gym, false);
  return { event: {}, slots: [{ id: '1', label: '1', isAvailable: true }] };
};
Provider.prototype.bookSlot = async () => { mutations++; return { ok: true, bookingId: '1' }; };
(async () => {
  await scheduler.executeAutoBookForClass({ user_id: user, gym_id: gym, event_id: '123', start_at: new Date(Date.now() + 86400000).toISOString(), preferences: '{"bookAny":true}' });
  assert.strictEqual(mutations, 0, 'disabling during event lookup prevents a new booking');
  db.setUserGymEnabled(user, gym, true);
  const gate = require('./gym-mutation-gate');
  const finish = gate.begin(user, gym);
  assert.ok(finish, 'an enabled gym can begin a mutation');
  let settled = false;
  const switchingOff = gate.disable(user, gym).then(() => { settled = true; });
  const pendingAt = new Date().toISOString();
  await Promise.resolve();
  assert.strictEqual(settled, false, 'switch waits for in-flight work and recovery');
  assert.strictEqual(gate.begin(user, gym), null, 'no further mutation starts while switch is pending');
  finish();
  await switchingOff;
  assert.strictEqual(db.isUserGymEnabled(user, gym), false);
  const interval = db.db.prepare('SELECT disabled_at FROM gym_disabled_intervals WHERE user_id=? AND gym_id=? ORDER BY id DESC LIMIT 1').get(user, gym);
  assert.ok(interval.disabled_at <= pendingAt, 'pending switch records the disable start');
  db.setUserGymEnabled(user, gym, true);
  const MT = require('./providers/marianatek');
  const provider = new MT({ id: gym, apiBaseUrl: 'https://fixture.invalid/api/customer/v1' });
  let writes = 0;
  const oldFetch = global.fetch;
  global.fetch = async () => { writes++; return { ok: true, status: 200 }; };
  try {
    await gate.run(user, gym, async () => {
      const release = gate.begin(user, gym);
      const disabled = gate.disable(user, gym);
      await assert.rejects(() => provider.request('/me/reservations', { method: 'POST', token: 'fixture' }), e => e.code === 'GYM_DISABLED');
      assert.strictEqual(writes, 0, 'provider preparation cannot issue its first write after disabling begins');
      release(); await disabled;
    });
    db.setUserGymEnabled(user, gym, true);
    await gate.run(user, gym, async () => {
      const release = gate.begin(user, gym);
      await provider.request('/me/reservations/1/cancel', { method: 'POST', token: 'fixture' });
      const disabled = gate.disable(user, gym);
      await provider.request('/me/reservations', { method: 'POST', token: 'fixture' });
      release(); await disabled;
      assert.strictEqual(writes, 2, 'rebooking recovery completes after cancellation was issued');
    });
  } finally { global.fetch = oldFetch; }
  console.log('Switch during preparation and in-flight mutation passed');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
