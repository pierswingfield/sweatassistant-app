import { describe, it, expect } from 'vitest';
import { compactLocationsLabel } from './filter-rail.js';

const locs = [{ id: 1, gymId: 'a' }, { id: 2, gymId: 'a' }, { id: 3, gymId: 'b' }];

describe('compactLocationsLabel', () => {
  it('pluralises picked locations', () => {
    expect(compactLocationsLabel({ gyms: ['a'], locations: ['1'] }, locs)).toBe('1 location');
    expect(compactLocationsLabel({ gyms: ['a'], locations: ['1', '2'] }, locs)).toBe('2 locations');
  });
  it('counts every location of the picked gyms when only gyms are chosen', () => {
    expect(compactLocationsLabel({ gyms: ['a'], locations: [] }, locs)).toBe('2 locations');
    expect(compactLocationsLabel({ gyms: ['b'], locations: [] }, locs)).toBe('1 location');
  });
  it('is empty when nothing is known, so the chip does not collapse', () => {
    expect(compactLocationsLabel({ gyms: ['z'], locations: [] }, locs)).toBe('');
    expect(compactLocationsLabel({ gyms: [], locations: [] }, [])).toBe('');
  });
});
