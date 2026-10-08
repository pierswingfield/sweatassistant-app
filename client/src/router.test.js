// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { commitFilterChange, commitNow, replaceCurrent, safeReturnTo, stashReturnTo, takeReturnTo, BURST_MS, _resetRouterForTest } from './router.js';

beforeEach(() => { vi.useFakeTimers(); _resetRouterForTest(); history.replaceState(null, '', '/timetable'); });
afterEach(() => { vi.useRealTimers(); });

describe('commitFilterChange', () => {
  it('a burst of chip toggles leaves ONE new history entry', () => {
    const start = history.length;
    commitFilterChange('/timetable?gym=a');
    commitFilterChange('/timetable?gym=a&loc=a%3A1');
    commitFilterChange('/timetable?gym=a&loc=a%3A1&fav=1');
    expect(history.length).toBe(start + 1);
    expect(location.search).toBe('?gym=a&loc=a%3A1&fav=1');
  });
  it('a change after the quiet window is a new entry', () => {
    const start = history.length;
    commitFilterChange('/timetable?gym=a');
    vi.advanceTimersByTime(BURST_MS + 10);
    commitFilterChange('/timetable?gym=b');
    expect(history.length).toBe(start + 2);
  });
  it('same URL is a no-op', () => {
    const start = history.length;
    expect(commitFilterChange('/timetable')).toBe(false);
    expect(history.length).toBe(start);
  });
  it('commitNow always pushes and closes a burst', () => {
    const start = history.length;
    commitFilterChange('/timetable?gym=a');
    commitNow('/timetable?gym=a&day=2026-10-07');
    commitFilterChange('/timetable?gym=b&day=2026-10-07');
    expect(history.length).toBe(start + 3);
  });
  it('replaceCurrent never adds an entry (set-from-URL)', () => {
    const start = history.length;
    replaceCurrent('/timetable?gym=z');
    expect(history.length).toBe(start);
    expect(location.search).toBe('?gym=z');
  });
});

describe('safeReturnTo', () => {
  it.each(['/bookings', '/timetable?day=2026-10-07&gym=jab', '/settings/about'])('accepts %s', (p) => expect(safeReturnTo(p)).toBe(p));
  it.each([
    '//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', null, undefined, 42,
    '/%2F/evil.com', '/%5Cevil.com', '\\\\evil.com', '/api/auth/status', '/admin', 'bookings', '/ok\nx', ' //x',
  ])('rejects %j', (p) => expect(safeReturnTo(p)).toBeNull());
  it('stash/take round-trips and clears', () => {
    sessionStorage.clear();
    expect(stashReturnTo('/bookings')).toBe('/bookings');
    expect(takeReturnTo()).toBe('/bookings');
    expect(takeReturnTo()).toBeNull();
  });
  it('does not stash unsafe or root', () => {
    sessionStorage.clear();
    stashReturnTo('//evil.com'); stashReturnTo('/');
    expect(takeReturnTo()).toBeNull();
  });
  it('a tampered stored value is re-validated on read', () => {
    sessionStorage.setItem('appReturnTo', '//evil.com');
    expect(takeReturnTo()).toBeNull();
  });
});
