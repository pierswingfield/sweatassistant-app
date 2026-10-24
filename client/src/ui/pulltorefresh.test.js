import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupPullToRefresh, cancelPullToRefresh } from './pulltorefresh.js';

function touch(scrollEl, type, y, x = 100) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  scrollEl.dispatchEvent(event);
  return event;
}

describe('pull-to-refresh on the mobile app scrollport', () => {
  let cleanup;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.querySelectorAll('.app-pull-indicator').forEach((el) => el.remove());
  });

  it('keeps native top bounce while still detecting a deliberate refresh pull', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const scrollEl = document.createElement('main');
    document.body.appendChild(scrollEl);
    const refresh = vi.fn().mockResolvedValue(undefined);
    cleanup = setupPullToRefresh(scrollEl, refresh, {
      getScrollTop: () => 0,
      getMaxScroll: () => 1000,
      scrollTargets: [scrollEl],
    });

    touch(scrollEl, 'touchstart', 100);
    const move = touch(scrollEl, 'touchmove', 400);
    expect(move.defaultPrevented).toBe(false);
    expect(scrollEl.style.transform).toBe('');
    touch(scrollEl, 'touchend', 400);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps native bottom bounce without preventing the edge gesture', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const scrollEl = document.createElement('main');
    document.body.appendChild(scrollEl);
    cleanup = setupPullToRefresh(scrollEl, vi.fn(), {
      getScrollTop: () => 1000,
      getMaxScroll: () => 1000,
      scrollTargets: [scrollEl],
    });

    touch(scrollEl, 'touchstart', 400);
    const move = touch(scrollEl, 'touchmove', 100);
    expect(move.defaultPrevented).toBe(false);
    expect(scrollEl.style.transform).toBe('');
  });

  it('does not arm pull-to-refresh for a horizontal date or filter drag', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const scrollEl = document.createElement('main');
    document.body.appendChild(scrollEl);
    cleanup = setupPullToRefresh(scrollEl, vi.fn(), {
      getScrollTop: () => 0,
      getMaxScroll: () => 1000,
      scrollTargets: [scrollEl],
    });
    touch(scrollEl, 'touchstart', 100, 100);
    const move = touch(scrollEl, 'touchmove', 104, 350);
    expect(move.defaultPrevented).toBe(false);
    expect(document.querySelector('.app-pull-indicator')).toBeNull();
    touch(scrollEl, 'touchend', 104, 350);
  });

  it('cancels pending pull state on every registered scroll surface', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const bodyScroller = document.createElement('main');
    const timetableScroller = document.createElement('div');
    document.body.append(bodyScroller, timetableScroller);
    cleanup = setupPullToRefresh(bodyScroller, vi.fn(), {
      isEnabled: () => true, getScrollTop: () => 0, getMaxScroll: () => 500, scrollTargets: [bodyScroller],
    });
    const cleanTimetable = setupPullToRefresh(timetableScroller, vi.fn(), {
      isEnabled: () => true, getScrollTop: () => 0, getMaxScroll: () => 500, scrollTargets: [timetableScroller],
    });
    const start = (el, type, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const point = { clientX: 100, clientY: y };
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
      Object.defineProperty(event, 'changedTouches', { value: [point] });
      el.dispatchEvent(event);
    };
    start(bodyScroller, 'touchstart', 100); start(bodyScroller, 'touchmove', 300);
    start(timetableScroller, 'touchstart', 100); start(timetableScroller, 'touchmove', 300);
    expect(document.querySelectorAll('.app-pull-indicator')).toHaveLength(2);

    cancelPullToRefresh();
    expect(document.querySelectorAll('.app-pull-indicator')).toHaveLength(0);
    cleanTimetable();
  });
});

// Landscape phones (769-1100px) take the synthetic path; the touch's real scroller may be another element.
describe('pull-to-refresh touch ownership (synthetic path)', () => {
  let cleanup;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = '';
  });

  it('does not preventDefault when the touch belongs to a different scroller', () => {
    window.matchMedia = vi.fn(() => ({ matches: false }));
    const outer = document.createElement('main');
    const inner = document.createElement('section');
    const child = document.createElement('div');
    inner.appendChild(child);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    inner.style.overflowY = 'auto';
    Object.defineProperty(inner, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(inner, 'clientHeight', { value: 300, configurable: true });
    cleanup = setupPullToRefresh(outer, vi.fn(), { scrollTargets: [outer] });

    touch(child, 'touchstart', 100);
    const move = touch(child, 'touchmove', 160);
    expect(move.defaultPrevented).toBe(false);
  });

  it('still engages the synthetic pull when the touch is in scrollEl at the top', () => {
    window.matchMedia = vi.fn(() => ({ matches: false }));
    const outer = document.createElement('main');
    const child = document.createElement('div');
    outer.appendChild(child);
    document.body.appendChild(outer);
    cleanup = setupPullToRefresh(outer, vi.fn(), { scrollTargets: [outer] });

    touch(child, 'touchstart', 100);
    const move = touch(child, 'touchmove', 200);
    expect(move.defaultPrevented).toBe(true);
    expect(document.querySelector('.app-pull-indicator')).not.toBeNull();
  });
});
