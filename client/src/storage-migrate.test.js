import { describe, it, expect } from 'vitest';
import { migrateLegacyStorage, removeStored, newKeyFor, legacyKeyFor, copyLegacyDatabase, MIGRATED_MARKER } from './storage-migrate.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

describe('migrateLegacyStorage', () => {
  it('old-only: copies to the new key and keeps the old one', () => {
    const s = fakeStorage({ psycleLocalToken: 'tok', psycleUserId: '7', psycleTheme: 'dark' });
    expect(migrateLegacyStorage(s)).toBe(3);
    expect(s.getItem('sweatLocalToken')).toBe('tok');
    expect(s.getItem('sweatUserId')).toBe('7');
    expect(s.getItem('sweatTheme')).toBe('dark');
    expect(s.getItem('psycleLocalToken')).toBe('tok');
  });
  it('new-only: untouched', () => {
    const s = fakeStorage({ sweatLocalToken: 'new' });
    expect(migrateLegacyStorage(s)).toBe(0);
    expect(s.getItem('sweatLocalToken')).toBe('new');
    expect(s.getItem('psycleLocalToken')).toBeNull();
  });
  it('both: the new value wins', () => {
    const s = fakeStorage({ psycleLocalToken: 'old', sweatLocalToken: 'new' });
    migrateLegacyStorage(s);
    expect(s.getItem('sweatLocalToken')).toBe('new');
  });
  it('none: only the marker is written', () => {
    const s = fakeStorage();
    expect(migrateLegacyStorage(s)).toBe(0);
    expect(s.dump()).toEqual({ [MIGRATED_MARKER]: '1' });
  });
  it('carries suffixed keys (onboarding, unified caches, helper dismissals)', () => {
    const s = fakeStorage({
      'psycleOnboardingComplete:42': '2', 'psycleOnboardingStep:42': 'login',
      'psycleUnifiedDefaultFilters:42': '{"a":1}', 'psycleHelperDismissed:jab': '1',
    });
    migrateLegacyStorage(s);
    expect(s.getItem('sweatOnboardingComplete:42')).toBe('2');
    expect(s.getItem('sweatOnboardingStep:42')).toBe('login');
    expect(s.getItem('sweatUnifiedDefaultFilters:42')).toBe('{"a":1}');
    expect(s.getItem('sweatHelperDismissed:jab')).toBe('1');
  });
  it('runs once: a value removed after migration is not resurrected from the old copy', () => {
    const s = fakeStorage({ psycleLocalToken: 'tok' });
    migrateLegacyStorage(s);
    s.removeItem('sweatLocalToken');
    migrateLegacyStorage(s);
    expect(s.getItem('sweatLocalToken')).toBeNull();
  });
  it('leaves unrelated keys (gym ids, extension favourites) alone', () => {
    const s = fakeStorage({ 'psycle-helper-favorites': '[1]', sweatCreditsTabHint: '1' });
    expect(migrateLegacyStorage(s)).toBe(0);
    expect(s.getItem('psycle-helper-favorites')).toBe('[1]');
  });
  it('tolerates blocked storage', () => {
    const bad = { getItem() { throw new Error('blocked'); } };
    expect(() => migrateLegacyStorage(bad)).not.toThrow();
  });
});

describe('removeStored / key maps', () => {
  it('removes the new key and its legacy twin (logout leaves no token behind)', () => {
    const s = fakeStorage({ psycleLocalToken: 'a', sweatLocalToken: 'a' });
    removeStored('sweatLocalToken', s);
    expect(s.dump()).toEqual({});
  });
  it('maps both directions', () => {
    expect(newKeyFor('psycleCacheTime')).toBe('sweatCacheTime');
    expect(legacyKeyFor('sweatCacheTime')).toBe('psycleCacheTime');
    expect(newKeyFor('something')).toBeNull();
  });
});

describe('copyLegacyDatabase', () => {
  it('is a no-op when the browser cannot list databases', async () => {
    expect(await copyLegacyDatabase({}, {})).toBe(0);
  });
  it('is a no-op when there is no legacy database', async () => {
    expect(await copyLegacyDatabase({ databases: async () => [{ name: 'sweat-cache' }] }, {})).toBe(0);
  });
});
