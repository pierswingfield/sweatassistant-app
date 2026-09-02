// Booking-window policy evaluator (WP-D8).
//
// WHERE THIS SITS IN THE THREE LAYERS
//
//   platform module  — knows WHERE its API exposes cutoffs, credits and release
//                      times. `providers/codexfit.js` reads `booking_cutoff`;
//                      `providers/marianatek.js` reads `booking_start_datetime`.
//   gym config       — knows the RULE: which weekday, what time, how many days,
//                      which credit type extends it. That is per-GYM policy, not
//                      per-platform protocol.
//   this file        — evaluates a policy. Platform-agnostic and gym-agnostic.
//
// Why not put this in providers/codexfit.js: Monday 12:00, the 14-day base and
// the advanced-booking-credit floor are **Psycle's** rules, not CodexFit's.
// CodexFit is a platform many gyms use, and another CodexFit gym could release
// on Sundays at 09:00 with a 21-day window. Putting Psycle's numbers in the
// platform module would make every future CodexFit gym a special case — which is
// the exact "second gym as an extension of the first" shape this phase removes.
//
// Equally, this algorithm is NOT CodexFit-specific: any gym on any platform that
// releases on a fixed weekday with a rolling offset can use it, which is why it
// lives beside the adapters rather than inside one.

const { DateTime } = require('luxon');

// Sane bounds when a gym's policy doesn't state its own. Purely a guard against
// a garbled or stale profile cutoff producing an absurd offset — NOT a set of
// allowed tiers. Any value in between is legitimate.
const DEFAULT_MIN_OFFSET_DAYS = 1;
const DEFAULT_MAX_OFFSET_DAYS = 35;

/**
 * @typedef {Object} BookingWindowPolicy
 * @property {'rolling-weekly'|'per-class'} kind
 * @property {number=} releaseWeekday       Luxon weekday, 1 = Monday.
 * @property {{hour:number, minute:number}=} releaseTime
 * @property {string=} timezone             IANA zone, e.g. 'Europe/London'.
 * @property {number=} baseOffsetDays       Standard window, in days after release.
 * @property {number=} minOffsetDays
 * @property {number=} maxOffsetDays
 * @property {{advancedBookingDays:number}=} legacy  Pre-detection manual toggle.
 */

function policyOf(gym) {
  const p = (gym && gym.bookingWindow) || { kind: 'per-class' };
  // A booking-window policy inherits the gym's timezone unless it deliberately
  // overrides it, so the zone is stated once per gym rather than twice.
  return p.timezone ? p : { ...p, timezone: (gym && gym.timezone) || 'Europe/London' };
}

// A gym may declare a `fallback` policy: what to assume when its API OMITS the
// per-class release it normally publishes. Without one, a missing value has no
// safe answer — and the unsafe answers are both bad: inventing another gym's
// weekday rule, or calling the class open when it isn't.
function fallbackPolicyOf(gym) {
  const p = policyOf(gym);
  if (p.kind !== 'per-class' || !p.fallback) return null;
  return p.fallback.timezone ? p.fallback : { ...p.fallback, timezone: p.timezone };
}

function isRollingWeekly(gym) {
  return policyOf(gym).kind === 'rolling-weekly';
}

function clampOffsetDays(days, policy = {}) {
  const min = policy.minOffsetDays ?? DEFAULT_MIN_OFFSET_DAYS;
  const max = policy.maxOffsetDays ?? DEFAULT_MAX_OFFSET_DAYS;
  const n = Math.round(Number(days));
  if (!Number.isFinite(n)) return policy.baseOffsetDays ?? min;
  return Math.min(max, Math.max(min, n));
}

/** The most recent release moment that has already passed. */
function mostRecentRelease(policy, now = null) {
  const zone = policy.timezone || 'Europe/London';
  const at = now ? now.setZone(zone) : DateTime.now().setZone(zone);
  const t = policy.releaseTime || { hour: 12, minute: 0 };
  let M = at.set({
    weekday: policy.releaseWeekday ?? 1,
    hour: t.hour, minute: t.minute, second: 0, millisecond: 0,
  });
  if (at < M) M = M.minus({ weeks: 1 });
  return M;
}

/**
 * When booking opens for a class starting at `classStartISO`, under `policy`.
 *
 * Walks back to the release before the class, then forward one — the same
 * algorithm the client countdown and the server scheduler each had their own
 * copy of. Behaviour is deliberately identical to that copy; see
 * test-booking-window.js, which pins it against the original.
 *
 * @returns {DateTime|null} null when the policy isn't a rolling-weekly one.
 */
function releaseFor(classStartISO, offsetDays, policy) {
  if (!classStartISO) return null;
  const zone = policy.timezone || 'Europe/London';
  const classDt = DateTime.fromISO(classStartISO, { zone });
  if (!classDt.isValid) return null;

  // Rolling-continuous: the window slides with the clock, so the release is a
  // fixed span before the class — exact to the minute, not to the day. At 13:30
  // on 1 Sep with a 14-day window, the 13:30 class on 15 Sep is open and the
  // 14:00 class on the same day is not. There is no weekday and no release hour;
  // asking for one would be inventing a rule the gym doesn't have.
  if (policy.kind === 'rolling-continuous') {
    const days = offsetDays != null ? offsetDays : policy.offsetDays;
    if (days == null) return null;
    return classDt.minus({ days });
  }

  if (policy.kind !== 'rolling-weekly') return null;
  const t = policy.releaseTime || { hour: 12, minute: 0 };

  let M = classDt.set({
    weekday: policy.releaseWeekday ?? 1,
    hour: t.hour, minute: t.minute, second: 0, millisecond: 0,
  });

  while (true) {
    const cutoff = M.plus({ days: offsetDays }).set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    if (cutoff < classDt) { M = M.plus({ weeks: 1 }); break; }
    M = M.minus({ weeks: 1 });
  }
  return M.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 });
}


/**
 * Turn an already-extracted cutoff date into an offset in days, applying the
 * gym's policy (credit floor, clamping).
 *
 * The adapter does the protocol half — pulling whichever field ITS platform
 * exposes the cutoff on — and passes the resolved ISO date here. This function
 * never looks at a provider payload.
 *
 * @returns {{offsetDays:number, cutoffISO:(string|null), source:string}|null}
 */
function windowFromCutoff(cutoffISO, policy, now = null) {
  if (policy.kind !== 'rolling-weekly') return null;
  if (!cutoffISO) return null;
  const zone = policy.timezone || 'Europe/London';
  const cutoffDt = DateTime.fromISO(cutoffISO, { zone });
  if (!cutoffDt.isValid) return null;

  const release = mostRecentRelease(policy, now);
  let offsetDays = Math.round(cutoffDt.diff(release, 'days').days);

  // NO credit floors, tier tables or other per-gym adjustments here. This
  // evaluator turns a cutoff date into a day offset under a declared policy and
  // nothing else — anything a specific gym does on top belongs in that gym's
  // ADAPTER (see codexfit.js resolveBookingWindow, which composes this), or in
  // its config. Psycle's advanced-booking-credit floor used to live here and is
  // gone: those credits no longer exist, and while they did, the rule was
  // CodexFit-agnostic-looking but Psycle-specific.
  //
  // NO whole-week snapping. The cutoff is server-authoritative and already
  // encodes whatever rule the gym applies to this account, including day-granular
  // membership tiers that a 7-day quantiser cannot represent.
  offsetDays = clampOffsetDays(offsetDays, policy);

  // The cutoff is always the account's own, because nothing here overrides it any
  // more. An adapter that DOES adjust the window must null `cutoffISO` itself, so
  // the label doesn't claim a date the effective window no longer matches.
  return { offsetDays, cutoffISO, source: 'cutoff' };
}

/** The offset to use when nothing could be detected. */
function fallbackOffsetDays(policy, settings = {}) {
  if (policy.kind !== 'rolling-weekly') return null;
  let days = policy.baseOffsetDays ?? 14;
  const legacy = policy.legacy || {};
  if (settings.advancedBooking) days += legacy.advancedBookingDays ?? 7;
  return clampOffsetDays(days, policy);
}

module.exports = {
  policyOf,
  fallbackPolicyOf,
  isRollingWeekly,
  clampOffsetDays,
  mostRecentRelease,
  releaseFor,
  windowFromCutoff,
  fallbackOffsetDays,
  DEFAULT_MIN_OFFSET_DAYS,
  DEFAULT_MAX_OFFSET_DAYS,
};
