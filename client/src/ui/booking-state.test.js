import { describe, it, expect, beforeEach, vi } from 'vitest';

const cache = { bookings: null, waitlists: null };
vi.mock('../main', () => ({ cache }));
vi.mock('../api', () => ({ api: { getBookings: vi.fn(), getWaitlists: vi.fn() } }));

const { applyMutationToCache, dropBookingFromCache, dropWaitlistFromCache } = await import('./booking-state.js');

describe('booking-state (U1-15)', () => {
  beforeEach(() => {
    cache.bookings = [
      { bookingId: '900001', eventId: '9043', gymId: 'jab-boxing' },
      { bookingId: 77, eventId: '5', gymId: 'psycle-london' },
    ];
    cache.waitlists = [
      { eventId: '9043', gymId: 'jab-boxing' },
      { eventId: '9043', gymId: 'psycle-london' }, // same provider id, different gym
    ];
  });

  it('a cancel makes the booking disappear from the shared cache synchronously', () => {
    applyMutationToCache({ type: 'cancel', bookingId: '900001', gymId: 'jab-boxing' });
    expect(cache.bookings.map((b) => b.bookingId)).toEqual([77]);
  });

  it('matches ids across string/number', () => {
    dropBookingFromCache('77');
    expect(cache.bookings.map((b) => b.bookingId)).toEqual(['900001']);
  });

  it('leaving a waitlist only drops that gym\'s entry (provider ids collide across gyms)', () => {
    applyMutationToCache({ type: 'leaveWaitlist', eventId: '9043', gymId: 'jab-boxing' });
    expect(cache.waitlists).toEqual([{ eventId: '9043', gymId: 'psycle-london' }]);
  });

  it('book / join / swap leave the cache alone (a refetch supplies the new row)', () => {
    const before = JSON.stringify(cache);
    applyMutationToCache({ type: 'book', eventId: '1' });
    applyMutationToCache({ type: 'joinWaitlist', eventId: '1' });
    applyMutationToCache({ type: 'swap', bookingId: '900001' });
    expect(JSON.stringify(cache)).toBe(before);
  });

  it('is safe before anything has loaded', () => {
    cache.bookings = null; cache.waitlists = null;
    expect(() => { dropBookingFromCache('1'); dropWaitlistFromCache('1'); }).not.toThrow();
  });
});
