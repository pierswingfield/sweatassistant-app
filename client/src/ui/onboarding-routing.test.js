import { describe, expect, it, vi } from 'vitest';
import { enableAutoUpgradeForGyms, getPostLoginDestination, shouldAnimateGymLogos } from './onboarding-routing.js';

describe('post-login onboarding destination', () => {
  it('keeps the full flow when no gyms are connected', () => {
    expect(getPostLoginDestination({ linkedGymCount: 0 })).toBe('full');
  });

  it('opens optional setup when any required feature is missing', () => {
    expect(getPostLoginDestination({ linkedGymCount: 2, hasPreferredSpotMap: true, calendarEnabled: true })).toBe('optional');
    expect(getPostLoginDestination({ linkedGymCount: 1, calendarEnabled: true, notificationsEnabled: true })).toBe('optional');
    expect(getPostLoginDestination({ linkedGymCount: 1, hasPreferredSpotMap: true, notificationsEnabled: true })).toBe('optional');
  });

  it('skips onboarding when every required feature is set up', () => {
    expect(getPostLoginDestination({ linkedGymCount: 1, hasPreferredSpotMap: true, calendarEnabled: true, notificationsEnabled: true })).toBe('home');
  });
});

describe('enableAutoUpgradeForGyms', () => {
  const catalogue = [
    { id: 'alpha', capabilities: { autoUpgrade: true } },
    { id: 'beta', capabilities: { autoUpgrade: false } },
    { id: 'gamma' },
  ];

  it('enables each unique connected, configured, eligible gym with explicit gym scope', async () => {
    const update = vi.fn().mockResolvedValue({});
    const result = await enableAutoUpgradeForGyms(
      [{ gym_id: 'alpha' }, { gym_id: 'alpha' }, { gym_id: 'beta' }, { gym_id: 'gamma' }, { gym_id: 'unknown' }],
      catalogue,
      update,
    );
    expect(update.mock.calls).toEqual([
      [{ autoUpgradeEnabled: true }, 'alpha'],
      [{ autoUpgradeEnabled: true }, 'gamma'],
    ]);
    expect(result).toEqual({ enabledGymIds: ['alpha', 'gamma'], failedGymIds: [] });
  });

  it('safely does nothing when there are no eligible gyms and reports partial failures', async () => {
    const update = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await enableAutoUpgradeForGyms([{ gym_id: 'beta' }], catalogue, update))
      .toEqual({ enabledGymIds: [], failedGymIds: [] });
    expect(update).not.toHaveBeenCalled();
    expect(await enableAutoUpgradeForGyms([{ gym_id: 'alpha' }], catalogue, update))
      .toEqual({ enabledGymIds: [], failedGymIds: ['alpha'] });
  });
});

describe('gym logo strip mode', () => {
  it('is static for 3 or fewer gyms and a marquee for more', () => {
    expect([0, 1, 2, 3].map(shouldAnimateGymLogos)).toEqual([false, false, false, false]);
    expect([4, 5, 12].map(shouldAnimateGymLogos)).toEqual([true, true, true]);
  });
});
