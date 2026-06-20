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

const PULL_THRESHOLD = 80; // px needed to trigger refresh
const RESISTANCE = 0.5; // pull feels like half the actual drag distance
const MAX_PULL = 120; // cap visual displacement

export function setupPullToRefresh(scrollEl, onRefresh) {
  if (!scrollEl) return () => {};

  let startY = 0;
  let startX = 0;
  let currentDelta = 0;
  let isPulling = false;
  let isRefreshing = false;
  let indicator = null;

  // Create the pull indicator element (inserted above scroll content)
  function createIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'psycle-pull-indicator';
    indicator.innerHTML = `
      <div class="psycle-spinner"></div>
      <span class="psycle-pull-text">Pull to refresh</span>
    `;
    indicator.style.transform = 'translateY(-100%)';
    // Insert as first child of the scroll element so it scrolls with content
    scrollEl.insertBefore(indicator, scrollEl.firstChild);
    return indicator;
  }

  function updateIndicator(delta) {
    const ind = createIndicator();
    const text = ind.querySelector('.psycle-pull-text');
    const spinner = ind.querySelector('.psycle-spinner');

    if (isRefreshing) {
      ind.style.transform = `translateY(0)`;
      text.textContent = 'Refreshing...';
      spinner.style.display = '';
    } else if (delta >= PULL_THRESHOLD) {
      ind.style.transform = `translateY(0)`;
      text.textContent = 'Release to refresh';
      spinner.style.display = 'none';
    } else {
      // Move indicator down proportionally (peeks out from top)
      const progress = delta / PULL_THRESHOLD;
      ind.style.transform = `translateY(${-100 + progress * 100}%)`;
      text.textContent = 'Pull to refresh';
      spinner.style.display = 'none';
    }
  }

  function removeIndicator() {
    if (indicator) {
      indicator.style.transform = 'translateY(-100%)';
      // Remove after transition
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
    // Only track single-finger touches
    if (e.touches.length !== 1) return;
    // Only start pull tracking if at the top of the scroll container
    if (scrollEl.scrollTop > 0) {
      isPulling = false;
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

    if (deltaY > 0 && scrollEl.scrollTop <= 0) {
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
    if (indicator && indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
    }
    indicator = null;
  };
}
