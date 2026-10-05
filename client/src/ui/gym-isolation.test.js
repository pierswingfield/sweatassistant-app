import { describe, expect, it } from 'vitest';
import { findUpgradeForSeat, findActiveUpgradeForBooking, isCreditInventoryLoaded, pickStudioPrefs } from './gym-isolation.js';

describe('gym-qualified client lookups', () => {
  it('loads simple-book credit state from the class gym and leaves unmetered gyms permissive', () => {
    const cache = {
      profile: { gymId: 'jab-boxing', available_credits: [{ credits_remaining: 2 }] },
      creditsByGym: { 'jab-boxing': [] },
    };

    expect(isCreditInventoryLoaded(cache, 'psycle-london', true)).toBe(false);
    cache.creditsByGym['psycle-london'] = [];
    expect(isCreditInventoryLoaded(cache, 'psycle-london', true)).toBe(true);
    expect(isCreditInventoryLoaded(cache, 'unmetered-gym', false)).toBe(true);
  });

  it('does not use another gym studio prefs when a gym is specified', () => {
    const prefs = {
      'psycle-london:5': { preferredSlots: ['bike-1'] },
      'jab-boxing:5': { preferredSlots: ['bag-1'] },
      5: { preferredSlots: ['legacy-slot'] },
    };

    expect(pickStudioPrefs(prefs, 5, 'jab-boxing')).toEqual({ preferredSlots: ['bag-1'] });
    expect(pickStudioPrefs(prefs, 5, 'unknown-gym')).toEqual({});
    expect(pickStudioPrefs(prefs, 5, 'unknown-gym', true)).toEqual({ preferredSlots: ['legacy-slot'] });
    expect(pickStudioPrefs(prefs, 5)).toEqual({ preferredSlots: ['legacy-slot'] });
  });

  it('matches upgrade monitors by booking and gym', () => {
    const upgrades = [
      { id: 1, booking_id: 123, gym_id: 'psycle-london', status: 'active' },
      { id: 2, booking_id: 123, gym_id: 'jab-boxing', status: 'paused_no_credits' },
    ];

    expect(findActiveUpgradeForBooking(upgrades, '123', 'jab-boxing')).toBe(upgrades[1]);
    expect(findActiveUpgradeForBooking(upgrades, 123, 'other-gym')).toBeUndefined();
  });
});

describe('findUpgradeForSeat', () => {
  const ups = [
    { id: 28, gym_id: 'psycle-london', event_id: 217241, booking_id: 8551698, current_slot_id: 8, status: 'active' },
    { id: 35, gym_id: 'psycle-london', event_id: 82484, booking_id: 421951, current_slot_id: 36272, status: 'stopped' },
  ];
  it('follows a re-booked seat by event+slot when the booking id is stale', () => {
    const u = findUpgradeForSeat(ups, { bookingId: 8564249, gymId: 'psycle-london', eventId: '217241', slotId: '8' });
    expect(u?.id).toBe(28);
  });
  it('is gym scoped and surfaces stopped monitors', () => {
    expect(findUpgradeForSeat(ups, { bookingId: 8564249, gymId: 'jab-boxing', eventId: '217241', slotId: '8' })).toBeUndefined();
    expect(findUpgradeForSeat(ups, { bookingId: 421951, gymId: 'psycle-london', eventId: 82484, slotId: 36272 })?.status).toBe('stopped');
  });
});
