import { describe, it, expect } from 'vitest';
import { cleanClassName } from './cards.js';

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
