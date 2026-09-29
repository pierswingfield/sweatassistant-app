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
