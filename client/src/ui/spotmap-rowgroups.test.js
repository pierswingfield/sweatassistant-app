import { describe, it, expect } from 'vitest';
import { studioHasRowGroups, rowSelectorVisible } from './spotmap.js';

describe('studioHasRowGroups', () => {
  it('defaults off for unknown, stub or unflagged studios', () => {
    expect(studioHasRowGroups(undefined)).toBe(false);
    expect(studioHasRowGroups({ id: '1', name: 'BOXING' })).toBe(false);
    expect(studioHasRowGroups({ id: '1', rowGroups: false })).toBe(false);
    expect(studioHasRowGroups({ id: '1', rowGroups: 'true' })).toBe(false);
  });
  it('is on only when the normalized flag is true', () => {
    expect(studioHasRowGroups({ id: '108', rowGroups: true })).toBe(true);
  });
});

describe('rowSelectorVisible', () => {
  it('needs the flag, editing mode and more than one row', () => {
    expect(rowSelectorVisible({ rowGroups: true, rowCount: 5, editing: true })).toBe(true);
    expect(rowSelectorVisible({ rowGroups: false, rowCount: 5, editing: true })).toBe(false);
    expect(rowSelectorVisible({ rowGroups: true, rowCount: 5, editing: false })).toBe(false);
    expect(rowSelectorVisible({ rowGroups: true, rowCount: 1, editing: true })).toBe(false);
    expect(rowSelectorVisible({ rowGroups: undefined, rowCount: 5, editing: true })).toBe(false);
  });
});
