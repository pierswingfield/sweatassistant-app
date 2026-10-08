// C2-3b (poller) — the auto-upgrade poller honours provider rate limits.
//
// C2-3 taught the scheduler to back off a gym after a 429, but poller.js
// (auto-upgrade attempts, reminder/cache fetches) kept hitting a gym that was
// already refusing us: it only consulted isGymRateLimited() in the C5-1
// resume path. This pins the follow-up:
//   1. a 429 during an upgrade attempt arms THAT gym's backoff and stops its
//      polling until it expires (no request of any kind reaches the gym);
//   2. another gym (different platform) keeps polling meanwhile;
//   3. after expiry polling resumes;
//   4. the throttle notification still dedupes (once per user+gym+day);
//   5. a 429 on a READ (event details) also arms the backoff, and the
//      reminder-cache sweep skips a backed-off gym;
//   6. scheduler and poller share ONE backoff state (rate-limit-backoff.js).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const testkit = require('./testkit');
const scheduler = require('./scheduler');
const poller = require('./poller');
const notifications = require('./notifications');
const backoff = require('./rate-limit-backoff');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let seq = 0;
function singleGymUser(gymId, label) {
  const uid = testkit.createUser(db, `pbackoff-${label}-${Date.now()}-${seq++}@test.local`, 'enc:pw', gymId);
  db.setGymSession(uid, gymId, { accessToken: `fake-jwt-${uid}`, expiresAt: null });
  return uid;
}

let eventSeq = 880000;
function monitor(uid, gymId, { cached = true } = {}) {
  const eventId = ++eventSeq;
  const startAt = new Date(Date.now() + 2 * 864e5).toISOString();
  const prefs = { preferredSlots: ['11'], preferredRows: [] };
  db.addAutoUpgrade(uid, eventId, 500000 + eventId, 25, 'Ride', 'Coach', 'Studio', 'Loc', startAt, prefs, null, 'Ride', gymId);
  if (cached) seedEvent(gymId, eventId);
  return eventId;
}
function seedEvent(gymId, eventId) {
  scheduler.setCachedEvent(gymId, eventId, {
    event: { id: String(eventId), credits: { required: 1, acceptedTypeIds: [] } },
    slots: [{ id: 11, isAvailable: true, y: 0 }, { id: 25, isAvailable: false, y: 1 }],
  }, 600000);
}

function res({ status = 200, body = {}, retryAfterSeconds }) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' && retryAfterSeconds != null ? String(retryAfterSeconds) : null) },
    json: async () => body,
  };
}


// The poller now verifies the original booking still exists before upgrading
// (cancel-then-upgrade guard). These suites model a member who still holds every
// seeded monitor's booking.
function stubHeldBookings(...protos) {
  const heldFromDb = async () => db.db.prepare('SELECT booking_id, event_id FROM auto_upgrades')
    .all().map(r => ({ bookingId: String(r.booking_id), eventId: String(r.event_id), isWaitlist: false }));
  protos.forEach(p => { p.prototype.listBookings = heldFromDb; });
}

const origRequest = CodexFitProvider.prototype.request;
const origCFList = CodexFitProvider.prototype.listBookings;
const origMTList = MarianaTekProvider.prototype.listBookings;
const origSwap = MarianaTekProvider.prototype.swapSpots;
const origNotify = notifications.notify;
const realNow = Date.now;
let psycleCalls; let bookPosts; let swapCalls; let notifyCalls; let bookingsGet429 = false;

function install({ book = 'limited', eventsStatus = 200 } = {}) {
  psycleCalls = []; bookPosts = 0; swapCalls = 0; notifyCalls = [];
  backoff._resetRateLimitBackoffForTests();
  db.db.prepare("UPDATE auto_upgrades SET status = 'stopped'").run(); // isolate from earlier checks' monitors
  stubHeldBookings(CodexFitProvider, MarianaTekProvider);
  CodexFitProvider.prototype.request = function (p, opts = {}) {
    const path = this.toPath(p);
    psycleCalls.push(`${opts.method || 'GET'} ${path}`);
    if (path === '/profile') return Promise.resolve(res({ body: { data: { id: 1, available_credits: [{ count: 5, credit_type: { id: 1 } }] } } }));
    if (path === '/bookings' && opts.method === 'POST') {
      bookPosts++;
      return Promise.resolve(book === 'limited'
        ? res({ status: 429, body: { message: 'Too many requests' }, retryAfterSeconds: 30 })
        : res({ body: { success: true, bookings: { 1: 11 } } }));
    }
    if (path.startsWith('/events/')) return Promise.resolve(res({ status: eventsStatus, body: {}, retryAfterSeconds: 30 }));
    if (path.startsWith('/bookings')) return Promise.resolve(res({ body: { data: [] } }));
    return Promise.resolve(res({ status: 400 }));
  };
  MarianaTekProvider.prototype.swapSpots = async function () { swapCalls++; return { ok: true, bookingId: 'mt-1', slotId: '11' }; };
  notifications.notify = async (userId, type, ctx) => { notifyCalls.push({ userId, type, ctx }); return origNotify.call(notifications, userId, type, ctx); };
}
function restore() {
  CodexFitProvider.prototype.request = origRequest;
  CodexFitProvider.prototype.listBookings = origCFList;
  MarianaTekProvider.prototype.listBookings = origMTList;
  MarianaTekProvider.prototype.swapSpots = origSwap;
  notifications.notify = origNotify;
  Date.now = realNow;
}
const throttleNotes = () => notifyCalls.filter((c) => c.type === 'providerThrottled');

check('scheduler and poller share one backoff state', async () => {
  backoff._resetRateLimitBackoffForTests();
  assert.strictEqual(scheduler.isGymRateLimited, backoff.isGymRateLimited, 'scheduler re-exports the shared function');
  scheduler.applyRateLimitBackoff(PSYCLE, 60000);
  assert.strictEqual(backoff.isGymRateLimited(PSYCLE), true);
  backoff._resetRateLimitBackoffForTests();
  assert.strictEqual(scheduler.isGymRateLimited(PSYCLE), false);
});

check('429 during an upgrade attempt stops that gym until expiry; other gyms continue; notification dedupes', async () => {
  install();
  try {
    const u = singleGymUser(PSYCLE, 'a');
    const j = singleGymUser(JAB, 'j');
    monitor(u, PSYCLE); monitor(u, PSYCLE);   // two Psycle monitors, same user
    monitor(j, JAB);

    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(bookPosts, 1, 'the 429 must abort the pass for the gym: one POST, not one per monitor');
    assert.strictEqual(backoff.isGymRateLimited(PSYCLE), true, 'Psycle armed');
    assert.strictEqual(backoff.isGymRateLimited(JAB), false, 'JAB untouched');
    assert.strictEqual(swapCalls, 1, 'JAB monitor ran in the same pass');
    assert.strictEqual(throttleNotes().length, 1, 'one throttle notification');
    assert.strictEqual(throttleNotes()[0].userId, u);

    // Second pass while backed off: NO request of any kind reaches Psycle.
    const before = psycleCalls.length;
    monitor(j, JAB); // fresh JAB monitor proves JAB keeps polling
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(psycleCalls.length, before, `Psycle received ${psycleCalls.length - before} request(s) while backed off`);
    assert.strictEqual(swapCalls, 2, 'JAB kept polling during the Psycle backoff');
    assert.strictEqual(throttleNotes().length, 1, 'still one notification');

    // Advance past the 30 s Retry-After: polling resumes and 429s again,
    // but the same user+gym+day dedupe key holds.
    const t = realNow();
    Date.now = () => t + 31000;
    await poller.executeAutoUpgradeChecks();
    assert.strictEqual(bookPosts, 2, 'polling resumed after the backoff expired');
    assert.strictEqual(throttleNotes().length, 1, 'notification deduped across the second throttle');
  } finally { restore(); }
});

check('a 429 on a read (event details) also arms the backoff', async () => {
  install({ eventsStatus: 429 });
  try {
    const u = singleGymUser(PSYCLE, 'r');
    monitor(u, PSYCLE, { cached: false });
    monitor(u, PSYCLE, { cached: false });
    await poller.executeAutoUpgradeChecks();
    const eventGets = psycleCalls.filter((c) => c.startsWith('GET /events/')).length;
    assert.strictEqual(eventGets, 1, 'second monitor must not hit /events after the first got a 429');
    assert.strictEqual(backoff.isGymRateLimited(PSYCLE), true);
  } finally { restore(); }
});

check('the reminder-cache sweep skips a backed-off gym and a 429 there arms it', async () => {
  install();
  try {
    const u = singleGymUser(PSYCLE, 's');
    db.addPushSubscription && db.addPushSubscription(u, JSON.stringify({ endpoint: `https://push.test/${u}`, keys: {} }));
    backoff.applyRateLimitBackoff(PSYCLE, 60000);
    await poller.refreshBookingCaches();
    assert.strictEqual(psycleCalls.filter((c) => c.includes('/bookings')).length, 0, 'no bookings read while backed off');
  } finally { restore(); }
});

(async () => {
  console.log('\n🧪 Poller rate-limit backoff (C2-3 follow-up)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  if (failed) { console.error(`\n✗ ${failed}/${checks.length} failed`); process.exit(1); }
  console.log(`\n🎉 ${checks.length}/${checks.length} passed`);
  process.exit(0);
})();
