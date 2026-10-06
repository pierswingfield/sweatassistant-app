import { describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
});

const m = await import('./autoupgrade-setup.js');

describe('auto-upgrade setup helpers', () => {
  it('remembers explainer dismissal', () => {
    expect(m.isExplainerDismissed()).toBe(false);
    m.dismissExplainer();
    expect(m.isExplainerDismissed()).toBe(true);
  });
  it('keep-original is hidden unless the gym enables it', () => {
    expect(m.isKeepOriginalEnabled(undefined)).toBe(false);
    expect(m.isKeepOriginalEnabled(false)).toBe(false);
    expect(m.isKeepOriginalEnabled(true)).toBe(true);
  });
  it('is unticked by default, even when enabled', () => {
    expect(m.keepOriginalInitial(null, true)).toBe(false);
    expect(m.keepOriginalInitial({ keepOriginalOnCutoff: true }, true)).toBe(true);
    expect(m.keepOriginalInitial({ keepOriginalOnCutoff: true }, false)).toBe(false);
  });
  it('auto-created monitors follow the gym default', () => {
    expect(m.keepOriginalForAutoCreate(false)).toBe(false);
    expect(m.keepOriginalForAutoCreate(true)).toBe(true);
  });
  it('summarises preferences', () => {
    expect(m.summarizeSpotPrefs([1, 2, 3], [4], 'bike')).toBe('3 preferred bikes, 1 preferred row');
    expect(m.summarizeSpotPrefs([], [], 'bike')).toBe('No preferred bikes set');
  });
  it('labels the current spot from a string id, never the raw id', () => {
    const slots = [{ id: 36272, label: 'Bike 12' }];
    expect(m.currentSpotLabel(slots, '36272')).toBe('Bike 12');
    expect(m.currentSpotLabel(slots, '999')).toBe('');
  });
});
