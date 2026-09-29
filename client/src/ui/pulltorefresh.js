// Reusable iOS-style rubber banding & pull-to-refresh engine for scroll containers.
//
// setupPullToRefresh(scrollEl, onRefresh, options)
//   scrollEl     — the element (or container) that translates elastically
//   onRefresh    — async function called when user pulls down past threshold and releases.
//   options:
//     isEnabled    — () => boolean: returns false to disable refresh while still allowing rubber banding
//     getScrollTop — () => number: current scroll top
//     getMaxScroll — () => number: current maximum scrollable top
//     scrollTargets— array of elements emitting scroll events
//
// Design & Physics:
// - Uses Apple logarithmic decay curve: f(y) = Math.pow(rawY, 0.82) * 1.85 capped at max displacement.
// - Hardware-accelerated GPU transform (translate3d) directly on scrollEl.
// - At top: pulling down applies elastic stretch. If pull >= threshold (54px elastic), arms refresh.
//   Releasing below threshold springs back with natural iOS bounce (cubic-bezier(0.175, 0.885, 0.32, 1.275)).
//   Releasing above threshold snaps to 48px, runs onRefresh(), and smoothly springs back to 0.
// - At bottom: pulling up past bottom boundary applies negative elastic stretch, springing back on release.
// - Horizontal swipe guard: ensures carousel / tab swipes are never intercepted.

import { isScrollBusy, isDocScroll, docScroller } from './scroll-state.js';

const PULL_THRESHOLD = 54; // px of elastic displacement needed to trigger refresh (~70-80px finger pull)
const MAX_TOP_PULL = 110;  // max visual displacement at top
const MAX_BOTTOM_PULL = 75; // max visual displacement at bottom

export function setupPullToRefresh(scrollEl, onRefresh, {
  isEnabled = () => true,
  getScrollTop = () => (isDocScroll() ? docScroller().scrollTop : scrollEl.scrollTop),
  getMaxScroll = () => {
    if (isDocScroll()) {
      const ds = docScroller();
      return Math.max(0, ds.scrollHeight - window.innerHeight);
    }
    return Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  },
  scrollTargets = [scrollEl, window],
} = {}) {
  if (!scrollEl) return () => {};

  let startY = 0;
  let startX = 0;
  let engagedStartY = null;
  let bottomEngagedStartY = null;
  let currentElasticY = 0;
  let isTopPulling = false;
  let isBottomPulling = false;
  let isRefreshing = false;
  let indicator = null;

  // Track recent scroll activity to avoid misfiring when momentum hits top or bottom
  let wasScrolling = false;
  let scrollCooldownTimer = null;
  function onScroll() {
    wasScrolling = true;
    clearTimeout(scrollCooldownTimer);
    scrollCooldownTimer = setTimeout(() => { wasScrolling = false; }, 180);
  }
  scrollTargets.forEach((t) => t.addEventListener('scroll', onScroll, { passive: true }));

  function createIndicator() {
    if (indicator && indicator.parentNode) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'psycle-pull-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = `
      <span class="psycle-pull-icon">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <polyline points="19 12 12 19 5 12"></polyline>
        </svg>
      </span>
      <div class="psycle-spinner" style="display: none;"></div>
      <span class="psycle-pull-text">Pull to refresh</span>
    `;
    document.body.appendChild(indicator);
    return indicator;
  }

  function updateIndicator(elasticY, isArmed, isRefreshingState) {
    const ind = createIndicator();
    const text = ind.querySelector('.psycle-pull-text');
    const spinner = ind.querySelector('.psycle-spinner');
    const icon = ind.querySelector('.psycle-pull-icon');

    if (isRefreshingState) {
      ind.classList.add('visible');
      ind.classList.remove('armed');
      text.textContent = 'Refreshing...';
      spinner.style.display = '';
      icon.style.display = 'none';
      ind.style.transform = 'translateX(-50%) translateY(26px) scale(1)';
      ind.style.opacity = '1';
    } else {
      spinner.style.display = 'none';
      icon.style.display = '';
      if (isArmed) {
        ind.classList.add('visible', 'armed');
        text.textContent = 'Release to refresh';
      } else {
        ind.classList.add('visible');
        ind.classList.remove('armed');
        text.textContent = 'Pull to refresh';
      }
      const progress = Math.min(1, Math.max(0, elasticY / PULL_THRESHOLD));
      const yOffset = Math.min(elasticY * 0.44, 26);
      ind.style.transform = `translateX(-50%) translateY(${yOffset}px) scale(${0.88 + 0.12 * progress})`;
      ind.style.opacity = `${progress}`;
    }
  }

  function hideIndicator() {
    if (!indicator) return;
    indicator.classList.remove('visible', 'armed');
    indicator.style.transition = 'all 0.24s cubic-bezier(0.16, 1, 0.3, 1)';
    indicator.style.opacity = '0';
    indicator.style.transform = 'translateX(-50%) translateY(-18px) scale(0.92)';
    setTimeout(() => {
      if (indicator && !isRefreshing && !isTopPulling) {
        if (indicator.parentNode) indicator.parentNode.removeChild(indicator);
        indicator = null;
      }
    }, 250);
  }

  function calcElastic(pull, maxPull) {
    if (pull <= 0) return 0;
    // Apple logarithmic resistance curve
    const d = Math.pow(pull, 0.82) * 1.85;
    return Math.min(d, maxPull);
  }

  function onTouchStart(e) {
    if (isRefreshing) return;
    if (e.touches.length !== 1) return;

    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    engagedStartY = null;
    bottomEngagedStartY = null;
    isTopPulling = false;
    isBottomPulling = false;
    currentElasticY = 0;

    const st = getScrollTop();
    const maxScroll = getMaxScroll();
    if (st <= 0 && !wasScrolling && !isScrollBusy()) {
      engagedStartY = startY;
    } else if (st >= maxScroll - 3 && !wasScrolling) {
      bottomEngagedStartY = startY;
    }
  }

  function onTouchMove(e) {
    if (isRefreshing) return;
    if (startY === 0) return;

    const clientY = e.touches[0].clientY;
    const clientX = e.touches[0].clientX;
    const rawDeltaY = clientY - startY;
    const deltaX = clientX - startX;

    // Ignore horizontal swipes (e.g. date carousel, filter scrolls)
    if (Math.abs(deltaX) > Math.abs(rawDeltaY) * 1.35) return;

    const st = getScrollTop();
    const maxScroll = getMaxScroll();

    // --- TOP RUBBER BANDING / PULL TO REFRESH ---
    if (st <= 0 && rawDeltaY > 0) {
      if (engagedStartY === null) {
        engagedStartY = clientY;
      }
      const pull = Math.max(0, clientY - engagedStartY);
      if (pull > 0) {
        isTopPulling = true;
        currentElasticY = calcElastic(pull, MAX_TOP_PULL);
        e.preventDefault();

        scrollEl.style.willChange = 'transform';
        scrollEl.style.transition = 'none';
        scrollEl.style.transform = `translate3d(0, ${currentElasticY}px, 0)`;

        if (isEnabled()) {
          const isArmed = currentElasticY >= PULL_THRESHOLD;
          updateIndicator(currentElasticY, isArmed, false);
        }
        return;
      }
    } else if (isTopPulling && rawDeltaY <= 0) {
      isTopPulling = false;
      currentElasticY = 0;
      scrollEl.style.transform = '';
      hideIndicator();
    }

    // --- BOTTOM RUBBER BANDING ---
    if (st >= maxScroll - 3 && rawDeltaY < 0) {
      if (bottomEngagedStartY === null) {
        bottomEngagedStartY = clientY;
      }
      const pull = Math.max(0, bottomEngagedStartY - clientY);
      if (pull > 0) {
        isBottomPulling = true;
        currentElasticY = -calcElastic(pull, MAX_BOTTOM_PULL);
        e.preventDefault();

        scrollEl.style.willChange = 'transform';
        scrollEl.style.transition = 'none';
        scrollEl.style.transform = `translate3d(0, ${currentElasticY}px, 0)`;
        return;
      }
    } else if (isBottomPulling && rawDeltaY >= 0) {
      isBottomPulling = false;
      currentElasticY = 0;
      scrollEl.style.transform = '';
    }
  }

  async function onTouchEnd() {
    startY = 0;
    engagedStartY = null;
    bottomEngagedStartY = null;

    if (isTopPulling) {
      isTopPulling = false;
      const shouldRefresh = isEnabled() && currentElasticY >= PULL_THRESHOLD;

      if (shouldRefresh) {
        isRefreshing = true;
        updateIndicator(PULL_THRESHOLD, false, true);

        // Snap to holding position (48px)
        scrollEl.style.transition = 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1)';
        scrollEl.style.transform = 'translate3d(0, 48px, 0)';

        try {
          await onRefresh();
        } catch (err) {
          console.error('[PullToRefresh] Refresh failed:', err);
        } finally {
          isRefreshing = false;
          currentElasticY = 0;
          // Spring back to 0
          scrollEl.style.transition = 'transform 0.34s cubic-bezier(0.25, 1, 0.5, 1)';
          scrollEl.style.transform = 'translate3d(0, 0, 0)';
          hideIndicator();
          setTimeout(() => {
            if (!isTopPulling && !isRefreshing && !isBottomPulling) {
              scrollEl.style.transform = '';
              scrollEl.style.transition = '';
              scrollEl.style.willChange = '';
            }
          }, 360);
        }
      } else {
        // Below threshold: snap back with iOS spring bounce
        currentElasticY = 0;
        scrollEl.style.transition = 'transform 0.38s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        scrollEl.style.transform = 'translate3d(0, 0, 0)';
        hideIndicator();
        setTimeout(() => {
          if (!isTopPulling && !isRefreshing && !isBottomPulling) {
            scrollEl.style.transform = '';
            scrollEl.style.transition = '';
            scrollEl.style.willChange = '';
          }
        }, 390);
      }
      return;
    }

    if (isBottomPulling) {
      isBottomPulling = false;
      currentElasticY = 0;
      // Bottom overscroll spring bounce back
      scrollEl.style.transition = 'transform 0.38s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      scrollEl.style.transform = 'translate3d(0, 0, 0)';
      setTimeout(() => {
        if (!isTopPulling && !isRefreshing && !isBottomPulling) {
          scrollEl.style.transform = '';
          scrollEl.style.transition = '';
          scrollEl.style.willChange = '';
        }
      }, 390);
    }
  }

  scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
  scrollEl.addEventListener('touchmove', onTouchMove, { passive: false });
  scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
  scrollEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

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
    scrollEl.style.transform = '';
    scrollEl.style.transition = '';
    scrollEl.style.willChange = '';
  };
}
