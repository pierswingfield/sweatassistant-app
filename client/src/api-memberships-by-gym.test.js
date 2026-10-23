import { describe, it, expect, vi, beforeAll } from 'vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));

if (typeof localStorage === 'undefined' || localStorage === null) {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  });
}

let api;
beforeAll(async () => { ({ api } = await import('./api.js')); });

describe('api.getMembershipsByGym', () => {
  it('preserves no membership while omitting a failed membership fetch', async () => {
    vi.spyOn(api, 'getMyGyms').mockResolvedValue({ gyms: [
      { gym_id: 'active' }, { gym_id: 'none' }, { gym_id: 'failed' },
    ] });
    vi.spyOn(api, 'getMembership').mockImplementation(async (gymId) => {
      if (gymId === 'failed') throw new Error('HTTP 503');
      if (gymId === 'none') return null;
      return { isActive: true, guestPassesRemaining: 0 };
    });

    await expect(api.getMembershipsByGym()).resolves.toEqual({
      active: { isActive: true, guestPassesRemaining: 0 },
      none: null,
    });
  });
});
