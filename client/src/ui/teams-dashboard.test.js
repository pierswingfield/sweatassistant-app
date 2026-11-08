import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { getMetadata: vi.fn(async ({ gymId }) => ({ instructors: gymId === 'gym-a' ? [{ gymId, id: '7', name: 'Kemi Lane', thumbUrl: '/gyms/instructor-test.png' }] : [] })) } }));
vi.mock('../main.js', () => ({ showToast: vi.fn(), debugLog: vi.fn(), cache: {} }));
vi.mock('../gym-context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllLinkedGyms: () => [{ gym_id: 'gym-a', account_enabled: 1 }, { gym_id: 'gym-off', account_enabled: 0 }],
  getGymShortName: (g) => ({ 'gym-a': 'Gym A', 'gym-off': 'Gym <Off>' }[g] || g),
}));
vi.mock('./bookings.js', () => ({ mountBookingCard(host) { const card = document.createElement('div'); card.className = 'ab-card'; host.appendChild(card); } }));
const quickBook = vi.fn();
vi.mock('./timetable.js', () => ({
  getLoadedEvents: () => [{ id: '20', gymId: 'gym-a', startAt: '2026-11-05T07:30:00+00:00', timeZone: 'Europe/London', name: 'Ride 45', instructors: [{ name: 'Kemi' }], availableCount: 6 }],
  ensureScheduleLoaded: vi.fn(),
  isEventBookedByMe: () => false,
  primaryActionForEvent: () => ({ label: 'Book', variant: 'success', run: quickBook }),
  actionModelForTeamEvent: () => ({ alternate: null }),
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
    { memberRef: 'me', name: 'Piers', colourIndex: 0, isCaptain: true, isMe: true, counts: { week: 1, month: 2 }, gyms: ['gym-a'] },
    { memberRef: 'a', name: `${EVIL}Ana`, colourIndex: 1, isCaptain: false, isMe: false, counts: { week: 3, month: 9 }, gyms: ['gym-a'], otherGym: true, stale: true, updatedAt: '2026-11-04T04:00:00Z' },
    { memberRef: 'b', name: 'Sam', colourIndex: 2, isCaptain: false, isMe: false, counts: null, gyms: [], otherGym: true },
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
    expect(h.state).toBe('2 in class now');
    expect(h.sub).toBe('');
    expect(h.avatars).toHaveLength(2);
  });

  it("Today restores a live timeline and completed expansion survives refresh", () => {
    const el = section();
    expect(dash.renderTodaysWorkouts(el, data, NOW)).toBe(true);
    expect(el.querySelectorAll('.tm-tw')).toHaveLength(2);
    expect(el.querySelector('.tm-tw.is-live .tm-pring')).not.toBeNull();
    expect(el.querySelector('.tm-workout-inst')).toBeNull();
    dash.renderTodaysWorkouts(el, data, NOW + 60 * 60000);
    const started = el.querySelector('.tm-tw.is-done');
    const toggle = started.querySelector('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(started.querySelector('.tm-workout-details').hasAttribute('inert')).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(started.querySelector('.tm-workout-details').hasAttribute('inert')).toBe(false);
    expect(started.querySelector('.tm-spot-pill')).not.toBeNull();
    dash.renderTodaysWorkouts(el, data, NOW + 61 * 60000);
    expect(el.querySelector('.is-done button').getAttribute('aria-expanded')).toBe('true');
    noInjection(el);
    const empty = section();
    expect(dash.renderTodaysWorkouts(empty, { ...data, classes: [] }, NOW)).toBe(false);
    expect(empty.hidden).toBe(true);
  });

  it('This week keeps its compact fields, square gym marks and completed expansion', () => {
    const many = { ...data, classes: [...data.classes, cls('12', 'gym-a', '2026-11-04T18:00:00+00:00', [att('a')]), cls('13', 'gym-a', '2026-11-04T19:00:00+00:00', [att('b')])] };
    const el = section();
    dash.renderThisWeek(el, many, NOW);
    expect(el.querySelectorAll('.tm-wday')).toHaveLength(7);
    expect(el.querySelector('.tm-wday.is-on')).toBeNull();
    expect(el.querySelector('.tm-workout')).toBeNull();
    expect(el.querySelector('[data-more]')).toBeNull();
    expect(el.textContent).toContain('Choose a day to see classes');
    expect(el.querySelector('[data-day="0"]').getAttribute('aria-expanded')).toBe('false');
    el.querySelector('[data-day="0"]').click();
    expect(el.querySelector('.tm-wday.is-on').getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelectorAll('.tm-workout')).toHaveLength(3);
    expect(el.querySelector('.tm-workout-inst')).not.toBeNull();
    expect(el.querySelector('.tm-workout-gym .app-gym-mark')).not.toBeNull();
    expect(el.querySelector('.tm-attendees .tm-attendee')).not.toBeNull();
    const toggle = el.querySelector('.is-done button');
    toggle.click(); expect(toggle.getAttribute('aria-expanded')).toBe('true');
    el.querySelector('[data-more]').click();
    expect(el.querySelectorAll('.tm-workout')).toHaveLength(4);
    dash.renderThisWeek(el, many, NOW);
    expect(el.querySelector('.tm-wday.is-on').getAttribute('data-day')).toBe('0');
    expect(el.querySelector('.is-done button').getAttribute('aria-expanded')).toBe('true');
    noInjection(el);
  });

  it('repeated day tap closes details and See more, restores hint, and reopens compactly with focus', () => {
    const el = section(); const many = { ...data, classes: [...data.classes, cls('12', 'gym-a', '2026-11-04T18:00:00+00:00', [att('a')]), cls('13', 'gym-a', '2026-11-04T19:00:00+00:00', [att('b')])] };
    dash.renderThisWeek(el, many, NOW);
    el.querySelector('[data-day="0"]').click(); el.querySelector('[data-more]').click();
    expect(el.querySelectorAll('.tm-workout')).toHaveLength(4);
    el.querySelector('[data-day="0"]').click();
    expect(el.querySelector('[data-day="0"]').getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('#tm-week-classes').hidden).toBe(true);
    expect(el.querySelector('[data-more]')).toBeNull(); expect(el.querySelector('[data-less]')).toBeNull();
    expect(el.querySelector('.tm-week-hint').hidden).toBe(false);
    expect(document.activeElement).toBe(el.querySelector('[data-day="0"]'));
    el.querySelector('[data-day="0"]').click(); expect(el.querySelectorAll('.tm-workout')).toHaveLength(3);
    expect(el.querySelector('.tm-week-hint').hidden).toBe(true);
  });

  it('activates blank and attendee areas, ignores swipes, and keeps completed rows as toggles', async () => {
    const el = section(); dash.renderThisWeek(el, data, NOW);
    el.querySelector('[data-day="1"]').click();
    const row = el.querySelector('.tm-workout');
    const pointer = (type, x) => { const e = new Event(type, { bubbles: true }); Object.assign(e, { clientX: x, clientY: 0 }); row.dispatchEvent(e); };
    pointer('pointerdown', 90); pointer('pointermove', 20); row.querySelector('.tm-attendees').click();
    await new Promise(r => setTimeout(r, 0)); expect(document.querySelector('.tm-ovl')).toBeNull();
    pointer('pointerdown', 20); row.querySelector('.tm-attendees').click();
    await vi.waitFor(() => expect(document.querySelector('.tm-class-members')).not.toBeNull());
    document.querySelector('.tm-ovl').remove();
    pointer('pointerdown', 20); row.click();
    await vi.waitFor(() => expect(document.querySelector('.tm-class-members')).not.toBeNull());
    expect(row.querySelector('button button')).toBeNull();
  });

  it('a future class opens a dismissible sheet using the timetable action', async () => {
    quickBook.mockClear();
    await dash.openTeamClass(data.classes[2], new Map(data.members.map(m => [m.memberRef, m])));
    const sheet = document.querySelector('.tm-ovl');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.querySelector('.tm-class-card .ab-card')).not.toBeNull();
    expect(sheet.querySelector('.tm-class-members').textContent).toContain('Booked');
    sheet.querySelector('.tm-class-actions button').click();
    expect(quickBook).toHaveBeenCalledOnce();
    sheet.querySelector('[data-nav-close]').click();
  });

  it('Classes together: Home favourite card, avatars left of the CTA, CTAs through existing flows', async () => {
    quickBook.mockClear();
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

  it('Classes together: the whole section hides when nothing is booked together', async () => {
    const el = section();
    await dash.renderClassesTogether(el, { ...data, classes: [] }, NOW);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });

  it('Members: 4 per page, sort menu, gym chips, no other-gym text even if a flag arrives, stale line, and a profile page', () => {
    const el = section();
    dash.renderMembers(el, data, NOW);
    expect(el.querySelectorAll('.tm-mem-card')).toHaveLength(3);
    expect(el.querySelectorAll('[data-sort]')).toHaveLength(3);
    const ana = [...el.querySelectorAll('.tm-mem-card')].find((c) => c.textContent.includes('Ana'));
    // T-3 review: nothing marks a gym the viewer hasn't linked (the server no longer sends a flag).
    expect(el.textContent).not.toMatch(/other gym|haven't linked/i);
    expect(el.querySelector('.tm-pill')).toBeNull();
    expect(el.querySelector('.tm-card-head .tm-count-pill').textContent).toBe('3');
    expect(ana.querySelector('.tm-mem-gyms .tm-gstack .tm-gcirc')).not.toBeNull();
    expect(el.textContent).not.toMatch(/Next:/);
    expect(ana.textContent).toContain('Updated');
    expect(ana.textContent).toContain('In class now');
    expect(el.textContent).toContain('Activity not shared');
    noInjection(el);
    ana.click();
    const page = document.querySelector('.tm-ovl');
    expect(page).not.toBeNull();
    expect(page.querySelectorAll('.tm-li').length).toBeGreaterThanOrEqual(4);
    expect(page.textContent).not.toMatch(/haven't linked/i);
    noInjection(page);
  });
});

describe('T-4 Team stats widget', () => {
  const stats = {
    week: { thisWeek: 14, lastWeek: 11, delta: 3 },
    streak: { days: 5, since: '2026-10-31', capped: false },
    charts: { windowDays: 28, total: 6, busiestDays: [1, 1, 0, 0, 0, 3, 1], busiestTimes: Object.assign(new Array(24).fill(0), { 7: 4, 18: 2 }),
      gymMix: [{ gymId: 'gym-off', count: 2 }, { gymId: 'gym-a', count: 4 }] },
  };
  it('renders tiles, "+3 on last week" with no bracketed total, four charts in order, escaped gym names', () => {
    const el = document.createElement('section');
    document.body.appendChild(el);
    expect(dash.renderTeamStats(el, { ...data, stats }, NOW)).toBe(true);
    const text = el.textContent;
    expect(text).toContain('+3 on last week');
    expect(text).not.toMatch(/\(\s*1[14]\s*\)/);
    expect(text).toContain('5 days');
    expect(text).toContain('Team streak');
    expect(el.querySelector('.tm-stat-sub')).toBeNull();
    expect(el.querySelector('.tm-chart-meta')).toBeNull();
    expect([...el.querySelectorAll('.tm-chart-title')].map((n) => n.textContent)).toEqual(['Busiest days', 'Gym mix', 'Busiest times', 'Trending instructors']);
    expect(el.querySelector('off')).toBe(null); // the gym name is text, never markup
    expect(el.textContent).toContain('Gym <Off>');
    expect(el.querySelectorAll('.tm-stats-dots i').length).toBe(4);
  });
  it('renders server-ranked instructor growth with cached metadata photos and initials on failure', async () => {
    const el = section();
    dash.renderTeamStats(el, { ...data, stats: { ...stats, charts: { ...stats.charts, trendingInstructors: [{ gymId: 'gym-a', instructorId: '7', name: 'Kemi Lane', current: 5, previous: 2, delta: 3 }, { gymId: 'gym-off', name: EVIL, current: 2, previous: 0, delta: 2 }] } } }, NOW);
    expect(el.querySelector('.tm-trending-avatar').textContent).toBe('KL');
    expect(el.querySelector('.tm-trending-gym .app-gym-mark')).not.toBeNull();
    expect(el.querySelector('.tm-trending-delta').textContent).toBe('+3');
    expect(el.textContent).not.toContain('Last 14 days vs previous 14');
    expect(el.querySelector('.tm-chart[aria-label="Trending instructors"] [role=img]').getAttribute('aria-label')).toContain('Last 14 days versus previous 14.');
    expect(el.textContent).toContain('5 shared class visits');
    expect(el.textContent).not.toContain('was 2');
    await vi.waitFor(() => expect(el.querySelector('.tm-trending-photo')).not.toBeNull());
    expect(el.querySelector('.tm-trending-photo').getAttribute('src')).toBe('/gyms/instructor-test.png');
    el.querySelector('.tm-trending-photo').dispatchEvent(new Event('error'));
    expect(el.querySelector('.tm-trending-avatar').textContent).toBe('KL');
    noInjection(el);
  });
  it('hides without a stats block, and shows empty charts and no streak gracefully', () => {
    const el = document.createElement('section');
    expect(dash.renderTeamStats(el, { ...data }, NOW)).toBe(false);
    expect(el.hidden).toBe(true);
    const empty = { week: { thisWeek: 0, lastWeek: 0, delta: 0 }, streak: { days: 0, since: null }, charts: { total: 0, busiestDays: [], busiestTimes: [], gymMix: [] } };
    dash.renderTeamStats(el, { ...data, stats: empty }, NOW);
    expect(el.textContent).toContain('Same as last week');
    expect(el.textContent).toContain('No streak');
    expect(el.querySelectorAll('.tm-chart-empty').length).toBe(4);
  });
});

describe('D13 Team goal (cooperative, §8.1 option B)', () => {
  const stats = { week: { thisWeek: 14, lastWeek: 11, delta: 3 }, streak: { days: 0, since: null }, charts: { total: 0, busiestDays: [], busiestTimes: [], gymMix: [] } };
  it('shows a ring with 14 of 20, an encouraging line, above the tiles, with no names', () => {
    const el = document.createElement('section');
    dash.renderTeamStats(el, { ...data, myRole: 'member', stats, goal: { target: 20, count: 14 } }, NOW);
    const goal = el.querySelector('.tm-goal');
    expect(goal).not.toBe(null);
    expect(goal.textContent).toContain('14');
    expect(goal.querySelector('.tm-goal-ring-num b').textContent).toBe('14');
    expect(goal.textContent).toContain('of 20');
    expect(goal.textContent).toContain('6 to go');
    expect(goal.querySelector('.tm-goal-ring-prog').getAttribute('stroke-dasharray').split(' ')[0]).toBe(((0.7) * 2 * Math.PI * 34).toFixed(1));
    expect(goal.textContent).not.toContain('Ana');
    expect(el.firstElementChild.nextElementSibling).toBe(goal); // right after the card head
    expect(el.querySelector('[data-goal-edit]')).toBe(null); // members cannot edit
  });
  it('reached: celebratory line and a full ring; a count over the target caps at 100%', () => {
    const el = document.createElement('section');
    dash.renderTeamStats(el, { ...data, stats, goal: { target: 10, count: 14 } }, NOW);
    expect(el.querySelector('.tm-goal').classList.contains('is-reached')).toBe(true);
    expect(el.textContent).toContain('Goal reached');
    const dash100 = (2 * Math.PI * 34).toFixed(1);
    expect(el.querySelector('.tm-goal-ring-prog').getAttribute('stroke-dasharray').split(' ')[0]).toBe(dash100);
  });
  it('no goal: nothing for members; a Captain gets "Set a weekly Team goal", which calls back', () => {
    const el = document.createElement('section');
    dash.renderTeamStats(el, { ...data, myRole: 'member', stats, goal: null }, NOW, { onEditGoal: null });
    expect(el.querySelector('.tm-goal, [data-goal-edit]')).toBe(null);
    const onEditGoal = vi.fn();
    dash.renderTeamStats(el, { ...data, myRole: 'captain', stats, goal: null }, NOW, { onEditGoal });
    expect(el.querySelector('.tm-goal')).toBe(null);
    expect(el.lastElementChild.hasAttribute('data-goal-edit')).toBe(true); // at the bottom of the card
    el.querySelector('[data-goal-edit]').click();
    expect(onEditGoal).toHaveBeenCalledTimes(1);
    dash.renderTeamStats(el, { ...data, myRole: 'captain', stats, goal: { target: 5, count: 1 } }, NOW, { onEditGoal });
    expect(el.querySelector('.tm-goal [data-goal-edit]').textContent).toBe('Edit');
  });
  it('a malformed goal renders nothing and the payload is never interpreted as markup', () => {
    expect(dash.teamGoalHtml({ target: '<b>', count: 1 })).toBe('');
    expect(dash.teamGoalHtml({ target: 0, count: 1 })).toBe('');
    expect(dash.teamGoalHtml({ target: 3, count: '<img src=x>' })).not.toContain('<img');
  });
});
