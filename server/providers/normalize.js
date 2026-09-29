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
/**
 * What a class costs and what it accepts.
 *
 * Absent (undefined) on a gym with no credit system — which is NOT the same as
 * `{ required: 0 }`. Absent means "this question doesn't apply here"; zero means
 * "this specific class is free". Collapsing the two is how a membership gym
 * ends up being asked whether you can afford something.
 */
function makeCreditRequirement(c) {
  if (!c) return undefined;
  const ids = Array.isArray(c.acceptedTypeIds) ? c.acceptedTypeIds.map(str).filter(Boolean) : [];
  return {
    required: Number.isFinite(Number(c.required)) ? Number(c.required) : 1,
    acceptedTypeIds: ids,
  };
}

function photoVersion(url) {
  // Keep this tiny and dependency-free so normalized API responses can mint a
  // new immutable proxy URL whenever a provider changes the source URL.
  return require('crypto').createHash('sha256').update(String(url)).digest('hex');
}

function photoProxyUrl(gymId, instructorId, size, sourceUrl) {
  if (!gymId || !instructorId || !sourceUrl) return undefined;
  return `/api/instructor-photo/${encodeURIComponent(gymId)}/${encodeURIComponent(String(instructorId))}?size=${size}&v=${photoVersion(sourceUrl)}`;
}

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
    instructors: Array.isArray(e.instructors) ? e.instructors.map((instructor) => makeInstructor(instructor, e.gymId)) : [],
    capacity: num(e.capacity),
    availableCount: num(e.availableCount),
    waitlistCount: num(e.waitlistCount),
    isFull: bool(e.isFull),
    waitlistAvailable: bool(e.waitlistAvailable),
    alwaysBookable: bool(e.alwaysBookable),
    layoutFormat: e.layoutFormat || 'pick-a-spot',
    isUserBooked: bool(e.isUserBooked),
    isUserWaitlisted: bool(e.isUserWaitlisted),
    credits: makeCreditRequirement(e.credits),
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

function makeInstructor(i, gymId) {
  if (!i) return { id: '', name: '' };
  // Both adapters already set bio/instagram/spotify fields (marianatek.js's
  // per-event mapping, codexfit.js's fetchMetadata()) — this function was the
  // actual gate dropping every one of them for BOTH gyms, not just Psycle,
  // since it's the single instructor normalizer both `makeEvent` and
  // `makeMetadata` route through. Found 2026-09-02 chasing "Psycle instructor
  // photos broken" — the photo-field-name bug in codexfit.js was real too,
  // but fixing only that would still have lost bio/social links here.
  const imageSource = i.imageUrl || i.thumbUrl;
  const thumbSource = i.thumbUrl || i.imageUrl;
  return prune({
    id: str(i.id), name: i.name || '',
    // Keep direct URLs when a caller does not yet have a gym context (mostly
    // small unit tests). Real provider responses always carry one, so every
    // browser image becomes same-origin and versioned by its source URL.
    imageUrl: gymId ? photoProxyUrl(gymId, i.id, 'full', imageSource) : i.imageUrl,
    thumbUrl: gymId ? photoProxyUrl(gymId, i.id, 'thumb', thumbSource) : i.thumbUrl,
    bio: i.bio, instagramUrl: i.instagramUrl, instagramHandle: i.instagramHandle,
    spotifyUrl: i.spotifyUrl, metafields: i.metafields,
  });
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
 * @param {Partial<import('./base').NormalizedMembership>} m
 * @returns {import('./base').NormalizedMembership}
 */
function makeMembership(m) {
  return prune({
    id: str(m.id),
    name: m.name || 'Membership',
    status: m.status,
    isActive: bool(m.isActive) ?? false,
    renewsAt: m.renewsAt,
    expiresAt: m.expiresAt,
    guestPassesRemaining: num(m.guestPassesRemaining),
    guestPassesTotal: num(m.guestPassesTotal),
    bookingWindowLabel: m.bookingWindowLabel,
    manageUrl: m.manageUrl,
    raw: m.raw,
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
    // Normalized distress signal (C2-3): set by the adapter via
    // base.js's classifyProviderThrottle() when a response looks like a
    // rate limit/block rather than an ordinary failure. The only value
    // today is 'PROVIDER_RATE_LIMITED'; callers (scheduler.js) branch on
    // this code, never on HTTP status or platform, so a future provider
    // can raise the same signal without a call-site change.
    code: r.code,
    // Milliseconds to back off for, when the provider published one
    // (e.g. a `Retry-After` header). Undefined when unknown — the caller
    // supplies its own default rather than treating "unknown" as "none".
    retryAfterMs: r.retryAfterMs,
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
    instructors: (m.instructors || []).map((instructor) => makeInstructor(instructor, m.gymId)),
    classTypes: (m.classTypes || []).map(makeClassType),
  };
}

module.exports = {
  makeLocation,
  makeStudio,
  makeClassType,
  makeMetadata, makeEvent, makeSlot, makeLayoutObject, makeInstructor, makeProfile, makeMembership, makeBookingResult, makeBooking, prune };
