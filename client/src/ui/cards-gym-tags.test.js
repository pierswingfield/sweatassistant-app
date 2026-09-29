import { describe, it, expect } from 'vitest';
import { syncGymBrandedTags } from './cards.js';

const view = (...gyms) => {
  const el = document.createElement('div');
  el.innerHTML = gyms.map((g) => `<div data-gym="${g}"><span class="ab-disc-tag" data-disc="ride"></span></div>`).join('');
  return el;
};

describe('syncGymBrandedTags (U4-9)', () => {
  it('flags a view showing classes from more than one gym', () => {
    const el = view('psycle-london', 'jab-boxing');
    expect(syncGymBrandedTags(el)).toBe(true);
    expect(el.hasAttribute('data-multi-gym')).toBe(true);
  });
  it('leaves a single-gym view on discipline colours', () => {
    const el = view('psycle-london', 'psycle-london');
    expect(syncGymBrandedTags(el)).toBe(false);
    expect(el.hasAttribute('data-multi-gym')).toBe(false);
  });
  it('re-evaluates after a re-filter removes the second gym', () => {
    const el = view('psycle-london', 'jab-boxing');
    syncGymBrandedTags(el);
    el.lastElementChild.remove();
    expect(syncGymBrandedTags(el)).toBe(false);
    expect(el.hasAttribute('data-multi-gym')).toBe(false);
  });
});

describe('syncGymBrandedTags is per page (tab panel), not per list', () => {
  it('counts gyms across both lists of one panel', () => {
    const panel = document.createElement('section');
    panel.className = 'psycle-tab-content';
    panel.innerHTML = '<div id="a"><div data-gym="psycle-london"><span class="ab-disc-tag"></span></div></div>'
      + '<div id="b"><div data-gym="jab-boxing"><span class="ab-disc-tag"></span></div></div>';
    const a = panel.querySelector('#a'), b = panel.querySelector('#b');
    expect(syncGymBrandedTags(a)).toBe(true);   // bookings alone is single-gym, the page is not
    expect(panel.hasAttribute('data-multi-gym')).toBe(true);
    expect(syncGymBrandedTags(b)).toBe(true);
  });
  it('stays single-gym when every list on the page is one gym', () => {
    const panel = document.createElement('section');
    panel.className = 'psycle-tab-content';
    panel.innerHTML = '<div id="a"><div data-gym="jab-boxing"><span class="ab-disc-tag"></span></div></div>'
      + '<div id="b"><div data-gym="jab-boxing"><span class="ab-disc-tag"></span></div></div>';
    expect(syncGymBrandedTags(panel.querySelector('#a'))).toBe(false);
    expect(panel.hasAttribute('data-multi-gym')).toBe(false);
  });
});
