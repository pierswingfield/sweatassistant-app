import { describe, expect, it } from 'vitest';
import { bookingSpotActions } from './booking-spot-actions.js';

describe('booking spot action chooser', () => {
  it('offers change, enable and cancel when Auto-Upgrade is available but inactive', () => {
    expect(bookingSpotActions({ canAutoUpgrade: true, hasActiveUpgrade: false }))
      .toEqual([
        { id: 'change-spot', label: 'Change spot' },
        { id: 'auto-upgrade', label: 'Enable Auto-Upgrade' },
        { id: 'cancel', label: 'Cancel', danger: true },
      ]);
  });

  it('changes the available Auto-Upgrade action to disable for an active monitor', () => {
    expect(bookingSpotActions({ canAutoUpgrade: true, hasActiveUpgrade: true })[1])
      .toEqual({ id: 'auto-upgrade', label: 'Disable Auto-Upgrade' });
  });

  it('keeps change and cancel when the gym has no Auto-Upgrade capability', () => {
    expect(bookingSpotActions({ canAutoUpgrade: false, hasActiveUpgrade: false }).map(({ id }) => id))
      .toEqual(['change-spot', 'cancel']);
  });
});
