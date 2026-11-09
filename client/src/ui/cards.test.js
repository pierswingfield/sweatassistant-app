import { describe, it, expect } from 'vitest';
import { cleanClassName, getDiscipline, SVG_PATHS } from './cards.js';

it('has a distinct plus glyph for guest-booking actions', () => {
  expect(SVG_PATHS.plus).toContain('M8 3v10');
});

describe('cleanClassName (U1-11)', () => {
  it("JAB: `discipline` is the full class_type.name, so the head 'TRAIN' is dropped", () => {
    const n = 'TRAIN - Upper (Focus)';
    expect(cleanClassName(n, n)).toBe('Upper (Focus)');
    expect(cleanClassName(n, 'TRAIN')).toBe('Upper (Focus)');
    expect(cleanClassName('TRAIN - Full Body Conditioning', 'TRAIN - Full Body Conditioning')).toBe('Full Body Conditioning');
    expect(cleanClassName('TRAIN – Core & Glutes', 'train')).toBe('Core & Glutes');
  });

  it('JAB: no separator at all', () => {
    expect(cleanClassName('BOXING Core & Power', 'BOXING Core & Power')).toBe('Core & Power');
  });

  it("Psycle: 'DISCIPLINE: name' and case-insensitive matches", () => {
    expect(cleanClassName('Ride: Signature 45', 'Ride')).toBe('Signature 45');
    expect(cleanClassName('RECOVERY (Members)', 'Recovery')).toBe('Members');
    expect(cleanClassName('barre - Burn', 'BARRE')).toBe('Burn');
  });

  it('does not strip arbitrary dashes or a prefix that is not the discipline', () => {
    expect(cleanClassName('Upper - Lower Split', 'TRAIN')).toBe('Upper - Lower Split');
    expect(cleanClassName('Pilates - Core', 'RIDE')).toBe('Pilates - Core');
    expect(cleanClassName('Full Body - Fast', 'Ride')).toBe('Full Body - Fast');
  });

  it('removes decorative leading separators, including after the discipline', () => {
    expect(cleanClassName('LAGREE | Lagree & Free Shake (Signature 50)', 'Lagree')).toBe('Lagree & Free Shake (Signature 50)');
    expect(cleanClassName('\u00a0 | | – \u2003| Signature 45', 'Ride')).toBe('Signature 45');
    expect(cleanClassName('Ride｜ | Signature 45', 'Ride')).toBe('Signature 45');
    expect(cleanClassName('Ride - | — Signature 45', 'Ride')).toBe('Signature 45');
  });

  it('preserves meaningful initial punctuation and internal separators', () => {
    for (const name of ['#1 Ride', '“Flow” & Focus', '(Members) Flow', '-5 Challenge', 'Ride | Flow', 'Core - Lower', 'A: B']) {
      expect(cleanClassName(name)).toBe(name);
    }
    expect(cleanClassName('Ride: #1 Challenge', 'Ride')).toBe('#1 Challenge');
    expect(cleanClassName(' | “Flow” | Focus', '')).toBe('“Flow” | Focus');
  });

  it('never blanks a name or leaves a bare number', () => {
    expect(cleanClassName('BOXING', 'BOXING')).toBe('Boxing');
    expect(cleanClassName('Barre 55', 'Barre')).toBe('Barre 55');
    expect(cleanClassName('', 'TRAIN')).toBe('');
  });
});

describe('JAB Recovery discipline label (U6-12)', () => {
  it('normalises the member-qualified provider discipline to Recovery', () => {
    expect(getDiscipline('RECOVERY (Members)').label).toBe('Recovery');
  });
});

describe('getDiscipline & passesDisciplineFilter (Pilates vs Reformer)', () => {
  it('differentiates Pilates and Reformer labels while sharing the reformer key/icon', async () => {
    const { getDiscipline } = await import('./cards.js');
    const pil = getDiscipline('Pilates');
    expect(pil.label).toBe('Pilates');
    expect(pil.key).toBe('reformer');
    expect(pil.icon).toBe('reformer');

    const ref = getDiscipline('Reformer');
    expect(ref.label).toBe('Reformer');
    expect(ref.key).toBe('reformer');
    expect(ref.icon).toBe('reformer');
  });

  it('treats Pilates and Reformer as semantically equivalent for filtering', async () => {
    const { passesDisciplineFilter } = await import('./cards.js');
    expect(passesDisciplineFilter(['Pilates'], 'Pilates')).toBe(true);
    expect(passesDisciplineFilter(['Pilates'], 'Reformer')).toBe(true);
    expect(passesDisciplineFilter(['Reformer'], 'Pilates')).toBe(true);
    expect(passesDisciplineFilter(['Reformer'], 'Reformer')).toBe(true);
    expect(passesDisciplineFilter(['Ride'], 'Pilates')).toBe(false);
    expect(passesDisciplineFilter(['Ride'], 'Reformer')).toBe(false);
  });

  it('labels Lagree separately and keeps it distinct from Reformer/Pilates', async () => {
    const { getDiscipline, passesDisciplineFilter } = await import('./cards.js');
    const lag = getDiscipline('Lagree');
    expect(lag.label).toBe('Lagree');
    expect(lag.key).toBe('reformer');

    expect(passesDisciplineFilter(['Lagree'], 'Lagree')).toBe(true);
    expect(passesDisciplineFilter(['Lagree'], 'Reformer')).toBe(false);
    expect(passesDisciplineFilter(['Lagree'], 'Pilates')).toBe(false);
    expect(passesDisciplineFilter(['Reformer'], 'Lagree')).toBe(false);
    expect(passesDisciplineFilter(['Pilates'], 'Lagree')).toBe(false);
  });
});

describe('action rail state', () => {
  it('preserves the same gym-qualified card across refresh and resets on logout', async () => {
    const { wireRailToggle, closeAllRails } = await import('./cards.js');
    closeAllRails();
    const container = document.createElement('div'); container.id = 'refresh-test'; document.body.appendChild(container);
    const paint = (gym = 'g') => {
      container.innerHTML = `<div class="ab-card" data-event-id="1" data-gym="${gym}"><div class="ab-card-footer"></div><div class="ab-card-rail"><button class="ab-rail-btn"></button></div></div>`;
      wireRailToggle(container);
    };
    paint(); container.querySelector('.ab-rail-toggle').click();
    paint();
    expect(container.querySelector('.ab-rail-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ab-card-rail').hasAttribute('inert')).toBe(false);
    paint('other'); expect(container.querySelector('.is-rail-open')).toBeNull();
    paint(); expect(container.querySelector('.is-rail-open')).not.toBeNull();
    expect(closeAllRails()).toBe(1);
    paint(); expect(container.querySelector('.is-rail-open')).toBeNull();
    container.querySelector('.ab-rail-toggle').click();
    window.dispatchEvent(new Event('app-logout-triggered'));
    paint(); expect(container.querySelector('.is-rail-open')).toBeNull();
    container.remove();
  });
});
