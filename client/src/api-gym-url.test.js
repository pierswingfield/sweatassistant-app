// C2-4: per-gym GETs must have distinct URLs. Chrome's HTTP cache serialises
// same-URL requests (cold: 13/23/34 s for three gyms), and x-gym-id is a header,
// not part of the cache key. The gym rides in the URL too.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));
if (typeof localStorage === 'undefined' || localStorage === null) {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

let apiFetch;
beforeAll(async () => { ({ apiFetch } = await import('./api.js')); });

describe('apiFetch gym-distinct URLs (C2-4)', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => { calls.push({ url, opts }); return new Response('{}', { status: 200 }); }));
  });

  it('adds a gym query param to a gym-scoped GET and keeps the header', async () => {
    await apiFetch('/api/timetable?startDate=a&endDate=b', { gymId: 'jab-boxing' });
    expect(calls[0].url).toBe('/api/timetable?startDate=a&endDate=b&gym=jab-boxing');
    expect(calls[0].opts.headers['x-gym-id']).toBe('jab-boxing');
  });

  it('makes two gyms request different URLs for the same endpoint', async () => {
    await apiFetch('/api/metadata', { gymId: 'a' });
    await apiFetch('/api/metadata', { gymId: 'b' });
    expect(calls[0].url).not.toBe(calls[1].url);
    expect(calls[0].url).toBe('/api/metadata?gym=a');
  });

  it('leaves non-GET and gym-less requests untouched', async () => {
    await apiFetch('/api/book', { method: 'POST', body: '{}', gymId: 'jab-boxing' });
    await apiFetch('/api/my-gyms');
    expect(calls[0].url).toBe('/api/book');
    expect(calls[1].url).toBe('/api/my-gyms');
  });
});
