// competing-booking detection (C5-3).
//
// PURE and gym-agnostic: no db, no provider, no gym ids compared to literals.
// It answers "does this auto-book fight something else the SAME member has?":
//
//   DUPLICATE_QUEUED  another pending auto-book for the exact same class
//                     (same gym + event). Severity 'error': it can never help —
//                     the second entry either double-claims or is a no-op.
//   ALREADY_BOOKED    the member already holds a booking in that exact class.
//   OVERLAP_QUEUED    another pending auto-book whose time span intersects,
//                     in ANY gym (a boxing class and a ride can't both happen).
//   OVERLAP_BOOKED    an existing booking whose time span intersects.
//
// Everything but DUPLICATE_QUEUED is severity 'warning'. Overlap is a warning,
// not a block, on purpose: auto-book is speculative — a member may queue two
// alternatives and cancel one when the first lands, and the server can't know.
//
// Cross-USER contention (two members, one spot) is a different problem, already
// handled by scheduler.js claimedSlots. Nothing here touches other users' rows.
//
// Time handling: CodexFit serves timezone-NAIVE datetimes, and which zone they
// are naive in is the gym's (gyms.config.js `timezone`). So instants are parsed
// with the ROW's own gym zone, supplied via `opts.zoneOf(gymId)`; an ISO string
// with an explicit offset ignores it. That is what makes a Psycle/JAB comparison
// correct rather than accidentally right.

const { DateTime } = require('luxon');
const { cleanClassName } = require('./class-name');

// Used only when a row has no known length (legacy queue rows pre-dating the
// duration_min column). Most studio classes run 45-60 min; 45 errs towards
// under-warning rather than crying wolf on back-to-back classes.
const DEFAULT_DURATION_MIN = 45;

// Zone fallback when the caller supplies no zoneOf(): UTC, never a gym's zone.
const DEFAULT_ZONE = 'UTC';

/**
 * @typedef {Object} BookingLike
 * @property {(number|string)=} id
 * @property {string} gymId
 * @property {(number|string)} eventId
 * @property {string} startAt
 * @property {number=} durationMin
 * @property {string=} className
 * @property {string=} groupName        discipline, for display
 * @property {string=} instructorName
 * @property {string=} instructorImageUrl
 * @property {string=} locationName
 * @property {string=} studioName
 */

function intervalOf(item, zoneOf) {
  if (!item || !item.startAt) return null;
  const zone = (zoneOf && zoneOf(item.gymId)) || DEFAULT_ZONE;
  const start = DateTime.fromISO(String(item.startAt), { zone });
  if (!start.isValid) return null;
  const mins = Number(item.durationMin) > 0 ? Number(item.durationMin) : DEFAULT_DURATION_MIN;
  return { start: start.toMillis(), end: start.toMillis() + mins * 60000, zone };
}

function sameClass(a, b) {
  return a.gymId != null && a.gymId === b.gymId
    && a.eventId != null && b.eventId != null && String(a.eventId) === String(b.eventId);
}

function describe(other, opts) {
  const iv = intervalOf(other, opts && opts.zoneOf);
  const when = iv
    ? DateTime.fromMillis(iv.start, { zone: iv.zone }).toFormat("ccc d LLL HH:mm")
    : 'the same time';
  const gym = opts && opts.labelOf ? opts.labelOf(other.gymId) : null;
  return `${cleanClassName(other.className, other.groupName) || other.className || 'a class'}${gym ? ` at ${gym}` : ''}, ${when}`;
}

/**
 * Warnings for `subject` against the rest of the member's queue and bookings.
 *
 * @param {BookingLike} subject
 * @param {BookingLike[]} queued   pending auto-books (may include the subject; skipped by id)
 * @param {BookingLike[]} booked   existing bookings
 * @param {{zoneOf?:(g:string)=>string, labelOf?:(g:string)=>string}=} opts
 */
function detectCompetingBookings(subject, queued = [], booked = [], opts = {}) {
  const warnings = [];
  const subjectIv = intervalOf(subject, opts.zoneOf);

  const overlaps = (other) => {
    const iv = intervalOf(other, opts.zoneOf);
    return !!(subjectIv && iv && subjectIv.start < iv.end && iv.start < subjectIv.end);
  };
  // What a UI needs to draw the OTHER class without a second lookup (U1-6: the
  // overlap confirmation shows it as a card). Everything past the first line is
  // display-only, optional, and null when the source row never captured it —
  // booking_cache, for one, has no instructor photo.
  const ref = (other, source) => ({
    source, id: other.id ?? null, gymId: other.gymId, eventId: String(other.eventId),
    className: other.className || null, startAt: other.startAt,
    durationMin: Number(other.durationMin) > 0 ? Number(other.durationMin) : null,
    groupName: other.groupName || null,
    instructorName: other.instructorName || null,
    instructorImageUrl: other.instructorImageUrl || null,
    locationName: other.locationName || null,
    studioName: other.studioName || null,
  });

  for (const q of queued) {
    if (subject.id != null && q.id != null && String(q.id) === String(subject.id)) continue;
    if (sameClass(subject, q)) {
      warnings.push({
        code: 'DUPLICATE_QUEUED', severity: 'error', with: ref(q, 'queue'),
        crossGym: false,
        message: 'This class is already in your auto-book queue.',
      });
    } else if (overlaps(q)) {
      warnings.push({
        code: 'OVERLAP_QUEUED', severity: 'warning', with: ref(q, 'queue'),
        crossGym: q.gymId !== subject.gymId,
        message: `Overlaps another queued class: ${describe(q, opts)}.`,
      });
    }
  }

  for (const b of booked) {
    if (sameClass(subject, b)) {
      warnings.push({
        code: 'ALREADY_BOOKED', severity: 'warning', with: ref(b, 'booked'),
        crossGym: false,
        message: 'You are already booked into this class.',
      });
    } else if (overlaps(b)) {
      warnings.push({
        code: 'OVERLAP_BOOKED', severity: 'warning', with: ref(b, 'booked'),
        crossGym: b.gymId !== subject.gymId,
        message: `Overlaps a class you have booked: ${describe(b, opts)}.`,
      });
    }
  }

  return warnings;
}

/**
 * Warnings for every entry in a queue, keyed by entry id (only entries with at
 * least one warning appear). Each entry is judged against all the others plus
 * the member's bookings, so both halves of a clash are flagged.
 */
function detectQueueConflicts(queued = [], booked = [], opts = {}) {
  const byId = {};
  for (const entry of queued) {
    if (entry.id == null) continue;
    const w = detectCompetingBookings(entry, queued, booked, opts);
    if (w.length) byId[entry.id] = w;
  }
  return byId;
}

/**
 * U1-12: the same rule, asked before a MANUAL book / quick-book. Only time
 * overlaps matter there: an auto-book queue entry for this very class, or a
 * booking record for it, is not a clash the member is about to create by pressing
 * Book (the button would already read Edit if they were booked). So the answer is
 * the overlap subset of detectCompetingBookings — one rule, not a second copy.
 */
function detectManualBookingOverlaps(subject, queued = [], booked = [], opts = {}) {
  return detectCompetingBookings(subject, queued, booked, opts)
    .filter((w) => w.code === 'OVERLAP_QUEUED' || w.code === 'OVERLAP_BOOKED');
}

module.exports = { detectCompetingBookings, detectQueueConflicts, detectManualBookingOverlaps, DEFAULT_DURATION_MIN };
