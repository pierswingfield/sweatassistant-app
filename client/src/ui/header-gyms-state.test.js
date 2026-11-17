import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeMode, normaliseSetting, createWaveTracker, createHeaderGymsMachine, createFadeMachine,
} from './header-gyms-state.js';
import { beginGymLoad, endGymLoad, loadingGymIds, resetGymLoadState } from './gym-load-state.js';

describe('computeMode', () => {
  it('auto: plain up to 4 gyms, collapsible from 5', () => {
    expect(computeMode('auto', 0)).toBe('plain');
    expect(computeMode('auto', 1)).toBe('plain');
    expect(computeMode('auto', 4)).toBe('plain');
    expect(computeMode('auto', 5)).toBe('collapsible');
    expect(computeMode('auto', 9)).toBe('collapsible');
  });
  it('always never collapses; never always collapses', () => {
    expect(computeMode('always', 9)).toBe('plain');
    expect(computeMode('never', 1)).toBe('collapsible');
    expect(computeMode('never', 0)).toBe('collapsible');
  });
  it('unknown or missing behaves as auto', () => {
    expect(normaliseSetting(undefined)).toBe('auto');
    expect(normaliseSetting('sideways')).toBe('auto');
    expect(computeMode(undefined, 5)).toBe('collapsible');
    expect(computeMode('x', 4)).toBe('plain');
  });
});

describe('wave tracker', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  it('advances in steps and ends at 100%', () => {
    const w = createWaveTracker();
    let r = w.sync(ids, ids);
    expect(r).toMatchObject({ active: true, pct: 0, total: 5, started: true });
    r = w.sync(['c', 'd', 'e'], ids);
    expect(r.pct).toBeCloseTo(0.4); expect(r.started).toBe(false);
    r = w.sync([], ids);
    expect(r).toMatchObject({ active: false, pct: 1, ended: true });
    expect(w.sync([], ids).ended).toBe(false);
  });
  it('a late gym grows the denominator', () => {
    const w = createWaveTracker();
    const six = [...ids, 'f'];
    w.sync(['a', 'b'], six);
    expect(w.sync(['b', 'f'], six)).toMatchObject({ total: 3, done: 1 });
  });
  it('ignores gyms that are not rendered chips', () => {
    const w = createWaveTracker();
    expect(w.sync(['zzz'], ids).active).toBe(false);
    expect(w.sync(['a', 'zzz'], ids).total).toBe(1);
  });
  it('overlapping loads for one gym count once (via the real store)', () => {
    resetGymLoadState();
    const w = createWaveTracker();
    beginGymLoad('a'); beginGymLoad('a'); beginGymLoad('b');
    expect(w.sync(loadingGymIds(), ids).total).toBe(2);
    endGymLoad('a');
    expect(w.sync(loadingGymIds(), ids)).toMatchObject({ done: 0, active: true });
    endGymLoad('a');
    expect(w.sync(loadingGymIds(), ids).done).toBe(1);
    endGymLoad('b');
    expect(w.sync(loadingGymIds(), ids).ended).toBe(true);
    resetGymLoadState();
  });
});

describe('expansion machine', () => {
  let loading, states, m;
  beforeEach(() => {
    vi.useFakeTimers();
    loading = false; states = [];
    m = createHeaderGymsMachine({ isLoading: () => loading, onState: (s, i) => states.push([s, i.animate]) });
  });
  afterEach(() => vi.useRealTimers());

  it('tap then idle collapses at 5000 ms, not 4999', () => {
    m.tap();
    expect(m.state).toBe('expanding');
    vi.advanceTimersByTime(700);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(4298);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('collapsing');
    vi.advanceTimersByTime(700);
    expect(m.state).toBe('collapsed');
  });
  it('holds open for as long as a load runs; arms 5 s after the last end', () => {
    loading = true;
    m.tap(); m.loadBegin();
    vi.advanceTimersByTime(60000);
    expect(m.state).toBe('expanded');
    loading = false; m.storeIdle();
    vi.advanceTimersByTime(4999);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('collapsing');
  });
  it('a fresh load at +3 s cancels the timer and its end re-arms a full 5 s', () => {
    m.tap();
    vi.advanceTimersByTime(3000);
    loading = true; m.loadBegin();
    vi.advanceTimersByTime(10000);
    expect(m.state).toBe('expanded');
    loading = false; m.storeIdle();
    vi.advanceTimersByTime(4999);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('collapsing');
  });
  it('a second tap collapses at once and cancels the timer', () => {
    m.tap(); vi.advanceTimersByTime(1000);
    m.tap();
    expect(m.state).toBe('collapsing');
    vi.advanceTimersByTime(700);
    expect(m.state).toBe('collapsed');
    vi.advanceTimersByTime(10000);
    expect(m.state).toBe('collapsed');
  });
  it('interaction resets the timer', () => {
    m.tap(); vi.advanceTimersByTime(4000);
    m.interact();
    vi.advanceTimersByTime(4999);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('collapsing');
  });
  it('keyboard focus holds it open; focusout re-arms', () => {
    m.tap(); m.focusIn();
    vi.advanceTimersByTime(30000);
    expect(m.state).toBe('expanded');
    m.focusOut();
    vi.advanceTimersByTime(5000);
    expect(m.state).toBe('collapsing');
  });
  it('headerHidden collapses immediately with no animation', () => {
    m.tap(); vi.advanceTimersByTime(800);
    m.headerHidden();
    expect(m.state).toBe('collapsed');
    expect(states[states.length - 1]).toEqual(['collapsed', false]);
    vi.advanceTimersByTime(10000);
    expect(m.state).toBe('collapsed');
  });
  it('turning collapsible off tears down; tap is then inert', () => {
    m.tap(); m.setCollapsible(false);
    expect(m.state).toBe('collapsed');
    m.tap();
    expect(m.state).toBe('collapsed');
  });
  it('escape collapses', () => {
    m.tap(); m.escape();
    expect(m.state).toBe('collapsing');
  });
  it('a tap during collapsing re-expands', () => {
    m.tap(); m.tap();
    m.tap();
    expect(m.state).toBe('expanding');
  });
});

describe('fade machine', () => {
  let changes, f;
  beforeEach(() => { vi.useFakeTimers(); changes = []; f = createFadeMachine({ onChange: (s) => changes.push(s) }); });
  afterEach(() => vi.useRealTimers());

  it('mutes 800 ms after the first wave goes idle', () => {
    f.markStrong();
    f.loadBegin();
    vi.advanceTimersByTime(10000);
    expect(f.state).toBe('strong');
    f.storeIdle();
    vi.advanceTimersByTime(799);
    expect(f.state).toBe('strong');
    vi.advanceTimersByTime(1);
    expect(f.state).toBe('muted');
  });
  it('mutes at 4 s when nothing loads', () => {
    f.markStrong();
    vi.advanceTimersByTime(3999);
    expect(f.state).toBe('strong');
    vi.advanceTimersByTime(1);
    expect(f.state).toBe('muted');
  });
  it('later loads stay muted; markStrong restores', () => {
    f.markStrong(); vi.advanceTimersByTime(4000);
    f.loadBegin(); f.storeIdle(); vi.advanceTimersByTime(5000);
    expect(f.state).toBe('muted');
    f.markStrong();
    expect(f.state).toBe('strong');
    expect(changes).toEqual(['muted', 'strong']);
  });
});
