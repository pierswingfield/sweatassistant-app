// Pure tab-routing rules for the app shell (testable without the DOM).
// Home is the FIRST tab and the default landing tab (F-10-1).

export const DEFAULT_TAB = 'home';
export const VALID_TABS = ['home', 'class-timetable', 'my-bookings', 'auto-book', 'buy-credits', 'settings'];

/**
 * Pick the tab to show at boot from the URL hash. A valid hash (deep link, push
 * click, page refresh, onboarding return path) always wins; anything else, i.e. a
 * fresh session, lands on Home. `about` is a legacy alias for Settings.
 */
export function resolveInitialTab(hash, validTabs = VALID_TABS) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === 'about') return 'settings';
  return validTabs.includes(h) ? h : DEFAULT_TAB;
}

/** Tab to fall back to when a requested tab is not allowed (e.g. Credits gate). */
export const FALLBACK_TAB = 'class-timetable';
