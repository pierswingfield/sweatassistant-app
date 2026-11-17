import { describe, it, expect } from 'vitest';
import { stackFromRoute, planRoute, padTo, shouldCommit, classifyMove, commonPrefix } from './nav-stack.js';
import { parseLocation } from './url-state.js';

const R = (path, search = '') => parseLocation(path, search);
const keys = (st) => st.map((e) => e.key);
const sync = { mobile: true, homeFirst: true };
const flat = { mobile: true, homeFirst: false };

describe('stackFromRoute', () => {
  it('Home is a single root', () => {
    expect(keys(stackFromRoute(R('/'), sync))).toEqual(['home']);
    expect(keys(stackFromRoute(R('/'), flat))).toEqual(['home']);
  });
  it('sync: a tab root sits on top of Home (Back goes Home first); flat: a tab root has nothing below', () => {
    expect(keys(stackFromRoute(R('/timetable'), sync))).toEqual(['home', 'tab:class-timetable']);
    expect(keys(stackFromRoute(R('/timetable'), flat))).toEqual(['tab:class-timetable']);
    expect(keys(stackFromRoute(R('/bookings'), sync))).toEqual(['home', 'tab:my-bookings']);
    expect(keys(stackFromRoute(R('/credits'), flat))).toEqual(['tab:buy-credits']);
  });
  it('the full URL (query) lands on the last entry only', () => {
    const st = stackFromRoute(R('/timetable', '?gym=a'), { ...sync, url: '/timetable?gym=a' });
    expect(st[1].url).toBe('/timetable?gym=a');
    expect(st[0].url).toBe('/');
  });
  it('deep links build the whole parent chain', () => {
    expect(keys(stackFromRoute(R('/teams/abcdefgh1'), sync))).toEqual(['home', 'tab:teams', 'team:abcdefgh1']);
    expect(keys(stackFromRoute(R('/teams/abcdefgh1'), flat))).toEqual(['tab:teams', 'team:abcdefgh1']);
    expect(keys(stackFromRoute(R('/settings/account'), sync))).toEqual(['home', 'tab:settings', 'settings:account']);
    expect(keys(stackFromRoute(R('/settings/gym-jab'), sync))).toEqual(['home', 'tab:settings', 'settings:gyms', 'settings:gym-jab']);
    expect(keys(stackFromRoute(R('/settings'), sync))).toEqual(['home', 'tab:settings']);
  });
  it('Auto-Book is a drill-down of Bookings on mobile and its own tab on desktop', () => {
    expect(keys(stackFromRoute(R('/auto-book'), sync))).toEqual(['home', 'tab:my-bookings', 'tab:auto-book']);
    expect(keys(stackFromRoute(R('/auto-book'), { mobile: false, homeFirst: true }))).toEqual(['home', 'tab:auto-book']);
  });
  it('desktop Settings panes are side by side: no pane level', () => {
    expect(keys(stackFromRoute(R('/settings/account'), { mobile: false, homeFirst: true }))).toEqual(['home', 'tab:settings']);
  });
  it('an unknown route is Home', () => {
    expect(keys(stackFromRoute(R('/nope'), sync))).toEqual(['home']);
  });
});

describe('planRoute', () => {
  const st = (p, o = sync) => stackFromRoute(R(p), o);
  it('same route: URL only', () => {
    expect(planRoute(st('/timetable'), st('/timetable')).urlOnly).toBe(true);
  });
  it('drill-down is a pure push (menu -> pane)', () => {
    const plan = planRoute(st('/settings'), st('/settings/account'));
    expect(plan).toMatchObject({ goBack: 0, replaceAt: null });
    expect(keys(plan.pushes)).toEqual(['settings:account']);
  });
  it('a cross-tab jump to a gym pane pushes its chain: Back stays inside Settings (decision 2)', () => {
    const plan = planRoute(st('/'), st('/settings/gym-x'));
    expect(keys(plan.pushes)).toEqual(['tab:settings', 'settings:gyms', 'settings:gym-x']);
    expect(plan.goBack).toBe(0);
  });
  it('tab to tab replaces the top level, no history.go()', () => {
    const plan = planRoute(st('/timetable'), st('/bookings'));
    expect(plan).toMatchObject({ goBack: 0, replaceAt: 1 });
    expect(plan.pushes).toEqual([]);
  });
  it('from a deep level to another tab goes back to the shared level first', () => {
    const cur = st('/settings/gym-x'); // home, settings, gyms, gym
    const plan = planRoute(cur, st('/timetable'));
    expect(plan.goBack).toBe(2);
    expect(plan.replaceAt).toBe(1);
  });
  it('re-tapping a tab at depth pops to its root', () => {
    const plan = planRoute(st('/teams/abcdefgh1'), st('/teams'));
    expect(plan).toMatchObject({ goBack: 1, replaceAt: null, pushes: [] });
  });
  it('open pages above the shared prefix are dropped', () => {
    const cur = [...st('/timetable'), { kind: 'page', key: 'booking' }];
    const plan = planRoute(cur, st('/timetable'));
    expect(plan.drop.map((e) => e.key)).toEqual(['booking']);
    expect(plan.goBack).toBe(1);
  });
  it('commonPrefix compares keys only', () => {
    expect(commonPrefix([{ key: 'a' }, { key: 'b' }], [{ key: 'a' }, { key: 'c' }])).toBe(1);
  });
});

describe('padTo / gesture maths', () => {
  it('pads a rebuilt stack to the history depth', () => {
    expect(padTo(stackFromRoute(R('/timetable'), sync), 3)).toHaveLength(4);
  });
  it('shouldCommit: past 35% of the width, or a flick', () => {
    expect(shouldCommit(100, 0.1, 390)).toBe(false);
    expect(shouldCommit(140, 0.1, 390)).toBe(true);
    expect(shouldCommit(40, 0.6, 390)).toBe(true);
    expect(shouldCommit(20, 0.9, 390)).toBe(false);
    expect(shouldCommit(10, 0.1, 0)).toBe(false);
  });
  it('classifyMove: horizontal dominance locks back, vertical aborts, leftward aborts', () => {
    expect(classifyMove(5, 3)).toBe('pending');
    expect(classifyMove(30, 8)).toBe('back');
    expect(classifyMove(30, 25)).toBe('pending');
    expect(classifyMove(5, 30)).toBe('abort');
    expect(classifyMove(-20, 2)).toBe('abort');
  });
});
