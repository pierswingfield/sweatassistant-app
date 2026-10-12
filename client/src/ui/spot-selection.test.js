import { describe, it, expect } from 'vitest';
import { spotSelectionRule } from './spot-selection.js';

describe('spotSelectionRule (U1-14)', () => {
  it('setting preferences: an occupied spot is selectable', () => {
    expect(spotSelectionRule({ mode: 'quickbook', isAvailable: false })).toEqual({ allowed: true, notice: null });
    expect(spotSelectionRule({ mode: 'autobook', isAvailable: false })).toEqual({ allowed: true, notice: 'will-target' });
  });
  it('a real booking still refuses an occupied spot', () => {
    expect(spotSelectionRule({ mode: 'book', isAvailable: false })).toEqual({ allowed: false, notice: 'occupied' });
  });
  it('available spots are always fine', () => {
    for (const mode of ['book', 'quickbook', 'autobook']) {
      expect(spotSelectionRule({ mode, isAvailable: true })).toEqual({ allowed: true, notice: null });
    }
  });
});
