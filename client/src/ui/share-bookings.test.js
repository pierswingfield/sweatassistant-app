import { describe, it, expect, beforeEach } from 'vitest';
import { setGymCatalogue, setLinkedGyms } from '../gym-context.js';
import { CATALOGUE } from './gym-brand-fixture.js';
import {
  buildShareItems, filterShareItems, countShareItems, formatShareText, possessive, pickFirstName, shortLocationLabel,
} from './share-bookings.js';

const NOW = Date.parse('2026-10-06T09:00:00Z');
const H = 3600 * 1000;
const iso = (offsetH) => new Date(NOW + offsetH * H).toISOString();
const booking = (id, offsetH, extra = {}) => ({
  bookingId: `b${id}`,
  event: { id, name: 'RIDE 45', discipline: 'RIDE', startAt: iso(offsetH), timeZone: 'Europe/London', gymId: 'psycle-london',
    locationName: 'Psycle Oxford Circus', instructors: [{ name: 'Emma' }], ...extra },
});

describe('share-bookings', () => {
  beforeEach(() => {
    setGymCatalogue(CATALOGUE);
    setLinkedGyms([
      { gym_id: 'psycle-london', shortName: 'Psycle', locationAliases: { 'oxford circus': 'OC' } },
      { gym_id: 'jab-boxing', shortName: 'JAB' },
    ]);
  });

  it('abbreviates the location: gym short name + alias', () => {
    expect(shortLocationLabel('psycle-london', 'Psycle Oxford Circus')).toBe('Psycle OC');
    expect(shortLocationLabel('jab-boxing', 'JAB Soho')).toBe('JAB Soho');
  });

  it('counts extra spots on one event as one class', () => {
    const items = buildShareItems({ bookings: [booking(1, 5), booking(1, 5)] });
    expect(items).toHaveLength(1);
  });

  it('drops a pending auto-book for an event already booked, keeps others', () => {
    const items = buildShareItems({
      bookings: [booking(1, 5)],
      autoBooks: [
        { event_id: 1, gym_id: 'psycle-london', start_at: iso(5), status: 'pending', class_name: 'RIDE 45' },
        { event_id: 2, gym_id: 'psycle-london', start_at: iso(6), status: 'pending', class_name: 'RIDE 45' },
        { event_id: 3, gym_id: 'psycle-london', start_at: iso(7), status: 'success', class_name: 'RIDE 45' },
      ],
    });
    expect(items.map((i) => [i.eventId, i.kind])).toEqual([['1', 'confirmed'], ['2', 'autobook']]);
  });

  it('window is now..now+N days; past classes and beyond-window are out', () => {
    const items = buildShareItems({ bookings: [booking(1, -1), booking(2, 24), booking(3, 71), booking(4, 73), booking(5, 24 * 13)] });
    const ids = (w) => filterShareItems(items, { windowId: w, now: NOW }).map((i) => i.eventId);
    expect(ids('3d')).toEqual(['2', '3']);
    expect(ids('1w')).toEqual(['2', '3', '4']);
    expect(ids('2w')).toEqual(['2', '3', '4', '5']);
  });

  it('gym selection and the TBC toggle filter and count', () => {
    const items = buildShareItems({
      bookings: [booking(1, 5), booking(2, 6, { gymId: 'jab-boxing', locationName: 'JAB Soho' })],
      waitlists: [{ event: { id: 3, name: 'RIDE 45', startAt: iso(7), gymId: 'psycle-london', timeZone: 'Europe/London' } }],
    });
    const all = filterShareItems(items, { now: NOW, gymIds: ['psycle-london', 'jab-boxing'] });
    expect(countShareItems(all)).toEqual({ total: 3, tbc: 1 });
    expect(filterShareItems(items, { now: NOW, gymIds: ['jab-boxing'] })).toHaveLength(1);
    expect(filterShareItems(items, { now: NOW, includeTbc: false })).toHaveLength(2);
    expect(filterShareItems(items, { now: NOW, gymIds: [] })).toHaveLength(0);
  });

  it('possessive always appends \'s, and is empty for no name', () => {
    expect(possessive('Piers')).toBe("Piers's");
    expect(possessive('Sam')).toBe("Sam's");
    expect(possessive('')).toBe('');
  });

  it('first name comes from normalized or raw profiles', () => {
    expect(pickFirstName([null, { first_name: 'Ana' }])).toBe('Ana');
    expect(pickFirstName([{ firstName: ' Bo ' }])).toBe('Bo');
    expect(pickFirstName([{}])).toBe('');
  });

  it('formats header, day groups, abbreviated location and TBC tags', () => {
    const items = buildShareItems({
      bookings: [booking(1, 5)],
      waitlists: [{ event: { id: 3, name: 'RIDE 45', discipline: 'RIDE', startAt: iso(6), gymId: 'psycle-london', timeZone: 'Europe/London', locationName: 'Psycle Oxford Circus' } }],
      autoBooks: [{ event_id: 9, gym_id: 'psycle-london', start_at: iso(30), status: 'pending', class_name: 'RIDE 45', location_name: 'Psycle Oxford Circus', instructor_name: 'Zed' }],
    });
    const text = formatShareText(items, { name: 'Piers', windowId: '1w', appName: 'Sweat Assistant' });
    const lines = text.split('\n');
    expect(lines[0]).toBe("Piers's classes - next week");
    expect(text).toContain('Psycle OC');
    expect(text).toContain('Emma');
    expect(text).toContain('(waitlist)');
    expect(text).toContain('(auto-book, TBC)');
    expect(text).toMatch(/Shared from Sweat Assistant$/);
    expect(text.match(/\n\n[A-Z][a-z]{2} \d+ [A-Z][a-z]{2}\n/g)).toHaveLength(2);
  });

  it('shows a gym-local time with a zone suffix when it differs from the device', () => {
    const items = buildShareItems({ bookings: [booking(1, 5, { timeZone: 'America/New_York', gymId: 'jab-boxing' })] });
    const text = formatShareText(items, { name: '', windowId: '3d' });
    expect(text.startsWith('My classes - next 3 days')).toBe(true);
  });
});
