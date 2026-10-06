import { describe, it, expect } from 'vitest';
import { slotKey } from './spotmap.js';

describe('slotKey', () => {
  it('keeps canonical numeric ids as numbers (saved prefs are number[])', () => {
    expect(slotKey(12)).toBe(12);
    expect(slotKey('12')).toBe(12);
  });
  it('keeps non-numeric ids as distinct strings, never NaN', () => {
    expect(slotKey('mock-bag-1')).toBe('mock-bag-1');
    expect(slotKey('mock-bag-1')).not.toBe(slotKey('mock-ground-1'));
    expect(Number.isNaN(slotKey('mock-bag-1'))).toBe(false);
  });
  it('does not coerce padded or decimal-looking ids that are not canonical', () => {
    expect(slotKey('007')).toBe('007');
    expect(slotKey('1.50')).toBe('1.50');
  });
  it('same-type match works across number and string forms of one id', () => {
    expect([3, 'a-1'].includes(slotKey('3'))).toBe(true);
    expect(['a-1'].map(slotKey).includes(slotKey('a-1'))).toBe(true);
  });
});
