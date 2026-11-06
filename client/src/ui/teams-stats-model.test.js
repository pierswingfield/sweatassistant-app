import { describe, expect, it } from 'vitest';
import {
  weekChange, streakView, busiestDaysView, busiestTimesView, gymMixView, viewerDayKey,
} from './teams-stats-model.js';

// 2026-11-09 is a Monday. 23:30 UTC that day is still Monday in London but already
// Tuesday 08:30 in Tokyo, and still Monday 18:30 in New York.
const LATE_MON_UTC = Date.parse('2026-11-09T23:30:00Z');

describe('viewerDayKey (lib.js dayKeyInZone)', () => {
  it('reads the calendar day in the viewer zone, across a midnight boundary', () => {
    expect(viewerDayKey(LATE_MON_UTC, 'Europe/London')).toBe('2026-11-09');
    expect(viewerDayKey(LATE_MON_UTC, 'Asia/Tokyo')).toBe('2026-11-10');
    expect(viewerDayKey(LATE_MON_UTC, 'America/New_York')).toBe('2026-11-09');
  });
});

describe('weekChange', () => {
  it('carries the sign, never a bracketed total', () => {
    expect(weekChange({ thisWeek: 14, lastWeek: 11, delta: 3 })).toEqual({ thisWeek: 14, delta: 3, tone: 'up' });
    expect(weekChange({ thisWeek: 2, lastWeek: 5, delta: -3 })).toEqual({ thisWeek: 2, delta: -3, tone: 'down' });
    expect(weekChange({ thisWeek: 4, lastWeek: 4 })).toEqual({ thisWeek: 4, delta: 0, tone: 'same' });
    expect(weekChange(null)).toEqual({ thisWeek: 0, delta: 0, tone: 'same' });
  });
});

describe('streakView', () => {
  it('a class-zone "since" day reads relative to the VIEWER\'s today (week boundary)', () => {
    // since Monday 9 Nov: a London viewer at 23:30 Monday is still on that day ...
    expect(streakView({ days: 1, since: '2026-11-09' }, { now: LATE_MON_UTC, zone: 'Europe/London' }).since.kind).toBe('today');
    // ... while for a Tokyo viewer it is already Tuesday, so it was yesterday.
    expect(streakView({ days: 1, since: '2026-11-09' }, { now: LATE_MON_UTC, zone: 'Asia/Tokyo' }).since.kind).toBe('yesterday');
  });
  it('uses the weekday within the last week, a date beyond it', () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    expect(streakView({ days: 3, since: '2026-11-07' }, { now, zone: 'Europe/London' })).toEqual({ days: 3, capped: false, since: { kind: 'weekday', label: 'Sat' } });
    expect(streakView({ days: 2, since: '2026-11-09' }, { now, zone: 'Europe/London' }).since).toEqual({ kind: 'weekday', label: 'Mon' });
    expect(streakView({ days: 9, since: '2026-11-02' }, { now, zone: 'Europe/London' }).since).toEqual({ kind: 'date', label: '2 Nov' });
  });
  it('edges: none, malformed, and capped', () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    expect(streakView({ days: 0, since: null }, { now, zone: 'Europe/London' })).toEqual({ days: 0, capped: false, since: null });
    expect(streakView(undefined, { now, zone: 'Europe/London' }).days).toBe(0);
    expect(streakView({ days: 31, since: '2026-10-11', capped: true }, { now, zone: 'Europe/London' }).capped).toBe(true);
    expect(streakView({ days: 2, since: 'nonsense' }, { now, zone: 'Europe/London' }).since).toBe(null);
  });
});

describe('busiestDaysView', () => {
  it('Monday first, scales to the busiest day, names a single peak only', () => {
    const v = busiestDaysView([2, 3, 2, 4, 1, 6, 3]);
    expect(v.bars.map((b) => b.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(v.peakName).toBe('Saturday');
    expect(v.bars[5].frac).toBe(1);
    expect(v.total).toBe(21);
    expect(busiestDaysView([1, 1, 0, 0, 0, 0, 0]).peak).toBe(-1);
    expect(busiestDaysView(undefined).total).toBe(0);
  });
});

describe('busiestTimesView', () => {
  it('spans 06:00..21:00 at least, widened to early or late classes, ticked every 4 h and at the end', () => {
    const counts = new Array(24).fill(0);
    counts[7] = 3; counts[18] = 5;
    const v = busiestTimesView(counts);
    expect(v.bars[0].label).toBe('06:00');
    expect(v.bars.at(-1).label).toBe('21:00');
    expect(v.bars.filter((b) => b.tick).map((b) => b.label)).toEqual(['06:00', '10:00', '14:00', '18:00', '21:00']);
    expect(v.peak).toBe(18);
    counts[5] = 1; counts[22] = 1;
    const w = busiestTimesView(counts);
    expect([w.bars[0].hour, w.bars.at(-1).hour]).toEqual([5, 22]);
    counts[23] = 1;
    // 06..23 would tick 22:00 and 23:00 side by side: the regular one is dropped.
    expect(busiestTimesView(counts).bars.filter((b) => b.tick).map((b) => b.label)).toEqual(['05:00', '09:00', '13:00', '17:00', '23:00']);
  });
});

describe('gymMixView', () => {
  it('whole percentages that sum to 100, with the brand name and colour', () => {
    const v = gymMixView([{ gymId: 'a', count: 1 }, { gymId: 'b', count: 1 }, { gymId: 'c', count: 1 }],
      (g) => ({ name: g.toUpperCase(), colour: '#111111' }));
    expect(v.rows.map((r) => r.percent).reduce((a, b) => a + b, 0)).toBe(100);
    expect(v.rows[0]).toMatchObject({ gymId: 'a', name: 'A', colour: '#111111' });
    expect(gymMixView([{ gymId: 'a', count: 0 }]).total).toBe(0);
  });
});
