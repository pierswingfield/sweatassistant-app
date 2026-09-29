import { describe, it, expect, beforeEach } from 'vitest';
import { gymBrand, gymChip } from './cards.js';
import { setGymCatalogue, getGymPresentation } from '../gym-context.js';
import { CATALOGUE } from './gym-brand-fixture.js';

describe('gymBrand: presentation contract lookup (F-7 item 2)', () => {
  beforeEach(() => setGymCatalogue(CATALOGUE));

  it('resolves each gym by exact id from the catalogue', () => {
    expect(gymBrand('psycle-london').logoSvg).toContain('/gyms/psycle-london.avif');
    expect(gymBrand('psycle-london').logoSvg).toContain('is-half');
    expect(gymBrand('jab-boxing').logoSvg).toContain('/gyms/jab-boxing.svg');
    expect(gymBrand('jab-boxing').brandBg).toBe('#6C1F20');
  });
  it('does not match by substring: an id merely containing "jab" is neutral', () => {
    const b = gymBrand('jabberwocky-fitness');
    expect(b.id).toBe('neutral');
    expect(b.logoSvg).not.toContain('jab-boxing');
    expect(b.logoSvg).toContain('ab-gym-logo-text');
  });
  it('unknown gym or unloaded catalogue gets the neutral fallback, never Psycle', () => {
    setGymCatalogue([]);
    const b = gymBrand('psycle-london');
    expect(b.id).toBe('neutral');
    expect(b.logoSvg).not.toContain('.avif');
    expect(getGymPresentation('nope')).toBeNull();
  });
  it('a third gym with a text-only wordmark needs no client code', () => {
    const b = gymBrand('third-gym');
    expect(b.id).toBe('third-gym');
    expect(b.logoSvg).toContain('THIRD');
    expect(b.brandBg).toBe('#0a7a3c');
    expect(gymChip('third-gym')).toContain('background:#0a7a3c');
  });
  it('escapes wordmark text', () => {
    setGymCatalogue([{ id: 'x', presentation: { ...CATALOGUE[2].presentation, wordmark: { text: '<b>X</b>' } } }]);
    expect(gymBrand('x').logoSvg).not.toContain('<b>');
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
