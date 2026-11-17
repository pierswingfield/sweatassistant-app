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
  it('holdExpanded (search focused / dropdown open) blocks collapsing and expands back', () => {
    expect(nextCollapseState({ ...base, top: 215, holdExpanded: true })).toEqual({ collapsed: false, anchor: 215 });
    expect(nextCollapseState({ ...base, collapsed: true, anchor: 215, top: 240, holdExpanded: true }).collapsed).toBe(false);
    expect(nextCollapseState({ ...base, top: 215, holdExpanded: false }).collapsed).toBe(true);
  });
  it('collapses on a short page (a Teams list of three, max 15) and reveals on upward travel, not only at the top', () => {
    const short = { ...base, max: 15, anchor: 0, top: 15 };
    expect(nextCollapseState(short).collapsed).toBe(true);
    expect(nextCollapseState({ ...short, top: 8 }).collapsed).toBe(false);
    // collapsed at the bottom of a short page: 5pt up is noise, 6pt up reveals immediately (no wait for top)
    expect(nextCollapseState({ ...short, collapsed: true, anchor: 15, top: 10 }).collapsed).toBe(true);
    expect(nextCollapseState({ ...short, collapsed: true, anchor: 15, top: 9 })).toEqual({ collapsed: false, anchor: 9 });
    // the anchor follows the lowest point while collapsed
    expect(nextCollapseState({ ...short, collapsed: true, anchor: 12, top: 14 })).toEqual({ collapsed: true, anchor: 14 });
    expect(nextCollapseState({ ...short, collapsed: true, top: 2 }).collapsed).toBe(false);
    expect(nextCollapseState({ ...short, modalOpen: true }).collapsed).toBe(false);
  });
  it('is never collapsed on a page too short to scroll, or with a modal open', () => {
    expect(nextCollapseState({ ...base, max: 8, collapsed: true, top: 6 })).toEqual({ collapsed: false, anchor: 0 });
    expect(nextCollapseState({ ...base, modalOpen: true, collapsed: true, top: 300 }).collapsed).toBe(false);
  });
});

import fs from 'node:fs';
import { collapseMode, MOBILE_QUERY, SHORT_LANDSCAPE_QUERY } from './scroll-collapse.js';

describe('collapseMode (landscape phones)', () => {
  it('portrait/mobile hides the header and compacts', () => {
    expect(collapseMode({ mobile: true, shortLandscape: false })).toEqual({ enabled: true, hideHeader: true });
  });
  it('short landscape compacts but keeps the top tab bar', () => {
    expect(collapseMode({ mobile: false, shortLandscape: true })).toEqual({ enabled: true, hideHeader: false });
  });
  it('desktop height does nothing', () => {
    expect(collapseMode({ mobile: false, shortLandscape: false })).toEqual({ enabled: false, hideHeader: false });
  });
  it('mobile wins when both match (small landscape phone)', () => {
    expect(collapseMode({ mobile: true, shortLandscape: true }).hideHeader).toBe(true);
  });
  it('styles.css uses the same media list as the JS constants', () => {
    const css = fs.readFileSync('src/styles.css', 'utf8');
    expect(css).toContain(`@media ${MOBILE_QUERY}, ${SHORT_LANDSCAPE_QUERY}`);
    expect(css).toContain(`@media ${SHORT_LANDSCAPE_QUERY} {`);
  });
});
