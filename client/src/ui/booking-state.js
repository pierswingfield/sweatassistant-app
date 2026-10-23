// U1-15 — one place that keeps the booked/waitlisted state coherent across tabs.
//
// `cache.bookings` / `cache.waitlists` are the single source of truth the
// timetable's Book/Edit/Cancel buttons and My Bookings both read. api.js announces
// every successful mutation (book, cancel, swap, join/leave waitlist) as a
// `app-bookings-mutated` event; this module reacts, whichever tab caused it:
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
import { setCached } from '../cache.js';

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

/** Replace one gym's bookings in `existing` with `fresh` (other gyms untouched). Pure. */
export function mergeGymBookings(existing, gymId, fresh) {
  const keep = (existing || []).filter((b) => b.gymId && b.gymId !== gymId);
  return [...keep, ...(fresh || [])];
}

/** Mutations whose result only a provider re-read can show (a new/removed guest row). */
export const NEEDS_PROVIDER_REREAD = new Set(['bookGuest', 'cancel']);

// Home reads each gym through a 120s SWR entry. A mutation's provider re-read
// is newer than that entry, so write the matching gym response before asking
// Home to repaint. This avoids a second provider request and prevents the old
// Home cards from winning the refresh race.
async function refreshHomeBookingsCache(gymId, bookings) {
  if (!gymId) return;
  const fresh = (bookings || []).filter((booking) => String(booking.gymId || booking.event?.gymId || '') === String(gymId));
  await setCached(`/api/bookings?gymId=${encodeURIComponent(gymId)}`, { bookings: fresh }, 120000);
}

let refetching = null;
let pendingGyms = new Set();
async function refetchBookingState(detail = {}) {
  // Coalesce: a burst of mutations (multi-spot cancel) triggers one refetch, but a
  // mutation that lands mid-flight queues a follow-up so it is never served a stale read.
  const gymId = NEEDS_PROVIDER_REREAD.has(detail.type) ? detail.gymId : null;
  if (gymId) pendingGyms.add(gymId);
  if (refetching) return refetching;
  refetching = (async () => {
    try {
      const gyms = [...pendingGyms];
      pendingGyms = new Set();
      const [bookings, waitlists] = await Promise.all([
        gyms.length ? Promise.resolve(null) : api.getBookings(),
        api.getWaitlists(),
      ]);
      if (bookings) cache.bookings = bookings;
      else {
        let merged = cache.bookings || [];
        for (const g of gyms) merged = mergeGymBookings(merged, g, await api.getGymBookings(g, { refresh: true }));
        cache.bookings = merged;
      }
      cache.waitlists = waitlists || [];
      await refreshHomeBookingsCache(detail.gymId, cache.bookings);
      // Keep the server's booking_cache (what /api/overlap-check reads) current.
      import('./bookings.js').then((m) => m.syncBookingCache(cache.bookings)).catch(() => {});
      window.dispatchEvent(new CustomEvent('app-booking-state-changed'));
    } catch (_) {
      // Keep the optimistic state; the next prefetch will reconcile.
    } finally {
      refetching = null;
      if (pendingGyms.size) refetchBookingState();
    }
  })();
  return refetching;
}

let installed = false;
export function installBookingState(onChanged = () => {}) {
  if (installed) return;
  installed = true;
  window.addEventListener('app-bookings-mutated', (e) => {
    applyMutationToCache(e.detail || {});
    onChanged();                 // repaint now, from the state we already know
    refetchBookingState(e.detail || {}); // then reconcile with the provider
  });
  window.addEventListener('app-booking-state-changed', () => onChanged());
}
