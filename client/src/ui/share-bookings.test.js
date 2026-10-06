import { describe, it, expect, beforeEach } from 'vitest';
import { setGymCatalogue, setLinkedGyms } from '../gym-context.js';
import { CATALOGUE } from './gym-brand-fixture.js';
import {
  buildShareItems, filterShareItems, countShareItems, formatShare, possessive, pickFirstName, boldUnicode, gymsWithUpcoming,
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

  it('plain text: title-cased header, bold date and time, bullets, full location', () => {
    const items = buildShareItems({
      bookings: [booking(1, 5)],
      waitlists: [{ event: { id: 3, name: 'RIDE 45', discipline: 'RIDE', startAt: iso(6), gymId: 'psycle-london', timeZone: 'Europe/London', locationName: 'Psycle Oxford Circus' } }],
      autoBooks: [{ event_id: 9, gym_id: 'psycle-london', start_at: iso(30), status: 'pending', class_name: 'RIDE 45', group_name: 'RIDE', location_name: 'Psycle Oxford Circus', instructor_name: 'Zed' }],
    });
    const { text } = formatShare(items, { name: 'Piers', windowId: '1w', appName: 'Sweat Assistant' });
    const lines = text.split('\n');
    expect(lines[0]).toBe("Piers's Classes - 7 Days");
    expect(text).toMatch(/• [\u{1d7ec}-\u{1d7f5}]{2}:[\u{1d7ec}-\u{1d7f5}]{2} Psycle - RIDE with Emma · Oxford Circus/u);
    expect(text).toContain('(waitlist)');
    expect(text).toContain('Psycle - RIDE with Zed · Oxford Circus (auto-book, TBC)');
    expect(text).not.toContain('RIDE 45');
    expect(text).toMatch(/Shared from Sweat Assistant$/);
    expect(text.match(/\n\n/g)).toHaveLength(3);
  });

  it('html: bold dates and times, bullets as a list, escaped content', () => {
    const items = buildShareItems({ bookings: [booking(1, 5, { instructors: [{ name: '<b>Em</b>' }] })] });
    const { html } = formatShare(items, { name: 'Piers', windowId: '3d' });
    expect(html).toContain('<p>Piers&#39;s Classes - 3 Days</p>');
    expect(html).toMatch(/<p><strong>[^<]+<\/strong><\/p><ul><li><strong>\d\d:\d\d<\/strong> Psycle - RIDE with &lt;b&gt;Em&lt;\/b&gt; · Oxford Circus<\/li><\/ul>/);
  });

  it('omits "with" when there is no instructor, and handles no name', () => {
    const items = buildShareItems({ bookings: [booking(1, 5, { instructors: [] })] });
    const { text } = formatShare(items, { windowId: '2w' });
    expect(text.startsWith('My Classes - 14 Days')).toBe(true);
    expect(text).toContain('Psycle - RIDE · Oxford Circus');
  });

  it('boldUnicode maps letters and digits and leaves punctuation', () => {
    expect(boldUnicode('Wed 7:30')).toBe('\u{1d5ea}\u{1d5f2}\u{1d5f1} \u{1d7f3}:\u{1d7ee}\u{1d7ec}'.replace('\u{1d7ee}\u{1d7ec}', '\u{1d7ef}\u{1d7ec}'));
  });

  it('only offers gyms that have something upcoming', () => {
    const items = buildShareItems({ bookings: [booking(1, 5), booking(2, -3, { gymId: 'jab-boxing' })] });
    expect(gymsWithUpcoming(items, NOW)).toEqual(['psycle-london']);
  });
});
