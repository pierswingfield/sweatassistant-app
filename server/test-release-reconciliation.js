// Member-specific published releases must be refreshed without overwriting newer queue state.
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const providers = require('./providers');
let fetchImpl, detailCalls = 0;
providers.getProvider = () => ({ fetchFreshReleaseEvents: (...args) => fetchImpl(...args), fetchEventDetails: async () => { detailCalls++; throw new Error('test stops before booking'); } });
const db = require('./db');
const scheduler = require('./scheduler');
const gym = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(gym);
const now = Date.now();
const iso = minutes => new Date(now + minutes * 60000).toISOString();
let sequence = 0;
function user() {
  const id = db.createAccount(`release-${++sequence}@test.local`, 'test-password');
  db.upsertUserGym(id, gym, { session_json: JSON.stringify({accessToken: `token-${id}`}), status: 'active' });
  return id;
}
function queue(uid, event, release = iso(180)) {
  return db.addAutoBooking(uid, event, 'Class', 'Coach', 'Studio', 'Location', iso(2880),
    {preferredSlots: [1], requiredCount: 1}, 100, 'Group', release, gym);
}
function release(id) { return db.db.prepare('SELECT release_at FROM auto_bookings WHERE id = ?').get(id).release_at; }
function clear() { db.db.prepare('DELETE FROM auto_bookings').run(); scheduler._resetRateLimitBackoffForTests(); }
async function waitForDetails(count) {
  const deadline = Date.now() + 3000;
  while (detailCalls < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(detailCalls, count, 'expected dispatch reached provider');
  await new Promise(resolve => setTimeout(resolve, 20));
}
async function main() {
  const a = user(), b = user();
  let id = queue(a, 'one'), id2 = queue(a, 'two'), id3 = queue(b, 'one');
  const calls = [];
  fetchImpl = async (range, session) => {
    calls.push({range, token: session.accessToken});
    return [{id:'one', releaseAt: session.accessToken === `token-${a}` ? iso(120) : iso(90)}, {id:'two', releaseAt: iso(60)}];
  };
  await scheduler.reconcilePendingReleases();
  assert.equal(calls.length, 2, 'one request per member and date');
  assert.deepEqual(new Set(calls.map(c => c.token)), new Set([`token-${a}`, `token-${b}`]));
  assert.equal(calls[0].range.startDate, calls[0].range.endDate);
  assert.equal(release(id), iso(120)); assert.equal(release(id2), iso(60)); assert.equal(release(id3), iso(90));
  clear(); id = queue(a, 'bad');
  fetchImpl = async () => [{id:'bad', releaseAt:'invalid'}];
  await scheduler.reconcilePendingReleases(); assert.equal(release(id), iso(180));
  fetchImpl = async () => { throw Object.assign(new Error('temporary failure'), {status:503}); };
  await scheduler.reconcilePendingReleases(); assert.equal(release(id), iso(180));
  fetchImpl = async () => [{id:'other', releaseAt:iso(30)}];
  await scheduler.reconcilePendingReleases(); assert.equal(release(id), iso(180));
  fetchImpl = async () => { db.db.prepare('UPDATE auto_bookings SET release_at = ? WHERE id = ?').run(iso(240), id); return [{id:'bad', releaseAt:iso(30)}]; };
  await scheduler.reconcilePendingReleases(); assert.equal(release(id), iso(240), 'stale fetch cannot overwrite newer state');
  clear(); id = queue(a, 'throttle');
  let attempts = 0;
  fetchImpl = async () => { attempts++; throw Object.assign(new Error('throttled'), {status:429}); };
  await scheduler.reconcilePendingReleases(); await scheduler.reconcilePendingReleases();
  assert.equal(attempts, 1, '429 backoff suppresses the next provider request');
  assert.equal(release(id), iso(180));
  clear(); id = queue(a, 'within-grace');
  db.db.prepare("UPDATE auto_bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(id);
  fetchImpl = async () => [{id:'within-grace', releaseAt:iso(-74)}];
  await scheduler.reconcilePendingReleases();
  await waitForDetails(1);
  assert.equal(detailCalls, 1, 'newly moved release within grace dispatches once');
  await scheduler.reconcilePendingReleases();
  assert.equal(detailCalls, 1, 'repeat reconciliation does not dispatch again');
  clear(); id = queue(a, 'both-past', iso(-20));
  db.db.prepare("UPDATE auto_bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(id);
  fetchImpl = async () => [{id:'both-past', releaseAt:iso(-74)}];
  await scheduler.reconcilePendingReleases();
  await waitForDetails(2);
  clear(); id = queue(a, 'restart-later', iso(-3));
  db.db.prepare("UPDATE auto_bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(id);
  const beforeRestart = detailCalls;
  fetchImpl = async () => [{id:'restart-later', releaseAt:iso(90)}];
  await scheduler.reconcilePendingReleases({startupRecovery:true});
  assert.equal(release(id), iso(90));
  assert.equal(detailCalls, beforeRestart, 'restart does not dispatch a stale past release moved later');
  clear(); id = queue(a, 'restart-due', iso(-74));
  db.db.prepare("UPDATE auto_bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(id);
  fetchImpl = async () => [{id:'restart-due', releaseAt:iso(-74)}];
  await scheduler.reconcilePendingReleases({startupRecovery:true});
  await waitForDetails(beforeRestart + 1);
  assert.equal(detailCalls, beforeRestart + 1, 'restart dispatches a freshly confirmed recent release');
  clear(); id = queue(a, 'restart-too-old', iso(-76));
  db.db.prepare("UPDATE auto_bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(id);
  const beforeTooOld = detailCalls;
  fetchImpl = async () => [{id:'restart-too-old', releaseAt:iso(-76)}];
  await scheduler.reconcilePendingReleases({startupRecovery:true});
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(detailCalls, beforeTooOld, 'startup recovery does not dispatch beyond 75 minutes');
  clear(); id = queue(a, 'past');
  fetchImpl = async () => [{id:'past', releaseAt:iso(-76)}];
  await scheduler.reconcilePendingReleases(); assert.equal(release(id), iso(-76));
  assert.equal(db.db.prepare('SELECT status FROM auto_bookings WHERE id = ?').get(id).status, 'pending', 'older than grace is not dispatched');
  clear(); id = queue(a, 'startup-immediate', iso(-3));
  const retryId = queue(b, 'startup-retry', iso(-20));
  db.db.prepare("UPDATE auto_bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(retryId);
  let finishRefresh;
  fetchImpl = (_range, session) => session.accessToken === `token-${a}`
    ? new Promise(resolve => { finishRefresh = resolve; })
    : Promise.reject(Object.assign(new Error('startup unavailable'), {status:503}));
  const beforeImmediate = detailCalls;
  scheduler.init();
  for (let i = 0; i < 100 && !finishRefresh; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof finishRefresh, 'function', 'startup refresh is pending');
  scheduler.checkAndRunImmediateBookings(a);
  scheduler.runAllPendingBookings(a);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(detailCalls, beforeImmediate, 'unverified startup row is blocked from immediate and simulated dispatch');
  finishRefresh([{id:'startup-immediate', releaseAt:iso(90)}]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(release(id), iso(90), 'fresh future release is retained');
  assert.equal(detailCalls, beforeImmediate, 'future release is not dispatched after refresh');
  fetchImpl = async (_range, session) => session.accessToken === `token-${a}`
    ? [{id:'startup-immediate', releaseAt:iso(90)}]
    : [{id:'startup-retry', releaseAt:iso(-74)}];
  await scheduler.reconcilePendingReleases();
  await waitForDetails(beforeImmediate + 1);
  await scheduler.reconcilePendingReleases();
  assert.equal(detailCalls, beforeImmediate + 1, 'startup failure retry dispatches once');
  console.log('PASS: session isolation, batching, invalid/missing/error responses, compare-and-swap, backoff, grace dispatch, and startup immediate guard');
}
main().then(() => process.exit(0), err => { console.error(err); process.exit(1); });
