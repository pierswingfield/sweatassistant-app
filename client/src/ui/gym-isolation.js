// Pure helpers for lookups whose IDs are unique only within one gym.

export function isCreditInventoryLoaded(cache, gymId, metered) {
  return !metered || cache?.creditsByGym?.[gymId] != null;
}

export function pickStudioPrefs(allPrefs, studioId, gymId, allowLegacyFallback = false) {
  if (!allPrefs || studioId == null) return {};
  const key = gymId ? `${gymId}:${studioId}` : studioId;
  return allPrefs[key] || (allowLegacyFallback && gymId ? allPrefs[studioId] : {}) || {};
}

export function findActiveUpgradeForBooking(upgrades, bookingId, gymId) {
  if (bookingId == null) return undefined;
  return (upgrades || []).find(upgrade =>
    String(upgrade.booking_id) === String(bookingId) &&
    (!gymId || String(upgrade.gym_id ?? upgrade.gymId) === String(gymId)) &&
    ['active', 'paused_no_credits'].includes(upgrade.status)
  );
}

// The monitor that belongs to one held seat, for the My Bookings chip. Matches on
// booking id, falling back to event+slot: cancel-then-rebook (edit spots, an
// upgrade) mints a new booking id, and a chip keyed on the id alone silently loses
// its monitor while the server still counts it. Live monitors win over stopped ones;
// a stopped one is still returned so the chip can show it (and re-enable it).
export function findUpgradeForSeat(upgrades, { bookingId, gymId, eventId, slotId }) {
  const inGym = (u) => !gymId || String(u.gym_id ?? u.gymId) === String(gymId);
  const mine = (upgrades || []).filter(u => inGym(u) && (
    (bookingId != null && String(u.booking_id) === String(bookingId)) ||
    (eventId != null && slotId != null && slotId !== '' &&
      String(u.event_id) === String(eventId) && String(u.current_slot_id) === String(slotId))
  ));
  const live = mine.find(u => ['active', 'paused_no_credits'].includes(u.status));
  return live || mine.find(u => u.status === 'stopped');
}
