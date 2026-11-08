import { describe, it, expect } from 'vitest';
import { todayLineSegments, hottestSegments, segmentsText } from './teams-today.js';
import { COPY } from '../copy.js';

const copy = COPY.teams;
// Stub clock: anything on 2026-11-10 is "today"; day names from a fixed table.
const when = (iso) => ({
  time: iso.slice(11, 16),
  day: { '2026-11-11': 'Wed', '2026-11-13': 'Fri' }[iso.slice(0, 10)] || 'Tue',
  isToday: iso.startsWith('2026-11-10'),
});
const line = (today) => segmentsText(todayLineSegments(today, when, copy));

describe('Teams list today line (§5.2)', () => {
  it('counts and progress', () => {
    expect(line({ total: 3, done: 1, inProgress: 0, remaining: 2 })).toBe('3 classes today · 1 done');
    expect(line({ total: 1, done: 0, inProgress: 0, remaining: 1, firstAt: { startAt: '2026-11-10T12:15:00Z' } })).toBe('1 class today · first at 12:15');
    expect(line({ total: 2, done: 0, inProgress: 1, remaining: 1 })).toBe('2 classes today · 1 in class now');
  });
  it('one person: "John doing 08:30 Train"', () => {
    expect(line({ total: 1, done: 0, inProgress: 0, remaining: 1, solo: { name: 'John', startAt: '2026-11-10T08:30:00Z', className: 'Train' } }))
      .toBe('1 class today · John doing 08:30 Train');
  });
  it('rest day and all done carry the next-class hint', () => {
    expect(line({ total: 0, next: { when: 'later', count: 3, startAt: '2026-11-13T07:30:00Z', className: 'Ride 45' } }))
      .toBe('Rest day · Next: 3 doing Fri 07:30 Ride 45');
    expect(line({ total: 2, done: 2, inProgress: 0, remaining: 0, next: { when: 'tomorrow', count: 1, name: 'Lily', startAt: '2026-11-11T08:30:00Z', className: 'Train' } }))
      .toBe('All done for today · Tomorrow: Lily doing 08:30 Train');
    expect(line({ total: 0 })).toBe('Rest day');
  });
  it('other gyms are a count only', () => {
    expect(line({ total: 3, done: 0, inProgress: 0, remaining: 3, otherGyms: 2, firstAt: { startAt: '2026-11-10T09:00:00Z' } }))
      .toBe('3 classes today · first at 09:00 · +2 at other gyms');
  });
  it('the strong segment is the count; hints are muted', () => {
    const segs = todayLineSegments({ total: 0, next: { when: 'tomorrow', count: 2, startAt: '2026-11-11T08:30:00Z', className: 'X' } }, when, copy);
    expect(segs[1].muted).toBe(true);
    expect(todayLineSegments({ total: 2, done: 1, remaining: 1 }, when, copy)[0].strong).toBe(true);
  });
});

describe('Teams list hottest line', () => {
  it('needs two or more people', () => {
    expect(hottestSegments({ hottest: { count: 1, startAt: '2026-11-10T08:30:00Z', className: 'Train' } }, when, copy)).toBeNull();
    expect(hottestSegments({}, when, copy)).toBeNull();
  });
  it('time, class and place; a later day names the day', () => {
    expect(segmentsText(hottestSegments({ hottest: { count: 2, startAt: '2026-11-10T18:30:00Z', className: 'Train', locationName: 'JAB Shoreditch' } }, when, copy)))
      .toBe('2 doing 18:30 Train · JAB Shoreditch');
    expect(segmentsText(hottestSegments({ hottest: { count: 3, startAt: '2026-11-13T07:30:00Z', className: 'Ride 45' } }, when, copy)))
      .toBe('3 doing Fri 07:30 Ride 45');
  });
});
