import { describe, it, expect } from 'vitest';
import { nextCollapseState } from './scroll-collapse.js';

const base = { top: 200, max: 2000, anchor: 200, collapsed: false, busy: false, modalOpen: false, headerH: 47 };

describe('nextCollapseState', () => {
  it('collapses after scrolling down past the dead zone, expands on scroll up', () => {
    expect(nextCollapseState({ ...base, top: 215 })).toEqual({ collapsed: true, anchor: 215 });
    expect(nextCollapseState({ ...base, collapsed: true, anchor: 215, top: 190 })).toEqual({ collapsed: false, anchor: 190 });
  });
  it('ignores jitter under the dead zone and keeps the anchor so slow drags accumulate', () => {
    expect(nextCollapseState({ ...base, top: 208 })).toEqual({ collapsed: false, anchor: 200 });
    expect(nextCollapseState({ ...base, top: 213 }).collapsed).toBe(true);
  });
  it('never collapses near the top; always expands at the top', () => {
    expect(nextCollapseState({ ...base, top: 3, anchor: 0 }).collapsed).toBe(false);
    expect(nextCollapseState({ ...base, collapsed: true, top: 2, anchor: 90 }).collapsed).toBe(false);
    expect(nextCollapseState({ ...base, top: 30, anchor: 0 }).collapsed).toBe(false);
  });
  it('a programmatic jump while busy (merge-in anchor restore) re-baselines without toggling', () => {
    expect(nextCollapseState({ ...base, busy: true, top: 600, anchor: 200 })).toEqual({ collapsed: false, anchor: 600 });
    expect(nextCollapseState({ ...base, busy: true, collapsed: true, top: 100, anchor: 600 })).toEqual({ collapsed: true, anchor: 100 });
  });
  it('ignores rubber-band samples and the bottom bounce zone', () => {
    expect(nextCollapseState({ ...base, top: -20 })).toEqual({ collapsed: false, anchor: 200 });
    expect(nextCollapseState({ ...base, top: 2050 })).toEqual({ collapsed: false, anchor: 200 });
    expect(nextCollapseState({ ...base, collapsed: true, top: 1990, anchor: 2000 })).toEqual({ collapsed: true, anchor: 1990 });
  });
  it('is never collapsed on a page too short to scroll, or with a modal open', () => {
    expect(nextCollapseState({ ...base, max: 80, collapsed: true, top: 60 })).toEqual({ collapsed: false, anchor: 0 });
    expect(nextCollapseState({ ...base, modalOpen: true, collapsed: true, top: 300 }).collapsed).toBe(false);
  });
});
