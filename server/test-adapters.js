// Sweat Assistant — provider adapter unit tests (WP-T1).
//
// Deterministic, no-network normalization coverage for both providers:
//   - server/providers/normalize.js  — the shared shape builders + coercion.
//   - server/providers/codexfit.js   — CodexFit → NormalizedEvent/Slot/BookingResult.
//   - server/providers/marianatek.js — MarianaTek → same, asserted against the
//     REAL captured fixtures in server/__fixtures__/marianatek/ (WP-R3 + the
//     production-account capture, §1H). Testing against real captured JSON is
//     the whole point — it catches field-mapping drift the mock can't, since the
//     mock's shapes were themselves modeled from these fixtures.
//
// Convention: plain-Node assertions (no test framework), matching
// test-regression-psycle.js / test-auth-and-proxy.js. Run directly:
//   node server/test-adapters.js
//
// SAFETY: this suite performs NO booking mutations. CodexFit write paths are
// tested via a stubbed request() (canned response), never against mock.js —
// so it never touches the git-tracked server/mock_bookings.dbjson fixture (the
// gotcha flagged repeatedly in PROGRESS.md). CodexFit *reads* go through the
// dev mock (GET only, no mutation).

// crypto.js fatally exits without ENCRYPTION_KEY; set a dummy before any require
// chain that might reach it (adapters don't, but be defensive).
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { makeEvent, makeSlot, makeMembership, makeBookingResult, prune } = require('./providers/normalize');
const { getProvider } = require('./providers');

const FIXTURES = path.join(__dirname, '__fixtures__', 'marianatek');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// A minimal fetch-Response stand-in for stubbing adapter.request/publicRequest.
const fakeRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
});

// Run a fn with a temporarily-stubbed method on an object, always restoring it.
async function withStub(obj, method, impl, fn) {
  const original = obj[method];
  obj[method] = impl;
  try { return await fn(); }
  finally { obj[method] = original; }
}


let passed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ===========================================================================
// 1. normalize.js — shared builders + coercion
// ===========================================================================

check('normalize: makeEvent coerces ids to strings and prunes undefined', () => {
  const e = makeEvent({ id: 1000, gymId: 'psycle-london', name: 'Ride', studioId: 138, capacity: 40 });
  assert.strictEqual(e.id, '1000', 'id coerced to string');
  assert.strictEqual(e.studioId, '138', 'studioId coerced to string');
  assert.strictEqual(e.capacity, 40, 'numeric capacity preserved');
  assert.ok(!('discipline' in e), 'undefined discipline pruned');
  assert.ok(!('releaseAt' in e), 'undefined releaseAt pruned');
  assert.deepStrictEqual(e.instructors, [], 'instructors defaults to []');
  assert.strictEqual(e.layoutFormat, 'pick-a-spot', 'layoutFormat defaults to pick-a-spot');
});

check('normalize: makeEvent maps instructors through makeInstructor', () => {
  const e = makeEvent({ id: 1, gymId: 'g', instructors: [{ id: 7, name: 'Alex', imageUrl: 'x.jpg' }] });
  assert.strictEqual(e.instructors[0].id, '7');
  assert.strictEqual(e.instructors[0].name, 'Alex');
  assert.match(e.instructors[0].imageUrl, /^\/api\/instructor-photo\/g\/7\?size=full&v=[a-f0-9]{64}$/);
  assert.match(e.instructors[0].thumbUrl, /^\/api\/instructor-photo\/g\/7\?size=thumb&v=[a-f0-9]{64}$/);
});

check('normalize: makeMembership keeps membership semantics separate from credits', () => {
  const membership = makeMembership({
    id: 42, name: 'Rolling Monthly', status: 'Active', isActive: true,
    guestPassesRemaining: '1', guestPassesTotal: 2,
  });
  assert.deepStrictEqual(membership, {
    id: '42', name: 'Rolling Monthly', status: 'Active', isActive: true,
    guestPassesRemaining: 1, guestPassesTotal: 2,
  });
});

check('normalize: makeSlot derives row from y and defaults isAvailable to false', () => {
  const s = makeSlot({ id: 36272, label: '1', x: 0, y: 2.37, isAvailable: undefined });
  assert.strictEqual(s.id, '36272');
  assert.strictEqual(s.label, '1');
  assert.strictEqual(s.row, 2.4, 'row = round(y*10)/10');
  assert.strictEqual(s.isAvailable, false, 'isAvailable defaults to false when unset');
});

check('normalize: makeSlot label falls back to id when unlabeled', () => {
  const s = makeSlot({ id: 99, isAvailable: true });
  assert.strictEqual(s.label, '99', 'label falls back to stringified id');
  assert.strictEqual(s.isAvailable, true);
});

check('normalize: makeBookingResult carries HTTP status through (WP-N3 contract)', () => {
  const fail = makeBookingResult({ ok: false, status: 401, error: 'Unauthenticated.' });
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.status, 401, 'status preserved for the relogin-retry ladder');
  assert.strictEqual(fail.error, 'Unauthenticated.');
  const okRes = makeBookingResult({ ok: true, bookingId: 8255409, slotId: 53 });
  assert.strictEqual(okRes.bookingId, '8255409', 'bookingId coerced to string');
  assert.strictEqual(okRes.slotId, '53', 'slotId coerced to string');
  assert.ok(!('status' in okRes), 'undefined status pruned on success');
});

check('normalize: prune keeps falsy 0/false/"" but drops undefined', () => {
  const o = prune({ a: 0, b: false, c: '', d: undefined, e: null });
  assert.deepStrictEqual(o, { a: 0, b: false, c: '', e: null }, 'only undefined removed');
});

// ===========================================================================
// 2. CodexFit adapter — normalization (reads via dev mock; writes stubbed)
// ===========================================================================

check('codexfit: fetchTimetable normalizes the mock event list', async () => {
  const cf = getProvider('psycle-london');
  const events = await cf.fetchTimetable({}, { accessToken: 'mock-jwt-token' });
  assert.ok(Array.isArray(events) && events.length > 0, 'returns a non-empty event array');
  const e = events[0];
  assert.strictEqual(typeof e.id, 'string', 'id is a string');
  assert.strictEqual(e.gymId, 'psycle-london', 'gymId stamped');
  assert.ok(e.name && e.name.length > 0, 'name populated');
  assert.strictEqual(e.layoutFormat, 'pick-a-spot', 'CodexFit is always pick-a-spot');
  assert.ok(Array.isArray(e.instructors), 'instructors is an array');
});

check('codexfit: fetchEventDetails maps floor-plan slots + the now-enriched event (real shape, via the dev mock)', async () => {
  const cf = getProvider('psycle-london');
  const { event, slots, maxBookableSlots } = await cf.fetchEventDetails('1000', { accessToken: 'mock-jwt-token' });
  assert.strictEqual(event.id, '1000', 'event id echoed');
  assert.ok(event.name, 'event has a name (resolved via relations — real API confirmed richer than the old minimal shape)');
  assert.ok(event.startAt, 'event has a startAt');
  assert.ok(event.instructors.length > 0, 'event has a resolved instructor');
  assert.ok(event.studioName, 'event has a resolved studio name');
  assert.ok(slots.length > 0, 'floor-plan slots returned');
  const s = slots[0];
  assert.strictEqual(typeof s.id, 'string', 'slot id is a string');
  assert.ok('label' in s, 'slot has a label');
  assert.strictEqual(typeof s.isAvailable, 'boolean', 'isAvailable resolved to a boolean');
  assert.strictEqual(maxBookableSlots, 10, 'maxBookableSlots read from the sibling-of-data field (WP-C5)');
});

check('codexfit: fetchEventDetails resolves id-referenced relations (real API shape, stubbed)', async () => {
  const cf = getProvider('psycle-london');
  const { event, slots } = await withStub(cf, 'request',
    async () => fakeRes({
      data: { id: 207551, instructor_id: 531, studio_id: 108, event_type_id: 2984, start_at: '2026-07-07T06:30:00', duration: 45, occupancy: 5, capacity: 58 },
      slots: [1, 3], // slot 2 deliberately absent — booked/unavailable
      relations: {
        instructors: [{ id: 531, full_name: 'Shani' }],
        event_types: [{ id: 2984, name: 'RIDE: 2000s Throwbacks 45', group: { name: 'Ride' } }],
        studios: [{ id: 108, name: 'Ride Studio 1', location_id: 1, layout: { slots: [{ id: 1, x: 250, y: 0 }, { id: 2, x: 650, y: 0 }] } }],
        locations: [{ id: 1, name: 'Psycle Oxford Circus' }],
      },
    }),
    () => cf.fetchEventDetails('207551', { accessToken: 'tok' }));
  assert.strictEqual(event.name, 'RIDE: 2000s Throwbacks 45');
  assert.strictEqual(event.discipline, 'Ride');
  assert.strictEqual(event.startAt, '2026-07-07T06:30:00+01:00');
  assert.strictEqual(event.endAt, '2026-07-07T07:15:00.000+01:00', 'endAt computed via Luxon in Europe/London (BST +01:00 in July), not bare Date arithmetic');
  assert.strictEqual(event.studioName, 'Ride Studio 1');
  assert.strictEqual(event.locationName, 'Psycle Oxford Circus');
  assert.strictEqual(event.instructors[0].name, 'Shani');
  assert.strictEqual(event.availableCount, 53, 'capacity(58) - occupancy(5)');
  assert.strictEqual(slots.length, 2, 'layout slots mapped from relations.studios[0].layout');
  assert.strictEqual(slots.find((s) => s.id === '1').isAvailable, true, 'slot 1 is in the top-level slots array');
  assert.strictEqual(slots.find((s) => s.id === '2').isAvailable, false, 'slot 2 is NOT in the top-level slots array (booked)');
});

check('codexfit: bookSlot parses the { success, bookings:{id:slot} } shape', async () => {
  const cf = getProvider('psycle-london');
  const result = await withStub(cf, 'request',
    async () => fakeRes({ success: true, bookings: { '8255409': 53 } }),
    () => cf.bookSlot('1000', ['53'], { accessToken: 'tok' }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.bookingId, '8255409', 'bookingId = key of the bookings map');
  assert.strictEqual(result.slotId, '53', 'slotId = value of the bookings map');
});

check('codexfit: bookSlot failure surfaces status for the relogin ladder', async () => {
  const cf = getProvider('psycle-london');
  const result = await withStub(cf, 'request',
    async () => fakeRes({ message: 'Unauthenticated.' }, { ok: false, status: 401 }),
    () => cf.bookSlot('1000', ['53'], { accessToken: 'stale' }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 401, 'a 401 here is the signal scheduler.js retries on');
  assert.strictEqual(result.error, 'Unauthenticated.');
});

check('codexfit: listBookings normalizes a booking with no relations data (event stays unset)', async () => {
  const cf = getProvider('psycle-london');
  const bookings = await withStub(cf, 'request',
    async () => fakeRes([{ id: 8255409, event_id: 1000, studio_slot: { id: 53, label: '53' }, cancelled_at: null }]),
    () => cf.listBookings({ accessToken: 'tok' }));
  assert.strictEqual(bookings.length, 1);
  assert.strictEqual(bookings[0].bookingId, '8255409');
  assert.strictEqual(bookings[0].eventId, '1000');
  assert.strictEqual(bookings[0].slotId, '53', 'slotId resolved from studio_slot.id fallback');
  assert.strictEqual(bookings[0].isWaitlist, false);
  assert.ok(!('event' in bookings[0]), 'no relations block + no inline event → event stays unset');
});

check('codexfit: listBookings resolves event via the top-level relations block (real API shape)', async () => {
  const cf = getProvider('psycle-london');
  const bookings = await withStub(cf, 'request',
    async () => fakeRes({
      data: [{ id: 8286252, event_id: 207544, slot: 5, cancelled_at: null }],
      relations: {
        events: [{ id: 207544, instructor_id: 230, studio_id: 108, event_type_id: 1, start_at: '2026-07-06T10:00:00', duration: 45, capacity: 40, occupancy: 5 }],
        instructors: [{ id: 230, full_name: 'Shani' }],
        event_types: [{ id: 1, name: 'RIDE: Signature 45', group: { name: 'Ride' } }],
        studios: [{ id: 108, name: 'Ride Studio 1', location_id: 1 }],
        locations: [{ id: 1, name: 'Psycle Oxford Circus' }],
      },
    }),
    () => cf.listBookings({ accessToken: 'tok' }));
  assert.strictEqual(bookings.length, 1);
  assert.strictEqual(bookings[0].slotId, '5', 'slot is a bare number on the real API, not studio_slot.id');
  assert.ok(bookings[0].event, 'event resolved via the relations join');
  assert.strictEqual(bookings[0].event.name, 'RIDE: Signature 45', 'name falls back to the resolved event_type name');
  assert.strictEqual(bookings[0].event.startAt, '2026-07-06T10:00:00+01:00'); // naive local + gym zone offset
  assert.strictEqual(bookings[0].event.studioName, 'Ride Studio 1');
  assert.strictEqual(bookings[0].event.locationName, 'Psycle Oxford Circus');
  assert.strictEqual(bookings[0].event.instructors[0].name, 'Shani');
  assert.strictEqual(bookings[0].event.availableCount, 35);
});

check('codexfit: listBookings resolves event via an inline b.event (dev-mock convention)', async () => {
  const cf = getProvider('psycle-london');
  const bookings = await withStub(cf, 'request',
    async () => fakeRes([{
      id: 1, event_id: 1000, slot: 5, cancelled_at: null,
      event: { id: 1000, name: 'Ride 45', start_at: '2026-07-06T08:30:00Z', instructor: { id: 10, name: 'Adam' }, studio: { id: 138, name: 'Ride Studio' } },
    }]),
    () => cf.listBookings({ accessToken: 'tok' }));
  assert.ok(bookings[0].event, 'inline b.event resolved without needing a relations join');
  assert.strictEqual(bookings[0].event.name, 'Ride 45');
  assert.strictEqual(bookings[0].event.instructors[0].name, 'Adam');
});

check('codexfit: listBookings filters out cancelled entries', async () => {
  const cf = getProvider('psycle-london');
  const bookings = await withStub(cf, 'request',
    async () => fakeRes([
      { id: 1, event_id: 1000, slot: 5, cancelled_at: null },
      { id: 2, event_id: 1001, slot: 6, cancelled_at: '2026-01-01T00:00:00Z' },
    ]),
    () => cf.listBookings({ accessToken: 'tok' }));
  assert.strictEqual(bookings.length, 1, 'cancelled booking excluded');
  assert.strictEqual(bookings[0].bookingId, '1');
});

check('codexfit: listWaitlists resolves an inline w.event directly (no relations join needed)', async () => {
  const cf = getProvider('psycle-london');
  const waitlists = await withStub(cf, 'request',
    async () => fakeRes([{
      id: 291511, event_id: 207761, cancelled_at: null,
      event: { id: 207761, event_type: { name: 'BARRE: Abs & Arms 45', group: { name: 'Barre' } }, instructor: { id: 254, full_name: 'Daniel' }, studio: { id: 71, name: 'Barre Studio', location: { id: 1, name: 'Psycle Oxford Circus' } }, start_at: '2026-07-07 07:30:00' },
    }]),
    () => cf.listWaitlists({ accessToken: 'tok' }));
  assert.strictEqual(waitlists.length, 1);
  assert.ok(waitlists[0].event, 'w.event is embedded inline on the real API — no extra fetch needed');
  assert.strictEqual(waitlists[0].event.name, 'BARRE: Abs & Arms 45');
  assert.strictEqual(waitlists[0].event.discipline, 'Barre');
  assert.strictEqual(waitlists[0].event.instructors[0].name, 'Daniel');
});

check('codexfit: listWaitlists normalizes with isWaitlist:true', async () => {
  const cf = getProvider('psycle-london');
  const waitlists = await withStub(cf, 'request',
    async () => fakeRes([{ id: 99, event_id: 1002, cancelled_at: null }]),
    () => cf.listWaitlists({ accessToken: 'tok' }));
  assert.strictEqual(waitlists.length, 1);
  assert.strictEqual(waitlists[0].eventId, '1002');
  assert.strictEqual(waitlists[0].isWaitlist, true);
});

check('codexfit: getProfile normalizes booking-window cutoffs', async () => {
  const cf = getProvider('psycle-london');
  const profile = await withStub(cf, 'request',
    async () => fakeRes({ id: 42, email: 'a@b.com', first_name: 'Sam', last_name: 'Doe', booking_cutoff: '2026-07-10T12:00:00Z', extended_cutoff: '2026-07-17T12:00:00Z' }),
    () => cf.getProfile({ accessToken: 'tok' }));
  assert.strictEqual(profile.id, '42');
  assert.strictEqual(profile.firstName, 'Sam');
  assert.strictEqual(profile.bookingCutoff, '2026-07-10T12:00:00Z');
  assert.strictEqual(profile.extendedCutoff, '2026-07-17T12:00:00Z');
});

check('codexfit: fetchStudioLayout reads GET /studios (list) and filters by id, not an unconfirmed /studios/{id}', async () => {
  const cf = getProvider('psycle-london');
  const { slots, objects } = await withStub(cf, 'request',
    async () => fakeRes([
      { id: 138, name: 'Ride Studio', layout: {
        slots: [{ id: 11, name: 'Bike 11', x: 100, y: 100 }],
        objects: [{ id: 900, name: 'Podium', x: 450, y: 20 }],
      } },
      { id: 139, name: 'Barre Studio' }, // no layout — real-world gap (e.g. Reformer)
    ]),
    () => cf.fetchStudioLayout('138', { accessToken: 'tok' }));
  assert.strictEqual(slots.length, 1, 'finds studio 138 and maps its layout');
  assert.strictEqual(slots[0].label, 'Bike 11');
  assert.strictEqual(typeof slots[0].id, 'string');
  // WP-C5: non-bookable fixtures come back normalized alongside the slots, so
  // the shared floor-plan renderer never has to touch a raw provider shape.
  assert.strictEqual(objects.length, 1, 'layout.objects normalized too');
  assert.deepStrictEqual(
    { id: objects[0].id, label: objects[0].label, x: objects[0].x, y: objects[0].y },
    { id: '900', label: 'Podium', x: 450, y: 20 });

  const empty = await withStub(cf, 'request',
    async () => fakeRes([{ id: 138, name: 'Ride Studio' }]),
    () => cf.fetchStudioLayout('139', { accessToken: 'tok' }));
  assert.deepStrictEqual(empty, { slots: [], objects: [] },
    'unknown/no-layout studio returns empty slots+objects (not an error)');
});

check('marianatek: fetchStudioLayout proxies through any upcoming class at that studio (no studio-level endpoint exists — Q12)', async () => {
  const mt = getProvider('jab-boxing');
  const classesList = readFixture('classes-list.json');
  const classDetail = readFixture('class-detail-with-layout.json');
  const studioId = String(mt.mapClassToEvent(classesList.results[0]).studioId);
  const { slots, objects } = await withStub(mt, 'request',
    async (path) => (path.startsWith('/classes/') && !path.includes('?'))
      ? fakeRes(classDetail)
      : fakeRes(classesList),
    () => mt.fetchStudioLayout(studioId, { accessToken: 'tok' }));
  assert.ok(slots.length > 0, 'proxies through a real class detail to get the studio layout');
  // MT's layout schema carries `spots` only — no podium/stage fixtures exist,
  // so `objects` is always empty rather than absent (WP-C5 contract).
  assert.deepStrictEqual(objects, [], 'MT has no layout objects, but the key is always present');

  const none = await withStub(mt, 'request', async () => fakeRes(classesList),
    () => mt.fetchStudioLayout('nonexistent-studio-id', { accessToken: 'tok' }));
  assert.deepStrictEqual(none, { slots: [], objects: [] }, 'no matching studio → empty (not an error)');
});

// ===========================================================================
// 3. MarianaTek adapter — normalization against REAL captured fixtures
// ===========================================================================

check('marianatek: mapClassToEvent maps a real pick-a-spot class (classes-list.json)', () => {
  const mt = getProvider('jab-boxing');
  const raw = readFixture('classes-list.json').results[0];
  const e = mt.mapClassToEvent(raw);
  assert.strictEqual(e.gymId, 'jab-boxing', 'gymId stamped');
  assert.strictEqual(e.id, String(raw.id), 'id preserved as string');
  assert.strictEqual(e.name, raw.name, 'name preserved');
  // class_type.name is the real category — classroom_name is the physical
  // room, which drifts from the discipline for classes like "Small Group
  // Boxing PT" in a room called "Boxing Studio" (confirmed 2026-09-15 against
  // 855 live classes, 68 of which disagreed with classroom_name).
  assert.strictEqual(e.discipline, raw.class_type.name, 'discipline = class_type.name, not classroom_name (the room)');
  assert.strictEqual(e.studioId, String(raw.classroom.id), 'studioId = classroom.id (room, not building)');
  assert.strictEqual(e.studioName, raw.classroom.name, 'studioName = classroom.name');
  assert.strictEqual(e.locationId, String(raw.location.id), 'locationId = location.id (building)');
  assert.strictEqual(e.locationName, raw.location.name, 'locationName = location.name');
  assert.strictEqual(new Date(e.startAt).getTime(), new Date(raw.start_datetime).getTime(), 'startAt = start_datetime (same instant, gym-local offset)');
  assert.strictEqual(e.releaseAt, raw.booking_start_datetime, 'releaseAt = booking_start_datetime (§1H)');
  assert.strictEqual(e.layoutFormat, 'pick-a-spot', 'layout_format passthrough');
  assert.strictEqual(e.availableCount, raw.available_spot_count, 'availableCount = available_spot_count');
});

check('marianatek: mapClassToEvent computes endAt from class_type.duration (minutes)', () => {
  const mt = getProvider('jab-boxing');
  const raw = readFixture('classes-list.json').results[0];
  const e = mt.mapClassToEvent(raw);
  const expectedEnd = new Date(new Date(raw.start_datetime).getTime() + raw.class_type.duration * 60000).toISOString();
  assert.strictEqual(new Date(e.endAt).toISOString(), expectedEnd, 'endAt = start + duration minutes (same instant, zoned ISO)');
});

check('marianatek: mapLayoutToSlots maps the full 40-spot pick-a-spot layout', () => {
  const mt = getProvider('jab-boxing');
  const detail = readFixture('class-detail-with-layout.json');
  const slots = mt.mapLayoutToSlots(detail.layout);
  assert.strictEqual(slots.length, 40, 'all 40 spots mapped');
  const raw0 = detail.layout.spots[0];
  const s0 = slots[0];
  assert.strictEqual(s0.id, String(raw0.id), 'spot id preserved as string');
  assert.strictEqual(s0.label, raw0.name, 'label = spot name');
  assert.strictEqual(s0.x, raw0.x_position, 'x = x_position');
  assert.strictEqual(s0.y, raw0.y_position, 'y = y_position');
  assert.strictEqual(s0.isAvailable, raw0.is_available, 'isAvailable = is_available');
  assert.strictEqual(s0.isPrimary, raw0.spot_type.is_primary, 'isPrimary = spot_type.is_primary');
  assert.strictEqual(s0.spotType, raw0.spot_type.name, 'spotType = spot_type.name');
});

check('marianatek: mapLayoutToSlots returns [] for FCFS (layout:null)', () => {
  const mt = getProvider('jab-boxing');
  const fcfs = readFixture('class-detail-fcfs.json');
  assert.strictEqual(fcfs.layout, null, 'fixture confirms FCFS has null layout');
  assert.deepStrictEqual(mt.mapLayoutToSlots(fcfs.layout), [], 'no picker for FCFS');
});

check('marianatek: getProfile normalizes /me/account (prod-me-account.json)', async () => {
  const mt = getProvider('jab-boxing');
  const account = readFixture('prod-me-account.json');
  const profile = await withStub(mt, 'request',
    async () => fakeRes(account),
    () => mt.getProfile({ accessToken: 'tok' }));
  assert.strictEqual(profile.id, String(account.id), 'id mapped');
  assert.strictEqual(profile.email, account.email, 'email mapped');
  assert.strictEqual(profile.firstName, account.first_name, 'firstName = first_name');
  assert.strictEqual(profile.lastName, account.last_name, 'lastName = last_name');
  assert.ok(!('bookingCutoff' in profile), 'no CodexFit-style cutoff for MT (§1H)');
});

check('marianatek: getCredits/getMemberships unwrap the DRF results envelope', async () => {
  const mt = getProvider('jab-boxing');
  const credits = await withStub(mt, 'request',
    async () => fakeRes({ results: [{ id: 'c1', count: 3 }] }),
    () => mt.getCredits({ accessToken: 'tok' }));
  assert.strictEqual(credits.length, 1, 'credits = data.results');
  assert.strictEqual(credits[0].id, 'c1');
  assert.strictEqual(credits[0].count, 3);
  const emptyMemberships = await withStub(mt, 'request',
    async () => fakeRes({ results: [] }),
    () => mt.getMemberships({ accessToken: 'tok' }));
  assert.deepStrictEqual(emptyMemberships, [], 'empty results → []');
});

check('marianatek: getMembership maps the active membership to the shared shape', async () => {
  const mt = getProvider('jab-boxing');
  const raw = {
    id: 2552, name: 'Original', status: 'Active', is_active: true,
    guest_usage_limit: 2, guest_remaining_usage_count: 1,
    booking_window_display: 'Reserve 14 days in advance',
  };
  const membership = await withStub(mt, 'getMemberships', async () => [raw],
    () => mt.getMembership({ accessToken: 'tok' }));
  assert.strictEqual(membership.id, '2552');
  assert.strictEqual(membership.name, 'Original');
  assert.strictEqual(membership.isActive, true);
  assert.strictEqual(membership.guestPassesRemaining, 1);
  assert.strictEqual(membership.guestPassesTotal, 2);
  assert.strictEqual(membership.bookingWindowLabel, 'Reserve 14 days in advance');
  assert.strictEqual(membership.manageUrl, 'https://jabboxing.club/');
});

check('codexfit: getMembership returns null instead of manufacturing one from credits', async () => {
  assert.strictEqual(await getProvider('psycle-london').getMembership({ accessToken: 'tok' }), null);
});

check('marianatek: bookSlot success parses a real reservation response (prod fixture)', async () => {
  const mt = getProvider('jab-boxing');
  const booking = readFixture('prod-booking-response-membership.json');
  // Stub class detail, payment-option lookup, and POST (all provider requests).
  const result = await withStub(mt, 'resolvePaymentOption', async () => 'membership-2552',
    () => withStub(mt, 'fetchEventDetails', async () => ({ event: { isUserBooked: false } }),
      () => withStub(mt, 'request', async () => fakeRes(booking),
        () => mt.bookSlot(String(booking.class_session.id), booking.spot ? [String(booking.spot.id)] : [], { accessToken: 'tok' }))));
  assert.strictEqual(result.ok, true, 'success result');
  assert.strictEqual(result.bookingId, String(booking.id), 'bookingId = reservation id');
  if (booking.spot) assert.strictEqual(result.slotId, String(booking.spot.id), 'slotId = spot id');
});

check('marianatek: bookSlot failure normalizes non_field_errors', async () => {
  const mt = getProvider('jab-boxing');
  const result = await withStub(mt, 'resolvePaymentOption', async () => null,
    () => withStub(mt, 'fetchEventDetails', async () => ({ event: { isUserBooked: false } }),
      () => withStub(mt, 'request',
        async () => fakeRes({ non_field_errors: ['The payments do not satisfy the cost of this reservation.'] }, { ok: false, status: 400 }),
        () => mt.bookSlot('123', [], { accessToken: 'tok' }))));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'The payments do not satisfy the cost of this reservation.', 'error = non_field_errors[0]');
  assert.strictEqual(result.status, 400);
});

check('marianatek: duplicate reservation is an explicit terminal conflict', async () => {
  const mt = getProvider('jab-boxing');
  const result = await withStub(mt, 'fetchEventDetails', async () => ({ event: { isUserBooked: true } }),
    () => mt.bookSlot('123', ['spot-1'], { accessToken: 'tok' }));
  assert.deepStrictEqual({ ok: result.ok, status: result.status, code: result.code }, {
    ok: false, status: 409, code: 'ALREADY_BOOKED',
  });
});

check('marianatek: JAB rejects more than one attendee before any booking request', async () => {
  const mt = getProvider('jab-boxing');
  let fetched = false;
  const result = await withStub(mt, 'fetchEventDetails', async () => { fetched = true; return { event: {} }; },
    () => mt.bookSlot('123', ['spot-1', 'spot-2'], { accessToken: 'tok' }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ATTENDEE_LIMIT_EXCEEDED');
  assert.strictEqual(fetched, false, 'reject before provider traffic');
});

check('marianatek: booking request aborts on timeout with a retry-safe message', async () => {
  const mt = getProvider('jab-boxing');
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    await assert.rejects(
      () => mt.request('/me/reservations', { token: 'tok', method: 'POST', timeoutMs: 5 }),
      (err) => err.code === 'BOOKING_TIMEOUT' && err.status === 504 && /check My Bookings/i.test(err.message),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

check('marianatek: getCancelPenalty maps is_penalty_cancel', async () => {
  const mt = getProvider('jab-boxing');
  const free = await withStub(mt, 'request', async () => fakeRes({ is_penalty_cancel: false }),
    () => mt.getCancelPenalty('r1', { accessToken: 'tok' }));
  assert.strictEqual(free.isPenalty, false, 'zero-penalty maps to isPenalty:false');
  const pen = await withStub(mt, 'request', async () => fakeRes({ is_penalty_cancel: true, message: 'Late cancel fee applies.' }),
    () => mt.getCancelPenalty('r2', { accessToken: 'tok' }));
  assert.strictEqual(pen.isPenalty, true);
  assert.strictEqual(pen.message, 'Late cancel fee applies.');
});

// ===========================================================================
// 4. Shared floor-plan renderer contract (WP-C5)
// ===========================================================================
//
// The client's three floor-plan renderers (spotmap.js's editor, timetable.js's
// openBookingModal, bookings.js's openEditBookingModal) consume NormalizedSlot[]
// and NormalizedLayoutObject[] directly — no provider-specific shapes. These
// checks pin the exact fields those renderers read, for BOTH providers, so a
// future adapter change that drops one is caught here rather than as a blank
// floor plan in the browser.

function assertRendersAsFloorPlan(slots, objects, who) {
  assert.ok(Array.isArray(slots) && slots.length > 0, `${who}: has slots to render`);
  slots.forEach((s) => {
    // Rendering reads .label; positioning reads .x/.y; colouring reads .isAvailable.
    assert.strictEqual(typeof s.id, 'string', `${who}: slot id is a string`);
    assert.ok(Number.isFinite(Number(s.id)), `${who}: slot id coerces to a number (preferred-spot maps store numbers)`);
    assert.ok(typeof s.label === 'string' && s.label.length > 0, `${who}: slot has a non-empty label`);
    assert.strictEqual(typeof s.x, 'number', `${who}: slot x is numeric`);
    assert.strictEqual(typeof s.y, 'number', `${who}: slot y is numeric`);
    assert.strictEqual(typeof s.isAvailable, 'boolean', `${who}: slot availability is a boolean`);
  });
  // Whole-row preferences group by y — needs at least one distinct row.
  assert.ok(new Set(slots.map((s) => s.y)).size > 0, `${who}: rows derivable from y`);
  assert.ok(Array.isArray(objects), `${who}: objects is always an array, never undefined`);
  objects.forEach((o) => {
    assert.strictEqual(typeof o.x, 'number', `${who}: layout object x is numeric`);
    assert.strictEqual(typeof o.y, 'number', `${who}: layout object y is numeric`);
  });
}

check('renderer contract: a CodexFit event layout satisfies every field the floor-plan renderers read', async () => {
  const cf = getProvider('psycle-london');
  const { slots, objects } = await withStub(cf, 'request',
    async () => fakeRes({
      data: { id: 1000, studio_id: 138, start_at: '2026-09-07T19:30:00' },
      slots: [11, 12],
      relations: { studios: [{ id: 138, name: 'Ride Studio', layout: {
        slots: [
          { id: 11, name: 'Bike 11', x: 100, y: 100 },
          { id: 12, name: 'Bike 12', x: 200, y: 100 },
          { id: 21, name: 'Bike 21', x: 100, y: 200 },
        ],
        objects: [{ id: 900, name: 'Podium', x: 150, y: 20 }],
      } }] },
    }),
    () => cf.fetchEventDetails('1000', { accessToken: 'tok' }));
  assertRendersAsFloorPlan(slots, objects, 'codexfit');
  assert.deepStrictEqual(slots.filter((s) => s.isAvailable).map((s) => s.id), ['11', '12'],
    'availability comes from the sibling `slots` id list');
  assert.strictEqual(objects[0].label, 'Podium');
});

check('renderer contract: a REAL MarianaTek layout satisfies the same contract (this is what C5 unblocks)', async () => {
  const mt = getProvider('jab-boxing');
  const { slots, objects } = await withStub(mt, 'request',
    async () => fakeRes(readFixture('class-detail-with-layout.json')),
    () => mt.fetchEventDetails('123', { accessToken: 'tok' }));
  assertRendersAsFloorPlan(slots, objects, 'marianatek');
  assert.strictEqual(slots.length, 40, 'the real 40-spot JAB layout');
  assert.deepStrictEqual(objects, [], 'MT has no floor fixtures — renderers must handle an empty array');
});

check('renderer contract: an FCFS MarianaTek class reports layoutFormat, not just empty slots', async () => {
  const mt = getProvider('jab-boxing');
  const { event, slots, objects } = await withStub(mt, 'request',
    async () => fakeRes(readFixture('class-detail-fcfs.json')),
    () => mt.fetchEventDetails('456', { accessToken: 'tok' }));
  // The client now branches on layoutFormat explicitly rather than inferring
  // "no picker" from an empty slot list (which conflates FCFS with a missing
  // floor map) — so this field must survive normalization.
  assert.strictEqual(event.layoutFormat, 'first-come-first-serve');
  assert.deepStrictEqual(slots, []);
  assert.deepStrictEqual(objects, []);
});

// ===========================================================================
// Runner
// ===========================================================================

// --- Metadata lists (WP-D9) --------------------------------------------------
//
// The same four lists from two platforms that expose them completely
// differently: CodexFit has a dedicated endpoint each, MarianaTek has none at
// all and derives every one from its class list. The point of these checks is
// that the SHAPE is identical regardless — that is what lets the client stop
// caring which platform it is talking to.

check('CodexFit builds metadata from its four dedicated endpoints', async () => {
  const cf = getProvider('psycle-london');
  const m = await cf.fetchMetadata({}, { accessToken: 'mock-jwt-token' });
  assert.ok(m.locations.length > 0 && m.studios.length > 0);
  assert.ok(m.instructors.length > 0 && m.classTypes.length > 0);
  const studio = m.studios.find((st) => st.hasLayout);
  assert.ok(studio, 'at least one studio reports a floor plan');
  assert.strictEqual(typeof studio.id, 'string', 'ids are normalized to strings');
  assert.ok(studio.locationId, 'studios carry their location, for the filter UI');
});

check('MarianaTek derives all four lists from its class list', async () => {
  const mt = getProvider('jab-boxing');
  const m = await mt.fetchMetadata({}, { accessToken: 'mock-mt-token' });
  assert.ok(m.locations.length > 0, 'derived, despite MT having no /locations metadata endpoint');
  assert.ok(m.studios.length > 0, 'and no /studios endpoint at all (Q12)');
  assert.ok(m.instructors.length > 0);
  assert.ok(m.classTypes.length > 0);
});

check('row groups: Psycle ride studios flagged, JAB studios never', async () => {
  const [a, b] = await Promise.all([
    getProvider('psycle-london').fetchMetadata({}, { accessToken: 'mock-jwt-token' }),
    getProvider('jab-boxing').fetchMetadata({}, { accessToken: 'mock-mt-token' }),
  ]);
  const ride = a.studios.filter((s) => /^ride/i.test(s.name));
  assert.ok(ride.length > 0 && ride.every((s) => s.rowGroups === true), 'ride studios have rowGroups');
  assert.ok(a.studios.filter((s) => !/^ride/i.test(s.name)).every((s) => s.rowGroups === false), 'others off');
  assert.ok(b.studios.length > 0 && b.studios.every((s) => s.rowGroups === false), 'JAB studios off by default');
});

check('both platforms return the identical metadata shape', async () => {
  const [a, b] = await Promise.all([
    getProvider('psycle-london').fetchMetadata({}, { accessToken: 'mock-jwt-token' }),
    getProvider('jab-boxing').fetchMetadata({}, { accessToken: 'mock-mt-token' }),
  ]);
  assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
  // Compare against the DECLARED shape, not against whichever fields the other
  // platform's fixtures happen to populate. `prune` drops undefined keys, so a
  // mock without addresses would otherwise make a real contract look violated.
  const ALLOWED = {
    locations: ['id', 'name', 'address', 'timeZone'],
    studios: ['id', 'name', 'locationId', 'locationName', 'hasLayout', 'rowGroups'],
    instructors: ['id', 'name', 'imageUrl'],
    classTypes: ['id', 'name', 'group'],
  };
  const keysOf = (list) => [...new Set(list.flatMap((x) => Object.keys(x)))].filter((k) => k !== 'raw');
  for (const k of ['locations', 'studios', 'instructors', 'classTypes']) {
    assert.ok(a[k].length && b[k].length, `${k} populated on both`);
    for (const [label, list] of [['CodexFit', a[k]], ['MarianaTek', b[k]]]) {
      const unknown = keysOf(list).filter((f) => !ALLOWED[k].includes(f));
      assert.deepStrictEqual(unknown, [],
        `${label} ${k} emits fields outside the normalized shape: ${unknown.join(', ')} — ` +
        'the client would have to know which gym it is talking to');
    }
    // And both must supply the fields the UI cannot render without.
    for (const list of [a[k], b[k]]) {
      assert.ok(list.every((x) => x.id && x.name != null), `${k}: every row needs an id and a name`);
    }
  }
});

check('derived studios report hasLayout from the class layout format', async () => {
  const mt = getProvider('jab-boxing');
  const m = await mt.fetchMetadata({}, { accessToken: 'mock-mt-token' });
  // MT mixes pick-a-spot and first-come-first-serve rooms; both must be present
  // and correctly flagged, or the booking UI offers a spot picker for a class
  // that has no spots.
  assert.ok(m.studios.some((st) => st.hasLayout === true), 'a pick-a-spot room reports a layout');
  assert.ok(m.studios.some((st) => !st.hasLayout), 'an FCFS room reports none');
});

check('MarianaTek: fetchTimetable follows links.next pagination across multiple pages', async () => {
  const mt = getProvider('jab-boxing');
  const page1 = {
    results: [
      { id: '101', name: 'Boxing 1', start_date: '2026-09-02', start_time: '09:00:00', start_datetime: '2026-09-02T09:00:00Z', capacity: 20, class_type: { name: 'Boxing', duration: 45 }, classroom: { id: 'c1', name: 'Room 1' }, instructors: [] }
    ],
    links: { next: 'https://jabboxingclub.marianatek.com/api/customer/v1/classes?page=2' }
  };
  const page2 = {
    results: [
      { id: '102', name: 'Boxing 2', start_date: '2026-09-03', start_time: '10:00:00', start_datetime: '2026-09-03T10:00:00Z', capacity: 20, class_type: { name: 'Boxing', duration: 45 }, classroom: { id: 'c1', name: 'Room 1' }, instructors: [] }
    ],
    links: { next: null }
  };

  const calledPaths = [];
  await withStub(mt, 'publicRequest', async (path) => {
    calledPaths.push(path);
    if (path.includes('page=2')) return fakeRes(page2);
    return fakeRes(page1);
  }, async () => {
    const events = await mt.fetchTimetable({ startDate: '2026-09-02', endDate: '2026-09-30' });
    assert.strictEqual(events.length, 2, 'retrieved classes across both pages');
    assert.strictEqual(events[0].id, '101');
    assert.strictEqual(events[1].id, '102');
    assert.strictEqual(calledPaths.length, 2, 'made 2 paginated requests');
  });
});

(async () => {
  console.log('\n🧪 Provider adapter unit tests (WP-T1)\n');
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
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} adapter checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
