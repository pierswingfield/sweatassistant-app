// My Bookings view mode: "combined" (one chronological list of booked AND
// waitlisted classes) or "separate" (booked and waitlisted in their own
// sections). Person-level preference: the settings key is account-scoped
// (server/db.js ACCOUNT_SCOPED_SETTING_KEYS), so it is the same on every gym.

export const BOOKINGS_VIEW_KEY = 'bookingsView';
export const BOOKINGS_VIEWS = Object.freeze(['combined', 'separate']);
export const DEFAULT_BOOKINGS_VIEW = 'combined';

/** Any unknown/absent value (settings not loaded yet, junk) reads as the default. */
export function normalizeBookingsView(value) {
  return BOOKINGS_VIEWS.includes(value) ? value : DEFAULT_BOOKINGS_VIEW;
}

function startMs(event) {
  const t = Date.parse(event?.startAt || event?.start_at || '');
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Merge booking groups (from groupBookingsByEvent) and raw waitlist entries
 * into one chronological timeline:
 *   [{ kind: 'booking', group, startMs } | { kind: 'waitlist', waitlist, startMs }]
 * Waitlists without a usable start time are dropped (the separate view drops
 * them too). On an exact tie a booking sorts before a waitlist; otherwise the
 * input order is kept (stable sort).
 */
export function mergeBookingsTimeline(groups, waitlists) {
  const items = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const ms = startMs(group?.event);
    if (Number.isFinite(ms)) items.push({ kind: 'booking', group, startMs: ms });
  }
  for (const waitlist of Array.isArray(waitlists) ? waitlists : []) {
    const ms = startMs(waitlist?.event);
    if (Number.isFinite(ms)) items.push({ kind: 'waitlist', waitlist, startMs: ms });
  }
  const rank = (k) => (k === 'booking' ? 0 : 1);
  return items.sort((a, b) => (a.startMs - b.startMs) || (rank(a.kind) - rank(b.kind)));
}
