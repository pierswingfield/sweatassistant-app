import { describe, expect, it, beforeAll, vi } from 'vitest';
import { setLinkedGyms } from '../gym-context.js';

let countPendingAutoBooks;
let getHomeCreditRows;
let getHomeBookLinks;
let cache;
beforeAll(async () => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  if (typeof localStorage === 'undefined' || localStorage === null || !localStorage.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    });
  }
  ({ cache } = await import('../main.js'));
  ({ countPendingAutoBooks, getHomeCreditRows, getHomeBookLinks } = await import('./home.js'));
});

describe('W2 Home book row', () => {
  it('uses timetable overlay URLs for each linked gym and an explicit merged All link', () => {
    setLinkedGyms([
      { gym_id: 'jab-boxing', shortName: 'JAB' },
      { gym_id: 'psycle-london', shortName: 'Psycle' },
    ]);
    expect(getHomeBookLinks([
      { gym_id: 'jab-boxing' },
      { gym_id: 'psycle-london' },
      { gym_id: 'jab-boxing' },
    ])).toMatchObject([
      { gymId: 'jab-boxing', href: '/timetable?gym=jab-boxing' },
      { gymId: 'psycle-london', href: '/timetable?gym=psycle-london' },
      { gymId: null, href: '/timetable?f=all' },
    ]);
  });

  it('keeps the All link when a malformed linked-gym row has no id', () => {
    expect(getHomeBookLinks([{ shortName: 'Unknown' }])).toEqual([
      { gymId: null, name: 'All', href: '/timetable?f=all' },
    ]);
  });
});

describe('W5 Home credits', () => {
  const gyms = [
    { gym_id: 'metered', shortName: 'Metered', capabilities: { metered: true } },
    { gym_id: 'member', shortName: 'Member', capabilities: { metered: false } },
    { gym_id: 'empty', shortName: 'Empty', capabilities: { metered: true } },
  ];

  it('shows positive balances and confirmed memberships only', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [{ count: 3 }], empty: [] };
    cache.eligibilityByGym = { member: { canBook: true }, empty: { canBook: false } };
    expect(getHomeCreditRows(gyms, {
      creditsByGym: cache.creditsByGym,
      eligibilityByGym: cache.eligibilityByGym,
    })).toMatchObject([
      { gymId: 'metered', kind: 'credits', count: 3 },
      { gymId: 'member', kind: 'membership' },
    ]);
  });

  it('omits gyms whose balance or eligibility is not loaded', () => {
    setLinkedGyms(gyms);
    cache.creditsByGym = { metered: [] };
    cache.eligibilityByGym = {};
    expect(getHomeCreditRows(gyms, { creditsByGym: cache.creditsByGym, eligibilityByGym: {} })).toEqual([]);
  });
});

describe('W4 auto-book count', () => {
  it('counts only pending rows across gyms', () => {
    expect(countPendingAutoBooks([{ id: 1 }, { id: 2, executed_at: 'x' }, { id: 3 }])).toBe(2);
  });
  it('never turns not-loaded into zero', () => {
    expect(countPendingAutoBooks(undefined)).toBeNull();
    expect(countPendingAutoBooks([])).toBe(0);
  });
});
