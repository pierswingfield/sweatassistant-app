// Shared scroll coordination between the header auto-hide (main.js) and pull-to-refresh.
// Both react to the same scroller, so they share one "settling" clock: while the header is
// mid-transition (or just toggled), pull-to-refresh must not arm and the header must not
// re-toggle on the momentum/bounce samples that the transition itself can produce.
let busyUntil = 0;
export function markScrollBusy(ms = 300) { busyUntil = Math.max(busyUntil, performance.now() + ms); }
export function isScrollBusy() { return performance.now() < busyUntil; }

// App content always scrolls inside `main.app-body`, keeping fixed navigation
// outside the momentum scroller on both mobile and desktop.
