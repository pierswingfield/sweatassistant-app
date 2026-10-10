import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { canOfferGuestAction, guestUnavailableMessage } from './guest-access.js';
import { describeCancelPenalty, loadCancelInfo } from './cancel-penalty-info.js';

describe('direct Guest action on a booking card', () => {
  it('offered when the gym supports guests and none is booked', () => {
    expect(canOfferGuestAction({ supported: true, bookings: [{ isGuest: false }] })).toBe(true);
  });
  it('hidden when unsupported or a guest is already booked', () => {
    expect(canOfferGuestAction({ supported: false, bookings: [{}] })).toBe(false);
    expect(canOfferGuestAction({ supported: true, bookings: [{}, { isGuest: true }] })).toBe(false);
  });
});

describe('guest unavailable reasons', () => {
  it('names the actual reason, with the generic text only as a last resort', () => {
    expect(guestUnavailableMessage('GUEST_ALREADY_BOOKED')).toContain('One guest per class');
    expect(guestUnavailableMessage('NO_GUEST_PASSES')).toContain('no guest passes or credits');
    expect(guestUnavailableMessage('GUEST_BOOKING_UNSUPPORTED')).toContain("doesn't offer guest");
    expect(guestUnavailableMessage('SOMETHING_NEW')).toBe(COPY.bookings.guestBookingUnavailable);
    expect(guestUnavailableMessage(undefined)).toBe(COPY.bookings.guestBookingUnavailable);
  });
});

describe('cancel penalty description', () => {
  it('free, penalty, with provider message and deadline', () => {
    expect(describeCancelPenalty({ isPenalty: false })).toEqual({ kind: 'free', text: 'Free to cancel.' });
    const p = describeCancelPenalty({ isPenalty: true, message: 'You will lose a credit.', deadline: '6pm the evening before' });
    expect(p.kind).toBe('penalty');
    expect(p.text).toContain('You will lose a credit.');
    expect(p.text).toContain('6pm the evening before');
  });
  it('unknown never implies free', async () => {
    expect(describeCancelPenalty(null).kind).toBe('unknown');
    expect(describeCancelPenalty({}).text).toMatch(/couldn't check/);
    const info = await loadCancelInfo({ getCancelPenalty: async () => { throw new Error('x'); } }, 1, 'g');
    expect(info.kind).toBe('unknown');
    expect(info.text).not.toMatch(/free/i);
  });
});
