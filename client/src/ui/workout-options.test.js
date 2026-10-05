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
