// T8: Auto-Book lives behind a bar on the Bookings page on mobile (no bottom-nav item).
// Pure helpers, no DOM, so the routing rules are unit-testable. Back navigation itself (Auto-Book's
// parent is Bookings on mobile) lives in nav-stack.js / nav-controller.js.

/** Pending = still in the queue (not executed), across every linked gym. null = not loaded (never 0). */
export function countPendingAutoBooks(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.filter((r) => !r.executed_at).length;
}

/** Bottom-nav button that stays highlighted for a tab id (Auto-Book is reached from Bookings). */
export const BOOKINGS_NAV_GROUP = 'my-bookings auto-book';
export function bookingsNavActive(tabId) {
  return BOOKINGS_NAV_GROUP.split(' ').includes(tabId);
}
