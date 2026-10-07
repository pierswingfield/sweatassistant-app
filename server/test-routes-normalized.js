// routes-normalized.js 401-relogin ladder regression test.
//
// WP-N1's routes-normalized.js originally had NO 401 auto-relogin retry (a
// documented gap in its own header comment) — a session that went stale mid-
// request surfaced as a plain error instead of transparently recovering, the
// way server.js's proxyRequest / scheduler.js / poller.js / calendar.js's own
// ladders already do. This test proves the fix (withRelogin(), exported
// alongside the router for testability, same rationale calendar.js exports
// listWithRelogin): a provider call that signals a 401 gets exactly one
// relogin + retry, and any other failure propagates untouched.
//
// Provider calls signal a 401 two different ways depending on the underlying
// adapter method's contract (see routes-normalized.js's header comment):
//   - throwing an Error with `.status === 401` (reads: fetchTimetable,
//     fetchEventDetails, getProfile, getCancelPenalty, listBookings,
//     listWaitlists)
//   - resolving with `.status === 401` on the returned object (writes:
//     bookSlot, swapSpots — NormalizedBookingResult)
// Both paths are exercised here, plus a non-401 failure to prove it's not
// retried blindly.
//
// SAFETY: isolated temp DB, no live network access. codexfit.login() is
// stubbed for the duration of the relogin assertions — triggerAutoRelogin
// always does a real provider login (no dev@psycle.com bypass inside
// codexfit.login itself, only inside handleLogin), so leaving it unstubbed
// would attempt a real outbound request. Same technique as
// test-calendar-feed.js's own 401-ladder test.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `routes-normalized-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('./db');
const { encrypt } = require('./crypto');
const { getProvider } = require('./providers');
const { withRelogin } = require('./routes-normalized');

const codexfit = getProvider('psycle-london');

function cleanup() {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
}

(async () => {
  let failed = 0;
  console.log('\n🧪 routes-normalized.js 401-relogin ladder regression\n');
  try {
    // A real encrypted password — triggerAutoRelogin decrypt()s this for real.
    const userId = db.createUser('dev@psycle.com', encrypt('dev-password'));
    db.updateUserJWT(userId, 'stale-mock-jwt-token', new Date(Date.now() + 864e5).toISOString());

    const originalLogin = codexfit.login;
    codexfit.login = async () => ({
      session: { accessToken: 'fresh-mock-token' },
      profile: {},
      raw: { access_token: 'fresh-mock-token', user: {} },
    });

    try {
      // --- 1. throw-based 401 (read-method convention) -----------------------
      let calls = 0;
      const thrower = async (s) => {
        calls += 1;
        if (calls === 1) {
          assert.strictEqual(s.accessToken, 'stale-mock-jwt-token', 'first attempt uses the caller-supplied session');
          const err = new Error('mock 401');
          err.status = 401;
          throw err;
        }
        assert.strictEqual(s.accessToken, 'fresh-mock-token', 'retry uses the freshly-relogged-in token');
        return ['ok'];
      };
      const result1 = await withRelogin(userId, { accessToken: 'stale-mock-jwt-token' }, thrower);
      assert.deepStrictEqual(result1, ['ok']);
      assert.strictEqual(calls, 2, 'thrower called exactly twice: stale-token 401, then fresh-token success');
      assert.strictEqual(db.getUserById(userId).jwt, 'fresh-mock-token', 'triggerAutoRelogin persisted the fresh token');
      console.log('✅ throw-based 401 (fetchTimetable/fetchEventDetails/getProfile/getCancelPenalty/listBookings/listWaitlists convention) triggers relogin + retries exactly once.');

      // --- 2. result.status-based 401 (write-method convention) --------------
      db.updateUserJWT(userId, 'stale-mock-jwt-token-2', new Date(Date.now() + 864e5).toISOString());
      calls = 0;
      const declines = async (s) => {
        calls += 1;
        if (calls === 1) {
          assert.strictEqual(s.accessToken, 'stale-mock-jwt-token-2');
          return { ok: false, status: 401 };
        }
        assert.strictEqual(s.accessToken, 'fresh-mock-token', 'retry uses the freshly-relogged-in token');
        return { ok: true, bookingId: '1' };
      };
      const result2 = await withRelogin(userId, { accessToken: 'stale-mock-jwt-token-2' }, declines);
      assert.deepStrictEqual(result2, { ok: true, bookingId: '1' });
      assert.strictEqual(calls, 2, 'declines called exactly twice: stale-token 401 result, then fresh-token success');
      console.log('✅ result.status===401 (bookSlot/swapSpots convention) triggers relogin + retries exactly once.');
    } finally {
      codexfit.login = originalLogin;
    }

    // --- 3. non-401 errors are NOT retried -------------------------------------
    let calls3 = 0;
    const otherError = async () => { calls3 += 1; throw new Error('boom'); };
    await assert.rejects(() => withRelogin(userId, { accessToken: 'whatever' }, otherError), /boom/);
    assert.strictEqual(calls3, 1, 'non-401 errors propagate immediately, no relogin/retry attempted');
    console.log('✅ non-401 failures are not treated as a relogin signal (no retry, no relogin attempted).');

    console.log('\n🎉 ROUTES-NORMALIZED RELOGIN LADDER CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ routes-normalized relogin test FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
