// MarianaTek adapter integration suite (WP-T2, mock-backed).
//
// The MT adapter (WP-M1–M5) was built and live/mock-verified during development,
// but had NO committed, re-runnable regression test — unlike CodexFit, which has
// test-regression-psycle.js. This is that missing safety net: it drives the FULL
// success path of every M1–M5 method through the adapter → mock-marianatek.js,
// chained realistically (book → availability decrements → cancel → availability
// restores → waitlist join/leave → spot swap), and asserts the normalized shapes.
//
// This formalizes the throwaway verification described in the WP-M5 handoff into
// a permanent guard, so any future edit to the MT adapter or its mock is caught.
//
// SAFETY: mock-only. Honors the golden rule "never cancel a real paid booking" —
// no live MarianaTek calls, no live account, no credentials. The MT mock is pure
// in-memory (no fixture files, no persistence), so nothing on disk is mutated;
// no backup/restore needed (unlike the CodexFit mock's mock_bookings.dbjson).
//
// Run: node server/test-marianatek-mock.js

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const { getProvider } = require('./providers');

// Class ids are DISCOVERED from the timetable, not hardcoded.
//
// They used to be literals ('9000' = the day's first pick-a-spot class, '9002'
// = the FCFS one), which encoded the mock's schedule ORDER into the test: the
// moment the mock grew a realistic multi-class day, 9002 was a pick-a-spot
// class and the FCFS assertion failed for a reason that had nothing to do with
// the adapter. What the test actually needs is "a pick-a-spot class" and "an
// FCFS class", so that is what it asks for.
// Spots remain mock-bag-1..10 / mock-ground-1..10 (see makeLayout).
let PICK_A_SPOT, PICK_A_SPOT_ALT, FCFS;

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// A shared session, populated by the login check and reused by the rest — the
// suite is an intentionally-ordered chain (book → cancel → …), not independent
// units, because it verifies STATE TRANSITIONS the way a real session would.
const ctx = {};

check('Aarmy: shared MarianaTek adapter resolves tenant config and mock login', async () => {
  const mt = getProvider('aarmy');
  const { session } = await mt.login({ email: 'dev@aarmy.mock', password: 'x' });
  const events = await mt.fetchTimetable({}, session);
  assert.ok(events.length > 0, 'Aarmy receives the shared mock timetable');
  assert.ok(events.every((e) => e.gymId === 'aarmy'), 'Aarmy events are gym-qualified');
  assert.ok(events.every((e) => !!e.releaseAt), 'per-class MarianaTek release times are preserved');
});

check('login: dev bypass returns a mock session + normalized profile', async () => {
  const mt = getProvider('jab-boxing');
  const { session, profile } = await mt.login({ email: 'dev@jabboxing.mock', password: 'x' });
  assert.strictEqual(session.accessToken, 'mock-mt-token', 'dev login short-circuits to the mock sentinel token');
  assert.strictEqual(profile.firstName, 'Dev', 'profile normalized from /me/account');
  assert.ok(!('bookingCutoff' in profile), 'no CodexFit-style cutoff leaks into an MT profile');
  ctx.session = session;
});

check('fetchTimetable: normalizes classes with both layout formats + releaseAt', async () => {
  const mt = getProvider('jab-boxing');
  const events = await mt.fetchTimetable({}, ctx.session);
  assert.ok(events.length > 0, 'returns a non-empty event list');
  assert.ok(events.every((e) => e.gymId === 'jab-boxing'), 'gymId stamped on every event');
  assert.ok(events.every((e) => !!e.releaseAt), 'releaseAt populated from booking_start_datetime (§1H)');
  assert.ok(events.some((e) => e.layoutFormat === 'pick-a-spot'), 'pick-a-spot classes present');
  assert.ok(events.some((e) => e.layoutFormat === 'first-come-first-serve'), 'FCFS classes present');

  const picks = events.filter((e) => e.layoutFormat === 'pick-a-spot');
  PICK_A_SPOT = picks[0].id;
  PICK_A_SPOT_ALT = picks[1].id;
  FCFS = events.find((e) => e.layoutFormat === 'first-come-first-serve').id;
});

check('fetchEventDetails: pick-a-spot yields a full slot layout; FCFS yields none', async () => {
  const mt = getProvider('jab-boxing');
  const picked = await mt.fetchEventDetails(PICK_A_SPOT, ctx.session);
  assert.strictEqual(picked.slots.length, 20, 'pick-a-spot layout mapped to 20 slots');
  assert.ok(picked.slots.every((s) => typeof s.isAvailable === 'boolean'), 'availability resolved on every slot');
  assert.ok(picked.slots.some((s) => s.section === 'Bag'), 'provider spot section is normalized');
  const fcfs = await mt.fetchEventDetails(FCFS, ctx.session);
  assert.deepStrictEqual(fcfs.slots, [], 'FCFS class renders no picker');
});

check('bookSlot: books a spot and returns a normalized result', async () => {
  const mt = getProvider('jab-boxing');
  const result = await mt.bookSlot(PICK_A_SPOT, ['mock-bag-1'], ctx.session);
  assert.strictEqual(result.ok, true, 'booking succeeds against the membership mock');
  assert.strictEqual(result.slotId, 'mock-bag-1', 'slotId echoes the booked spot');
  assert.ok(result.bookingId, 'a reservation id is returned');
  ctx.bookingId = result.bookingId;
});

check('bookSlot side effect: the booked spot flips to unavailable', async () => {
  const mt = getProvider('jab-boxing');
  const { slots } = await mt.fetchEventDetails(PICK_A_SPOT, ctx.session);
  const bag1 = slots.find((s) => s.id === 'mock-bag-1');
  assert.strictEqual(bag1.isAvailable, false, 'the just-booked spot is no longer available');
});

check('getCancelPenalty: a fresh booking is inside the free window', async () => {
  const mt = getProvider('jab-boxing');
  const penalty = await mt.getCancelPenalty(ctx.bookingId, ctx.session);
  assert.strictEqual(penalty.isPenalty, false, 'zero-penalty cancel');
});

check('cancelBooking restores availability (§1H: credit/spot freed on free cancel)', async () => {
  const mt = getProvider('jab-boxing');
  assert.strictEqual(await mt.cancelBooking(ctx.bookingId, ctx.session), true, 'cancel succeeds');
  const { slots } = await mt.fetchEventDetails(PICK_A_SPOT, ctx.session);
  const bag1 = slots.find((s) => s.id === 'mock-bag-1');
  assert.strictEqual(bag1.isAvailable, true, 'the freed spot is available again');
});

check('waitlist: join then leave (leave resolves reservation-by-event indirection)', async () => {
  const mt = getProvider('jab-boxing');
  assert.strictEqual(await mt.joinWaitlist(PICK_A_SPOT_ALT, ctx.session), true, 'waitlist join succeeds');
  // leaveWaitlist must look the reservation up by event id (MT cancels waitlist
  // entries by reservation id, not event id — the M3 gotcha) and cancel it.
  assert.strictEqual(await mt.leaveWaitlist(PICK_A_SPOT_ALT, ctx.session), true, 'waitlist leave finds + cancels the entry');
});

check('listBookings: an active booking is listed with a full embedded event', async () => {
  const mt = getProvider('jab-boxing');
  const booked = await mt.bookSlot(PICK_A_SPOT_ALT, ['mock-ground-1'], ctx.session);
  assert.strictEqual(booked.ok, true, 'seed booking for listBookings');
  const bookings = await mt.listBookings(ctx.session);
  const found = bookings.find((b) => b.bookingId === booked.bookingId);
  assert.ok(found, 'the seeded booking appears in listBookings');
  assert.strictEqual(found.isWaitlist, false);
  assert.strictEqual(found.eventId, PICK_A_SPOT_ALT);
  assert.strictEqual(found.slotId, 'mock-ground-1');
  // Spot type is studio-specific (gyms.config spotMap.spotTypeStudios): BOXING shows it, TRAIN does not.
  assert.strictEqual(found.spotSection, /^boxing$/i.test(found.event.studioName) ? 'Ground' : undefined, `studio ${found.event.studioName}`);
  assert.strictEqual(found.slotLabel, 'G1');
  assert.ok(found.event && found.event.gymId === 'jab-boxing', 'MT embeds a full NormalizedEvent for free (unlike CodexFit)');
  // Clean up so later checks (credits/memberships) see a consistent state.
  await mt.cancelBooking(booked.bookingId, ctx.session);
});

check('listWaitlists: a waitlist join is listed distinctly from bookings', async () => {
  const mt = getProvider('jab-boxing');
  assert.strictEqual(await mt.joinWaitlist(PICK_A_SPOT, ctx.session), true, 'seed a waitlist entry');
  const waitlists = await mt.listWaitlists(ctx.session);
  assert.ok(waitlists.length > 0, 'the waitlist entry is listed');
  assert.ok(waitlists.every((w) => w.isWaitlist === true), 'every entry is flagged isWaitlist');
  const bookings = await mt.listBookings(ctx.session);
  assert.ok(!bookings.some((b) => b.isWaitlist), 'listBookings never returns waitlist entries');
  // Clean up.
  assert.strictEqual(await mt.leaveWaitlist(PICK_A_SPOT, ctx.session), true);
});

check('swapSpots: native swap moves the reservation to the target spot', async () => {
  const mt = getProvider('jab-boxing');
  // Pick a target that is actually free rather than naming one: the mock now
  // pre-books part of the room to look realistic, so a hardcoded target spot is
  // a test that depends on the mock's occupancy pattern instead of on swapping.
  const details = await mt.fetchEventDetails(PICK_A_SPOT, ctx.session);
  const free = details.slots.filter((sl) => sl.isAvailable).map((sl) => sl.id);
  assert.ok(free.length >= 2, 'the mock class has at least two free spots to swap between');
  const [from, to] = free;
  const booked = await mt.bookSlot(PICK_A_SPOT, [from], ctx.session);
  assert.strictEqual(booked.ok, true, 'seed booking for the swap');
  const swap = await mt.swapSpots(booked.bookingId, from, to, ctx.session);
  assert.strictEqual(swap.ok, true, 'swap succeeds');
  assert.strictEqual(swap.slotId, to, 'result reflects the new spot');
  // Clean up so a re-run starts from a consistent spot state.
  await mt.cancelBooking(swap.bookingId, ctx.session);
});

check('getCredits/getMemberships: mock account has a membership, no credit packs', async () => {
  const mt = getProvider('jab-boxing');
  // U1-20: live shape — an expired, fully used pack, never an empty list.
  const packs = await mt.getCredits(ctx.session);
  assert.ok(packs.length > 0 && packs.every((c) => c.credits_remaining === 0 && c.is_expired === true), 'only expired, used-up packs (membership-based)');
  assert.ok(packs.every((c) => c.count === 0), 'normalised: expired/used-up packs carry count 0 (raw fields kept)');
  const memberships = await mt.getMemberships(ctx.session);
  assert.strictEqual(memberships.length, 1, 'one active membership');
});

// --- Runner ---------------------------------------------------------------

(async () => {
  console.log('\n🧪 MarianaTek adapter integration suite (WP-T2, mock-backed)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} MarianaTek checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
