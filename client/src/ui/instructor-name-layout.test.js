import { describe, expect, it } from 'vitest';
import { instructorNameLengthClass } from './cards.js';

describe('instructor name layout class', () => {
  it('centres names with fewer than ten visible Unicode code points', () => {
    expect(instructorNameLengthClass('  Louise  ')).toBe('is-short-name');
    expect(instructorNameLengthClass('😀'.repeat(9))).toBe('is-short-name');
  });

  it('uses the long-name layout at ten characters and above', () => {
    expect(instructorNameLengthClass('LouiseAnn')).toBe('is-short-name');
    expect(instructorNameLengthClass('LouiseAnne')).toBe('is-long-name');
    expect(instructorNameLengthClass('😀'.repeat(10))).toBe('is-long-name');
  });
});
