import { describe, expect, it } from 'vitest';
import { beforeAll } from 'vitest';

let countPendingAutoBooks;
beforeAll(async () => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  ({ countPendingAutoBooks } = await import('./home.js'));
});

describe('W4 auto-book count', () => {
  it('counts only pending rows across gyms', () => {
    expect(countPendingAutoBooks([{ id: 1 }, { id: 2, executed_at: 'x' }, { id: 3 }])).toBe(2);
  });
  it('never turns not-loaded into zero', () => {
    expect(countPendingAutoBooks(undefined)).toBeNull();
    expect(countPendingAutoBooks([])).toBe(0);
  });
});
