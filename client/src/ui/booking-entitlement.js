export function countSelfBookingSlots(bookings) {
  return (Array.isArray(bookings) ? bookings : []).filter((booking) => booking && booking.isGuest !== true).length;
}

export function canSelectSelfSpot({ selectedCount, selfBookingLimit, isSelected = false }) {
  return isSelected || Number(selectedCount) < Number(selfBookingLimit);
}

export function validateSelfBookingRequest({ slotIds, currentSelfBookings = 0, selfBookingLimit }) {
  if (!Array.isArray(slotIds)) return { ok: false, code: 'INVALID_BOOKING_REQUEST' };
  const current = Math.max(0, Math.floor(Number(currentSelfBookings) || 0));
  const requested = Math.max(1, new Set(slotIds.map(String)).size);
  const limit = Number(selfBookingLimit);
  if (!Number.isFinite(limit) || limit < 0) return { ok: false, code: 'BOOKING_LIMIT_UNAVAILABLE' };
  return current + requested <= limit
    ? { ok: true, current, requested, limit }
    : { ok: false, code: 'ATTENDEE_LIMIT_EXCEEDED', current, requested, limit };
}

export function isCurrentModalRun(runId, activeRunId, modalOpen) {
  return runId === activeRunId && modalOpen === true;
}
