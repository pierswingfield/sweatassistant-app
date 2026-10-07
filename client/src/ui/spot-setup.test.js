import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';

let openSpotSetup;
let spotSetupHelperText;
let spotSetupBookingOptions;

beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  if (typeof localStorage === 'undefined' || localStorage === null || !localStorage.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    });
  }
  ({ openSpotSetup, spotSetupHelperText, spotSetupBookingOptions } = await import('./spot-setup.js'));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('preferred spot setup copy and entry', () => {
  it('shows row guidance only for multi-row studios that support row preferences', () => {
    const slots = [{ y: 1 }, { y: 2 }];
    expect(spotSetupHelperText(false, slots)).toBe(COPY.bookingFlow.helperSetup);
    expect(spotSetupHelperText(true, [{ y: 1 }])).toBe(COPY.bookingFlow.helperSetup);
    expect(spotSetupHelperText(true, slots)).toBe(`${COPY.bookingFlow.helperSetup} ${COPY.bookingFlow.helperSetupRows}`);
  });

  it('offers Choose a spot for now instead of Skip for now on the intro page', () => {
    const onChooseForNow = vi.fn();
    const page = openSpotSetup({
      event: { gymId: 'psycle-london', studioId: 'studio-1', studioName: 'Studio 1', locationName: 'Soho' },
      className: 'Ride', onChooseForNow,
    });
    const actions = [...page.querySelectorAll('.app-setup-footer button')].map((button) => button.textContent);
    expect(actions).toContain(COPY.spotSetup.chooseForNow);
    expect(actions).not.toContain('Skip for now');
    page.querySelector('.app-setup-footer button:last-child').click();
    expect(onChooseForNow).toHaveBeenCalledWith(page);
  });

  it('shows the two-step cue only when a class follows the spot setup', () => {
    window.matchMedia = (query) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} });
    const event = { gymId: 'psycle-london', studioId: 'studio-1', studioName: 'Studio 1', locationName: 'Soho' };
    const withClass = openSpotSetup({ event, className: 'Ride' });
    expect(withClass.querySelector('.app-stepper')).not.toBeNull();
    withClass.remove();
    // Onboarding / Settings: no class, so no "2 Book class" step.
    const noClass = openSpotSetup({ event, className: null });
    expect(noClass.querySelector('.app-stepper')).toBeNull();
  });

  it('replaces the saved setup page with booking so success cannot return to the confirmation loop', () => {
    const page = document.createElement('div');
    const saved = { slots: [12], rows: [2] };
    const options = spotSetupBookingOptions({ mode: 'quickbook', backToSetup: true }, page, saved);

    expect(options.replaceEl).toBe(page);
    expect(options.savedPrefs).toBe(saved);
    expect(options.setupFlow).toBe(true);
    expect(options.backToSetup).toBeUndefined();
  });
});
