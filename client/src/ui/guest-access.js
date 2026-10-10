// Pure helpers for guest access: when to offer the action, and why a guest cannot be added.
import { COPY } from '../copy.js';

/** Show the direct Guest action on a booking card: gym supports guests and none is booked yet. */
export function canOfferGuestAction({ supported, bookings = [] }) {
  return !!supported && !bookings.some((b) => b && b.isGuest);
}

/** Plain-language reason for a guest entitlement refusal (never the generic message when a reason exists). */
export function guestUnavailableMessage(reason) {
  return COPY.bookings[`guestReason_${reason}`] || COPY.bookings.guestBookingUnavailable;
}
