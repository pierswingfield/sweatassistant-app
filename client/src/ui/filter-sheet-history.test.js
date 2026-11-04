// Filter drawer x history: edits made while the drawer is open must survive closing it.
// Regression: each toggle pushed a filter entry that copied the drawer layer's appNavId, so
// "Show classes" (history.back) landed on the pre-edit layer entry, the router restored the old
// filters from it and flagged them as a link overlay, which hid the filter rail.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderFilterRail, removeFilterRail, isFilterSheetHoldingHistory, isFilterSheetOpen } from './filter-rail.js';
import { _resetForTests } from './modal-nav.js';
import { commitFilterChange, initRouter, _resetRouterForTest } from '../router.js';

const setMobile = (m) => { window.matchMedia = (q) => ({ matches: m, media: q, addEventListener() {}, removeEventListener() {} }); };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// A stand-in for timetable.js: owns the filter state, syncs it to the URL like syncUrlFromState
// (held while the drawer owns history), and records what the router would restore on popstate.
function harness() {
  const state = { gyms: ['g1'], locations: [], instructors: [], eventTypes: [], bookmarks: false };
  const urlOf = () => `/timetable?gym=${state.gyms.join(',')}${state.instructors.length ? `&instructor=${state.instructors.join(',')}` : ''}`;
  const sync = () => { if (isFilterSheetHoldingHistory()) return; commitFilterChange(urlOf()); };
  const ctx = {
    state, gyms: [{ id: 'g1', name: 'G1' }], locations: [], workouts: [],
    instructors: [{ id: 'g1:1', name: 'Ann', gymId: 'g1' }, { id: 'g1:2', name: 'Bob', gymId: 'g1' }],
    resultCount: 3, locationAlias: () => '', locationLabel: (l) => l.name, canBookmark: false,
    isOn: (k, id) => state[k].includes(String(id)),
    toggle: (k, id) => { state[k] = state[k].includes(id) ? state[k].filter((x) => x !== id) : [...state[k], id]; sync(); },
    flush: vi.fn(), clear() {}, clearAll() {}, save() {},
    onSheetClosed: vi.fn(() => sync()),
  };
  return { ctx, state, sync };
}

const restored = [];
initRouter(() => restored.push(location.pathname + location.search));

beforeEach(() => {
  setMobile(true);
  _resetForTests(); _resetRouterForTest();
  removeFilterRail(); // module-level sheet from the previous test (its layer is gone with the reset)
  restored.length = 0;
  document.body.innerHTML = '<div id="app-timetable-filters-container"></div>';
  history.replaceState({ manualFilter: true }, '', '/timetable?gym=g1');
});

async function openDrawerAndPick(h) {
  renderFilterRail(h.ctx);
  document.querySelector('.fr-trigger[data-fr-open]').click();
  expect(isFilterSheetOpen()).toBe(true);
  expect(isFilterSheetHoldingHistory()).toBe(true);
  const len = history.length;
  h.ctx.toggle('instructors', 'g1:1');
  // No competing entry while the drawer owns the top of history.
  expect(history.length).toBe(len);
  expect(location.search).toBe('?gym=g1');
}

describe('filter drawer history', () => {
  it('Show classes keeps the edit, commits it once and never restores the pre-edit URL', async () => {
    const h = harness();
    await openDrawerAndPick(h);
    document.querySelector('.fr-done').click();
    await tick();
    expect(h.ctx.onSheetClosed).toHaveBeenCalledTimes(1);
    expect(isFilterSheetHoldingHistory()).toBe(false);
    expect(location.pathname + location.search).toBe('/timetable?gym=g1&instructor=g1:1');
    expect(history.state.appNavId).toBeUndefined();
    expect(history.state.manualFilter).toBe(true);
    expect(restored).toEqual([]);   // the drawer's own pop is consumed by modal-nav
    expect(h.state.instructors).toEqual(['g1:1']);
  });

  it('the back gesture closes the drawer and also keeps the edit', async () => {
    const h = harness();
    await openDrawerAndPick(h);
    history.back();
    await tick();
    expect(isFilterSheetOpen()).toBe(false);
    expect(h.ctx.onSheetClosed).toHaveBeenCalledTimes(1);
    expect(location.pathname + location.search).toBe('/timetable?gym=g1&instructor=g1:1');
    expect(restored).toEqual([]);
  });

  it('a later Back steps to the pre-drawer filters (one entry per drawer session)', async () => {
    const h = harness();
    await openDrawerAndPick(h);
    h.ctx.toggle('instructors', 'g1:2');
    document.querySelector('.fr-done').click();
    await tick();
    expect(location.search).toBe('?gym=g1&instructor=g1:1,g1:2');
    history.back();
    await tick();
    expect(location.search).toBe('?gym=g1');
    expect(restored).toEqual(['/timetable?gym=g1']);
  });

  it('desktop (no history layer) commits on close without a pop', async () => {
    setMobile(false);
    const h = harness();
    renderFilterRail(h.ctx);
    document.querySelector('.fr-trigger[data-fr-open]').click();
    h.ctx.toggle('instructors', 'g1:1');
    document.querySelector('.fr-done').click();
    expect(h.ctx.onSheetClosed).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('?gym=g1&instructor=g1:1');
  });
});
