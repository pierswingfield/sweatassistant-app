import { describe, expect, it } from 'vitest';
import { bookingQuantityOptions, maxAttendeesPerClass } from './booking-limits.js';

describe('per-class attendee limits', () => {
  it('caps JAB at one attendee regardless of provider slots or credits', () => {
    expect(maxAttendeesPerClass({ gymLimit: 1, providerLimit: 40 })).toBe(1);
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
