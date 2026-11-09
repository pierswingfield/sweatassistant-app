// Outbound gate for DISABLED gyms — the one place that decides whether the server
// may talk to a gym's provider at all.
//
// "Disabled" means any of:
//   0. PRIMARY — the member switched it off: Settings > the gym > "Use this gym"
//      writes `user_gyms.account_enabled = 0` (db.setUserGymEnabled). That hides
//      the gym outside Settings AND stops all communication with it; switching it
//      back on restores both on the very next call (checked per call, no cache);
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

// Demo fixture accounts (users.is_fixture, server/scripts/seed-team-fixtures.js). Two
// independent markers so a missed path still cannot reach a gym: the DB flag (every
// call site that knows a user id goes through isOutboundBlocked) and this sentinel
// access token stored as the fixture's gym session (the provider layer sees a token,
// never a user id, so guardProvider and the adapters' request() refuse it).
const FIXTURE_TOKEN = 'fixture-no-network';

let fixtureStmt = null;
function isFixtureUser(userId) {
  if (userId == null) return false;
  try {
    if (!fixtureStmt) fixtureStmt = dbHandle().prepare('SELECT is_fixture FROM users WHERE id = ?');
    const row = fixtureStmt.get(userId);
    return !!(row && row.is_fixture);
  } catch (_) { return false; }
}

/** True when a value (token, session, credentials, or args) carries the fixture sentinel. */
function carriesFixtureToken(value, depth = 0) {
  if (value === FIXTURE_TOKEN) return true;
  if (!value || typeof value !== 'object' || depth > 3) return false;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    if (carriesFixtureToken(v, depth + 1)) return true;
  }
  return false;
}

function fixtureError(gymId) {
  const err = new Error('Fixture account: no provider calls are ever made for it.');
  err.status = 409;
  err.code = 'FIXTURE_ACCOUNT';
  err.gymId = gymId;
  err.gymDisabled = true; // existing handlers treat it like a gym that is switched off
  return err;
}

/** Adapter-level backstop: throw before any network I/O when the token is the fixture's. */
function assertNotFixtureToken(token, gymId) {
  if (token === FIXTURE_TOKEN) throw fixtureError(gymId);
}

/** True when this account's link to the gym is switched off (by the member, or link status), or the account is a fixture. */
function isLinkDisabled(userId, gymId) {
  if (userId == null || !gymId) return false;
  if (isFixtureUser(userId)) return true;
  try {
    if (!linkStmt) linkStmt = dbHandle().prepare('SELECT status, account_enabled FROM user_gyms WHERE user_id = ? AND gym_id = ?');
    const row = linkStmt.get(userId, String(gymId));
    return !!row && (row.account_enabled === 0 || row.status === 'disabled');
  } catch (_) {
    return false;
  }
}

/** The user of the current request context, if any (background work has none). */
function contextUserId() {
  try {
    const db = require('./db');
    return typeof db.currentGymContextUserId === 'function' ? db.currentGymContextUserId() : null;
  } catch (_) { return null; }
}

/** The one question every outbound path asks. */
function isOutboundBlocked(gymId, userId = null) {
  return isGymDisabled(gymId) || isLinkDisabled(userId, gymId) || require('./gym-connection').unavailable(userId, gymId);
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
  if (isGymDisabled(gymId) || isLinkDisabled(userId, gymId)) throw gymDisabledError(gymId);
  if (require('./gym-connection').unavailable(userId, gymId)) throw require('./gym-connection').expiredError(gymId);
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
      // Registry/config disable needs no user; the member's own switch is read
      // from the request's gym context (db.runWithGymContext) when there is one.
      if (isGymDisabled(gymId) || isLinkDisabled(contextUserId(), gymId)) {
        return function blockedProviderCall() {
          return Promise.reject(gymDisabledError(gymId));
        };
      }
      // A fixture session/credential in the arguments: refuse before the adapter runs.
      return function fixtureGuarded(...args) {
        if (carriesFixtureToken(args)) return Promise.reject(fixtureError(gymId));
        if (require('./gym-connection').unavailable(contextUserId(), gymId)) return Promise.reject(require('./gym-connection').expiredError(gymId));
        return value.apply(this, args);
      };
    },
  });
}

module.exports = {
  FIXTURE_TOKEN, isFixtureUser, carriesFixtureToken, assertNotFixtureToken, fixtureError,
  isGymDisabled, isLinkDisabled, isOutboundBlocked, assertOutboundAllowed, gymDisabledError, guardProvider,
};
