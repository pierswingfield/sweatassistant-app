import { describe, expect, it } from 'vitest';
import { applyStudioPreferenceMutation, hasStudioPreferences, shouldShowPreferredMapEditToggle } from './studio-preferences-state.js';

describe('studio preference mutation state', () => {
  it('does not show the saved-map edit button in Quick-Book', () => {
    expect(shouldShowPreferredMapEditToggle('quickbook', false)).toBe(false);
    expect(shouldShowPreferredMapEditToggle('autobook', false)).toBe(true);
  });

  it('clears the qualified and matching legacy aliases immediately after deletion', () => {
    const saved = { preferredSlots: [7, 8], preferredRows: [2] };
    const state = { 'psycle-london:138': saved, '138': saved };

    applyStudioPreferenceMutation(state, {
      gymId: 'psycle-london', studioId: 138,
      preferences: { preferredSlots: [], preferredRows: [] },
    });

    expect(state['psycle-london:138']).toEqual({ preferredSlots: [], preferredRows: [] });
    expect(state['138']).toBe(state['psycle-london:138']);
    expect(hasStudioPreferences(state['psycle-london:138'])).toBe(false);
  });

  it('does not overwrite a bare alias owned by another gym', () => {
    const otherGym = { preferredSlots: [99], preferredRows: [] };
    const state = {
      'psycle-london:138': { preferredSlots: [7], preferredRows: [] },
      'jab-boxing:138': otherGym,
      '138': otherGym,
    };

    applyStudioPreferenceMutation(state, {
      gymId: 'psycle-london', studioId: 138,
      preferences: { preferredSlots: [], preferredRows: [] },
    });

    expect(state['138']).toBe(otherGym);
    expect(state['jab-boxing:138']).toBe(otherGym);
  });
});
