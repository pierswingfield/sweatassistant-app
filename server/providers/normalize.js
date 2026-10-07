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
  // Already a proxy URL (an event's instructor re-normalized by makeMetadata, e.g.
  // MarianaTek derives metadata from events). Re-hashing the proxy URL minted a
  // version that matches no provider URL, so the route 404'd every such photo.
  if (String(sourceUrl).startsWith('/api/instructor-photo/')) {
    return String(sourceUrl).replace(/([?&])size=(?:thumb|full)/, `$1size=${size}`);
  }
  return `/api/instructor-photo/${encodeURIComponent(gymId)}/${encodeURIComponent(String(instructorId))}?size=${size}&v=${photoVersion(sourceUrl)}`;
}

function makeEvent(e) {
  return prune({
    id: str(e.id),
    gymId: e.gymId,
    name: e.name || '',
    discipline: e.discipline,
    startAt: e.startAt,
    timeZone: e.timeZone,
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
    isUserGuestBooked: bool(e.isUserGuestBooked),
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
    section: s.section,
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
  const stats = p.stats && typeof p.stats === 'object' ? prune({
    totalBookings: num(p.stats.totalBookings),
    totalUniqueBookings: num(p.stats.totalUniqueBookings),
    totalUniqueBookingsAttended: num(p.stats.totalUniqueBookingsAttended),
    totalAttendedMinutes: num(p.stats.totalAttendedMinutes),
  }) : undefined;
  return prune({
    id: str(p.id),
    email: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    bookingCutoff: p.bookingCutoff,
    extendedCutoff: p.extendedCutoff,
    stats: Object.keys(stats || {}).length ? stats : undefined,
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
    slotLabel: str(r.slotLabel),
    spotSection: str(r.spotSection),
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
    isGuest: bool(r.isGuest),
    guestEmail: str(r.guestEmail),
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
    slotLabel: str(b.slotLabel),
    spotSection: str(b.spotSection),
    isWaitlist: bool(b.isWaitlist) ?? false,
    isGuest: bool(b.isGuest),
    guestEmail: str(b.guestEmail),
    // When the booking was made. Powers the free-cancellation grace period the
    // UI counts down — universal enough to belong on the shape, and the only
    // reason bookings.js was still reading a raw CodexFit field.
    bookedAt: b.bookedAt,
    timeZone: b.timeZone || (b.event && b.event.timeZone),
    event: b.event,
    raw: b.raw,
  });
}

/**
 * One past (or settled) booking for the class-history store (F-10-0).
 * `status` is the NORMALIZED vocabulary, never a provider's own:
 *   attended | unconfirmed | late-cancel | cancelled | no-show | class-cancelled
 * `unconfirmed` = the class has passed with the booking intact but the platform
 * gave no positive attendance signal (MarianaTek `pending` after start).
 * @returns {import('./base').NormalizedHistoryEntry}
 */
const HISTORY_STATUSES = ['attended', 'unconfirmed', 'late-cancel', 'cancelled', 'no-show', 'class-cancelled'];
function makeHistoryEntry(h) {
  const ev = h.event || {};
  const ins = (ev.instructors && ev.instructors[0]) || {};
  return prune({
    bookingId: str(h.bookingId),
    eventId: str(h.eventId ?? ev.id),
    status: HISTORY_STATUSES.includes(h.status) ? h.status : 'unconfirmed',
    startAt: ev.startAt,
    timeZone: ev.timeZone,
    durationMin: num(ev.durationMin),
    slotLabel: str(h.slotLabel),
    spotSection: str(h.spotSection),
    name: ev.name,
    discipline: ev.discipline,
    instructorId: str(ins.id),
    instructorName: ins.name,
    studioId: str(ev.studioId),
    studioName: ev.studioName,
    locationId: str(ev.locationId),
    locationName: ev.locationName,
    raw: h.raw,
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
  return prune({ id: str(l.id), name: l.name || '', address: l.address, timeZone: l.timeZone, raw: l.raw });
}

function makeStudio(s) {
  return prune({
    id: str(s.id),
    name: s.name || '',
    locationId: str(s.locationId),
    locationName: s.locationName,
    // Whether a floor plan exists at all — drives "pick a spot" vs "book any".
    hasLayout: bool(s.hasLayout),
    // Whether the spot-map editor offers the whole-row preference for this studio.
    // Gym policy (gyms.config spotMap.rowGroupStudios); default off.
    rowGroups: s.rowGroups === true,
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
  makeMetadata, makeEvent, makeSlot, makeLayoutObject, makeInstructor, makeProfile, makeMembership, makeBookingResult, makeBooking, makeHistoryEntry, HISTORY_STATUSES, prune };
