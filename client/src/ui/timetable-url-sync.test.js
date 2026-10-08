import { describe, it, expect } from 'vitest';
import {
  slug, stateToUrlTimetable, urlToState, overlayLabels, guardedSaveDefaults, sameFilters, savedToState, emptyFilterState,
} from './timetable-url-sync.js';
import { parseLocation, serializeState } from '../url-state.js';

const ctx = {
  linkedGymIds: ['psycle-london', 'jab'],
  locations: [{ id: '3', gymId: 'psycle-london', name: 'Clapham' }, { id: '12', gymId: 'jab', name: 'Soho' }],
  instructors: [{ id: '123', gymId: 'psycle-london', name: 'Johan' }],
  workouts: [{ label: 'Ride', gymId: 'psycle-london' }, { label: 'Boxing', gymId: 'jab' }, { label: 'Ride', gymId: 'jab' }],
  gymName: (g) => (g === 'jab' ? 'JAB' : 'Psycle'),
};
const path = (t) => serializeState({ tab: 'class-timetable', timetable: t });

describe('state -> url', () => {
  it('state equal to saved defaults emits no filter params', () => {
    const saved = { ...emptyFilterState(), gyms: ['jab'] };
    expect(path(stateToUrlTimetable(saved, ctx, { saved }))).toBe('/timetable');
  });
  it('maps bare location ids and labels to scoped tokens', () => {
    const st = { ...emptyFilterState(), locations: ['3'], eventTypes: ['Ride'], instructors: ['psycle-london:123'] };
    expect(path(stateToUrlTimetable(st, ctx, { day: '2026-10-07', defaultDay: '2026-10-06' })))
      .toBe('/timetable?day=2026-10-07&loc=psycle-london%3A3&type=psycle-london%3Aride&instructor=psycle-london%3A123');
  });
  it('omits the default day', () => {
    expect(path(stateToUrlTimetable(emptyFilterState(), ctx, { day: '2026-10-06', defaultDay: '2026-10-06' }))).toBe('/timetable');
  });
  it('empty filters under non-empty saved defaults emit f=all', () => {
    const saved = { ...emptyFilterState(), gyms: ['jab'] };
    expect(path(stateToUrlTimetable(emptyFilterState(), ctx, { saved }))).toBe('/timetable?f=all');
  });
  it('keeps a committed search query in the same URL as its filters', () => {
    const st = { ...emptyFilterState(), gyms: ['jab'] };
    expect(path(stateToUrlTimetable(st, ctx, { q: 'boxing class' })))
      .toBe('/timetable?gym=jab&q=boxing%20class');
  });
});

describe('url -> state', () => {
  const rt = (st, opts) => {
    const url = path(stateToUrlTimetable(st, ctx, opts));
    const [p, q] = url.split('?');
    return urlToState(parseLocation(p, q ? `?${q}` : '').timetable, ctx);
  };
  it('round-trips filters', () => {
    const st = { gyms: ['jab'], locations: ['12'], instructors: ['psycle-london:123'], eventTypes: ['Boxing', 'Ride'], bookmarks: true };
    const r = rt(st);
    expect(sameFilters(r.state, st)).toBe(true);
    expect(r.dropped).toEqual([]);
  });
  it('no params = use saved defaults', () => {
    expect(urlToState(parseLocation('/timetable', '').timetable, ctx).usesDefaults).toBe(true);
  });
  it('a q-only deep link is an explicit search overlay, not saved defaults', () => {
    const r = urlToState(parseLocation('/timetable', '?q=boxing').timetable, ctx);
    expect(r.usesDefaults).toBe(false);
    expect(r.q).toBe('boxing');
    expect(sameFilters(r.state, emptyFilterState())).toBe(true);
  });
  it('f=all is an explicit empty set, not defaults', () => {
    const r = urlToState(parseLocation('/timetable', '?f=all').timetable, ctx);
    expect(r.usesDefaults).toBe(false);
    expect(sameFilters(r.state, emptyFilterState())).toBe(true);
  });
  it('drops unknown ids and reports them; unlinked gyms are ignored', () => {
    const t = parseLocation('/timetable', '?gym=ghost,jab&loc=jab:999&instructor=psycle-london:1&type=jab:nope').timetable;
    const r = urlToState(t, ctx);
    expect(r.state.gyms).toEqual(['jab']);
    expect(r.ignoredGyms).toEqual(['ghost']);
    expect(r.dropped.sort()).toEqual(['jab:999', 'jab:nope', 'psycle-london:1']);
  });
  it('rejects tokens of unlinked gyms', () => {
    const r = urlToState(parseLocation('/timetable', '?loc=other:3').timetable, ctx);
    expect(r.state.locations).toEqual([]);
    expect(r.dropped).toEqual(['other:3']);
  });
  it('slug is URL-safe', () => expect(slug('Reformer Pilates!')).toBe('reformer-pilates'));
});

describe('banner labels', () => {
  it('names gym, workout, instructor, favourites', () => {
    const st = { gyms: ['jab'], locations: ['3'], instructors: ['psycle-london:123'], eventTypes: ['Ride'], bookmarks: true };
    expect(overlayLabels(st, { ...ctx, favouritesLabel: 'Favourites' })).toEqual(['JAB', 'Clapham', 'Ride', 'Johan', 'Favourites']);
  });
  it('labels a search query so Clear remains discoverable', () => {
    expect(overlayLabels(emptyFilterState(), { ...ctx, searchLabel: (q) => `Search: ${q}` }, 'boxing'))
      .toEqual(['Search: boxing']);
  });
});

describe('write guard', () => {
  const mk = () => { const w = []; return { w, setItem: (k, v) => w.push([k, v]) }; };
  it('never persists while an overlay is active', () => {
    const s = mk();
    expect(guardedSaveDefaults(s, 'k', { gyms: ['jab'] }, true)).toBe(false);
    expect(s.w).toEqual([]);
  });
  it('persists the user own selection', () => {
    const s = mk();
    expect(guardedSaveDefaults(s, 'k', { gyms: ['jab'] }, false)).toBe(true);
    expect(s.w).toEqual([['k', '{"gyms":["jab"]}']]);
  });
  it('savedToState reads the localStorage shape', () => {
    expect(savedToState({ gyms: ['a'], showBookmarksOnly: true }).bookmarks).toBe(true);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
describe('write-guard coverage (source scan)', () => {
  const dir = join(process.cwd(), 'src', 'ui');
  const src = readFileSync(join(dir, 'timetable.js'), 'utf8');
  it('timetable.js has no unguarded write of the saved-defaults key', () => {
    expect(src).not.toMatch(/localStorage\.setItem\(\s*defaultFiltersKey\(\)/);
    expect(src).toMatch(/guardedSaveDefaults\(localStorage, defaultFiltersKey\(\)/);
  });
  it('no other module writes the saved-defaults key', () => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'timetable.js')) {
      expect(readFileSync(join(dir, f), 'utf8')).not.toContain('appUnifiedDefaultFilters');
    }
  });
});
