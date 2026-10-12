import { describe, it, expect } from 'vitest';
import {
  scheduledGuestLimit, placeOptions, guestSlotCount, placesLabel, seedGuestDrafts, validateGuestDrafts, buildGuests,
} from './booking-limits.js';
import { guestFieldsHtml } from './guest-fields.js';

// [Claude 2026-10-11] Guests are the places above the self limit; no checkbox.
describe('guest places', () => {
  const mt = { selfLimit: 1, guestLimit: scheduledGuestLimit({ selfLimit: 1, guestSupported: true }) };
  const psycle = { selfLimit: 4, guestLimit: scheduledGuestLimit({ selfLimit: 4, guestSupported: false }) };

  it('offers self + one guest place on a one-self gym that supports guests', () => {
    expect(mt.guestLimit).toBe(1);
    expect(placeOptions(mt)).toEqual([1, 2]);
  });

  it('count above the self limit maps to guest slots', () => {
    expect(guestSlotCount({ qty: 1, ...mt })).toBe(0);
    expect(guestSlotCount({ qty: 2, ...mt })).toBe(1);
    expect(guestSlotCount({ qty: 9, ...mt })).toBe(1); // never above the supported guest limit
  });

  it('labels make the guest explicit', () => {
    expect(placesLabel(1, mt)).toBe('1 place (you)');
    expect(placesLabel(2, mt)).toBe('2 places (you + 1 guest)');
  });

  it('multi-self gyms (Psycle) get plain numbers and never a guest field', () => {
    expect(psycle.guestLimit).toBe(0);
    expect(placeOptions(psycle)).toEqual([1, 2, 3, 4]);
    expect(guestSlotCount({ qty: 4, ...psycle })).toBe(0);
    expect(placesLabel(3, psycle)).toBe('3');
    expect(guestFieldsHtml({ idPrefix: 'x', count: guestSlotCount({ qty: 4, ...psycle }) })).toBe('');
  });

  it('guests are not offered when the self limit is above one or guests are unsupported', () => {
    expect(scheduledGuestLimit({ selfLimit: 2, guestSupported: true })).toBe(0);
    expect(scheduledGuestLimit({ selfLimit: 1, guestSupported: false })).toBe(0);
    expect(scheduledGuestLimit({ selfLimit: 1 })).toBe(0);
  });

  it('requires a valid email for each guest place', () => {
    expect(validateGuestDrafts([], 0).ok).toBe(true);
    expect(validateGuestDrafts([{ email: '' }], 1)).toMatchObject({ ok: false });
    expect(validateGuestDrafts([{ email: 'nope' }], 1)).toMatchObject({ ok: false });
    expect(validateGuestDrafts([{ email: 'pal@example.com' }], 1).ok).toBe(true);
    expect(validateGuestDrafts([{ email: 'a@b.co' }, { email: 'A@B.co' }], 2).ok).toBe(false);
  });

  it('seeds an edit with the existing guest and resizes with the count', () => {
    const existing = [{ email: 'pal@example.com', name: 'Pal' }];
    expect(seedGuestDrafts(existing, 1)).toEqual([{ email: 'pal@example.com', name: 'Pal' }]);
    expect(seedGuestDrafts(existing, 0)).toEqual([]);
    expect(seedGuestDrafts(existing, 2)[1]).toEqual({ email: '', name: null });
  });

  it('keeps a booked guest name only while the email is unchanged', () => {
    const seeded = [{ email: 'pal@example.com', name: 'Pal' }];
    expect(buildGuests([{ email: ' PAL@example.com ' }], 1, seeded)).toEqual([{ email: 'PAL@example.com', name: 'Pal' }]);
    expect(buildGuests([{ email: 'new@example.com' }], 1, seeded)).toEqual([{ email: 'new@example.com', name: null }]);
    expect(buildGuests([{ email: 'x@y.zz' }], 0, seeded)).toEqual([]);
  });

  it('renders one email input per guest place and no name field', () => {
    const html = guestFieldsHtml({ idPrefix: 'autobook', drafts: [{ email: 'a@b.co' }], count: 1 });
    expect(html).toContain('type="email"');
    expect(html).toContain('required');
    expect(html).not.toContain('guest-name');
    expect((html.match(/<input/g) || []).length).toBe(1);
  });
});
