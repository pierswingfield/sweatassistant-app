import { describe, it, expect, vi } from 'vitest';
import { renderGymSettingsSection } from './gym-settings-section.js';

const baseGym = {
  id: 'test-gym',
  name: 'Test Gym',
  gym_email: 'member@example.com',
  status: 'active',
  capabilities: { metered: true, creditPurchase: true, bookingWindow: 'rolling-weekly' },
};

describe('renderGymSettingsSection', () => {
  it('carries no gym-switching affordance', () => {
    // The app shows every linked gym in every list at once, so there is nothing
    // to switch between. A switch control here would imply the other gym's
    // classes are hidden until you flip it, which is false. This test exists
    // because the switcher was removed deliberately, not incidentally.
    const root = document.createElement('div');
    renderGymSettingsSection(root, { gym: baseGym, settings: {}, credits: [] });
    expect(root.querySelector('[data-switch-gym]')).toBeNull();
    expect(root.querySelector('[data-gym-action="switch"]')).toBeNull();
    expect(root.textContent).not.toMatch(/\bSwitch\b/);
  });

  it('renders all gym-owned concerns into one reusable root', () => {
    const root = document.createElement('div');
    renderGymSettingsSection(root, {
      gym: baseGym,
      settings: { autoUpgradeEnabled: true, autoUpgradeInterval: '15min' },
      credits: [{ count: 4 }, { count: 3 }],
      bookingWindowText: '15 days',
      debugMode: true,
    });

    expect(root.textContent).toContain('Connection');
    expect(root.textContent).toContain('7 credits available');
    expect(root.textContent).toContain('15 days');
    expect(root.textContent).toContain('Auto-Upgrade Engine');
    expect(root.textContent).toContain('Preferred Spot Maps');
    expect(root.textContent).toContain('Profile Explorer');
    // The calendar feed is ACCOUNT-level (ui/calendar-section.js), so a gym
    // section must NOT render one: a card here is how a two-gym member ended up
    // with two .ics URLs each covering part of their week.
    expect(root.querySelector('[data-calendar-action]')).toBeNull();
    expect(root.querySelector('[data-calendar-setting]')).toBeNull();
    expect(root.querySelector('[data-gym-setting="manualBookingWindowWeeks"]')).not.toBeNull();
  });

  it('renders membership and a per-class window without a manual override', () => {
    const root = document.createElement('div');
    renderGymSettingsSection(root, {
      gym: { ...baseGym, capabilities: { metered: false, creditPurchase: false, bookingWindow: 'per-class' } },
      settings: {},
      membership: { name: 'Rolling Monthly', status: 'Active', guestPassesRemaining: 2 },
      calendar: {},
      debugMode: true,
    });

    expect(root.textContent).toContain('Rolling Monthly');
    expect(root.textContent).toContain('2 guest passes left');
    expect(root.textContent).toContain('Published per class');
    expect(root.querySelector('[data-gym-setting="manualBookingWindowWeeks"]')).toBeNull();
    expect(root.querySelector('[data-gym-action="buy-credits"]')).toBeNull();
  });

  it('binds actions and per-gym setting changes', () => {
    const root = document.createElement('div');
    const onAction = vi.fn();
    const onSettingChange = vi.fn();
    renderGymSettingsSection(root, { gym: baseGym, settings: {}, calendar: {} }, { onAction, onSettingChange });

    root.querySelector('[data-gym-action="profile"]').click();
    const enabled = root.querySelector('[data-gym-setting="autoUpgradeEnabled"]');
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change'));

    expect(onAction).toHaveBeenCalledWith('profile', expect.any(HTMLButtonElement));
    expect(onSettingChange).toHaveBeenCalledWith('autoUpgradeEnabled', false, enabled);
  });

  it('surfaces a relogin state and applies the gym accent without hiding settings', () => {
    const root = document.createElement('div');
    renderGymSettingsSection(root, {
      gym: { ...baseGym, status: 'needs_relogin', theme: { primary: '#123456' } },
      settings: {}, calendar: {},
    });

    expect(root.textContent).toContain('Re-authentication needed');
    expect(root.textContent).toContain('Reconnect this gym');
    // The gym's theme-aware token wins, with the raw config hex as the fallback
    // inside the var() — a gym without a token block still gets its brand colour.
    expect(root.style.getPropertyValue('--gym-settings-accent'))
      .toBe('var(--gym-test-gym-ink, #123456)');
    expect(root.querySelector('[data-gym-action="reauth"]')).not.toBeNull();
  });
});
