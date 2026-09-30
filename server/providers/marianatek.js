// Sweat Assistant — MarianaTek provider adapter.
//
// Auth (WP-M1) implements the confirmed headless OAuth2 + PKCE flow documented
// in Documentation/Services/marianatek.md §1B/§1G (live-tested against the JAB
// Boxing test account). Unlike CodexFit's one-shot POST /auth/login, this is a
// 4-step, stateful flow: an unauthenticated MT client has no session cookie, so
// steps 2-3 must carry cookies (csrftoken, sessionid) across requests exactly
// like a browser would — Node's fetch does not do this automatically.
//
// See server/providers/base.js for the GymProvider contract and normalized
// shapes, and PLAN.md §4 Phase 4 for the full work-package breakdown (M1-M5).

const crypto = require('crypto');
const { GymProvider } = require('./base');
const { makeMetadata, makeProfile, makeMembership, makeEvent, makeSlot, makeBookingResult, makeBooking } = require('./normalize');
const bookingWindow = require('./booking-window');

// Dev-mode bypass (WP-M5), mirroring the dev@psycle.com / 'mock-jwt-token'
// convention already used for CodexFit (see server/auth.js, server/mock.js).
// login() short-circuits the real OAuth flow for this email; every other
// method checks for MOCK_TOKEN and routes to mock-marianatek.js instead of a
// live fetch — lets the full success path (book/cancel/waitlist/swap) be
// exercised with no real credits, which the live JAB test account can't do.
const MOCK_TOKEN = 'mock-mt-token';

// --- Minimal cookie jar -----------------------------------------------------
// MT's login flow is 2-3 requests deep and needs cookie continuity (a live
// trace shows a single csrftoken cookie set on the login-page GET, carried
// through the POST). Deliberately not a general-purpose jar (no path/domain/
// expiry handling) — just enough for the handful of same-host requests here.
class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> value
  }
  absorb(response) {
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// Scrape Django's rendered `<input type="hidden" name="csrfmiddlewaretoken" value="...">`
// out of the login page HTML. There's no HTML parser dependency in this codebase
// (matches the existing "no bundler for admin.html" convention) — a targeted
// regex is sufficient for one known, stable field.
function extractCsrfToken(html) {
  const m = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  if (!m) throw new Error('Could not find csrfmiddlewaretoken in the MarianaTek login page HTML — page structure may have changed.');
  return m[1];
}

class MarianaTekProvider extends GymProvider {
  url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return this.gym.apiBaseUrl + path;
  }

  buildHeaders(token) {
    const headers = { accept: 'application/json', ...this.gym.headers };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  // Just the client-fidelity subset (user-agent/accept-language) of gym.headers,
  // safe to merge into the OAuth login-flow's own fetch calls without clobbering
  // deliberate values those calls already set (referer=loginPageUrl, cookie,
  // content-type). See LIVE_VERIFICATION_PLAYBOOK.md §3 — real capture-derived,
  // applied everywhere a real browser session would send them, not just on the
  // customer-API calls buildHeaders() already covers.
  browserHeaders() {
    const h = this.gym.headers || {};
    const out = {};
    if (h['user-agent']) out['user-agent'] = h['user-agent'];
    if (h['accept-language']) out['accept-language'] = h['accept-language'];
    return out;
  }

  async request(path, { token, method = 'GET', body } = {}) {
    if (token === MOCK_TOKEN) {
      const { handleMockRequest } = require('../mock-marianatek');
      return handleMockRequest(path, method, body);
    }
    const opts = { method, headers: this.buildHeaders(token) };
    if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      opts.headers['content-type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(this.url(path), opts);
  }

  // Public (no-auth) reads — /classes, /locations, etc. per §1C. No mock check
  // here: dev-mode browsing always goes through request() with the mock token
  // once logged in (see fetchTimetable/fetchEventDetails, which prefer
  // request() whenever a session is available).
  async publicRequest(path, { method = 'GET' } = {}) {
    return fetch(this.url(path), { method, headers: this.buildHeaders(null) });
  }

  isPublicRead(method, path) {
    return method === 'GET' && /^\/(classes|locations|regions|config|theme|countries|legal)(\/|$|\?)/.test(path);
  }

  // --- Authentication (WP-M1) ------------------------------------------------

  generatePkce() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * The confirmed 4-step headless OAuth (PKCE) flow — see marianatek.md §1B.
   * @param {{email: string, password: string}} credentials
   * @returns {Promise<{session: import('./base').AuthSession, profile: import('./base').NormalizedProfile, raw: Object}>}
   */
  async login({ email, password }) {
    if (email === (this.gym.mockEmail || `dev@${this.gym.tenant}.mock`)) {
      const session = { accessToken: MOCK_TOKEN, refreshToken: MOCK_TOKEN, expiresAt: new Date(Date.now() + 365 * 864e5).toISOString() };
      const profile = await this.getProfile(session);
      return { session, profile, raw: { access_token: MOCK_TOKEN, mock: true } };
    }

    const jar = new CookieJar();
    const { codeVerifier, codeChallenge } = this.generatePkce();

    // Step 1: GET /o/authorize/ -> redirects to the login page.
    const authorizeUrl = new URL(`${this.gym.oauthBaseUrl}/authorize/`);
    authorizeUrl.searchParams.set('client_id', this.gym.clientId);
    authorizeUrl.searchParams.set('scope', this.gym.scope);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', this.gym.redirectUri);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    let res = await fetch(authorizeUrl.toString(), { redirect: 'manual', headers: this.browserHeaders() });
    jar.absorb(res);
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) {
      throw new Error(`MarianaTek login step 1 (authorize) failed: expected a redirect, got ${res.status}`);
    }
    let loginPageUrl = new URL(res.headers.get('location'), authorizeUrl).toString();
    // The post-login redirect target comes back as a `next` query param on the
    // login page URL itself (not a hidden form field — confirmed live: the form
    // has no `next` input on this tenant). Extract it from the URL, not the HTML.
    const nextField = new URL(loginPageUrl).searchParams.get('next');

    // Step 2: GET the login page -> scrape CSRF token, absorb csrftoken/sessionid cookies.
    res = await fetch(loginPageUrl, { headers: { cookie: jar.header(), ...this.browserHeaders() } });
    jar.absorb(res);
    if (!res.ok) throw new Error(`MarianaTek login step 2 (login page) failed: ${res.status}`);
    const loginPageHtml = await res.text();
    const csrfToken = extractCsrfToken(loginPageHtml);

    // Step 3: POST credentials -> follow the redirect chain manually
    // (login page -> /o/authorize/ -> redirect_uri?code=...) since the final
    // redirect_uri (marianaiframes.com/iframe/callback/) is a client-side page
    // we don't need to actually fetch — we just need the `code` off its URL.
    const loginBody = new URLSearchParams({
      csrfmiddlewaretoken: csrfToken,
      username: email,
      password,
      next: nextField || '',
    });
    let currentUrl = loginPageUrl;
    let response = await fetch(loginPageUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
        referer: loginPageUrl,
        ...this.browserHeaders(),
      },
      body: loginBody.toString(),
    });
    jar.absorb(response);

    let authCode = null;
    let hops = 0;
    while (response.status >= 300 && response.status < 400 && hops < 5) {
      const location = response.headers.get('location');
      if (!location) break;
      const nextUrl = new URL(location, currentUrl);
      const codeParam = nextUrl.searchParams.get('code');
      if (codeParam) { authCode = codeParam; break; }
      currentUrl = nextUrl.toString();
      response = await fetch(currentUrl, { redirect: 'manual', headers: { cookie: jar.header(), ...this.browserHeaders() } });
      jar.absorb(response);
      hops += 1;
    }

    if (!authCode) {
      // A login failure typically re-renders the login page (200, with an error
      // message) rather than redirecting — surface that distinction.
      // C3-11: name the GYM, not the platform — "MarianaTek" means nothing to
      // a member of a specific gym, and WP-D7 already forbids treating the
      // platform as if it were one gym's identity.
      const gymName = (this.gym && this.gym.shortName) || 'The gym';
      if (response.status === 200) {
        throw new Error(`${gymName} rejected your login: incorrect email/password (login page re-rendered instead of redirecting).`);
      }
      throw new Error(`${gymName} login failed: could not obtain an authorization code (last status ${response.status}).`);
    }

    // Step 4: exchange the code for tokens.
    const tokenRes = await fetch(`${this.gym.oauthBaseUrl}/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...this.browserHeaders() },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: this.gym.clientId,
        redirect_uri: this.gym.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const errData = await tokenRes.json().catch(() => ({}));
      throw new Error(`MarianaTek token exchange failed: ${errData.error || tokenRes.status}`);
    }
    const tokenData = await tokenRes.json(); // { access_token, expires_in, token_type, scope, refresh_token }

    const session = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: new Date(Date.now() + (tokenData.expires_in || 604800) * 1000).toISOString(),
    };

    const profile = await this.getProfile(session);
    return { session, profile, raw: tokenData };
  }

  async validateSession(session) {
    return !!(session && session.accessToken);
  }

  /**
   * Credential ladder step 2: exchange the refresh token for a new access
   * token. Per marianatek.md §1G, an invalid/dead refresh token fails with
   * `400 {"error": "invalid_grant"}` — callers should catch that and fall back
   * to a full login() with stored credentials (ladder step 3).
   */
  // Implements the full contract ladder (base.js): refresh token first, then
  // re-login with stored credentials. MarianaTek is the platform that HAS refresh
  // tokens, so rung one is real here — but rung two still has to exist, or a
  // revoked/expired refresh token becomes an unrecoverable lockout even though we
  // hold working credentials. Callers must not branch on which rung ran; that is
  // the whole point of the adapter owning this.
  async refreshSession(session, credentials) {
    if (session && session.accessToken === MOCK_TOKEN) {
      return { accessToken: MOCK_TOKEN, refreshToken: MOCK_TOKEN, expiresAt: new Date(Date.now() + 365 * 864e5).toISOString() };
    }
    if (!session || !session.refreshToken) {
      if (credentials && credentials.email && credentials.password) {
        const { session: fresh } = await this.login(credentials);
        return fresh;
      }
      throw new Error('No refresh token and no stored credentials — MarianaTek needs a re-link.');
    }
    const res = await fetch(`${this.gym.oauthBaseUrl}/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...this.browserHeaders() },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: this.gym.clientId,
      }).toString(),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const why = errData.error || res.status;
      // A refresh token that EXISTS but is rejected (revoked, expired, or
      // invalidated by a password change at the gym) is the commoner failure —
      // commoner than having no token at all — so it descends the same ladder
      // rather than surfacing as an unrecoverable error while we hold working
      // credentials.
      if (credentials && credentials.email && credentials.password) {
        console.log(`[MarianaTek] Refresh rejected (${why}); falling back to a full re-login.`);
        const { session: fresh } = await this.login(credentials);
        return fresh;
      }
      throw new Error(`MarianaTek refresh failed: ${why}`);
    }
    const data = await res.json();
    return {
      accessToken: data.access_token,
      // Confirmed not rotated (§1B/§1G) but fall back to the old one defensively
      // in case a future MT change starts rotating it.
      refreshToken: data.refresh_token || session.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in || 604800) * 1000).toISOString(),
    };
  }

  /** GET /me/account -> normalized profile. */
  async getProfile(session) {
    const res = await this.request('/me/account', { token: session.accessToken });
    if (!res.ok) throw new Error(`getProfile failed: ${res.status}`);
    const a = await res.json();
    return makeProfile({
      id: a.id,
      email: a.email,
      firstName: a.first_name,
      lastName: a.last_name,
      // bookingCutoff/extendedCutoff are intentionally left unset — those are
      // CodexFit account-level booking-window concepts (§1H: MT resolves this
      // per-class via booking_start_datetime instead, no account-level cutoff
      // exists to report here).
      raw: a,
    });
  }

  // --- Credits & memberships (WP-M4) ------------------------------------------
  // MT-specific extension methods, not part of the shared GymProvider interface
  // — unlike CodexFit (which embeds available_credits directly in /profile),
  // MT exposes these as separate endpoints with no natural home in the shared
  // NormalizedProfile shape. Return raw MT shapes; a future UI-facing caller
  // decides how to render them (mirrors how gyms.config.js's `capabilities`
  // already tells the UI whether to even show a credits/membership panel —
  // creditPurchase:false for JAB means "display only", not "purchase flow").

  /** GET /me/credits -> raw credit packages (empty array if none/not applicable). */
  async getCredits(session) {
    const res = await this.request('/me/credits', { token: session.accessToken });
    if (!res.ok) throw new Error(`getCredits failed: ${res.status}`);
    const data = await res.json();
    return data.results || [];
  }

  /** GET /me/memberships -> raw memberships (empty array if none). */
  async getMemberships(session) {
    const res = await this.request('/me/memberships', { token: session.accessToken });
    if (!res.ok) {
      const err = new Error(`getMemberships failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return data.results || [];
  }

  /** Map the account's primary MarianaTek membership to the shared UI shape. */
  async getMembership(session) {
    const memberships = await this.getMemberships(session);
    if (!memberships.length) return null;

    const isActive = (m) => m.is_active !== false
      && !['inactive', 'cancelled', 'canceled', 'expired'].includes(String(m.status || '').toLowerCase())
      && m.is_charge_declined !== true;
    const membership = memberships.find(isActive) || memberships[0];

    return makeMembership({
      id: membership.id,
      name: membership.name || membership.description || 'Membership',
      status: membership.status,
      isActive: isActive(membership),
      renewsAt: membership.next_payment_datetime || membership.next_payment_date
        || membership.renewal_datetime || membership.renewal_date,
      expiresAt: membership.expiration_datetime || membership.expiration_date
        || membership.end_datetime || membership.end_date,
      guestPassesRemaining: membership.guest_remaining_usage_count,
      guestPassesTotal: membership.guest_usage_limit,
      bookingWindowLabel: membership.booking_window_display,
      manageUrl: this.gym.websiteUrl,
    });
  }

  /**
   * "Can this account book at all" for a MarianaTek gym: an active membership,
   * OR a credit balance, whichever the studio's members actually use (some MT
   * studios are credit-pack-based rather than membership-based — see
   * marianatek.md §"Not yet confirmed"). Both getMemberships/getCredits already
   * exist and are tested; this was the missing piece — they were wired to no
   * route, so a JAB user with neither ever got a "why can't I book" signal.
   * @param {import('./base').AuthSession} session
   * @returns {Promise<import('./base').NormalizedEligibility>}
   */
  async getEligibility(session) {
    const [membership, credits] = await Promise.all([
      this.getMembership(session).catch(() => null),
      this.getCredits(session).catch(() => []),
    ]);
    if (membership?.isActive) return { canBook: true, expiresAt: membership.expiresAt };
    const hasCredits = credits.some((c) => Number(c.credits_remaining ?? 0) > 0);
    if (hasCredits) return { canBook: true };
    return { canBook: false, reason: 'No active membership or credits' };
  }

  // --- Timetable & layout (WP-M2) --------------------------------------------
  //
  // GET /classes is public per §1C, but authenticated requests populate
  // is_user_reserved/is_user_waitlisted for the caller, so pass the token when
  // a session is available. Query params confirmed live (not documented in the
  // OpenAPI schema): min_start_date/max_start_date (date filter), location
  // (studio location id), page_size (default page size is small — 10ish).

  /**
   * @param {{startDate?: string, endDate?: string, locationId?: string, instructorId?: string, page?: number, pageSize?: number}} params
   * @param {import('./base').AuthSession=} session
   * @returns {Promise<import('./base').NormalizedEvent[]>}
   */
  async fetchTimetable(params = {}, session) {
    if (params.page) {
      const qs = new URLSearchParams();
      if (params.startDate) qs.set('min_start_date', params.startDate);
      if (params.endDate) qs.set('max_start_date', params.endDate);
      if (params.locationId) qs.set('location', params.locationId);
      if (params.instructorId) qs.set('instructor', params.instructorId);
      qs.set('page_size', String(params.pageSize || 100));
      qs.set('page', String(params.page));

      const res = session
        ? await this.request(`/classes?${qs}`, { token: session.accessToken })
        : await this.publicRequest(`/classes?${qs}`);
      if (!res.ok) throw new Error(`fetchTimetable failed: ${res.status}`);
      const data = await res.json();
      return (data.results || []).map((c) => this.mapClassToEvent(c));
    }

    const qs = new URLSearchParams();
    if (params.startDate) qs.set('min_start_date', params.startDate);
    if (params.endDate) qs.set('max_start_date', params.endDate);
    if (params.locationId) qs.set('location', params.locationId);
    if (params.instructorId) qs.set('instructor', params.instructorId);
    qs.set('page_size', String(params.pageSize || 100));

    let path = `/classes?${qs}`;
    const allResults = [];
    let pageCount = 0;
    const maxPages = 10; // Safety cap (up to 1,000 classes)

    while (path && pageCount < maxPages) {
      pageCount++;
      const res = session
        ? await this.request(path, { token: session.accessToken })
        : await this.publicRequest(path);
      if (!res.ok) throw new Error(`fetchTimetable failed: ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.results)) {
        allResults.push(...data.results);
      }
      const nextLink = (data.links && data.links.next) || data.next;
      if (nextLink) {
        try {
          const nextUrl = new URL(nextLink, this.gym.apiBaseUrl);
          path = `${nextUrl.pathname.replace(/^\/api\/customer\/v1/, '')}${nextUrl.search}`;
        } catch (_) {
          path = null;
        }
      } else {
        path = null;
      }
    }

    return allResults.map((c) => this.mapClassToEvent(c));
  }

  /**
   * @param {string} eventId
   * @param {import('./base').AuthSession=} session
   * @returns {Promise<import('./base').NormalizedEventDetails>}
   */
  async fetchEventDetails(eventId, session) {
    const res = session
      ? await this.request(`/classes/${eventId}`, { token: session.accessToken })
      : await this.publicRequest(`/classes/${eventId}`);
    if (!res.ok) throw new Error(`fetchEventDetails failed: ${res.status}`);
    const c = await res.json();
    return {
      event: this.mapClassToEvent(c),
      slots: this.mapLayoutToSlots(c.layout),
      // MT's `layout` carries `spots` only — no podium/stage/pillar fixtures
      // exist in the schema (confirmed against the captured class-detail
      // fixtures), so there is nothing to normalize here. Kept explicit rather
      // than omitted so the field is always present on NormalizedEventDetails.
      objects: [],
    };
  }

  /**
   * MarianaTek has NO studio-level (event-independent) layout endpoint —
   * layout only ever exists embedded in a class detail (marianatek.md §1/Q12;
   * the separate "Studio API" that reportedly manages layouts requires its
   * own partner API-key credential, not the customer OAuth session this
   * adapter has). Proxies through any upcoming class at the given studio
   * (`classroom.id`) and reads its layout — a Pick-A-Spot studio's physical
   * floor plan doesn't vary class-to-class, so any class works as the source.
   * Returns empty `slots` if no upcoming class exists at that studio to proxy
   * through, same "no floor map available" contract as CodexFit's implementation.
   */
  async fetchStudioLayout(studioId, session) {
    const events = await this.fetchTimetable({}, session);
    const match = events.find((e) => String(e.studioId) === String(studioId));
    if (!match) return { slots: [], objects: [] };
    const { slots, objects } = await this.fetchEventDetails(match.id, session);
    return { slots, objects };
  }

  // Maps a raw MT `class`/`class_session` object (confirmed shape: see
  // server/__fixtures__/marianatek/classes-list.json and class-detail-*.json)
  // onto NormalizedEvent. `booking_start_datetime` -> releaseAt is the key
  // finding from marianatek.md §1H: MT resolves the booking-window rule
  // (rolling vs interval, whatever tier) server-side and just publishes the
  // answer per class — no per-gym window-type inference needed here.
  // --- Booking window (WP-D8) -------------------------------------------------
  //
  // MarianaTek resolves whichever window rule a studio uses (interval or rolling,
  // per membership tier) SERVER-side and publishes the answer as
  // `booking_start_datetime`, so the normal path computes nothing at all — see
  // mapClassToEvent, which reads it straight onto `releaseAt`.
  //
  // These two exist only for the gap: a class whose payload omits the field.
  // The gym's declared fallback policy fills it, so a missing value degrades to
  // "this gym's actual rule" rather than to another gym's rule or to "open now".
  resolveBookingWindow() {
    const fb = bookingWindow.fallbackPolicyOf(this.gym);
    return fb ? { offsetDays: fb.offsetDays, cutoffISO: null, source: 'gym-fallback' } : null;
  }

  releaseAtFor(startAt, window) {
    const fb = bookingWindow.fallbackPolicyOf(this.gym);
    if (!fb) return undefined;
    const days = (window && window.offsetDays != null) ? window.offsetDays : fb.offsetDays;
    const dt = bookingWindow.releaseFor(startAt, days, fb);
    return dt ? dt.toISO() : undefined;
  }

  // MarianaTek has NO studios, instructors or class-type endpoints — confirmed in
  // marianatek.md §1 (Q12). All four lists are therefore derived from the class
  // list over the requested window, deduped by id.
  //
  // The consequence is honest and worth knowing: these lists describe what is
  // ON THE TIMETABLE, not everything the gym has. An instructor with no upcoming
  // classes simply won't appear as a filter option — which is what a user
  // filtering a timetable actually wants, but it is not the same guarantee
  // CodexFit's dedicated endpoints give.
  async fetchMetadata(params = {}, session) {
    const defaultParams = {
      min_start_date: new Date().toISOString().split('T')[0],
      max_start_date: new Date(Date.now() + 28 * 864e5).toISOString().split('T')[0],
      ...params,
    };
    const events = await this.fetchTimetable(defaultParams, session);
    const locations = new Map();
    const studios = new Map();
    const instructors = new Map();
    const classTypes = new Map();

    for (const ev of events) {
      if (ev.locationId && !locations.has(ev.locationId)) {
        locations.set(ev.locationId, { id: ev.locationId, name: ev.locationName, address: ev.locationAddress });
      }
      if (ev.studioId && !studios.has(ev.studioId)) {
        studios.set(ev.studioId, {
          id: ev.studioId,
          name: ev.studioName,
          locationId: ev.locationId,
          locationName: ev.locationName,
          // A pick-a-spot class has a floor plan; a first-come-first-serve one
          // has none by definition.
          hasLayout: ev.layoutFormat === 'pick-a-spot',
        });
      }
      for (const i of (ev.instructors || [])) {
        if (i && i.id && !instructors.has(i.id)) instructors.set(i.id, i);
      }
      // MT has no class-type id on the event; the discipline name is the filter
      // the UI actually groups by, so it doubles as the key.
      if (ev.discipline && !classTypes.has(ev.discipline)) {
        classTypes.set(ev.discipline, { id: ev.discipline, name: ev.discipline, group: ev.discipline });
      }
    }

    return makeMetadata({
      gymId: this.gymId,
      locations: [...locations.values()],
      studios: [...studios.values()],
      instructors: [...instructors.values()],
      classTypes: [...classTypes.values()],
    });
  }

  // MarianaTek has no instructor endpoint. Its public /classes endpoint does
  // support an instructor filter (documented in marianatek.md), so one small
  // current/future window is the provider-authoritative source. An instructor
  // with no class in that window intentionally falls back to initials.
  async findInstructorPhoto(instructorId) {
    const today = new Date();
    const end = new Date(today.getTime() + 90 * 864e5);
    const query = new URLSearchParams({
      instructor: String(instructorId),
      min_start_date: today.toISOString().slice(0, 10),
      max_start_date: end.toISOString().slice(0, 10),
      page_size: '20',
    });
    const res = await this.publicRequest(`/classes?${query}`);
    if (!res.ok) return null;
    const body = await res.json();
    const instructor = (body.results || []).flatMap((item) => item.instructors || [])
      .find((item) => String(item.id) === String(instructorId));
    const photos = instructor && instructor.photo_urls;
    if (!photos) return null;
    return {
      imageUrl: photos.large_url || photos.thumbnail_url || undefined,
      thumbUrl: photos.thumbnail_url || photos.large_url || undefined,
    };
  }

  mapClassToEvent(c) {
    const durationMin = c.class_type && c.class_type.duration;
    const endAt = durationMin && c.start_datetime
      ? new Date(new Date(c.start_datetime).getTime() + durationMin * 60000).toISOString()
      : undefined;
    return makeEvent({
      id: c.id,
      gymId: this.gymId,
      name: c.name,
      // `class_type.name` is the real category (confirmed 2026-09-15 against
      // 855 live classes: it differs from `classroom_name` for 68 of them,
      // and every one of those was `classroom_name` being wrong — e.g. a
      // "Small Group Boxing PT" class sits in a room literally called
      // "Boxing Studio", which then showed as the class's "discipline" in
      // both the filter dropdown and the row's discipline pill. There is no
      // `class_session_type` field on either the list or detail payload
      // (checked both) — `class_type.name` is the only real category
      // MarianaTek exposes. Falls back to `classroom_name` only if a class
      // ever arrives with no `class_type` at all, which no live capture has
      // shown but costs nothing to guard.
      discipline: (c.class_type && c.class_type.name) || c.classroom_name,
      startAt: c.start_datetime,
      durationMin,
      endAt,
      releaseAt: c.booking_start_datetime,
      locationId: c.location && c.location.id,
      locationName: c.location && c.location.name,
      locationAddress: c.location && (c.location.address_line_one || c.location.formatted_address),
      studioId: c.classroom && c.classroom.id,
      studioName: c.classroom && c.classroom.name,
      instructors: (c.instructors || []).map((i) => ({
        id: String(i.id),
        name: i.name,
        imageUrl: (i.photo_urls && (i.photo_urls.large_url || i.photo_urls.thumbnail_url)) || undefined,
        // Kept distinct from imageUrl: a card avatar renders at ~26px, and
        // collapsing both to large_url is what makes thumbnails cost a full
        // -size download per instructor on a mobile connection.
        thumbUrl: (i.photo_urls && (i.photo_urls.thumbnail_url || i.photo_urls.large_url)) || undefined,
        bio: i.bio || undefined,
        instagramUrl: i.instagram_url || undefined,
        instagramHandle: i.instagram_handle || undefined,
        spotifyUrl: i.spotify_url || undefined,
      })),
      capacity: c.capacity,
      availableCount: c.available_spot_count,
      // Top-level waitlist_count is unreliable (confirmed null on every live
      // capture so far) — spot_options.waitlist_availability is the real signal.
      waitlistCount: c.spot_options && c.spot_options.waitlist_availability,
      isFull: c.available_spot_count === 0,
      // MT exposes waitlist availability on spot_options rather than as a set of
      // separate flags; a positive availability means a waitlist can be joined.
      waitlistAvailable: !!(c.spot_options && c.spot_options.waitlist_availability > 0),
      // No MarianaTek equivalent — every class honours its own booking window.
      alwaysBookable: false,
      layoutFormat: c.layout_format,
      isUserBooked: c.is_user_reserved,
      isUserWaitlisted: c.is_user_waitlisted,
      raw: c,
    });
  }

  // Maps MT's `layout.spots` (pick-a-spot only — `layout` is null for
  // first-come-first-serve classes, confirmed via class-detail-fcfs.json) onto
  // NormalizedSlot[]. Returns [] for FCFS, matching the UI contract that no
  // floor-plan picker should render for those classes.
  mapLayoutToSlots(layout) {
    if (!layout || !Array.isArray(layout.spots)) return [];
    return layout.spots.map((s) => makeSlot({
      id: s.id,
      label: s.name,
      x: s.x_position,
      y: s.y_position,
      isAvailable: s.is_available,
      isPrimary: s.spot_type && s.spot_type.is_primary,
      spotType: s.spot_type && s.spot_type.name,
      raw: s,
    }));
  }

  // --- Bookings & waitlists (WP-M3) ------------------------------------------
  //
  // Confirmed shapes: server/__fixtures__/marianatek/prod-*.json (real production-
  // account capture, marianatek.md §1H). Every real booking/waitlist write on
  // this tenant included a `payment_option.id` (e.g. "membership-2552") — MT
  // exposes the valid options per class via GET /classes/{id}/payment_options,
  // so bookSlot/joinWaitlist resolve one before writing rather than guessing a
  // fixed shape (a credit-based MT studio would presumably return a different
  // option here — untested, see PROGRESS.md Q8).

  // Resolves the first available payment_option.id for a class, or null if
  // none apply (e.g. a free class, or a studio type this account can't parse).
  async resolvePaymentOption(eventId, session, { forGuest = false } = {}) {
    const res = await this.request(`/classes/${eventId}/payment_options`, { token: session.accessToken });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const options = forGuest ? data.guest_payment_options : data.user_payment_options;
    return options && options[0] ? options[0].id : null;
  }

  /**
   * Books ONE reservation attempt. `slotIds` (if non-empty) uses only the
   * first entry — this method is a single attempt, not a multi-slot retry
   * loop; that orchestration belongs to the scheduler (WP-S1), which calls
   * this once per candidate slot exactly like it already does for CodexFit.
   * Empty `slotIds` omits the `spot` field entirely (first-come-first-serve
   * classes have no spot to select).
   */
  async bookSlot(eventId, slotIds, session) {
    const paymentOptionId = await this.resolvePaymentOption(eventId, session);
    const body = { class_session: { id: eventId }, is_booked_for_me: true, reservation_type: 'standard' };
    if (slotIds && slotIds.length > 0) body.spot = { id: slotIds[0] };
    if (paymentOptionId) body.payment_option = { id: paymentOptionId };

    const res = await this.request('/me/reservations', { token: session.accessToken, method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (data.non_field_errors && data.non_field_errors[0]) || data.detail || `HTTP ${res.status}`;
      return makeBookingResult({ ok: false, error, raw: data });
    }
    return makeBookingResult({ ok: true, bookingId: data.id, slotId: data.spot && data.spot.id, raw: data });
  }

  async cancelBooking(bookingId, session) {
    const res = await this.request(`/me/reservations/${bookingId}/cancel`, { token: session.accessToken, method: 'POST' });
    return res.ok;
  }

  async getCancelPenalty(bookingId, session) {
    const res = await this.request(`/me/reservations/${bookingId}/cancel_penalty`, { token: session.accessToken });
    if (!res.ok) throw new Error(`getCancelPenalty failed: ${res.status}`);
    const data = await res.json();
    return { isPenalty: !!data.is_penalty_cancel, message: data.message || undefined };
  }

  async joinWaitlist(eventId, session) {
    const paymentOptionId = await this.resolvePaymentOption(eventId, session);
    const body = { class_session: { id: eventId }, is_booked_for_me: true, reservation_type: 'waitlist' };
    if (paymentOptionId) body.payment_option = { id: paymentOptionId };
    const res = await this.request('/me/reservations', { token: session.accessToken, method: 'POST', body });
    return res.ok;
  }

  /**
   * MT's waitlist entries are reservations (reservation_type: "waitlist")
   * cancelled by RESERVATION id (POST /me/reservations/{id}/cancel), not event
   * id — unlike CodexFit's PUT/DELETE /waitlists/{eventId}. To honor the
   * shared eventId-based interface (base.js), look up the user's own waitlist
   * reservation for this event first, then cancel it by its reservation id.
   */
  async leaveWaitlist(eventId, session) {
    const res = await this.request('/me/reservations?is_upcoming=true&page_size=100', { token: session.accessToken });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    const entry = (data.results || []).find(
      (r) => r.reservation_type === 'waitlist' && r.class_session && String(r.class_session.id) === String(eventId)
    );
    if (!entry) return false;
    return this.cancelBooking(entry.id, session);
  }

  /**
   * Shared list fetch backing listBookings/listWaitlists — both are just
   * /me/reservations filtered client-side by reservation_type (same endpoint
   * leaveWaitlist already uses for its reservation-by-event lookup). Every
   * reservation embeds a full class_session (confirmed: prod-booking-
   * response-membership.json), so — unlike CodexFit — this gets a full
   * NormalizedEvent for free via the same mapClassToEvent used by the
   * timetable, no extra request needed.
   */
  async _listReservations(session, reservationType) {
    const res = await this.request('/me/reservations?is_upcoming=true&page_size=100', { token: session.accessToken });
    if (!res.ok) throw new Error(`listReservations failed: ${res.status}`);
    const data = await res.json();
    const results = data.results || [];
    return results
      .filter((r) => r.reservation_type === reservationType)
      .map((r) => makeBooking({
        bookingId: r.id,
        eventId: r.class_session && r.class_session.id,
        slotId: r.spot && r.spot.id,
        bookedAt: r.created_at || r.reserved_at,
        isWaitlist: reservationType === 'waitlist',
        event: r.class_session ? this.mapClassToEvent(r.class_session) : undefined,
        raw: r,
      }));
  }

  async listBookings(session) { return this._listReservations(session, 'standard'); }
  async listWaitlists(session) { return this._listReservations(session, 'waitlist'); }

  /** Native spot swap — no cancel-then-rebook needed (unlike CodexFit). */
  async swapSpots(bookingId, currentSlotId, targetSlotId, session) {
    const res = await this.request(`/me/reservations/${bookingId}/swap_spots`, {
      token: session.accessToken, method: 'POST', body: { spot: targetSlotId },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return makeBookingResult({ ok: false, error: data.detail || `HTTP ${res.status}`, raw: data });
    }
    return makeBookingResult({ ok: true, bookingId: data.id, slotId: data.spot && data.spot.id, raw: data });
  }
}

module.exports = MarianaTekProvider;
