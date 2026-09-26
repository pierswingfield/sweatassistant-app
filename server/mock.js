const fs = require('fs');
const path = require('path');

// To be fully safe and compatible with all node versions, let's write a simple custom Response-like object.
function createFakeResponse(data, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        return null;
      }
    },
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

const locations = [
  { id: 13, name: "Mortimer Street" },
  { id: 14, name: "Canary Wharf" },
  { id: 15, name: "Clapham" },
  { id: 16, name: "Shoreditch" }
];

// 5x8 grid of bike slots — shared by GET /events/{id} (per-class layout) and
// GET /studios (studio-level layout, WP-C5 fetchStudioLayout). Real CodexFit
// data has some studios with no layout at all (e.g. Reformer, per existing
// code comments) — modeled here by only giving 138/139 a layout, leaving
// 140/141 without one, so "no floor map available" stays exercisable too.
function makeLayoutSlots() {
  const layoutSlots = [];
  for (let r = 1; r <= 5; r++) {
    for (let c = 1; c <= 8; c++) {
      const slotId = r * 10 + c;
      layoutSlots.push({ id: slotId, name: `Bike ${slotId}`, x: c * 100, y: r * 100 });
    }
  }
  return layoutSlots;
}

// Non-bookable floor fixtures (the instructor podium), which real CodexFit
// publishes as `studio.layout.objects` alongside the slots. Only `x`/`y` are
// ever read by the renderer (WP-C5), so that's what's modeled — placed above
// the front row (y below row 1's y=100) and centred across the 8 columns.
function makeLayoutObjects() {
  return [{ id: 900, name: 'Podium', x: 450, y: 20 }];
}

// Studios 138/139 KEEP their layout and their ids: test-regression-psycle.js
// pins studio 138's floor plan, and event 1000 below must resolve to it.
// 140/141 deliberately have NO layout — real CodexFit has studios without one
// (Reformer rooms), and "no floor map available" needs to stay exercisable.
const studios = [
  { id: 138, name: "Ride Studio", location_id: 13, layout: { slots: makeLayoutSlots(), objects: makeLayoutObjects() } },
  { id: 139, name: "Barre Studio", location_id: 13, layout: { slots: makeLayoutSlots(), objects: makeLayoutObjects() } },
  { id: 140, name: "Ride Studio", location_id: 14 },
  { id: 141, name: "Strength Studio", location_id: 15 },
  { id: 142, name: "Reformer Studio", location_id: 13 },
  { id: 143, name: "Yoga Studio", location_id: 16, layout: { slots: makeLayoutSlots(), objects: makeLayoutObjects() } },
  { id: 144, name: "Strength Studio", location_id: 16 },
  { id: 145, name: "Ride Studio", location_id: 15, layout: { slots: makeLayoutSlots(), objects: makeLayoutObjects() } },
  { id: 146, name: "Barre Studio", location_id: 14 }
];

const instructors = [
  { id: 10, name: "ADAM", full_name: "Adam" },
  { id: 11, name: "BECKY", full_name: "Becky" },
  { id: 12, name: "CHRIS", full_name: "Chris" },
  { id: 13, name: "DAN", full_name: "Dan" },
  { id: 14, name: "ELLA", full_name: "Ella" },
  { id: 15, name: "FRANKIE", full_name: "Frankie" },
  { id: 16, name: "GEORGIA", full_name: "Georgia" },
  { id: 17, name: "HARRY", full_name: "Harry" },
  { id: 18, name: "IMANI", full_name: "Imani" },
  { id: 19, name: "JOSS", full_name: "Joss" }
];

// One per discipline group the client knows how to tag (see cards.js
// getDiscipline) — a single-discipline mock could never surface a wrong or
// missing discipline pill, which is a regression that has shipped twice.
const eventTypes = [
  { id: 20, name: "Ride 45", group: { id: 1, name: "Ride" } },
  { id: 21, name: "Barre 55", group: { id: 2, name: "Barre" } },
  { id: 22, name: "Strength 45", group: { id: 3, name: "Strength" } },
  { id: 23, name: "Ride 60", group: { id: 1, name: "Ride" } },
  { id: 24, name: "Reformer 50", group: { id: 4, name: "Reformer" } },
  { id: 25, name: "Yoga Flow 60", group: { id: 5, name: "Yoga" } },
  { id: 26, name: "Infrared Sculpt 45", group: { id: 6, name: "Infrared" } },
  { id: 27, name: "Recovery 30", group: { id: 7, name: "Recovery" } },
  { id: 28, name: "Rhythm Ride 45", group: { id: 1, name: "Ride" } },
  { id: 29, name: "Barre Express 30", group: { id: 2, name: "Barre" } }
];

// A weekly template, so the generated timetable looks like a real one: busier
// on weekday mornings and evenings, quieter midday, a different shape at the
// weekend. Each entry is [hh:mm, eventTypeId, studioId, capacity].
const WEEKDAY_SCHEDULE = [
  ['06:30', 20, 138, 40], ['07:30', 26, 139, 20], ['08:30', 20, 138, 40],
  ['09:30', 21, 139, 25], ['10:30', 24, 142, 12], ['12:15', 29, 139, 25],
  ['17:30', 28, 138, 40], ['18:30', 21, 139, 25], ['18:30', 22, 141, 18],
  ['19:30', 23, 145, 40], ['19:45', 25, 143, 30], ['20:30', 27, 143, 30]
];
const WEEKEND_SCHEDULE = [
  ['09:00', 23, 138, 40], ['09:30', 25, 143, 30], ['10:30', 21, 146, 25],
  ['11:00', 20, 145, 40], ['11:30', 24, 142, 12], ['12:30', 22, 144, 18],
  ['17:00', 27, 143, 30]
];

// Mirrors the live `relations.credit_types` bag (confirmed 2026-09-14): 46
// types on real Psycle, 11 of them guest-only. Three here is enough to exercise
// accepted-type filtering and the guest-only exclusion.
const creditTypes = [
  { id: 1, name: 'Universal', handle: 'universal', is_guest_use_only: false, extended_booking_period: null },
  { id: 2, name: 'Guest', handle: 'buddy', is_guest_use_only: true, extended_booking_period: null },
  { id: 3, name: 'Ride Only', handle: 'ride-only', is_guest_use_only: false, extended_booking_period: null },
  { id: 8, name: 'Extended Booking', handle: 'extended-booking', is_guest_use_only: false, extended_booking_period: '+1 week' },
];

const bundles = [
  {
    id: 792,
    name: "CRM 5-Pack Ride Credits",
    price: 9500, // £95.00
    total_credits: 5,
    is_unlimited: false,
    handle: "crm-5-pack",
    studios: [138, 140]
  },
  {
    id: 793,
    name: "Introductory 3-Pack All Studios",
    price: 3500, // £35.00
    total_credits: 3,
    is_unlimited: false,
    handle: "intro-3-pack"
  },
  {
    id: 794,
    name: "10-Pack Strength & Barre",
    price: 18000, // £180.00
    total_credits: 10,
    is_unlimited: false,
    handle: "10-pack-strength-barre",
    class_types: [21, 22]
  }
];

let mockBookmarks = [];

const mockNow = new Date();
const mockD1 = new Date(mockNow.getTime() + 2 * 864e5).toISOString();
const mockD2 = new Date(mockNow.getTime() + 5 * 864e5).toISOString();

const mockBookingsPath = path.join(__dirname, 'mock_bookings.dbjson');
let mockBookings = [];

function loadMockBookings() {
  if (fs.existsSync(mockBookingsPath)) {
    try {
      mockBookings = JSON.parse(fs.readFileSync(mockBookingsPath, 'utf8'));
      return;
    } catch (e) {
      console.warn('[Mock Server] Failed to parse mock_bookings.json:', e.message);
    }
  }
  // Initialize default mock bookings
  mockBookings = [
    {
      id: 8255401,
      event_id: 1000,
      booked_at: new Date().toISOString(),
      studio_slot: { id: 23, label: '23' },
      event: {
        id: 1000, name: 'Ride 45', start_at: mockD1,
        event_type: { id: 20, name: 'RIDE: Ride 45', group: { id: 1, name: 'Ride' } },
        instructor: { id: 10, name: 'ADAM', full_name: 'Adam' },
        studio: { id: 138, name: 'Ride Studio', location: { id: 13, name: 'Mortimer Street' } }
      }
    },
    {
      id: 8255402,
      event_id: 1003,
      booked_at: new Date(Date.now() - 120000).toISOString(),
      studio_slot: { id: 11, label: '11' },
      event: {
        id: 1003, name: 'Barre 55', start_at: mockD2,
        event_type: { id: 21, name: 'BARRE: Barre 55', group: { id: 2, name: 'Barre' } },
        instructor: { id: 11, name: 'BECKY', full_name: 'Becky' },
        studio: { id: 139, name: 'Barre Studio', location: { id: 13, name: 'Mortimer Street' } }
      }
    }
  ];
  saveMockBookings();
}

function saveMockBookings() {
  try {
    fs.writeFileSync(mockBookingsPath, JSON.stringify(mockBookings, null, 2), 'utf8');
  } catch (e) {
    console.error('[Mock Server] Failed to write mock_bookings.json:', e.message);
  }
}

// Load initially
loadMockBookings();

function handleMockRequest(pathName, method, body) {
  console.log(`[Mock Server] Intercepted ${method} ${pathName}`);

  // Bookmark mutations: PUT adds, DELETE removes a single bookmark identifier.
  if (pathName.startsWith('/profile/metafields/bookmarks.events.')) {
    const identifier = pathName.split('bookmarks.events.')[1];
    if (method === 'PUT') {
      if (!mockBookmarks.includes(identifier)) {
        mockBookmarks.push(identifier);
      }
    } else if (method === 'DELETE') {
      mockBookmarks = mockBookmarks.filter(b => b !== identifier);
    }
    return createFakeResponse({ success: true });
  }

  if (pathName.startsWith('/profile')) {
    return createFakeResponse({
      id: 99999,
      email: "dev@psycle.com",
      first_name: "Dev",
      last_name: "User",
      telephone: "+44 7700 900123",
      created_at: new Date(Date.now() - 420 * 24 * 60 * 60 * 1000).toISOString(),
      booking_cutoff: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      extended_cutoff: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      stats: {
        total_bookings: 142,
        total_unique_bookings: 138,
        total_unique_bookings_attended: 129,
        credits_remaining: 4,
        total_attended_minutes: 6450
      },
      available_credits: [
        { count: 3, credit_type: { id: 3, name: "Ride Only", is_guest_use_only: false }, expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() },
        { count: 1, credit_type: { id: 1, name: "Universal", is_guest_use_only: false } },
        { count: 10, credit_type: { id: 8, name: "Extended Booking", is_guest_use_only: false } },
        // Guest credits must NOT count toward booking yourself in.
        { count: 4, credit_type: { id: 2, name: "Guest", is_guest_use_only: true } }
      ],
      subscriptions: [
        { name: "Unlimited Monthly", status: "active", renews_at: new Date(Date.now() + 18 * 24 * 60 * 60 * 1000).toISOString() }
      ],
      subscription_statuses: ["active"],
      metafields: {
        public: {
          bookmarks: {
            events: [...mockBookmarks]
          }
        }
      }
    });
  }

  if (pathName.startsWith('/credits')) {
    return createFakeResponse([
      { count: 3, credit_type: { name: "Ride Credit" } },
      { count: 1, credit_type: { name: "Strength Credit" } }
    ]);
  }

  if (pathName.startsWith('/locations')) {
    return createFakeResponse(locations);
  }

  if (pathName.startsWith('/studios')) {
    return createFakeResponse(studios);
  }

  if (pathName.startsWith('/instructors')) {
    return createFakeResponse(instructors);
  }

  if (pathName.startsWith('/event-types')) {
    return createFakeResponse(eventTypes);
  }

  if (pathName.startsWith('/bundles')) {
    // C2-3b: real CodexFit /bundles answers the by-reference envelope
    // `{ data, relations }`, same as /events (see codexfit.js listBundles()'s
    // doc comment) — NOT a bare array. This mock used to return `bundles`
    // directly, so `data.data || []` in listBundles() always saw `undefined`
    // and dev mode's Buy Credits tab rendered zero cards with no error
    // anywhere (confirmed empty #psycle-bundles-container, 2026-09-26).
    // `relations.bundle_types` is empty here since none of the dev fixture
    // bundles carry a `bundle_type_id` — the client's category filter
    // (`bundleTypeHandle` in credits.js) falls back to its text-based rule
    // when a bundle_type can't be resolved, so this is enough to render.
    return createFakeResponse({ data: bundles, relations: { bundle_types: [] } });
  }

  // In-app checkout mocks (dev@psycle.com) — let the UI run end to end.
  if (pathName.startsWith('/cart/add_bundle/')) {
    return createFakeResponse({ instance: 'mock-instance-0001' });
  }
  if (pathName.startsWith('/cart/get_payment_methods')) {
    return createFakeResponse({
      success: true,
      methods: [
        { id: 'pm_mock_amex', brand: 'amex', last4: '3003', default: true, exp_month: 10, exp_year: 2029 },
        { id: 'pm_mock_visa', brand: 'visa', last4: '4242', default: false, exp_month: 3, exp_year: 2027 },
      ],
    });
  }
  if (pathName.startsWith('/cart/set_payment_method/')) {
    return createFakeResponse({ success: true, intent: { id: 'pi_mock', status: 'requires_payment_method' } });
  }
  if (pathName.startsWith('/cart/ajaxCheckoutProcess')) {
    return createFakeResponse({ success: true, order: { id: 9000001, status: 'Payment pending' } });
  }
  if (pathName.startsWith('/orders/')) {
    // Mock settles immediately as Paid. Real API wraps the order in { data: ... }.
    return createFakeResponse({ data: { id: 9000001, status: 'Paid' } });
  }

  if (pathName.startsWith('/bookings')) {
    // DELETE booking
    if (method === 'DELETE') {
      const parts = pathName.split('/');
      const bookingId = parseInt(parts[parts.length - 1]);
      console.log(`[Mock Server] Cancelling booking ID: ${bookingId}`);
      mockBookings = mockBookings.filter(b => b.id !== bookingId);
      saveMockBookings();
      return createFakeResponse({ success: true });
    }

    // POST (create) booking
    if (method === 'POST') {
      const slots = body?.slots || [];
      const eventId = Number(body?.event_id || 1000);
      const bookingsObj = {};
      
      // Calculate dynamic event details matching the mock timetable generation
      let eventDetails;
      if (eventId >= 1000 && eventId < 2000) {
        const offsetDays = Math.floor((eventId - 1000) / 2);
        const isEvening = (eventId - 1000) % 2 === 1;
        const date = new Date(mockNow.getTime() + offsetDays * 24 * 60 * 60 * 1000);
        const yyyymmdd = date.toISOString().split('T')[0];
        
        eventDetails = {
          id: eventId,
          name: isEvening ? "Barre 55" : "Ride 45",
          start_at: isEvening ? `${yyyymmdd}T18:30:00.000Z` : `${yyyymmdd}T08:30:00.000Z`,
          event_type: isEvening ? eventTypes[1] : eventTypes[0],
          instructor: instructors[(offsetDays % 4)],
          studio: isEvening ? studios[1] : studios[0]
        };
      } else {
        const isEven = eventId % 2 === 0;
        eventDetails = {
          id: eventId,
          name: isEven ? "Ride 45" : "Barre 55",
          start_at: new Date(new Date().setUTCHours(isEven ? 8 : 18, 30, 0, 0) + 3 * 864e5).toISOString(),
          event_type: isEven ? eventTypes[0] : eventTypes[1],
          instructor: instructors[0],
          studio: isEven ? studios[0] : studios[1],
          max_bookable_slots: 10
        };
      }

      slots.forEach(slot => {
        const mockId = 8255400 + Math.floor(Math.random() * 10000);
        bookingsObj[String(mockId)] = Number(slot);
        
        // Add to our mutable dev bookings array
        mockBookings.push({
          id: mockId,
          event_id: eventId,
          booked_at: new Date().toISOString(),
          studio_slot: { id: Number(slot), label: String(slot) },
          event: eventDetails
        });
      });
      
      saveMockBookings();
      return createFakeResponse({
        success: true,
        bookings: bookingsObj
      });
    }

    // GET bookings list
    return createFakeResponse(mockBookings);
  }

  if (pathName.startsWith('/events/')) {
    const parts = pathName.split('/');
    const eventId = parseInt(parts[parts.length - 1]);
    const isEven = eventId % 2 === 0;
    const studioId = isEven ? 138 : 139;
    const studioName = isEven ? "Ride Studio" : "Barre Studio";

    const layoutSlots = makeLayoutSlots();

    // For mock testing upgrades, make a wide range of slots available
    // so that whatever spot the user maps as preferred is likely available.
    const availableSlots = [];
    for (let r = 1; r <= 8; r++) {
      for (let c = 1; c <= 8; c++) {
        availableSlots.push(r * 10 + c);
      }
    }

    // Real shape confirmed via a live browser capture (2026-07-03, deleted after
    // extraction — see Documentation/Archive/2026-09-26/Backlog/modular-gyms/PROGRESS.md handoff):
    // `data.{start_at,duration,instructor_id,event_type_id,studio_id,occupancy,
    // capacity}` + a sibling `relations.{instructors,event_types,studios,locations}`
    // block (id-referenced, not inline) — genuinely richer than this mock
    // previously simulated (it used to return only `{id, slots, relations:
    // {studios}}`, which silently masked calendar.js's per-event enrichment step
    // in dev mode). Mirrors the same offsetDays/isEvening date derivation the
    // mock's own POST /bookings and GET /events handlers already use, so a
    // booked event's detail is internally consistent across all three.
    const offsetDays = eventId >= 1000 && eventId < 2000 ? Math.floor((eventId - 1000) / 2) : 0;
    const isEvening = eventId >= 1000 && eventId < 2000 ? (eventId - 1000) % 2 === 1 : !isEven;
    const date = new Date(mockNow.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const yyyymmdd = date.toISOString().split('T')[0];
    const instructor = isEvening ? instructors[(offsetDays + 1) % 4] : instructors[offsetDays % 4];
    const eventType = isEvening ? eventTypes[1] : eventTypes[0];
    const location = locations[0]; // studios 138/139 are both location_id 13 (Mortimer Street)

    return createFakeResponse({
      data: {
        id: eventId,
        instructor_id: instructor.id,
        studio_id: studioId,
        event_type_id: eventType.id,
        start_at: isEvening ? `${yyyymmdd}T18:30:00.000Z` : `${yyyymmdd}T08:30:00.000Z`,
        duration: isEvening ? 55 : 45,
        occupancy: isEvening ? 25 : 15,
        capacity: isEvening ? 25 : 40,
      },
      slots: availableSlots,
      bookings: [],
      max_bookable_slots: 10,
      relations: {
        instructors: [instructor],
        event_types: [eventType],
        studios: [
          {
            id: studioId,
            name: studioName,
            location_id: location.id,
            layout: {
              slots: layoutSlots,
              objects: makeLayoutObjects()
            }
          }
        ],
        locations: [location],
      }
    });
  }

  if (pathName.startsWith('/events')) {
    // A realistic 14-day timetable from the weekly template above.
    //
    // Deliberately varied: several locations and studios per day, ten
    // instructors, every discipline group, and a spread of occupancy from
    // nearly empty to full-with-waitlist. A two-class-per-day mock cannot
    // surface a filter bug, a discipline-pill bug, a waitlist-state bug or a
    // merged-timetable ordering bug — all of which have shipped before.
    //
    // ID SCHEME: day 0's first class is id 1000 in Ride Studio 138, because
    // test-regression-psycle.js pins exactly that event and that floor plan.
    // Ids stay stable per (day, slot) so a queued auto-book survives a reload.
    const classes = [];
    const now = new Date();

    for (let i = 0; i < 14; i++) {
      const date = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const yyyymmdd = date.toISOString().split('T')[0];
      const dow = date.getDay();
      const template = (dow === 0 || dow === 6) ? WEEKEND_SCHEDULE : WEEKDAY_SCHEDULE;

      template.forEach(([time, eventTypeId, studioId, capacity], slotIdx) => {
        const studio = studios.find((st) => st.id === studioId);
        const eventType = eventTypes.find((t) => t.id === eventTypeId);

        // Spread occupancy deterministically rather than randomly, so a reload
        // shows the same timetable — a list that reshuffles under you makes
        // every visual comparison worthless.
        const seed = (i * 13 + slotIdx * 7) % 10;
        let occupancy;
        if (seed === 0) occupancy = capacity;              // full → waitlist
        else if (seed === 1) occupancy = capacity - 1;     // one spot left
        else occupancy = Math.min(capacity - 1, Math.floor((capacity * (seed + 2)) / 14));

        const isFull = occupancy >= capacity;

        classes.push({
          id: 1000 + i * 20 + slotIdx,
          name: eventType.name,
          start_at: `${yyyymmdd}T${time}:00.000Z`,
          studio_id: studioId,
          location_id: studio.location_id,
          instructor_id: instructors[(i * 3 + slotIdx) % instructors.length].id,
          event_type_id: eventTypeId,
          capacity,
          occupancy,
          is_fully_booked: isFull,
          is_waitlistable: true,
          waitlist_available: isFull,
          is_waitlist_full: false,
          is_always_bookable: false,
          max_bookable_slots: 10,
          // The live API publishes BOTH of these on every event, and neither was
          // modelled here — which is exactly why the client's per-class credit
          // logic could be dead code for months without a test going red.
          // Ride classes additionally accept the Ride Only type; one slot per
          // day costs 2 credits so the "can't afford it" path is exercisable.
          required_credits: slotIdx === 3 ? 2 : 1,
          credit_types: [
            { credit_type: 1 }, { credit_type: 2 }, { credit_type: 8 },
            ...(eventType.group && eventType.group.name === 'Ride' ? [{ credit_type: 3 }] : []),
          ],
          accepted_credits: [
            { credit_type_id: 1 }, { credit_type_id: 2 }, { credit_type_id: 8 },
            ...(eventType.group && eventType.group.name === 'Ride' ? [{ credit_type_id: 3 }] : []),
          ]
          // NOTE: no inline `instructor`/`event_type`/`studio` — the real
          // GET /events returns these BY REFERENCE only (see the relations bag
          // below). The mock used to embed them, which made it more generous
          // than reality and hid the 2026-08-31 "CLASS" regression from tests.
        });
      });
    }

    // Mirror the real response envelope: `{ data, relations }`, with events
    // referencing relations by id. Confirmed against a live capture (see the
    // GET /events/{id} note above and PROGRESS.md Q11).
    return createFakeResponse({
      data: classes,
      relations: {
        instructors,
        event_types: eventTypes,
        studios,
        locations,
        credit_types: creditTypes,
      },
    });
  }

  // Fallback default response
  return createFakeResponse([]);
}

module.exports = {
  handleMockRequest
};
