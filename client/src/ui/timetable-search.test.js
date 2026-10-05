import { describe, it, expect } from 'vitest';
import { normalizeText, tokenize, buildSearchIndex, searchEvents, suggest, groupByDay } from './timetable-search.js';
import { getSearchQuery, setSearchQuery, clearSearch, onSearchChange } from './timetable-search-state.js';

const ev = (o) => ({ id: '1', gymId: 'p', name: 'Ride', discipline: 'Ride', startAt: '2026-10-06T10:00:00+01:00', instructors: [], locationId: 'l1', locationName: 'Oxford Circus', studioName: 'Studio A', ...o });
const gymNames = (id) => ({ p: ['Psycle London', 'Psycle'], j: ['JAB Boxing', 'JAB'] }[id] || [id]);
const gymLabel = (id) => ({ p: 'Psycle', j: 'JAB' }[id] || id);
const events = [
  ev({ id: '1', name: 'Boxing Fundamentals', discipline: 'Boxing', gymId: 'j', locationId: '9', locationName: 'Soho', instructors: [{ id: '7', name: 'George Smith' }], startAt: '2026-10-08T09:00:00+01:00' }),
  ev({ id: '1', name: 'Ride 45', instructors: [{ id: '7', name: 'Johan Müller' }], startAt: '2026-10-06T07:00:00+01:00' }),
  ev({ id: '2', name: 'Ride 45', instructors: [{ id: '7', name: 'Johan Müller' }], startAt: '2026-10-07T07:00:00+01:00' }),
  ev({ id: '3', name: 'Strength', discipline: 'Strength', instructors: [{ id: '8', name: 'George Hall' }], startAt: '2026-10-06T18:00:00+01:00' }),
];
const idx = buildSearchIndex(events, { gymNames, gymLabel });

describe('normalize/tokenize', () => {
  it('is case, diacritic and punctuation insensitive', () => {
    expect(normalizeText('  JOHAN  Müller! ')).toBe('johan muller');
    expect(tokenize('Core & Power')).toEqual(['core', 'power']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('searchEvents', () => {
  it('matches diacritics both ways', () => {
    expect(searchEvents(idx, 'muller')).toHaveLength(2);
    expect(searchEvents(idx, 'MÜLLER')).toHaveLength(2);
  });
  it('ANDs words across different fields (instructor + discipline)', () => {
    const r = searchEvents(idx, 'george boxing');
    expect(r).toHaveLength(1);
    expect(r[0].gymId).toBe('j');
    expect(searchEvents(idx, 'george ride')).toHaveLength(0);
  });
  it('matches gym, location and workout fields', () => {
    expect(searchEvents(idx, 'jab')).toHaveLength(1);
    expect(searchEvents(idx, 'oxford')).toHaveLength(3);
    expect(searchEvents(idx, 'strength')).toHaveLength(1);
  });
  it('returns chronological order and nothing for empty text', () => {
    const r = searchEvents(idx, 'george');
    expect(r.map(e => e.name)).toEqual(['Strength', 'Boxing Fundamentals']);
    expect(searchEvents(idx, '')).toEqual([]);
  });
  it('does not read .raw', () => {
    const i = buildSearchIndex([ev({ raw: { name: 'SECRETWORD' } })], { gymNames });
    expect(searchEvents(i, 'secretword')).toHaveLength(0);
  });
});

describe('suggest', () => {
  it('suggests instructors labelled with their gym and a count', () => {
    const g = suggest(idx, 'johan');
    const inst = g.find(x => x.type === 'instructor').items;
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ label: 'Johan Müller', sub: 'Psycle', gymId: 'p', id: '7', count: 2 });
  });
  it('keys instructors by gym so colliding ids stay separate', () => {
    const i = buildSearchIndex([
      ev({ gymId: 'p', instructors: [{ id: '7', name: 'Alex' }] }),
      ev({ id: '2', gymId: 'j', instructors: [{ id: '7', name: 'Alex' }] }),
    ], { gymNames, gymLabel });
    expect(suggest(i, 'alex').find(x => x.type === 'instructor').items).toHaveLength(2);
  });
  it('groups by type in a stable order and omits empty groups', () => {
    const types = suggest(idx, 'boxing').map(x => x.type);
    expect(types).toEqual(['class', 'gym', 'workout']);
  });
  it('a multi-word query narrows suggestions', () => {
    expect(suggest(idx, 'george smith').find(x => x.type === 'instructor').items).toHaveLength(1);
    expect(suggest(idx, 'zzz')).toEqual([]);
  });
  it('merges a class name shared by two gyms and counts it', () => {
    const c = suggest(idx, 'ride').find(x => x.type === 'class').items;
    expect(c).toHaveLength(1);
    expect(c[0].count).toBe(2);
  });
});

describe('groupByDay', () => {
  it('splits a sorted list on day change', () => {
    const sorted = searchEvents(idx, 'a');
    const g = groupByDay(sorted, (e) => e.startAt.slice(0, 10));
    expect(g.map(x => x.day)).toEqual([...new Set(sorted.map(e => e.startAt.slice(0, 10)))]);
  });
});

describe('search state', () => {
  it('normalises, notifies once per change, and clears', () => {
    const seen = [];
    const off = onSearchChange(q => seen.push(q));
    setSearchQuery('  george   boxing ');
    setSearchQuery('george boxing');
    expect(getSearchQuery()).toBe('george boxing');
    clearSearch();
    off();
    expect(seen).toEqual(['george boxing', '']);
  });
});

import { enterSearchScope, leaveSearchScope, inSearchScope, emptyFilters, filtersAreEmpty } from './timetable-search-state.js';

describe('search scope snapshot/restore', () => {
  const normal = { gyms: ['aarmy'], locations: ['3'], instructors: [], eventTypes: ['Boxing'], bookmarks: true };
  it('snapshots once, restores exactly, and is isolated from later edits', () => {
    expect(inSearchScope()).toBe(false);
    expect(enterSearchScope(normal)).toBe(true);
    normal.gyms.push('mutated-after');            // caller keeps editing its live arrays
    expect(enterSearchScope(emptyFilters())).toBe(false);   // re-entry must NOT overwrite the snapshot
    const back = leaveSearchScope();
    expect(back).toEqual({ gyms: ['aarmy'], locations: ['3'], instructors: [], eventTypes: ['Boxing'], bookmarks: true });
    expect(inSearchScope()).toBe(false);
    expect(leaveSearchScope()).toBeNull();        // restore after leave is a no-op
  });
  it('emptyFilters is unfiltered and fresh each call', () => {
    expect(filtersAreEmpty(emptyFilters())).toBe(true);
    expect(emptyFilters()).not.toBe(emptyFilters());
    expect(filtersAreEmpty({ ...emptyFilters(), bookmarks: true })).toBe(false);
  });
});
