import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../main.js', () => ({ showToast: vi.fn(), debugLog: vi.fn(), cache: {} }));
vi.mock('../gym-context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllLinkedGyms: () => [{ gym_id: 'gym-a', account_enabled: 1 }, { gym_id: 'gym-off', account_enabled: 0 }],
  getGymShortName: (g) => ({ 'gym-a': 'Gym A', 'gym-off': 'Gym <Off>' }[g] || g),
}));
const quickBook = vi.fn();
vi.mock('./timetable.js', () => ({
  getLoadedEvents: () => [{ id: '20', gymId: 'gym-a', startAt: '2026-11-05T07:30:00+00:00', timeZone: 'Europe/London', name: 'Ride 45', instructors: [{ name: 'Kemi' }], availableCount: 6 }],
  ensureScheduleLoaded: vi.fn(),
  isEventBookedByMe: () => false,
  primaryActionForEvent: () => ({ label: 'Book', variant: 'success', run: quickBook }),
  actionGlyph: () => '',
  metadata: { instructors: [] },
}));

const NOW = Date.parse('2026-11-04T07:53:00Z');
const EVIL = '<img src=x onerror=alert(1)>';
const att = (memberRef, kind = 'booked', spot) => ({ memberRef, kind, ...(spot ? { spot } : {}) });
const cls = (key, gymId, startAt, attendees, extra = {}) => ({
  key: `${gymId}:${key}`, gymId, eventId: key, startAt, timeZone: 'Europe/London', durationMin: 45,
  className: `${EVIL} class`, instructorName: `${EVIL} inst`, locationName: `${EVIL} loc`, attendees, ...extra,
});
const data = {
  team: { id: 'team1', name: 'Crew' },
  members: [
    { memberRef: 'me', name: 'Piers', colourIndex: 0, isCaptain: true, isMe: true, counts: { week: 1, month: 2 }, gyms: ['gym-a'], otherGym: false },
    { memberRef: 'a', name: `${EVIL}Ana`, colourIndex: 1, isCaptain: false, isMe: false, counts: { week: 3, month: 9 }, gyms: ['gym-a'], otherGym: true, stale: true, updatedAt: '2026-11-04T04:00:00Z' },
    { memberRef: 'b', name: 'Sam', colourIndex: 2, isCaptain: false, isMe: false, counts: null, gyms: [], otherGym: false },
  ],
  today: { total: 3, done: 0, inProgress: 1 },
  classes: [
    cls('10', 'gym-a', '2026-11-04T07:30:00+00:00', [att('a', 'booked', `${EVIL}Bike`), att('b')]),
    cls('11', 'gym-a', '2026-11-04T12:15:00+00:00', [att('me'), att('b', 'waitlist')]),
    cls('20', 'gym-a', '2026-11-05T07:30:00+00:00', [att('a'), att('b')]),
    cls('21', 'gym-a', '2026-11-05T08:30:00+00:00', [att('a'), att('me')]),
    cls('30', 'gym-off', '2026-11-06T09:00:00+00:00', [att('a'), att('b')]),
  ],
  recent: [cls('r1', 'gym-a', '2026-11-02T08:00:00+00:00', [att('a')])],
};

let dash;
beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  dash = await import('./teams-dashboard.js');
});
afterEach(() => { document.body.innerHTML = ''; });

const section = () => { const el = document.createElement('section'); document.body.appendChild(el); return el; };
const noInjection = (el) => {
  // Attribute values legitimately hold a raw "<" when serialised; what matters is that no element was injected.
  expect(el.querySelector('img[src="x"], img[onerror]')).toBeNull();
};

describe('Team dashboard widgets render escaped, from the projection only', () => {
  it('header lines name who is in class now', () => {
    const h = dash.heroLines(data, NOW);
    expect(h.state).toContain('in class now');
    expect(h.sub).toBe('0 of 3 workouts done today');
  });

  it("Today's workouts: rows in order, ring on the live class, hidden when empty", () => {
    const el = section();
    expect(dash.renderTodaysWorkouts(el, data, NOW)).toBe(true);
    expect(el.querySelectorAll('.tm-tw')).toHaveLength(2);
    expect(el.querySelector('.tm-tw.is-live .tm-pring')).not.toBeNull();
    expect(el.textContent).toContain('You');
    noInjection(el);
    const empty = section();
    expect(dash.renderTodaysWorkouts(empty, { ...data, classes: [] }, NOW)).toBe(false);
    expect(empty.hidden).toBe(true);
  });

  it('This week: 7 days, opens on today, instructor then separator then attendees, See more after 3', () => {
    const many = { ...data, classes: [...data.classes, cls('12', 'gym-a', '2026-11-04T18:00:00+00:00', [att('a')]), cls('13', 'gym-a', '2026-11-04T19:00:00+00:00', [att('b')])] };
    const el = section();
    dash.renderThisWeek(el, many, NOW);
    expect(el.querySelectorAll('.tm-wday')).toHaveLength(7);
    expect(el.querySelector('.tm-wday.is-on').getAttribute('data-day')).toBe('0');
    expect(el.querySelectorAll('.tm-wrow')).toHaveLength(3);
    const sub = el.querySelector('.tm-wrow-sub');
    expect([...sub.children].map((c) => c.className.split(' ')[0])).toEqual(['tm-wrow-inst', 'tm-wrow-sep', 'tm-stack', 'tm-wrow-who']);
    expect(el.textContent).not.toMatch(/other gym/i);
    el.querySelector('[data-more]').click();
    expect(el.querySelectorAll('.tm-wrow')).toHaveLength(4);
    noInjection(el);
  });

  it('Classes together: Home favourite card, avatars left of the CTA, CTAs through existing flows', async () => {
    const el = section();
    await dash.renderClassesTogether(el, data, NOW);
    const cards = el.querySelectorAll('.home-favourite-card');
    expect(cards).toHaveLength(3);
    const ctas = [...cards].map((c) => c.querySelector('.home-favourite-cta').textContent);
    expect(ctas).toEqual(['Book', "You're in ✓", 'Turn on Gym <Off>']);
    const foot = cards[0].querySelector('.home-favourite-foot');
    expect(foot.firstElementChild.classList.contains('tm-together-who')).toBe(true);
    expect(foot.lastElementChild.classList.contains('home-favourite-cta')).toBe(true);
    cards[0].querySelector('.home-favourite-cta').click();
    expect(quickBook).toHaveBeenCalledTimes(1);
    noInjection(el);
  });

  it('Members: 4 per page, sort menu, gym chips, Other gym pill, stale line, and a profile page', () => {
    const el = section();
    dash.renderMembers(el, data, NOW);
    expect(el.querySelectorAll('.tm-mem-card')).toHaveLength(3);
    expect(el.querySelectorAll('[data-sort]')).toHaveLength(3);
    const ana = [...el.querySelectorAll('.tm-mem-card')].find((c) => c.textContent.includes('Ana'));
    expect(ana.textContent).toContain('Other gym');
    expect(ana.textContent).toContain('Updated');
    expect(ana.textContent).toContain('In class now');
    expect(el.textContent).toContain('Activity not shared');
    noInjection(el);
    ana.click();
    const page = document.querySelector('.tm-ovl');
    expect(page).not.toBeNull();
    expect(page.querySelectorAll('.tm-li').length).toBeGreaterThanOrEqual(4);
    noInjection(page);
  });
});
