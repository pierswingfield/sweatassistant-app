import { describe, expect, it } from 'vitest';
import { canSelectSelfSpot, countSelfBookingSlots, isCurrentModalRun, validateSelfBookingRequest } from './booking-entitlement.js';

describe('booking entitlement limits', () => {
  it('allows selecting exactly the entitled number of self spots', () => {
    expect(canSelectSelfSpot({ selectedCount: 0, selfBookingLimit: 1 })).toBe(true);
    expect(validateSelfBookingRequest({ slotIds: ['bike-1'], selfBookingLimit: 1 })).toMatchObject({ ok: true });
  });

  it('blocks selection and rejects a request over the self limit', () => {
    expect(canSelectSelfSpot({ selectedCount: 1, selfBookingLimit: 1 })).toBe(false);
    expect(validateSelfBookingRequest({ slotIds: ['bike-2'], currentSelfBookings: 1, selfBookingLimit: 1 }))
      .toMatchObject({ ok: false, code: 'ATTENDEE_LIMIT_EXCEEDED' });
  });

  it('counts self reservations while excluding guest reservations', () => {
    expect(countSelfBookingSlots([
      { eventId: 'class-1', isGuest: false },
      { eventId: 'class-1', isGuest: true },
    ])).toBe(1);
    expect(validateSelfBookingRequest({ slotIds: ['self-2'], currentSelfBookings: 1, selfBookingLimit: 2 }))
      .toMatchObject({ ok: true });
  });

  it('rejects stale async modal work after close or a newer edit opens', () => {
    expect(isCurrentModalRun(4, 4, true)).toBe(true);
    expect(isCurrentModalRun(4, 5, true)).toBe(false);
    expect(isCurrentModalRun(4, 4, false)).toBe(false);
  });
});
