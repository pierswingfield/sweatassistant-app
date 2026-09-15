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
//   2. The server's getBookingOffset stays equivalent to the client's. They are
//      hand-mirrored in two languages' worth of module systems; a divergence
//      means the countdown the user watches and the instant auto-book fires
//      disagree, which is invisible until a Monday goes wrong.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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

// --- 2. client/server parity ------------------------------------------------

check('client and server getBookingOffset agree on every case that matters', async () => {
  let lib;
  try {
    const libUrl = pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib.js')).href;
    lib = await import(libUrl);
  } catch (_) {
    console.log('       ℹ️  Skipping client lib parity check (client dependencies not available in server container)');
    return;
  }

  const cases = [
    {}, // cold start
    { advancedBooking: true },
    { advancedBooking: true, advancedBookingCredit: true },
    { detectedBookingOffset: 14 },
    { detectedBookingOffset: 16 },
    { detectedBookingOffset: 17 },
    { detectedBookingOffset: 22 },
    { detectedBookingOffset: 9999 },
    { detectedBookingOffset: 0 },
    { debugMode: true, manualBookingWindowDays: 17 },
    { debugMode: true, manualBookingWindowWeeks: 3 },
    { debugMode: true, manualBookingWindowWeeks: 2, detectedBookingOffset: 16 },
    { manualBookingWindowDays: 17, detectedBookingOffset: 14 },
  ];
  for (const c of cases) {
    assert.strictEqual(
      scheduler.getBookingOffset(c), lib.getBookingOffset(c),
      `client/server divergence for ${JSON.stringify(c)}`);
  }
});

check('client: detectBookingWindow reports the profile cutoff exactly, unsnapped', async () => {
  let lib;
  try {
    const libUrl = pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib.js')).href;
    lib = await import(libUrl);
  } catch (_) {
    return;
  }
  const release = lib.getMostRecentReleaseMonday();

  // Build a profile whose cutoff sits exactly N days after the release Monday.
  const profileAt = (days) => ({ booking_cutoff: release.plus({ days }).toISO() });

  for (const days of [14, 16, 17, 22]) {
    const got = lib.detectBookingWindow(profileAt(days), []);
    assert.ok(got, `detection should succeed for a ${days}-day cutoff`);
    assert.strictEqual(got.offsetDays, days,
      `a ${days}-day cutoff must detect as ${days} days, not the nearest week`);
  }

  // The member tiers used to collapse onto 15. Pin that they no longer do.
  assert.notStrictEqual(lib.detectBookingWindow(profileAt(16), []).offsetDays, 15);
  assert.notStrictEqual(lib.detectBookingWindow(profileAt(17), []).offsetDays, 15);
  assert.strictEqual(lib.detectBookingWindow(profileAt(14), []).offsetDays, 14,
    'standard must not round UP to 15 — that fires auto-book early');
});

check('client: extended_cutoff wins over booking_cutoff when extended booking is allowed', async () => {
  let lib;
  try {
    const libUrl = pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib.js')).href;
    lib = await import(libUrl);
  } catch (_) {
    return;
  }
  const release = lib.getMostRecentReleaseMonday();
  const got = lib.detectBookingWindow({
    booking_cutoff: release.plus({ days: 14 }).toISO(),
    extended_cutoff: release.plus({ days: 17 }).toISO(),
    metafields: { extended_booking_allowed: true },
  }, []);
  assert.strictEqual(got.offsetDays, 17, 'a Psycle 15 member books to Friday, not the standard fortnight');
  assert.strictEqual(got.source, 'extended');
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
