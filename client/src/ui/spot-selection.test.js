import { describe, it, expect } from 'vitest';
import { spotSelectionRule, needsSetupIntro, setupIntroCopy } from './spot-selection.js';

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

describe('needsSetupIntro', () => {
  it('only for preference modes, with a seat map, and no saved map', () => {
    expect(needsSetupIntro({ mode: 'quickbook', hasSavedMap: false, hasSeatMap: true })).toBe(true);
    expect(needsSetupIntro({ mode: 'autobook', hasSavedMap: false, hasSeatMap: true })).toBe(true);
    expect(needsSetupIntro({ mode: 'quickbook', hasSavedMap: true, hasSeatMap: true })).toBe(false);
    expect(needsSetupIntro({ mode: 'book', hasSavedMap: false, hasSeatMap: true })).toBe(false);
    expect(needsSetupIntro({ mode: 'quickbook', hasSavedMap: false, hasSeatMap: false })).toBe(false);
  });
});

describe('setupIntroCopy', () => {
  it('uses the exact agreed copy', () => {
    const c = setupIntroCopy({ gymName: 'Psycle', locationName: 'Clapham' });
    expect(c.header).toBe('First-time setup');
    expect(c.sub).toBe('Choose your preferred spots for Psycle Clapham first.');
    expect(c.bodyHtml).toBe('Once set up, <b>Quick-Book</b> and <b>Auto-Book</b> will always book the best possible spot for you.');
    expect(c.next).toBe('Next');
  });
  it('degrades without a location', () => {
    expect(setupIntroCopy({ gymName: 'JAB' }).sub).toBe('Choose your preferred spots for JAB first.');
    expect(setupIntroCopy({}).sub).toBe('Choose your preferred spots for this studio first.');
  });
});
