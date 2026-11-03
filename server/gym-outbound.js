// Outbound gate for DISABLED gyms — the one place that decides whether the server
// may talk to a gym's provider at all.
//
// "Disabled" means either of:
//   1. the gym itself: `gyms.enabled = 0` in the registry mirror (synced from
//      gyms.config.js `enabled`, and what linkGymAccount's rollout gate reads),
//      or the config entry itself saying `enabled: false`, or an unknown gym;
//   2. one account's link to it: `user_gyms.status = 'disabled'` (only when a
//      userId is known — the provider-level backstop has no user).
//
// A disabled gym keeps its DATA: links, queues, spot maps, class_history and
// booking caches all survive, and db.resolveActiveGymId deliberately still
// resolves onto it (test-active-gym.js). What stops is every OUTBOUND call:
// provider reads/writes, logins, session refreshes, history syncs and the
// scheduler/poller/calendar background work. Two layers enforce that:
//   - call sites that have a user (resolveContext, triggerAutoRelogin, class
//     history, scheduler/poller/calendar loops) ask isOutboundBlocked() first, so
//     a disabled gym is SKIPPED cleanly rather than recorded as a failure;
//   - providers/index.js wraps every adapter so any I/O method on a disabled gym
//     rejects with GYM_DISABLED before reaching the adapter — the backstop for
//     any path that forgets (admin, photos, freshness, schedule cache).

const { getGymConfig } = require('./gyms.config');

let registryStmt = null;
let linkStmt = null;
function dbHandle() {
  // Lazy: providers/index.js requires this module, and db.js must not be pulled
  // into the provider layer at load time.
  return require('./db').db;
}

/** True when the gym itself is disabled (or unknown). No user needed. */
function isGymDisabled(gymId) {
  if (!gymId) return true;
  const cfg = getGymConfig(gymId);
  if (!cfg || cfg.enabled === false) return true;
  try {
    if (!registryStmt) registryStmt = dbHandle().prepare('SELECT enabled FROM gyms WHERE id = ?');
    const row = registryStmt.get(String(gymId));
    if (row && !row.enabled) return true;
  } catch (_) { /* registry unreadable: fall back to the config answer */ }
  return false;
}

/** True when this account's link to the gym is switched off. */
function isLinkDisabled(userId, gymId) {
  if (userId == null || !gymId) return false;
  try {
    if (!linkStmt) linkStmt = dbHandle().prepare('SELECT status FROM user_gyms WHERE user_id = ? AND gym_id = ?');
    const row = linkStmt.get(userId, String(gymId));
    return !!row && row.status === 'disabled';
  } catch (_) {
    return false;
  }
}

/** The one question every outbound path asks. */
function isOutboundBlocked(gymId, userId = null) {
  return isGymDisabled(gymId) || isLinkDisabled(userId, gymId);
}

function gymDisabledError(gymId) {
  const err = new Error(`Gym "${gymId}" is disabled; no provider calls are made for it.`);
  err.status = 409;
  err.code = 'GYM_DISABLED';
  err.gymId = gymId;
  err.gymDisabled = true;
  return err;
}

function assertOutboundAllowed(gymId, userId = null) {
  if (isOutboundBlocked(gymId, userId)) throw gymDisabledError(gymId);
}

// Adapter members that never touch the network and stay usable for a disabled
// gym (capability flags, mock identity, pure mapping/policy helpers).
const PURE_MEMBERS = new Set([
  'constructor', 'gym', 'capabilities', 'mockToken', 'isMockLogin', 'isMockUser', 'isPublicRead',
  'hasFreshnessStamps', 'resolveBookingWindow', 'releaseAtFor', 'buildHeaders', 'browserHeaders',
  'url', 'toPath', 'invalidateProfile', 'resolveEventRelations', 'mapEventToNormalized',
  'mapClassToEvent', 'mapLayoutToSlots', 'generatePkce', '_profileKey', '_spotSection', '_historyStatus',
  '_rememberInstructorPhoto', 'then',
]);

/**
 * Wrap an adapter so every I/O member rejects with GYM_DISABLED while its gym is
 * disabled. Checked per call (not at wrap time), so enabling or disabling a gym
 * takes effect without a restart. Internal `this.request(...)` calls go through
 * the proxy too, because methods are invoked with the proxy as `this`.
 */
function guardProvider(instance, gymId) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || PURE_MEMBERS.has(prop)) return value;
      if (!isGymDisabled(gymId)) return value;
      return function blockedProviderCall() {
        return Promise.reject(gymDisabledError(gymId));
      };
    },
  });
}

module.exports = {
  isGymDisabled, isLinkDisabled, isOutboundBlocked, assertOutboundAllowed, gymDisabledError, guardProvider,
};
