// Sweat Assistant — dev-mode mock MarianaTek API (JAB Boxing). Mirrors
// server/mock.js's role for CodexFit: lets a developer exercise the full
// success path (browse -> book -> cancel -> waitlist) with no live network
// calls and no real credits, using the `dev@jabboxing.mock` account.
//
// Shapes are modeled directly on the REAL captured fixtures — both the test-
// account research (server/__fixtures__/marianatek/*.json, no prod- prefix)
// and the production-account capture (prod-*.json) — not guessed. Unlike the
// real JAB test account, this mock account HAS a working membership, so
// bookSlot/joinWaitlist/cancelBooking/swapSpots can all be exercised through
// their actual success paths — the one thing WP-M3's live testing couldn't
// reach. See Documentation/Archive/2026-09-26/Backlog/modular-gyms/PROGRESS.md WP-M5 handoff.

function createFakeResponse(data, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'application/json' : null; } },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const LOCATION = {
  id: '48751', name: 'SW1', address_line_one: 'Unit 5, Colonnade Walk, 151 Buckingham Palace Road',
  city: 'London', currency_code: 'GBP', postal_code: 'SW1W9SZ', timezone: 'Europe/London',
  payment_gateway_type: 'stripe', region: { id: '48575', name: 'Southeast' },
};

const INSTRUCTORS = [
  { id: '7197', name: 'George Davies', photo_urls: { thumbnail_url: null } },
  { id: '6255', name: 'Nickol', photo_urls: { thumbnail_url: null } },
  { id: '6301', name: 'Aaron Reid', photo_urls: { thumbnail_url: null } },
  { id: '6412', name: 'Simi', photo_urls: { thumbnail_url: null } },
  { id: '6580', name: 'Leila Haddad', photo_urls: { thumbnail_url: null } },
];

const CLASS_TYPES = {
  boxing: { id: '6266', name: 'BOXING Core & Power', duration: 60, duration_formatted: '60 minutes' },
  train: { id: '5898', name: 'TRAIN - Core & Glutes', duration: 50, duration_formatted: '50 minutes' },
  recovery: { id: '6301', name: 'RECOVERY (Members)', duration: 30, duration_formatted: '30 minutes' },
  fundamentals: { id: '6410', name: 'BOXING Fundamentals', duration: 45, duration_formatted: '45 minutes' },
  conditioning: { id: '6411', name: 'TRAIN - Full Body Conditioning', duration: 45, duration_formatted: '45 minutes' },
  sparring: { id: '6412', name: 'BOXING Technical Sparring', duration: 60, duration_formatted: '60 minutes' },
};

// [hh:mm, classType, classroom, layoutFormat] — a real JAB day runs an early
// block, a lunchtime express and an evening block, which is what makes the
// merged Psycle+JAB timetable interleave the way a real one would.
const WEEKDAY_SCHEDULE = [
  ['06:30', CLASS_TYPES.boxing, 'BOXING', 'pick-a-spot'],
  ['07:30', CLASS_TYPES.train, 'TRAIN', 'pick-a-spot'],
  ['09:00', CLASS_TYPES.fundamentals, 'BOXING', 'pick-a-spot'],
  ['12:15', CLASS_TYPES.conditioning, 'TRAIN', 'pick-a-spot'],
  ['17:30', CLASS_TYPES.boxing, 'BOXING', 'pick-a-spot'],
  ['18:30', CLASS_TYPES.sparring, 'BOXING', 'pick-a-spot'],
  ['19:00', CLASS_TYPES.train, 'TRAIN', 'pick-a-spot'],
  ['20:00', CLASS_TYPES.recovery, 'RECOVERY', 'first-come-first-serve'],
];
const WEEKEND_SCHEDULE = [
  ['09:00', CLASS_TYPES.boxing, 'BOXING', 'pick-a-spot'],
  ['10:00', CLASS_TYPES.fundamentals, 'BOXING', 'pick-a-spot'],
  ['11:00', CLASS_TYPES.conditioning, 'TRAIN', 'pick-a-spot'],
  ['12:00', CLASS_TYPES.recovery, 'RECOVERY', 'first-come-first-serve'],
];

// Pick-a-spot layout — 20 spots (10 bags, 10 ground), same shape family as the
// real 40-spot layout in class-detail-with-layout.json, just smaller for dev.
function makeLayout(bookedSpotIds) {
  const spots = [];
  for (let i = 1; i <= 10; i++) {
    spots.push({ id: `mock-bag-${i}`, name: `B${i}`, spot_type: { id: '6564', is_primary: true, name: 'Bag' }, x_position: i, y_position: 0, is_available: !bookedSpotIds.has(`mock-bag-${i}`) });
  }
  for (let i = 1; i <= 10; i++) {
    spots.push({ id: `mock-ground-${i}`, name: `G${i}`, spot_type: { id: '6563', is_primary: true, name: 'Ground' }, x_position: i, y_position: 2, is_available: !bookedSpotIds.has(`mock-ground-${i}`) });
  }
  return { id: 'mock-layout', name: 'MOCK BOXING', spots };
}

const PAYMENT_OPTION = {
  id: 'membership-mock-1',
  type: 'membership',
  description: 'Mock Rolling Monthly Membership (Exp. never)',
  membership_payment: {
    id: 'mock-1', status: 'Active', guest_usage_limit: 2, guest_remaining_usage_count: 2,
    commitment_length: 1, payment_interval: 'MO', is_active: true, is_charge_declined: false,
    booking_window_display: 'Reserve 14 days in advance', name: 'Mock Rolling Monthly Membership',
  },
};

let nextReservationId = 900001;
const reservations = new Map(); // id -> reservation object
const bookedSpotsByClass = new Map(); // classId -> Set<spotId>

function bookedSpotsFor(classId) {
  if (!bookedSpotsByClass.has(classId)) bookedSpotsByClass.set(classId, new Set());
  return bookedSpotsByClass.get(classId);
}

// Generate a rolling 14-day mock schedule.
//
// Days 0-10 are always freshly bookable (booking_start_datetime in the past), so
// dev mode and the suites never hit a "class isn't released yet" case for the
// classes they reach for (test-background-gym-session books 9100 = day 10).
//
// Days 11-13 model a rolling-continuous window (MarianaTek's real shape, see
// gyms.config.js jab-boxing.bookingWindow): a class opens exactly
// MOCK_ADVANCE_DAYS before it starts, so on those days it is still UNRELEASED —
// which is what makes JAB's Auto-Book path (and the cross-gym overlap
// confirmation, U1-6) exercisable against the mock at all. Before this, every JAB
// mock class was already open, so a JAB class could never be auto-booked in dev.
const MOCK_ADVANCE_DAYS = 10;
const FIRST_UNRELEASED_DAY = 11;
function generateClasses() {
  const classes = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const day = new Date(now.getTime() + i * 864e5);
    const iso = day.toISOString().split('T')[0];
    const dow = day.getDay();
    const template = (dow === 0 || dow === 6) ? WEEKEND_SCHEDULE : WEEKDAY_SCHEDULE;

    template.forEach(([time, classType, room, layoutFormat], slotIdx) => {
      const startMs = Date.parse(`${iso}T${time}:00Z`);
      const bookingStart = i >= FIRST_UNRELEASED_DAY
        ? new Date(startMs - MOCK_ADVANCE_DAYS * 864e5).toISOString()
        : new Date(now.getTime() - 864e5).toISOString();
      // Ids stay stable per (day, slot) across reloads — a queued auto-book
      // pointing at a class that no longer exists is not a state worth testing.
      classes.push(mockClass(`${9000 + i * 10 + slotIdx}`, classType, iso, `${time}:00`, room, layoutFormat, bookingStart, i * 7 + slotIdx));
    });
  }
  return classes;
}

function mockClass(id, classType, dateStr, timeStr, classroomName, layoutFormat, bookingStart, seedIdx = 0) {
  const startDatetime = `${dateStr}T${timeStr}Z`;
  const booked = bookedSpotsFor(id);
  const capacity = layoutFormat === 'pick-a-spot' ? 20 : 100;
  // Deterministic pre-booked occupancy so the list shows a realistic spread
  // (some full, some nearly empty) and does not reshuffle on reload.
  // Offset so the "completely full" case (seed 0) never lands on the FIRST
  // pick-a-spot class of day 0 — that is the class every suite reaches for, and
  // a room with no free spot fails them for a reason unrelated to what they test.
  const seed = (seedIdx + 3) % 10;
  const preBooked = seed === 0 ? capacity : Math.min(capacity - 1, Math.floor((capacity * (seed + 1)) / 13));
  // Fill from the BACK of the room forwards (ground-10 → ground-1, then
  // bag-10 → bag-1), which is both what a real room does and what keeps the
  // low-numbered spots free — several suites book mock-bag-1/-3 by name, and
  // pre-booking them turned a realistic mock into two failing tests.
  if (layoutFormat === 'pick-a-spot') {
    let remaining = preBooked;
    for (let n = 10; n >= 1 && remaining > 0; n--, remaining--) booked.add(`mock-ground-${n}`);
    for (let n = 10; n >= 4 && remaining > 0; n--, remaining--) booked.add(`mock-bag-${n}`);
  }
  return {
    id, name: classType.name, start_date: dateStr, start_time: timeStr, start_datetime: startDatetime,
    booking_start_datetime: bookingStart, capacity, available_spot_count: capacity - booked.size,
    class_type: classType, classroom: { id: `mock-room-${classroomName}`, name: classroomName },
    classroom_name: classroomName, instructors: [INSTRUCTORS[Number(id) % INSTRUCTORS.length]],
    location: LOCATION, layout_format: layoutFormat, is_free_class: false, is_cancelled: false,
    is_user_reserved: false, is_user_waitlisted: false, is_user_guest_reserved: false,
    class_tags: [], waitlist_count: null,
    spot_options: { primary_availability: capacity - booked.size, primary_capacity: capacity, waitlist_availability: 10, waitlist_capacity: 10 },
    reservations: [],
  };
}

let classCache = null;
function getClasses() {
  if (!classCache) classCache = generateClasses();
  // Recompute availability counts live (bookedSpotsByClass mutates over the session).
  return classCache.map((c) => {
    const booked = bookedSpotsFor(c.id);
    return { ...c, available_spot_count: c.capacity - booked.size, spot_options: { ...c.spot_options, primary_availability: c.capacity - booked.size } };
  });
}

function findClass(id) {
  return getClasses().find((c) => c.id === String(id));
}

function makeReservation({ classId, spotId, reservationType, guestEmail }) {
  const cls = findClass(classId);
  const id = String(nextReservationId++);
  const spot = spotId
    ? (makeLayout(bookedSpotsFor(classId)).spots.find((s) => s.id === spotId) || { id: spotId, name: spotId, spot_type: { id: '', name: '' }, x_position: null, y_position: null })
    : { id: '', name: '', spot_type: { id: '', name: '' }, x_position: null, y_position: null };
  const reservation = {
    id, is_booked_by_me: true, is_booked_for_me: !guestEmail, reservation_type: reservationType,
    spot, status: 'pending', waitlist_position: null, booked_by: 'Dev User', guest_email: guestEmail || null,
    is_change_spots_enabled: true, is_upcoming: true, class_session: cls || { id: classId },
    payment_option: PAYMENT_OPTION,
  };
  reservations.set(id, reservation);
  return reservation;
}

function handleMockRequest(pathName, method, body) {
  console.log(`[Mock MarianaTek] Intercepted ${method} ${pathName}`);
  const [path, queryString] = pathName.split('?');
  const query = new URLSearchParams(queryString || '');

  // GET /classes/{id}/payment_options
  let m = path.match(/^\/classes\/([^/]+)\/payment_options$/);
  if (m && method === 'GET') {
    return createFakeResponse({ user_payment_options: [PAYMENT_OPTION], guest_payment_options: [PAYMENT_OPTION] });
  }

  // GET /classes/{id}
  m = path.match(/^\/classes\/([^/]+)$/);
  if (m && method === 'GET') {
    const cls = findClass(m[1]);
    if (!cls) return createFakeResponse({ detail: 'No ClassSession matches the given query.' }, 404);
    const layout = cls.layout_format === 'pick-a-spot' ? makeLayout(bookedSpotsFor(cls.id)) : null;
    return createFakeResponse({ ...cls, layout });
  }

  // GET /classes (list)
  if (path === '/classes' && method === 'GET') {
    let results = getClasses();
    const minDate = query.get('min_start_date');
    const maxDate = query.get('max_start_date');
    if (minDate) results = results.filter((c) => c.start_date >= minDate);
    if (maxDate) results = results.filter((c) => c.start_date <= maxDate);
    return createFakeResponse({ count: results.length, next: null, previous: null, results, meta: {} });
  }

  // GET /locations
  if (path === '/locations' && method === 'GET') {
    return createFakeResponse({ count: 1, results: [LOCATION], meta: {}, links: {} });
  }

  // GET /me/account
  if (path === '/me/account' && method === 'GET') {
    return createFakeResponse({
      id: 'mock-user', first_name: 'Dev', last_name: 'User', full_name: 'Dev User',
      email: 'dev@jabboxing.mock', home_location: LOCATION, credit_cards: [], is_waiver_signed: true,
      has_unsigned_waivers: false, join_datetime: new Date(Date.now() - 30 * 864e5).toISOString(),
    });
  }

  // GET /me/credits
  if (path === '/me/credits' && method === 'GET') {
    // U1-20: the LIVE shape — an expired, fully used pack (credits_remaining 0, no
    // `count`, no type id). An empty list hid that a first-linked JAB credit list
    // was being read as a Psycle balance. Captured from live 2026-09-29, ids only.
    const results = [{
      id: '33777', credits_remaining: 0, credits_total: 3, credits_used: 3, product_id: '14716',
      expiration_datetime: '2024-12-06T19:10:12.661055Z', is_expired: true, is_valid_for_guests: true,
    }];
    return createFakeResponse({ count: results.length, results, meta: {}, links: {} });
  }

  // GET /me/memberships
  if (path === '/me/memberships' && method === 'GET') {
    return createFakeResponse({ count: 1, results: [PAYMENT_OPTION.membership_payment], meta: {}, links: {} });
  }

  // GET /me/reservations?is_upcoming=...
  if (path === '/me/reservations' && method === 'GET') {
    const isUpcoming = query.get('is_upcoming');
    let results = Array.from(reservations.values()).filter((r) => r.status !== 'standard cancel' && r.status !== 'removed');
    if (isUpcoming === 'false') results = []; // mock has no history yet
    return createFakeResponse({ count: results.length, results, meta: {}, links: {} });
  }

  // POST /me/reservations (book or waitlist-join)
  if (path === '/me/reservations' && method === 'POST') {
    const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
    const classId = payload.class_session && String(payload.class_session.id);
    const cls = findClass(classId);
    if (!cls) return createFakeResponse({ non_field_errors: ['Class not found.'] }, 400);
    if (payload.is_booked_for_me === false && !payload.guest_email) {
      return createFakeResponse({ non_field_errors: ['Email address for guest must be provided'] }, 400);
    }
    const reservationType = payload.reservation_type || 'standard';
    const spotId = payload.spot && payload.spot.id;
    if (reservationType === 'standard' && spotId) bookedSpotsFor(classId).add(spotId);
    const reservation = makeReservation({ classId, spotId, reservationType, guestEmail: payload.guest_email });
    return createFakeResponse(reservation, 201);
  }

  // GET /me/reservations/{id}/cancel_penalty
  m = path.match(/^\/me\/reservations\/([^/]+)\/cancel_penalty$/);
  if (m && method === 'GET') {
    if (!reservations.has(m[1])) return createFakeResponse({ detail: 'No Reservation matches the given query.' }, 404);
    return createFakeResponse({ is_penalty_cancel: false, message: null });
  }

  // POST /me/reservations/{id}/cancel
  m = path.match(/^\/me\/reservations\/([^/]+)\/cancel$/);
  if (m && method === 'POST') {
    const reservation = reservations.get(m[1]);
    if (!reservation) return createFakeResponse({ detail: 'No Reservation matches the given query.' }, 404);
    // Matches the real §1H finding: zero-penalty cancel frees the spot back up.
    if (reservation.spot && reservation.spot.id) bookedSpotsFor(reservation.class_session.id).delete(reservation.spot.id);
    reservation.status = reservation.reservation_type === 'waitlist' ? 'removed' : 'standard cancel';
    reservation.is_upcoming = false;
    return createFakeResponse(reservation);
  }

  // POST /me/reservations/{id}/swap_spots
  m = path.match(/^\/me\/reservations\/([^/]+)\/swap_spots$/);
  if (m && method === 'POST') {
    const reservation = reservations.get(m[1]);
    if (!reservation) return createFakeResponse({ detail: 'No Reservation matches the given query.' }, 404);
    const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
    const targetSpotId = payload.spot;
    const classId = reservation.class_session.id;
    const layout = makeLayout(bookedSpotsFor(classId));
    const targetSpot = layout.spots.find((s) => s.id === targetSpotId);
    if (!targetSpot || !targetSpot.is_available) {
      return createFakeResponse({ non_field_errors: ['That spot is not available.'] }, 400);
    }
    if (reservation.spot && reservation.spot.id) bookedSpotsFor(classId).delete(reservation.spot.id);
    bookedSpotsFor(classId).add(targetSpotId);
    reservation.spot = targetSpot;
    return createFakeResponse(reservation);
  }

  // Fallback — matches mock.js's convention of a safe default rather than a 500.
  return createFakeResponse([]);
}

module.exports = { handleMockRequest };
