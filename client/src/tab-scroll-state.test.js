import { describe, expect, it } from 'vitest';
import { syncTabScrollState } from './tab-scroll-state.js';

describe('tab scroll-layout state', () => {
  it('owns Home and Timetable scroll geometry on the shared scroller', () => {
    const scroller = document.createElement('main');

    const settings = document.createElement('div'); settings.className = 'app-settings-content'; settings.style.transform = 'translateX(100px)'; scroller.appendChild(settings);
    syncTabScrollState(scroller, 'settings');
    expect(scroller.classList.contains('app-settings-active')).toBe(true);
    syncTabScrollState(scroller, 'home');
    expect(scroller.classList.contains('app-settings-active')).toBe(false);
    expect(settings.style.transform).toBe('');
    expect(scroller.classList.contains('app-home-active')).toBe(true);
    expect(scroller.classList.contains('app-timetable-active')).toBe(false);

    syncTabScrollState(scroller, 'class-timetable');
    expect(scroller.classList.contains('app-home-active')).toBe(false);
    expect(scroller.classList.contains('app-timetable-active')).toBe(true);

    syncTabScrollState(scroller, 'my-bookings');
    expect(scroller.classList.contains('app-home-active')).toBe(false);
    expect(scroller.classList.contains('app-timetable-active')).toBe(false);
  });
});
