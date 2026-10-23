import { describe, expect, it, beforeAll, vi } from 'vitest';
import { DateTime } from 'luxon';
import { setLinkedGyms } from '../gym-context.js';
import { indexFavourites } from '../favourites.js';
import { COPY } from '../copy.js';
import { HOME_FAVOURITE_EVENTS } from './__fixtures__/home-favourite-events.js';

let countPendingAutoBooks;
let getHomeCreditRows;
let getHomeBookLinks;
let groupHomeGymLinks;
let getHomeTopInstructorRows;
let getHomeFavouriteRows;
let getHomeFavouriteStatus;
let renderHomeFavouriteCard;
let getHomeStats;
let primaryActionForEvent;
let actionGlyph;
let formatInZone;
let syncHomeDesktopFlow;
let homeRegistry;
let mountWidget;
let cache;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
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
  ({ formatInZone } = await import('../lib.js'));
  ({ countPendingAutoBooks, getHomeCreditRows, getHomeBookLinks, groupHomeGymLinks, getHomeTopInstructorRows, getHomeFavouriteRows, getHomeStats, getHomeFavouriteStatus, renderHomeFavouriteCard, syncHomeDesktopFlow } = await import('./home.js'));
  ({ primaryActionForEvent, actionGlyph } = await import('./timetable.js'));
  ({ registry: homeRegistry, mountWidget } = await import('./widget-registry.js'));
});

describe('Home booked classes header and strip', () => {
  it('shows all upcoming grouped classes in the heading, keeps the action beside it, and places navigable day links after the Home header', async () => {
    const host = document.createElement('main');
    host.innerHTML = '<section id="app-panel-home"><header class="app-tab-header home-page-header"></header><div id="app-home-widgets"></div></section>';
    document.body.appendChild(host);
    const ctx = { gyms: [], navigate: vi.fn() };
    const original = homeRegistry.list(ctx).find((item) => item.id === 'upcoming');
    const widget = {
      ...original,
      load: async () => ({
        mode: 'strip', bookedCount: 5, cards: [], next: null,
        days: [{ key: '2026-10-21', label: 'Wed 21', isToday: true, href: '/bookings?day=2026-10-21', groups: [{ gymId: 'psycle-london' }] }],
      }),
    };
    const section = document.createElement('section');
    section.className = 'home-widget';
    section.dataset.widgetId = 'upcoming';
    host.querySelector('#app-home-widgets').appendChild(section);
    const mountOptions = { contextKey: 'home-test' };
    try {
      await mountWidget(section, widget, ctx, mountOptions);
      const heading = section.querySelector('.home-widget-heading');
      expect(heading.querySelector('h3.home-widget-title').textContent).toBe('Booked Classes');
      expect(heading.querySelector('.home-view-all')?.textContent).toBe('View all 5 bookings');
      expect(section.querySelector('.home-view-all')).toBeTruthy();
      expect(section.querySelector('.home-upcoming-queue .home-widget-empty')?.textContent).toBe(COPY.home.autoBookUnavailable);
      expect(homeRegistry.list(ctx).some((item) => item.id === 'auto-book-count')).toBe(false);
      const action = section.querySelector('.home-view-all');
      section.querySelector('.home-view-all').click();
      expect(ctx.navigate).toHaveBeenCalledWith('my-bookings');

      const strip = host.querySelector('.home-up-strip');
      expect(strip.previousElementSibling).toBe(host.querySelector('.home-page-header'));
      const day = strip.querySelector('.home-up-day.has-classes');
      expect(day.tagName).toBe('A');
      expect(day.getAttribute('href')).toBe('/bookings?day=2026-10-21');
      expect(day.getAttribute('aria-label')).toBe('Wed 21: 1 class');
      expect(day.querySelector('.home-up-day-head').textContent).toBe(COPY.home.upcomingToday);
      expect(day.classList.contains('is-today')).toBe(true);

      const originalSwitchTab = window.switchTab;
      window.switchTab = vi.fn();
      try {
        day.click();
        expect(location.pathname + location.search).toBe('/bookings?day=2026-10-21');
        expect(window.switchTab).toHaveBeenCalledWith('my-bookings', { history: 'none' });
      } finally {
        window.switchTab = originalSwitchTab;
      }

      await mountWidget(section, widget, ctx, mountOptions);
      expect(section.querySelector('.home-view-all')).toBe(action);
      expect(host.querySelectorAll('.home-up-strip')).toHaveLength(1);
      const duplicate = document.createElement('div');
      duplicate.className = 'home-up-strip';
      host.querySelector('#app-panel-home').appendChild(duplicate);
      section._wDataSignature = null; // force a real re-render for duplicate-strip cleanup
      await mountWidget(section, widget, ctx, mountOptions);
      expect(host.querySelectorAll('.home-up-strip')).toHaveLength(1);
      expect(host.querySelector('.home-up-strip').previousElementSibling).toBe(host.querySelector('.home-page-header'));

      await mountWidget(section, { ...widget, load: async () => ({ mode: 'card', bookedCount: 0, cards: [], next: null }) }, ctx, mountOptions);
      expect(host.querySelector('.home-up-strip')).toBeNull();
    } finally {
      host.remove();
    }
  });
});

describe('Home desktop flow', () => {
  it('groups desktop columns without changing the mobile reading order', () => {
    const root = document.createElement('div');
    ['upcoming', 'book', 'favourites', 'credits', 'stats', 'top-instructors'].forEach((id) => {
      const widget = document.createElement('section');
      widget.className = 'home-widget';
      widget.dataset.widgetId = id;
      root.appendChild(widget);
    });
    const media = { matches: true, addEventListener() {}, addListener() {} };
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => media;
    try {
      syncHomeDesktopFlow(root);
      expect([...root.children].map((node) => node.className)).toEqual([
        'home-desktop-column home-desktop-column--left',
        'home-desktop-column home-desktop-column--right',
      ]);
      expect([...root.children[0].children].map((node) => node.dataset.widgetId)).toEqual(['upcoming', 'book', 'stats']);
      expect([...root.children[1].children].map((node) => node.dataset.widgetId)).toEqual(['credits', 'favourites', 'top-instructors']);
      media.matches = false;
      syncHomeDesktopFlow(root);
      expect([...root.children].map((node) => node.dataset.widgetId)).toEqual(['upcoming', 'book', 'favourites', 'credits', 'stats', 'top-instructors']);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe('Home cache context', () => {
  it('does not let an old account refresh repopulate shared credit maps after a switch', async () => {
    const { api } = await import('../api.js');
    const gym = { gym_id: 'gym-a', capabilities: { metered: true } };
    const ctx = { gyms: [gym], contextKey: 'user-a:gym-a' };
    const widget = homeRegistry.list(ctx).find((item) => item.id === 'credits');
    setLinkedGyms([gym]);
    localStorage.setItem('appUserId', 'user-a');
    const oldCredits = api.getCreditsByGym;
    const oldEligibility = api.getEligibilityByGym;
    const oldMembership = api.getMembershipsByGym;
    const previousCredits = cache.creditsByGym;
    const previousEligibility = cache.eligibilityByGym;
    let resolveCredits;
    api.getCreditsByGym = () => new Promise((resolve) => { resolveCredits = resolve; });
    api.getEligibilityByGym = async () => ({ 'gym-a': { canBook: true } });
    api.getMembershipsByGym = async () => ({});
    try {
      const pending = widget.load(ctx);
      await tick();
      localStorage.setItem('appUserId', 'user-b');
      const switchedCredits = { 'gym-b': [{ count: 9 }] };
      const switchedEligibility = { 'gym-b': { canBook: true } };
      cache.creditsByGym = switchedCredits;
      cache.eligibilityByGym = switchedEligibility;
      resolveCredits({ 'gym-a': [{ count: 1 }] });
      await pending;
      expect(cache.creditsByGym).toBe(switchedCredits);
      expect(cache.eligibilityByGym).toBe(switchedEligibility);
    } finally {
      api.getCreditsByGym = oldCredits;
      api.getEligibilityByGym = oldEligibility;
      api.getMembershipsByGym = oldMembership;
      cache.creditsByGym = previousCredits;
      cache.eligibilityByGym = previousEligibility;
      localStorage.removeItem('appUserId');
    }
  });
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
      { gymId: null, name: 'See full timetable', href: '/timetable?f=all' },
    ]);
  });

  it('fills up to four gym actions in one row, then centers rows of three', () => {
    for (const [count, expected] of [[1, [1]], [4, [4]], [5, [3, 2]], [7, [3, 3, 1]]]) {
      expect(groupHomeGymLinks(Array.from({ length: count }, (_, i) => ({ gymId: `gym-${i}` }))).map((row) => row.length)).toEqual(expected);
    }
  });
});

describe('W5 Home credits', () => {
  const gyms = [
    { gym_id: 'metered', shortName: 'Metered', capabilities: { metered: true } },
    { gym_id: 'member', shortName: 'Member', capabilities: { metered: false } },
    { gym_id: 'empty', shortName: 'Empty', capabilities: { metered: true } },
  ];

  it('shows a tile for every linked gym with confirmed balances and membership state', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [{ count: 3 }, { count: 4, isGuestOnly: true }], empty: [] };
    cache.eligibilityByGym = { member: { canBook: true }, empty: { canBook: false } };
    expect(getHomeCreditRows(gyms, {
      creditsByGym: cache.creditsByGym,
      eligibilityByGym: cache.eligibilityByGym,
      membershipByGym: { member: { isActive: true, guestPassesRemaining: 2 } },
    })).toMatchObject([
      { gymId: 'metered', kind: 'credits', count: 3, memberCredits: 3, guestCredits: 4 },
      { gymId: 'member', kind: 'membership', membershipStatus: 'active' },
      { gymId: 'empty', kind: 'credits', count: 0, memberCredits: 0 },
    ]);
  });

  it('keeps linked gyms visible when their balances or eligibility are not loaded', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [] };
    cache.eligibilityByGym = {};
    expect(getHomeCreditRows(gyms, { creditsByGym: cache.creditsByGym, eligibilityByGym: {} })).toMatchObject([
      { gymId: 'metered', memberCredits: 0, balanceKnown: true },
      { gymId: 'member', membershipStatus: 'unknown' },
      { gymId: 'empty', memberCredits: null, balanceKnown: false },
    ]);
    expect(getHomeCreditRows(gyms, { creditsByGym: {}, eligibilityByGym: { member: null } }))
      .toMatchObject(gyms.map((gym) => ({ gymId: gym.gym_id })));
    expect(getHomeCreditRows(gyms, { creditsByGym: {}, eligibilityByGym: { member: null } })[0].memberCredits).toBeNull();
  });

  it('shows a confirmed zero beside a positive separate balance, while unknown guest values stay omitted', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = {
      metered: [{ count: 0 }, { count: 5, isGuestOnly: true }],
      empty: [{ count: 2 }],
    };
    cache.eligibilityByGym = { member: { canBook: true } };
    const rows = getHomeCreditRows(gyms, {
      creditsByGym: cache.creditsByGym,
      eligibilityByGym: cache.eligibilityByGym,
      membershipByGym: { member: { isActive: true } },
    });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.gymId === 'metered')).toMatchObject({ memberCredits: 0, guestCredits: 5 });
    expect(rows.find((row) => row.gymId === 'empty')).toMatchObject({ memberCredits: 2, guestCredits: null });
    expect(rows.find((row) => row.gymId === 'member')).toMatchObject({ guestPasses: null });
  });

  it('shows zero credits and no membership as confirmed states', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [], empty: [{ count: 0 }] };
    cache.eligibilityByGym = { member: { canBook: false } };
    const rows = getHomeCreditRows(gyms, {
      creditsByGym: cache.creditsByGym,
      eligibilityByGym: cache.eligibilityByGym,
      membershipByGym: { member: { guestPassesRemaining: 5 } },
    });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.gymId === 'metered')).toMatchObject({ memberCredits: 0, balanceKnown: true });
    expect(rows.find((row) => row.gymId === 'member')).toMatchObject({ membershipStatus: 'inactive', guestPasses: null });
  });

  it('renders numeric, unknown, and membership balances with readable labels', () => {
    const widget = homeRegistry.list().find((item) => item.id === 'credits');
    const root = document.createElement('div');
    widget.render(root, [
      { gymId: 'metered', name: 'Metered', kind: 'credits', memberCredits: 3, guestCredits: null, balanceKnown: true },
      { gymId: 'empty', name: 'Empty', kind: 'credits', memberCredits: null, guestCredits: null, balanceKnown: false },
      { gymId: 'member', name: 'Member', kind: 'membership', membershipStatus: 'active', guestPasses: null },
    ], { navigate() {}, openGymSettings: vi.fn() });
    const tiles = [...root.querySelectorAll('.home-credits-tile')];
    expect(tiles).toHaveLength(3);
    expect(tiles[0].querySelector('.home-credits-balance').textContent).toBe('3');
    expect(tiles[0].querySelector('.home-credits-kind').textContent).toBe('Class credits');
    expect(tiles[0].querySelector('.home-credits-value').textContent).toBe('3Class credits');
    expect(tiles[1].querySelector('.home-credits-balance').textContent).toBe('Unavailable');
    expect(tiles[2].querySelector('.home-credits-balance').textContent).toBe('Membership');
    expect(tiles[0].querySelector('.home-credits-name')).toBeNull();
    expect(tiles[0].getAttribute('aria-label')).toContain('Metered');
  });

  it('opens the matching gym settings from every allowance tile', () => {
    const widget = homeRegistry.list().find((item) => item.id === 'credits');
    const root = document.createElement('div');
    const openGymSettings = vi.fn();
    widget.render(root, [
      { gymId: 'metered', name: 'Metered', kind: 'credits', memberCredits: 3, guestCredits: null, balanceKnown: true },
      { gymId: 'member', name: 'Member', kind: 'membership', membershipStatus: 'active', guestPasses: 2 },
    ], { navigate() {}, openGymSettings });
    [...root.querySelectorAll('.home-credits-tile')].forEach((tile) => tile.click());
    expect(openGymSettings).toHaveBeenNthCalledWith(1, 'metered');
    expect(openGymSettings).toHaveBeenNthCalledWith(2, 'member');
  });

  it('keeps one credit row per linked gym with 1, 3, or 4 gyms', () => {
    for (const count of [1, 3, 4]) {
      const linked = Array.from({ length: count }, (_, index) => ({
        gym_id: `metered-${index}`,
        capabilities: { metered: true },
      }));
      setLinkedGyms(linked);
      const creditsByGym = Object.fromEntries(linked.map((gym) => [gym.gym_id, []]));
      expect(getHomeCreditRows(linked, { creditsByGym }).map((row) => row.gymId))
        .toEqual(linked.map((gym) => gym.gym_id));
    }
  });

  it('keeps a confirmed zero membership guest allowance distinct from unknown', () => {
    const membership = [{ gym_id: 'member', shortName: 'Member', capabilities: { metered: false } }];
    setLinkedGyms(membership);
    cache.eligibilityByGym = { member: { canBook: true } };
    expect(getHomeCreditRows(membership, {
      eligibilityByGym: cache.eligibilityByGym,
      membershipByGym: { member: { isActive: true, guestPassesRemaining: 0 } },
    })[0].guestPasses).toBe(0);
    expect(getHomeCreditRows(membership, {
      eligibilityByGym: cache.eligibilityByGym,
      membershipByGym: { member: { isActive: true } },
    })[0].guestPasses).toBeNull();
    expect(getHomeCreditRows(membership, {
      eligibilityByGym: cache.eligibilityByGym,
      membershipByGym: { member: { isActive: true, guestPassesRemaining: null } },
    })[0].guestPasses).toBeNull();
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

describe('Home activity tiles', () => {
  it('uses named Settings controls without visible gym-name text or a subtitle', () => {
    const widget = homeRegistry.list().find((item) => item.id === 'stats');
    const root = document.createElement('div');
    const openGymSettings = vi.fn();
    widget.render(root, {
      rows: [{ gymId: 'metered', gymName: 'Metered', attendanceTotal: 12 }],
      partial: false,
    }, { openGymSettings });
    const tile = root.querySelector('.home-attendance-tile');
    expect(tile.tagName).toBe('BUTTON');
    expect(tile.textContent).toBe('12classes');
    expect(tile.getAttribute('aria-label')).toBe(`Open Metered settings: 12 ${COPY.home.statsProviderAttended}`);
    expect(root.querySelector('.home-section-subtitle, .home-section-divider')).toBeNull();
    tile.click();
    expect(openGymSettings).toHaveBeenCalledWith('metered');
  });
});

describe('W6 Home favourites', () => {
  const gyms = [{ gym_id: 'gym-a' }, { gym_id: 'gym-b' }];
  const event = (overrides = {}) => ({
    id: 'class-a', gymId: 'gym-a', studioId: '7', startAt: '2026-10-08T17:30:00+01:00', timeZone: 'Europe/London', discipline: 'Ride',
    ...overrides,
  });

  it('renders published instructor photos and truthful availability in the card fixture', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const card = renderHomeFavouriteCard(HOME_FAVOURITE_EVENTS[0], () => ({ label: 'Quick Book', variant: 'success' }), actionGlyph);
    expect(card.querySelector('.home-favourite-avatar')?.getAttribute('src')).toContain('2_r9cgZUz.png');
    expect(card.querySelector('.home-favourite-instructor').textContent).toBe('Nickol');
    expect(card.querySelector('.home-favourite-status').textContent).toBe('5 spots left');
    expect(card.querySelector('.home-favourite-cta').lastChild.textContent).toBe('Quick Book');
    expect(card.querySelector('.home-favourite-meta').firstElementChild.className).toBe('home-favourite-gym');
    expect(card.querySelector('.home-favourite-class').textContent).toBe('Core & Glutes');
    expect(getHomeFavouriteStatus({ ...HOME_FAVOURITE_EVENTS[0], releaseAt: '2026-10-20T06:30:00+01:00' }, DateTime.fromJSDate(now, { zone: 'Europe/London' })).kind).toBe('release');
  });

  it('escapes provider text and invokes the supplied action handler', () => {
    const run = vi.fn();
    const card = renderHomeFavouriteCard({
      ...HOME_FAVOURITE_EVENTS[0],
      name: '<script>bad</script>',
      instructors: [{ name: '<img src=x onerror=bad>' }],
    }, () => ({ label: COPY.timetable.autoBook, variant: 'autoupgrade', run }), actionGlyph);
    expect(card.querySelector('.home-favourite-instructor').textContent).toBe('<img src=x onerror=bad>');
    expect(card.querySelector('.home-favourite-instructor').innerHTML).not.toContain('<img');
    const expectedGlyph = document.createElement('span');
    expectedGlyph.innerHTML = actionGlyph(COPY.timetable.autoBook);
    expect(card.querySelector('.home-favourite-cta .app-seg-ico svg').outerHTML).toBe(expectedGlyph.querySelector('svg').outerHTML);
    card.querySelector('.home-favourite-cta').click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown release and availability neutral instead of claiming open access', () => {
    expect(getHomeFavouriteStatus({ gymId: 'jab-boxing', startAt: '2026-10-15T18:30:00+01:00' })).toEqual({ kind: 'unknown', label: 'Availability not published' });
  });

  it.each([
    ['Europe/London', 'America/New_York', '2026-10-20T06:30:00+01:00', 'BST'],
    ['America/New_York', 'Europe/London', '2026-10-20T06:30:00-04:00', 'ET'],
  ])('formats a %s release like the timetable for a viewer in %s', (classZone, viewingZone, releaseAt, suffix) => {
    const release = DateTime.fromISO(releaseAt).setZone('Europe/London');
    const now = DateTime.fromISO('2026-10-01T12:00:00Z');
    const status = getHomeFavouriteStatus({
      gymId: 'gym-a', timeZone: classZone, startAt: '2026-10-22T10:00:00Z', releaseAt,
    }, now, viewingZone);
    expect(status.kind).toBe('release');
    expect(status.label).toMatch(/^Opens in \d+ (day|days|hour|hours|mins?)$/);
    expect(status.label).not.toContain(suffix);
  });

  it('keeps date, class and release as the three body facts, with the CTA inside the body', () => {
    const card = renderHomeFavouriteCard({
      ...HOME_FAVOURITE_EVENTS[0], releaseAt: '2099-10-20T06:30:00Z',
    }, () => ({ label: 'Quick Book', variant: 'success' }), actionGlyph);
    const body = card.querySelector('.home-favourite-body');
    expect([...body.children].map((node) => node.classList[0])).toEqual([
      'home-favourite-meta', 'home-favourite-class', 'home-favourite-status', 'home-favourite-cta',
    ]);
    expect(card.querySelector('.home-favourite-footer')).toBeNull();
    expect(body.querySelector('.home-favourite-cta')).toBeTruthy();
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

  it('uses the timetable booking decision for release, open, and eligibility states', () => {
    setLinkedGyms([{ gym_id: 'psycle-london', capabilities: { metered: true, bookingWindow: 'per-class' } }]);
    cache.bookings = [];
    cache.waitlists = [];
    cache.autoBookings = [];
    cache.creditsByGym = { 'psycle-london': [{ count: 3 }] };
    cache.eligibilityByGym = { 'psycle-london': { canBook: true } };
    const base = { id: 'parity-event', gymId: 'psycle-london', startAt: '2099-10-22T10:00:00Z' };

    expect(primaryActionForEvent({ ...base, releaseAt: '2099-10-20T06:30:00Z' }).label).toBe(COPY.timetable.autoBook);
    expect(primaryActionForEvent({ ...base, releaseAt: '2000-10-20T06:30:00Z' }).label).toBe(COPY.timetable.book);
    // An absent release is unknown and follows the timetable's permissive-open rule.
    expect(primaryActionForEvent(base).label).toBe(COPY.timetable.book);

    cache.eligibilityByGym = { 'psycle-london': { canBook: false, reason: 'No credits' } };
    expect(primaryActionForEvent(base)).toMatchObject({ label: COPY.timetable.buyCredits, variant: 'danger' });
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

  it('groups the gym mark with the portrait and keeps the image fallback', () => {
    const widget = homeRegistry.list().find((item) => item.id === 'top-instructors');
    const root = document.createElement('div');
    widget.render(root, [
      { gymId: 'gym-a', gymName: 'A', instructorName: 'Alex', count: 3, photoUrl: '/alex.webp', href: '/timetable' },
      { gymId: 'gym-b', gymName: 'B', instructorName: 'Sam', count: 1, photoUrl: null, href: '/timetable' },
    ], { navigate() {} });
    const cards = [...root.querySelectorAll('.home-instructor-card')];
    expect(cards[0].querySelector('.home-instructor-identities').children).toHaveLength(2);
    expect(cards[0].querySelector('.home-instructor-photo img').getAttribute('src')).toBe('/alex.webp');
    expect(cards[1].querySelector('.home-instructor-photo').textContent).toBe('S');
    expect(cards.every((card) => card.querySelector('.home-instructor-gym .app-gym-mark'))).toBe(true);
  });
});

describe('W8 Home stats', () => {
  const gyms = [
    { gym_id: 'psycle-london', shortName: 'Psycle' },
    { gym_id: 'jab-boxing', shortName: 'JAB' },
    { gym_id: 'aarmy', shortName: 'AARMY' },
  ];

  it('keeps one provider attendance tile per gym, including a known zero', () => {
    setLinkedGyms(gyms);
    const stats = getHomeStats(gyms, {
      'psycle-london': { attendance: { attendedTotal: 129 } },
      'jab-boxing': { attendance: { attendedTotal: 0 } },
      'aarmy': { attendance: { attendedTotal: 389 } },
    });
    expect(stats).toMatchObject({ partial: false });
    expect(stats.rows).toEqual([
      { gymId: 'psycle-london', gymName: 'Psycle', attendanceTotal: 129 },
      { gymId: 'jab-boxing', gymName: 'JAB', attendanceTotal: 0 },
      { gymId: 'aarmy', gymName: 'AARMY', attendanceTotal: 389 },
    ]);
  });

  it('omits unknown attendance and never substitutes booking history', () => {
    const stats = getHomeStats([{ gym_id: 'unknown', shortName: 'Unknown' }], {
      unknown: { attendance: { attendedTotal: null }, history: { summary: { classCount: 42 } } },
    });
    expect(stats.rows).toEqual([]);
    expect(stats.partial).toBe(true);
  });

  it('keeps confirmed tiles when another gym attendance request fails', () => {
    const stats = getHomeStats(gyms, {
      'psycle-london': { attendance: { attendedTotal: 12 } },
      'jab-boxing': {},
      'aarmy': { attendance: { attendedTotal: 3 } },
    });
    expect(stats.rows).toEqual([
      { gymId: 'psycle-london', gymName: 'Psycle', attendanceTotal: 12 },
      { gymId: 'aarmy', gymName: 'AARMY', attendanceTotal: 3 },
    ]);
    expect(stats.partial).toBe(true);
  });

  it('renders a prominent number with an inline classes unit', () => {
    const widget = homeRegistry.list().find((item) => item.id === 'stats');
    const root = document.createElement('div');
    widget.render(root, { rows: [{ gymId: 'psycle-london', gymName: 'Psycle', attendanceTotal: 8 }], partial: false }, { openGymSettings: vi.fn() });
    expect(root.querySelector('.home-attendance-number').textContent).toBe('8');
    expect(root.querySelector('.home-attendance-unit').textContent).toBe('classes');
    expect(root.querySelector('.home-attendance-gym')).toBeNull();
  });

});
