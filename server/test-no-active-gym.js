// "There is no active gym" — enforced (active-gym audit, stage 1 + 5).
//
// The product model is one account, many gyms, every list merged. There is no
// active gym, so no per-gym write may be resolved by guessing one.
//
// This is the guard for a bug class that has now shipped three times, always in
// the same shape and always silently: a call site omits `gymId`, the server
// falls back to `db.resolveActiveGymId()`, the guess is correct on a single-gym
// account (so it passes review and every other suite), and it writes to the
// WRONG gym on a two-gym account with no error and a plausible-looking screen.
//
// Two halves:
//   1. Runtime — an ambiguous per-gym write THROWS instead of guessing.
//   2. Source  — no client UI module asks a capability question ambiently.
//
// Part 2 scans source, which is usually a smell, but the property being
// protected IS source-level ("no module asks `can()` in a merged view") and it
// is one reviewers demonstrably miss: 7 such call sites were live and passing
// every other suite when this file was written.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';

let seq = 0;
function makeUser(gyms) {
  const email = `no-active-gym-${++seq}@test.local`;
  const id = db.createAccount(email, 'pw-not-used-here');
  for (const g of gyms) db.upsertUserGym(id, g, { gym_email: email });
  return id;
}

const AUTO_BOOK_ARGS = (gymId) => [
  'evt-1', 'Class', 'Instructor', 'Studio', 'Location',
  '2026-10-01T09:00:00Z', { requiredCount: 1 },
  null, null, null, gymId,
];
const AUTO_UPGRADE_ARGS = (gymId) => [
  'evt-1', 'bk-1', 'slot-1', 'Class', 'Instructor', 'Studio', 'Location',
  '2026-10-01T09:00:00Z', { keepOriginalOnCutoff: true }, null, null, gymId,
];

// ── 1. Runtime: ambiguity is an error, not a guess ─────────────────────────

check('a SINGLE-gym account still resolves without an explicit gym', () => {
  const uid = makeUser([PSYCLE]);
  // Unambiguous: one link, so there is exactly one answer and no guessing.
  const id = db.addAutoBooking(uid, ...AUTO_BOOK_ARGS(null));
  const rows = db.getUserAutoBookings(uid, 'all');
  assert.strictEqual(rows.find((r) => r.id === id).gym_id, PSYCLE);
});

check('a MULTI-gym account THROWS on an auto-book write with no gym', () => {
  const uid = makeUser([PSYCLE, JAB]);
  assert.throws(
    () => db.addAutoBooking(uid, ...AUTO_BOOK_ARGS(null)),
    /no gym specified/i,
    'this is the exact bug that queued a JAB class against Psycle — it must not resolve silently',
  );
});

check('a MULTI-gym account THROWS on an auto-upgrade write with no gym', () => {
  const uid = makeUser([PSYCLE, JAB]);
  assert.throws(
    () => db.addAutoUpgrade(uid, ...AUTO_UPGRADE_ARGS(null)),
    /no gym specified/i,
    'a monitor stored against the wrong gym is polled with the wrong session and never fires',
  );
});

check('an explicit gym is always honoured on a multi-gym account', () => {
  const uid = makeUser([PSYCLE, JAB]);
  const id = db.addAutoBooking(uid, ...AUTO_BOOK_ARGS(JAB));
  const rows = db.getUserAutoBookings(uid, 'all');
  assert.strictEqual(rows.find((r) => r.id === id).gym_id, JAB);
});

check('the request gym context satisfies the requirement', () => {
  const uid = makeUser([PSYCLE, JAB]);
  const id = db.runWithGymContext(uid, JAB, () => db.addAutoBooking(uid, ...AUTO_BOOK_ARGS(null)));
  const rows = db.getUserAutoBookings(uid, 'all');
  assert.strictEqual(rows.find((r) => r.id === id).gym_id, JAB);
});

check('quota counters refuse to guess too', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // A quota counted against the wrong gym lets a user past their real limit on
  // one gym while blocking them on another.
  assert.throws(() => db.countPendingAutoBookings(uid), /no gym specified/i);
  assert.throws(() => db.countActiveAutoUpgrades(uid), /no gym specified/i);
  assert.doesNotThrow(() => db.countPendingAutoBookings(uid, JAB));
});

check('an account-only settings patch needs no gym at all', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // `theme` belongs to the person. Demanding a gym here would be as wrong as
  // guessing one — there is nothing gym-shaped in this save.
  assert.doesNotThrow(() => db.setUserSettings(uid, { theme: 'dark' }));
  assert.strictEqual(db.getUserSettings(uid).theme, 'dark');
});

check('a gym-scoped settings patch refuses to guess', () => {
  const uid = makeUser([PSYCLE, JAB]);
  assert.throws(
    () => db.setUserSettings(uid, { detectedBookingOffset: 15 }),
    /no gym specified/i,
    'a booking window derived from one gym\'s profile must not land on another',
  );
  assert.doesNotThrow(() => db.setUserSettings(uid, { detectedBookingOffset: 15 }, JAB));
});

check('settings MERGE rather than replace, so a patch keeps everything else', () => {
  const uid = makeUser([PSYCLE]);
  db.setUserSettings(uid, { theme: 'dark', prefetchWeeks: 8 });
  db.setUserSettings(uid, { theme: 'light' });   // patch of one key
  const s = db.getUserSettings(uid);
  assert.strictEqual(s.theme, 'light');
  assert.strictEqual(s.prefetchWeeks, 8,
    'replacing wholesale is what forced every caller to resend the entire blob');
});

check('a rejected gym patch does not half-apply the account half', () => {
  const uid = makeUser([PSYCLE, JAB]);
  assert.throws(
    () => db.setUserSettings(uid, { theme: 'dark', detectedBookingOffset: 15 }),
    /no gym specified/i,
  );
  const s = db.getUserSettings(uid) || {};
  assert.notStrictEqual(s.theme, 'dark',
    'the account half must not be written when the gym half is refused');
});

check('gym-scoped settings stay separate per gym', () => {
  const uid = makeUser([PSYCLE, JAB]);
  db.setUserSettings(uid, { detectedBookingOffset: 15 }, PSYCLE);
  db.setUserSettings(uid, { detectedBookingOffset: 14 }, JAB);
  assert.strictEqual(db.runWithGymContext(uid, PSYCLE, () => db.getUserSettings(uid)).detectedBookingOffset, 15);
  assert.strictEqual(db.runWithGymContext(uid, JAB, () => db.getUserSettings(uid)).detectedBookingOffset, 14);
});

check('setUserPriority updates EVERY linked gym when none is named', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // The admin panel has one "VIP" control per user, no per-gym picker — but the
  // scheduler joins user_gyms.priority for a booking's OWN gym. Defaulting to
  // resolveActiveGymId silently left every other linked gym at the old
  // priority, so a user marked VIP kept queuing at default priority everywhere
  // except whichever gym happened to be active.
  db.setUserPriority(uid, 5);
  assert.strictEqual(db.getUserGym(uid, PSYCLE).priority, 5);
  assert.strictEqual(db.getUserGym(uid, JAB).priority, 5,
    'the gym that was NOT active when this was called must still update');
});

check('setUserPriority can still target one gym explicitly', () => {
  const uid = makeUser([PSYCLE, JAB]);
  db.setUserPriority(uid, 5, PSYCLE);
  assert.strictEqual(db.getUserGym(uid, PSYCLE).priority, 5);
  assert.notStrictEqual(db.getUserGym(uid, JAB).priority, 5);
});

check('cacheUserProfile refuses to save a profile without a named gym', () => {
  const uid = makeUser([PSYCLE, JAB]);
  assert.throws(
    () => db.cacheUserProfile(uid, { first_name: 'A', last_name: 'B' }),
    /no gym specified/i,
    'a profile cached against a guessed gym can overwrite that gym\'s real profile with another\'s',
  );
});

check('getStudioPreference reads the RIGHT gym\'s map when one is named', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // Same studio id at both gyms — different rooms, different floor plans. This
  // is the exact shape scheduler.js's resolveLiveMap and poller.js's upgrade
  // check both got wrong: a comment sat right above the call warning "from the
  // ROW, not the active gym", and the call itself still didn't pass one.
  db.setStudioPreference(uid, 138, { preferredSlots: [1, 2], preferredRows: [] }, PSYCLE);
  db.setStudioPreference(uid, 138, { preferredSlots: [9], preferredRows: [] }, JAB);
  assert.deepStrictEqual(db.getStudioPreference(uid, 138, PSYCLE).preferredSlots, [1, 2]);
  assert.deepStrictEqual(db.getStudioPreference(uid, 138, JAB).preferredSlots, [9]);
});

check('getUserSettings reads the RIGHT gym\'s booking-window offset when one is named', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // detectedBookingOffset is gym-scoped. This is the scheduler's wake-clock
  // engine's own dependency (getClassReleaseTime -> getBookingOffset) — reading
  // the wrong gym's offset here mistimes when a queued class actually opens.
  db.setUserSettings(uid, { detectedBookingOffset: 17 }, PSYCLE);
  db.setUserSettings(uid, { detectedBookingOffset: 14 }, JAB);
  assert.strictEqual(db.getUserSettings(uid, PSYCLE).detectedBookingOffset, 17);
  assert.strictEqual(db.getUserSettings(uid, JAB).detectedBookingOffset, 14);
});

check('a spot map refuses to save without a named gym', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // studio_id is a PROVIDER id: studio 138 at JAB is a different room from
  // studio 138 at Psycle, so guessing overwrites one gym's map with another's.
  assert.throws(
    () => db.setStudioPreference(uid, 138, { preferredSlots: [1], preferredRows: [] }),
    /no gym specified/i,
  );
  assert.doesNotThrow(
    () => db.setStudioPreference(uid, 138, { preferredSlots: [1], preferredRows: [] }, JAB),
  );
  const saved = db.runWithGymContext(uid, JAB, () => db.getStudioPreference(uid, 138));
  assert.deepStrictEqual(saved.preferredSlots, [1]);
  assert.strictEqual(db.runWithGymContext(uid, PSYCLE, () => db.getStudioPreference(uid, 138)), null,
    'the other gym\'s identically-numbered studio must be untouched');
});

check('the merged booking sync files each row under its OWN gym', () => {
  const uid = makeUser([PSYCLE, JAB]);
  // One call carrying BOTH gyms' bookings — exactly what the client sends.
  db.replaceBookingCache(uid, [
    { bookingId: 'p1', gymId: PSYCLE, eventId: 'ep', startAt: '2026-10-01T09:00:00Z', slotLabel: '1' },
    { bookingId: 'j1', gymId: JAB, eventId: 'ej', startAt: '2026-10-01T18:00:00Z', slotLabel: '2' },
  ], [PSYCLE, JAB]);

  const rows = db.getAllBookingCache().filter((r) => r.user_id === uid);
  const byBooking = Object.fromEntries(rows.map((r) => [r.booking_id, r.gym_id]));
  assert.deepStrictEqual(byBooking, { p1: PSYCLE, j1: JAB },
    'filing every row under one resolved gym is what made JAB bookings fire Psycle reminders');
});

check('a gym whose last booking was cancelled is cleared, not left stale', () => {
  const uid = makeUser([PSYCLE, JAB]);
  db.replaceBookingCache(uid, [
    { bookingId: 'p1', gymId: PSYCLE, eventId: 'ep', startAt: '2026-10-01T09:00:00Z', slotLabel: '1' },
    { bookingId: 'j1', gymId: JAB, eventId: 'ej', startAt: '2026-10-01T18:00:00Z', slotLabel: '2' },
  ], [PSYCLE, JAB]);

  // JAB booking cancelled — it simply stops appearing in the merged payload.
  db.replaceBookingCache(uid, [
    { bookingId: 'p1', gymId: PSYCLE, eventId: 'ep', startAt: '2026-10-01T09:00:00Z', slotLabel: '1' },
  ], [PSYCLE, JAB]);

  const rows = db.getAllBookingCache().filter((r) => r.user_id === uid);
  assert.deepStrictEqual(rows.map((r) => r.booking_id), ['p1'],
    'a gym absent from the payload must still be cleared, or it keeps reminding about a cancelled class');
});

check('a single-gym sync cannot clear another gym\'s cache', () => {
  const uid = makeUser([PSYCLE, JAB]);
  db.replaceBookingCache(uid, [
    { bookingId: 'p1', gymId: PSYCLE, eventId: 'ep', startAt: '2026-10-01T09:00:00Z', slotLabel: '1' },
    { bookingId: 'j1', gymId: JAB, eventId: 'ej', startAt: '2026-10-01T18:00:00Z', slotLabel: '2' },
  ], [PSYCLE, JAB]);

  // The calendar loop refreshes ONE gym at a time.
  db.replaceBookingCache(uid, [
    { bookingId: 'j2', gymId: JAB, eventId: 'ej2', startAt: '2026-10-02T18:00:00Z', slotLabel: '5' },
  ], [JAB]);

  const rows = db.getAllBookingCache().filter((r) => r.user_id === uid);
  const byBooking = Object.fromEntries(rows.map((r) => [r.booking_id, r.gym_id]));
  assert.deepStrictEqual(byBooking, { p1: PSYCLE, j2: JAB },
    'scoping the replace is what lets per-gym callers coexist with the merged one');
});

// ── 2. Source: no ambient capability questions in the UI ───────────────────

const CLIENT_UI = path.join(__dirname, '..', 'client', 'src');

function clientModules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.endsWith('.test.js')) continue;
      // gym-context.js used to DEFINE can() (an ambient module-level "active
      // gym" capability read) alongside canForGym(); C3-6 (2026-09-27) removed
      // can() and the ambient state it read entirely — every real call site
      // already passed an explicit gym, so canForGym/capabilityForGym/canAny
      // now fall back straight to the permissive DEFAULTS instead of a guessed
      // gym's flags. This exclusion is now belt-and-braces: if `can(` is ever
      // reintroduced anywhere, including here, the regex below still catches
      // it (nothing defines it any more, so it would also fail to import).
      if (entry.name === 'gym-context.js') continue;
      out.push({ name: path.relative(CLIENT_UI, p), src: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(CLIENT_UI);
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

check('no client module asks an ambient can(...) capability question', () => {
  const offenders = [];
  for (const m of clientModules()) {
    const src = stripComments(m.src);
    // `can('x')` / `can("x")` but NOT canForGym / canAny.
    const re = /(?<![A-Za-z0-9_$])can\s*\(\s*['"]/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${m.name}:${line}`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'Ask canForGym(flag, row.gymId) — every row, card and action belongs to a known gym. '
    + 'canAny(flag) is for global chrome above a merged list. '
    + `Ambient can() found at: ${offenders.join(', ')}`,
  );
});

// ── run ────────────────────────────────────────────────────────────────────

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${checks.length} no-active-gym checks FAILED.`);
  process.exit(1);
}
console.log(`\n🎉 ${checks.length}/${checks.length} no-active-gym checks passed.`);
