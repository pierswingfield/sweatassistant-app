import { expect, it } from 'vitest';
import { renderFilterRail } from './filter-rail.js';

it('groups more than nine locations by gym without changing selection controls', () => {
  document.body.innerHTML = '<div id="app-timetable-filters-container"></div>';
  const locations = Array.from({ length: 10 }, (_, i) => ({ id: `loc${i}`, gymId: i < 5 ? 'a' : 'b', name: `Location ${i}` }));
  const ctx = {
    state: { gyms: [], locations: ['loc1'], instructors: [], eventTypes: [], times: [], bookmarks: false },
    gyms: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'disabled', name: 'Disabled' }], locations, instructors: [], workouts: [], resultCount: 10,
    isOn: (key, id) => key === 'locations' && id === 'loc1', locationLabel: l => l.name, locationAlias: () => '',
    clear: () => {}, toggle: () => {}, reset: () => {},
  };
  renderFilterRail(ctx);
  document.querySelector('[data-fr-open]').click();
  expect(document.querySelectorAll('#fr-sec-locations .fr-wgroup-head')).toHaveLength(2);
  expect(document.querySelectorAll('[data-fr-toggle="locations"]')).toHaveLength(10);
  expect(document.querySelector('[data-id="loc1"][data-fr-toggle="locations"]').getAttribute('aria-pressed')).toBe('true');
});
