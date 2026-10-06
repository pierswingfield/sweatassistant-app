import { describe, it, expect } from 'vitest';
import { buildWorkoutOptions } from './workout-options.js';

const labelOf = (g) => String(g);
const all = () => true;

describe('buildWorkoutOptions', () => {
  it('back-fills from events when metadata classTypes are empty', () => {
    const out = buildWorkoutOptions({
      eventTypes: [], events: [{ discipline: 'Ride', gymId: 'p' }, { discipline: 'Ride', gymId: 'p' }, { discipline: 'Boxing', gymId: 'j' }],
      gymOk: all, labelOf,
    });
    expect(out.map(o => `${o.gymId}:${o.id}`)).toEqual(['j:Boxing', 'p:Ride']);
  });
  it('back-fills when classTypes lack a group', () => {
    const out = buildWorkoutOptions({ eventTypes: [{ id: '1', gymId: 'p' }], events: [{ discipline: 'Barre', gymId: 'p' }], gymOk: all, labelOf });
    expect(out).toHaveLength(1);
  });
  it('dedupes metadata and events and respects the gym filter', () => {
    const out = buildWorkoutOptions({
      eventTypes: [{ group: 'Ride', gymId: 'p' }], events: [{ discipline: 'Ride', gymId: 'p' }, { discipline: 'Boxing', gymId: 'j' }],
      gymOk: (g) => g === 'p', labelOf,
    });
    expect(out).toHaveLength(1);
  });
});

import { stripVariantSuffix } from './workout-options.js';
describe('stripVariantSuffix', () => {
  it('collapses duration and audience variants', () => {
    const k = (n) => stripVariantSuffix(n).toLowerCase();
    expect(k('Recovery 30m')).toBe(k('Recovery'));
    expect(k('RECOVERY (Members)')).toBe('recovery');
    expect(k('Recovery - 45 min')).toBe('recovery');
    expect(stripVariantSuffix('BOXING Core & Power')).toBe('BOXING Core & Power');
  });
  it('never returns empty', () => { expect(stripVariantSuffix('30m')).toBeTruthy(); });
  it('groups variants into one JAB option', () => {
    const out = buildWorkoutOptions({
      eventTypes: [{ group: 'Recovery', gymId: 'j' }, { group: 'Recovery 30m', gymId: 'j' }],
      events: [{ discipline: 'RECOVERY (Members)', gymId: 'j' }], gymOk: all,
      labelOf: (g) => stripVariantSuffix(g).toLowerCase(),
    });
    expect(out).toHaveLength(1);
  });
});
