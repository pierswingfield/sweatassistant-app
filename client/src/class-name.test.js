import { describe, it, expect } from 'vitest';
import { cleanClassNameWith, disciplineHead } from './class-name.js';
import { cleanClassName } from './ui/cards.js';

describe('U1-11/U1-19b class-name rule', () => {
  it('drops the whole-name discipline prefix (JAB)', () => {
    expect(cleanClassName('TRAIN - Lower (Focus)', 'TRAIN - Lower (Focus)')).toBe('Lower (Focus)');
    expect(cleanClassName('TRAIN - Lower (Focus)', 'TRAIN')).toBe('Lower (Focus)');
  });
  it('is what cards.cleanClassName delegates to', () => {
    expect(cleanClassName('RIDE: Signature 45', 'Ride')).toBe(cleanClassNameWith('RIDE: Signature 45', 'Ride', 'Ride'));
  });
  it('head of a discipline', () => {
    expect(disciplineHead('TRAIN - Lower (Focus)')).toBe('TRAIN');
    expect(disciplineHead('Ride')).toBe('Ride');
  });
});
