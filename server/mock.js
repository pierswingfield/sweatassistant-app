// To be fully safe and compatible with all node versions, let's write a simple custom Response-like object.
function createFakeResponse(data, status = 200) {
  return {
    status,
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

const studios = [
  { id: 138, name: "Ride Studio", location_id: 13 },
  { id: 139, name: "Barre Studio", location_id: 13 },
  { id: 140, name: "Ride Studio", location_id: 14 },
  { id: 141, name: "Strength Studio", location_id: 15 }
];

const instructors = [
  { id: 10, name: "ADAM", full_name: "Adam" },
  { id: 11, name: "BECKY", full_name: "Becky" },
  { id: 12, name: "CHRIS", full_name: "Chris" },
  { id: 13, name: "DAN", full_name: "Dan" }
];

const eventTypes = [
  { id: 20, name: "Ride 45", group: { id: 1, name: "Ride" } },
  { id: 21, name: "Barre 55", group: { id: 2, name: "Barre" } },
  { id: 22, name: "Strength 45", group: { id: 3, name: "Strength" } }
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

function handleMockRequest(pathName, method, body) {
  console.log(`[Mock Server] Intercepted ${method} ${pathName}`);

  if (pathName.startsWith('/profile')) {
    return createFakeResponse({
      id: 99999,
      email: "dev@psycle.com",
      first_name: "Dev",
      last_name: "User",
      booking_cutoff: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      extended_cutoff: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      metafields: {
        public: {
          bookmarks: {
            events: ["1380000100001930"]
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
    return createFakeResponse(bundles);
  }

  if (pathName.startsWith('/events/')) {
    const parts = pathName.split('/');
    const eventId = parseInt(parts[parts.length - 1]);
    
    // Generate layout slots
    const layoutSlots = [];
    for (let r = 1; r <= 5; r++) {
      for (let c = 1; c <= 8; c++) {
        const slotId = r * 10 + c;
        layoutSlots.push({
          id: slotId,
          name: `Bike ${slotId}`,
          x: c * 100,
          y: r * 100
        });
      }
    }

    const availableSlots = [11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 42, 43, 51, 52, 53];

    return createFakeResponse({
      id: eventId,
      slots: availableSlots,
      relations: {
        studios: [
          {
            id: 138,
            name: "Ride Studio",
            layout: {
              slots: layoutSlots
            }
          }
        ]
      }
    });
  }

  if (pathName.startsWith('/events')) {
    // Generate classes dynamically in the future
    const classes = [];
    const now = new Date();
    
    for (let i = 0; i < 14; i++) {
      const date = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const yyyymmdd = date.toISOString().split('T')[0];
      
      // Class 1 (Morning)
      classes.push({
        id: 1000 + i * 2,
        name: "Ride 45",
        start_at: `${yyyymmdd}T08:30:00.000Z`,
        studio_id: 138,
        location_id: 13,
        instructor_id: 10 + (i % 4),
        event_type_id: 20,
        capacity: 40,
        occupancy: 15 + (i % 20),
        is_fully_booked: false,
        is_waitlistable: true,
        waitlist_available: true,
        is_waitlist_full: false,
        is_always_bookable: false,
        instructor: instructors[(i % 4)],
        event_type: eventTypes[0],
        studio: { 
          id: 138, 
          name: "Ride Studio", 
          location_id: 13, 
          location: { id: 13, name: "Mortimer Street" } 
        }
      });

      // Class 2 (Evening)
      classes.push({
        id: 1000 + i * 2 + 1,
        name: "Barre 55",
        start_at: `${yyyymmdd}T18:30:00.000Z`,
        studio_id: 139,
        location_id: 13,
        instructor_id: 10 + ((i + 1) % 4),
        event_type_id: 21,
        capacity: 25,
        occupancy: 25,
        is_fully_booked: true,
        is_waitlistable: true,
        waitlist_available: true,
        is_waitlist_full: false,
        is_always_bookable: false,
        instructor: instructors[((i + 1) % 4)],
        event_type: eventTypes[1],
        studio: { 
          id: 139, 
          name: "Barre Studio", 
          location_id: 13, 
          location: { id: 13, name: "Mortimer Street" } 
        }
      });
    }

    return createFakeResponse(classes);
  }

  // Fallback default response
  return createFakeResponse([]);
}

module.exports = {
  handleMockRequest
};
