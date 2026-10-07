// Shared scroll coordination between the header auto-hide (main.js) and pull-to-refresh.
// Both react to the same scroller, so they share one "settling" clock: while the header is
// mid-transition (or just toggled), pull-to-refresh must not arm and the header must not
// re-toggle on the momentum/bounce samples that the transition itself can produce.
let busyUntil = 0;
export function markScrollBusy(ms = 300) { busyUntil = Math.max(busyUntil, performance.now() + ms); }
export function isScrollBusy() { return performance.now() < busyUntil; }

// Mobile (<= 768px) scrolls the DOCUMENT (so Safari's URL/toolbar can collapse); desktop keeps the inner
// `main.app-body` scroller. Everything that reads scroll position goes through these two helpers.
export const isDocScroll = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
export function docScroller() { return document.scrollingElement || document.documentElement; }
