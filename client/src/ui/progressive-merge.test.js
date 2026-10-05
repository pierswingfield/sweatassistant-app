import { describe, it, expect, vi } from 'vitest';
import { createProgressiveMerge } from './progressive-merge.js';
import { beginGymLoad, endGymLoad, isGymLoading, resetGymLoadState, applyGymLoadState } from './gym-load-state.js';
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-anchor.js';

function harness(gymIds) {
  let fire = null;
  const flushes = [];
  const m = createProgressiveMerge({
    gymIds, graceMs: 4000,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
    onFlush: (f) => flushes.push(f),
  });
  return { m, flushes, grace: () => fire && fire() };
}
const ev = (id, gym, t) => ({ id, gymId: gym, startAt: `2026-10-06T${t}:00Z` });

describe('progressive merge (U4-7)', () => {
  it('flushes once, merged and sorted, when all gyms land inside the grace window', () => {
    const { m, flushes, grace } = harness(['a', 'b']);
    m.arrive('a', [ev(1, 'a', '12')]);
    expect(flushes).toHaveLength(0);
    m.arrive('b', [ev(2, 'b', '08')]);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].final).toBe(true);
    expect(flushes[0].events.map(e => e.id)).toEqual([2, 1]);
    grace();
    expect(flushes).toHaveLength(1);
  });

  it('after grace flushes what arrived, then merges the late gym in', () => {
    const { m, flushes, grace } = harness(['a', 'b']);
    m.arrive('a', [ev(1, 'a', '12')]);
    grace();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ final: false, pending: ['b'] });
    m.arrive('b', [ev(2, 'b', '08')]);
    expect(flushes).toHaveLength(2);
    expect(flushes[1].final).toBe(true);
    expect(flushes[1].events).toHaveLength(2);
  });

  it('with nothing arrived at grace, flushes on the first arrival', () => {
    const { m, flushes, grace } = harness(['a', 'b']);
    grace();
    expect(flushes).toHaveLength(0);
    m.arrive('b', [ev(2, 'b', '08')]);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].pending).toEqual(['a']);
  });

  it('graceMs 0 paints on the first gym and merges later ones', () => {
    const flushes = [];
    const m = createProgressiveMerge({ gymIds: ['a','b'], graceMs: 0, onFlush: (f) => flushes.push(f) });
    m.arrive('a', [ev(1,'a','12')]);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ final: false, pending: ['b'] });
    m.arrive('b', [ev(2,'b','08')]);
    expect(flushes).toHaveLength(2);
    expect(flushes[1].events.map(e => e.id)).toEqual([2, 1]);
  });

  it('a failed gym settles with no events; ids compare as strings', () => {
    const { m, flushes } = harness([1, 2]);
    m.arrive('1', [ev(1, '1', '10')]);
    m.fail(2);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].final).toBe(true);
    expect(flushes[0].events).toHaveLength(1);
  });

  it('ignores a duplicate arrival for a settled gym', () => {
    const { m, flushes } = harness(['a']);
    m.arrive('a', [ev(1, 'a', '10')]);
    m.arrive('a', [ev(9, 'a', '11')]);
    expect(flushes).toHaveLength(1);
  });
});

describe('gym load state (U4-2)', () => {
  it('counts overlapping loads per gym and marks chips', () => {
    resetGymLoadState();
    document.body.innerHTML = '<button class="psycle-header-gym-badge" data-gym="jab"></button><button class="psycle-header-gym-badge" data-gym="psycle-london"></button>';
    beginGymLoad('jab'); beginGymLoad('jab');
    applyGymLoadState(document);
    const [jab, psy] = document.querySelectorAll('.psycle-header-gym-badge');
    expect(jab.classList.contains('is-loading')).toBe(true);
    expect(jab.getAttribute('aria-busy')).toBe('true');
    expect(psy.classList.contains('is-loading')).toBe(false);
    endGymLoad('jab');
    expect(isGymLoading('jab')).toBe(true);
    endGymLoad('jab');
    applyGymLoadState(document);
    expect(jab.classList.contains('is-loading')).toBe(false);
  });
});

describe('scroll anchor', () => {
  it('is a no-op at the top and tolerates a missing container', () => {
    expect(captureScrollAnchor(null)).toBeNull();
    const c = document.createElement('div');
    expect(captureScrollAnchor(c)).toEqual({ top: 0, key: null, offset: 0 });
    expect(() => restoreScrollAnchor(c, null)).not.toThrow();
  });
});
