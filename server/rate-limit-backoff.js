// Sweat Assistant — shared per-gym provider rate-limit backoff (C2-3, C2-3b).
//
// ONE state, used by every background actor that talks to a gym: the
// auto-book scheduler and the poller (auto-upgrade attempts, resume checks,
// reminder/cache fetches). It used to live inside scheduler.js and the poller
// reached in for a single read of it, so the two could never agree about a
// gym that was refusing us.
//
// Keyed by gymId only (WP-D7/WP-G: never by platform, never global): a 429
// from Psycle must not pause JAB.
//
// The signal comes from the adapter, never from a platform name here:
//   - write paths return NormalizedBookingResult.code === 'PROVIDER_RATE_LIMITED'
//     (providers/base.js classifyProviderThrottle)
//   - read paths throw an Error with `.status === 429` (httpError in the adapters)
//   - raw Responses (poller.fetchFromGym) are classified with classifyProviderThrottle.

const { DateTime } = require('luxon');
const { classifyProviderThrottle } = require('./providers/base');

const rateLimitBackoffUntil = new Map(); // gymId -> epoch ms
// Used when the provider's response didn't carry a Retry-After.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

function isGymRateLimited(gymId) {
  const until = rateLimitBackoffUntil.get(gymId);
  return typeof until === 'number' && Date.now() < until;
}

function applyRateLimitBackoff(gymId, retryAfterMs) {
  const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const until = Date.now() + ms;
  const prior = rateLimitBackoffUntil.get(gymId) || 0;
  const next = Math.max(prior, until);
  rateLimitBackoffUntil.set(gymId, next);
  return next;
}

/**
 * If `err` is a thrown provider read failure that means "throttled" (HTTP 429),
 * arm this gym's backoff. Returns true when it did. A 403 is deliberately NOT
 * handled here: a thrown error carries no body to corroborate throttle
 * language, and an ordinary 403 must not pause a gym (base.js rule).
 */
function noteThrottleError(gymId, err) {
  if (!err) return false;
  if (err.code === 'PROVIDER_RATE_LIMITED' || err.status === 429) {
    applyRateLimitBackoff(gymId, err.retryAfterMs);
    return true;
  }
  return false;
}

/** Same for a raw fetch Response (poller.fetchFromGym callers). `data` optional, for 403 wording. */
function noteThrottleResponse(gymId, res, data) {
  if (!res) return false;
  const t = classifyProviderThrottle(res, data);
  if (!t.limited) return false;
  applyRateLimitBackoff(gymId, t.retryAfterMs);
  return true;
}

// Test-only: reset between cases sharing a process.
function _resetRateLimitBackoffForTests() {
  rateLimitBackoffUntil.clear();
}

// "The provider is rate-limiting us" notification, once per user per gym per
// day, via the same sent_notifications ledger every one-shot reminder uses.
// Deliberately per-user, not one global send. `db`/`notifications` are
// required lazily so this module stays a leaf that db-free callers can load.
function notifyRateLimited(userId, gymId) {
  try {
    const db = require('./db');
    const notifications = require('./notifications');
    const key = `rate-limit:${gymId}:${DateTime.utc().toISODate()}`;
    if (db.wasNotificationSent(userId, key)) return;
    db.markNotificationSent(userId, key);
    notifications.notify(userId, 'providerThrottled', { gymId });
  } catch (err) {
    require('./logger').log.error('failed to send rate-limit notification', { component: 'rate-limit', gymId, userId, err });
  }
}

module.exports = {
  isGymRateLimited,
  applyRateLimitBackoff,
  noteThrottleError,
  noteThrottleResponse,
  notifyRateLimited,
  _resetRateLimitBackoffForTests,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
};
