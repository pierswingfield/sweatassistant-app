import { describe, expect, it } from 'vitest';
import { bookingQuantityOptions, maxAttendeesPerClass } from './booking-limits.js';

describe('per-class attendee limits', () => {
  it('turns a resolved one-self-booking entitlement into no quantity choice', () => {
    expect(bookingQuantityOptions(1)).toEqual([1]);
  });

  it('preserves the existing four-option range when no gym/provider cap exists', () => {
    expect(maxAttendeesPerClass()).toBe(4);
    expect(bookingQuantityOptions()).toEqual([1, 2, 3, 4]);
  });

  it('uses the stricter available provider or gym cap', () => {
    expect(maxAttendeesPerClass({ gymLimit: 3, providerLimit: 2 })).toBe(2);
    expect(bookingQuantityOptions(2)).toEqual([1, 2]);
  });
});
