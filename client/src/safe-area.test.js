import { describe, it, expect } from 'vitest';
import { shouldCover } from './safe-area.js';

describe('shouldCover', () => {
  it('is on only for a standalone page with a positive inset', () => {
    expect(shouldCover({ standalone: true, inset: 62 })).toBe(true);
    expect(shouldCover({ standalone: true, inset: 0 })).toBe(false);
    expect(shouldCover({ standalone: false, inset: 62 })).toBe(false);
    expect(shouldCover({ standalone: true, inset: NaN })).toBe(false);
  });
});
