import { describe, expect, it } from 'vitest';
import { mapRemovalMessage, mapRemovalWarning } from './spot-map-usage.js';
import { COPY } from '../copy.js';

describe('remove spot map warning', () => {
  it('is the plain confirmation when nothing depends on the map', () => {
    expect(mapRemovalMessage({ autoBooks: 0, autoUpgrades: 0 })).toBe('Confirm remove?');
    expect(mapRemovalMessage(null)).toBe('Confirm remove?');
  });
  it('names both counts', () => {
    const m = mapRemovalMessage({ autoBooks: 3, autoUpgrades: 1 });
    expect(m).toContain('3 Auto-Books and 1 Auto-Upgrade use this map');
    expect(m.endsWith('Confirm remove?')).toBe(true);
  });
  it('singular and single-kind wording', () => {
    expect(mapRemovalMessage({ autoBooks: 1, autoUpgrades: 0 })).toContain('1 Auto-Book uses this map');
    expect(mapRemovalMessage({ autoBooks: 0, autoUpgrades: 2 })).toContain('2 Auto-Upgrades use this map');
  });
});

describe('remove warning grammar', () => {
  it('agrees the pronoun with the count and has no confirm line', () => {
    expect(mapRemovalWarning({ autoBooks: 1 })).toBe('1 Auto-Book uses this map. It will book any spot (or skip) without a map.');
    expect(mapRemovalWarning({ autoBooks: 2 })).toBe('2 Auto-Books use this map. They will book any spot (or skip) without a map.');
    expect(mapRemovalWarning({ autoUpgrades: 1 })).toBe('1 Auto-Upgrade uses this map. It will stop without a map.');
    expect(mapRemovalWarning({})).toBe('');
  });
});

describe('edit Auto-Book with no map copy', () => {
  it('has the no-map message and link label', () => {
    expect(COPY.bookingFlow.noPreferredMap).toBe('No preferred spot map for this studio');
    expect(COPY.bookingFlow.setPreferredSpots).toBe('Set preferred spots');
  });
});
