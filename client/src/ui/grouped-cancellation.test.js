import { describe, expect, it } from 'vitest';
import {
  applyGroupedCancellationResult,
  createGroupedCancellationState,
  GUEST_ACTION_LABEL,
  hasMultipleBookedSpots,
  isIndividualCancellationBlocked,
  orderedCancellationIds,
  requestGroupedCancellation,
} from './grouped-cancellation.js';

const self = { bookingId: 'self-1', slotLabel: '24' };
const guestA = { bookingId: 'guest-1', slotLabel: '3', isGuest: true };
const guestB = { bookingId: 'guest-2', slotLabel: '4', isGuest: true };

describe('grouped cancellation chooser', () => {
  it('uses the compact Guest label on the booking-card action', () => {
    expect(GUEST_ACTION_LABEL).toBe('Guest');
  });

  it('only opens for classes with more than one booked spot', () => {
    expect(hasMultipleBookedSpots([self])).toBe(false);
    expect(hasMultipleBookedSpots([self, guestA])).toBe(true);
  });

  it('requires a second explicit tap for an individual spot', () => {
    const state = requestGroupedCancellation(createGroupedCancellationState([self, guestA]), 'guest-1');
    expect(state.confirmation).toEqual({ ids: ['guest-1'], all: false });
  });

  it('orders Cancel all guest-first and requires confirmation', () => {
    const state = createGroupedCancellationState([self, guestA, guestB]);
    expect(orderedCancellationIds(state.bookings)).toEqual(['guest-1', 'guest-2', 'self-1']);
    expect(requestGroupedCancellation(state).confirmation).toEqual({ ids: ['guest-1', 'guest-2', 'self-1'], all: true });
  });

  it('keeps the primary action unavailable until guest spots are cancelled', () => {
    const state = createGroupedCancellationState([self, guestA]);
    expect(isIndividualCancellationBlocked(state, 'self-1')).toBe(true);
    const afterGuest = applyGroupedCancellationResult(state, { cancelledIds: ['guest-1'] });
    expect(isIndividualCancellationBlocked(afterGuest, 'self-1')).toBe(false);
  });

  it('removes only confirmed cancellations after an error and auto-closes when none remain', () => {
    const partial = applyGroupedCancellationResult(createGroupedCancellationState([self, guestA]), {
      cancelledIds: ['guest-1'], error: 'Provider refused the remaining reservation.',
    });
    expect(partial.bookings).toEqual([self]);
    expect(partial.error).toContain('Provider refused');
    expect(partial.shouldClose).toBe(false);

    expect(applyGroupedCancellationResult(partial, { cancelledIds: ['self-1'] }).shouldClose).toBe(true);
  });
});
