import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const cache = { bookings: [], waitlists: [] };
const api = { getBookings: vi.fn(), getWaitlists: vi.fn(), getGymBookings: vi.fn() };
vi.mock('../main', () => ({ cache }));
vi.mock('../api', () => ({ api }));
const { installBookingState, mergeGymBookings } = await import('./booking-state.js');

describe('guest chip opens the guest flow directly', () => {
  const src = readFileSync('src/ui/bookings.js', 'utf8');
  it('is not a spot chip, so the Booking Actions listener never fires for it', () => {
    expect(src).toMatch(/class="bk-guest-chip"/);
    expect(src).not.toMatch(/ab-spot-upgrade-chip bk-guest-chip/);
    expect(src).toContain("button.ab-spot-upgrade-chip:not(.bk-guest-chip)");
  });
  it('is labelled "+" with an accessible name', () => {
    expect(src).toMatch(/aria-label="\$\{GUEST_ACTION_LABEL\}" title="\$\{GUEST_ACTION_LABEL\}">\$\{COPY\.bookings\.guestChip\}/);
  });
});

describe('guest mutations re-read bookings from the provider', () => {
  beforeEach(() => {
    cache.bookings = [{ bookingId: 1, gymId: 'jab' }, { bookingId: 2, gymId: 'psycle' }];
    api.getWaitlists.mockResolvedValue([]);
    api.getBookings.mockReset();
    api.getGymBookings.mockReset();
  });
  it('mergeGymBookings replaces only that gym', () => {
    expect(mergeGymBookings(cache.bookings, 'jab', [{ bookingId: 3, gymId: 'jab' }, { bookingId: 4, gymId: 'jab' }]).map((b) => b.bookingId)).toEqual([2, 3, 4]);
  });
  it.each(['bookGuest', 'cancel'])('%s refetches that gym with refresh and notifies', async (type) => {
    api.getGymBookings.mockResolvedValue([{ bookingId: 9, gymId: 'jab' }]);
    const changed = new Promise((r) => window.addEventListener('app-booking-state-changed', r, { once: true }));
    installBookingState();
    window.dispatchEvent(new CustomEvent('app-bookings-mutated', { detail: { type, gymId: 'jab', bookingId: 1 } }));
    await changed;
    expect(api.getGymBookings).toHaveBeenCalledWith('jab', { refresh: true });
    expect(api.getBookings).not.toHaveBeenCalled();
    expect(cache.bookings.map((b) => b.bookingId)).toEqual([2, 9]);
  });
});
