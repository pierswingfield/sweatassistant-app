// Shared client-side utilities (gym-local timezone formatting, countdowns, release reads)
import { DateTime } from 'luxon';
import { getGymTimeZone, getDefaultGymId } from './gym-context.js';
import { COPY, formatCopyText } from './copy.js';

// When booking opens for a class.
//
// The client reads the release instant the SERVER stamped on the event
// (`releaseAt`; `release_at` on an auto-book queue row) and computes nothing:
// a per-class gym publishes one per class, and a rolling-weekly gym (Psycle) has
// one composed server-side from that gym's policy in gyms.config.js and the
// member's own window. There is deliberately no client-side policy fallback.
//
// Accepts an event/queue row. Returns a DateTime, or null when the server gave
// no release. NULL MEANS UNKNOWN: never "open now", never a guessed instant.
export function getClassReleaseTime(eventOrRow) {
  const ev = eventOrRow || {};
  const iso = ev.releaseAt || ev.release_at;
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { setZone: true });
  return dt.isValid ? dt : null;
}

// Has booking opened? true only for an always-bookable class or a release that
// has passed. An unknown (null) or future release is NOT open.
export function isReleaseOpen(eventOrRow, now = Date.now()) {
  if (eventOrRow?.alwaysBookable) return true;
  const r = getClassReleaseTime(eventOrRow);
  return !!r && r.toMillis() <= now;
}

// The soonest release strictly in the future among events/queue rows, or null.
// Rows with an unknown release are skipped.
export function soonestFutureRelease(items, now = Date.now()) {
  let best = null;
  for (const it of items || []) {
    const r = getClassReleaseTime(it);
    if (r && r.toMillis() > now && (!best || r.toMillis() < best.toMillis())) best = r;
  }
  return best;
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

// Friendly relative phrasing shared by Auto-Book and Home favourite cards.
export function formatOpensIn(ms, { html = true } = {}) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const prefix = html ? COPY.timetable.opensInPrefixHtml : COPY.timetable.opensInPrefix;
  if (days >= 1) return formatCopyText(days === 1 ? COPY.timetable.opensInDaysOne : COPY.timetable.opensInDaysMany, { prefix, count: days });
  if (hours >= 1) return formatCopyText(hours === 1 ? COPY.timetable.opensInHoursOne : COPY.timetable.opensInHoursMany, { prefix, count: hours });
  return formatCopyText(mins === 1 ? COPY.timetable.opensInMinutesOne : COPY.timetable.opensInMinutesMany, { prefix, count: mins });
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
      labelEl.textContent = formatCopyText(COPY.bookingWindow.graceCancel, { seconds: remaining });
    } else {
      el.removeAttribute('data-grace-deadline');
      el.classList.remove('grace-cancel');
      labelEl.textContent = COPY.bookings.cancel;
    }
  }
}

export function startGraceCountdown() {
  if (_graceInterval) return;
  _tickGraceCountdown();
  _graceInterval = setInterval(_tickGraceCountdown, 1000);
}

/**
 * Newer ICU builds render September as "Sept" for en-GB short months. The app
 * uses the three-letter form everywhere, so every short-month string passes
 * through here.
 */
export function noSept(str) {
  return typeof str === 'string' ? str.replace(/\bSept\b/g, 'Sep') : str;
}

/**
 * THE one answer to "is this class full with no way in": full AND the waitlist is explicitly
 * unavailable (NormalizedEvent.isFull / .waitlistAvailable). An absent waitlistAvailable means the
 * payload said nothing, so it is NOT treated as closed (unknown defaults permissive). Adapters
 * normalise the flag; the UI must not re-derive it per provider or read `.raw`.
 */
export function isFullWithoutWaitlist(event) {
  return !!(event && event.isFull) && event.waitlistAvailable === false;
}


// ─── Gym-local time display ───────────────────────────────────────────────────
// Times are shown in the zone the CLASS runs in (NormalizedEvent/Booking
// `timeZone`, from the server's providers/timezone.js), never the browser's and
// never a literal. A zone suffix ("ET") is appended only when that zone's UTC
// offset at the class instant differs from the device's, so a UK member viewing
// London classes sees no suffix.

export function deviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Zone for an event/booking/queue row: its own `timeZone`, else its gym's catalogue zone, else the device zone. */
export function zoneFor(obj, gymId) {
  const o = obj || {};
  const gid = gymId || o.gymId || o.gym_id || (o.event && o.event.gymId) || getDefaultGymId();
  return o.timeZone || (o.event && o.event.timeZone) || getGymTimeZone(gid) || deviceZone();
}

function parseIn(iso, zone) {
  const dt = DateTime.fromISO(String(iso), { zone });
  return dt.isValid ? dt : null;
}

export function nowInZone(zone) {
  return DateTime.now().setZone(zone || deviceZone());
}

/** 'yyyy-MM-dd' of the instant in `zone` (the gym-local calendar day). */
export function dayKeyInZone(iso, zone) {
  const dt = parseIn(iso, zone);
  return dt ? dt.toFormat('yyyy-MM-dd') : '';
}

/**
 * Short zone label ("ET") when `zone` differs from the device zone at that
 * instant (compared by UTC offset), else ''.
 */
export function zoneSuffix(iso, zone, device = deviceZone()) {
  const dt = parseIn(iso, zone);
  if (!dt) return '';
  if (dt.offset === dt.setZone(device).offset) return '';
  const d = dt.toJSDate();
  // Keep compact generic labels such as ET/PT when available. Some browsers
  // return long names ("United Kingdom Time"), so fall back to a short,
  // season-specific label; en-GB yields BST where en-US may say GMT+1.
  try {
    const generic = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortGeneric' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
    if (generic && generic.length <= 5 && !/^GMT/i.test(generic)) return generic;
  } catch { /* try short specific names */ }
  for (const locale of ['en-GB', 'en-US']) {
    try {
      const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(d).find((p) => p.type === 'timeZoneName');
      if (part && part.value) return part.value;
    } catch { /* try next locale */ }
  }
  return '';
}

/**
 * Display strings for an instant in a zone: date ("Mon 5 Oct"), time ("09:15",
 * 24h), suffix ("ET" or ''), and timeLabel (time + suffix).
 */
export function formatInZone(iso, zone, device = deviceZone()) {
  const dt = parseIn(iso, zone);
  if (!dt) return { date: '', time: '', suffix: '', timeLabel: '' };
  const d = dt.toJSDate();
  const date = d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone });
  const time = d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone });
  const suffix = zoneSuffix(iso, zone, device);
  return { date, time, suffix, timeLabel: suffix ? `${time} ${suffix}` : time };
}

/** "Friday, 2 October 2026" for a YYYY-MM-DD calendar date. Date-only strings carry no zone, so format in UTC. */
export function formatFullDate(iso) {
  return DateTime.fromISO(iso, { zone: 'UTC' }).setLocale('en-GB').toFormat('cccc, d LLLL yyyy');
}

/**
 * Location filter: with ANY location selected, a class passes only if ITS OWN location is among them, so a gym
 * with no selected location contributes no classes. Nothing selected = no filter. Ids compare as strings
 * (normalized ids are strings, raw event ids numbers).
 */
export function passesLocationFilter(selected, locationId) {
  if (!selected || !selected.length) return true;
  return locationId != null && locationId !== '' && selected.map(String).includes(String(locationId));
}
