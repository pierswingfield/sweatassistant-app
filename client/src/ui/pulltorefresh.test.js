import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupPullToRefresh } from './pulltorefresh.js';

function touch(scrollEl, type, y) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: 100, clientY: y };
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
});
