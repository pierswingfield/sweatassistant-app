// Shared client-side utilities that need London timezone awareness
import { DateTime } from 'luxon';

// Booking-window tiers. The base standard window is 8 days from the release Monday
// (≈1 week); each extra booking week adds 7 days. So 1→8, 2→15, 3→22, 4→29.
export function weeksToOffsetDays(weeks) {
  const w = Math.min(4, Math.max(1, Math.round(weeks) || 1));
  return 8 + (w - 1) * 7;
}

// Inverse of weeksToOffsetDays — snap an offset in days to a whole-week tier (1..4).
export function offsetDaysToWeeks(days) {
  return Math.min(4, Math.max(1, Math.round((days - 8) / 7) + 1));
}

// Calculate booking offset in days based on settings.
// Priority: debug manual override → auto-detected window → legacy manual toggles.
export function getBookingOffset(settings = {}) {
  // Debug-only manual override for testing a specific window (1-4 weeks).
  if (settings.debugMode && settings.manualBookingWindowWeeks) {
    return weeksToOffsetDays(settings.manualBookingWindowWeeks);
  }
  // Auto-detected from membership cutoffs + credit inventory (see detectBookingWindow).
  if (typeof settings.detectedBookingOffset === 'number' && settings.detectedBookingOffset > 0) {
    return settings.detectedBookingOffset;
  }
  // Legacy fallback (manual toggles, pre-auto-detection).
  let days = 8;
  if (settings.advancedBooking) days += 7;
  if (settings.advancedBookingCredit) days += 7;
  return days;
}

// The most recent Monday 12:00 PM London time that has already passed (the current
// release Monday). Booking cutoffs are expressed relative to this release.
export function getMostRecentReleaseMonday(now = DateTime.now().setZone('Europe/London')) {
  let M = now.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (now < M) M = M.minus({ weeks: 1 });
  return M;
}

// CodexFit credit_type id for "Advanced Booking Credit" (e.g. bundle 361). Holding any
// such credit grants a 2-week (15-day) booking window.
const ADVANCED_BOOKING_CREDIT_TYPE_ID = 8;

// Count Advanced Booking credits in the user's inventory. Holding any grants a 2-week
// (15-day) window — it does NOT add a week on top of an account that already books in
// advance, and credits do not stack into a 3rd week.
function countExtendedBookingCredits(credits) {
  if (!Array.isArray(credits)) return 0;
  let count = 0;
  for (const c of credits) {
    const typeId = c?.credit_type_id ?? c?.credit_type?.id ?? c?.credit_type;
    const name = (c?.credit_type?.name || c?.name || c?.credit_type_name || '').toString();
    const isAdvanced = String(typeId) === String(ADVANCED_BOOKING_CREDIT_TYPE_ID)
      || (/advance/i.test(name) && /book/i.test(name));
    if (isAdvanced) count += Number(c?.count ?? c?.quantity ?? c?.qty ?? 1) || 1;
  }
  return count;
}

// Detect a user's booking window from their CodexFit profile cutoffs + credit inventory.
// Returns null if the profile lacks the data needed to detect (caller should fall back).
// Result: { offsetDays, weeks, cutoffISO, extendedAllowed, extendedCredits, source }
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

  // Holding extended-booking credits guarantees a 2-week (15-day) window. It is a floor,
  // not additive — credits never extend an already-extended account or stack to 3 weeks.
  const extendedCredits = countExtendedBookingCredits(credits);
  const creditFloorApplied = extendedCredits > 0 && offsetDays < 15;
  if (creditFloorApplied) offsetDays = 15;

  // Snap to a whole-week tier (1..4) for robustness against DST / time-of-day drift.
  const weeks = offsetDaysToWeeks(offsetDays);

  return {
    offsetDays: weeksToOffsetDays(weeks),
    weeks,
    // When the credit floor overrides the account cutoff, the profile cutoff no longer
    // matches the effective window — let the label derive the date from release + offset.
    cutoffISO: creditFloorApplied ? null : effectiveCutoff,
    extendedAllowed,
    extendedCredits,
    source: creditFloorApplied ? 'credits' : (extendedAllowed ? 'extended' : 'standard')
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
  return through ? `${wordLabel} · books through ${through}` : wordLabel;
}

// Calculate when booking opens for a specific class date (London timezone)
// Mirrors the server-side scheduler.js getClassReleaseTime exactly
export function getClassReleaseTime(classDateStr, settings = {}) {
  if (!classDateStr) return DateTime.now().setZone('Europe/London');

  const daysToAdd = getBookingOffset(settings);
  const classDt = DateTime.fromISO(classDateStr, { zone: 'Europe/London' });

  // Start M as Monday 12:00 PM of the class week
  let M = classDt.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });

  while (true) {
    const cutoff = M.plus({ days: daysToAdd }).set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    if (cutoff < classDt) {
      M = M.plus({ weeks: 1 });
      break;
    }
    M = M.minus({ weeks: 1 });
  }

  return M.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
}

// Get the next Monday 12:00 PM London time
export function getNextMondayNoonLondon() {
  const now = DateTime.now().setZone('Europe/London');
  let target = now.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (now >= target) {
    target = target.plus({ weeks: 1 });
  }
  return target;
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

// Format a full countdown with days
export function formatFullCountdown(diffMs) {
  if (diffMs <= 0) return 'RELEASE ACTIVE!';

  const days = Math.floor(diffMs / (24 * 3600 * 1000));
  const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  const secs = Math.floor((diffMs % (60 * 1000)) / 1000);

  return `${days}d ${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

// ── 60-second cancellation grace period ──────────────────────────────
// CodexFit bookings carry a `booked_at` timestamp. For the first 60 seconds
// after booking, the cancel is free (no penalty) and requires no confirmation.
// The UI shows a live countdown on the cancel button: "Cancel (54s)".

export const GRACE_PERIOD_MS = 60 * 1000;

export function getGraceRemaining(bookedAt) {
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
