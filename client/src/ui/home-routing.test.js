import { describe, expect, it } from 'vitest';
import { resolveInitialTab, VALID_TABS, DEFAULT_TAB } from './home-routing.js';

describe('default tab routing', () => {
  it('lands a fresh session on Home', () => {
    expect(DEFAULT_TAB).toBe('home');
    expect(resolveInitialTab('')).toBe('home');
    expect(resolveInitialTab(undefined)).toBe('home');
    expect(resolveInitialTab('#nonsense')).toBe('home');
  });
  it('honours every valid hash (deep links, push click, refresh, onboarding)', () => {
    for (const t of VALID_TABS) expect(resolveInitialTab(`#${t}`)).toBe(t);
    expect(resolveInitialTab('#my-bookings')).toBe('my-bookings');
    expect(resolveInitialTab('class-timetable')).toBe('class-timetable');
  });
  it('maps the legacy about hash to settings', () => {
    expect(resolveInitialTab('#about')).toBe('settings');
  });
  it('Home is the first tab', () => { expect(VALID_TABS[0]).toBe('home'); });
});
