// F-12: Settings > Favourites pane, pure model. Grouping is by the favourite's weekday in the CLASS zone
// (already baked into the stored slot), Monday first; each favourite resolves to the NEXT upcoming loaded class
// at its own gym + studio + weekday + start time; "not loaded" is not "none".
import { describe, it, expect } from 'vitest';
import { indexFavourites } from '../favourites.js';
import { buildFavouriteGroups, paneState } from './favourites-pane-model.js';

const NOW = new Date('2026-10-06T12:00:00Z'); // a Tuesday
const ev = (over) => ({ id: 'e', gymId: 'psycle-london', studioId: '138', startAt: '2026-10-12T19:30:00+01:00', timeZone: 'Europe/London', name: 'Ride', ...over });
const fav = (studioId, dayOfWeek, startTime, extra = {}) => ({ studioId, dayOfWeek, startTime, id: `${studioId}0000${dayOfWeek}0000${startTime}`, ...extra });

describe('buildFavouriteGroups', () => {
  it('groups Monday to Sunday, only days that have favourites, sorted by time within a day', () => {
    const favouritesByGym = {
      'psycle-london': indexFavourites([fav('138', 0, '1000'), fav('138', 3, '1830'), fav('138', 1, '1930'), fav('138', 1, '0700')]),
    };
    const { groups, total } = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london'], events: [], now: NOW });
    expect(groups.map((g) => g.label)).toEqual(['Monday', 'Wednesday', 'Sunday']);
    expect(groups[0].items.map((i) => i.fav.startTime)).toEqual(['0700', '1930']);
    expect(total).toBe(4);
  });

  it('resolves each favourite to the earliest upcoming class at the same gym, studio, weekday and time', () => {
    const events = [
      ev({ id: 'past', startAt: '2026-10-05T19:30:00+01:00' }), // last Monday: already gone
      ev({ id: 'later', startAt: '2026-10-19T19:30:00+01:00' }),
      ev({ id: 'next', startAt: '2026-10-12T19:30:00+01:00' }),
      ev({ id: 'otherTime', startAt: '2026-10-12T19:45:00+01:00' }),
      ev({ id: 'otherStudio', studioId: '99', startAt: '2026-10-12T19:30:00+01:00' }),
      ev({ id: 'otherGym', gymId: 'jab', startAt: '2026-10-12T19:30:00+01:00' }),
    ];
    const favouritesByGym = { 'psycle-london': indexFavourites([fav('138', 1, '1930')]) };
    const { groups } = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london'], events, now: NOW });
    expect(groups[0].items[0].event.id).toBe('next');
  });

  it('never matches a same-numbered studio at another gym', () => {
    const events = [ev({ id: 'jabOnly', gymId: 'jab', studioId: '138' })];
    const favouritesByGym = { 'psycle-london': indexFavourites([fav('138', 1, '1930')]) };
    const { groups } = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london'], events, now: NOW });
    expect(groups[0].items[0].event).toBe(null);
  });

  it('keeps a favourite with no upcoming class (event null) and carries its stored labels', () => {
    const favouritesByGym = { 'psycle-london': indexFavourites([fav('138', 1, '1930', { className: 'Ride', studioName: 'Studio 1' })]) };
    const { groups } = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london'], events: [], now: NOW });
    expect(groups[0].items[0]).toMatchObject({ gymId: 'psycle-london', event: null });
    expect(groups[0].items[0].fav.className).toBe('Ride');
  });

  it('reads the weekday in the class zone: a favourite stored as Monday matches a Monday-in-zone class', () => {
    // 23:30 UTC Sunday is 00:30 Monday in London: slot Monday 0030, not Sunday 2330.
    const e = ev({ id: 'late', startAt: '2026-10-11T23:30:00Z' });
    const favouritesByGym = { 'psycle-london': indexFavourites([fav('138', 1, '0030')]) };
    const { groups } = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london'], events: [e], now: NOW });
    expect(groups[0].label).toBe('Monday');
    expect(groups[0].items[0].event.id).toBe('late');
  });

  it('merges several gyms into the same day, breaking time ties by gym order', () => {
    const favouritesByGym = {
      'psycle-london': indexFavourites([fav('1', 2, '1800')]),
      jab: indexFavourites([fav('1', 2, '1800'), fav('5', 2, '0600')]),
    };
    const { groups } = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london', 'jab'], events: [], now: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => `${i.gymId}:${i.fav.startTime}`)).toEqual(['jab:0600', 'psycle-london:1800', 'jab:1800']);
  });

  it('skips a gym whose favourites have not loaded (null), without calling it empty', () => {
    const favouritesByGym = { jab: indexFavourites([fav('5', 2, '0600')]) };
    const r = buildFavouriteGroups({ favouritesByGym, gymIds: ['psycle-london', 'jab'], events: [], now: NOW });
    expect(r.total).toBe(1);
    expect(r.loadedGyms).toEqual(['jab']);
  });
});

describe('paneState', () => {
  it('is loading until at least one linked gym has loaded', () => {
    expect(paneState({ gymIds: ['a'], loadedGyms: [], total: 0 })).toBe('loading');
  });
  it('is empty when loaded and nothing is favourited', () => {
    expect(paneState({ gymIds: ['a'], loadedGyms: ['a'], total: 0 })).toBe('empty');
  });
  it('is empty with no linked gyms at all (nothing can be loading)', () => {
    expect(paneState({ gymIds: [], loadedGyms: [], total: 0 })).toBe('empty');
  });
  it('is list when there is anything to show', () => {
    expect(paneState({ gymIds: ['a', 'b'], loadedGyms: ['a'], total: 2 })).toBe('list');
  });
});
