import { describe, expect, it, vi } from 'vitest';
import { coldBootDestination, enableAutoUpgradeForGyms, getPostLoginDestination, shouldAnimateGymLogos, detectInstallContext, shouldOfferInstall } from './onboarding-routing.js';

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

describe('install-to-home-screen detection', () => {
  const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36';
  const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  it('classifies the mobile browsers', () => {
    expect(detectInstallContext({ userAgent: IOS_SAFARI }).platform).toBe('ios-safari');
    expect(detectInstallContext({ userAgent: IOS_CHROME }).platform).toBe('ios-other');
    expect(detectInstallContext({ userAgent: ANDROID_CHROME }).platform).toBe('android-chrome');
    expect(detectInstallContext({ userAgent: SAMSUNG }).platform).toBe('android-samsung');
    expect(detectInstallContext({ userAgent: DESKTOP }).mobile).toBe(false);
  });

  it('treats iPadOS (desktop UA + touch) and narrow touch devices as mobile', () => {
    expect(detectInstallContext({ userAgent: DESKTOP, maxTouchPoints: 5 }).platform).toBe('ios-safari');
    expect(detectInstallContext({ userAgent: 'Unknown', maxTouchPoints: 2, viewportWidth: 400 }).mobile).toBe(true);
    expect(detectInstallContext({ userAgent: 'Unknown', maxTouchPoints: 2, viewportWidth: 1400 }).mobile).toBe(false);
  });

  it('offers the step to mobile browser tabs until the persistent dismissal exists', () => {
    const ctx = detectInstallContext({ userAgent: IOS_SAFARI });
    expect(shouldOfferInstall(ctx)).toBe(true);
    expect(shouldOfferInstall(ctx, false)).toBe(true);
    expect(shouldOfferInstall(ctx, true)).toBe(false);
    expect(shouldOfferInstall(detectInstallContext({ userAgent: IOS_SAFARI, standalone: true }), false)).toBe(false);
    expect(shouldOfferInstall(detectInstallContext({ userAgent: IOS_SAFARI, displayStandalone: true }), false)).toBe(false);
    expect(shouldOfferInstall(detectInstallContext({ userAgent: DESKTOP }), false)).toBe(false);
  });

});

describe('cold-boot destination', () => {
  it('does not bring the optional setup back once the account dismissed it', () => {
    expect(coldBootDestination('optional', true)).toBe('home');
  });
  it('still shows the optional setup to an account that has not dismissed it', () => {
    expect(coldBootDestination('optional', false)).toBe('optional');
  });
  it('never suppresses the full flow or changes home', () => {
    expect(coldBootDestination('full', true)).toBe('full');
    expect(coldBootDestination('home', true)).toBe('home');
    expect(coldBootDestination(null, true)).toBe(null);
  });
});
