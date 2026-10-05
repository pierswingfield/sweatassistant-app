import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';

let openSpotSetup;
let spotSetupHelperText;

beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  ({ openSpotSetup, spotSetupHelperText } = await import('./spot-setup.js'));
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
    const onSkip = vi.fn();
    const page = openSpotSetup({
      event: { gymId: 'psycle-london', studioId: 'studio-1', studioName: 'Studio 1', locationName: 'Soho' },
      className: 'Ride', onSkip,
    });
    const actions = [...page.querySelectorAll('.psycle-setup-footer button')].map((button) => button.textContent);
    expect(actions).toContain(COPY.spotSetup.chooseForNow);
    expect(actions).not.toContain('Skip for now');
    page.querySelector('.psycle-setup-footer button:last-child').click();
    expect(onSkip).toHaveBeenCalledWith(page, { anySpot: false });
  });
});
