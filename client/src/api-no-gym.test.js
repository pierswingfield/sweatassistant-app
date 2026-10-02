// C3-10: an account with no linked gym is a legitimate state (post-signup, or
// after unlinking the last gym), not an error. Before this fix, `api.getMetadata()`
// always called `/api/metadata` regardless of the linked-gym count, which the
// server answers with 409 NO_GYM_LINKED for a gym-less account — surfaced to the
// user as a "Failed to load filters metadata" toast on every page load.
//
// This asserts the client-side contract directly: zero linked gyms means
// `getMetadata()` resolves to the empty shape without ever calling `fetch`.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  getOfflineSnapshot: vi.fn(),
  setOfflineSnapshot: vi.fn(),
}));

vi.mock('./cache.js', async () => {
  const actual = await vi.importActual('./cache.js');
  return { ...actual, ...cacheMocks };
});

// api.js pulls in main.js (for debugLog) which pulls in timetable.js/tooltips.js,
// and those touch window.matchMedia at module-load time for a resize listener
// unrelated to this test. Stub it before the dynamic import so the module graph
// loads cleanly under jsdom, which has no matchMedia implementation.
if (!window.localStorage) {
  const store = new Map();
  window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}
window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}));

let api;
beforeAll(async () => {
  ({ api } = await import('./api.js'));
});

describe('api.getMetadata — no gym linked (C3-10)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cacheMocks.getOfflineSnapshot.mockReset();
    cacheMocks.setOfflineSnapshot.mockReset();
    document.documentElement.classList.remove('psycle-offline');
  });

  it('resolves to the empty shape and never calls fetch when the account has no linked gym', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    vi.spyOn(api, 'getMyGyms').mockResolvedValue({ gyms: [] });

    const result = await api.getMetadata();

    expect(result).toEqual({ locations: [], studios: [], instructors: [], eventTypes: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still calls fetch normally for a single-gym account', async () => {
    vi.spyOn(api, 'getMyGyms').mockResolvedValue({ gyms: [{ gym_id: 'psycle-london', gym_name: 'Psycle' }] });
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ locations: [{ id: 1 }], studios: [], instructors: [], eventTypes: [] }),
    });

    const result = await api.getMetadata();

    expect(result.locations).toEqual([{ id: 1, gymId: 'psycle-london', gymName: 'Psycle' }]);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('restores saved filter metadata before attempting a fetch while offline', async () => {
    document.documentElement.classList.add('psycle-offline');
    cacheMocks.getOfflineSnapshot.mockResolvedValue({
      savedAt: 123,
      data: {
        locations: [{ id: 'location-1', name: 'Mortimer Street' }],
        studios: [{ id: 'studio-1', name: 'Ride Studio' }],
        instructors: [{ id: 'instructor-1', name: 'Becky' }],
        eventTypes: [{ id: 'ride', name: 'RIDE' }],
      },
    });
    const fetchSpy = vi.spyOn(global, 'fetch');

    await expect(api.getMetadata()).resolves.toMatchObject({
      locations: [{ id: 'location-1', name: 'Mortimer Street' }],
      instructors: [{ id: 'instructor-1', name: 'Becky' }],
    });
    expect(cacheMocks.getOfflineSnapshot).toHaveBeenCalledWith('metadata::');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
