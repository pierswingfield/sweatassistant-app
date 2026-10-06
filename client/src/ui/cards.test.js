import { describe, it, expect } from 'vitest';
import { cleanClassName, SVG_PATHS } from './cards.js';

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

  it('never blanks a name or leaves a bare number', () => {
    expect(cleanClassName('BOXING', 'BOXING')).toBe('Boxing');
    expect(cleanClassName('Barre 55', 'Barre')).toBe('Barre 55');
    expect(cleanClassName('', 'TRAIN')).toBe('');
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
