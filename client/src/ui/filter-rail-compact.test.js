import { describe, it, expect } from 'vitest';
import { compactLocationsLabel, compactInstructorsLabel } from './filter-rail.js';

const locs = [{ id: 1, gymId: 'a' }, { id: 2, gymId: 'a' }, { id: 3, gymId: 'b' }];

describe('compactLocationsLabel', () => {
  it('pluralises picked locations', () => {
    expect(compactLocationsLabel({ gyms: ['a'], locations: ['1'] }, locs)).toBe('1 Location');
    expect(compactLocationsLabel({ gyms: ['a'], locations: ['1', '2'] }, locs)).toBe('2 Locations');
  });
  it('counts every location of the picked gyms when only gyms are chosen', () => {
    expect(compactLocationsLabel({ gyms: ['a'], locations: [] }, locs)).toBe('2 Locations');
    expect(compactLocationsLabel({ gyms: ['b'], locations: [] }, locs)).toBe('1 Location');
  });
  it('is empty when nothing is known, so the chip does not collapse', () => {
    expect(compactLocationsLabel({ gyms: ['z'], locations: [] }, locs)).toBe('');
    expect(compactLocationsLabel({ gyms: [], locations: [] }, [])).toBe('');
  });
});

describe('compactInstructorsLabel (U6-15)', () => {
  it('renders grand total count label with pluralisation', () => {
    expect(compactInstructorsLabel({ instructors: ['a:1', 'b:2'] }, ['a', 'b']))
      .toBe('<b class="fr-num">2</b><span class="fr-thin">Instructors</span>');
  });

  it('renders grand total count with plus when any gym has no filter', () => {
    expect(compactInstructorsLabel({ instructors: ['a:1', 'a:2'] }, ['a', 'b']))
      .toBe('<b class="fr-num">2+</b><span class="fr-thin">Instructors</span>');
  });

  it('renders singular Instructor for 1 instructor without unfiltered gyms', () => {
    expect(compactInstructorsLabel({ instructors: ['a:1'] }, ['a']))
      .toBe('<b class="fr-num">1</b><span class="fr-thin">Instructor</span>');
  });
});
