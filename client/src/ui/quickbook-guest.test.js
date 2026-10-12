import { describe, expect, it, vi } from 'vitest';
import { bookGuestAfterPrimary } from './quickbook-guest.js';

const guest = { email: 'g@example.com' };

describe('quick-book named guest', () => {
  it('skips cleanly with no guest', async () => {
    const bookGuest = vi.fn();
    expect(await bookGuestAfterPrimary({ guest: null, bookGuest, eventId: 1, gymId: 'g' })).toEqual({ attempted: false, ok: true });
    expect(bookGuest).not.toHaveBeenCalled();
  });
  it('makes exactly one guest request; a rejected result reports the split without retry', async () => {
    const bookGuest = vi.fn(async () => ({ ok: false, error: 'No guest pass' }));
    const out = await bookGuestAfterPrimary({ guest, bookGuest, eventId: 1, slotId: 4, gymId: 'g' });
    expect(out).toEqual({ attempted: true, ok: false, message: 'No guest pass' });
    expect(bookGuest).toHaveBeenCalledTimes(1);
    expect(bookGuest).toHaveBeenCalledWith(1, 4, 'g@example.com', 'g');
  });
  it('a thrown guest error never propagates (primary stays booked)', async () => {
    const bookGuest = vi.fn(async () => { throw new Error('boom'); });
    const out = await bookGuestAfterPrimary({ guest, bookGuest, eventId: 1, gymId: 'g' });
    expect(out).toMatchObject({ attempted: true, ok: false, message: 'boom' });
  });
});
