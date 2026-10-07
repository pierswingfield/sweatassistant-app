import { describe, it, expect, beforeAll } from 'vitest';
import { setGymCatalogue } from '../gym-context.js';
import { CATALOGUE } from './gym-brand-fixture.js';
import { gymSquareChip, gymBrand, icon, SVG_PATHS } from './cards.js';

beforeAll(() => setGymCatalogue(CATALOGUE));

describe('gymSquareChip (U1-8)', () => {
  it('renders each gym\'s own real logo on its own brand plate, decoratively', () => {
    const psycle = gymSquareChip('psycle-london');
    expect(psycle).toContain('sa-gym-mark-psycle-london');
    expect(psycle).toContain('/gyms/psycle-london-half.avif');
    expect(psycle).toContain('aria-hidden="true"');
    const jab = gymSquareChip('jab-boxing');
    expect(jab).toContain('sa-gym-mark-jab-boxing');
    expect(jab).toContain('ab-gym-logo-svg');
  });
  it('reuses the shared brand asset instead of a second copy', () => {
    expect(gymSquareChip('jab-boxing')).toContain(gymBrand('jab-boxing').logoSvg);
  });
});

describe('Settings menu icons (U1-10)', () => {
  it.each(['sliders', 'bell', 'user', 'link', 'info'])('%s is in the shared set and renders like every other icon', (name) => {
    expect(SVG_PATHS[name]).toBeTruthy();
    const svg = icon(name, 18);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.6"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('viewBox="0 0 16 16"');
  });
});
