// U1-15 — one place that keeps the booked/waitlisted state coherent across tabs.
//
// `cache.bookings` / `cache.waitlists` are the single source of truth the
// timetable's Book/Edit/Cancel buttons and My Bookings both read. api.js announces
// every successful mutation (book, cancel, swap, join/leave waitlist) as a
// `psycle-bookings-mutated` event; this module reacts, whichever tab caused it:
//
//   1. apply what the mutation already tells us, synchronously (a cancelled
//      booking simply stops being booked), so the very next paint is right;
//   2. refetch bookings + waitlists in the background to pick up anything the
//      response did not carry (a new booking's id and spot), then repaint.
//
// Step 1 is the fix for "cancelled in My Bookings, timetable still says booked
// for several seconds": before it, the state only became true when a refetch
// landed, and a live provider takes seconds to answer.

import { cache } from '../main';
import { api } from '../api';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const bookingIdOf = (b) => b?.bookingId ?? b?.id;
const eventIdOf = (b) => b?.eventId ?? b?.event_id ?? b?.event?.id;

/** Synchronously drop a cancelled booking from the shared cache. */
export function dropBookingFromCache(bookingId) {
  if (bookingId == null || !Array.isArray(cache.bookings)) return;
  cache.bookings = cache.bookings.filter((b) => !sameId(bookingIdOf(b), bookingId));
}

/** Synchronously drop a waitlist entry for `eventId` (in `gymId`, when known). */
export function dropWaitlistFromCache(eventId, gymId = null) {
  if (eventId == null || !Array.isArray(cache.waitlists)) return;
  cache.waitlists = cache.waitlists.filter((w) => !(
    sameId(eventIdOf(w), eventId) && (!gymId || !w.gymId || w.gymId === gymId)
  ));
}

/** Apply a mutation's known effect to the shared cache. Pure w.r.t. the network. */
export function applyMutationToCache(detail = {}) {
  if (detail.type === 'cancel') dropBookingFromCache(detail.bookingId);
  else if (detail.type === 'leaveWaitlist') dropWaitlistFromCache(detail.eventId, detail.gymId);
}

let refetching = null;
async function refetchBookingState() {
  // Coalesce: a burst of mutations (multi-spot cancel) triggers one refetch.
  if (refetching) return refetching;
  refetching = (async () => {
    try {
      const [bookings, waitlists] = await Promise.all([api.getBookings(), api.getWaitlists()]);
      cache.bookings = bookings || [];
      cache.waitlists = waitlists || [];
      // Keep the server's booking_cache (what /api/overlap-check reads) current.
      import('./bookings.js').then((m) => m.syncBookingCache(cache.bookings)).catch(() => {});
      window.dispatchEvent(new CustomEvent('psycle-booking-state-changed'));
    } catch (_) {
      // Keep the optimistic state; the next prefetch will reconcile.
    } finally {
      refetching = null;
    }
  })();
  return refetching;
}

let installed = false;
export function installBookingState(onChanged = () => {}) {
  if (installed) return;
  installed = true;
  window.addEventListener('psycle-bookings-mutated', (e) => {
    applyMutationToCache(e.detail || {});
    onChanged();                 // repaint now, from the state we already know
    refetchBookingState();       // then reconcile with the provider
  });
  window.addEventListener('psycle-booking-state-changed', () => onChanged());
}
