// T8: Auto-Book lives behind a bar on the Bookings page on mobile (no bottom-nav item).
// Pure helpers, no DOM, so the routing rules are unit-testable.

/** Pending = still in the queue (not executed), across every linked gym. null = not loaded (never 0). */
export function countPendingAutoBooks(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.filter((r) => !r.executed_at).length;
}

/**
 * What the mobile Auto-Book "Back" button does. Arriving from Bookings in-app means the previous
 * history entry IS Bookings, so pop it (browser back and this button then agree). Anything else
 * (deep link, Home tile, push click) has no Bookings entry behind it: replace the current entry
 * with /bookings so Back never leaves the app and the Auto-Book entry does not linger.
 */
export function autoBookBackAction(previousTab) {
  return previousTab === 'my-bookings' ? 'history-back' : 'replace-bookings';
}

/** Bottom-nav button that stays highlighted for a tab id (Auto-Book is reached from Bookings). */
export const BOOKINGS_NAV_GROUP = 'my-bookings auto-book';
export function bookingsNavActive(tabId) {
  return BOOKINGS_NAV_GROUP.split(' ').includes(tabId);
}
