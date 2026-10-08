/** Whether any linked gym that supports Auto-Upgrade has its engine disabled. */
export function hasDisabledAutoUpgradeGym(gyms, canForGym, gymSetting) {
  const available = (gyms || []).map((gym) => String(gym?.gym_id || gym?.id || ''))
    .filter((gymId) => gymId && canForGym('autoUpgrade', gymId));
  return available.length > 0
    && available.some((gymId) => gymSetting(gymId, 'autoUpgradeEnabled') === false);
}

/** Claim an account-scoped tip before displaying it, so later bookings stay quiet. */
export function claimAutoUpgradeTipOnce(storage, key) {
  if (!storage || !key) return false;
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, '1');
    return true;
  } catch (_) {
    return false;
  }
}
