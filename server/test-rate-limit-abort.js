// C2-3 — rate-limit distress abort.
//
// Before this test existed, nothing in providers/codexfit.js or scheduler.js
// recognized a 429 (or a throttle-shaped 403) at all: a rate-limited/blocked
// provider response was treated exactly like "slot taken" (see the old
// `else { burn the slot }` branch in executeAutoBookForClass), so the
// scheduler kept POSTing through a block instead of backing off. Confirmed by
// reading providers/codexfit.js bookSlot() and scheduler.js's dispatch loop
// (2026-09-26): no code path checked for 429/403 anywhere in either file.
//
// This asserts the fix end-to-end for ONE gym (real CodexFitProvider.request()
// stubbed to return a real 429 Response shape, so classifyProviderThrottle()
// in providers/base.js and its wiring into codexfit.js bookSlot() are
// exercised for real, not just the scheduler reaction) while a SECOND gym on a
// DIFFERENT platform (MarianaTek/JAB) dispatches normally in the same run —
// the mechanism must be gym-keyed, never global and never platform-specific
// (WP-D7/WP-G).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('./db');
const scheduler = require('./scheduler');
const notifications = require('./notifications');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');
const { DEFAULT_GYM_ID } = require('./gyms.config');

const PSYCLE = 'psycle-london'; // codexfit — the gym we rate-limit
const JAB = 'jab-boxing';       // marianatek — must be unaffected
db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run(JAB);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let seq = 0;
// One gym per user (rather than reusing test-wake-clock's twoGymUser helper)
// so db.getUserById()'s active-gym resolution ("their sole linked gym") hands
// bookSlotWithRelogin the right session with no ambiguity — that resolution
// order is a different concern (db.js resolveActiveGymId) and not what this
// test is about.
function singleGymUser(gymId, label) {
  const uid = db.createUser(`ratelimit-${label}-${Date.now()}-${seq++}@test.local`, 'enc:pw');
  if (gymId !== DEFAULT_GYM_ID) {
    db.db.prepare('DELETE FROM user_gyms WHERE user_id = ? AND gym_id = ?').run(uid, DEFAULT_GYM_ID);
    db.upsertUserGym(uid, gymId, { gym_email: `${label}@test.local`, encrypted_password: 'enc:pw' });
  }
  db.setGymSession(uid, gymId, { accessToken: `fake-jwt-${uid}`, expiresAt: null });
  return uid;
}

function bookingRow(userId, gymId, eventId, slotId) {
  return {
    user_id: userId,
    gym_id: gymId,
    event_id: eventId,
    studio_id: null,
    start_at: new Date(Date.now() + 3 * 864e5).toISOString(),
    group_name: 'Group',
    class_name: 'Class',
    instructor_name: 'Coach',
    preferences: JSON.stringify({ preferredSlots: [slotId], requiredCount: 1, bookAny: true }),
  };
}

// Pre-populate the shared event cache so executeAutoBookForClass never makes a
// real network call for /events/:id — only /bookings (the call we're testing)
// is exercised.
function seedEventCache(gymId, eventId, slotId) {
  scheduler.setCachedEvent(gymId, eventId, {
    event: { id: eventId },
    slots: [{ id: slotId, label: String(slotId), isAvailable: true }],
    objects: [],
  }, 60000);
}

// A minimal, real-shaped fetch Response for a 429 — exercises the actual
// classifyProviderThrottle() header/body inspection, not a shortcut.
function fakeResponse({ status, message, retryAfterSeconds }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' && retryAfterSeconds != null ? String(retryAfterSeconds) : null) },
    json: async () => ({ success: false, message }),
  };
}

// Stubs CodexFitProvider.prototype.request for the duration of one check.
// `bookingsResponse` answers /bookings; every OTHER path (notably the
// waitlist-fallback PUT that a failed booking triggers) gets a generic
// failure — this must NEVER fall through to a real fetch(), per the hard rule
// against live gym traffic in this pass.
function stubCodexRequest(bookingsResponse) {
  CodexFitProvider.prototype.request = function (pathOrUrl) {
    const path = this.toPath(pathOrUrl);
    if (path.startsWith('/bookings')) return Promise.resolve(bookingsResponse());
    return Promise.resolve(fakeResponse({ status: 400, message: 'stubbed: no live traffic in this test' }));
  };
}
function unstubCodexRequest() {
  CodexFitProvider.prototype.request = originalCodexRequest;
}

let notifyCalls;
const originalNotify = notifications.notify;
function installNotifySpy() {
  notifyCalls = [];
  notifications.notify = async (userId, type, ctx) => {
    notifyCalls.push({ userId, type, ctx });
    return originalNotify.call(notifications, userId, type, ctx);
  };
}
function restoreNotify() {
  notifications.notify = originalNotify;
}

const originalCodexRequest = CodexFitProvider.prototype.request;
const originalMTBookSlot = MarianaTekProvider.prototype.bookSlot;

function reset() {
  scheduler._resetRateLimitBackoffForTests();
  installNotifySpy();
}

// --- 1. a 429 on /bookings backs off, aborts, and notifies once -------------

check('a 429 from the provider stops dispatch for that gym, backs off, and notifies once (deduped)', async () => {
  reset();
  const uid = singleGymUser(PSYCLE, 'a');
  const eventId = 990001;
  seedEventCache(PSYCLE, eventId, 501);

  let bookingsCallCount = 0;
  stubCodexRequest(() => {
    bookingsCallCount++;
    return fakeResponse({ status: 429, message: 'Too many requests', retryAfterSeconds: 30 });
  });

  try {
    assert.strictEqual(scheduler.isGymRateLimited(PSYCLE), false, 'no backoff should be armed yet');

    await scheduler.executeAutoBookForClass(bookingRow(uid, PSYCLE, eventId, 501));

    assert.strictEqual(bookingsCallCount, 1, 'exactly one /bookings POST — the 429 must not be retried in-process');
    assert.strictEqual(scheduler.isGymRateLimited(PSYCLE), true, 'the gym should now be in backoff');

    assert.strictEqual(notifyCalls.length, 1, 'exactly one notification should have been sent');
    assert.strictEqual(notifyCalls[0].type, 'providerThrottled');
    assert.strictEqual(notifyCalls[0].userId, uid);

    // A second attempt for the SAME gym, started while backoff is in effect,
    // must not even reach the provider — this is the "stop dispatch" half.
    const eventId2 = 990002;
    seedEventCache(PSYCLE, eventId2, 502);
    await scheduler.executeAutoBookForClass(bookingRow(uid, PSYCLE, eventId2, 502));
    assert.strictEqual(bookingsCallCount, 1, 'a second class for the same rate-limited gym must not POST at all');

    // And the notification must have deduped — still exactly one sent.
    assert.strictEqual(notifyCalls.length, 1, 'a repeat trigger for the same gym/day must not re-notify');
  } finally {
    unstubCodexRequest();
    restoreNotify();
  }
});

// --- 2. a different gym, different platform, is unaffected -------------------

check('a rate limit on one gym does not affect another gym (different platform)', async () => {
  reset();
  // Arm backoff on PSYCLE directly (no network involved) to isolate this case
  // from case 1's timing.
  scheduler.applyRateLimitBackoff(PSYCLE, 60000);

  const uidJab = singleGymUser(JAB, 'b');
  const eventId = 990003;
  seedEventCache(JAB, eventId, 7);

  let mtCalls = 0;
  MarianaTekProvider.prototype.bookSlot = async function () {
    mtCalls++;
    return { ok: true, bookingId: 'mt-1', slotId: '7' };
  };

  try {
    assert.strictEqual(scheduler.isGymRateLimited(JAB), false, 'JAB must not inherit Psycle\'s backoff — keys are per gym');
    await scheduler.executeAutoBookForClass(bookingRow(uidJab, JAB, eventId, 7));
    assert.strictEqual(mtCalls, 1, 'JAB dispatch must proceed normally while Psycle is backed off');
  } finally {
    MarianaTekProvider.prototype.bookSlot = originalMTBookSlot;
  }
});

// --- 3. a plain 403 (no throttle signal) is NOT classified as rate limiting --

check('an ordinary 403 (no Retry-After, no throttle language) is left as a normal failure', async () => {
  reset();
  const uid = singleGymUser(PSYCLE, 'c');
  const eventId = 990004;
  seedEventCache(PSYCLE, eventId, 503);

  stubCodexRequest(() => fakeResponse({ status: 403, message: 'You are not eligible to book this class.' }));

  try {
    await scheduler.executeAutoBookForClass(bookingRow(uid, PSYCLE, eventId, 503));
    assert.strictEqual(scheduler.isGymRateLimited(PSYCLE), false, 'an ordinary permission 403 must not trip the gym-wide backoff');
    assert.strictEqual(notifyCalls.length, 0, 'no rate-limit notification for an ordinary 403');
  } finally {
    unstubCodexRequest();
    restoreNotify();
  }
});

// --- 4. a throttle-shaped 403 IS classified as rate limiting -----------------

check('a 403 with throttle language IS classified as rate limiting', async () => {
  reset();
  const uid = singleGymUser(PSYCLE, 'd');
  const eventId = 990005;
  seedEventCache(PSYCLE, eventId, 504);

  stubCodexRequest(() => fakeResponse({ status: 403, message: 'Too many requests — temporarily blocked.' }));

  try {
    await scheduler.executeAutoBookForClass(bookingRow(uid, PSYCLE, eventId, 504));
    assert.strictEqual(scheduler.isGymRateLimited(PSYCLE), true, 'a throttle-worded 403 must trip the backoff same as a 429');
    assert.strictEqual(notifyCalls.length, 1);
  } finally {
    unstubCodexRequest();
    restoreNotify();
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err.stack || err.message}`);
    }
  }
  CodexFitProvider.prototype.request = originalCodexRequest;
  MarianaTekProvider.prototype.bookSlot = originalMTBookSlot;
  restoreNotify();
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} rate-limit-abort checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} rate-limit-abort checks passed.`);
})();
