/** Choose the post-login onboarding destination from the account's saved setup. */
export function getPostLoginDestination({
  linkedGymCount = 0,
  hasPreferredSpotMap = false,
  calendarEnabled = false,
  notificationsEnabled = false,
} = {}) {
  if (linkedGymCount < 1) return 'full';
  if (!hasPreferredSpotMap || !calendarEnabled || !notificationsEnabled) return 'optional';
  return 'home';
}

/** Enable Auto-Upgrade polling for each linked gym that supports the feature. */
export async function enableAutoUpgradeForGyms(linkedGyms, catalogue, updateSettings) {
  const configured = new Map((catalogue || []).map((gym) => [gym.id, gym]));
  const gymIds = [...new Set((linkedGyms || []).map((link) => link.gym_id || link.gymId || link.id).filter(Boolean))]
    .filter((gymId) => configured.has(gymId) && configured.get(gymId)?.capabilities?.autoUpgrade !== false);

  const results = await Promise.allSettled(gymIds.map((gymId) => updateSettings({ autoUpgradeEnabled: true }, gymId)));
  return {
    enabledGymIds: gymIds.filter((_, index) => results[index].status === 'fulfilled'),
    failedGymIds: gymIds.filter((_, index) => results[index].status === 'rejected'),
  };
}

/** Gym logos scroll as a marquee only when there are more than this many. */
export const GYM_LOGO_STATIC_MAX = 3;
export function shouldAnimateGymLogos(count) {
  return Number(count) > GYM_LOGO_STATIC_MAX;
}
