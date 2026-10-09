import { describe, it, expect } from 'vitest';
import { shownGyms, nextGymSelection, quickSelectItems } from './gym-quick-select.js';

const ALL = ['a', 'b', 'c'];

describe('shownGyms', () => {
  it('empty filter shows all', () => expect(shownGyms([], ALL)).toEqual(ALL));
  it('uses the saved subset', () => expect(shownGyms(['a', 'c'], ALL)).toEqual(['a', 'c']));
  it('ignores ids that are no longer linked', () => expect(shownGyms(['zzz'], ALL)).toEqual(ALL));
  it('compares as strings', () => expect(shownGyms([1], [1, 2])).toEqual(['1']));
});

describe('nextGymSelection', () => {
  it('from all: tap shows only that gym', () => expect(nextGymSelection([], ALL, 'b')).toEqual(['b']));
  it('tap another switches', () => expect(nextGymSelection(['a'], ALL, 'b')).toEqual(['b']));
  it('tap the sole selected gym shows all', () => expect(nextGymSelection(['b'], ALL, 'b')).toEqual([]));
  it('from a multi-gym default, tap one narrows to it', () => expect(nextGymSelection(['a', 'b'], ALL, 'a')).toEqual(['a']));
  it('unknown gym is a no-op', () => expect(nextGymSelection(['a'], ALL, 'q')).toEqual(['a']));
  it('single linked gym stays all', () => expect(nextGymSelection([], ['a'], 'a')).toEqual([]));
  it('does not mutate input', () => { const s = ['a']; nextGymSelection(s, ALL, 'b'); expect(s).toEqual(['a']); });
});

describe('quickSelectItems', () => {
  it('places active (shown) gyms first, followed by excluded gyms (U6-14)', () => {
    expect(quickSelectItems(['b'], ALL)).toEqual([
      { gymId: 'b', linked: true, shown: true }, { gymId: 'a', linked: true, shown: false }, { gymId: 'c', linked: true, shown: false }]);
  });
  // Initial state = the saved default gym filter (see loadStoredFilters), or [] when none is saved.
  it('initial: one gym saved shows only that gym', () => {
    expect(quickSelectItems(['b'], ALL).filter(i => i.shown).map(i => i.gymId)).toEqual(['b']);
  });
  it('initial: nothing saved shows every linked gym', () => {
    expect(quickSelectItems([], ALL).filter(i => i.shown).map(i => i.gymId)).toEqual(ALL);
  });
  it('unlinked gyms render but are never shown, and never count as "all"', () => {
    const items = quickSelectItems([], ALL, ['a', 'b']);
    expect(items.map(i => [i.gymId, i.linked, i.shown])).toEqual([['a', true, true], ['b', true, true], ['c', false, false]]);
  });
  it('tapping an unlinked gym leaves the filter unchanged', () => {
    expect(nextGymSelection(['a'], ['a', 'b'], 'c')).toEqual(['a']);
  });
  it('all shown when no filter', () => expect(quickSelectItems([], ALL).every(i => i.shown)).toBe(true));
});
