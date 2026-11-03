import { describe, it, expect } from 'vitest';
import { normalizeBookingsView, mergeBookingsTimeline, DEFAULT_BOOKINGS_VIEW, BOOKINGS_VIEW_KEY } from './bookings-view.js';
import { groupBookingsByEvent } from './upcoming.js';

const booking = (id, startAt, gymId = 'psycle-london') => ({ bookingId: `b${id}`, event: { id: String(id), gymId, startAt } });
const waitlist = (id, startAt, gymId = 'psycle-london') => ({ event: { id: String(id), gymId, startAt } });

describe('bookings view mode', () => {
  it('defaults to combined for absent or unknown values', () => {
    expect(DEFAULT_BOOKINGS_VIEW).toBe('combined');
    expect(BOOKINGS_VIEW_KEY).toBe('bookingsView');
    for (const v of [undefined, null, '', 'grid', 42]) expect(normalizeBookingsView(v)).toBe('combined');
  });

  it('keeps a valid saved choice', () => {
    expect(normalizeBookingsView('separate')).toBe('separate');
    expect(normalizeBookingsView('combined')).toBe('combined');
  });
});

describe('mergeBookingsTimeline', () => {
  it('interleaves booked and waitlisted classes chronologically', () => {
    const groups = groupBookingsByEvent([
      booking(1, '2026-11-05T09:00:00Z'),
      booking(2, '2026-11-03T18:00:00Z'),
    ]);
    const wl = [waitlist(9, '2026-11-04T07:00:00Z'), waitlist(8, '2026-11-02T07:00:00Z')];
    const merged = mergeBookingsTimeline(groups, wl);
    expect(merged.map(i => `${i.kind}:${(i.group || i.waitlist).event.id}`)).toEqual([
      'waitlist:8', 'booking:2', 'waitlist:9', 'booking:1',
    ]);
  });

  it('compares instants, not strings, across offsets', () => {
    const groups = groupBookingsByEvent([booking(1, '2026-11-03T10:00:00-05:00')]); // 15:00Z
    const wl = [waitlist(2, '2026-11-03T14:00:00+00:00')];
    expect(mergeBookingsTimeline(groups, wl).map(i => i.kind)).toEqual(['waitlist', 'booking']);
  });

  it('puts a booking before a waitlist at the same instant', () => {
    const groups = groupBookingsByEvent([booking(1, '2026-11-03T10:00:00Z')]);
    const wl = [waitlist(2, '2026-11-03T10:00:00Z')];
    expect(mergeBookingsTimeline(groups, wl).map(i => i.kind)).toEqual(['booking', 'waitlist']);
  });

  it('drops waitlists without a start time and tolerates missing inputs', () => {
    expect(mergeBookingsTimeline(null, [{ event: { id: '1' } }, { event: null }])).toEqual([]);
    expect(mergeBookingsTimeline(undefined, undefined)).toEqual([]);
  });

  it('accepts the legacy start_at field', () => {
    const merged = mergeBookingsTimeline([], [{ event: { id: '1', start_at: '2026-11-03T10:00:00Z' } }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].startMs).toBe(Date.parse('2026-11-03T10:00:00Z'));
  });
});
