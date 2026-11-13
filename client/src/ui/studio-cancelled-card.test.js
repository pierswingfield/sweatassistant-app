// Studio-cancelled booking card: minimal (date/time, "Cancelled class"),
// no photo, instructor, tag, location, chips or strikethrough; Edit toggle reveals Remove.
import { describe, it, expect, beforeAll, vi } from 'vitest';

let bookings;
beforeAll(async () => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  if (typeof localStorage === 'undefined' || !localStorage?.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
    });
  }
  bookings = await import('./bookings.js');
});

const event = {
  id: 'e1', gymId: 'jab-boxing', name: 'BOXING Core', discipline: 'BOXING', startAt: '2099-03-04T09:30:00+00:00',
  endAt: '2099-03-04T10:30:00+00:00', durationMin: 60, timeZone: 'Europe/London', studioId: 's1', studioName: 'Room',
  locationId: 'l1', locationName: 'SW1', instructors: [{ id: 'i1', name: 'George Davies', thumbUrl: 'https://x.test/a.jpg' }],
  layoutFormat: 'pick-a-spot',
};
const mount = (isCancelled) => {
  const c = document.createElement('div'); c.id = 'sc-' + isCancelled; document.body.appendChild(c);
  bookings.mountBookingCard(c, { eventId: 'e1', gymId: 'jab-boxing', event, isCancelled,
    bookings: [{ bookingId: 'b1', id: 'b1', slotId: '3', slotLabel: 'B3', gymId: 'jab-boxing', event }] }, []);
  return c;
};

describe('studio-cancelled booking card', () => {
  it('drops photo, instructor, tag, location, chips; keeps date/time, label; no badge', () => {
    const c = mount(true);
    const card = c.querySelector('.ab-card');
    expect(card.classList.contains('is-studio-cancelled')).toBe(true);
    for (const sel of ['.ab-card-figure', '.ab-card-instructor', '.ab-disc-tag', '.ab-card-location', '.ab-chip-group', '.ab-spot-upgrade-chip', '.bk-guest-chip']) {
      expect(card.querySelector(sel), sel).toBeNull();
    }
    expect(card.querySelector('.ab-card-class').textContent.trim()).toBe('Cancelled class');
    expect(card.querySelector('.ab-card-date').textContent.trim()).not.toBe('');
    expect(card.querySelector('.ab-card-time').textContent.trim()).not.toBe('');
    expect(card.querySelector('.bk-cancelled-badge')).toBeNull();
    // The footer only hosts the Edit toggle (cards.js wireRailToggle appends it), no badge.
    expect(card.querySelector('.ab-card-footer').children.length).toBe(1);
    expect(card.textContent).not.toMatch(/Cancelled by studio/);
    expect(card.textContent).not.toMatch(/George|BOXING|SW1/);
    expect(card.querySelector('.ab-rail-toggle').textContent).toBe('Edit');
    expect(card.querySelector('.bk-cancel-btn').textContent).toBe('Remove');
    c.remove();
  });

  it('leaves a normal booking card unchanged', () => {
    const c = mount(false);
    const card = c.querySelector('.ab-card');
    expect(card.querySelector('.ab-chip-group')).not.toBeNull();
    expect(card.querySelector('.ab-card-instructor')).not.toBeNull();
    expect(card.querySelector('.ab-card-class').textContent).not.toBe('Cancelled class');
    c.remove();
  });
});
