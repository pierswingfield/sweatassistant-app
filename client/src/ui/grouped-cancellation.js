// State transitions for the multi-spot cancellation chooser.  Keeping this
// separate from the DOM means the sequence is explicit and testable: guests
// are always attempted before the member reservation, and a partial failure
// only removes reservations the provider has actually cancelled.

import { COPY } from '../copy.js';

const idOf = (booking) => String(booking?.bookingId ?? booking?.id ?? '');

// The compact rail action should not repeat the imperative modal title.
export const GUEST_ACTION_LABEL = COPY.bookings.guestMenu;

export function hasMultipleBookedSpots(bookings) {
  return (bookings || []).filter((booking) => idOf(booking)).length > 1;
}

export function orderedCancellationIds(bookings) {
  return [...(bookings || [])]
    .filter((booking) => idOf(booking))
    .sort((a, b) => Number(!!b.isGuest) - Number(!!a.isGuest))
    .map(idOf);
}

export function createGroupedCancellationState(bookings) {
  return { bookings: [...(bookings || [])], confirmation: null, error: null };
}

// A member reservation may only be individually cancelled after its linked
// guests.  The server still enforces this invariant for stale/external calls.
export function isIndividualCancellationBlocked(state, bookingId) {
  const target = state.bookings.find((booking) => idOf(booking) === String(bookingId));
  return !!target && !target.isGuest && state.bookings.some((booking) => booking.isGuest);
}

export function requestGroupedCancellation(state, bookingId = null) {
  const ids = bookingId == null
    ? orderedCancellationIds(state.bookings)
    : [String(bookingId)];
  return { ...state, confirmation: { ids, all: bookingId == null }, error: null };
}

export function clearGroupedCancellationConfirmation(state) {
  return { ...state, confirmation: null };
}

export function applyGroupedCancellationResult(state, { cancelledIds = [], error = null } = {}) {
  const cancelled = new Set(cancelledIds.map(String));
  const bookings = state.bookings.filter((booking) => !cancelled.has(idOf(booking)));
  return {
    bookings,
    confirmation: null,
    error,
    shouldClose: bookings.length === 0,
  };
}
