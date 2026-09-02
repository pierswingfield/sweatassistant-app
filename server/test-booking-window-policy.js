// Booking-window policy-split equivalence suite (WP-D8).
//
// The window model moved out of shared code and split across two layers:
//   providers/codexfit.js   — WHERE CodexFit exposes its cutoff fields (protocol)
//   gyms.config.js          — WHAT the cutoff means for Psycle (policy)
//   providers/booking-window.js — evaluates a policy (platform-agnostic)
//
// This is the highest-risk change in the whole phase. Auto-book fires at the
// instant this computes; a one-week error means the queue entry burns on a
// closed window, and a silent one — nobody sees a wrong countdown until Monday.
//
// So the bar here is not "the new code looks right". It is: for every class
// datetime and every offset, the composed result must be IDENTICAL to the
// algorithm that shipped. The original is reimplemented at the bottom of this
// file, verbatim from scheduler.js as of 2026-08-31, and the two are compared
// across a wide sweep including DST boundaries.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const { DateTime } = require('luxon');
const { getProvider } = require('./providers');
const { GYMS } = require('./gyms.config');
const bw = require('./providers/booking-window');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const psycle = getProvider('psycle-london');
const jab = getProvider('jab-boxing');
const PSYCLE_POLICY = GYMS['psycle-london'].bookingWindow;

// --- The original algorithm, verbatim from scheduler.js (2026-08-31) ---------
// Deliberately duplicated rather than imported: importing the thing under test
// as its own oracle proves nothing.
function originalGetClassReleaseTime(classDateStr, daysToAdd) {
  const classDt = DateTime.fromISO(classDateStr, { zone: 'Europe/London' });
  let M = classDt.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  while (true) {
    const cutoff = M.plus({ days: daysToAdd }).set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    if (cutoff < classDt) { M = M.plus({ weeks: 1 }); break; }
    M = M.minus({ weeks: 1 });
  }
  return M.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
}

// --- 1. exhaustive equivalence ----------------------------------------------

check('composed releaseAt matches the original for every day of a year × every tier', () => {
  // Every real tier plus the clamp edges. 14 = standard, 16/17 = Psycle 10/15,
  // 22 = Unlimited, 15 = the credit floor.
  const offsets = [1, 8, 14, 15, 16, 17, 18, 21, 22, 29, 35];
  let compared = 0;
  const mismatches = [];

  let d = DateTime.fromISO('2026-01-01T00:00:00', { zone: 'Europe/London' });
  const end = DateTime.fromISO('2027-01-01T00:00:00', { zone: 'Europe/London' });
  while (d < end) {
    // Three times of day, including either side of the BST switch hours.
    for (const hour of [0, 12, 23]) {
      const startAt = d.set({ hour, minute: 30 }).toISO();
      for (const offsetDays of offsets) {
        const expected = originalGetClassReleaseTime(startAt, offsetDays);
        const actual = psycle.releaseAtFor(startAt, { offsetDays });
        compared++;
        if (DateTime.fromISO(actual).toMillis() !== expected.toMillis()) {
          if (mismatches.length < 5) mismatches.push({ startAt, offsetDays, expected: expected.toISO(), actual });
        }
      }
    }
    d = d.plus({ days: 1 });
  }
  assert.deepStrictEqual(mismatches, [],
    'the composed result must be bit-identical to the shipped algorithm');
  assert.ok(compared > 10000, `expected a wide sweep, only compared ${compared}`);
});

check('release instants survive both BST transitions', () => {
  // 2026: BST starts 29 Mar, ends 25 Oct. A release computed either side must
  // still land at 12:00 LOCAL, not drift by the hour.
  for (const iso of ['2026-03-30T09:00:00', '2026-04-02T19:30:00',
                     '2026-10-26T09:00:00', '2026-10-29T19:30:00']) {
    const at = DateTime.fromISO(psycle.releaseAtFor(iso, { offsetDays: 14 })).setZone('Europe/London');
    assert.strictEqual(at.hour, 12, `${iso}: release drifted to ${at.hour}:00 local`);
    assert.strictEqual(at.weekday, 1, `${iso}: release landed on weekday ${at.weekday}, not Monday`);
  }
});

// --- 2. the protocol / policy seam ------------------------------------------

check('CodexFit reads the cutoff; the gym config decides what it means', () => {
  const release = bw.mostRecentRelease(PSYCLE_POLICY);
  const cutoff = release.plus({ days: 17 }).toISO(); // a Psycle 15 tier account
  const win = psycle.resolveBookingWindow({ booking_cutoff: cutoff }, []);
  assert.strictEqual(win.offsetDays, 17, 'day-granular tiers pass through unsnapped');
  assert.strictEqual(win.source, 'standard');
});

check('the extended cutoff wins when extended booking is allowed', () => {
  const release = bw.mostRecentRelease(PSYCLE_POLICY);
  const win = psycle.resolveBookingWindow({
    booking_cutoff: release.plus({ days: 14 }).toISO(),
    extended_cutoff: release.plus({ days: 22 }).toISO(),
    metafields: { extended_booking_allowed: true },
  }, []);
  assert.strictEqual(win.offsetDays, 22);
  assert.strictEqual(win.extendedAllowed, true);
});

check('credits do not affect the window — that logic is out of the core', () => {
  // Psycle no longer issues Advanced Booking credits (stakeholder, 2026-09-01),
  // and while it did, the "15-day floor" rule was Psycle's promotion wearing a
  // platform-neutral shape. The shared evaluator now turns a cutoff into an
  // offset and does nothing else; a gym needing an adjustment does it in its own
  // adapter. This asserts the core stays clean.
  const release = bw.mostRecentRelease(PSYCLE_POLICY);
  const credits = [{ credit_type_id: 8, count: 3 }];
  const withCredits = psycle.resolveBookingWindow({ booking_cutoff: release.plus({ days: 15 }).toISO() }, credits);
  const without = psycle.resolveBookingWindow({ booking_cutoff: release.plus({ days: 15 }).toISO() }, []);
  assert.deepStrictEqual(withCredits, without, 'holding credits must change nothing');
  // 'standard'/'extended' is the ADAPTER relabelling the evaluator's 'cutoff' —
  // the adapter adding meaning is the correct layering. What matters is that no
  // 'credits' source exists any more.
  assert.strictEqual(withCredits.source, 'standard', 'the profile cutoff is the only input');
  assert.notStrictEqual(withCredits.source, 'credits');
  assert.strictEqual(typeof bw.countExtendingCredits, 'undefined',
    'the credit-counting helper is gone from the shared evaluator, not just unused');
});

check('the tier extra days arrive on the cutoff, needing no table in code', () => {
  // Psycle 10 +2, Psycle 15 +3, Unlimited +8 are all already baked into the
  // account's own booking_cutoff, which is server-authoritative. Encoding the
  // tier table anywhere in our code would be a second source of truth that can
  // drift the moment Psycle changes a tier.
  const release = bw.mostRecentRelease(PSYCLE_POLICY);
  for (const [tier, days] of [['standard', 15], ['Psycle 10', 17], ['Psycle 15', 18], ['Unlimited', 23]]) {
    const win = psycle.resolveBookingWindow({ booking_cutoff: release.plus({ days }).toISO() }, []);
    assert.strictEqual(win.offsetDays, days, `${tier}: read verbatim from the cutoff`);
  }
});

check('an absurd cutoff is clamped to the gym\'s own bounds', () => {
  const release = bw.mostRecentRelease(PSYCLE_POLICY);
  assert.strictEqual(psycle.resolveBookingWindow({ booking_cutoff: release.plus({ days: 400 }).toISO() }, []).offsetDays,
    PSYCLE_POLICY.maxOffsetDays);
  assert.strictEqual(psycle.resolveBookingWindow({ booking_cutoff: release.minus({ days: 400 }).toISO() }, []).offsetDays,
    PSYCLE_POLICY.minOffsetDays);
});

check('no profile, or an unparseable cutoff, resolves to null rather than a guess', () => {
  assert.strictEqual(psycle.resolveBookingWindow(null, []), null);
  assert.strictEqual(psycle.resolveBookingWindow({}, []), null);
  assert.strictEqual(psycle.resolveBookingWindow({ booking_cutoff: 'not-a-date' }, []), null);
});

// --- 3. a per-class gym computes nothing ------------------------------------

check('MarianaTek ignores CodexFit-shaped cutoffs entirely', () => {
  const win = jab.resolveBookingWindow({ booking_cutoff: '2026-09-14T00:00:00Z' }, []);
  assert.strictEqual(win.source, 'gym-fallback',
    'a CodexFit profile field must never drive a MarianaTek window');
  assert.strictEqual(win.offsetDays, 14, "JAB's own declared rule, not anything read off that profile");
});

check('JAB\'s window is rolling-continuous and exact to the minute', () => {
  // The stakeholder's own example: at 13:30 on 1 Sep with a 14-day window, the
  // 13:30 class on 15 Sep is open and the 14:00 class the same day is not.
  const at1330 = jab.releaseAtFor('2026-09-15T13:30:00+01:00');
  const at1400 = jab.releaseAtFor('2026-09-15T14:00:00+01:00');
  assert.strictEqual(DateTime.fromISO(at1330).toUTC().toISO(), '2026-09-01T12:30:00.000Z');
  assert.strictEqual(DateTime.fromISO(at1400).toUTC().toISO(), '2026-09-01T13:00:00.000Z');
  assert.notStrictEqual(at1330, at1400,
    'two classes on the same day open at DIFFERENT times — a day-granular or ' +
    'weekday-based model cannot express this');
});

check('a rolling-continuous release lands on no particular weekday', () => {
  // Guards the specific bug this correction fixed: applying Psycle's Monday rule
  // to a gym that has no weekly release at all.
  const weekdays = new Set();
  for (let d = 1; d <= 14; d++) {
    const iso = jab.releaseAtFor(`2026-09-${String(d).padStart(2, '0')}T18:00:00+01:00`);
    weekdays.add(DateTime.fromISO(iso).weekday);
  }
  assert.strictEqual(weekdays.size, 7, 'releases fall on every weekday, as a sliding window must');
});

check('MarianaTek events carry releaseAt straight from the API', () => {
  const ev = jab.mapClassToEvent({
    id: 1, name: 'Boxing', start_datetime: '2026-09-01T18:00:00Z',
    booking_start_datetime: '2026-08-25T10:00:00Z',
    class_type: { duration: 45 },
  });
  assert.strictEqual(ev.releaseAt, '2026-08-25T10:00:00Z',
    'read, not computed — and unrelated to any Monday');
});

// --- 4. the policy lives in config, not in code -----------------------------

check('Psycle\'s numbers are in gyms.config.js, not in the platform module', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'providers/codexfit.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const smell of [/weekday:\s*1\b/, /hour:\s*12\b/, /\b14\b\s*;/, /floorDays/, /Europe\/London/]) {
    assert.ok(!smell.test(code),
      `providers/codexfit.js contains ${smell} — that is Psycle policy, and CodexFit ` +
      'is a platform many gyms use. It belongs in that gym\'s config entry.');
  }
});

check('changing the gym\'s policy changes the result, with no code change', () => {
  // The real proof the split works: a hypothetical CodexFit gym that releases
  // Sundays at 09:00 needs no adapter change at all.
  const sundayPolicy = {
    kind: 'rolling-weekly', releaseWeekday: 7, releaseTime: { hour: 9, minute: 0 },
    timezone: 'Europe/London', baseOffsetDays: 21, minOffsetDays: 1, maxOffsetDays: 35,
  };
  const at = bw.releaseFor('2026-09-15T18:00:00', 21, sundayPolicy);
  assert.strictEqual(at.weekday, 7, 'released on Sunday');
  assert.strictEqual(at.hour, 9, 'at 09:00');
});

// --- 5. the scheduler picks the right world ---------------------------------
//
// This is the instant auto-book actually fires at, so it gets its own checks
// rather than relying on the adapter's being right.

const scheduler = require('./scheduler');

check('a published per-class release wins over any weekly recomputation', () => {
  const published = '2026-08-25T10:00:00Z';
  const at = scheduler.getClassReleaseTime({
    start_at: '2026-09-01T18:00:00Z',
    release_at: published,
    gym_id: 'jab-boxing',
  });
  assert.strictEqual(at.toUTC().toISO(), DateTime.fromISO(published).toUTC().toISO(),
    'a gym that publishes its release must not have a Monday-noon rule applied to it');
  assert.notStrictEqual(at.weekday, 1, 'and the result is a Tuesday — no weekday rule was imposed');
});

check('a rolling-weekly gym with no stored release still computes the old answer', () => {
  const startAt = '2026-09-15T19:30:00';
  const viaRow = scheduler.getClassReleaseTime(
    { start_at: startAt, gym_id: 'psycle-london' }, { detectedBookingOffset: 14 });
  assert.strictEqual(viaRow.toMillis(), originalGetClassReleaseTime(startAt, 14).toMillis(),
    'existing Psycle queue entries (release_at NULL) must behave exactly as before');
});

check('a bare date string still works, for the legacy call shape', () => {
  const startAt = '2026-09-15T19:30:00';
  assert.strictEqual(
    scheduler.getClassReleaseTime(startAt, { detectedBookingOffset: 16 }).toMillis(),
    originalGetClassReleaseTime(startAt, 16).toMillis());
});

check('a per-class gym with no stored release falls back to ITS OWN rule', () => {
  // Not a Monday, and emphatically not "now": treating an unresolved class as
  // open would fire auto-book weeks early and burn the queue entry. The gym's
  // declared fallback is the only honest answer.
  // A far-future class, so the assertion can't be confounded by what today is.
  const at = scheduler.getClassReleaseTime({ start_at: '2027-06-15T18:00:00+01:00', gym_id: 'jab-boxing' });
  assert.strictEqual(at.toUTC().toISO(), '2027-06-01T17:00:00.000Z', 'class start minus 14 days');
  assert.ok(Math.abs(at.diffNow('minutes').minutes) > 5,
    'the old behaviour returned DateTime.now() here, which would fire auto-book immediately');
});

check('an unresolvable release yields null, and null never dispatches', () => {
  // A gym with neither a policy nor a fallback. The scheduler must decline rather
  // than guess — every call site treats null as "skip this entry".
  const { GYMS } = require('./gyms.config');
  const saved = GYMS['jab-boxing'].bookingWindow;
  GYMS['jab-boxing'].bookingWindow = { kind: 'per-class' }; // no fallback
  try {
    const at = scheduler.getClassReleaseTime({ start_at: '2026-09-15T18:00:00Z', gym_id: 'jab-boxing' });
    assert.strictEqual(at, null, 'no policy + no published release = refuse, never assume');
  } finally {
    GYMS['jab-boxing'].bookingWindow = saved;
  }
});

// --- 6. the base offset lands on the right weekday ---------------------------

check('the standard window ends on a TUESDAY, not a Monday', () => {
  // Booking for any given Tuesday opens on the Monday. releaseMonday + 15 is a
  // Tuesday; +14 is a Monday and would hold Tuesday classes back a whole week
  // for anyone on the standard tier. Stakeholder-confirmed 2026-09-01.
  const base = PSYCLE_POLICY.baseOffsetDays;
  assert.strictEqual(base, 15, 'the standard window is releaseMonday + 15 days');

  const release = bw.mostRecentRelease(PSYCLE_POLICY);
  assert.strictEqual(release.weekday, 1, 'releases are Mondays');
  assert.strictEqual(release.plus({ days: base }).weekday, 2,
    'and the cutoff lands on a Tuesday — the alignment the 8-day base also had (M+8)');
});

check('a Tuesday class opens on the Monday 15 days earlier, not 22', () => {
  // The concrete regression: with base 14 this class would have released a week
  // late, silently, for every standard-tier member.
  const tuesday = '2026-09-15T19:30:00'; // a Tuesday
  const at = DateTime.fromISO(psycle.releaseAtFor(tuesday, { offsetDays: 15 })).setZone('Europe/London');
  assert.strictEqual(at.weekday, 1, 'opens on a Monday');
  assert.strictEqual(Math.round(DateTime.fromISO(tuesday, { zone: 'Europe/London' }).diff(at, 'days').days), 15,
    'exactly 15 days earlier');
});

// --- run --------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of checks) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks.length} booking-window-policy checks FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${passed}/${checks.length} booking-window-policy checks passed.`);
