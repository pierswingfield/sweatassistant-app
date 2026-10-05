import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';

let openSpotSetup;
let spotSetupHelperText;
let spotSetupBookingOptions;

beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
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
    const actions = [...page.querySelectorAll('.psycle-setup-footer button')].map((button) => button.textContent);
    expect(actions).toContain(COPY.spotSetup.chooseForNow);
    expect(actions).not.toContain('Skip for now');
    page.querySelector('.psycle-setup-footer button:last-child').click();
    expect(onChooseForNow).toHaveBeenCalledWith(page);
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
