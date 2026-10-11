import { describe, expect, it } from 'vitest';
import { orderCompanionSlots } from './companion-slots.js';

const slots = [
  { id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 2, y: 0 },
  { id: 'd', x: 10, y: 0 }, { id: 'e', x: 11, y: 0 },
];
describe('orderCompanionSlots (guest beside the primary)', () => {
  it('orders by distance from where the primary actually is', () => {
    expect(orderCompanionSlots({ slots, candidates: ['a', 'c', 'd', 'e'], primarySlotId: 'b' }).slice(0, 2)).toEqual(['a', 'c']);
    expect(orderCompanionSlots({ slots, candidates: ['a', 'c', 'd'], primarySlotId: 'e' })[0]).toBe('d');
  });
  it('keeps input order for ties and without coordinates', () => {
    expect(orderCompanionSlots({ slots, candidates: ['c', 'a'], primarySlotId: 'b' })).toEqual(['c', 'a']);
    expect(orderCompanionSlots({ slots: [{ id: 'x' }], candidates: ['q', 'r'], primarySlotId: 'x' })).toEqual(['q', 'r']);
  });
});

import { orderTogetherSlots } from './companion-slots.js';
import { showCancelRebookSetting } from './gym-settings-section.js';
import { describe as d2, it as i2, expect as e2 } from 'vitest';

d2('orderTogetherSlots (Quick-Book self group togetherness)', () => {
  const slots = [1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), x: n * 100, y: 0 }));
  i2('picks adjacent seats instead of the first two preferred ones', () => {
    // preferred 1 and 6 are far apart; 5+6 are adjacent and 1 is a preferred anchor but alone
    const out = orderTogetherSlots({ slots, candidates: ['1', '6', '5', '2'], count: 2, preferredCount: 2 });
    e2(out.slice(0, 2).sort()).toEqual(['1', '2']);
    e2(out).toHaveLength(4);
  });
  i2('keeps input order without coordinates or for a single spot', () => {
    e2(orderTogetherSlots({ slots: [{ id: '1' }, { id: '2' }], candidates: ['2', '1'], count: 2 })).toEqual(['2', '1']);
    e2(orderTogetherSlots({ slots, candidates: ['6', '1'], count: 1 })).toEqual(['6', '1']);
  });
});

d2('cancel & rebook setting visibility', () => {
  i2('hidden only for gyms with a direct swap', () => {
    e2(showCancelRebookSetting({ capabilities: { atomicSwap: true } })).toBe(false);
    e2(showCancelRebookSetting({ capabilities: { atomicSwap: false } })).toBe(true);
    e2(showCancelRebookSetting({})).toBe(true);
  });
});
