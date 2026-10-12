// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const slots = [
  { id: 1, label: '1', x: 0, y: 0 }, { id: 2, label: '2', x: 10, y: 0 }, { id: 3, label: '3', x: 20, y: 0 },
];
vi.mock('../api', () => ({ api: { getStudioLayout: vi.fn(async () => ({ slots, objects: [] })), updateStudioPreferences: vi.fn() } }));

let openSpotSetup;
beforeAll(async () => {
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  if (typeof localStorage === 'undefined' || !localStorage.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() });
  }
  ({ openSpotSetup } = await import('./spot-setup.js'));
});

beforeEach(() => {
  document.body.replaceChildren();
  window.matchMedia = vi.fn((q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  history.replaceState(null, '');
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const event = { gymId: 'psycle-london', studioId: 's1', studioName: 'Studio 1', locationName: 'Soho' };
const selection = (page) => page.querySelector('[data-spotmap-root]').__getSelection();

describe('Your Spots editor draft', () => {
  it('re-entering via "Edit spots" restores the draft selection in order, not empty or the saved map', async () => {
    const page = openSpotSetup({ event, className: 'Ride', deferPersist: true, initialStep: 'editor', initialPrefs: { preferredSlots: [1], preferredRows: [] } });
    await tick();
    page.querySelector('[title="Spot 3"]').click();
    expect(selection(page).slots).toEqual([1, 3]);
    [...page.querySelectorAll('.app-setup-footer button')].find((b) => /Save/.test(b.textContent)).click();
    await tick(60);
    [...page.querySelectorAll('.app-setup-footer button')].find((b) => /Edit spots/.test(b.textContent)).click();
    await tick(60);
    expect(selection(page).slots).toEqual([1, 3]);
  });

  it('the setup tip stays after a spot tap (only its x dismisses it)', async () => {
    const page = openSpotSetup({ event, className: 'Ride', deferPersist: true, initialStep: 'editor' });
    await tick();
    expect(page.querySelector('.app-bk-helper')).not.toBeNull();
    page.querySelector('[title="Spot 2"]').click();
    expect(page.querySelector('.app-bk-helper')).not.toBeNull();
    page.querySelector('.app-bk-helper-x').click();
    expect(page.querySelector('.app-bk-helper')).toBeNull();
  });

  it('Back from an editor opened from the summary hands control back instead of closing the flow', async () => {
    const onCancelEdit = vi.fn();
    const page = openSpotSetup({ event, className: 'Ride', deferPersist: true, initialStep: 'editor', onCancelEdit });
    await tick();
    page.querySelector('.app-modal-close-btn').click();
    await tick(80);
    expect(onCancelEdit).toHaveBeenCalledWith(page);
  });
});
