import { describe, it, expect, beforeEach } from 'vitest';
import { gymBrand, gymChip, gymLogoPlate, gymLogoBanner } from './cards.js';
import { setGymCatalogue, getGymPresentation } from '../gym-context.js';
import { CATALOGUE } from './gym-brand-fixture.js';

describe('gymBrand: presentation contract lookup (F-7 item 2)', () => {
  beforeEach(() => setGymCatalogue(CATALOGUE));

  it('resolves each gym by exact id from the catalogue', () => {
    expect(gymBrand('psycle-london', 'full').logo).toContain('/gyms/psycle-london.avif');
    expect(gymBrand('psycle-london', 'half').logo).toContain('gym-logo--half');
    expect(gymBrand('jab-boxing').logo).toContain('/gyms/jab-boxing.svg');
    expect(gymBrand('jab-boxing').brandBg).toBe('#6C1F20');
  });
  it('does not match by substring: an id merely containing "jab" is neutral', () => {
    const b = gymBrand('jabberwocky-fitness');
    expect(b.id).toBe('neutral');
    expect(b.logo).not.toContain('jab-boxing');
    expect(b.logo).toContain('ab-gym-logo-text');
  });
  it('unknown gym or unloaded catalogue gets the neutral fallback, never Psycle', () => {
    setGymCatalogue([]);
    const b = gymBrand('psycle-london');
    expect(b.id).toBe('neutral');
    expect(b.logo).not.toContain('.avif');
    expect(getGymPresentation('nope')).toBeNull();
  });
  it('a third gym with a text-only wordmark needs no client code', () => {
    const b = gymBrand('third-gym');
    expect(b.id).toBe('third-gym');
    expect(b.logo).toContain('THIRD');
    expect(b.brandBg).toBe('#0a7a3c');
    expect(gymChip('third-gym')).toContain('background:#0a7a3c');
  });
  it('uses the filter drawer logo-plate contract for compact full wordmarks', () => {
    const plate = gymLogoPlate('psycle-london');
    expect(plate).toContain('fr-logo-plate');
    expect(plate).toContain('gym-logo--full');
    expect(plate).not.toContain('app-gym-chip');
  });
  it('escapes wordmark text', () => {
    setGymCatalogue([{ id: 'x', presentation: { ...CATALOGUE[2].presentation, wordmark: { text: '<b>X</b>' } } }]);
    expect(gymBrand('x').logo).not.toContain('<b>');
  });
});

// F-7 item 3: styles.css must not name a gym; tokens come from the contract.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gymPresentationCss } from '../gym-context.js';
describe('gym presentation css (F-7 item 3)', () => {
  it('styles.css has no gym-id selectors or tokens', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(css).not.toMatch(/psycle-london|jab-boxing|--gym-jab|--gym-psycle/);
  });
  it('generates tokens for an arbitrary third gym', () => {
    const c = { ink: '#111111', inkHover: '#222222', tint: '#333333', on: '#ffffff' };
    const out = gymPresentationCss(new Map([['acme-fit', { light: c, dark: c }]]));
    expect(out).toContain('--gym-acme-fit-ink:#111111');
    expect(out).toContain('[data-gym="acme-fit"]{--gym-ink:var(--gym-acme-fit-ink)');
    expect(out).toContain('data-theme="light"');
  });
  it('rejects unsafe ids', () => {
    const c = { ink: '#111111', inkHover: '#222222', tint: '#333333', on: '#ffffff' };
    expect(gymPresentationCss(new Map([['a"]{x', { light: c, dark: c }]]))).toBe('');
  });
});

// F-7 item 4: aliases are display-only and scoped to the owning gym.
import { displayStudioName } from './cards.js';
describe('display aliases (F-7 item 4)', () => {
  beforeEach(() => setGymCatalogue(CATALOGUE));
  it('applies only for the owning gym', () => {
    expect(displayStudioName('jab-boxing', 'RECOVERY 2.0')).toBe('Recovery');
    expect(displayStudioName('jab-boxing', ' Recovery  2.0 ')).toBe('Recovery');
    expect(displayStudioName('psycle-london', 'RECOVERY 2.0')).toBe('RECOVERY 2.0');
    expect(displayStudioName('third-gym', 'RECOVERY 2.0')).toBe('RECOVERY 2.0');
    expect(displayStudioName(undefined, 'RECOVERY 2.0')).toBe('RECOVERY 2.0');
  });
  it('leaves unaliased names untouched', () => {
    expect(displayStudioName('jab-boxing', 'BOXING')).toBe('BOXING');
  });
  it('cards.js has no gym-id or recovery literal', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ui/cards.js'), 'utf8');
    expect(src).not.toMatch(/recovery\\s|jab-boxing|includes\('jab'\)/);
  });
});

describe('F-7 guard: no gym id is hardcoded in client code or CSS', () => {
  const root = resolve(process.cwd(), 'src');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const files = walk(root).filter((f) => /\.(js|css)$/.test(f) && !/\.test\.js$|fixture/.test(f));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  it('scans a non-trivial file set', () => expect(files.length).toBeGreaterThan(15));
  it('names no gym id and never branches on a gym', () => {
    const bad = files.filter((f) => /psycle-london|jab-boxing|includes\(['"]jab['"]\)|===?\s*['"]jab/.test(strip(readFileSync(f, 'utf8'))));
    expect(bad.map((f) => f.replace(root, ''))).toEqual([]);
  });
});

describe('gymBrand wordmark scale (data-driven, E2)', () => {
  it('emits --logo-scale only when presentation.wordmark.scale is set and not 1', () => {
    const jab = CATALOGUE.find((g) => g.id === 'jab-boxing');
    const scaled = [{ ...jab, presentation: { ...jab.presentation, wordmark: { ...jab.presentation.wordmark, scale: 0.95 } } }];
    setGymCatalogue(scaled);
    expect(gymBrand('jab-boxing').logo).toContain('--logo-scale:0.95');
    setGymCatalogue(CATALOGUE);
    expect(gymBrand('jab-boxing').logo).not.toContain('--logo-scale');
  });
});


it('uses a settings-only banner width without changing timetable chips or drawer plates', () => {
  const gym = CATALOGUE[1];
  setGymCatalogue([{ ...gym, presentation: { ...gym.presentation, wordmark: { ...gym.presentation.wordmark, logoWidth: 40, settingsLogoWidth: 84 } } }]);
  expect(gymLogoBanner(gym.id, { settings: true })).toContain('--logo-w:84px');
  expect(gymChip(gym.id)).toContain('--logo-w:40px');
  expect(gymLogoPlate(gym.id)).not.toContain('--logo-w:84px');
  expect(gymLogoBanner(gym.id)).toContain('--logo-w:40px');
});

describe('gymBrand form factors (single size-keyed API)', () => {
  beforeEach(() => setGymCatalogue(CATALOGUE));
  it('stamps one size-keyed class per form and defaults to full', () => {
    for (const f of ['square', 'half', 'full']) expect(gymBrand('psycle-london', f).logo).toContain(`gym-logo--${f}`);
    expect(gymBrand('psycle-london').form).toBe('full');
    expect(gymBrand('psycle-london', 'bogus').form).toBe('full');
  });
  it('half is a distinct asset for Psycle, full falls back for single-asset gyms', () => {
    expect(gymBrand('psycle-london', 'half').logo).toContain('half');
    expect(gymBrand('psycle-london').hasHalf).toBe(true);
    expect(gymBrand('jab-boxing').hasHalf).toBe(false);
    expect(gymBrand('jab-boxing', 'half').logo).toContain('/gyms/jab-boxing.svg');
  });
  it('square falls back to the first letter when there is no mark; text-only gym shows its text', () => {
    setGymCatalogue([{ id: 'x', presentation: { ...CATALOGUE[2].presentation, shortName: 'Zed', wordmark: { text: 'ZED' } } }]);
    expect(gymBrand('x', 'square').logo).toContain('>Z<');
    expect(gymBrand('x', 'half').logo).toContain('ZED');
    expect(gymBrand('x', 'full').logo).toContain('ZED');
  });
  it('a squareMark gym shows its mark for half and square, its wordmark for full', () => {
    const g = CATALOGUE[1];
    setGymCatalogue([{ ...g, presentation: { ...g.presentation, wordmark: { ...g.presentation.wordmark, mark: { src: '/m.svg' }, squareMark: true } } }]);
    expect(gymBrand(g.id, 'half').logo).toContain('/m.svg');
    expect(gymBrand(g.id, 'half').isMark).toBe(true);
    expect(gymBrand(g.id, 'full').logo).not.toContain('/m.svg');
  });
  it('chip switches by viewport only when the gym has a distinct half', () => {
    expect(gymChip('psycle-london')).toContain('is-responsive');
    expect(gymChip('psycle-london', { responsive: false })).not.toContain('gym-logo--half');
    expect(gymChip('jab-boxing')).not.toContain('is-responsive');
  });
});
