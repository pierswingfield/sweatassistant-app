import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { groupBookingsByEvent, selectUpcoming } from './upcoming.js';

const now = DateTime.fromISO('2026-10-06T10:00:00', { zone: 'Europe/London' });
const bk = (id, startAt, gymId = 'psycle-london') => ({ gymId, eventId: id, event: { id, gymId, startAt } });

describe('H-4 upcoming selection', () => {
  it('groups seats of one class and keeps gyms with colliding event ids apart', () => {
    const g = groupBookingsByEvent([bk(1, '2026-10-07T09:00:00+01:00'), bk(1, '2026-10-07T09:00:00+01:00'), bk(1, '2026-10-08T09:00:00+01:00', 'jab-boxing'), { eventId: 9 }]);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.gymId === 'psycle-london').bookings).toHaveLength(2);
  });
  it('is card mode with null next when nothing is booked', () => {
    expect(selectUpcoming([], now, 'Europe/London')).toMatchObject({ mode: 'card', next: null });
  });
  it('is card mode for a single class in 7 days and ignores past classes', () => {
    const g = groupBookingsByEvent([bk(1, '2026-10-05T09:00:00+01:00'), bk(2, '2026-10-08T09:00:00+01:00')]);
    const r = selectUpcoming(g, now, 'Europe/London');
    expect(r.mode).toBe('card');
    expect(r.next.eventId).toBe('2');
  });
  it('card mode shows the next class even when it is beyond 7 days', () => {
    const g = groupBookingsByEvent([bk(3, '2026-10-20T09:00:00+01:00')]);
    expect(selectUpcoming(g, now, 'Europe/London').next.eventId).toBe('3');
  });
  it('is strip mode with 7 days when 2+ classes fall in the window', () => {
    const g = groupBookingsByEvent([bk(1, '2026-10-06T18:00:00+01:00'), bk(2, '2026-10-08T09:00:00+01:00'), bk(3, '2026-10-13T09:00:00+01:00')]);
    const r = selectUpcoming(g, now, 'Europe/London');
    expect(r.mode).toBe('strip');
    expect(r.days).toHaveLength(7);
    expect(r.days[0].isToday).toBe(true);
    expect(r.days[0].groups.map((x) => x.eventId)).toEqual(['1']);
    expect(r.days[2].groups.map((x) => x.eventId)).toEqual(['2']);
    expect(r.days.flatMap((d) => d.groups)).toHaveLength(2); // day 8 (13 Oct) is outside
  });
});
