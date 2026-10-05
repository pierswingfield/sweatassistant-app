// F-10-0 — class-history pull and store.
//
// Covers: both adapters' listBookingHistory against the dev mocks (live envelopes),
// full pagination, idempotent re-sync, incremental sync, multi-gym isolation (same
// provider booking id under two gyms), per-gym aggregates, failure recording,
// unlink cleanup, and the GET /api/history route (gym named via x-gym-id).
//
// Q5 depth/pagination/status behaviour on the REAL APIs is UNVERIFIED; this suite
// pins our handling of the documented/fixture shapes, not the live API.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-class-history-secret';

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { getProvider } = require('./providers');
const history = require('./class-history');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

let seq = 0;
function twoGymUser(label) {
  const uid = db.createUser(`hist-${label}-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  db.linkGym(uid, JAB, { encryptedPassword: 'enc:pw' });
  db.setGymSession(uid, PSYCLE, { accessToken: 'mock-jwt-token' });
  db.setGymSession(uid, JAB, { accessToken: 'mock-mt-token' });
  return uid;
}
const rowCount = (uid, gym) => db.db.prepare('SELECT COUNT(*) n FROM class_history WHERE user_id = ? AND gym_id = ?').get(uid, gym).n;

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('CodexFit adapter: paginates fully (120 rows over 2 pages), normalized, v2 envelope', async () => {
  const rows = await getProvider(PSYCLE).listBookingHistory({ accessToken: 'mock-jwt-token' });
  assert.strictEqual(rows.length, 120, 'both pages read');
  assert.ok(rows.every((r) => r.bookingId && r.startAt && /[+-]\d\d:\d\d$|Z$/.test(r.startAt)), 'offset-bearing ISO start');
  assert.ok(rows.every((r) => Date.parse(r.startAt) < Date.now()), 'only past rows');
  assert.ok(rows.every((r) => r.status === 'unconfirmed'), 'live past list has no attendance signal');
  assert.strictEqual(rows[0].instructorName, 'Adam');
  assert.strictEqual(rows[0].timeZone, 'Europe/London');
  const since = new Date(Date.now() - 10 * 864e5).toISOString();
  const recent = await getProvider(PSYCLE).listBookingHistory({ accessToken: 'mock-jwt-token' }, { sinceDate: since });
  assert.ok(recent.length > 0 && recent.length <= 10, `sinceDate bounds the pull (${recent.length})`);
});

check('MarianaTek adapter: paginates via links.next, skips waitlist, maps all statuses', async () => {
  const rows = await getProvider(JAB).listBookingHistory({ accessToken: 'mock-mt-token' });
  assert.strictEqual(rows.length, 113, '120 reservations minus 7 waitlist, across 2 pages');
  const statuses = new Set(rows.map((r) => r.status));
  for (const s of ['attended', 'unconfirmed', 'late-cancel', 'no-show', 'cancelled', 'class-cancelled']) {
    assert.ok(statuses.has(s), `status ${s} present`);
  }
  assert.strictEqual(rows[0].instructorName, 'George Davies');
});

check('sync stores rows; re-sync is idempotent; sync state recorded', async () => {
  const uid = twoGymUser('idem');
  const r1 = await history.syncUserGym(uid, PSYCLE);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(rowCount(uid, PSYCLE), 120);
  const s1 = history.getSyncState(uid, PSYCLE);
  assert.ok(s1.lastSyncedAt && s1.rowCount === 120 && !s1.lastError);
  const r2 = await history.syncUserGym(uid, PSYCLE, { full: true });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(rowCount(uid, PSYCLE), 120, 'no duplicates after a full re-sync');
  const r3 = await history.syncUserGym(uid, PSYCLE); // incremental, overlapping
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(rowCount(uid, PSYCLE), 120, 'no duplicates after an incremental re-sync');
  const one = history.listHistory(uid, PSYCLE, { limit: 1 })[0];
  assert.ok(!('raw' in one), 'stored rows carry no raw');
});

check('class history persists normalized spot label and section metadata', async () => {
  const uid = twoGymUser('spot-section');
  try {
    history.upsertEntries(uid, JAB, [{
      bookingId: 'section-1', eventId: 'class-1', status: 'attended',
      startAt: new Date(Date.now() - 864e5).toISOString(), name: 'Boxing',
      slotLabel: '24', spotSection: 'Ground',
    }]);
    const rows = history.listHistory(uid, JAB, {});
    const saved = rows.find((row) => row.bookingId === 'section-1');
    assert.strictEqual(saved.slotLabel, '24');
    assert.strictEqual(saved.spotSection, 'Ground');
  } finally { db.deleteUser(uid); }
});

check('multi-gym isolation: one user, two gyms, and colliding provider booking ids', async () => {
  const uid = twoGymUser('iso');
  await history.syncUserGym(uid, PSYCLE);
  await history.syncUserGym(uid, JAB);
  assert.strictEqual(rowCount(uid, PSYCLE), 120);
  assert.strictEqual(rowCount(uid, JAB), 113);
  // The SAME provider booking id under two gyms must be two rows, not one.
  const e = { bookingId: 'COLLIDE-1', eventId: 'e', status: 'attended', startAt: new Date(Date.now() - 864e5).toISOString(), instructorId: '1', instructorName: 'X' };
  history.upsertEntries(uid, PSYCLE, [e]);
  history.upsertEntries(uid, JAB, [{ ...e, instructorId: '2', instructorName: 'Y' }]);
  const p = history.listHistory(uid, PSYCLE, { limit: 1000 }).find((r) => r.bookingId === 'COLLIDE-1');
  const j = history.listHistory(uid, JAB, { limit: 1000 }).find((r) => r.bookingId === 'COLLIDE-1');
  assert.strictEqual(p.instructorName, 'X');
  assert.strictEqual(j.instructorName, 'Y');
  // Reads never leak across gyms or users.
  assert.ok(history.listHistory(uid, PSYCLE, { limit: 1000 }).every((r) => r.studioName !== 'BOXING'), 'no JAB rows in Psycle history');
  const other = twoGymUser('iso-other');
  assert.strictEqual(history.listHistory(other, PSYCLE).length, 0, 'other user sees nothing');
  assert.strictEqual(history.getSyncState(other, PSYCLE), null);
});

check('topInstructors: per gym, windowed, ties to most recent', async () => {
  const uid = twoGymUser('top');
  await history.syncUserGym(uid, PSYCLE);
  await history.syncUserGym(uid, JAB);
  const p = history.topInstructors(uid, PSYCLE, { days: 30 });
  const j = history.topInstructors(uid, JAB, { days: 30 });
  assert.strictEqual(p[0].instructorName, 'Adam', 'Psycle top');
  assert.strictEqual(j[0].instructorName, 'George Davies', 'JAB top');
  assert.ok(p[0].count >= (p[1] ? p[1].count : 0));
  const total30 = p.reduce((n, x) => n + x.count, 0);
  assert.ok(total30 <= 30, `window respected (${total30})`);
  // Cancelled classes do not count; tie-break prefers the most recent class.
  const u2 = db.createUser(`hist-tie-${Date.now()}@test.local`, 'enc:pw');
  const t = (d) => new Date(Date.now() - d * 864e5).toISOString();
  history.upsertEntries(u2, PSYCLE, [
    { bookingId: 'a', status: 'attended', startAt: t(10), instructorId: '1', instructorName: 'Old' },
    { bookingId: 'b', status: 'attended', startAt: t(2), instructorId: '2', instructorName: 'Recent' },
    { bookingId: 'c', status: 'cancelled', startAt: t(1), instructorId: '1', instructorName: 'Old' },
    { bookingId: 'd', status: 'attended', startAt: t(60), instructorId: '1', instructorName: 'Old' },
  ]);
  const tie = history.topInstructors(u2, PSYCLE, { days: 30 });
  assert.deepStrictEqual(tie.map((x) => [x.instructorName, x.count]), [['Recent', 1], ['Old', 1]]);
});

check('topInstructors counts distinct classes (multi-slot bookings on one event count once)', async () => {
  const uid = db.createUser(`hist-dup-${Date.now()}@test.local`, 'enc:pw');
  const t = new Date(Date.now() - 864e5).toISOString();
  history.upsertEntries(uid, PSYCLE, [
    { bookingId: 'm1', eventId: 'ev1', status: 'unconfirmed', startAt: t, instructorId: '1', instructorName: 'A' },
    { bookingId: 'm2', eventId: 'ev1', status: 'unconfirmed', startAt: t, instructorId: '1', instructorName: 'A' },
  ]);
  assert.strictEqual(history.topInstructors(uid, PSYCLE)[0].count, 1);
});

check('failed pull is recorded, keeps stored rows, never throws', async () => {
  const uid = twoGymUser('fail');
  await history.syncUserGym(uid, PSYCLE);
  const provider = getProvider(PSYCLE);
  const orig = provider.listBookingHistory;
  provider.listBookingHistory = async () => { const e = new Error('boom'); e.status = 500; throw e; };
  try {
    const r = await history.syncUserGym(uid, PSYCLE);
    assert.strictEqual(r.ok, false);
  } finally { provider.listBookingHistory = orig; }
  const s = history.getSyncState(uid, PSYCLE);
  assert.strictEqual(s.lastError, 'boom');
  assert.ok(s.lastSyncedAt, 'last good sync time preserved');
  assert.strictEqual(rowCount(uid, PSYCLE), 120, 'stored rows untouched');
});

check('unlinking a gym removes its history only; syncing an unlinked gym is refused', async () => {
  const uid = twoGymUser('unlink');
  await history.syncUserGym(uid, PSYCLE);
  await history.syncUserGym(uid, JAB);
  db.unlinkGym(uid, JAB);
  assert.strictEqual(rowCount(uid, JAB), 0);
  assert.strictEqual(history.getSyncState(uid, JAB), null);
  assert.strictEqual(rowCount(uid, PSYCLE), 120);
  const r = await history.syncUserGym(uid, JAB);
  assert.strictEqual(r.ok, false);
});

check('syncStale scans every gym of every user, not just the active gym', async () => {
  const uid = twoGymUser('stale');
  assert.strictEqual(db.resolveActiveGymId(uid), PSYCLE);
  await history.syncStale({ maxAgeMs: 1 });
  assert.strictEqual(rowCount(uid, JAB), 113, 'non-active gym synced by the background scan');
  assert.strictEqual(rowCount(uid, PSYCLE), 120);
});

check('GET /api/history: gym via x-gym-id, lazy backfill, normalized, no raw; 400 without a gym', async () => {
  const router = require('./routes-normalized');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const uid = twoGymUser('route');
    const token = jwt.sign({ userId: uid, email: 'x@test.local' }, process.env.JWT_SECRET);
    const get = (path, gym) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, ...(gym ? { 'x-gym-id': gym } : {}) } });
    assert.strictEqual(rowCount(uid, JAB), 0, 'not synced before first read');
    const res = await get('/history?days=30&limit=5&top=3', JAB);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.gymId, JAB);
    assert.strictEqual(body.history.length, 5);
    assert.ok(body.history.every((r) => !('raw' in r)));
    assert.strictEqual(body.topInstructors[0].instructorName, 'George Davies');
    assert.ok(body.sync.lastSyncedAt);
    assert.strictEqual(rowCount(uid, PSYCLE), 0, 'other gym untouched');
    const bare = await get('/history');
    assert.strictEqual(bare.status, 400);
    assert.strictEqual((await bare.json()).code, 'GYM_REQUIRED');
  } finally { server.close(); }
});

check('getMilestones: CodexFit normalizes the live /milestones envelope; capability gates the route', async () => {
  const t = await getProvider(PSYCLE).getMilestones({ accessToken: 'mock-jwt-token' });
  assert.strictEqual(t.attendedTotal, 129);
  assert.deepStrictEqual([t.thisWeek, t.thisMonth, t.thisYear], [1, 4, 31]);
  assert.strictEqual(t.milestones.length, 8);
  assert.ok(t.milestones.find((m) => m.threshold === 100).earned && !t.milestones.find((m) => m.threshold === 1000).earned);
  assert.ok(t.milestones.every((m) => !('raw' in m)));
  await assert.rejects(() => getProvider(JAB).getMilestones({ accessToken: 'x' }), /not implemented|getMilestones/i);
  const router = require('./routes-normalized');
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const uid = twoGymUser('milestones');
    const token = jwt.sign({ userId: uid, email: 'x@test.local' }, process.env.JWT_SECRET);
    const get = (gym) => fetch(`http://127.0.0.1:${server.address().port}/api/attendance-totals`, { headers: { authorization: `Bearer ${token}`, 'x-gym-id': gym } });
    const ok = await get(PSYCLE);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).attendedTotal, 129);
    const no = await get(JAB);
    assert.strictEqual(no.status, 501);
    assert.strictEqual((await no.json()).code, 'CAPABILITY_UNSUPPORTED');
  } finally { server.close(); }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
  }
  console.log(`${passed}/${checks.length} class-history checks passed`);
  process.exit(process.exitCode || 0);
})();
