// Sweat Assistant — MarianaTek adapter integration suite (WP-T2, mock-backed).
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

// Mock ids (see server/mock-marianatek.js generateClasses/makeLayout):
//   9000 = BOXING (pick-a-spot, 20 spots)   9001 = TRAIN (pick-a-spot)
//   9002 = RECOVERY (first-come-first-serve, no layout)
//   spots: mock-bag-1..10, mock-ground-1..10
const PICK_A_SPOT = '9000';
const PICK_A_SPOT_ALT = '9001';
const FCFS = '9002';

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// A shared session, populated by the login check and reused by the rest — the
// suite is an intentionally-ordered chain (book → cancel → …), not independent
// units, because it verifies STATE TRANSITIONS the way a real session would.
const ctx = {};

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
});

check('fetchEventDetails: pick-a-spot yields a full slot layout; FCFS yields none', async () => {
  const mt = getProvider('jab-boxing');
  const picked = await mt.fetchEventDetails(PICK_A_SPOT, ctx.session);
  assert.strictEqual(picked.slots.length, 20, 'pick-a-spot layout mapped to 20 slots');
  assert.ok(picked.slots.every((s) => typeof s.isAvailable === 'boolean'), 'availability resolved on every slot');
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
  const booked = await mt.bookSlot(PICK_A_SPOT, ['mock-bag-2'], ctx.session);
  assert.strictEqual(booked.ok, true, 'seed booking for the swap');
  const swap = await mt.swapSpots(booked.bookingId, 'mock-bag-2', 'mock-ground-5', ctx.session);
  assert.strictEqual(swap.ok, true, 'swap succeeds');
  assert.strictEqual(swap.slotId, 'mock-ground-5', 'result reflects the new spot');
  // Clean up so a re-run starts from a consistent spot state.
  await mt.cancelBooking(swap.bookingId, ctx.session);
});

check('getCredits/getMemberships: mock account has a membership, no credit packs', async () => {
  const mt = getProvider('jab-boxing');
  assert.deepStrictEqual(await mt.getCredits(ctx.session), [], 'no credit packs (membership-based)');
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
