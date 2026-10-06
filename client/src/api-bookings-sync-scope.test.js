// C3 (2026-10-06): a per-gym bookings fetch that FAILS must not clear that gym's server-side
// reminder cache. getBookings used to answer `[]` for a failed gym; the merged list was then synced
// as authoritative for every linked gym. Now the sync names only the gyms that actually loaded.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));

// Node >= 22 ships its own `localStorage` global that shadows jsdom's (see api-credits-by-gym.test.js).
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

const GYMS = [{ gym_id: 'psycle-london', gym_name: 'Psycle' }, { gym_id: 'jab-boxing', gym_name: 'JAB' }];
const booking = (id, gymId) => ({ bookingId: id, gymId, event: { startAt: '2030-01-01T10:00:00Z' } });

// failing: { '/api/bookings': ['jab-boxing'], '/api/waitlists': [...] }
function mockFetch(failing = {}) {
  const posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const gym = opts.headers?.['x-gym-id'];
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if ((failing[url] || []).includes(gym)) return new Response('{}', { status: 500 });
    const key = url === '/api/waitlists' ? 'waitlists' : 'bookings';
    return new Response(JSON.stringify({ [key]: [booking(`${key}-${gym}`, gym)] }), { status: 200 });
  }));
  return posts;
}

beforeEach(() => {
  vi.spyOn(api, 'getMyGyms').mockResolvedValue({ gyms: GYMS });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('api.syncBookings gym scope', () => {
  it('names only the gyms whose bookings fetch succeeded', async () => {
    const posts = mockFetch({ '/api/bookings': ['jab-boxing'] });
    const list = await api.getBookings();
    expect(list.map((b) => b.gymId)).toEqual(['psycle-london']); // failed gym contributes nothing
    await api.syncBookings(list);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/bookings/sync');
    expect(posts[0].body.gymIds).toEqual(['psycle-london']);
  });

  it('names every gym when all fetches succeed', async () => {
    const posts = mockFetch();
    await api.syncBookings(await api.getBookings());
    expect(posts[0].body.gymIds.sort()).toEqual(['jab-boxing', 'psycle-london']);
  });

  it('does not sync at all when no gym loaded', async () => {
    const posts = mockFetch({ '/api/bookings': ['psycle-london', 'jab-boxing'] });
    await api.syncBookings(await api.getBookings());
    expect(posts).toHaveLength(0);
  });

  it('a waitlists fetch cannot change which gyms the bookings sync is authoritative for', async () => {
    const posts = mockFetch({ '/api/waitlists': ['psycle-london'] });
    const list = await api.getBookings();   // both gyms loaded
    await api.getWaitlists();               // psycle waitlist fails; must not shrink or grow the set
    await api.syncBookings(list);
    expect(posts[0].body.gymIds.sort()).toEqual(['jab-boxing', 'psycle-london']);
  });
});
