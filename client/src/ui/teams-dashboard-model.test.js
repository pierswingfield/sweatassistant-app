import { describe, it, expect } from 'vitest';
import {
  todaysWorkouts, weekDays, initialDayIndex, visibleWeekRows, classesTogether, memberActivity,
  activityScore, heroState, namesList, ctaKind, memberProfile, statusAt, classDayKey,
} from './teams-dashboard-model.js';

// Wed 4 Nov 2026, 07:53 London (GMT).
const NOW = Date.parse('2026-11-04T07:53:00Z');
const cls = (key, startAt, attendees, extra = {}) => ({
  key, gymId: 'psycle-london', eventId: key, startAt, timeZone: 'Europe/London', durationMin: 45,
  className: `C${key}`, instructorName: 'Kemi', attendees, ...extra,
});
const A = { memberRef: 'a', kind: 'booked' };
const B = { memberRef: 'b', kind: 'booked' };
const ME = { memberRef: 'me', kind: 'booked' };

const classes = [
  cls('1', '2026-11-04T06:45:00+00:00', [B]),                       // done
  cls('2', '2026-11-04T07:30:00+00:00', [{ ...A, spot: 'Bike 14' }, B]), // in progress
  cls('3', '2026-11-04T12:15:00+00:00', [A]),
  cls('4', '2026-11-04T18:30:00+00:00', [ME, { memberRef: 'b', kind: 'waitlist' }]),
  cls('5', '2026-11-05T07:30:00+00:00', [A, B, ME]),
  cls('6', '2026-11-06T07:15:00+00:00', [{ memberRef: 'a', kind: 'queued' }]),
  cls('7', '2026-11-12T07:15:00+00:00', [A, B]),                      // beyond the week
];

describe('statusAt and classDayKey', () => {
  it('derives the status from the clock and the day from the class zone', () => {
    expect(classes.slice(0, 3).map((c) => statusAt(c, NOW))).toEqual(['done', 'inProgress', 'upcoming']);
    const ny = cls('ny', '2026-11-04T23:30:00-05:00', [A], { timeZone: 'America/New_York' });
    expect(classDayKey(ny)).toBe('2026-11-04');
  });
});

describe('todaysWorkouts', () => {
  it('lists past, ongoing and upcoming booked classes today in order, with the ring', () => {
    const rows = todaysWorkouts(classes, { now: NOW });
    expect(rows.map((r) => r.cls.key)).toEqual(['1', '2', '3', '4']);
    expect(rows.map((r) => r.status)).toEqual(['done', 'inProgress', 'upcoming', 'upcoming']);
    expect(rows[1].minutesLeft).toBe(22);
    expect(rows[1].progress).toBeCloseTo(23 / 45, 2);
  });
  it('skips waitlist-only and queued-only classes', () => {
    expect(todaysWorkouts([cls('w', '2026-11-04T19:00:00Z', [{ memberRef: 'a', kind: 'waitlist' }])], { now: NOW })).toEqual([]);
  });
});

describe('weekDays and the strip', () => {
  const days = weekDays(classes, { now: NOW, zone: 'Europe/London' });
  it('covers seven days from today and drops classes outside', () => {
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: '2026-11-04', weekday: 'Wed', dayNum: 4, isToday: true });
    expect(days.flatMap((d) => d.classes).map((c) => c.key)).not.toContain('7');
    expect(days[0].memberRefs).toEqual(['b', 'a', 'me']);
    expect(days[2].classes.map((c) => c.key)).toEqual(['6']);
  });
  it('opens on the day with the next class', () => {
    expect(initialDayIndex(days, NOW)).toBe(0);
    const late = Date.parse('2026-11-04T23:00:00Z');
    expect(initialDayIndex(weekDays(classes, { now: late, zone: 'Europe/London' }), late)).toBe(1);
    expect(initialDayIndex(weekDays([], { now: NOW, zone: 'Europe/London' }), NOW)).toBe(0);
  });
  it('shows at most 3 rows, then See more', () => {
    expect(visibleWeekRows(days[0].classes, false)).toMatchObject({ hidden: 1 });
    expect(visibleWeekRows(days[0].classes, false).rows).toHaveLength(3);
    expect(visibleWeekRows(days[0].classes, true)).toMatchObject({ hidden: 0 });
    expect(visibleWeekRows(days[1].classes, false).hidden).toBe(0);
  });
});

describe('classesTogether', () => {
  it('keeps not-started classes with two or more booked members, chronologically', () => {
    expect(classesTogether(classes, { now: NOW }).map((c) => c.key)).toEqual(['5', '7']);
  });
  it('does not count a waitlisted member as booked', () => {
    expect(classesTogether([classes[3]], { now: NOW })).toEqual([]);
  });
});

describe('memberActivity', () => {
  it('finds who is in class now and their next class, with spots', () => {
    const m = memberActivity([{ memberRef: 'a' }, { memberRef: 'b' }, { memberRef: 'me' }, { memberRef: 'z' }], classes, { now: NOW });
    expect(m.get('a').inClass.key).toBe('2');
    expect(m.get('a').spotIn).toBe('Bike 14');
    expect(m.get('a').next.key).toBe('3');
    expect(m.get('me').next.key).toBe('4');
    expect(m.get('b').next.key).toBe('5');
    expect(m.get('z')).toEqual({ inClass: null, next: null, spotIn: '', spotNext: '' });
  });
});

describe('sorting and header', () => {
  it('activity: week, then month; private counts last', () => {
    expect(activityScore({ counts: { week: 2, month: 9 } })).toBeGreaterThan(activityScore({ counts: { week: 1, month: 30 } }));
    expect(activityScore({ counts: null })).toBe(-1);
  });
  it('heroState names the visible members in class now and keeps the server totals', () => {
    const data = { members: [{ memberRef: 'a', name: 'Ana' }, { memberRef: 'b', name: 'Sam' }], classes, today: { inProgress: 3, done: 1, total: 6 } };
    const h = heroState(data, { now: NOW });
    expect(h.inClass.map((m) => m.name)).toEqual(['Ana', 'Sam']);
    expect(h).toMatchObject({ inProgress: 3, done: 1, total: 6 });
  });
  it('namesList', () => {
    expect(namesList(['Ana'])).toBe('Ana');
    expect(namesList(['Ana', 'Sam'])).toBe('Ana and Sam');
    expect(namesList(['Ana', 'Sam', 'Tom', 'Jo'])).toBe('Ana, Sam and 2 more');
    expect(namesList([])).toBe('');
  });
});

describe('ctaKind', () => {
  const c5 = classes[4];
  it("You're in when the viewer is booked, by projection or by their own bookings", () => {
    expect(ctaKind({ cls: c5, myRef: 'me' })).toBe('in');
    expect(ctaKind({ cls: classes[6], myRef: 'me', bookedByMe: true })).toBe('in');
  });
  it('Turn on Gym beats the booking flow for a paused-but-linked gym', () => {
    expect(ctaKind({ cls: classes[6], myRef: 'me', gymDisabled: true, eventFound: true })).toBe('turnOn');
  });
  it('delegates to the existing timetable action when the event is loaded', () => {
    expect(ctaKind({ cls: classes[6], myRef: 'me', eventFound: true })).toBe('event');
    expect(ctaKind({ cls: classes[6], myRef: 'me' })).toBe('timetable');
  });
});

describe('memberProfile', () => {
  it("lists a member's upcoming (any kind) and recent classes, newest recent first", () => {
    const data = {
      classes,
      recent: [cls('r1', '2026-11-01T08:00:00Z', [A]), cls('r2', '2026-11-02T08:00:00Z', [A]), cls('r3', '2026-11-02T09:00:00Z', [B])],
    };
    const p = memberProfile('a', data, { now: NOW });
    expect(p.upcoming.map((r) => r.cls.key)).toEqual(['2', '3', '5', '6', '7']);
    expect(p.upcoming[0].spot).toBe('Bike 14');
    expect(p.upcoming[3].kind).toBe('queued');
    expect(p.recent.map((r) => r.cls.key)).toEqual(['r2', 'r1']);
  });
});
