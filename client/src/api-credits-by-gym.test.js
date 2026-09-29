// U1-13: a per-gym credit fetch that FAILS must be "unknown", not "zero".
// getCreditsByGym used to answer `[]` for a failed gym, which the Auto-Book card
// read as "you hold no credits" and printed "Insufficient Credits" for a member
// who had one Universal credit (reproduced by failing /api/credits in a browser).

import { describe, it, expect, vi, beforeAll } from 'vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));

// Node >= 22 ships its own `localStorage` global, which is undefined unless
// --localstorage-file is given and shadows jsdom's. api.js -> main.js reads it
// at import time (applyTheme -> getTheme), so give it a minimal in-memory one.
if (typeof localStorage === 'undefined' || localStorage === null) {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

let api;
beforeAll(async () => { ({ api } = await import('./api.js')); });

describe('api.getCreditsByGym (U1-13)', () => {
  it('leaves a failed gym out of the map instead of reporting an empty inventory', async () => {
    vi.spyOn(api, 'getMyGyms').mockResolvedValue({ gyms: [{ gym_id: 'psycle-london' }, { gym_id: 'jab-boxing' }] });
    vi.spyOn(api, 'getNormalizedCredits').mockImplementation(async (gymId) => {
      if (gymId === 'psycle-london') throw new Error('HTTP 500');
      return [];
    });
    const out = await api.getCreditsByGym();
    expect('psycle-london' in out).toBe(false);
    expect(out['jab-boxing']).toEqual([]);
  });

  it('keeps a real inventory', async () => {
    vi.spyOn(api, 'getMyGyms').mockResolvedValue({ gyms: [{ gym_id: 'psycle-london' }] });
    vi.spyOn(api, 'getNormalizedCredits').mockResolvedValue([{ typeId: '1', count: 1 }]);
    expect(await api.getCreditsByGym()).toEqual({ 'psycle-london': [{ typeId: '1', count: 1 }] });
  });
});
