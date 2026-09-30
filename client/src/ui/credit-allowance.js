// Credit arithmetic — one copy, gym-aware (WP-D12).
//
// This lived in FOUR modules (timetable, bookings, autobook, autoupgrade), three
// byte-identical and one drifted. Worse, every copy answered the CodexFit
// question — "how many of my credits does this class accept" — and returned **0**
// for a gym with no credit system at all. Zero is not "unmetered", it is "you
// cannot book", so a membership gym would have had booking silently disabled:
// `maxBookableSlots = Math.min(available, 0)`.
//
// The concept both gyms share is an ALLOWANCE: how many spots can I take on this
// class. A metered gym answers it from a credit balance; a membership gym has no
// per-class limit of this kind and answers Infinity.

import { cache } from '../main';
import { canForGym, getLinkedGyms } from '../gym-context.js';
import { COPY } from '../copy.js';

// Whether a gym charges per class from a credit balance. ALWAYS pass the gym
// when you have one — in a merged list you always do. Without it this answers
// for whichever gym the app defaults to, which is the wrong gym for most rows.
export function isMetered(gymId) { return canForGym('metered', gymId); }

/**
 * The credit inventory to charge a class against: that class's OWN gym's.
 *
 * `cache.creditsByGym` is populated by updateCreditBadge (one entry per linked
 * gym). `cache.profile.available_credits` is the single-gym fallback and is
 * only correct when the row belongs to the gym the profile came from.
 */
function creditsFor(gymId) {
  if (gymId && cache.creditsByGym && gymId in cache.creditsByGym) return cache.creditsByGym[gymId];
  // NOT LOADED YET → null, which is not the same as []. The per-gym fan-out is
  // fire-and-forget so the first paint runs before it lands, and returning an
  // empty array there reads as "you have zero credits" and put "Buy Credits" on
  // every row — including a membership gym's — until the user switched days and
  // forced a re-render.
  if (gymId && cache.creditsByGym) return null;
  // U1-20: with SEVERAL gyms linked, `cache.profile.available_credits` is only
  // the first-loaded gym's (JAB, for the reporting account: raw MarianaTek
  // `credits_remaining` rows with no `count` and no type id). Reading it for a
  // Psycle row summed to 0 and put "Buy Credits" on every Psycle class until
  // `cache.creditsByGym` landed. "This gym's balance isn't loaded" is unknown
  // (null, permissive), never another gym's list.
  if (gymId && (getLinkedGyms() || []).length > 1) return null;
  // Single-gym account: the account-level list IS that gym's.
  return (cache.profile && cache.profile.available_credits) || null;
}

/**
 * How many spots this account can book on `event` right now.
 * @returns {number} Infinity when unmetered or when the class draws no credit type.
 */
export function getAvailableCreditsForEvent(event) {
  const gymId = event && (event.gymId || event.gym_id);
  // A membership gym has no credit balance to draw down — the booking attempt
  // itself is what enforces the membership's limits.
  if (!isMetered(gymId)) return Infinity;

  // NormalizedEvent.credits — `{ required, acceptedTypeIds }`, mapped from the
  // provider's own `required_credits` + `credit_types` (confirmed live). The
  // client no longer guesses any of this.
  //
  // `credits` ABSENT means the payload said nothing about credits, which is not
  // the same as free. Treat it as the old behaviour (cost 1, any type) rather
  // than as Infinity, so a missing field can't silently unlock a class.
  const req = event && event.credits;
  const required = req && Number.isFinite(Number(req.required)) ? Number(req.required) : 1;
  const acceptedTypeIds = (req && Array.isArray(req.acceptedTypeIds)) ? req.acceptedTypeIds : [];

  // A genuinely free class (required 0) needs no balance at all.
  if (required <= 0) return Infinity;

  const inventory = creditsFor(gymId);
  // Unknown (still loading) → permissive, same rule as an unknown capability
  // flag: briefly offering a class you can't afford self-corrects at the
  // booking attempt, whereas wrongly hiding every Book button does not.
  if (inventory == null) return Infinity;

  const usable = inventory.reduce((total, credit) => {
    // Guest credits book a GUEST in, not you.
    if (credit.isGuestOnly === true) return total;
    // An empty accepted list means the class didn't say — fall back to counting
    // everything, which is the pre-2026-09-14 behaviour and no worse than it.
    if (acceptedTypeIds.length > 0) {
      const typeId = credit.typeId != null
        ? String(credit.typeId)
        : String(credit.credit_type?.id ?? credit.credit_type ?? '');
      if (!acceptedTypeIds.includes(typeId)) return total;
    }
    return total + (Number(credit.count) || 0);
  }, 0);

  // How many SPOTS this balance affords, not how many credits are held: a
  // 2-credit class on a balance of 3 is one bookable spot, not three.
  return Math.floor(usable / required);
}

export function hasUsableCredit(event) {
  return canBookAtAll(event && (event.gymId || event.gym_id)) && getAvailableCreditsForEvent(event) > 0;
}

// "Can this account book at all" (WP-J) — distinct from the credit arithmetic
// above, which only ever answers "can it afford THIS class". An unmetered gym
// with no membership returns Infinity from getAvailableCreditsForEvent/
// getTotalCredits (correctly — there's nothing to charge), which is exactly
// why neither of those can answer this question; a membership-less JAB user
// used to see no warning at all and just fail at the booking attempt. Backed
// by `cache.eligibility`, fetched once in main.js's refresh flow. Default is
// permissive (true) while unset/loading — same "unknown defaults ON" rule as
// capability flags, so a slow or failed fetch never itself blocks booking.
export function canBookAtAll(gymId) {
  return !eligibilityFor(gymId) || eligibilityFor(gymId).canBook !== false;
}

/**
 * True only when the server has CONFIRMED this account can book at this gym
 * (unlike canBookAtAll, which is permissive while unloaded). For an unmetered
 * gym that means an active membership: nothing to count, so the header shows ∞.
 */
export function hasConfirmedAccess(gymId) {
  const e = eligibilityFor(gymId);
  return !!e && e.canBook === true;
}

/** @returns {string|null} why booking is blocked, or null if it isn't. */
export function getIneligibleReason(gymId) {
  const e = eligibilityFor(gymId);
  if (e && e.canBook === false) {
    return e.reason || COPY.common.ineligibleAtGym;
  }
  return null;
}

/**
 * That gym's own eligibility. Global eligibility in a merged list is wrong in
 * the dangerous direction: one gym answering "no credits" would disable booking
 * on ANOTHER gym's membership classes, which is what put "Buy Credits" on every
 * row regardless of which gym it belonged to.
 */
function eligibilityFor(gymId) {
  if (gymId && cache.eligibilityByGym && gymId in cache.eligibilityByGym) {
    return cache.eligibilityByGym[gymId];
  }
  // With several gyms linked and no answer for THIS one yet, fall back to
  // nothing rather than to the account-level value. That value belongs to one
  // gym, and applying it to another's rows is how a JAB membership class ended
  // up saying "Buy Credits" because the Psycle balance was empty.
  const linked = getLinkedGyms() || [];
  if (gymId && linked.length > 1) return null;
  return cache.eligibility;
}

/**
 * The account's whole credit balance, for the call sites that have no event to
 * check against — an auto-book queue row, an auto-upgrade monitor.
 *
 * Exists because four call sites were each doing this reduce inline and so each
 * skipped the `isMetered()` guard, which is the whole reason this module is
 * meant to be the only place credit arithmetic happens. On a membership gym they
 * summed an empty `available_credits` to 0, compared `0 < 1`, and rendered
 * "⚠ Insufficient Credits" on every JAB card — reading as "you cannot book" when
 * the truth is "there is nothing to charge". Found by a browser smoke test; no
 * automated test covered it and nothing threw.
 *
 * @returns {number} Infinity when the gym is unmetered.
 */
export function getTotalCredits(gymId) {
  if (!isMetered(gymId)) return Infinity;
  const inventory = creditsFor(gymId);
  // Not loaded yet is not "zero" — see creditsFor.
  if (inventory == null) return Infinity;
  // Guest-only credits book a GUEST in, not the member — same rule as
  // getAvailableCreditsForEvent, so a balance of only guest credits can't hide
  // "Insufficient Credits" (and holding one never reads as 'no credits' either way).
  return inventory.reduce((sum, c) => sum + (c.isGuestOnly === true ? 0 : (Number(c.count) || 0)), 0);
}
