// My Bookings manual Auto-Upgrade: decide whether the seat being enabled is a lone seat or part of a
// GROUP (2+ of the member's own reservations on the same class). A group gets ONE monitor over every
// reservation; a guest on the class blocks it (swapping a guest reservation is unproven).
const same = (a, b) => String(a) === String(b);
const bookingIdOf = (b) => b?.bookingId ?? b?.id;
const slotIdOf = (b) => b?.slotId ?? b?.studio_slot?.id ?? b?.studio_slot_id ?? b?.slot_id ?? b?.slot;

/** @returns {{kind:'single'}|{kind:'guest'}|{kind:'group', members:{bookingId:number, slotId:*}[]}} */
export function resolveUpgradeGroup(bookings, { gymId, eventId, bookingId }) {
  const onClass = (bookings || []).filter((b) => b && !b.isWaitlist && same(b.eventId ?? b.event_id ?? b.event?.id, eventId)
    && (!gymId || !b.gymId || same(b.gymId, gymId)));
  const own = onClass.filter((b) => !b.isGuest);
  if (own.length < 2 || !own.some((b) => same(bookingIdOf(b), bookingId))) return { kind: 'single' };
  if (onClass.some((b) => b.isGuest)) return { kind: 'guest' };
  return { kind: 'group', members: own.map((b) => ({ bookingId: Number(bookingIdOf(b)), slotId: slotIdOf(b) })) };
}
