// CodexFit provider adapter.
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
const { GymProvider, classifyProviderThrottle } = require('./base');
const bookingWindow = require('./booking-window');
const { resolveZone, toZonedISO } = require('./timezone');
const { studioHasRowGroups } = require('./spot-map');
const { makeMetadata, makeProfile, makeEvent, makeSlot, makeLayoutObject, makeBookingResult, makeBooking, makeHistoryEntry, prune } = require('./normalize');
const cart = require('./codexfit-cart');
const favourites = require('../favourites');
const { timedProviderFetch } = require('../logger');

// Dev-mode bypass, aligned with MarianaTek's dev@jabboxing.mock convention.
// login() must establish the sentinel session itself, since a fresh account
// linking Psycle has no existing token for request() to recognise yet.
const DEV_EMAIL = 'dev@psycle.com';

// Matches the sentinel set by auth.js's dev@psycle.com bypass (db.updateUserJWT
// with 'mock-jwt-token'). See request()'s doc comment below for why this check
// lives here now, not just in the 5 pre-Phase-3 callers.
const MOCK_TOKEN = 'mock-jwt-token';
// C2-4: widest span one UNSCOPED ranged /events call may cover. Measured live
// 2026-10-06: 7 days = 3 MB/7 s, 10 days = 4.2 MB/8 s, 14+ days = HTTP 502 (upstream
// timeout), so the planned single 42-day call does not work unscoped. 7 keeps margin.
const MAX_TIMETABLE_DAYS = 7;

// C2-6: how long a fetched /profile is reused (see CodexFitProvider._fetchProfile).
const PROFILE_MEMO_TTL_MS = 30 * 1000;

// Error with an attached HTTP `.status`, for methods (listBookings/listWaitlists)
// that throw on failure instead of returning a NormalizedBookingResult — lets a
// caller distinguish "401, worth a relogin retry" without string-parsing the message.
function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// U1-19: CodexFit's numeric ids travel as JSON numbers on the wire (what the
// website and prod `master` send). Normalized ids are strings; convert at this
// boundary only. Non-numeric input passes through unchanged.
function toWireId(v) {
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  return v;
}

// U1-19: a Laravel 422 may carry `errors` without a top-level `message`; the old
// `data.message || 'HTTP 422'` hid the actual reason.
function upstreamMessage(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.message) return data.message;
  if (typeof data.error === 'string') return data.error;
  const errs = data.errors;
  if (errs && typeof errs === 'object') {
    const first = Object.values(errs).flat()[0];
    if (first) return String(first);
  }
  return '';
}

// C2-7: `GET /profile` envelopes its payload as `{ data: {...} }` — confirmed
// live (server/fixtures/codexfit-v2/PARITY.md G1/profile-v1-response.json) and
// matching the same by-reference convention `/events` uses (AGENTS.md's
// "GET /events returns events BY REFERENCE" note). getProfile/getEligibility/
// getCredits each called `this.request('/profile', ...)` and read fields
// straight off the top-level JSON body, so every field (available_credits,
// booking_cutoff, id, ...) was silently `undefined` against the real gym —
// invisible against server/mock.js's dev fixture, which returned the profile
// bare. Accepts EITHER shape so a future upstream envelope flip can't silently
// zero credits again the same way: only unwraps `.data` when it looks like the
// real profile object (has an `id`), never when the body is already bare.
function unwrapProfileEnvelope(body) {
  if (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data) && body.data.id != null) {
    return body.data;
  }
  return body || {};
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
  constructor(gymConfig) {
    super(gymConfig);
    // C2-6: per-adapter (= per-gym) /profile memo state; see _fetchProfile.
    this._profileMemo = new Map();     // gym|token -> { value, expires }
    this._profileInflight = new Map(); // gym|token -> Promise
    this._profileGen = new Map();      // gym|token -> write generation
  }

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

  // Same as url(), but resolves against the v2 cart/checkout base
  // (`/api/customer/v2`, a genuinely different path than the v1 base above —
  // see gyms.config.js's `v2ApiBaseUrl` comment). Used only by
  // providers/codexfit-cart.js (C2-1).
  url2(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return this.gym.v2ApiBaseUrl + pathOrUrl;
  }

  // Strip whichever CodexFit API base (v1 or v2) a full URL carries → the
  // customer path (for mock routing).
  toPath(pathOrUrl) {
    return pathOrUrl.replace(this.gym.apiBaseUrl, '').replace(this.gym.v2ApiBaseUrl, '');
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
  async request(pathOrUrl, opts = {}) {
    return this._doFetch(this.url.bind(this), pathOrUrl, opts);
  }

  /**
   * Same contract as request(), but resolves against the v2 cart/checkout
   * base (url2()) instead of the v1 customer base. Added for C2-1 — the v2
   * cart lifecycle (init/add-line/mutate/checkout/finalise) lives at
   * `/api/customer/v2`, a different host path than everything else this
   * adapter calls. See providers/codexfit-cart.js, the only caller.
   */
  async requestV2(pathOrUrl, opts = {}) {
    return this._doFetch(this.url2.bind(this), pathOrUrl, opts);
  }

  async _doFetch(urlFn, pathOrUrl, { token, method = 'GET', body, headers } = {}) {
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
    return timedProviderFetch(this.gym.id, method, pathOrUrl, () => fetch(urlFn(pathOrUrl), opts));
  }

  /**
   * Public (no Bearer) fetch — events/locations/studios/etc. No mock check
   * here: dev-mode reads always go through request() with the mock token once
   * logged in (fetchTimetable/fetchEventDetails prefer request() whenever a
   * session is available — same convention as the MarianaTek adapter).
   */
  async publicRequest(pathOrUrl, { method = 'GET' } = {}) {
    return timedProviderFetch(this.gym.id, method, pathOrUrl, () => fetch(this.url(pathOrUrl), { method, headers: this.buildHeaders(null, false) }));
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
      // C3-11: name the gym that actually rejected the credential — a
      // multi-gym account linking a second gym needs to know WHICH one just
      // failed ("JAB rejected your password"), not a gym-less "Invalid
      // credentials" that reads as if the whole app is broken.
      const gymName = (this.gym && this.gym.shortName) || 'The gym';
      const reason = errorData.message || `login failed with status ${res.status}`;
      throw new Error(`${gymName} rejected your login: ${reason}`);
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

  // --- C2-6: single-flight + short memo for GET /profile ---------------------
  //
  // getProfile/getEligibility/getCredits all read the same document, so one
  // page load or one scheduler/poller pass fetched it 3 times and N concurrent
  // readers fetched it N times. The memo is keyed by GYM + the session's access
  // token (the user identity this adapter sees), so it can never hand one
  // member's credits to another. Only SUCCESSFUL bodies are kept (a 429 or 401
  // must not be replayed for 30 s); concurrent callers share one in-flight
  // promise, which is dropped on failure. A generation counter makes a write
  // that lands mid-flight win: the stale result still resolves to its own
  // callers but is not stored.
  _profileKey(session) {
    return `${this.gym.id}|${session.accessToken}`;
  }

  /** Drop this user's memoised /profile. Call after any write that changes credits or profile. */
  invalidateProfile(session) {
    if (!session || !session.accessToken) return;
    const key = this._profileKey(session);
    this._profileGen.set(key, (this._profileGen.get(key) || 0) + 1);
    this._profileMemo.delete(key);
    this._profileInflight.delete(key);
  }

  /** @returns {Promise<Object>} the unwrapped raw profile; rejects with `.status` on a non-2xx. */
  _fetchProfile(session) {
    const key = this._profileKey(session);
    const hit = this._profileMemo.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    const pending = this._profileInflight.get(key);
    if (pending) return pending;

    const gen = this._profileGen.get(key) || 0;
    const p = (async () => {
      const res = await this.request('/profile', { token: session.accessToken });
      if (!res.ok) throw httpError(`profile fetch failed: ${res.status}`, res.status);
      const value = unwrapProfileEnvelope(await res.json());
      if ((this._profileGen.get(key) || 0) === gen) {
        this._profileMemo.set(key, { value, expires: Date.now() + PROFILE_MEMO_TTL_MS });
        // Bound the map: drop expired entries opportunistically.
        if (this._profileMemo.size > 500) {
          const now = Date.now();
          for (const [k, v] of this._profileMemo) if (v.expires <= now) this._profileMemo.delete(k);
        }
      }
      return value;
    })();
    this._profileInflight.set(key, p);
    const clear = () => { if (this._profileInflight.get(key) === p) this._profileInflight.delete(key); };
    p.then(clear, clear);
    return p;
  }

  /** _fetchProfile with the caller's own error label (status preserved). */
  async _profileFor(session, label) {
    try {
      return await this._fetchProfile(session);
    } catch (e) {
      if (e && e.status != null) throw httpError(`${label} failed: ${e.status}`, e.status);
      throw e;
    }
  }

  /** GET /profile → normalized profile. Used by scheduler/poller/calendar in Phase 3. */
  async getProfile(session) {
    const u = await this._profileFor(session, 'getProfile');
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
    const u = await this._profileFor(session, 'getEligibility');
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
    const u = await this._profileFor(session, 'getCredits');
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
    // C2-4: ranged v2 `/events` calls (unscoped: all locations) instead of
    // `/locations` + one call per location. `filter[between]=a,b` (end exclusive
    // for date-only values), unpaginated `{data, relations}` (G4). The G4 "no cap
    // up to 56 days" finding was LOCATION-SCOPED; unscoped it 502s from ~14 days
    // (see MAX_TIMETABLE_DAYS), so the window is chunked into <=7-day calls.
    const fetcher = session
      ? (path) => this.requestV2(path, { token: session.accessToken })
      : (path) => this.requestV2(path);

    const startDate = params.startDate
      ? DateTime.fromISO(params.startDate, { zone: this.gym.timezone })
      : DateTime.now().setZone(this.gym.timezone);
    const endDate = params.endDate
      ? DateTime.fromISO(params.endDate, { zone: this.gym.timezone })
      : startDate.plus({ weeks: 4 });
    const first = startDate.startOf('day');
    const endExclusive = endDate.startOf('day').plus({ days: 1 });

    const ranges = [];
    for (let cur = first; cur < endExclusive; cur = cur.plus({ days: MAX_TIMETABLE_DAYS })) {
      const next = DateTime.min(cur.plus({ days: MAX_TIMETABLE_DAYS }), endExclusive);
      ranges.push([cur.toFormat('yyyy-MM-dd'), next.toFormat('yyyy-MM-dd')]);
    }

    // Best-effort per chunk; if every chunk fails, surface the failure rather than an empty timetable.
    const results = await Promise.allSettled(ranges.map(([a, b]) =>
      fetcher(`/events?filter[between]=${a},${b}&sort=start_at`).then((res) => {
        if (!res.ok) throw httpError(`fetchTimetable /events failed: ${res.status}`, res.status);
        return res.json();
      })));
    if (results.length && results.every((r) => r.status === 'rejected')) throw results[0].reason;

    const seen = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const list = Array.isArray(r.value) ? r.value : (r.value.data || []);
      // `GET /events` returns events BY REFERENCE (event_type_id/instructor_id/
      // studio_id) plus a SIBLING `relations` bag; resolve within each response
      // (AGENTS.md "GET /events returns events BY REFERENCE"). Skipping this
      // caused the 2026-08-31 "CLASS" regression.
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
      gymId: this.gymId,
      locations: locations.map((l) => ({ id: l.id, name: l.name, address: l.address, timeZone: resolveZone(this.gym, { locationId: l.id }), raw: l })),
      studios: studios.map((st) => ({
        id: st.id,
        name: st.name,
        locationId: st.location_id || (st.location && st.location.id),
        locationName: st.location && st.location.name,
        hasLayout: !!(st.layout && Array.isArray(st.layout.slots) && st.layout.slots.length),
        rowGroups: studioHasRowGroups(this.gym, st),
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

  // C2-5 (rebuilt): CodexFit's public `GET /api/v1/customer/heartbeat` (the official website polls
  // it) returns `{ data: { <resource>: ISO, ..., "logged-in": false } }`. Each stamp moves when
  // that resource is created/edited. The `events` stamp does NOT move on seat-count changes
  // (measured 2026-10-06), so occupancy can lag; that is accepted (same as the website).
  hasFreshnessStamps() { return true; }

  async getFreshnessStamps(session) {
    const res = (session && session.accessToken === MOCK_TOKEN)
      ? await this.request('/heartbeat', { token: session.accessToken })
      : await this.publicRequest('/heartbeat');
    if (!res.ok) throw httpError(`heartbeat failed: ${res.status}`, res.status);
    const body = await res.json();
    const data = (body && body.data) || {};
    const out = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === 'string') out[k] = v;
    return out;
  }

  // Public list lookup, not a client-supplied URL: this is the SSRF boundary
  // for F-15. CodexFit exposes the complete instructor collection publicly.
  async findInstructorPhoto(instructorId) {
    const res = await this.publicRequest('/instructors');
    if (res.ok) {
      const body = await res.json();
      const instructors = Array.isArray(body) ? body : (body.data || []);
      const match = instructors.find((i) => String(i.id) === String(instructorId));
      if (match && match.photo) return { imageUrl: match.photo, thumbUrl: match.photo };
    }
    // Co-teach records (e.g. "Brittney Tam & Geoff") are absent from /instructors;
    // fall back to the photo last seen on an event's own instructor.
    const seen = this._eventPhotos && this._eventPhotos.get(String(instructorId));
    return seen ? { imageUrl: seen, thumbUrl: seen } : null;
  }

  _rememberInstructorPhoto(i) {
    if (!i || !i.photo || i.id == null) return;
    (this._eventPhotos = this._eventPhotos || new Map()).set(String(i.id), i.photo);
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
    const locId = e.location_id || (e.studio && e.studio.location_id) || (e.studio && e.studio.location && e.studio.location.id);
    // CodexFit publishes NO zone: it comes from gym config only.
    const timeZone = resolveZone(this.gym, { locationId: locId });
    return makeEvent({
      id: e.id,
      gymId: this.gymId,
      timeZone,
      // GET /events list items carry a top-level `name`; GET /events/{id}'s
      // `data` object does not (confirmed via live capture) — fall back to the
      // resolved event_type's own name, which is what the real site displays.
      name: e.name || (e.event_type && e.event_type.name) || '',
      discipline: e.event_type && e.event_type.group && e.event_type.group.name,
      startAt: toZonedISO(e.start_at, timeZone),
      // CodexFit's start_at is a timezone-naive local London string (no offset
      // suffix) — must resolve via Luxon in the GYM's zone, never bare Date
      // arithmetic (AGENTS.md rule 7). A bare `new Date(e.start_at)` parses it
      // as the RUNNING MACHINE's local zone, which is wrong on any server not
      // itself in that zone and silently drifts across DST transitions.
      durationMin: e.duration,
      endAt: e.start_at && e.duration ? DateTime.fromISO(e.start_at, { zone: timeZone }).plus({ minutes: e.duration }).toISO() : undefined,
      locationId: e.location_id || (e.studio && e.studio.location_id) || (e.studio && e.studio.location && e.studio.location.id),
      locationName: e.studio && e.studio.location && e.studio.location.name,
      locationAddress: e.studio && e.studio.location && e.studio.location.address,
      studioId: e.studio_id || (e.studio && e.studio.id),
      studioName: e.studio && e.studio.name,
      // `photo` rides on the event's own relations instructor. GET /instructors is
      // incomplete (paged at 100 of 113; co-teach records such as
      // "Brittney Tam & Geoff", id 576, are absent), so the metadata name lookup
      // cannot be the only photo source.
      instructors: e.instructor ? [{
        id: (this._rememberInstructorPhoto(e.instructor), e.instructor.id),
        name: e.instructor.full_name || e.instructor.name,
        imageUrl: e.instructor.photo || undefined,
        thumbUrl: e.instructor.photo || undefined,
      }] : [],
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
    if (slotIds && slotIds.length > 0) return this._postBooking(eventId, slotIds[0], session);

    // U1-19: a class in a studio with NO seat map (Psycle Barre, Yoga, Infrared
    // Sculpt) arrives here with no slot, because the app has no map to pick from.
    // CodexFit still books by slot: prod `master` always POSTed one, taken from
    // GET /events/{id}'s top-level `slots` (the available slot ids, present even
    // when the studio has no layout — checked live 2026-09-29, event 216718:
    // slots [1,4,8,9,10,14,19], layout slots 0). A POST with no `slots` is the
    // "HTTP 422" the member hit on those classes. Resolve the slot here so the
    // normalized contract ("no slot = provider assigns") holds for this gym.
    let available = [];
    try {
      const res = await this.request(`/events/${eventId}`, { token: session.accessToken });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        available = ((d.slots || (d.data && d.data.slots)) || []).slice();
      }
    } catch (_) { /* fall through: treated as no availability info */ }
    if (available.length === 0) {
      return makeBookingResult({ ok: false, status: 409, error: 'This class is fully booked (no available spots).' });
    }
    // A couple of candidates, in case another member takes the first between
    // our read and our write. Never retry a throttle.
    let last;
    for (const slot of available.slice(0, 3)) {
      last = await this._postBooking(eventId, slot, session);
      if (last.ok || last.code === 'PROVIDER_RATE_LIMITED') return last;
    }
    return last;
  }

  async _postBooking(eventId, wantedSlot, session) {
    const slotIds = [wantedSlot];
    // U1-19: the wire shape is the one prod (`master`) has always sent: NUMERIC
    // event_id and slot ids. Normalized ids are strings everywhere above this
    // adapter (C1-3), and this is the boundary that converts them back.
    const body = { event_id: toWireId(eventId), slots: [toWireId(wantedSlot)] };
    let res;
    try {
      res = await this.request('/bookings', { token: session.accessToken, method: 'POST', body });
    } finally {
      this.invalidateProfile(session); // C2-6: a booking spends credits
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      // U1-19: a failed booking used to leave NO trace server-side, so a live
      // "HTTP 422" could not be diagnosed after the fact. Log the sanitized
      // request shape (types, never tokens) and the upstream reply.
      console.warn(`[CodexFit] POST /bookings -> ${res.status} req=${JSON.stringify(body)} (${typeof body.event_id}/${(body.slots || []).map((x) => typeof x).join(',')}) resp=${JSON.stringify(data).slice(0, 400)}`);
      // C2-3: classify a 429/throttle-shaped 403 into the normalized
      // PROVIDER_RATE_LIMITED code so scheduler.js can back off this gym's
      // queue instead of hammering a provider that's already refusing. See
      // classifyProviderThrottle's doc comment (base.js) for the 403 rule.
      const throttle = classifyProviderThrottle(res, data);
      return makeBookingResult({
        ok: false,
        status: res.status,
        error: upstreamMessage(data) || `HTTP ${res.status}`,
        code: throttle.limited ? 'PROVIDER_RATE_LIMITED' : undefined,
        retryAfterMs: throttle.limited ? throttle.retryAfterMs : undefined,
        raw: data,
      });
    }
    // Response shape: { success: true, bookings: { bookingId: slotId } } — see
    // AGENTS.md "Booking response shape" gotcha.
    const bookingsMap = data.bookings || {};
    const bookingId = Object.keys(bookingsMap)[0];
    const slotId = bookingId ? bookingsMap[bookingId] : (slotIds && slotIds[0]);
    return makeBookingResult({ ok: true, bookingId, slotId, raw: data });
  }

  async cancelBooking(bookingId, session) {
    let res;
    try {
      res = await this.request(`/bookings/${bookingId}`, { token: session.accessToken, method: 'DELETE' });
    } finally {
      this.invalidateProfile(session); // C2-6: a cancel refunds credits
    }
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

  /**
   * DELETE /waitlists/{waitlistRowId} — NOT /waitlists/{eventId} (C2-2, fixed
   * 2026-09-26).
   *
   * Root cause / evidence: a live capture (server/fixtures/codexfit-v2/
   * waitlist-v1-join-leave.json, PARITY.md G2) showed joining event 217095
   * returns `waitlist.id: 300480`, and the real site's leave call was
   * `DELETE /waitlists/300480` — never `DELETE /waitlists/217095`. This
   * method used to `DELETE /waitlists/${eventId}` directly, which targets the
   * wrong id: an event can be waitlisted by many customers, each with their
   * own row id, and CodexFit's leave verb only ever accepts that row id.
   * Always penalty-free per psycle_codexfit.md.
   *
   * To honor the shared eventId-based interface (base.js) — MarianaTek's
   * leaveWaitlist has the identical constraint, see its doc comment just
   * above this one in providers/marianatek.js — this looks up the user's own
   * waitlist row for the event via listWaitlists(), then deletes by that
   * row's id. One extra read per leave; CodexFit has no "find my waitlist
   * entry for event X" endpoint, the same limitation getCancelPenalty already
   * works around for bookings (see its doc comment above).
   */
  async leaveWaitlist(eventId, session) {
    const entries = await this.listWaitlists(session);
    const entry = entries.find((w) => String(w.eventId) === String(eventId));
    if (!entry) return false;
    const res = await this.request(`/waitlists/${entry.bookingId}`, { token: session.accessToken, method: 'DELETE' });
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
   * F-10-0: the member's PAST bookings, paginated fully.
   *
   * Q5 MEASURED LIVE 2026-10-05 (read-only GETs, one real account):
   *  - Endpoint is the v2 base, NOT v1: `GET {v2ApiBaseUrl}/bookings?filter[type]=past
   *    &page[size]=N&page[number]=P` (v1's `limit`/`page` is the upcoming list's style).
   *  - Page size: 9, 100 work; 500 -> Cloudflare 504. We use 100.
   *  - Envelope: `{data, links, meta, message, relations:{events, instructors,
   *    event_types, studios, locations}}`; `meta` = {current_page, last_page, per_page,
   *    total, from, to, path, links[]}. `links.next` and `meta.links[]` repeat
   *    `page[number]` twice (page 1 then the real one), so DO NOT follow them: count
   *    pages from `meta.last_page`.
   *  - Depth: complete, back to the member's first class (2016 on the measured account).
   *    857 rows = profile `total_bookings` (858) minus 1 upcoming; 798 distinct events =
   *    `total_unique_bookings` (799) minus the upcoming one. Past rows are ALL events with
   *    `status: "finished"`.
   *  - Statuses: the past list carries NO cancelled rows (`cancelled_at` null on all 857)
   *    and no attended/no-show flag (booking keys: id, event_id, slot, booked_at,
   *    cancelled_at, credits_used, subscription_used, ...). Profile says 770 of 798
   *    events were attended, so ~28 are no-shows we cannot tell apart => every row is
   *    'unconfirmed'. Several rows can share an event (multi-slot or guest bookings:
   *    57 events), so aggregates count DISTINCT events (class-history.js).
   */
  async listBookingHistory(session, { sinceDate } = {}) {
    const PAGE_SIZE = 100;
    const sinceMs = sinceDate ? Date.parse(sinceDate) : null;
    const nowMs = Date.now();
    const out = [];
    const MAX_PAGES = 60;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.requestV2(`/bookings?filter[type]=past&page[size]=${PAGE_SIZE}&page[number]=${page}`, { token: session.accessToken });
      if (!res.ok) throw httpError(`listBookingHistory failed: ${res.status}`, res.status);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.data || []);
      const relations = (!Array.isArray(data) && data.relations) || {};
      const eventsById = new Map((relations.events || []).map((e) => [String(e.id), e]));
      for (const b of list) {
        const eventId = b.event_id || (b.event && b.event.id);
        const rawEvent = b.event || eventsById.get(String(eventId));
        if (!rawEvent) continue; // no start time => cannot place it in history
        const event = this.mapEventToNormalized(b.event ? rawEvent : this.resolveEventRelations(rawEvent, relations));
        const startMs = Date.parse(event.startAt);
        if (!Number.isFinite(startMs) || startMs >= nowMs) continue; // upcoming
        if (sinceMs != null && startMs < sinceMs) continue;
        // cancelled_at has never been seen set on the past list; kept defensively.
        const status = b.cancelled_at ? 'cancelled' : 'unconfirmed';
        out.push(makeHistoryEntry({ bookingId: b.id, eventId, status, event, raw: b }));
      }
      const lastPage = data && data.meta && data.meta.last_page;
      if (!list.length || page >= (lastPage || 1)) break;
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : 250)); // playbook s4 pacing
    }
    return out;
  }

  /**
   * `GET {v2}/milestones` (live-captured 2026-10-05):
   * `{overview:{this_week,this_month,this_year}, kinds:[{kind, kind_label, current_count,
   * milestones:[{id, slug, name, description, threshold, window_days, bundle_handle,
   * reward_summary, badge_label, card_width, color, current_count, earned, reached_at}]}]}`.
   * `kinds[attended_events].current_count` is the OFFICIAL attended total (770 vs 857
   * past booking rows / 798 distinct events on the measured account: it excludes
   * no-shows, which the bookings list cannot distinguish).
   */
  async getMilestones(session) {
    const res = await this.requestV2('/milestones', { token: session.accessToken });
    if (!res.ok) throw httpError(`getMilestones failed: ${res.status}`, res.status);
    const data = await res.json();
    const kind = (data.kinds || []).find((k) => k.kind === 'attended_events') || {};
    const ov = data.overview || {};
    return {
      attendedTotal: Number(kind.current_count) || 0,
      thisWeek: ov.this_week, thisMonth: ov.this_month, thisYear: ov.this_year,
      milestones: (kind.milestones || []).map((m) => prune({
        id: String(m.id), slug: m.slug, name: String(m.name || '').trim(), description: m.description,
        threshold: Number(m.threshold), earned: !!m.earned, reachedAt: m.reached_at || undefined,
        rewardSummary: m.reward_summary || undefined,
      })),
    };
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

  // --- v2 cart & checkout (C2-1, 2026-09-26) --------------------------------
  //
  // Protocol lives in providers/codexfit-cart.js (see its own header for the
  // fixture/doc sourcing and what's UNVERIFIED live). These methods are just
  // the session-token plumbing so the route layer (server/routes-normalized.js)
  // never needs to know a token exists, matching every other method here.

  async initCart(session) {
    return cart.initCart(this, session.accessToken);
  }

  async getCart(cartUuid, session) {
    return cart.getCart(this, session.accessToken, cartUuid);
  }

  /**
   * Adds `bundleId` to the cart `quantity` times. Add-line itself takes no
   * quantity (confirmed live, PARITY.md G3), so this adds once and then
   * increments (quantity - 1) times via the mutate-quantity endpoint —
   * cheaper and more obviously correct than calling add-line in a loop, which
   * risks creating `quantity` separate lines instead of one line at that
   * quantity (never observed either way live — this is the documented
   * increment verb, so it's the safer assumption).
   */
  async addBundleToCart(cartUuid, bundleId, quantity, session) {
    let line = await cart.addLine(this, session.accessToken, cartUuid, bundleId);
    for (let i = 1; i < quantity; i++) {
      line = await cart.mutateLineQuantity(this, session.accessToken, cartUuid, line.hash, 'increment');
    }
    return line;
  }

  async removeCartLine(cartUuid, hash, session) {
    return cart.removeLine(this, session.accessToken, cartUuid, hash);
  }

  // UNVERIFIED against live Psycle — see codexfit-cart.js header.
  async listCartPaymentMethods(session) {
    return cart.listPaymentMethods(this, session.accessToken);
  }

  // UNVERIFIED against live Psycle — see codexfit-cart.js header.
  async attachCartPaymentMethod(cartUuid, paymentMethodId, session) {
    return cart.attachPaymentMethod(this, session.accessToken, cartUuid, paymentMethodId);
  }

  // UNVERIFIED against live Psycle — see codexfit-cart.js header.
  async finaliseCart(cartUuid, analytics, session) {
    await cart.beginCheckout(this, session.accessToken, cartUuid);
    let result;
    try {
      result = await cart.finaliseCart(this, session.accessToken, cartUuid, analytics);
    } finally {
      this.invalidateProfile(session); // C2-6: an order adds credits
    }
    return { orderId: cart.extractOrderId(result), raw: result };
  }

  /**
   * Poll an order until Stripe settles it. Unchanged by the v1→v2 cart
   * migration — the v2 doc (psycle_codexfit.md §2.5.3 #4) describes polling
   * "the status endpoint" without naming one, and `/orders/{id}` is the only
   * order-status read this API has ever had (used identically by the old v1
   * checkout flow this replaces). UNVERIFIED that finalise actually hands back
   * an order this shape resolves — see codexfit-cart.js header.
   */
  async getOrder(orderId, session) {
    const res = await this.request(`/orders/${orderId}`, { token: session.accessToken, method: 'GET' });
    // C2-6: credits land when the order settles, which is observed here — not
    // at finalise time — so a memoised /profile is stale from this point on.
    this.invalidateProfile(session);
    const data = await res.json().catch(() => ({}));
    return data.data || data;
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
    // The bookmark list lives on the profile; a memoised /profile would serve the
    // old list for up to 30 s (C2-6), so a heart would flip back on the next read.
    this.invalidateProfile(session);
    return true;
  }

  /** F-12: native favourites = the profile's bookmark keys, parsed back into slots. */
  async listFavourites(session) {
    const u = await this._profileFor(session, 'listFavourites');
    const keys = (u && u.metafields && u.metafields.public && u.metafields.public.bookmarks
      && u.metafields.public.bookmarks.events) || [];
    return (Array.isArray(keys) ? keys : []).map((k) => favourites.parseIdentifier(String(k))).filter(Boolean);
  }

  async setFavourite(slot, on, session) {
    return this.setBookmark(favourites.toIdentifier(slot), on, session);
  }

  async updateProfile(payload, session) {
    let res;
    try {
      res = await this.request('/account/update', { token: session.accessToken, method: 'POST', body: payload });
    } finally {
      this.invalidateProfile(session); // C2-6: the profile itself changed
    }
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
