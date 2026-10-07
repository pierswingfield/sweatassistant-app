// C2-4: an empty filtered grid while a selected gym has not delivered yet is
// "still loading", not "no classes". Pure rule; timetable.js wires it.
import { describe, it, expect } from 'vitest';
import { shouldShowPendingSkeleton } from './pending-gyms.js';

describe('shouldShowPendingSkeleton', () => {
  it('shows the skeleton when a gym the filters select is still pending', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: ['jab-boxing'], selectedGyms: ['jab-boxing'], visibleCount: 0 })).toBe(true);
  });
  it('treats an empty gym selection as every gym', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: ['aarmy'], selectedGyms: [], visibleCount: 0 })).toBe(true);
  });
  it('ignores a pending gym the filters exclude', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: ['aarmy'], selectedGyms: ['jab-boxing'], visibleCount: 0 })).toBe(false);
  });
  it('shows the real empty state once every gym has settled', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: [], selectedGyms: [], visibleCount: 0 })).toBe(false);
  });
  it('never covers rows that are already visible', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: ['jab-boxing'], selectedGyms: [], visibleCount: 3 })).toBe(false);
  });
  it('null pending (no flush yet) counts as everything pending', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: null, selectedGyms: ['jab-boxing'], visibleCount: 0 })).toBe(true);
  });
  it('compares ids as strings', () => {
    expect(shouldShowPendingSkeleton({ pendingGyms: [7], selectedGyms: ['7'], visibleCount: 0 })).toBe(true);
  });
});
