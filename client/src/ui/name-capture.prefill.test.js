import { describe, it, expect } from 'vitest';
import { validPrefill } from './name-capture.js';

describe('validPrefill (mirrors server/user-text.js checkPersonName)', () => {
  it('keeps a valid name, normalised', () => {
    expect(validPrefill('  Mary   Ann ')).toBe('Mary Ann');
    expect(validPrefill('Ａna')).toBe('Ana');
    expect(validPrefill('Zoë')).toBe('Zoë');
  });
  it('returns empty for anything the server would reject', () => {
    for (const v of ['<b>x', 'a​b', 'a‮b', 'a\u0007b', 'x'.repeat(41), 'a＜']) expect(validPrefill(v)).toBe('');
  });
  it('handles empty input', () => {
    expect(validPrefill(undefined)).toBe('');
    expect(validPrefill('')).toBe('');
  });
});
