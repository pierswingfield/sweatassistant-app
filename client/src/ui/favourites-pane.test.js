// F-12: Settings > Favourites pane DOM behaviour (states, grouping, the unfavourite control). The timetable and
// main modules are mocked: the pane's contract with them is "read these caches, render these rows, call this remover".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { indexFavourites } from '../favourites.js';

const state = vi.hoisted(() => ({ cache: { favouritesByGym: {} }, events: [], loading: false, removed: [] }));
vi.mock('../main', () => ({ cache: state.cache }));
vi.mock('../gym-context.js', () => ({
  getLinkedGyms: () => [{ gym_id: 'psycle-london' }, { gym_id: 'jab-boxing' }],
  getGymPresentation: () => null, getGymShortName: (g) => g, getGymTimeZone: () => 'Europe/London', getDefaultGymId: () => 'psycle-london',
}));
vi.mock('./timetable.js', () => ({
  getLoadedEvents: () => state.events,
  isScheduleLoading: () => state.loading,
  ensureScheduleLoaded: () => {},
  renderEventRowsInto: (tbody, events) => events.forEach((e) => { const tr = document.createElement('tr'); tr.className = 'tt-row'; tr.textContent = `row:${e.id}`; tbody.appendChild(tr); }),
  removeFavouriteSlot: (gymId, slot) => { state.removed.push([gymId, slot.id]); return Promise.resolve(true); },
}));

const { renderFavouritesPane, initFavouritesPane } = await import('./favourites-pane.js');
const fav = (studioId, dayOfWeek, startTime, extra = {}) => ({ studioId, dayOfWeek, startTime, id: `${studioId}0000${dayOfWeek}0000${startTime}`, ...extra });

function mount() {
  document.body.innerHTML = '<div id="app-settings-pane-favourites" class="active"><div id="app-favourites-section"></div></div>';
  return document.getElementById('app-favourites-section');
}

describe('Favourites pane', () => {
  beforeEach(() => { state.cache.favouritesByGym = {}; state.events = []; state.loading = false; state.removed = []; });

  it('shows a loading skeleton until some gym has loaded its favourites', () => {
    const host = mount();
    renderFavouritesPane(host);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('.app-fav-empty')).toBeNull();
  });

  it('shows the empty state, with a pointer to the timetable, when loaded and nothing is favourited', () => {
    state.cache.favouritesByGym = { 'psycle-london': indexFavourites([]), 'jab-boxing': indexFavourites([]) };
    const host = mount();
    renderFavouritesPane(host);
    expect(host.querySelector('.app-fav-empty').textContent).toContain('No favourites yet');
    expect(host.querySelector('.app-fav-empty').textContent).toContain('timetable');
  });

  it('groups by weekday Monday first, shows the instructor note, and a muted line when no class is loaded', () => {
    state.cache.favouritesByGym = {
      'psycle-london': indexFavourites([fav('1', 0, '1000'), fav('1', 3, '1830', { className: 'Ride' })]),
      'jab-boxing': indexFavourites([fav('9', 1, '0700')]),
    };
    state.events = [{ id: 'next', gymId: 'jab-boxing', studioId: '9', startAt: '2099-01-05T07:00:00Z', timeZone: 'UTC' }];
    const host = mount();
    renderFavouritesPane(host);
    expect([...host.querySelectorAll('.app-fav-day-title')].map((e) => e.textContent)).toEqual(['Monday', 'Wednesday', 'Sunday']);
    expect(host.querySelector('.app-fav-note').textContent).toContain('whoever teaches it next');
    expect(host.querySelector('tr.tt-row').textContent).toBe('row:next');
    expect(host.querySelectorAll('.app-fav-missing-row')).toHaveLength(2);
    expect(host.querySelector('.app-fav-missing-note').textContent).toBe('No upcoming class in the loaded schedule');
  });

  it('says "checking" rather than "none" while the schedule is still loading', () => {
    state.cache.favouritesByGym = { 'psycle-london': indexFavourites([fav('1', 2, '1800')]) };
    state.loading = true;
    const host = mount();
    renderFavouritesPane(host);
    expect(host.querySelector('.app-fav-missing-note').textContent).toContain('Checking');
  });

  it('unfavourite control: labelled by slot, and removes that gym\'s favourite through the shared remover', async () => {
    state.cache.favouritesByGym = { 'jab-boxing': indexFavourites([fav('9', 1, '0700', { className: 'Boxing' })]) };
    const host = mount();
    renderFavouritesPane(host);
    initFavouritesPane();
    const btn = host.querySelector('.app-fav-missing-heart');
    expect(btn.getAttribute('aria-label')).toBe('Unfavourite Monday 07:00');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    btn.click();
    await Promise.resolve();
    expect(state.removed).toEqual([['jab-boxing', fav('9', 1, '0700').id]]);
  });

  it('repaints when favourites change while the pane is showing', async () => {
    state.cache.favouritesByGym = { 'jab-boxing': indexFavourites([fav('9', 1, '0700')]) };
    const host = mount();
    renderFavouritesPane(host);
    initFavouritesPane();
    state.cache.favouritesByGym = { 'jab-boxing': indexFavourites([]) };
    window.dispatchEvent(new Event('app-favourites-changed'));
    await new Promise((r) => setTimeout(r, 10));
    expect(host.querySelector('.app-fav-empty')).not.toBeNull();
  });
});
