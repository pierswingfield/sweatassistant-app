// Sweat Assistant — CodexFit provider adapter.
//
// Extracted from the previously-inlined CodexFit logic in auth.js, server.js,
// scheduler.js, poller.js and calendar.js. All CodexFit HTTP specifics (base URL,
// origin/referer/x-organisation headers, login shape, public-path detection,
// re-login-on-401) live here now, driven by the gym config (server/gyms.config.js).
//
// Behavior is intentionally identical to the old inline code — this is a
// behavior-preserving extraction (WP-A3). Normalized reads/writes below (WP-N1)
// mirror the shapes already proven live by scheduler.js/mock.js. fetchTimetable
// (fixed 2026-07-03, see PROGRESS.md WP-C1 handoff) fans out per-location with
// server-side start/end params, per psycle_codexfit.md's documented contract —
// the query params aren't guessed, they come from the extension's own
// previously-captured traffic.

const { DateTime } = require('luxon');
const { GymProvider } = require('./base');
const bookingWindow = require('./booking-window');
const { makeMetadata, makeProfile, makeEvent, makeSlot, makeLayoutObject, makeBookingResult, makeBooking } = require('./normalize');

// Dev-mode bypass, aligned with MarianaTek's dev@jabboxing.mock convention.
// login() must establish the sentinel session itself, since a fresh account
// linking Psycle has no existing token for request() to recognise yet.
const DEV_EMAIL = 'dev@psycle.com';

// Matches the sentinel set by auth.js's dev@psycle.com bypass (db.updateUserJWT
// with 'mock-jwt-token'). See request()'s doc comment below for why this check
// lives here now, not just in the 5 pre-Phase-3 callers.
const MOCK_TOKEN = 'mock-jwt-token';

// Error with an attached HTTP `.status`, for methods (listBookings/listWaitlists)
// that throw on failure instead of returning a NormalizedBookingResult — lets a
// caller distinguish "401, worth a relogin retry" without string-parsing the message.
function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// CodexFit publishes non-bookable floor fixtures (the instructor podium) as
// `studio.layout.objects`, alongside `studio.layout.slots`. The full object
// schema isn't documented anywhere (psycle_codexfit.md doesn't cover it) and
// the only fields the app has ever read are `x`/`y` — so map those plus the
// ids/labels IF present, keep the rest on `raw`, and don't invent a shape
// (Golden Rule 6). Absent fields prune away, and the renderer supplies its own
// default label, preserving today's behaviour exactly.
function mapLayoutObjects(studio) {
  const objects = (studio && studio.layout && studio.layout.objects) || [];
  return objects.map((o) => makeLayoutObject({
    id: o.id,
    label: o.name || o.label,
    x: o.x,
    y: o.y,
    objectType: o.type,
    raw: o,
  }));
}

class CodexFitProvider extends GymProvider {
  // Build the standard CodexFit header set. Mirrors the old getCodexFitHeaders()
  // and the inline header objects exactly.
  buildHeaders(token, isJSON = false) {
    const headers = {
      accept: 'application/json',
      ...this.gym.headers, // origin, referer, x-organisation
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (isJSON) headers['content-type'] = 'application/json';
    return headers;
  }

  // Accept either a full CodexFit URL (as legacy callers pass) or a path relative
  // to the customer API base. This lets callers migrate incrementally.
  url(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return this.gym.apiBaseUrl + pathOrUrl;
  }

  // Strip the CodexFit API base from a full URL → the customer path (for mock routing).
  toPath(pathOrUrl) {
    return pathOrUrl.replace(this.gym.apiBaseUrl, '');
  }

  /** Is this GET a public (no-auth) CodexFit read? Mirrors server.js PUBLIC_PATHS. */
  isPublicRead(method, path) {
    return method === 'GET' && this.gym.publicPathPattern.test(path);
  }

  // --- Raw request helpers (used by proxy/scheduler/poller during Phase 1/3) ---

  /**
   * Authenticated fetch. No auto-relogin here — the 401 ladder is the caller's
   * job (proxyRequest / fetchCodexFit already own that flow). Returns the raw
   * Response so callers keep their existing handling.
   *
   * Dev-mode note: the 5 pre-Phase-3 callers (auth.js, server.js proxy,
   * scheduler.js, poller.js, admin.js) each own a `user.email === 'dev@psycle.com'`
   * check that intercepts BEFORE ever reaching this method — they call mock.js
   * directly. Any NEW caller (e.g. WP-N1's routes-normalized.js) won't have that
   * check, so this method also recognizes the mock sentinel token directly —
   * purely additive, never fires for the 5 existing callers since they never
   * construct a call with this token in the first place.
   */
  async request(pathOrUrl, { token, method = 'GET', body, headers } = {}) {
    if (token === MOCK_TOKEN) {
      const { handleMockRequest } = require('../mock');
      return handleMockRequest(this.toPath(pathOrUrl), method, typeof body === 'string' ? JSON.parse(body) : body);
    }
    const opts = { method, headers: { ...this.buildHeaders(token, !!body), ...(headers || {}) } };
    if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (typeof body === 'string') {
        opts.body = body;
      } else if (Object.keys(body).length > 0) {
        opts.body = JSON.stringify(body);
      } else {
        // Empty body object → no content-type/body, matching legacy behavior.
        delete opts.headers['content-type'];
      }
    }
    return fetch(this.url(pathOrUrl), opts);
  }

  /**
   * Public (no Bearer) fetch — events/locations/studios/etc. No mock check
   * here: dev-mode reads always go through request() with the mock token once
   * logged in (fetchTimetable/fetchEventDetails prefer request() whenever a
   * session is available — same convention as the MarianaTek adapter).
   */
  async publicRequest(pathOrUrl, { method = 'GET' } = {}) {
    return fetch(this.url(pathOrUrl), { method, headers: this.buildHeaders(null, false) });
  }

  // --- Authentication -------------------------------------------------------

  /**
   * Direct credential login. Returns a normalized session + profile, plus the
   * raw payload so legacy callers can read `raw.access_token` / `raw.user`.
   */
  async login({ email, password }) {
    if (process.env.NODE_ENV !== 'production' && email === DEV_EMAIL) {
      const session = {
        accessToken: MOCK_TOKEN,
        expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
      };
      // Keep the mock profile on the same adapter path as an authenticated
      // production profile; request() recognises MOCK_TOKEN and never fetches.
      const profile = await this.getProfile(session);
      return { session, profile, raw: { access_token: MOCK_TOKEN, mock: true } };
    }

    const res = await fetch(this.url(this.gym.loginPath), {
      method: 'POST',
      headers: this.buildHeaders(null, true),
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `Login failed with status ${res.status}`);
    }

    const data = await res.json(); // { access_token, user: { ... } }
    const u = data.user || data.customer || data.data || {};
    return {
      session: { accessToken: data.access_token },
      profile: makeProfile({
        id: u.id,
        email: u.email || email,
        firstName: u.first_name,
        lastName: u.last_name,
        bookingCutoff: u.booking_cutoff,
        extendedCutoff: u.extended_cutoff,
        raw: u,
      }),
      raw: data,
    };
  }

  async validateSession(session) {
    return !!(session && session.accessToken);
  }

  /**
   * CodexFit has no token-refresh endpoint (see AGENTS.md gotchas) — the only
   * option is a full re-login with stored credentials.
   */
  async refreshSession(_session, credentials) {
    const { session } = await this.login(credentials);
    return session;
  }

  /** GET /profile → normalized profile. Used by scheduler/poller/calendar in Phase 3. */
  async getProfile(session) {
    const res = await this.request('/profile', { token: session.accessToken });
    if (!res.ok) throw httpError(`getProfile failed: ${res.status}`, res.status);
    const u = await res.json();
    return makeProfile({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      bookingCutoff: u.booking_cutoff,
      extendedCutoff: u.extended_cutoff,
      raw: u,
    });
  }

  /**
   * "Can this account book at all" for CodexFit: it's a metered gym, so this
   * collapses to "does this account hold any usable credit" — deliberately
   * NOT reusing `available_credits` summed elsewhere for PER-CLASS affordance
   * (getAvailableCreditsForEvent on the client); this is the coarser
   * account-level question, evaluated the same way (any credit_type with a
   * positive count) but with no specific class in view.
   * @param {import('./base').AuthSession} session
   * @returns {Promise<import('./base').NormalizedEligibility>}
   */
  async getEligibility(session) {
    const res = await this.request('/profile', { token: session.accessToken });
    if (!res.ok) throw httpError(`getEligibility failed: ${res.status}`, res.status);
    const u = await res.json();
    const credits = u.available_credits || [];
    const total = credits.reduce((sum, c) => sum + (c.count || 0), 0);
    if (total > 0) return { canBook: true };
    return { canBook: false, reason: 'No credits available' };
  }

  /**
   * Credit inventory, normalized.
   *
   * The raw shape is `available_credits: [{ count, credit_type: {id, name},
   * expires_at }]` — GROUPED entries carrying a count, with the type nested,
   * and NO sibling `relations.credit_types` bag (unlike /events). The client's
   * credit-detail modal assumed both the opposite things: a flat `credit_type_id`
   * and a `relations.credit_types` array to look names up in. It read the latter
   * off `profile.raw`, defaulted it to `{}` when missing, then called `.find()`
   * on that object — which is why opening the modal threw
   * "creditTypes.find is not a function" rather than degrading.
   *
   * Normalizing here means the client never sees any of that.
   */
  async getCredits(session) {
    const res = await this.request('/profile', { token: session.accessToken });
    if (!res.ok) throw httpError(`getCredits failed: ${res.status}`, res.status);
    const u = await res.json();
    return (u.available_credits || []).map((c) => ({
      typeId: c.credit_type && c.credit_type.id != null ? String(c.credit_type.id) : undefined,
      typeName: (c.credit_type && c.credit_type.name) || 'Credits',
      count: Number(c.count) || 0,
      expiresAt: c.expires_at || undefined,
      // 11 of Psycle's 46 credit types are guest-only ("Guest", "Clapham
      // Guest", …) and classes DO accept them — for booking a guest in, not
      // yourself. Counting them toward your own allowance says you can book
      // when you cannot. Undefined when the profile payload omits the flag;
      // the client treats undefined as "not guest-only", matching the
      // unknown-defaults-permissive rule used for capabilities.
      isGuestOnly: c.credit_type && typeof c.credit_type.is_guest_use_only === 'boolean'
        ? c.credit_type.is_guest_use_only
        : undefined,
      raw: c,
    }));
  }

  // --- Timetable & layout (WP-N1) --------------------------------------------
  //
  // Field mapping confirmed against server/mock.js's CodexFit fixtures AND (as
  // of 2026-07-03) a real live browser capture of /events/{id}, /bookings, and
  // /waitlists (the capture itself was deleted after extraction per its own
  // handling note — see PROGRESS.md's handoff for that date). Two fields are
  // deliberately left unset because the adapter genuinely doesn't have enough
  // context to compute them correctly:
  //   - releaseAt: CodexFit has no published per-event release time (unlike
  //     MT's booking_start_datetime) — it depends on the viewing USER's
  //     booking_cutoff/extended_cutoff + credit inventory. That's business
  //     logic scheduler.js already owns (getClassReleaseTime()); duplicating
  //     it here would need to reach into db.getUserSettings(), which breaks
  //     the adapter's "stateless w.r.t. a specific server-side user" design.
  //     WP-S1 (Phase 6) is where this actually gets wired together.
  //   - isUserBooked/isUserWaitlisted: not present on a single /events list
  //     item (unlike MT's is_user_reserved) — would need cross-referencing
  //     the user's own /bookings list, a second fetch the caller should do,
  //     not something this method should silently trigger.

  /**
   * `GET /events` is scoped to ONE location per call and takes server-side
   * `start`/`end` range params (psycle_codexfit.md §2.1 "Timetable Events",
   * confirmed from the extension's own real traffic — not a guess). The old
   * inline client code (still `timetable.js`'s `prefetchTimetableData`) always
   * fanned out per-location; this mirrors that here instead of the earlier
   * client-side-only date filter, which silently assumed an unscoped `/events`
   * call returns something useful (never confirmed against the real API — see
   * PROGRESS.md WP-C1 handoff 2026-07-03). Locations are discovered via
   * `GET /locations` (also public/no-auth per the docs) rather than hardcoded,
   * since they're account/org data, not gym config.
   * @param {{startDate?: string, endDate?: string}} params
   * @param {import('./base').AuthSession=} session
   * @returns {Promise<import('./base').NormalizedEvent[]>}
   */
  // --- Booking window (WP-D8) -------------------------------------------------
  //
  // CodexFit's half of this is purely "where are the cutoff fields": they sit on
  // the profile as `booking_cutoff` / `extended_cutoff`, gated by an
  // `extended_booking_allowed` metafield. What those dates MEAN — Monday noon,
  // a 14-day base, a 15-day credit floor — is Psycle's policy and lives in
  // gyms.config.js, so a second CodexFit gym with different rules needs no
  // change here.
  // `credits` is accepted but unused: the window comes from the profile cutoff
  // alone. It stays in the signature because this adapter is the right seam for
  // any future credit- or promotion-based adjustment — that logic belongs to a
  // gym, never to the shared evaluator.
  resolveBookingWindow(profile, credits) {
    const policy = bookingWindow.policyOf(this.gym);
    if (policy.kind !== 'rolling-weekly') return null;
    if (!profile) return null;

    const bookingCutoff = profile.booking_cutoff || null;
    const extendedCutoff = profile.extended_cutoff || null;
    const mf = profile.metafields || {};
    const extendedAllowed = !!(mf.extended_booking_allowed ?? (mf.public && mf.public.extended_booking_allowed))
      || (!!extendedCutoff && !!bookingCutoff && extendedCutoff > bookingCutoff);

    const effective = (extendedAllowed && extendedCutoff) ? extendedCutoff : bookingCutoff;
    const win = bookingWindow.windowFromCutoff(effective, policy);
    if (!win) return null;
    return { ...win, extendedAllowed, source: win.source === 'cutoff' ? (extendedAllowed ? 'extended' : 'standard') : win.source };
  }

  releaseAtFor(startAt, window) {
    const policy = bookingWindow.policyOf(this.gym);
    const offsetDays = (window && window.offsetDays) != null
      ? window.offsetDays
      : bookingWindow.fallbackOffsetDays(policy, {});
    const dt = bookingWindow.releaseFor(startAt, offsetDays, policy);
    return dt ? dt.toISO() : undefined;
  }

  async fetchTimetable(params = {}, session) {
    const fetcher = session
      ? (path) => this.request(path, { token: session.accessToken })
      : (path) => this.publicRequest(path);

    const startDate = params.startDate
      ? DateTime.fromISO(params.startDate, { zone: this.gym.timezone })
      : DateTime.now().setZone(this.gym.timezone);
    const endDate = params.endDate
      ? DateTime.fromISO(params.endDate, { zone: this.gym.timezone })
      : startDate.plus({ weeks: 4 });
    const start = startDate.toFormat('yyyy-MM-dd') + ' 00:00:00';
    const end = endDate.toFormat('yyyy-MM-dd') + ' 23:59:59';

    const locRes = await fetcher('/locations');
    if (!locRes.ok) throw httpError(`fetchTimetable failed to load locations: ${locRes.status}`, locRes.status);
    const locData = await locRes.json();
    const locations = Array.isArray(locData) ? locData : (locData.data || []);

    // Best-effort per-location — one failing location shouldn't blank the
    // whole timetable, matching the old client's own per-location try/catch.
    const results = await Promise.allSettled(locations.map((loc) => {
      const url = `/events?location=${loc.id}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
      return fetcher(url).then((res) => (res.ok ? res.json() : null));
    }));

    const seen = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const list = Array.isArray(r.value) ? r.value : (r.value.data || []);
      // The real `GET /events` returns id-referenced events (`event_type_id`,
      // `instructor_id`, `studio_id`) plus a SIBLING `relations` bag — it does
      // NOT embed them inline, whatever an earlier comment here claimed. Each
      // location's response carries its own bag, so resolve within the response
      // rather than pooling them.
      //
      // Skipping this is what caused the 2026-08-31 "CLASS" regression: with
      // `event_type` unresolved, `mapEventToNormalized` produced events with no
      // `discipline` (and no studio/location/instructor names), and the client —
      // which had just lost its own relations-merge in WP-C1 — fell through to
      // rendering a literal "CLASS" pill for any type missing from the base
      // `/event_types` list. The dev mock hid it by embedding the relations
      // inline, which the real API never does.
      const relations = (r.value && r.value.relations) || {};
      for (const e of list) {
        if (!seen.has(String(e.id))) seen.set(String(e.id), this.resolveEventRelations(e, relations));
      }
    }
    return Array.from(seen.values()).map((e) => this.mapEventToNormalized(e));
  }

  /**
   * @param {string} eventId
   * @param {import('./base').AuthSession=} session
   * @returns {Promise<import('./base').NormalizedEventDetails>}
   */
  async fetchEventDetails(eventId, session) {
    const res = session
      ? await this.request(`/events/${eventId}`, { token: session.accessToken })
      : await this.publicRequest(`/events/${eventId}`);
    if (!res.ok) throw httpError(`fetchEventDetails failed: ${res.status}`, res.status);
    const data = await res.json();
    const payload = data.data || data;
    const relations = data.relations || payload.relations || {};
    // Match by id, same as resolveEventRelations() below — `relations.studios[0]`
    // silently picked the wrong room whenever the bag carried more than one
    // studio, so a class in a room with an open spot could resolve against an
    // unrelated (full) room's layout and read as fully booked.
    const studio = (relations.studios || []).find((s) => s.id === payload.studio_id) || payload.studio;
    const layoutSlots = (studio && studio.layout && studio.layout.slots) || [];
    // `slots` (available slot ids) is a SIBLING of `data`, not nested inside it
    // — confirmed via a real live capture 2026-07-03 (top-level keys: data,
    // slots, bookings, max_bookable_slots, ...). Fall back to payload.slots
    // defensively in case a legacy/alternate response shape nests it instead.
    const availableIds = new Set(((data.slots || payload.slots) || []).map(String));
    const slots = layoutSlots.map((s) => makeSlot({
      id: s.id, label: s.name, x: s.x, y: s.y,
      isAvailable: availableIds.has(String(s.id)),
      raw: s,
    }));
    // Real capture confirmed /events/{id} DOES carry full event metadata — the
    // earlier "id + raw only" comment here was based on an incomplete
    // assumption (matching the mock's old, now-corrected minimal shape), not a
    // real API constraint. `start_at`/`duration`/`occupancy`/`capacity` are
    // inline on `data`; `instructor`/`event_type`/`location` are id-referenced
    // (`instructor_id` etc.) against the sibling `relations` block, resolved
    // via resolveEventRelations() below before mapping.
    const event = this.mapEventToNormalized(this.resolveEventRelations({ ...payload, id: payload.id || eventId }, relations));
    // `max_bookable_slots` is a SIBLING of `data`, same as `slots` above.
    const maxBookableSlots = (data.max_bookable_slots ?? payload.max_bookable_slots);
    return {
      event,
      slots,
      objects: mapLayoutObjects(studio),
      maxBookableSlots: maxBookableSlots != null ? Number(maxBookableSlots) : undefined,
    };
  }

  /**
   * Deliberately uses `GET /studios` (the documented list endpoint —
   * psycle_codexfit.md §2.1 "Lists studio rooms and their configuration
   * layouts") rather than a singular `GET /studios/{id}`, which isn't
   * documented anywhere and was never confirmed against the real API — the
   * pre-existing client code that called it (settings.js's
   * `openStudioFloorPlanEditor`, now migrated onto this method) was relying on
   * unconfirmed behavior (Golden Rule 6: don't guess the API). Filtering the
   * confirmed list client-side is slightly more wasteful per-call but
   * verifiably correct, and it's the same "list already fetched elsewhere in
   * the app" data every studio-aware feature already uses (loadMetadata()'s
   * own `/studios` call in timetable.js). Some studios have no `.layout` in
   * the list response (confirmed real-world gap, e.g. Reformer per existing
   * code comments) — returns `[]` for those, same as "no floor map available".
   */
  async fetchStudioLayout(studioId, session) {
    const res = session
      ? await this.request('/studios', { token: session.accessToken })
      : await this.publicRequest('/studios');
    if (!res.ok) throw httpError(`fetchStudioLayout failed: ${res.status}`, res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.data || []);
    const studio = list.find((s) => String(s.id) === String(studioId));
    const layoutSlots = (studio && studio.layout && studio.layout.slots) || [];
    return {
      // No event context here, so per-spot availability is unknowable — every
      // slot is reported available. Callers of this method are preference
      // editors (which don't show availability), never booking flows.
      slots: layoutSlots.map((s) => makeSlot({ id: s.id, label: s.name, x: s.x, y: s.y, isAvailable: true, raw: s })),
      objects: mapLayoutObjects(studio),
    };
  }

  /**
   * Resolve id-referenced relations (instructor_id/studio_id/event_type_id)
   * against a sibling `relations` bag into the INLINE shape
   * mapEventToNormalized() expects (instructor/studio/event_type nested
   * directly on the event object) — needed for endpoints that return events
   * by-reference (GET /events/{id}, GET /bookings's relations block) rather
   * than by-value (GET /events list, GET /waitlists' embedded `event`, both of
   * which already carry instructor/studio/event_type inline and skip this).
   */
  // CodexFit serves a dedicated endpoint per list, so this is four public reads
  // in parallel. `hasLayout` comes from the studio's own embedded layout — the
  // one field the UI needs that isn't just an id and a name.
  async fetchMetadata(params = {}, session) {
    const get = async (path) => {
      const res = session
        ? await this.request(path, { token: session.accessToken })
        : await this.publicRequest(path);
      if (!res.ok) throw httpError(`fetchMetadata ${path} failed: ${res.status}`, res.status);
      const data = await res.json();
      return Array.isArray(data) ? data : (data.data || []);
    };
    const [locations, studios, instructors, eventTypes] = await Promise.all([
      get('/locations'), get('/studios'), get('/instructors'), get('/event-types'),
    ]);
    return makeMetadata({
      locations: locations.map((l) => ({ id: l.id, name: l.name, address: l.address, raw: l })),
      studios: studios.map((st) => ({
        id: st.id,
        name: st.name,
        locationId: st.location_id || (st.location && st.location.id),
        locationName: st.location && st.location.name,
        hasLayout: !!(st.layout && Array.isArray(st.layout.slots) && st.layout.slots.length),
        raw: st,
      })),
      instructors: instructors.map((i) => ({
        id: i.id, name: i.full_name || i.name,
        // `photo` is the real field — confirmed 2026-09-02 against a live
        // capture of GET /instructors. `image_url`/`photo_url` (the previous
        // mapping) don't exist on the raw object at all, so `imageUrl` was
        // silently undefined for every Psycle instructor since this was
        // written — nothing threw, the tooltip just fell back to its
        // initial-letter placeholder. Bio/Instagram/Spotify live under
        // `metafields` (`description`, `instagram_handle`, `spotify_handle`,
        // `keywords`) — passed through as-is rather than re-extracted here,
        // since `tooltips.js` already reads `instructor.metafields?.*` as
        // its fallback chain (written for this exact shape, just never fed
        // it before now).
        imageUrl: i.photo, metafields: i.metafields, raw: i,
      })),
      classTypes: eventTypes.map((t) => ({
        id: t.id, name: t.name, group: t.group && t.group.name, raw: t,
      })),
    });
  }

  resolveEventRelations(e, relations = {}) {
    // Non-destructive: a relation is only overwritten when the relations bag
    // actually resolves it. Some responses carry the entities inline instead of
    // by reference, and an unconditional assignment would blank them out.
    const instructor = (relations.instructors || []).find((i) => i.id === e.instructor_id) || e.instructor;
    const eventType = (relations.event_types || []).find((t) => t.id === e.event_type_id) || e.event_type;
    const rawStudio = (relations.studios || []).find((s) => s.id === e.studio_id) || e.studio;
    const location = rawStudio
      && ((relations.locations || []).find((l) => l.id === rawStudio.location_id) || rawStudio.location);
    return {
      ...e,
      instructor,
      event_type: eventType,
      studio: rawStudio ? { ...rawStudio, location } : undefined,
    };
  }

  /**
   * Accepted credit-type ids, from whichever of CodexFit's two parallel fields
   * is populated: `credit_types: [{credit_type: <id>}]` and
   * `accepted_credits: [{credit_type_id: <id>}]` carry the same ids in
   * different shapes on the same payload. Read both — a list response and a
   * detail response do not reliably agree on which one they send.
   */
  static acceptedCreditTypeIds(e) {
    const out = new Set();
    for (const c of (e.credit_types || [])) {
      const id = c && (c.credit_type != null ? c.credit_type : c.id);
      if (id != null) out.add(String(typeof id === 'object' ? id.id : id));
    }
    for (const c of (e.accepted_credits || [])) {
      const id = c && (c.credit_type_id != null ? c.credit_type_id : c.id);
      if (id != null) out.add(String(id));
    }
    return [...out];
  }

  mapEventToNormalized(e) {
    return makeEvent({
      id: e.id,
      gymId: this.gymId,
      // GET /events list items carry a top-level `name`; GET /events/{id}'s
      // `data` object does not (confirmed via live capture) — fall back to the
      // resolved event_type's own name, which is what the real site displays.
      name: e.name || (e.event_type && e.event_type.name) || '',
      discipline: e.event_type && e.event_type.group && e.event_type.group.name,
      startAt: e.start_at,
      // CodexFit's start_at is a timezone-naive local London string (no offset
      // suffix) — must resolve via Luxon in the GYM's zone, never bare Date
      // arithmetic (AGENTS.md rule 7). A bare `new Date(e.start_at)` parses it
      // as the RUNNING MACHINE's local zone, which is wrong on any server not
      // itself in that zone and silently drifts across DST transitions.
      durationMin: e.duration,
      endAt: e.start_at && e.duration ? DateTime.fromISO(e.start_at, { zone: this.gym.timezone }).plus({ minutes: e.duration }).toISO() : undefined,
      locationId: e.location_id || (e.studio && e.studio.location_id) || (e.studio && e.studio.location && e.studio.location.id),
      locationName: e.studio && e.studio.location && e.studio.location.name,
      locationAddress: e.studio && e.studio.location && e.studio.location.address,
      studioId: e.studio_id || (e.studio && e.studio.id),
      studioName: e.studio && e.studio.name,
      instructors: e.instructor ? [{ id: e.instructor.id, name: e.instructor.full_name || e.instructor.name }] : [],
      capacity: e.capacity,
      availableCount: e.capacity != null && e.occupancy != null ? Math.max(0, e.capacity - e.occupancy) : undefined,
      isFull: e.is_fully_booked,
      // CodexFit splits this three ways; the app only needs "can I join one".
      waitlistAvailable: e.is_waitlistable !== false && e.waitlist_available !== false && !e.is_waitlist_full,
      alwaysBookable: e.is_always_bookable,
      layoutFormat: 'pick-a-spot', // CodexFit has no FCFS-equivalent per research
      // What this class costs and which credit types it accepts. CONFIRMED live
      // 2026-09-14 against psyclelondon.com's public /events: every event
      // carries `required_credits` (698 of 705 were 1, but 4 were 2 and 3 were
      // 0) and `credit_types` / `accepted_credits` listing the accepted type
      // ids, which differ per class — a Ride-only credit is accepted by ride
      // classes and refused elsewhere.
      //
      // Both fields existed all along and neither was normalized, so the client
      // asked "do you hold ANY credits at all" instead. That answers the wrong
      // question in both directions: bookable when you cannot afford a 2-credit
      // class, and blocked when you hold the wrong type.
      credits: creditRequirementFrom(e),
      raw: e,
    });
  }

  // --- Bookings & waitlists (WP-N1) ------------------------------------------

  /**
   * Books ONE reservation attempt (mirrors the MarianaTek adapter's contract —
   * multi-slot retry-until-success is scheduler orchestration, not this
   * method's job). `POST /bookings` accepts multiple slots in one call per
   * scheduler.js's existing usage, but this method sends exactly one to keep
   * the per-attempt semantics consistent across providers.
   */
  async bookSlot(eventId, slotIds, session) {
    // One spot per call, by contract (see base.js). CodexFit would accept the
    // whole array here, but MarianaTek cannot, so the normalized surface is
    // singular and callers loop. Taking [0] is the contract, not a truncation
    // bug — a caller passing several is the thing that's wrong.
    const body = { event_id: eventId };
    if (slotIds && slotIds.length > 0) body.slots = [slotIds[0]];
    const res = await this.request('/bookings', { token: session.accessToken, method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return makeBookingResult({ ok: false, status: res.status, error: data.message || `HTTP ${res.status}`, raw: data });
    }
    // Response shape: { success: true, bookings: { bookingId: slotId } } — see
    // AGENTS.md "Booking response shape" gotcha.
    const bookingsMap = data.bookings || {};
    const bookingId = Object.keys(bookingsMap)[0];
    const slotId = bookingId ? bookingsMap[bookingId] : (slotIds && slotIds[0]);
    return makeBookingResult({ ok: true, bookingId, slotId, raw: data });
  }

  async cancelBooking(bookingId, session) {
    const res = await this.request(`/bookings/${bookingId}`, { token: session.accessToken, method: 'DELETE' });
    return res.ok;
  }

  /**
   * CodexFit has no cancel_penalty endpoint (unlike MarianaTek) — the rule is
   * policy, not queryable: penalty-free if cancelled >12h before class start
   * (psycle_codexfit.md "Cancel a Booking"). There's also no per-booking GET
   * (AGENTS.md gotcha), so this has to fetch the full recent-bookings list and
   * find the match — genuinely the only way to learn a booking's class start
   * time from this API.
   */
  async getCancelPenalty(bookingId, session) {
    const res = await this.request('/bookings?limit=100&page=1', { token: session.accessToken });
    if (!res.ok) throw httpError(`getCancelPenalty failed: ${res.status}`, res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.data || []);
    const booking = list.find((b) => String(b.id) === String(bookingId));
    if (!booking || !booking.event || !booking.event.start_at) {
      throw new Error(`Booking ${bookingId} not found in recent bookings — cannot determine cancel penalty (CodexFit has no per-booking lookup endpoint).`);
    }
    const startAt = DateTime.fromISO(booking.event.start_at, { zone: this.gym.timezone });
    const hoursUntilClass = startAt.diff(DateTime.now().setZone(this.gym.timezone), 'hours').hours;
    const isPenalty = hoursUntilClass < 12;
    return { isPenalty, message: isPenalty ? 'Cancelling within 12 hours of class start forfeits the credit.' : undefined };
  }

  /** PUT /waitlists/{eventId} — see psycle_codexfit.md "Join a Waitlist". */
  async joinWaitlist(eventId, session) {
    const res = await this.request(`/waitlists/${eventId}`, { token: session.accessToken, method: 'PUT' });
    return res.ok;
  }

  /** DELETE /waitlists/{eventId} — always penalty-free per the research doc. */
  async leaveWaitlist(eventId, session) {
    const res = await this.request(`/waitlists/${eventId}`, { token: session.accessToken, method: 'DELETE' });
    return res.ok;
  }

  /**
   * List active (non-cancelled) bookings. Real shape confirmed via a live
   * capture (2026-07-03): each row is bare (`id, event_id, slot,
   * cancelled_at, ...`), but the RESPONSE carries a top-level `relations`
   * block with `events[]` (id-referenced, same shape as /events/{id}'s
   * `data`) alongside `instructors[]`/`event_types[]`/`studios[]`/
   * `locations[]` — the earlier assumption that this endpoint has "no
   * embedded event/class details at all" was wrong (based on the mock's own
   * old, now-corrected minimal shape). `event` is now populated by joining
   * `event_id` against `relations.events[]` and resolving that event's own
   * id-references via resolveEventRelations(), same helper fetchEventDetails
   * uses. `mock.js`'s bookings additionally embed `b.event` directly
   * (a simpler, dev-only convention) — checked first since it needs no join.
   * `slot` (a bare number) is the confirmed real field name; the other
   * fallbacks (`studio_slot.id`/`studio_slot_id`/`slot_id`) are kept
   * defensively for any API-version drift, not because they're confirmed.
   *
   * Throws with `.status` set to the HTTP status on failure (same convention
   * as NormalizedBookingResult.status, WP-N3) — a 401 here is the signal a
   * caller should relogin and retry, same as the booking-write ladder;
   * calendar.js's listWithRelogin keys off it.
   */
  async listBookings(session) {
    const res = await this.request('/bookings?limit=100&page=1', { token: session.accessToken });
    if (!res.ok) throw httpError(`listBookings failed: ${res.status}`, res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.data || []);
    const relations = (!Array.isArray(data) && data.relations) || {};
    const eventsById = new Map((relations.events || []).map((e) => [String(e.id), e]));
    return list
      .filter((b) => !b.cancelled_at)
      .map((b) => {
        const eventId = b.event_id || (b.event && b.event.id);
        const rawEvent = b.event || eventsById.get(String(eventId));
        const event = rawEvent
          ? this.mapEventToNormalized(b.event ? rawEvent : this.resolveEventRelations(rawEvent, relations))
          : undefined;
        return makeBooking({
          bookingId: b.id,
          eventId,
          slotId: b.slot ?? (b.studio_slot && b.studio_slot.id) ?? b.studio_slot_id ?? b.slot_id,
          bookedAt: b.booked_at || b.created_at,
          isWaitlist: false,
          event,
          raw: b,
        });
      });
  }

  /**
   * List active waitlist entries. Real shape confirmed via a live capture
   * (2026-07-03): unlike /bookings, each waitlist item embeds a FULL `event`
   * object directly (`w.event.{start_at,duration,instructor,event_type,
   * studio}` — all inline, not id-referenced), so no relations-join is
   * needed here — mapEventToNormalized(w.event) works directly, the same as
   * for a GET /events list item. Also present but not modeled here: a
   * `customer` object (the waitlisted user's own profile) — not useful to a
   * caller who already knows which user this is.
   */
  async listWaitlists(session) {
    const res = await this.request('/waitlists?page=1', { token: session.accessToken });
    if (!res.ok) throw httpError(`listWaitlists failed: ${res.status}`, res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.data || []);
    return list
      .filter((w) => !w.cancelled_at)
      .map((w) => makeBooking({
        bookingId: w.id,
        eventId: w.event_id || (w.event && w.event.id),
        isWaitlist: true,
        event: w.event ? this.mapEventToNormalized(w.event) : undefined,
        raw: w,
      }));
  }

  /**
   * No atomic swap API (capabilities.atomicSwap: false) — cancel-then-rebook,
   * per psycle_codexfit.md "Spot Swapping Limitations". This has a real,
   * documented race window: the original spot is released before the new one
   * is confirmed, so a failure here can leave the user with NEITHER spot. The
   * interface only provides bookingId/currentSlotId/targetSlotId (no eventId),
   * so the booking's event_id is looked up first via the same bookings-list
   * scan getCancelPenalty uses.
   */
  async swapSpots(bookingId, currentSlotId, targetSlotId, session) {
    const listRes = await this.request('/bookings?limit=100&page=1', { token: session.accessToken });
    const listData = await listRes.json().catch(() => ({}));
    const list = Array.isArray(listData) ? listData : (listData.data || []);
    const booking = list.find((b) => String(b.id) === String(bookingId));
    if (!booking || !booking.event) {
      return makeBookingResult({ ok: false, error: `Booking ${bookingId} not found — cannot determine event for rebooking.` });
    }
    const eventId = booking.event.id;

    const cancelOk = await this.cancelBooking(bookingId, session);
    if (!cancelOk) {
      return makeBookingResult({ ok: false, error: 'Failed to cancel current booking before rebooking target spot.' });
    }

    const rebookResult = await this.bookSlot(eventId, [targetSlotId], session);
    if (!rebookResult.ok) {
      // Documented race window realized: original spot is gone AND the new
      // one failed. Nothing more this adapter can do — the caller (WP-S2)
      // needs to detect this and notify the user they lost their spot.
      return makeBookingResult({ ok: false, error: `Cancelled original booking but failed to rebook target spot: ${rebookResult.error}`, raw: rebookResult.raw });
    }
    return rebookResult;
  }

  // --- Capability-gated extras (see base.js) --------------------------------

  /**
   * GET /bundles returns the by-reference envelope `{ data, relations }` like
   * /events does. The bundle_type relations carry the handles the client's
   * category filters key off, so both halves are returned.
   */
  async listBundles(session) {
    const res = await this.request('/bundles', { token: session.accessToken });
    if (!res.ok) {
      const err = new Error(`Failed to load bundles (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    return {
      bundles: data.data || [],
      bundleTypes: (data.relations && data.relations.bundle_types) || undefined,
    };
  }

  /**
   * CodexFit stores bookmarks as profile metafields under
   * `bookmarks.events.<identifier>`. The path shape is this adapter's business
   * — the client passes the identifier only.
   *
   * DELETE on a metafield answers with `content-type: application/json` and an
   * empty body, so the response is never parsed; only `res.ok` is meaningful.
   */
  async setBookmark(identifier, on, session) {
    const path = `/profile/metafields/bookmarks.events.${identifier}`;
    const res = on
      ? await this.request(path, { token: session.accessToken, method: 'PUT', body: { data: identifier } })
      : await this.request(path, { token: session.accessToken, method: 'DELETE' });
    if (!res.ok) {
      const err = new Error(`Failed to update bookmark (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return true;
  }

  async updateProfile(payload, session) {
    const res = await this.request('/account/update', { token: session.accessToken, method: 'POST', body: payload });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Failed to update profile (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

/**
 * `{ required, acceptedTypeIds }` for a raw CodexFit event, or undefined when
 * the payload says nothing about credits (so the client can tell "free" from
 * "not applicable").
 */
function creditRequirementFrom(e) {
  const hasCost = e.required_credits != null;
  const ids = CodexFitProvider.acceptedCreditTypeIds(e);
  if (!hasCost && ids.length === 0) return undefined;
  return {
    required: hasCost ? Number(e.required_credits) : 1,
    acceptedTypeIds: ids,
  };
}

module.exports = CodexFitProvider;
