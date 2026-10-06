// F-12: gym-neutral favourites, client half. A favourite is a recurring slot
// (studio + weekday + start time) read in the CLASS's zone. Matching must never
// use the device zone, never match across gyms, and "not loaded" is not "none".
import { describe, it, expect } from 'vitest';
import { slotOfEvent, favouriteId, indexFavourites, isFavouriteIn, labelsOfEvent } from './favourites.js';

describe('slotOfEvent', () => {
  it('uses the class zone for weekday and time', () => {
    // 23:30 UTC Sunday: 19:30 Sunday in New York, 00:30 Monday in London.
    const ny = { studioId: '7', startAt: '2026-06-07T23:30:00Z', timeZone: 'America/New_York' };
    const ldn = { studioId: '7', startAt: '2026-06-07T23:30:00Z', timeZone: 'Europe/London' };
    expect(slotOfEvent(ny)).toEqual({ studioId: '7', dayOfWeek: 0, startTime: '1930' });
    expect(slotOfEvent(ldn)).toEqual({ studioId: '7', dayOfWeek: 1, startTime: '0030' });
  });

  it('stringifies ids and returns null for unusable events', () => {
    expect(slotOfEvent({ studioId: 138, startAt: '2026-10-05T19:30:00+01:00', timeZone: 'Europe/London' }).studioId).toBe('138');
    expect(slotOfEvent(null)).toBe(null);
    expect(slotOfEvent({ studioId: '1' })).toBe(null);
    expect(slotOfEvent({ startAt: '2026-10-05T19:30:00Z' })).toBe(null);
  });
});

describe('favouriteId', () => {
  it('is the native bookmark key (studio 138, Monday 19:30)', () => {
    expect(favouriteId({ studioId: '138', dayOfWeek: 1, startTime: '1930' })).toBe('1380000100001930');
  });
});

describe('matching', () => {
  const list = [{ id: '1380000100001930', studioId: '138', dayOfWeek: 1, startTime: '1930' }];
  const mon1930 = { studioId: '138', startAt: '2026-10-05T19:30:00+01:00', timeZone: 'Europe/London' };

  it('matches the same studio, weekday and time on any date', () => {
    const idx = indexFavourites(list);
    expect(isFavouriteIn(idx, mon1930)).toBe(true);
    expect(isFavouriteIn(idx, { ...mon1930, startAt: '2026-10-12T19:30:00+01:00' })).toBe(true);
    expect(isFavouriteIn(idx, { ...mon1930, startAt: '2026-10-06T19:30:00+01:00' })).toBe(false); // Tuesday
    expect(isFavouriteIn(idx, { ...mon1930, startAt: '2026-10-05T19:45:00+01:00' })).toBe(false);
    expect(isFavouriteIn(idx, { ...mon1930, studioId: '139' })).toBe(false);
  });

  it('treats an unloaded list as "not a favourite", and an empty list the same without throwing', () => {
    expect(isFavouriteIn(null, mon1930)).toBe(false);
    expect(isFavouriteIn(undefined, mon1930)).toBe(false);
    expect(isFavouriteIn(indexFavourites([]), mon1930)).toBe(false);
  });
});

describe('labelsOfEvent', () => {
  it('keeps display-only labels', () => {
    const l = labelsOfEvent({ name: 'Ride', discipline: 'Cycling', instructors: [{ name: 'Sam' }], studioName: 'A', locationName: 'Soho' });
    expect(l).toEqual({ className: 'Ride', discipline: 'Cycling', instructorName: 'Sam', studioName: 'A', locationName: 'Soho' });
  });
});
