// Shared client-side utilities that need London timezone awareness
import { DateTime } from 'luxon';

// Sane bounds for a detected booking window, in days after the release Monday.
// Purely a guard against a garbled/stale profile cutoff producing an absurd
// offset — NOT a set of allowed tiers. Any value in between is legitimate.
export const MIN_OFFSET_DAYS = 1;
export const MAX_OFFSET_DAYS = 35;

// LEGACY / DEBUG ONLY — whole-week tiers (1→8, 2→15, 3→22, 4→29).
//
// Psycle's booking window used to come in whole-week steps, so detection snapped
// to one of these. **That is no longer true** (confirmed 2026-08-31): the standard
// window moved from 8 days to a fortnight ("an additional six days" = 14), and
// membership tiers now extend by DAYS, not weeks — Psycle 10 +2d, Psycle 15 +3d,
// Unlimited +8d. Snapping 14/16/17 to the nearest week yielded 15 in all three
// cases: standard over-ran by a day (auto-book firing a week early on boundary
// classes and burning the queue entry), while both member tiers were truncated
// by 1–2 days. detectBookingWindow() therefore no longer snaps — it uses the
// exact day count from the profile cutoff, which is server-authoritative and
// already reflects whatever rule Psycle is applying today.
//
// These two survive only for the debug week-override and the pre-detection
// legacy settings path. Don't reintroduce them into detection.
export function weeksToOffsetDays(weeks) {
  const w = Math.min(4, Math.max(1, Math.round(weeks) || 1));
  return 8 + (w - 1) * 7;
}

// Approximate whole-week label for a day offset — display only ("~2 weeks").
// Never feed this back into a booking calculation.
export function offsetDaysToWeeks(days) {
  return Math.min(4, Math.max(1, Math.ceil(days / 7)));
}

// Calculate booking offset in days based on settings.
// Priority: debug manual override → auto-detected window → legacy manual toggles.
export function getBookingOffset(settings = {}) {
  // Debug-only exact-day override — preferred, since real windows are no longer
  // whole weeks (see the note on weeksToOffsetDays).
  if (settings.debugMode && settings.manualBookingWindowDays) {
    return clampOffsetDays(settings.manualBookingWindowDays);
  }
  // Debug-only manual override for testing a specific window (1-4 weeks).
  if (settings.debugMode && settings.manualBookingWindowWeeks) {
    return weeksToOffsetDays(settings.manualBookingWindowWeeks);
  }
  // Auto-detected from the account's membership cutoffs (see detectBookingWindow).
  if (typeof settings.detectedBookingOffset === 'number' && settings.detectedBookingOffset > 0) {
    return clampOffsetDays(settings.detectedBookingOffset);
  }
  // Legacy fallback (manual toggles, pre-auto-detection). Base is 15: the window
  // ends on a TUESDAY (releaseMonday + 15), because booking for any Tuesday opens
  // on the Monday. M+14 would be a Monday and would hold Tuesday classes back a
  // week. Corrected 2026-09-01.
  // This path should be unreachable for any account whose profile loads, since
  // detection persists `detectedBookingOffset`; it exists for the cold-start case.
  let days = 15;
  if (settings.advancedBooking) days += 7;
  return days;
}

export function clampOffsetDays(days) {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n)) return 15;
  return Math.min(MAX_OFFSET_DAYS, Math.max(MIN_OFFSET_DAYS, n));
}

// The most recent Monday 12:00 PM London time that has already passed (the current
// release Monday). Booking cutoffs are expressed relative to this release.
export function getMostRecentReleaseMonday(now = DateTime.now().setZone('Europe/London')) {
  let M = now.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (now < M) M = M.minus({ weeks: 1 });
  return M;
}


// Detect a user's booking window from their CodexFit profile cutoffs.
// `credits` is accepted and ignored — kept only so existing callers don't need
// changing in the same pass; the parameter goes when this whole function moves
// server-side (it duplicates providers/codexfit.js resolveBookingWindow).
// Returns null if the profile lacks the data needed to detect (caller should fall back).
// Result: { offsetDays, weeks, cutoffISO, extendedAllowed, source }
export function detectBookingWindow(profile, credits) {
  if (!profile) return null;

  const bookingCutoff = profile.booking_cutoff || null;
  const extendedCutoff = profile.extended_cutoff || null;
  const mf = profile.metafields || {};
  const extendedAllowed = !!(mf.extended_booking_allowed ?? mf.public?.extended_booking_allowed)
    || (!!extendedCutoff && !!bookingCutoff && extendedCutoff > bookingCutoff);

  const effectiveCutoff = (extendedAllowed && extendedCutoff) ? extendedCutoff : bookingCutoff;
  if (!effectiveCutoff) return null;

  const cutoffDt = DateTime.fromISO(effectiveCutoff, { zone: 'Europe/London' });
  if (!cutoffDt.isValid) return null;

  const release = getMostRecentReleaseMonday();
  let offsetDays = Math.round(cutoffDt.diff(release, 'days').days);

  // No credit floor. Psycle no longer issues Advanced Booking credits, and while
  // it did, that rule was Psycle's promotion — not something shared client code
  // should know about. Any per-gym adjustment belongs server-side in that gym's
  // adapter (providers/codexfit.js resolveBookingWindow).

  // NO whole-week snapping (removed 2026-08-31 — see weeksToOffsetDays). The
  // profile cutoff is server-authoritative and already encodes whatever window
  // rule Psycle applies to this account, including the day-granular membership
  // tiers (Psycle 10 +2d, Psycle 15 +3d, Unlimited +8d) that a 7-day quantiser
  // cannot represent. `Math.round` on the day diff above already absorbs the
  // DST / time-of-day drift that the snapping was originally there to handle,
  // since the cutoff and the release Monday are both resolved in Europe/London.
  offsetDays = clampOffsetDays(offsetDays);
  // Display label only — never fed back into a booking calculation.
  const weeks = offsetDaysToWeeks(offsetDays);

  return {
    offsetDays,
    weeks,
    cutoffISO: effectiveCutoff,
    extendedAllowed,
    source: extendedAllowed ? 'extended' : 'standard'
  };
}

// Human label for a booking window, e.g. "2 weeks · books through Mon 29 Jun".
export function describeBookingWindow(offsetDays, cutoffISO) {
  const weeks = offsetDaysToWeeks(offsetDays);
  const wordLabel = `${weeks} week${weeks === 1 ? '' : 's'}`;
  let through = null;
  if (cutoffISO) {
    const dt = DateTime.fromISO(cutoffISO, { zone: 'Europe/London' });
    if (dt.isValid) through = dt.toFormat('ccc d LLL');
  } else {
    const dt = getMostRecentReleaseMonday().plus({ days: offsetDays });
    through = dt.toFormat('ccc d LLL');
  }
  return through ? `${wordLabel} · up to ${through}` : wordLabel;
}

// When booking opens for a class (WP-D8).
//
// Prefers the release the SERVER stamped on the event. That value already
// accounts for which world this gym lives in:
//   * a per-class gym (MarianaTek) publishes a release instant per class, with
//     no weekday rule behind it at all;
//   * a rolling-weekly gym (Psycle) has one composed server-side from that gym's
//     policy in gyms.config.js and the user's own membership window.
//
// The client therefore reads a timestamp and computes nothing. It used to
// reimplement Psycle's Monday-noon model here, which silently applied Psycle's
// rule to every gym — the countdown a JAB user watched would have been keyed to
// an event with no relationship to their class.
//
// Accepts an event object (preferred) or a bare ISO string (legacy callers).
export function getClassReleaseTime(eventOrDate, settings = {}) {
  const ev = (typeof eventOrDate === 'string' || eventOrDate == null)
    ? { start_at: eventOrDate }
    : eventOrDate;

  // `releaseAt` on a normalized event; `release_at` on an auto-book queue row.
  const published_ = ev.releaseAt || ev.release_at;
  if (published_) {
    const published = DateTime.fromISO(published_);
    if (published.isValid) return published.setZone('Europe/London');
  }

  // LEGACY FALLBACK — only reachable for events cached before the server began
  // stamping releaseAt, or if a request failed. Hardcodes Psycle's rule, so it is
  // wrong for any other gym; it exists so a stale cache degrades to the old
  // behaviour rather than to nothing. Remove once the cache has rolled over.
  const classDateStr = ev.start_at || ev.startAt;
  if (!classDateStr) return DateTime.now().setZone('Europe/London');

  const daysToAdd = getBookingOffset(settings);
  const classDt = DateTime.fromISO(classDateStr, { zone: 'Europe/London' });
  let M = classDt.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  while (true) {
    const cutoff = M.plus({ days: daysToAdd }).set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    if (cutoff < classDt) { M = M.plus({ weeks: 1 }); break; }
    M = M.minus({ weeks: 1 });
  }
  return M.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
}

// Format a countdown from milliseconds
export function formatCountdown(diffMs) {
  if (diffMs <= 0) return '00:00:00';

  const hours = Math.floor(diffMs / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  const secs = Math.floor((diffMs % (60 * 1000)) / 1000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ── 60-second cancellation grace period ──────────────────────────────
// CodexFit bookings carry a `booked_at` timestamp. For the first 60 seconds
// after booking, the cancel is free (no penalty) and requires no confirmation.
// The UI shows a live countdown on the cancel button: "Cancel (54s)".

export const GRACE_PERIOD_MS = 60 * 1000;

function getGraceRemaining(bookedAt) {
  if (!bookedAt) return 0;
  const elapsed = Date.now() - new Date(bookedAt).getTime();
  return Math.max(0, GRACE_PERIOD_MS - elapsed);
}

export function isInGracePeriod(bookedAt) {
  return getGraceRemaining(bookedAt) > 0;
}

// Shared countdown manager — a single setInterval ticks every 1s and updates
// all [data-grace-deadline] elements in the DOM. The attribute value is the
// deadline epoch-ms. When the deadline passes the label reverts to "Cancel"
// and the attribute is removed. Auto-stops when no grace elements remain.
// Call startGraceCountdown() after rendering any button with data-grace-deadline.
let _graceInterval = null;

function _tickGraceCountdown() {
  const els = document.querySelectorAll('[data-grace-deadline]');
  if (els.length === 0) {
    if (_graceInterval) { clearInterval(_graceInterval); _graceInterval = null; }
    return;
  }
  for (const el of els) {
    const deadline = Number(el.getAttribute('data-grace-deadline'));
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    // For buttons with an icon + <span> label, update the span; otherwise
    // update the element's own textContent (e.g. timetable segment buttons).
    const labelEl = el.querySelector('span') || el;
    if (remaining > 0) {
      labelEl.textContent = `Cancel (${remaining}s)`;
    } else {
      el.removeAttribute('data-grace-deadline');
      el.classList.remove('grace-cancel');
      labelEl.textContent = 'Cancel';
    }
  }
}

export function startGraceCountdown() {
  if (_graceInterval) return;
  _tickGraceCountdown();
  _graceInterval = setInterval(_tickGraceCountdown, 1000);
}
