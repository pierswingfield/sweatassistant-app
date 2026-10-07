import { describe, expect, it, beforeAll, vi } from 'vitest';
import { setLinkedGyms } from '../gym-context.js';
import { indexFavourites } from '../favourites.js';
import { COPY } from '../copy.js';

let countPendingAutoBooks;
let getHomeCreditRows;
let getHomeBookLinks;
let getHomeTopInstructorRows;
let getHomeFavouriteRows;
let primaryActionForEvent;
let cache;
beforeAll(async () => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  if (typeof localStorage === 'undefined' || localStorage === null || !localStorage.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    });
  }
  ({ cache } = await import('../main.js'));
  ({ countPendingAutoBooks, getHomeCreditRows, getHomeBookLinks, getHomeTopInstructorRows, getHomeFavouriteRows } = await import('./home.js'));
  ({ primaryActionForEvent } = await import('./timetable.js'));
});

describe('W2 Home book row', () => {
  it('uses timetable overlay URLs for each linked gym and an explicit merged All link', () => {
    setLinkedGyms([
      { gym_id: 'jab-boxing', shortName: 'JAB' },
      { gym_id: 'psycle-london', shortName: 'Psycle' },
    ]);
    expect(getHomeBookLinks([
      { gym_id: 'jab-boxing' },
      { gym_id: 'psycle-london' },
      { gym_id: 'jab-boxing' },
    ])).toMatchObject([
      { gymId: 'jab-boxing', href: '/timetable?gym=jab-boxing' },
      { gymId: 'psycle-london', href: '/timetable?gym=psycle-london' },
      { gymId: null, href: '/timetable?f=all' },
    ]);
  });

  it('keeps the All link when a malformed linked-gym row has no id', () => {
    expect(getHomeBookLinks([{ shortName: 'Unknown' }])).toEqual([
      { gymId: null, name: 'All', href: '/timetable?f=all' },
    ]);
  });
});

describe('W5 Home credits', () => {
  const gyms = [
    { gym_id: 'metered', shortName: 'Metered', capabilities: { metered: true } },
    { gym_id: 'member', shortName: 'Member', capabilities: { metered: false } },
    { gym_id: 'empty', shortName: 'Empty', capabilities: { metered: true } },
  ];

  it('shows positive balances and confirmed memberships only', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [{ count: 3 }], empty: [] };
    cache.eligibilityByGym = { member: { canBook: true }, empty: { canBook: false } };
    expect(getHomeCreditRows(gyms, {
      creditsByGym: cache.creditsByGym,
      eligibilityByGym: cache.eligibilityByGym,
    })).toMatchObject([
      { gymId: 'metered', kind: 'credits', count: 3 },
      { gymId: 'member', kind: 'membership' },
    ]);
  });

  it('omits gyms whose balance or eligibility is not loaded', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [] };
    cache.eligibilityByGym = {};
    expect(getHomeCreditRows(gyms, { creditsByGym: cache.creditsByGym, eligibilityByGym: {} })).toEqual([]);
  });
});

describe('W4 auto-book count', () => {
  it('counts only pending rows across gyms', () => {
    expect(countPendingAutoBooks([{ id: 1 }, { id: 2, executed_at: 'x' }, { id: 3 }])).toBe(2);
  });
  it('never turns not-loaded into zero', () => {
    expect(countPendingAutoBooks(undefined)).toBeNull();
    expect(countPendingAutoBooks([])).toBe(0);
  });
});

describe('W6 Home favourites', () => {
  const gyms = [{ gym_id: 'gym-a' }, { gym_id: 'gym-b' }];
  const event = (overrides = {}) => ({
    id: 'class-a', gymId: 'gym-a', studioId: '7', startAt: '2026-10-08T17:30:00+01:00', timeZone: 'Europe/London', discipline: 'Ride',
    ...overrides,
  });
  const favouritesByGym = {
    'gym-a': indexFavourites([{ id: '70000400001730', studioId: '7', dayOfWeek: 4, startTime: '1730' }]),
    'gym-b': indexFavourites([]),
  };
  const now = new Date('2026-10-06T12:00:00Z');

  it('keeps only matched, gym-scoped classes in the next seven days', () => {
    const result = getHomeFavouriteRows(gyms, {
      favouritesByGym,
      now,
      events: [
        event(),
        event({ id: 'wrong-gym', gymId: 'gym-b' }),
        event({ id: 'too-late', startAt: '2026-10-14T17:30:00+01:00' }),
      ],
    });
    expect(result.state).toBe('list');
    expect(result.rows.map((row) => row.id)).toEqual(['class-a']);
  });

  it('does not turn an unloaded gym into an empty favourites result', () => {
    const result = getHomeFavouriteRows(gyms, {
      favouritesByGym: { 'gym-a': favouritesByGym['gym-a'] }, now, events: [],
    });
    expect(result.state).toBe('loading');
  });

  it('reports empty only after every linked gym and the schedule are known', () => {
    const result = getHomeFavouriteRows(gyms, { favouritesByGym, now, events: [] });
    expect(result).toMatchObject({ state: 'empty', rows: [] });
  });

  it('uses the compact timetable decision for a full class without a waitlist', () => {
    cache.bookings = [];
    cache.waitlists = [];
    cache.autoBookings = [];
    expect(primaryActionForEvent(event({ id: 'full', alwaysBookable: true, isFull: true, waitlistAvailable: false })))
      .toMatchObject({ label: COPY.timetable.full, disabled: true });
  });
});

describe('W7 Home top instructors', () => {
  it('keeps an instructor identity and photo scoped to its own gym', () => {
    setLinkedGyms([
      { gym_id: 'gym-a', shortName: 'A' },
      { gym_id: 'gym-b', shortName: 'B' },
    ]);
    const rows = getHomeTopInstructorRows([
      { gym_id: 'gym-a', shortName: 'A' },
      { gym_id: 'gym-b', shortName: 'B' },
    ], {
      'gym-a': { history: { topInstructors: [{ instructorId: '7', instructorName: 'Alex', count: 3 }] }, metadata: { instructors: [{ id: '7', thumbUrl: '/api/instructor-photo/gym-a/7?size=thumb&v=a' }] } },
      'gym-b': { history: { topInstructors: [{ instructorId: '7', instructorName: 'Sam', count: 1 }] }, metadata: { instructors: [{ id: '7', thumbUrl: '/api/instructor-photo/gym-b/7?size=thumb&v=b' }] } },
    });
    expect(rows).toMatchObject([
      { gymId: 'gym-a', instructorName: 'Alex', photoUrl: expect.stringContaining('/gym-a/7'), href: '/timetable?gym=gym-a&instructor=gym-a%3A7' },
      { gymId: 'gym-b', instructorName: 'Sam', photoUrl: expect.stringContaining('/gym-b/7'), href: '/timetable?gym=gym-b&instructor=gym-b%3A7' },
    ]);
  });

  it('omits a gym with no qualifying class instead of inventing an instructor', () => {
    expect(getHomeTopInstructorRows([{ gym_id: 'gym-a' }], {
      'gym-a': { history: { topInstructors: [] }, metadata: { instructors: [] } },
    })).toEqual([]);
  });
});
