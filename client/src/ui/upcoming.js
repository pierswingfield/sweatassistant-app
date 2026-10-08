// H-4 / W3: pure selection logic for the Home "Upcoming classes" widget.
// No DOM, no fetching: takes grouped bookings (one group per class, as the
// Bookings page builds them) and decides which of the two display modes applies.
import { DateTime } from 'luxon';

const startOf = (group) => group?.event?.startAt || group?.event?.start_at || '';

/** One group per class occurrence per gym, mirroring bookings.js grouping. */
export function groupBookingsByEvent(bookings) {
  const groups = new Map();
  for (const b of Array.isArray(bookings) ? bookings : []) {
    const event = b?.event || null;
    if (!event || !startOf({ event })) continue;
    const gymId = String(event.gymId || b.gymId || '');
    // Provider event ids collide across gyms, so the gym is part of the key.
    const key = `${gymId}:${String(event.id || b.eventId || b.event_id)}`;
    if (!groups.has(key)) groups.set(key, { eventId: String(event.id || b.eventId || b.event_id), gymId, event, bookings: [] });
    groups.get(key).bookings.push(b);
  }
  return [...groups.values()].sort((a, b) => Date.parse(startOf(a)) - Date.parse(startOf(b)));
}

/**
 * mode 'strip': 2+ classes in the next 7 days, `days` holds 7 entries (today first).
 * mode 'card' : one class or none in 7 days; `next` is the next booked class
 *               (any date) or null when nothing is booked at all.
 * `zone` is the viewer's zone: the strip's "days" are the viewer's calendar days.
 */
export function selectUpcoming(groups, now = DateTime.now(), zone = undefined) {
  const base = (zone ? now.setZone(zone) : now).startOf('day');
  const windowEnd = base.plus({ days: 7 });
  const future = (Array.isArray(groups) ? groups : []).filter((g) => {
    const t = Date.parse(startOf(g));
    return Number.isFinite(t) && t >= now.toMillis();
  }).sort((a, b) => Date.parse(startOf(a)) - Date.parse(startOf(b)));
  const inWindow = future.filter((g) => Date.parse(startOf(g)) < windowEnd.toMillis());
  if (inWindow.length < 2) return { mode: 'card', next: future[0] || null, days: [] };
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = base.plus({ days: i });
    const key = day.toFormat('yyyy-MM-dd');
    return {
      key, label: day.toFormat('ccc d'), isToday: i === 0,
      groups: inWindow.filter((g) => DateTime.fromISO(startOf(g), { setZone: false }).setZone(base.zone).toFormat('yyyy-MM-dd') === key),
    };
  });
  return { mode: 'strip', next: inWindow[0], days };
}
