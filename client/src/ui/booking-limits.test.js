import { describe, expect, it } from 'vitest';
import { bookingQuantityOptions, maxAttendeesPerClass, normalizeGroupOptions, applyTogetherChange, applyCountChange, applyFallbackChange, showTogetherOption, autoBookEditDirty } from './booking-limits.js';

describe('per-class attendee limits', () => {
  it('turns a resolved one-self-booking entitlement into no quantity choice', () => {
    expect(bookingQuantityOptions(1)).toEqual([1]);
  });

  it('does not invent extra choices when no provider or gym allowance is known', () => {
    expect(maxAttendeesPerClass()).toBe(1);
    expect(bookingQuantityOptions()).toEqual([1]);
  });

  it('uses the stricter available provider or gym cap', () => {
    expect(maxAttendeesPerClass({ gymLimit: 3, providerLimit: 2 })).toBe(2);
    expect(bookingQuantityOptions(2)).toEqual([1, 2]);
  });

  it('does not truncate a provider-published allowance to four', () => {
    expect(maxAttendeesPerClass({ providerLimit: 6 })).toBe(6);
    expect(bookingQuantityOptions(6)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('group options', () => {
  it('clears togetherness at count 1 so no invisible flag forces book-any', () => {
    expect(normalizeGroupOptions({ qty: 1, bookAny: false, prioritizeTogether: true }))
      .toEqual({ prioritizeTogether: false, bookAny: false });
  });
  it('forces book-any when togetherness is on for a group', () => {
    expect(normalizeGroupOptions({ qty: 2, bookAny: false, prioritizeTogether: true }))
      .toEqual({ prioritizeTogether: true, bookAny: true });
    expect(normalizeGroupOptions({ qty: 3, bookAny: false, prioritizeTogether: false }))
      .toEqual({ prioritizeTogether: false, bookAny: false });
  });
});

describe('group option transitions', () => {
  const base = { qty: 1, bookAny: false, prioritizeTogether: false, bookAnyRestore: null };
  it('count back to 1 clears togetherness and restores a book-any the member had off', () => {
    let s = applyCountChange(base, 2);
    s = applyTogetherChange(s, true);
    expect(s).toMatchObject({ prioritizeTogether: true, bookAny: true });
    s = applyCountChange(s, 1);
    expect(s).toMatchObject({ qty: 1, prioritizeTogether: false, bookAny: false, bookAnyRestore: null });
  });
  it('keeps a book-any the member set themselves', () => {
    let s = applyCountChange({ ...base, bookAny: true }, 2);
    s = applyTogetherChange(s, true);
    s = applyCountChange(s, 1);
    expect(s).toMatchObject({ prioritizeTogether: false, bookAny: true });
  });
  it('unticking togetherness releases the forced book-any; unticking fallback clears togetherness', () => {
    const s = applyTogetherChange(applyCountChange(base, 3), true);
    expect(applyTogetherChange(s, false)).toMatchObject({ prioritizeTogether: false, bookAny: false });
    expect(applyFallbackChange(s, false)).toMatchObject({ prioritizeTogether: false, bookAny: false });
  });
});

describe('edit Auto-Book: together option and dirty state', () => {
  const base = { qty: 2, bookAny: true, prioritizeTogether: true, guestEmails: [], autoUpgrade: false, slots: ['1', '2'], rows: [] };
  it('shows the together option for any total of 2+ places, guests included', () => {
    expect(showTogetherOption({ qty: 2, guestPlaces: 0 })).toBe(true);
    expect(showTogetherOption({ qty: 3, guestPlaces: 1 })).toBe(true);
    expect(showTogetherOption({ qty: 1, guestPlaces: 0 })).toBe(false);
    expect(showTogetherOption({ qty: 2, guestPlaces: 1 })).toBe(true); // you + 1 guest sit together too
  });
  it('is clean when nothing changed, and when a change is reverted', () => {
    expect(autoBookEditDirty(base, { ...base })).toBe(false);
    expect(autoBookEditDirty(base, { ...base, qty: 3 })).toBe(true);
    expect(autoBookEditDirty(base, { ...base, qty: 3 })).toBe(true);
    expect(autoBookEditDirty(base, { ...base, qty: 2 })).toBe(false);
  });
  it('detects option, guest, map and priority-order changes', () => {
    expect(autoBookEditDirty(base, { ...base, prioritizeTogether: false })).toBe(true);
    expect(autoBookEditDirty(base, { ...base, autoUpgrade: true })).toBe(true);
    expect(autoBookEditDirty(base, { ...base, slots: ['2', '1'] })).toBe(true);
    expect(autoBookEditDirty(base, { ...base, slots: ['1'] })).toBe(true);
    expect(autoBookEditDirty(base, { ...base, rows: [3] })).toBe(true);
    const g = { ...base, qty: 2, prioritizeTogether: false, guestEmails: ['a@b.co'] };
    expect(autoBookEditDirty(g, { ...g, guestEmails: [' A@B.co '] })).toBe(false);
    expect(autoBookEditDirty(g, { ...g, guestEmails: ['c@d.co'] })).toBe(true);
  });
  it('ignores togetherness that cannot apply (one place) and the forced fallback', () => {
    const one = { ...base, qty: 1, prioritizeTogether: false };
    expect(autoBookEditDirty(one, { ...one, prioritizeTogether: true })).toBe(false);
    expect(autoBookEditDirty({ ...base, bookAny: false }, { ...base, bookAny: true })).toBe(false);
  });
});
