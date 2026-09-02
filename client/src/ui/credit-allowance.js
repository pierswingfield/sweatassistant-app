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
import { can } from '../gym-context.js';

// Whether the ACTIVE gym charges per class from a credit balance — read from the
// shared gym context rather than a flag of its own, so there is one place that
// knows what the current gym can do.
export function isMetered() { return can('metered'); }

/**
 * How many spots this account can book on `event` right now.
 * @returns {number} Infinity when unmetered or when the class draws no credit type.
 */
export function getAvailableCreditsForEvent(event) {
  // A membership gym has no credit balance to draw down — the booking attempt
  // itself is what enforces the membership's limits.
  if (!isMetered()) return Infinity;

  if (!cache.profile || !cache.profile.available_credits) return 0;

  // credit_types entries can be {credit_type: number} | {credit_type: {id}} | {id}
  const acceptedIds = (event.credit_types || []).map((c) => {
    const raw = c.credit_type ?? c.id ?? c;
    return Number(typeof raw === 'object' ? raw.id : raw);
  }).filter((id) => !isNaN(id));

  // No credit type on the class means nothing to charge against.
  if (acceptedIds.length === 0) return Infinity;

  return cache.profile.available_credits.reduce((total, credit) => {
    const creditTypeId = Number(credit.credit_type?.id ?? credit.credit_type);
    return acceptedIds.includes(creditTypeId) ? total + (credit.count || 0) : total;
  }, 0);
}

export function hasUsableCredit(event) {
  return getAvailableCreditsForEvent(event) > 0;
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
export function getTotalCredits() {
  if (!isMetered()) return Infinity;
  if (!cache.profile || !cache.profile.available_credits) return 0;
  return cache.profile.available_credits.reduce((sum, c) => sum + (c.count || 0), 0);
}
