import { describe, it, expect } from 'vitest';
import {
  instructorToken, parseInstructorToken, migrateInstructorSelection, passesInstructorFilter,
  pruneInstructorSelection, findInstructor, serializeInstructorParam, parseInstructorParam, hasLegacyInstructors,
  addInstructorSearchFilter,
} from './instructor-filter.js';

const pool = [
  { id: '1', gymId: 'psy' }, { id: '2', gymId: 'psy' }, { id: '5', gymId: 'psy' },
  { id: '5', gymId: 'jab' }, { id: '9', gymId: 'jab' },
];

describe('tokens', () => {
  it('round-trips and rejects bare/malformed', () => {
    expect(parseInstructorToken(instructorToken('psy', 12))).toEqual({ gymId: 'psy', id: '12' });
    expect(parseInstructorToken('12')).toBeNull();
    expect(parseInstructorToken(':3')).toBeNull();
    expect(parseInstructorToken('psy:')).toBeNull();
  });
});

describe('passesInstructorFilter', () => {
  const sel = ['psy:1'];
  it('restricts only the gym that has picks', () => {
    expect(passesInstructorFilter(sel, 'psy', ['1'])).toBe(true);
    expect(passesInstructorFilter(sel, 'psy', ['2'])).toBe(false);
    expect(passesInstructorFilter(sel, 'jab', ['9'])).toBe(true);
  });
  it('restricts both gyms independently', () => {
    const both = ['psy:1', 'jab:9'];
    expect(passesInstructorFilter(both, 'jab', ['5'])).toBe(false);
    expect(passesInstructorFilter(both, 'jab', ['9'])).toBe(true);
    expect(passesInstructorFilter(both, 'psy', ['2'])).toBe(false);
  });
  it('never matches across gyms (colliding ids)', () => {
    expect(passesInstructorFilter(['psy:5'], 'jab', ['5'])).toBe(true);   // jab unrestricted
    expect(passesInstructorFilter(['psy:5', 'jab:9'], 'jab', ['5'])).toBe(false);
  });
  it('empty selection passes everything; no instructor fails a restricted gym', () => {
    expect(passesInstructorFilter([], 'psy', [])).toBe(true);
    expect(passesInstructorFilter(sel, 'psy', [])).toBe(false);
  });
  it('accepts numeric ids and a scalar', () => {
    expect(passesInstructorFilter(sel, 'psy', 1)).toBe(true);
  });
});

describe('migrateInstructorSelection', () => {
  it('attributes a unique bare id to its gym', () => {
    expect(migrateInstructorSelection(['9', '1'], pool, 'psy')).toEqual(['jab:9', 'psy:1']);
  });
  it('ambiguous and unknown go to the default gym', () => {
    expect(migrateInstructorSelection(['5', '777'], pool, 'psy')).toEqual(['psy:5', 'psy:777']);
  });
  it('keeps tokens, de-dupes, never drops', () => {
    expect(migrateInstructorSelection(['psy:1', '1', 'jab:9'], pool, 'psy')).toEqual(['psy:1', 'jab:9']);
    expect(migrateInstructorSelection(['3'], [], undefined)).toEqual(['3']);
    expect(hasLegacyInstructors(['psy:1', '2'])).toBe(true);
    expect(hasLegacyInstructors(['psy:1'])).toBe(false);
  });
});

describe('helpers', () => {
  it('prune, find, url shape', () => {
    expect(pruneInstructorSelection(['psy:1', 'jab:9'], g => g === 'jab')).toEqual(['jab:9']);
    expect(findInstructor(pool, 'jab:5')).toBe(pool[3]);
    expect(serializeInstructorParam(['psy:1', '7', 'jab:9'])).toBe('psy:1,jab:9');
    expect(parseInstructorParam('psy:1, 7,psy:1,jab:9')).toEqual(['psy:1', 'jab:9']);
  });
});

describe('instructor search scope', () => {
  it('adds the instructor gym so unrelated gyms cannot leak through the per-gym filter', () => {
    const first = addInstructorSearchFilter({ gyms: [], locations: ['psy:1'], instructors: [], eventTypes: ['Ride'], bookmarks: false }, 'psy', '1');
    expect(first).toEqual({ gyms: ['psy'], locations: ['psy:1'], instructors: ['psy:1'], eventTypes: ['Ride'], bookmarks: false });
    expect(passesInstructorFilter(first.instructors, 'psy', ['2'])).toBe(false);
    expect(first.gyms.includes('jab')).toBe(false);

    const both = addInstructorSearchFilter(first, 'jab', '9');
    expect(both.gyms).toEqual(['psy', 'jab']);
    expect(both.instructors).toEqual(['psy:1', 'jab:9']);
  });
});

import { summariseInstructorsByGym } from './instructor-filter.js';
describe('summariseInstructorsByGym', () => {
  it('counts per gym, 0 means All, ignores bare ids', () => {
    expect(summariseInstructorsByGym(['psy:1', 'psy:2', '7'], ['psy', 'jab'])).toEqual([{ gymId: 'psy', count: 2 }, { gymId: 'jab', count: 0 }]);
    expect(summariseInstructorsByGym(['jab:9'], ['psy', 'jab'])).toEqual([{ gymId: 'psy', count: 0 }, { gymId: 'jab', count: 1 }]);
    expect(summariseInstructorsByGym([], ['psy'])).toEqual([{ gymId: 'psy', count: 0 }]);
  });
});
