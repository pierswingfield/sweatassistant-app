// Sweat Assistant — normalized-shape factory helpers.
//
// Small, dependency-free builders that adapters use to produce consistent
// NormalizedEvent / NormalizedSlot / etc. objects. Keeping construction here
// (rather than ad-hoc object literals in each adapter) means shape drift is
// caught in one place and fixtures/tests assert against these builders.
//
// See server/providers/base.js for the typedefs.

/**
 * Build a NormalizedEvent, dropping undefined keys for clean equality in tests.
 * @param {Partial<import('./base').NormalizedEvent>} e
 * @returns {import('./base').NormalizedEvent}
 */
function makeEvent(e) {
  return prune({
    id: str(e.id),
    gymId: e.gymId,
    name: e.name || '',
    discipline: e.discipline,
    startAt: e.startAt,
    endAt: e.endAt,
    durationMin: num(e.durationMin),
    releaseAt: e.releaseAt,
    locationId: str(e.locationId),
    locationName: e.locationName,
    locationAddress: e.locationAddress,
    studioId: str(e.studioId),
    studioName: e.studioName,
    instructors: Array.isArray(e.instructors) ? e.instructors.map(makeInstructor) : [],
    capacity: num(e.capacity),
    availableCount: num(e.availableCount),
    waitlistCount: num(e.waitlistCount),
    isFull: bool(e.isFull),
    waitlistAvailable: bool(e.waitlistAvailable),
    alwaysBookable: bool(e.alwaysBookable),
    layoutFormat: e.layoutFormat || 'pick-a-spot',
    isUserBooked: bool(e.isUserBooked),
    isUserWaitlisted: bool(e.isUserWaitlisted),
    raw: e.raw,
  });
}

/**
 * @param {Partial<import('./base').NormalizedSlot>} s
 * @returns {import('./base').NormalizedSlot}
 */
function makeSlot(s) {
  const y = num(s.y);
  return prune({
    id: str(s.id),
    label: s.label != null ? String(s.label) : str(s.id),
    x: num(s.x),
    y,
    row: s.row != null ? s.row : (y != null ? Math.round(y * 10) / 10 : undefined),
    isAvailable: bool(s.isAvailable) ?? false,
    isPrimary: bool(s.isPrimary),
    spotType: s.spotType,
    raw: s.raw,
  });
}

/**
 * Build a NormalizedLayoutObject (podium/stage/pillar — non-bookable floor
 * fixtures that the renderer draws but never lets you click).
 * @param {Partial<import('./base').NormalizedLayoutObject>} o
 * @returns {import('./base').NormalizedLayoutObject}
 */
function makeLayoutObject(o) {
  return prune({
    id: str(o.id),
    label: o.label != null ? String(o.label) : undefined,
    x: num(o.x),
    y: num(o.y),
    objectType: o.objectType,
    raw: o.raw,
  });
}

function makeInstructor(i) {
  if (!i) return { id: '', name: '' };
  return prune({ id: str(i.id), name: i.name || '', imageUrl: i.imageUrl });
}

/**
 * @param {Partial<import('./base').NormalizedProfile>} p
 * @returns {import('./base').NormalizedProfile}
 */
function makeProfile(p) {
  return prune({
    id: str(p.id),
    email: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    bookingCutoff: p.bookingCutoff,
    extendedCutoff: p.extendedCutoff,
    raw: p.raw,
  });
}

/**
 * @param {Partial<import('./base').NormalizedBookingResult>} r
 * @returns {import('./base').NormalizedBookingResult}
 */
function makeBookingResult(r) {
  return prune({
    ok: !!r.ok,
    bookingId: str(r.bookingId),
    slotId: str(r.slotId),
    error: r.error,
    // HTTP status of the underlying response, when known (WP-N3) — lets a
    // caller distinguish "auth expired, worth a relogin retry" (401) from any
    // other failure, without the adapter itself owning retry/relogin logic
    // (that stays the caller's job, per the base.js request() convention).
    status: r.status,
    raw: r.raw,
  });
}

/**
 * @param {Partial<import('./base').NormalizedBooking>} b
 * @returns {import('./base').NormalizedBooking}
 */
function makeBooking(b) {
  return prune({
    bookingId: str(b.bookingId),
    eventId: str(b.eventId),
    slotId: str(b.slotId),
    isWaitlist: bool(b.isWaitlist) ?? false,
    // When the booking was made. Powers the free-cancellation grace period the
    // UI counts down — universal enough to belong on the shape, and the only
    // reason bookings.js was still reading a raw CodexFit field.
    bookedAt: b.bookedAt,
    event: b.event,
    raw: b.raw,
  });
}

// --- coercion helpers -------------------------------------------------------

function str(v) { return v == null ? undefined : String(v); }
function num(v) { return v == null || v === '' || isNaN(Number(v)) ? undefined : Number(v); }
function bool(v) { return v == null ? undefined : !!v; }

/** Remove keys whose value is undefined (keeps false/0/'' ). */
function prune(obj) {
  Object.keys(obj).forEach((k) => obj[k] === undefined && delete obj[k]);
  return obj;
}


// --- Metadata lists (WP-D9) --------------------------------------------------
// The four lists the timetable UI filters on. Deliberately minimal: only what
// the app actually renders, so a platform that has to DERIVE these (MarianaTek
// has no studios/instructors/class-type endpoints at all) can still satisfy the
// shape from its class list.

function makeLocation(l) {
  return prune({ id: str(l.id), name: l.name || '', address: l.address, raw: l.raw });
}

function makeStudio(s) {
  return prune({
    id: str(s.id),
    name: s.name || '',
    locationId: str(s.locationId),
    locationName: s.locationName,
    // Whether a floor plan exists at all — drives "pick a spot" vs "book any".
    hasLayout: bool(s.hasLayout),
    raw: s.raw,
  });
}

function makeClassType(t) {
  return prune({ id: str(t.id), name: t.name || '', group: t.group, raw: t.raw });
}

function makeMetadata(m = {}) {
  return {
    locations: (m.locations || []).map(makeLocation),
    studios: (m.studios || []).map(makeStudio),
    instructors: (m.instructors || []).map(makeInstructor),
    classTypes: (m.classTypes || []).map(makeClassType),
  };
}

module.exports = {
  makeLocation,
  makeStudio,
  makeClassType,
  makeMetadata, makeEvent, makeSlot, makeLayoutObject, makeInstructor, makeProfile, makeBookingResult, makeBooking, prune };
