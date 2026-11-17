// Booking-window regression suite.
//
// Psycle changed its booking window on/around 2026-08-31: the standard window
// moved from 8 days after the release Monday to a fortnight ("an additional six
// days"), and membership tiers now extend it by DAYS rather than whole weeks
// (Psycle 10 +2d → Thursday, Psycle 15 +3d → Friday, Unlimited +8d).
//
// The old code snapped every detected window to a whole-week tier (8/15/22/29).
// Under the new rules that is wrong for three of the four tiers — and wrong in
// BOTH directions, which is why this suite exists:
//
//   true 14 → used 15   standard over-runs by a day; auto-book can compute an
//                       earlier release Monday for a boundary class and fire a
//                       week early, burning the queue entry on a closed window
//   true 16 → used 15   Psycle 10 truncated by 1 day (loses Thursday)
//   true 17 → used 15   Psycle 15 truncated by 2 days (loses Thu + Fri)
//   true 22 → used 22   Unlimited unaffected (coincidentally a whole week)
//
// Two things are pinned here:
//   1. Detection passes the profile's exact day count through, unsnapped.
//   2. The client holds no copy of this arithmetic (it reads the server-stamped
//      releaseAt), so there is nothing to drift.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- 1. server-side offsets ------------------------------------------------

const scheduler = require('./scheduler');

check('server: detected offset is used verbatim — no whole-week snapping', () => {
  for (const days of [14, 15, 16, 17, 18, 21, 22]) {
    assert.strictEqual(
      scheduler.getBookingOffset({ detectedBookingOffset: days }), days,
      `offset ${days} must pass through unchanged`);
  }
});

check('server: the four real Psycle tiers all resolve exactly', () => {
  const tiers = { 'standard (fortnight)': 14, 'Psycle 10': 16, 'Psycle 15': 17, 'Unlimited': 22 };
  for (const [label, days] of Object.entries(tiers)) {
    assert.strictEqual(scheduler.getBookingOffset({ detectedBookingOffset: days }), days, label);
  }
});

check('server: legacy fallback base is 15 — the window ends on a Tuesday', () => {
  // Corrected 2026-09-01 (was 14). Booking for any given Tuesday opens on the
  // Monday, so the cutoff is releaseMonday + 15 (M+14 is a Monday). The retired
  // 8-day base had the same alignment: M+8 is also a Tuesday. A 14 here silently
  // held Tuesday classes back a whole extra week on the standard tier.
  assert.strictEqual(scheduler.getBookingOffset({}), 15, 'cold-start default');
  assert.strictEqual(scheduler.getBookingOffset({ advancedBooking: true }), 22);
});

check('server: an absurd stored offset is clamped, not trusted', () => {
  assert.strictEqual(scheduler.getBookingOffset({ detectedBookingOffset: 9999 }), 35);
  // 0 and negatives fall through to the legacy path (the `> 0` guard), not to a
  // clamp — asserted so a future refactor doesn't silently change which wins.
  assert.strictEqual(scheduler.getBookingOffset({ detectedBookingOffset: 0 }), 15);
});

check('server: debug day-override beats the week-override and detection', () => {
  const s = { debugMode: true, manualBookingWindowDays: 17, manualBookingWindowWeeks: 3, detectedBookingOffset: 22 };
  assert.strictEqual(scheduler.getBookingOffset(s), 17, 'exact-day override wins');
  assert.strictEqual(
    scheduler.getBookingOffset({ debugMode: true, manualBookingWindowWeeks: 3, detectedBookingOffset: 14 }), 22,
    'week override still works when no day override is set');
  assert.strictEqual(
    scheduler.getBookingOffset({ manualBookingWindowDays: 17, detectedBookingOffset: 14 }), 14,
    'overrides are inert without debugMode');
});

// --- 2. the client holds no copy of the policy ------------------------------

check('client lib.js no longer duplicates the booking-window policy', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'client', 'src', 'lib.js'), 'utf8');
  for (const name of ['detectBookingWindow', 'getBookingOffset', 'getMostRecentReleaseMonday', 'getNextMondayNoonLondon']) {
    assert.ok(!src.includes(name), `client/src/lib.js must not define ${name}: the server stamps releaseAt`);
  }
  assert.ok(!/Europe\/London/.test(src), 'client/src/lib.js must carry no London policy zone');
});

// --- runner ------------------------------------------------------------------

(async () => {
  console.log('\n🧪 Booking-window tests (post-2026-08-31 Psycle window change)\n');
  let failed = 0, passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (err) { failed++; console.error(`❌ ${name}\n   ${err.message}`); }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} booking-window checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
