import { describe, expect, it, vi } from 'vitest';
import { claimAutoUpgradeTipOnce, hasDisabledAutoUpgradeGym } from './autoupgrade-tip.js';
import { COPY } from '../copy.js';

const canUpgrade = (_capability, id) => id !== 'unsupported';

describe('Auto-Upgrade tip eligibility', () => {
  it('uses the requested concise tip copy', () => {
    expect(COPY.timetable.autoUpgradeTip).toBe('💡 Tip: Enable Auto-Upgrade in gym settings so I can automatically grab you a better spot when one becomes available!');
  });

  it('does not prompt when no linked gym supports Auto-Upgrade', () => {
    expect(hasDisabledAutoUpgradeGym([{ id: 'unsupported' }], vi.fn(canUpgrade), vi.fn(() => false))).toBe(false);
  });

  it('prompts if any supporting linked gym has the engine disabled', () => {
    expect(hasDisabledAutoUpgradeGym(
      [{ gym_id: 'jab' }, { id: 'psycle' }],
      vi.fn(() => true),
      (id) => id === 'jab' ? false : true,
    )).toBe(true);
  });

  it('does not prompt when all supporting linked gyms have the engine enabled', () => {
    expect(hasDisabledAutoUpgradeGym(
      [{ gym_id: 'jab' }, { id: 'psycle' }, { id: 'unsupported' }],
      vi.fn(canUpgrade),
      () => true,
    )).toBe(false);
  });

  it('claims display once and persists the shown state', () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    };
    expect(claimAutoUpgradeTipOnce(storage, 'tip:account-1')).toBe(true);
    expect(claimAutoUpgradeTipOnce(storage, 'tip:account-1')).toBe(false);
    expect(values.get('tip:account-1')).toBe('1');
  });
});
