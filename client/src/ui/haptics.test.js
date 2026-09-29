import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { haptic } from './haptics.js';

describe('haptic engine', () => {
  let vibrateSpy;

  beforeEach(() => {
    vibrateSpy = vi.fn();
    Object.defineProperty(navigator, 'vibrate', {
      value: vibrateSpy,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('triggers navigator.vibrate with appropriate pattern for light haptic', () => {
    haptic('light');
    expect(vibrateSpy).toHaveBeenCalledWith([12]);
  });

  it('triggers navigator.vibrate with appropriate pattern for medium and heavy', () => {
    haptic('medium');
    expect(vibrateSpy).toHaveBeenCalledWith([24]);

    haptic('heavy');
    expect(vibrateSpy).toHaveBeenCalledWith([38]);
  });

  it('triggers navigator.vibrate with cadence for success, warning, and error', () => {
    haptic('success');
    expect(vibrateSpy).toHaveBeenCalledWith([15, 60, 22]);

    haptic('warning');
    expect(vibrateSpy).toHaveBeenCalledWith([25, 50, 25]);

    haptic('error');
    expect(vibrateSpy).toHaveBeenCalledWith([35, 45, 35, 45, 45]);
  });

  it('defaults to light pattern for unknown types', () => {
    haptic('unknown_type');
    expect(vibrateSpy).toHaveBeenCalledWith([12]);
  });

  it('does not throw when navigator.vibrate is undefined (e.g. iOS Safari)', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(() => haptic('success')).not.toThrow();
  });

  it('schedules multi-pulse switch events for success and error', () => {
    vi.useFakeTimers();
    expect(() => haptic('success')).not.toThrow();
    vi.advanceTimersByTime(100);
    expect(() => haptic('error')).not.toThrow();
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
  });
});
