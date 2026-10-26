// Normalized app mutation boundary shared by native HTTP and guarded MCP actions.
// No HTTP loopback and no provider protocol knowledge belongs in callers.
const db = require('./db');
const { resolveContext, withRelogin } = require('./normalized-reads');
const { getGymConfig } = require('./gyms.config');
const { countSelfBookings, validateSelfBookingLimit } = require('./booking-entitlement');
const scheduleCache = require('./schedule-cache');
const calendar = require('./calendar');
const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
function changed(userId, gymId) {
  require('./private-read-cache').invalidateGym(gymId);
  scheduleCache.invalidate(`timetable|${gymId}|`);
  try { calendar.scheduleRefresh(userId); } catch (_) {}
}
function invoke(userId, session, fn, retryAuth = true) {
  return retryAuth ? withRelogin(userId, session, fn) : fn(session);
}
async function book(userId, { eventId, slotIds = [] }, { retryAuth = true, existingCreditOnly = false } = {}) {
  if (!eventId) throw failure('EVENT_REQUIRED', 'eventId is required', 400);
  const { gymId, provider, session } = resolveContext(userId);
  // Enforce provider-published per-class limits at the authenticated route,
  // so a caller cannot bypass the spot picker or the client's request check.
  // Guests are separate reservations and do not consume this self-booking cap.
  if (getGymConfig(gymId)?.capabilities?.bookingEntitlement === true) {
    if (typeof provider.getBookingEntitlement !== 'function') {
      throw failure('BOOKING_LIMIT_UNAVAILABLE', 'Booking limits could not be confirmed.', 503);
    }
    const [bookings, entitlement] = await Promise.all([
      invoke(userId, session, (s) => provider.listBookings(s), retryAuth),
      invoke(userId, session, (s) => provider.getBookingEntitlement(eventId, s), retryAuth),
    ]);
    const currentSelfBookings = countSelfBookings(bookings, eventId);
    const requestedSelfBookings = Array.isArray(slotIds) && slotIds.length ? slotIds.length : 1;
    const check = validateSelfBookingLimit({
      currentSelfBookings,
      requestedSelfBookings,
      selfBookingLimit: entitlement && entitlement.selfBookingLimit,
    });
    if (!check.ok) {
      const message = check.code === 'ATTENDEE_LIMIT_EXCEEDED'
        ? `You can book up to ${check.limit} personal spot${check.limit === 1 ? '' : 's'} for this class.`
        : 'Booking limits could not be confirmed.';
      throw failure(check.code, message, check.code === 'ATTENDEE_LIMIT_EXCEEDED' ? 400 : 503);
    }
  }
  const result = await invoke(userId, session, (s) => provider.bookSlot(eventId, slotIds || [], s, { existingCreditOnly }), retryAuth);
  if (result && result.ok) changed(userId, gymId);
  return result;
}

async function cancelReservationGroup({ userId, gymId, provider, session, bookingId, singleOnly = false, retryAuth = true }) {
  const edges = db.getGuestBookingGroupByMember(userId, gymId, bookingId);
  let bookings;
  try {
    if (singleOnly) {
      const snapshot = await require('./normalized-reads').bookingSnapshot(userId, { retryAuth });
      if (!snapshot.complete) throw failure('CANCELLATION_STATE_UNAVAILABLE', 'A complete reservation snapshot is required.', 503);
      bookings = snapshot.bookings;
    } else bookings = await invoke(userId, session, (s) => provider.listBookings(s), retryAuth);
  } catch (_) {
    const err = new Error('Could not confirm linked guest reservations. Your booking has not been cancelled; refresh and try again.');
    err.status = 503;
    err.code = 'CANCELLATION_STATE_UNAVAILABLE';
    throw err;
  }
  const target = bookings.find((booking) => String(booking.bookingId) === String(bookingId));
  if (singleOnly && (!target || target.isGuest || edges.length || bookings.some(b => b.isGuest && String(b.eventId) === String(target.eventId)))) {
    throw failure('SINGLE_BOOKING_REQUIRED', 'This action requires one personal booking without guests.', 409);
  }
  const targetIsGuest = !!target?.isGuest || edges.some((edge) => String(edge.guest_booking_id) === String(bookingId));
  if (targetIsGuest) {
    const ok = await provider.cancelBooking(bookingId, session);
    if (ok) db.deleteGuestBookingGroupForGuest(userId, gymId, bookingId);
    return { ok, cancelledIds: ok ? [String(bookingId)] : [], primaryBookingId: null };
  }

  const eventId = target?.eventId || edges.find((edge) => String(edge.primary_booking_id) === String(bookingId))?.event_id;
  const persistedGuestIds = db.getGuestBookingIdsForPrimary(userId, gymId, bookingId);
  const liveGuestIds = eventId == null ? [] : bookings
    .filter((booking) => booking.isGuest && String(booking.eventId) === String(eventId))
    .map((booking) => String(booking.bookingId));
  const guestIds = [...new Set([...persistedGuestIds, ...liveGuestIds])];
  const cancelledIds = [];
  for (const guestId of guestIds) {
    const guestOk = await provider.cancelBooking(guestId, session);
    if (!guestOk) {
      return {
        ok: false,
        code: 'GUEST_CANCELLATION_FAILED',
        message: 'Your guest spot could not be cancelled. Your own booking is unchanged; try again or cancel the guest from Edit booking.',
        cancelledIds,
        primaryBookingId: String(bookingId),
      };
    }
    db.deleteGuestBookingGroupForGuest(userId, gymId, guestId);
    cancelledIds.push(guestId);
  }
  const ok = await provider.cancelBooking(bookingId, session);
  if (ok) db.deleteGuestBookingGroupsForPrimary(userId, gymId, bookingId);
  return {
    ok,
    code: ok ? undefined : 'PRIMARY_CANCELLATION_FAILED',
    message: ok ? undefined : 'Your guest spot was cancelled, but your own booking is unchanged. Refresh before trying again.',
    cancelledIds: ok ? [...cancelledIds, String(bookingId)] : cancelledIds,
    primaryBookingId: String(bookingId),
  };
}

async function cancel(userId, { bookingId }, { singleOnly = false, retryAuth = true } = {}) {
  if (!bookingId) throw failure('BOOKING_REQUIRED', 'bookingId is required', 400);
  const { gymId, provider, session } = resolveContext(userId);
  const result = await cancelReservationGroup({ userId, gymId, provider, session, bookingId, singleOnly, retryAuth });
  if (result.ok) {
    try { db.stopAutoUpgradesForBooking(userId, gymId, bookingId); } catch (_) {}
    changed(userId, gymId);
  }
  return result;
}
async function swap(userId, { bookingId, currentSlotId, targetSlotId }, { atomicOnly = false, retryAuth = true } = {}) {
  if (!bookingId || !targetSlotId) throw failure('SPOT_REQUIRED', 'bookingId and targetSlotId are required', 400);
  const { gymId, provider, session } = resolveContext(userId);
  if (atomicOnly && !getGymConfig(gymId)?.capabilities?.atomicSwap) throw failure('ATOMIC_SWAP_UNAVAILABLE', 'In-place spot changes are not supported.', 409);
  const result = await invoke(userId, session, s => provider.swapSpots(bookingId, currentSlotId, targetSlotId, s, { allowCancelRebook: !atomicOnly }), retryAuth);
  if (result && result.ok) changed(userId, gymId);
  return result;
}
// Bounded preflight for one immediate personal action. The caller displays
// these exact fields for first-party approval and compares them before execution.
async function describeAction(userId, operation, input) {
  const reads = require('./normalized-reads');
  const { gymId, provider, session } = resolveContext(userId);
  const snapshot = await reads.bookingSnapshot(userId);
  if (!snapshot.complete) throw failure('ACTION_UNAVAILABLE', 'Complete reservation state could not be confirmed.', 409);
  const { bookings } = snapshot;
  if (!Array.isArray(bookings) || bookings.length > 100) throw failure('ACTION_UNAVAILABLE', 'Booking state cannot be bounded.', 409);
  const target = operation === 'book' ? null : bookings.find(b => String(b.bookingId) === input.bookingId && !b.isGuest && !b.isWaitlist);
  if (operation !== 'book' && !target) throw failure('ACTION_CHANGED', 'The personal booking is no longer available.', 409);
  const eventId = operation === 'book' ? input.eventId : String(target.eventId);
  if (bookings.some(b => b.isGuest && String(b.eventId) === eventId) ||
      target && db.getGuestBookingGroupByMember(userId, gymId, target.bookingId).length) {
    throw failure('SINGLE_BOOKING_REQUIRED', 'Guest reservation changes require the app.', 409);
  }
  const details = await reads.eventDetails(userId, eventId);
  const event = details?.event;
  if (!event || String(event.id) !== eventId || !Number.isFinite(Date.parse(event.startAt)) || Date.parse(event.startAt) <= Date.now()) {
    throw failure('ACTION_UNAVAILABLE', 'Only a confirmed future class can be changed.', 409);
  }
  const clean = v => String(v || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 150);
  const summary = { operation, gymId, eventId, className: clean(event.name), startAt: event.startAt, timeZone: clean(event.timeZone),
    bookingId: target ? String(target.bookingId) : null, currentSlotId: target?.slotId == null ? null : String(target.slotId),
    targetSlotId: input.slotId || null, targetSlotLabel: null, creditCost: null, cancellationPenalty: null,
    existingBookingIds: bookings.filter(b => !b.isGuest && String(b.eventId) === eventId).map(b => String(b.bookingId)).sort() };
  if (operation === 'book' || operation === 'edit') {
    if (operation === 'edit' && (!getGymConfig(gymId)?.capabilities?.atomicSwap || input.currentSlotId !== summary.currentSlotId)) {
      throw failure('ACTION_CHANGED', 'The current spot changed or an in-place edit is unavailable.', 409);
    }
    const slots = details.slots || [];
    const slot = input.slotId && slots.find(s => String(s.id) === input.slotId);
    if (input.slotId ? !slot || slot.isAvailable !== true : slots.length || event.isFull === true) {
      throw failure('ACTION_UNAVAILABLE', 'The requested personal spot is unavailable.', 409);
    }
    summary.targetSlotLabel = slot ? clean(slot.label) : null;
    if (operation === 'book' && getGymConfig(gymId)?.capabilities?.metered !== false) {
      if (!Number.isFinite(event.credits?.required) || event.credits.required < 0) throw failure('ACTION_UNAVAILABLE', 'Class credit cost is unknown.', 409);
      summary.creditCost = event.credits.required;
    }
  }
  if (operation === 'cancel') {
    const penalty = await withRelogin(userId, session, s => provider.getCancelPenalty(input.bookingId, s));
    if (!['none', 'credit'].includes(penalty?.penalty)) throw failure('ACTION_UNAVAILABLE', 'Unknown or monetary cancellation penalties require the app.', 409);
    summary.cancellationPenalty = penalty.penalty;
  }
  return summary;
}
module.exports = { book, cancel, swap, cancelReservationGroup, describeAction };
