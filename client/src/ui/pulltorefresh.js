// Reusable pull-to-refresh utility for scroll containers.
//
// setupPullToRefresh(scrollEl, onRefresh)
//   scrollEl  — the element with overflow-y: auto that the user scrolls
//   onRefresh — async function called when the user releases past the threshold.
//               The indicator stays in "refreshing" state until the promise resolves.
//   returns   — a cleanup function that removes all listeners and the indicator.
//
// Design notes:
// - Only activates when scrollTop === 0 and the user pulls DOWN.
// - Uses a resistance factor (0.5) so the pull feels elastic but deliberate.
// - preventDefault() is called ONLY during an active pull (not during normal scroll)
//   to suppress iOS rubber-banding without breaking native scroll.
// - Guards against horizontal swipes (e.g. the timetable date carousel) by checking
//   that the gesture is predominantly vertical.
// - Debounced: won't trigger another refresh while one is in progress.

import { isScrollBusy } from './scroll-state.js';

const PULL_THRESHOLD = 80; // px needed to trigger refresh
const RESISTANCE = 0.5; // pull feels like half the actual drag distance
const MAX_PULL = 120; // cap visual displacement
const INDICATOR_HEIGHT = 56; // must match .psycle-pull-indicator height in CSS

export function setupPullToRefresh(scrollEl, onRefresh, { isEnabled = () => true, getScrollTop = () => scrollEl.scrollTop, scrollTargets = [scrollEl] } = {}) {
  if (!scrollEl) return () => {};

  let startY = 0;
  let startX = 0;
  let currentDelta = 0;
  let isPulling = false;
  let isRefreshing = false;
  let indicator = null;

  // iOS momentum scroll can carry scrollTop to 0 while the finger is still moving.
  // Track recent scroll activity so we don't misfire pull-to-refresh when the user
  // was scrolling upward and momentum just hit the top.
  let wasScrolling = false;
  let scrollCooldownTimer = null;
  function onScroll() {
    wasScrolling = true;
    clearTimeout(scrollCooldownTimer);
    scrollCooldownTimer = setTimeout(() => { wasScrolling = false; }, 200);
  }
  scrollTargets.forEach((t) => t.addEventListener('scroll', onScroll, { passive: true }));

  // Create the pull indicator element (inserted above scroll content)
  function createIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'psycle-pull-indicator';
    indicator.innerHTML = `
      <div class="psycle-spinner"></div>
      <span class="psycle-pull-text">Pull to refresh</span>
    `;
    // Start fully hidden above with no layout footprint (margin-top = -height).
    // Transition is disabled here; it's re-enabled on release for snap animations.
    indicator.style.transition = 'none';
    indicator.style.marginTop = `-${INDICATOR_HEIGHT}px`;
    // Insert as first child of the scroll element so it scrolls with content
    scrollEl.insertBefore(indicator, scrollEl.firstChild);
    return indicator;
  }

  function updateIndicator(delta) {
    const ind = createIndicator();
    const text = ind.querySelector('.psycle-pull-text');
    const spinner = ind.querySelector('.psycle-spinner');

    if (isRefreshing) {
      // Re-enable CSS transition for the snap-to-visible animation
      ind.style.transition = '';
      ind.style.marginTop = '0px';
      text.textContent = 'Refreshing...';
      spinner.style.display = '';
    } else if (delta >= PULL_THRESHOLD) {
      // Past threshold — fully revealed, no transition so it follows the finger
      ind.style.transition = 'none';
      ind.style.marginTop = '0px';
      text.textContent = 'Release to refresh';
      spinner.style.display = 'none';
    } else {
      // Proportionally reveal as the user pulls: margin-top goes from
      // -INDICATOR_HEIGHT (hidden) toward 0 (fully visible) as delta → PULL_THRESHOLD.
      // No transition — must track the finger in real time.
      ind.style.transition = 'none';
      const progress = delta / PULL_THRESHOLD;
      ind.style.marginTop = `${-INDICATOR_HEIGHT + progress * INDICATOR_HEIGHT}px`;
      text.textContent = 'Pull to refresh';
      spinner.style.display = 'none';
    }
  }

  function removeIndicator() {
    if (indicator) {
      // Re-enable CSS transition so the snap-back animates smoothly
      indicator.style.transition = '';
      indicator.style.marginTop = `-${INDICATOR_HEIGHT}px`;
      // Remove after transition completes
      setTimeout(() => {
        if (indicator && indicator.parentNode) {
          indicator.parentNode.removeChild(indicator);
        }
        indicator = null;
      }, 300);
    }
  }

  function onTouchStart(e) {
    if (isRefreshing) return;
    if (!isEnabled()) { startY = 0; isPulling = false; return; }
    // Only track single-finger touches
    if (e.touches.length !== 1) return;
    // Only start pull tracking if at the top AND not still decelerating there.
    // wasScrolling stays true for 200ms after the last scroll event, which covers
    // the window where iOS momentum may have just carried scrollTop to 0.
    // Also never arm while the header is mid-transition (shared scroll clock).
    if (getScrollTop() > 0 || wasScrolling || isScrollBusy()) {
      isPulling = false;
      startY = 0; // disarm: a stale start point must not turn a later move into a pull
      return;
    }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    isPulling = false; // not pulling yet — wait for touchmove to confirm direction
  }

  function onTouchMove(e) {
    if (isRefreshing) return;
    if (startY === 0) return; // touchstart didn't register a valid start

    const deltaY = e.touches[0].clientY - startY;
    const deltaX = e.touches[0].clientX - startX;

    // Ignore predominantly horizontal gestures (e.g. date carousel swipe)
    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.5) return;

    if (deltaY > 0 && getScrollTop() <= 0) {
      // User is pulling down at the top — activate pull-to-refresh
      isPulling = true;
      currentDelta = Math.min(deltaY * RESISTANCE, MAX_PULL);
      e.preventDefault(); // suppress iOS rubber-banding only during active pull
      updateIndicator(currentDelta);
    } else if (isPulling && deltaY <= 0) {
      // User reversed direction — reset
      isPulling = false;
      currentDelta = 0;
      removeIndicator();
    }
  }

  async function onTouchEnd(e) {
    startY = 0; // gesture over: disarm
    if (!isPulling || isRefreshing) {
      isPulling = false;
      currentDelta = 0;
      if (!isRefreshing) removeIndicator();
      return;
    }

    isPulling = false;

    if (currentDelta >= PULL_THRESHOLD) {
      // Trigger refresh
      isRefreshing = true;
      updateIndicator(PULL_THRESHOLD); // show "Refreshing..." state
      try {
        await onRefresh();
      } catch (err) {
        console.error('[PullToRefresh] Refresh failed:', err);
      } finally {
        isRefreshing = false;
        currentDelta = 0;
        removeIndicator();
      }
    } else {
      // Not enough pull — snap back
      currentDelta = 0;
      removeIndicator();
    }
  }

  // Use passive: false for touchmove so we can call preventDefault()
  scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
  scrollEl.addEventListener('touchmove', onTouchMove, { passive: false });
  scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
  scrollEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

  // Cleanup function
  return () => {
    scrollEl.removeEventListener('touchstart', onTouchStart);
    scrollEl.removeEventListener('touchmove', onTouchMove);
    scrollEl.removeEventListener('touchend', onTouchEnd);
    scrollEl.removeEventListener('touchcancel', onTouchEnd);
    scrollTargets.forEach((t) => t.removeEventListener('scroll', onScroll));
    clearTimeout(scrollCooldownTimer);
    if (indicator && indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
    }
    indicator = null;
  };
}
