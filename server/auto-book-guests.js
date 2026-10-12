const { preferenceError } = require('./auto-book-preferences');

// Save-time validation distinguishes a capability restriction from a balance or
// availability condition that can change before the release window. Runtime
// execution always calls the adapter again immediately before charging a guest.
async function validateScheduledGuestEligibility({ provider, eventId, session, guestCount }) {
  if (!guestCount) return { warning: null, entitlement: null };
  if (typeof provider.getBookingEntitlement !== 'function') {
    throw preferenceError('GUEST_BOOKING_UNSUPPORTED', 'Scheduled guests are not supported by this gym yet.');
  }
  const entitlement = await provider.getBookingEntitlement(eventId, session);
  if (entitlement.guestSupported !== true) {
    throw preferenceError('GUEST_BOOKING_UNSUPPORTED', 'Guest booking is not available at this gym.');
  }
  // The adapter contract is currently one named guest per member reservation.
  // Do not reinterpret a self allowance as a guest allowance.
  if (guestCount > 1) throw preferenceError('GUEST_LIMIT_EXCEEDED', 'This class allows one scheduled guest.');
  // The MT payment-options endpoint can be empty before the booking window opens
  // and a guest may only become eligible after the primary reservation. Both are
  // temporal states for a scheduled job, not evidence that the gym forbids a
  // guest. Runtime `bookGuestSlot` refreshes this eligibility after the primary.
  const temporaryReasons = new Set(['NO_GUEST_PASSES', 'NO_VALID_GUEST_PAYMENT_OPTION', 'CLASS_FULL', 'BOOKING_NOT_OPEN', 'PRIMARY_RESERVATION_REQUIRED']);
  // An unknown allowance (provider published no count) is also temporal: allow, and re-check at run time.
  temporaryReasons.add('GUEST_ALLOWANCE_UNKNOWN');
  if (!entitlement.guestEligible && !temporaryReasons.has(entitlement.guestReason)) {
    throw preferenceError(entitlement.guestReason || 'GUEST_NOT_ELIGIBLE', 'This guest is not currently eligible for this class.', 409);
  }
  return {
    entitlement,
    warning: entitlement.guestEligible && entitlement.guestReason !== 'GUEST_ALLOWANCE_UNKNOWN' ? null : { code: entitlement.guestReason, message: 'Guest eligibility will be checked again when Auto-Book runs.' },
  };
}

module.exports = { validateScheduledGuestEligibility };
