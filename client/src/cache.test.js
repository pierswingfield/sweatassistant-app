// API-response cache key isolation. (WP-G's gym segment was removed in C3-24: it
// keyed off `appActiveGymId`, which nothing writes any more.)
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

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { setCacheKeyPrefix, cacheKeyPrefix, accountScopedKey, sanitiseOfflineSnapshot, getCachedSWR, invalidateApiCache, setCached, readCached } from './cache.js';

let api;
beforeAll(async () => { ({ api } = await import('./api.js')); });

window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));

const GYM_KEY = 'appActiveGymId';

const mockStorage = {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
  clear() { this._data = {}; }
};

function mockIndexedDB() {
  const rows = new Map();
  let failWrites = false;
  return {
    rows,
    failWrites(value) { failWrites = value; },
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const tx = {};
            const store = {
              get(key) {
                const result = {};
                setTimeout(() => {
                  result.result = rows.get(key);
                  result.onsuccess?.();
                  setTimeout(() => tx.oncomplete?.(), 0);
                }, 0);
                return result;
              },
              put(value, key) {
                if (failWrites) {
                  setTimeout(() => { tx.error = new Error('mock write failure'); tx.onerror?.(); }, 0);
                } else rows.set(key, value);
                return {};
              },
              delete(key) { rows.delete(key); },
              clear() { rows.clear(); },
              openCursor() {
                const cursorRequest = {};
                const entries = [...rows.entries()];
                let index = 0;
                const next = () => setTimeout(() => {
                  if (index >= entries.length) {
                    cursorRequest.result = null;
                    cursorRequest.onsuccess?.();
                    setTimeout(() => tx.oncomplete?.(), 0);
                    return;
                  }
                  const [key, value] = entries[index];
                  cursorRequest.result = {
                    key, value,
                    delete() { rows.delete(key); },
                    continue() { index += 1; next(); },
                  };
                  cursorRequest.onsuccess?.();
                }, 0);
                next();
                return cursorRequest;
              },
            };
            tx.objectStore = () => store;
            return tx;
          },
        };
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

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

describe('linked-gym cache invalidation', () => {
  async function expectMutationToClearMyGyms(mutate) {
    const oldDescriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    const db = mockIndexedDB();
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: db });
    setCacheKeyPrefix('linked-user');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ gyms: [] }), { status: 200 })));
    try {
      await setCached('/api/my-gyms', { gyms: [{ gym_id: 'old-gym' }] });
      expect((await readCached('/api/my-gyms')).data.gyms).toHaveLength(1);
      await mutate();
      expect(await readCached('/api/my-gyms')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      if (oldDescriptor) Object.defineProperty(window, 'indexedDB', oldDescriptor);
      else delete window.indexedDB;
    }
  }

  it('clears a cached linked-gym response after linking', async () => {
    await expectMutationToClearMyGyms(() => api.linkGym('jab-boxing', 'member@example.test', 'test-password'));
  });

  it('clears a cached linked-gym response after unlinking', async () => {
    await expectMutationToClearMyGyms(() => api.unlinkGym('jab-boxing'));
  });
});

describe('cache key prefix', () => {
  it('is the user id, with no gym segment (C3-24)', () => {
    setCacheKeyPrefix('user123');
    expect(cacheKeyPrefix()).toBe('user123');
  });

  it('ignores the retired appActiveGymId key entirely', () => {
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

describe('offline snapshot sanitising', () => {
  it('keeps normalized display data but removes credentials, tokens and calendar links recursively', () => {
    expect(sanitiseOfflineSnapshot({
      gyms: [{ id: 'jab-boxing', name: 'JAB Boxing' }],
      calendar: { enabled: true, links: { https: 'https://secret.example/feed' } },
      profile: { displayName: 'Member', accessToken: 'secret', nested: { password: 'nope', visible: true } },
    })).toEqual({
      gyms: [{ id: 'jab-boxing', name: 'JAB Boxing' }],
      calendar: { enabled: true },
      profile: { displayName: 'Member', nested: { visible: true } },
    });
  });
});

describe('SWR invalidation races', () => {
  it('retries an in-flight miss after mutation invalidation before returning data', async () => {
    const oldDescriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    const db = mockIndexedDB();
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: db });
    setCacheKeyPrefix('race-user');
    let resolveFirst;
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { ok: true, json: async () => ({ value: 'fresh' }) };
    });
    try {
      const pending = getCachedSWR('/api/bookings?gymId=gym-a', { fetcher, ttlMs: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await invalidateApiCache('/api/bookings');
      resolveFirst({ ok: true, json: async () => ({ value: 'stale' }) });
      await expect(pending).resolves.toMatchObject({ data: { value: 'fresh' } });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      if (oldDescriptor) Object.defineProperty(window, 'indexedDB', oldDescriptor);
      else delete window.indexedDB;
    }
  });

  it('never retries an invalidated old-account request under the new account prefix', async () => {
    const oldDescriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    const db = mockIndexedDB();
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: db });
    setCacheKeyPrefix('old-user');
    let resolveFirst;
    const fetcher = vi.fn(() => new Promise((resolve) => { resolveFirst = resolve; }));
    try {
      const pending = getCachedSWR('/api/bookings?gymId=gym-a', { fetcher, ttlMs: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await invalidateApiCache('/api/bookings');
      setCacheKeyPrefix('new-user');
      resolveFirst({ ok: true, json: async () => ({ value: 'old-account' }) });
      await expect(pending).rejects.toThrow('Cache account changed during request');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(db.rows.has('new-user:/api/bookings?gymId=gym-a')).toBe(false);
    } finally {
      if (oldDescriptor) Object.defineProperty(window, 'indexedDB', oldDescriptor);
      else delete window.indexedDB;
    }
  });

  it('does not announce a background refresh when its cache write fails', async () => {
    const oldDescriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    const db = mockIndexedDB();
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: db });
    setCacheKeyPrefix('race-user');
    const endpoint = '/api/favourites?gymId=gym-a';
    db.rows.set(`race-user:${endpoint}`, { data: { value: 'cached' }, ts: Date.now() - 1000, ttlMs: 10 });
    db.failWrites(true);
    const refreshed = vi.fn();
    window.addEventListener('app-data-refreshed', refreshed);
    try {
      const result = await getCachedSWR(endpoint, {
        ttlMs: 10,
        fetcher: async () => ({ ok: true, json: async () => ({ value: 'new' }) }),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(result).toMatchObject({ data: { value: 'cached' }, stale: true });
      expect(refreshed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('app-data-refreshed', refreshed);
      if (oldDescriptor) Object.defineProperty(window, 'indexedDB', oldDescriptor);
      else delete window.indexedDB;
    }
  });
});
