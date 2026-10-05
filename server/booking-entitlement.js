'use strict';

function countSelfBookings(bookings, eventId) {
  return (Array.isArray(bookings) ? bookings : []).filter((booking) =>
    String(booking && booking.eventId) === String(eventId) && booking.isGuest !== true
  ).length;
}

function validateSelfBookingLimit({ currentSelfBookings, requestedSelfBookings, selfBookingLimit }) {
  const current = Math.max(0, Math.floor(Number(currentSelfBookings) || 0));
  const requested = Math.max(0, Math.floor(Number(requestedSelfBookings) || 0));
  const limit = Number(selfBookingLimit);
  if (!Number.isFinite(limit) || limit < 0) {
    return { ok: false, code: 'BOOKING_LIMIT_UNAVAILABLE' };
  }
  if (current + requested > limit) {
    return { ok: false, code: 'ATTENDEE_LIMIT_EXCEEDED', current, requested, limit };
  }
  return { ok: true, current, requested, limit };
}

module.exports = { countSelfBookings, validateSelfBookingLimit };
