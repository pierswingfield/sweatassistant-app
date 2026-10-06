import { describe, expect, it, beforeEach, vi } from 'vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  media: '',
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
}));

if (typeof localStorage === 'undefined' || localStorage === null || !localStorage.getItem) {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

const { isAutoUpgradeDefaultEnabled, cache, userSettings } = await import('../main.js');
const { setLinkedGyms } = await import('../gym-context.js');

describe('isAutoUpgradeDefaultEnabled', () => {
  beforeEach(() => {
    cache.gymSettings = {};
    userSettings.autoUpgradeEnabled = true;
    userSettings.autoUpgradeByDefault = true;
    setLinkedGyms([
      { gym_id: 'jab-boxing', capabilities: { autoUpgrade: true } },
      { gym_id: 'psycle-london', capabilities: { autoUpgrade: true } },
      { gym_id: 'no-upgrade-gym', capabilities: { autoUpgrade: false } },
    ]);
  });

  it('returns true when gym settings default to enabled', () => {
    expect(isAutoUpgradeDefaultEnabled('jab-boxing')).toBe(true);
    expect(isAutoUpgradeDefaultEnabled('psycle-london')).toBe(true);
  });

  it('returns false when autoUpgradeByDefault is false in gym settings', () => {
    cache.gymSettings['jab-boxing'] = { autoUpgradeByDefault: false, autoUpgradeEnabled: true };
    expect(isAutoUpgradeDefaultEnabled('jab-boxing')).toBe(false);
    expect(isAutoUpgradeDefaultEnabled('psycle-london')).toBe(true);
  });

  it('returns false when autoUpgradeEnabled is false in gym settings', () => {
    cache.gymSettings['jab-boxing'] = { autoUpgradeByDefault: true, autoUpgradeEnabled: false };
    expect(isAutoUpgradeDefaultEnabled('jab-boxing')).toBe(false);
  });

  it('returns false when both autoUpgradeByDefault and autoUpgradeEnabled are false in gym settings', () => {
    cache.gymSettings['jab-boxing'] = { autoUpgradeByDefault: false, autoUpgradeEnabled: false };
    expect(isAutoUpgradeDefaultEnabled('jab-boxing')).toBe(false);
  });

  it('returns false when gym does not have autoUpgrade capability', () => {
    expect(isAutoUpgradeDefaultEnabled('no-upgrade-gym')).toBe(false);
  });

  it('falls back to userSettings when gym settings are not loaded for a gym', () => {
    userSettings.autoUpgradeByDefault = false;
    expect(isAutoUpgradeDefaultEnabled('psycle-london')).toBe(false);

    userSettings.autoUpgradeByDefault = true;
    userSettings.autoUpgradeEnabled = false;
    expect(isAutoUpgradeDefaultEnabled('psycle-london')).toBe(false);
  });
});
