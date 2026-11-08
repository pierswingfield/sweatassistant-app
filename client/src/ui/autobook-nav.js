// T8: Auto-Book lives behind a bar on the Bookings page on mobile (no bottom-nav item).
// Pure helpers, no DOM, so the routing rules are unit-testable.

/** Pending = still in the queue (not executed), across every linked gym. null = not loaded (never 0). */
export function countPendingAutoBooks(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.filter((r) => !r.executed_at).length;
}

/**
 * What the mobile Auto-Book "Back" button does. Arriving from any in-app tab (Bookings, Home,
 * Timetable, ...) means the previous history entry IS that tab, so pop it: Back returns to where
 * the member came from and agrees with browser back. With no in-app tab behind it (deep link,
 * push click, first paint) there is no entry to pop: replace the current one with /bookings so
 * Back never leaves the app and the Auto-Book entry does not linger.
 */
export function autoBookBackAction(previousTab) {
  return typeof previousTab === 'string' && previousTab && previousTab !== 'auto-book' ? 'history-back' : 'replace-bookings';
}

/** Bottom-nav button that stays highlighted for a tab id (Auto-Book is reached from Bookings). */
export const BOOKINGS_NAV_GROUP = 'my-bookings auto-book';
export function bookingsNavActive(tabId) {
  return BOOKINGS_NAV_GROUP.split(' ').includes(tabId);
}

/** The tab Back may pop to: only when a 'push' switch into Auto-Book came from another in-app tab. */
export function autoBookBackTarget(historyMode, tabId, prevTabId) {
  return historyMode === 'push' && tabId === 'auto-book' && prevTabId && prevTabId !== 'auto-book' ? prevTabId : null;
}
