import { describe, it, expect } from 'vitest';
import { resolveDefaultFilters, normalizeFilters } from './default-filters.js';

const f = { gyms: ['a'], locations: [1], instructors: [], eventTypes: ['x'], showBookmarksOnly: true };

describe('resolveDefaultFilters', () => {
  it('server wins over local', () => {
    const r = resolveDefaultFilters(f, { ...f, gyms: ['b'] });
    expect(r.filters.gyms).toEqual(['a']);
    expect(r.pushUp).toBe(false);
    expect(r.writeLocal).toBe(true);
  });
  it('migrates local up when server has none', () => {
    const r = resolveDefaultFilters(undefined, f);
    expect(r.filters).toEqual(f);
    expect(r.pushUp).toBe(true);
  });
  it('returns nothing when neither exists or data is junk', () => {
    expect(resolveDefaultFilters(null, null).filters).toBeNull();
    expect(resolveDefaultFilters('x', [1]).filters).toBeNull();
  });
  it('normalizes missing arrays', () => {
    expect(normalizeFilters({}).locations).toEqual([]);
  });
});
