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
// - Uses Apple's exact UIScrollView resistance formula:
//     d = (1.0 - (1.0 / ((pull * 0.55 / dimension) + 1.0))) * dimension
// - High threshold (80px elastic displacement, ~160px finger drag) to prevent accidental triggers.
// - Hardware-accelerated GPU transform (translate3d) directly on scrollEl.
// - Silk-smooth critically damped deceleration (cubic-bezier(0.25, 1, 0.4, 1) over 440ms) matching iOS.
// - Global cancelPullToRefresh() exported so tab switches or navigation dismiss the widget immediately.
// - Horizontal swipe guard: ensures carousel / tab swipes are never intercepted.

import { isScrollBusy, isDocScroll, docScroller } from './scroll-state.js';
import { haptic } from './haptics.js';
import { COPY } from '../copy.js';

const PULL_THRESHOLD = 115; // Much higher threshold: deliberate ~245px finger drag prevents accidental triggers
const MAX_TOP_PULL = 160;   // visual cap at top
const MAX_BOTTOM_PULL = 75; // visual cap at bottom

let activeCancelFn = null;

/**
 * Immediately cancels any active pull-to-refresh or rubber banding and removes the widget from DOM.
 * Call this on tab changes or navigation to ensure zero lingering artifacts.
 */
export function cancelPullToRefresh() {
  if (typeof activeCancelFn === 'function') {
    activeCancelFn();
  }
}

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
  let wasArmed = false;
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

  // Mobile scrolls the DOCUMENT and `main` holds the sticky header/date block: any transform
  // (even translate3d(0,0,0) / will-change) on it re-bases those sticky bars and leaves a gap
  // after release. So on mobile the indicator overlays and the container is NEVER transformed.
  function moveEl(y, transition) {
    if (isDocScroll()) return;
    scrollEl.style.willChange = 'transform';
    scrollEl.style.transition = transition;
    scrollEl.style.transform = `translate3d(0, ${y}px, 0)`;
  }
  function clearEl() {
    scrollEl.style.transform = '';
    scrollEl.style.transition = '';
    scrollEl.style.willChange = '';
  }

  function createIndicator() {
    if (indicator && indicator.parentNode) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'sa-pull-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = `
      <span class="sa-pull-icon">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <polyline points="19 12 12 19 5 12"></polyline>
        </svg>
      </span>
      <div class="sa-spinner" style="display: none;"></div>
      <span class="sa-pull-text">${COPY.pullToRefresh.pull}</span>
    `;
    document.body.appendChild(indicator);
    return indicator;
  }

  function updateIndicator(elasticY, isArmed, isRefreshingState) {
    const ind = createIndicator();
    const text = ind.querySelector('.sa-pull-text');
    const spinner = ind.querySelector('.sa-spinner');
    const icon = ind.querySelector('.sa-pull-icon');

    if (isRefreshingState) {
      ind.classList.add('visible');
      ind.classList.remove('armed');
      text.textContent = COPY.pullToRefresh.refreshing;
      spinner.style.display = '';
      icon.style.display = 'none';
      ind.style.transform = 'translateX(-50%) translateY(26px) scale(1)';
      ind.style.opacity = '1';
    } else {
      spinner.style.display = 'none';
      icon.style.display = '';
      if (isArmed) {
        ind.classList.add('visible', 'armed');
        text.textContent = COPY.pullToRefresh.release;
      } else {
        ind.classList.add('visible');
        ind.classList.remove('armed');
        text.textContent = COPY.pullToRefresh.pull;
      }
      const progress = Math.min(1, Math.max(0, elasticY / PULL_THRESHOLD));
      const yOffset = Math.min(elasticY * 0.42, 28);
      ind.style.transform = `translateX(-50%) translateY(${yOffset}px) scale(${0.88 + 0.12 * progress})`;
      ind.style.opacity = `${progress}`;
    }
  }

  function hideIndicator() {
    if (!indicator) return;
    const ind = indicator;
    ind.classList.remove('visible', 'armed');
    ind.style.transition = 'all 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
    ind.style.opacity = '0';
    ind.style.transform = 'translateX(-50%) translateY(-18px) scale(0.92)';
    setTimeout(() => {
      if (ind && ind.parentNode) {
        ind.parentNode.removeChild(ind);
      }
      if (indicator === ind) indicator = null;
    }, 240);
  }

  function forceReset() {
    isRefreshing = false;
    isTopPulling = false;
    isBottomPulling = false;
    wasArmed = false;
    startY = 0;
    engagedStartY = null;
    bottomEngagedStartY = null;
    currentElasticY = 0;
    scrollEl.style.transform = '';
    scrollEl.style.transition = '';
    scrollEl.style.willChange = '';
    if (indicator && indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
    }
    indicator = null;
  }

  activeCancelFn = forceReset;

  // Apple's exact UIScrollView logarithmic resistance formula
  function calcElastic(pull, maxPull) {
    if (pull <= 0) return 0;
    const c = 0.55;
    const dimension = (typeof window !== 'undefined' ? window.innerHeight : 800) || 800;
    const d = (1.0 - (1.0 / ((pull * c / dimension) + 1.0))) * dimension;
    return Math.min(d, maxPull);
  }

  function onTouchStart(e) {
    if (isRefreshing) return;
    if (e.touches.length !== 1) return;

    if (isDocScroll()) clearEl();
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    engagedStartY = null;
    bottomEngagedStartY = null;
    isTopPulling = false;
    isBottomPulling = false;
    wasArmed = false;
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

        moveEl(currentElasticY, 'none');

        if (isEnabled()) {
          const isArmed = currentElasticY >= PULL_THRESHOLD;
          if (isArmed && !wasArmed) {
            haptic('light');
          }
          wasArmed = isArmed;
          updateIndicator(currentElasticY, isArmed, false);
        }
        return;
      }
    } else if (isTopPulling && rawDeltaY <= 0) {
      isTopPulling = false;
      wasArmed = false;
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

        moveEl(currentElasticY, 'none');
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
    wasArmed = false;

    if (isTopPulling) {
      isTopPulling = false;
      const shouldRefresh = isEnabled() && currentElasticY >= PULL_THRESHOLD;

      if (shouldRefresh) {
        isRefreshing = true;
        updateIndicator(PULL_THRESHOLD, false, true);

        // Snap to holding position (48px) with smooth deceleration
        moveEl(48, 'transform 0.3s cubic-bezier(0.25, 1, 0.4, 1)');

        try {
          await onRefresh();
          haptic('success');
        } catch (err) {
          console.error('[PullToRefresh] Refresh failed:', err);
        } finally {
          isRefreshing = false;
          currentElasticY = 0;
          // Silky smooth return to 0
          moveEl(0, 'transform 0.44s cubic-bezier(0.25, 1, 0.4, 1)');
          hideIndicator();
          setTimeout(() => {
            if (!isTopPulling && !isRefreshing && !isBottomPulling) {
              scrollEl.style.transform = '';
              scrollEl.style.transition = '';
              scrollEl.style.willChange = '';
            }
          }, 450);
        }
      } else {
        // Below threshold or released halfway: silky smooth damped return to 0 (no overshoot)
        currentElasticY = 0;
        moveEl(0, 'transform 0.44s cubic-bezier(0.25, 1, 0.4, 1)');
        hideIndicator();
        setTimeout(() => {
          if (!isTopPulling && !isRefreshing && !isBottomPulling) {
            scrollEl.style.transform = '';
            scrollEl.style.transition = '';
            scrollEl.style.willChange = '';
          }
        }, 450);
      }
      return;
    }

    if (isBottomPulling) {
      isBottomPulling = false;
      currentElasticY = 0;
      // Bottom overscroll silky smooth damped return to 0
      moveEl(0, 'transform 0.44s cubic-bezier(0.25, 1, 0.4, 1)');
      setTimeout(() => {
        if (!isTopPulling && !isRefreshing && !isBottomPulling) {
          scrollEl.style.transform = '';
          scrollEl.style.transition = '';
          scrollEl.style.willChange = '';
        }
      }, 450);
    }
  }

  scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
  scrollEl.addEventListener('touchmove', onTouchMove, { passive: false });
  scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
  scrollEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

  const onVisibilityChange = () => {
    if (document.hidden) forceReset();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('blur', forceReset);

  return () => {
    forceReset();
    scrollEl.removeEventListener('touchstart', onTouchStart);
    scrollEl.removeEventListener('touchmove', onTouchMove);
    scrollEl.removeEventListener('touchend', onTouchEnd);
    scrollEl.removeEventListener('touchcancel', onTouchEnd);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', forceReset);
    scrollTargets.forEach((t) => t.removeEventListener('scroll', onScroll));
    clearTimeout(scrollCooldownTimer);
    activeCancelFn = null;
  };
}
