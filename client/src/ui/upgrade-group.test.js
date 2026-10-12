import { describe, it, expect } from 'vitest';
import { resolveUpgradeGroup } from './upgrade-group.js';

const b = (id, slot, extra = {}) => ({ bookingId: id, eventId: 5, gymId: 'g', slotId: slot, ...extra });
const ctx = { gymId: 'g', eventId: 5, bookingId: 1 };
describe('resolveUpgradeGroup', () => {
  it('one own seat stays single', () => expect(resolveUpgradeGroup([b(1, 10)], ctx).kind).toBe('single'));
  it('2+ own seats on the class become one group of all of them', () => {
    const r = resolveUpgradeGroup([b(1, 10), b(2, 11), b(3, 12, { eventId: 6 })], ctx);
    expect(r).toEqual({ kind: 'group', members: [{ bookingId: 1, slotId: 10 }, { bookingId: 2, slotId: 11 }] });
  });
  it('a guest on the class blocks the group', () => expect(resolveUpgradeGroup([b(1, 10), b(2, 11), b(3, 12, { isGuest: true })], ctx).kind).toBe('guest'));
  it('ignores waitlists and other gyms', () => expect(resolveUpgradeGroup([b(1, 10), b(2, 11, { isWaitlist: true }), b(4, 9, { gymId: 'x' })], ctx).kind).toBe('single'));
});
