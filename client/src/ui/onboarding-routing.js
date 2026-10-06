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

/**
 * Destination for a COLD LOAD with an existing session (reload, PWA launch, deep link).
 * The optional setup screen is a post-login nudge: once the account has dismissed it ("Set up later"
 * records completion), a cold load must not bring it back, or every launch and every deep link is
 * interrupted. The full flow (no gym linked) is never suppressed.
 */
export function coldBootDestination(destination, dismissed) {
  return destination === 'optional' && dismissed ? 'home' : destination;
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

/**
 * Which install-to-home-screen situation is this browser in? Pure (all inputs injected) so it can be tested.
 * `mobile` = an iOS/Android UA, or a touch device with a narrow viewport. `standalone` = already running as
 * an installed app (display-mode: standalone / navigator.standalone), in which case there is nothing to offer.
 * platform: ios-safari | ios-other | android-chrome | android-samsung | android-other | other
 */
export function detectInstallContext({
  userAgent = '', standalone = false, displayStandalone = false,
  maxTouchPoints = 0, viewportWidth = 1024, hasPromptEvent = false,
} = {}) {
  const ua = String(userAgent);
  const iPadOS = /Macintosh/.test(ua) && maxTouchPoints > 1;           // iPadOS reports a desktop UA
  const ios = /iPad|iPhone|iPod/.test(ua) || iPadOS;
  const android = /Android/.test(ua);
  const touchNarrow = maxTouchPoints > 0 && viewportWidth <= 820;
  const mobile = ios || android || touchNarrow;
  let platform = 'other';
  if (ios) platform = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser/.test(ua) ? 'ios-other' : 'ios-safari';
  else if (android) {
    if (/SamsungBrowser/.test(ua)) platform = 'android-samsung';
    else if (/Chrome\//.test(ua) && !/EdgA|OPR\/|Firefox|DuckDuckGo/.test(ua)) platform = 'android-chrome';
    else platform = 'android-other';
  }
  return { mobile, platform, standalone: !!(standalone || displayStandalone), canPrompt: !!hasPromptEvent };
}

/**
 * Offer the install step in a mobile browser tab (not an installed app) on every flow entry until the user
 * has both chosen "Continue in browser" and logged in (`dismissed` = that persistent flag). Showing it
 * never counts as seeing it.
 */
export function shouldOfferInstall(ctx, dismissed = false) {
  return !!(ctx && ctx.mobile && !ctx.standalone && !dismissed);
}
