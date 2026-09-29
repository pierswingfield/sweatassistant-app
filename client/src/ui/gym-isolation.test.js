import { describe, expect, it } from 'vitest';
import { findActiveUpgradeForBooking, isCreditInventoryLoaded, pickStudioPrefs } from './gym-isolation.js';

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
