// API-response cache key isolation. (WP-G's gym segment was removed in C3-24: it
// keyed off `sweatActiveGymId`, which nothing writes any more.)
//
// Every body in the `api-responses` store is gym-specific — one gym's timetable,
// its bookings, its studio layouts. Before WP-G the key carried only the user id,
// so isolation depended entirely on settings.js's applyGymSwitch() remembering to
// clear the store on every transition. That is a correctness guarantee resting on
// a habit: one new path that changes the active gym without calling it, and the
// app serves the previous gym's timetable to this gym's UI, indistinguishable
// from a caching bug.
//
// The fix derives the gym segment from localStorage at key-build time, so the
// collision is impossible rather than avoided. These tests pin that property —
// specifically that switching the gym changes the key WITHOUT anyone clearing
// anything, which is the half a "we clear on switch" test cannot cover.

import { describe, it, expect, beforeEach } from 'vitest';
import { setCacheKeyPrefix, cacheKeyPrefix, accountScopedKey } from './cache.js';

const GYM_KEY = 'sweatActiveGymId';

const mockStorage = {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
  clear() { this._data = {}; }
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
}
try {
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
} catch (_) {}

beforeEach(() => {
  mockStorage.clear();
  setCacheKeyPrefix('');
});

describe('cache key prefix', () => {
  it('is the user id, with no gym segment (C3-24)', () => {
    setCacheKeyPrefix('user123');
    expect(cacheKeyPrefix()).toBe('user123');
  });

  it('ignores the retired sweatActiveGymId key entirely', () => {
    // The old switcher wrote this; nothing does now. If a stale value survives in
    // someone's storage it must not change any key.
    setCacheKeyPrefix('user123');
    window.localStorage.setItem(GYM_KEY, 'jab-boxing');
    expect(cacheKeyPrefix()).toBe('user123');
  });

  it('still separates two users', () => {
    setCacheKeyPrefix('userA');
    const a = cacheKeyPrefix();
    setCacheKeyPrefix('userB');
    expect(cacheKeyPrefix()).not.toBe(a);
  });

  it('is empty before login so keys stay unprefixed', () => {
    expect(cacheKeyPrefix()).toBe('');
  });
});

describe('account-scoped caller cache keys', () => {
  it('separates merged data by user without changing on an active-gym switch', () => {
    setCacheKeyPrefix('user123');
    window.localStorage.setItem(GYM_KEY, 'psycle-london');
    const psycle = accountScopedKey('unifiedTimetable');
    window.localStorage.setItem(GYM_KEY, 'jab-boxing');

    expect(accountScopedKey('unifiedTimetable')).toBe(psycle);
    expect(psycle).toBe('unifiedTimetable:user123');

    setCacheKeyPrefix('user456');
    expect(accountScopedKey('unifiedTimetable')).toBe('unifiedTimetable:user456');
  });

  it('keeps the base key before account identity is known', () => {
    expect(accountScopedKey('unifiedTimetable')).toBe('unifiedTimetable');
  });
});
