import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { timetableEntryPlan, isResultSetChangeReason } from './timetable-entry.js';

describe('timetableEntryPlan', () => {
  it('first entry is fresh', () => {
    expect(timetableEntryPlan({ initialised: false, routeTimetable: {} })).toBe('fresh');
  });
  it('switching away and back keeps state (plain /timetable)', () => {
    expect(timetableEntryPlan({ initialised: true, routeTimetable: {} })).toBe('resume');
    expect(timetableEntryPlan({ initialised: true, routeTimetable: undefined })).toBe('resume');
    expect(timetableEntryPlan({ initialised: true, routeTimetable: { day: null, gyms: [], fav: false, q: '', explicit: false } })).toBe('resume');
  });
  it('a URL naming day or filters wins over remembered state', () => {
    expect(timetableEntryPlan({ initialised: true, routeTimetable: { day: '2026-11-21' } })).toBe('fresh');
  });
});

describe('search persistence and result scroll', () => {
  it('only search/filter renders reset scroll', () => {
    expect(isResultSetChangeReason('search')).toBe(true);
    expect(isResultSetChangeReason('filter')).toBe(true);
    for (const r of ['interaction', 'warm-cache', 'team-chips', 'preferences-mutated', undefined]) expect(isResultSetChangeReason(r)).toBe(false);
  });
  it('leaving the Timetable tab does not end search (text + picked filter persist)', () => {
    const main = readFileSync(process.cwd() + '/src/main.js', 'utf8');
    expect(main).not.toMatch(/exitSearch/);
  });
  it('scrollResultsToTop resets the desktop panel body, the list and the window', () => {
    const tt = readFileSync(process.cwd() + '/src/ui/timetable.js', 'utf8');
    const fn = tt.slice(tt.indexOf('export function scrollResultsToTop'), tt.indexOf('export async function renderTimetableGrid'));
    expect(fn).toContain("main.app-body");
    expect(fn).toContain("app-timetable-grid");
    expect(fn).toContain('resetWindowScroll');
  });
});
