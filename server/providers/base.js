// Sweat Assistant — GymProvider abstract interface.
//
// Every gym provider (CodexFit, MarianaTek, …) implements this interface so the
// rest of the server (routes, scheduler, poller, calendar) can speak one
// normalized language regardless of the underlying booking platform.
//
// Design notes:
// - Adapters are constructed with a *gym config* object (see server/gyms.config.js).
//   The same adapter class can therefore serve multiple tenants of the same
//   provider (e.g. two CodexFit gyms) by varying baseUrl/headers in config.
// - Adapters are stateless with respect to a *user*: every method that needs
//   authentication takes a `session` (the normalized AuthSession) as an argument.
//   Session persistence (user_gyms table) is the caller's responsibility.
// - Methods return NORMALIZED shapes (see typedefs below), never raw provider JSON
//   in the happy path. Raw payloads may be attached as `.raw` for debugging.
//
// See Documentation/Archive/2026-09-26/Backlog/modular-gyms/PLAN.md §2.2 / §3 for the full contract.

// ---------------------------------------------------------------------------
// Normalized shape typedefs (JSDoc — this is a plain-JS/CommonJS codebase).
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UserCredentials
 * @property {string} email
 * @property {string} password
 */

/**
 * Opaque per-gym session bundle. Persisted (encrypted where sensitive) on the
 * user_gyms row as `session_json`. CodexFit uses `accessToken` only; MarianaTek
 * uses `accessToken` + `refreshToken` + `expiresAt`.
 * @typedef {Object} AuthSession
 * @property {string}  accessToken
 * @property {string=} refreshToken
 * @property {number=} expiresAt      Epoch ms when accessToken expires (if known).
 * @property {Object=} meta           Provider-specific extras (e.g. PKCE verifier during flow).
 */

/**
 * @typedef {Object} NormalizedCreditRequirement
 * @property {number}   required   Credits this class costs. 0 = free. CONFIRMED
 *           to vary on live Psycle data (2026-09-14: of 705 events, 698 cost 1,
 *           4 cost 2 and 3 cost 0) — so "one credit per class" is not a safe
 *           simplification, it is wrong for real classes people try to book.
 * @property {string[]} acceptedTypeIds  Credit-type ids this class accepts.
 *           Differs per class (a Ride-only credit is accepted by ride classes
 *           and refused elsewhere), which is exactly what a total-balance check
 *           cannot see.
 *
 * @typedef {Object} NormalizedInstructor
 * @property {string}  id
 * @property {string}  name
 * @property {string=} imageUrl
 * @property {string=} thumbUrl   Small rendering of imageUrl where the provider
 *           publishes one. Card avatars use this; the hover tooltip uses
 *           `imageUrl`. Absent means the provider offers a single size, and a
 *           card avatar must decide for itself whether that is worth fetching.
 * @property {string=} bio
 * @property {string=} instagramUrl
 * @property {string=} instagramHandle
 * @property {string=} spotifyUrl
 * @property {Object=} metafields  CodexFit-only extras (description/instagram_handle/
 *           spotify_handle/keywords) — read as a fallback chain by the client
 *           tooltip rather than re-extracted per-field server-side.
 */

/**
 * A bookable class/session, normalized across providers.
 * @typedef {Object} NormalizedEvent
 * @property {string}  id
 * @property {string}  gymId
 * @property {string}  name
 * @property {string=} discipline        e.g. "BOXING", "Ride"
 * @property {string}  startAt           ISO 8601 (with offset)
 * @property {string=} endAt             ISO 8601
 * @property {number=} durationMin       Class length in minutes.
 * @property {string=} releaseAt         ISO 8601 — when booking opens for this event.
 *                                       CodexFit: computed Monday-noon window.
 *                                       MarianaTek: `booking_start_datetime`.
 * @property {string=} locationId
 * @property {string=} locationName
 * @property {string=} locationAddress   Street address, for calendar LOCATION.
 * @property {string=} studioId
 * @property {string=} studioName
 * @property {NormalizedInstructor[]} instructors
 * @property {number=} capacity
 * @property {number=} availableCount
 * @property {boolean=} isFull            No spots left (waitlist may still be open).
 * @property {boolean=} waitlistAvailable  Whether a waitlist can be joined right now.
 * @property {boolean=} alwaysBookable     Bypasses the booking window entirely.
 * @property {number=} waitlistCount
 * @property {'pick-a-spot'|'first-come-first-serve'} layoutFormat
 * @property {boolean=} isUserBooked
 * @property {boolean=} isUserWaitlisted
 * @property {*=}      raw               Raw provider payload (debug only).
 * @property {NormalizedCreditRequirement=} credits  What it costs and what it
 *           accepts. Absent on a gym with no credit system.
 */

/**
 * A single spot/seat in a pick-a-spot layout.
 * @typedef {Object} NormalizedSlot
 * @property {string}  id
 * @property {string}  label            Human label, e.g. "24"
 * @property {number=} x                x position (provider-native units)
 * @property {number=} y                y position
 * @property {number=} row              Derived row key (rounded y), for whole-row prefs.
 * @property {boolean} isAvailable
 * @property {boolean=} isPrimary
 * @property {string=} spotType
 * @property {*=}      raw
 */

/**
 * A non-bookable fixture on the floor plan (instructor podium, stage, pillar).
 * Rendered as a marker so the map's proportions match the real room, never
 * clickable. CodexFit publishes these as `studio.layout.objects`; MarianaTek's
 * layout carries spots only, so its adapters return an empty array.
 * @typedef {Object} NormalizedLayoutObject
 * @property {string=} id
 * @property {string=} label            Human label, e.g. "Podium"
 * @property {number=} x                x position (same coordinate space as slots)
 * @property {number=} y                y position
 * @property {string=} objectType       Provider-native type string, when given.
 * @property {*=}      raw
 */

/**
 * @typedef {Object} NormalizedEventDetails
 * @property {NormalizedEvent} event
 * @property {NormalizedSlot[]} slots    Empty for first-come-first-serve layouts.
 * @property {NormalizedLayoutObject[]} objects  Non-bookable floor fixtures.
 *                                       Empty when the provider has none.
 * @property {number=} maxBookableSlots  Provider-side cap on slots bookable in
 *                                       one call for this event (CodexFit only
 *                                       — undefined for providers without the
 *                                       concept; callers should fall back to
 *                                       slots.length when unset).
 */

/**
 * @typedef {Object} NormalizedStudioLayout
 * @property {NormalizedSlot[]} slots           Empty means "no floor map available".
 * @property {NormalizedLayoutObject[]} objects
 */

/**
 * @typedef {Object} NormalizedBookingResult
 * @property {boolean}  ok
 * @property {string=}  bookingId
 * @property {string=}  slotId
 * @property {string=}  error
 * @property {number=}  status  HTTP status of the underlying response, when known
 *                               (WP-N3) — a 401 here is the signal a caller should
 *                               retry after a relogin; the adapter itself never
 *                               retries (that stays the caller's job, matching
 *                               request()'s existing convention).
 * @property {*=}       raw
 */

/**
 * @typedef {Object} CancelPenalty
 * @property {boolean}  isPenalty
 * @property {string=}  message
 */

/**
 * One entry from a user's booking or waitlist list.
 * @typedef {Object} NormalizedBooking
 * @property {string}  bookingId          Booking id (standard) or waitlist-entry id (waitlist).
 * @property {string=} eventId
 * @property {string=} slotId
 * @property {boolean} isWaitlist
 * @property {NormalizedEvent=} event     Present when the provider's list response embeds
 *                                        full class details (MarianaTek's class_session).
 *                                        Absent for CodexFit — its /bookings and /waitlists
 *                                        list endpoints return only { id, event_id, slot },
 *                                        no embedded event (see codexfit.js listBookings doc
 *                                        comment). Callers needing full metadata for a
 *                                        CodexFit booking must fetch it separately, exactly
 *                                        as the existing client (bookings.js) and calendar.js
 *                                        already do.
 * @property {*=}      raw
 */

/**
 * @typedef {Object} NormalizedProfile
 * @property {string=} id
 * @property {string=} email
 * @property {string=} firstName
 * @property {string=} lastName
 * @property {string=} bookingCutoff     ISO (CodexFit) — release-window detection input.
 * @property {string=} extendedCutoff    ISO (CodexFit)
 * @property {*=}      raw
 */

/**
 * @typedef {Object} NormalizedEligibility
 * @property {boolean} canBook
 * @property {string=} reason        User-facing, only set when canBook is false.
 * @property {string=} expiresAt     ISO 8601, when known (e.g. membership end date).
 */

/**
 * A provider membership suitable for account-facing UI. Providers without a
 * membership object return null; credit balances remain on /api/credits.
 * @typedef {Object} NormalizedMembership
 * @property {string=} id
 * @property {string}  name
 * @property {string=} status
 * @property {boolean} isActive
 * @property {string=} renewsAt
 * @property {string=} expiresAt
 * @property {number=} guestPassesRemaining
 * @property {number=} guestPassesTotal
 * @property {string=} bookingWindowLabel
 * @property {string=} manageUrl
 * @property {*=} raw
 */

/**
 * Capability flags — the UI/scheduler read these to decide what to show/do.
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} atomicSwap        Native spot swap (MT) vs cancel-rebook (CodexFit).
 * @property {boolean} nativeWaitlist    Provider auto-fills waitlists itself.
 * @property {boolean} creditPurchase    In-app credit/bundle purchase supported.
 * @property {boolean} bookmarks         Favourites/bookmarks supported.
 * @property {'rolling-weekly'|'per-class'} bookingWindow
 */

// ---------------------------------------------------------------------------
// Abstract base class.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NormalizedCredit
 * @property {string=} typeId    Provider's credit-type id, where it has one.
 * @property {string}  typeName  Human label ("Ride Credit"). Never blank.
 * @property {number}  count     How many credits this entry represents. CodexFit
 *           returns GROUPED entries with a count, not one object per credit —
 *           treating each entry as a single credit under-reports a balance.
 * @property {string=} expiresAt ISO instant, absent when the credit never expires.
 * @property {boolean=} isGuestOnly  Usable only for booking a GUEST, not the
 *           account holder. Absent when the provider doesn't say.
 * @property {Object=} raw
 */

class GymProvider {
  /**
   * @param {Object} gymConfig  A gym entry from server/gyms.config.js.
   */
  constructor(gymConfig) {
    if (new.target === GymProvider) {
      throw new Error('GymProvider is abstract — instantiate a concrete adapter.');
    }
    if (!gymConfig || !gymConfig.id) {
      throw new Error('GymProvider requires a gym config with an id.');
    }
    this.gym = gymConfig;
    this.gymId = gymConfig.id;
  }

  /** @returns {ProviderCapabilities} */
  get capabilities() {
    return this.gym.capabilities;
  }

  /** Whether a normalized path is a public (no-auth) read for this provider. */
  isPublicRead(/* method, path */) {
    return false;
  }

  // --- Authentication -------------------------------------------------------

  /**
   * @param {UserCredentials} credentials
   * @returns {Promise<{ session: AuthSession, profile: NormalizedProfile }>}
   */
  async login(/* credentials */) { throw notImplemented('login', this); }

  /**
   * @param {AuthSession} session
   * @returns {Promise<boolean>}
   */
  async validateSession(/* session */) { throw notImplemented('validateSession', this); }

  /**
   * Advance the credential ladder: refresh token → re-login with stored creds.
   * @param {AuthSession} session
   * @param {UserCredentials=} credentials  Needed for the re-login fallback.
   * @returns {Promise<AuthSession>}
   */
  async refreshSession(/* session, credentials */) { throw notImplemented('refreshSession', this); }

  // --- Timetable & metadata -------------------------------------------------

  /**
   * @param {Object} params    { startDate, endDate, locationIds?, ... }
   * @param {AuthSession=} session
   * @returns {Promise<NormalizedEvent[]>}
   */
  async fetchTimetable(/* params, session */) { throw notImplemented('fetchTimetable', this); }

  /**
   * @param {string} eventId
   * @param {AuthSession=} session
   * @returns {Promise<NormalizedEventDetails>}
   */
  async fetchEventDetails(/* eventId, session */) { throw notImplemented('fetchEventDetails', this); }

  /**
   * A studio's floor-plan layout, independent of any specific class — for the
   * shared preferred-spot-map editor (`spotmap.js`'s `openStudioFloorPlanEditor`,
   * opened from a studio list with no event in context). CodexFit has a
   * studio-level endpoint for this; MarianaTek does NOT (layout only exists
   * embedded per-class, see marianatek.md §1/Q12) — its implementation finds
   * any upcoming class at the studio and reads that class's layout as a proxy.
   * Returns `{ slots: [], objects: [] }` if the studio has no layout data (or
   * no upcoming class to proxy through, for MT) rather than throwing — "no
   * floor map available" is an expected, handled case in every caller, not an
   * error.
   * @param {string} studioId
   * @param {AuthSession=} session
   * @returns {Promise<NormalizedStudioLayout>}
   */
  async fetchStudioLayout(/* studioId, session */) { throw notImplemented('fetchStudioLayout', this); }

  /**
   * The four metadata lists the timetable filters on: locations, studios,
   * instructors, class types.
   *
   * Deliberately ONE method rather than four. Platforms differ sharply in how
   * these are exposed — CodexFit serves a dedicated endpoint per list, while
   * MarianaTek has none of them and must derive all four from its class list —
   * so a per-list contract would force one platform's shape onto the other.
   *
   * @param {{startDate?:string, endDate?:string}} params  Window to derive from,
   *        for platforms with no dedicated endpoints.
   * @returns {Promise<{locations:Object[], studios:Object[], instructors:Object[], classTypes:Object[]}>}
   */
  async fetchMetadata(/* params, session */) { throw notImplemented('fetchMetadata', this); }

  /**
   * @param {AuthSession} session
   * @returns {Promise<NormalizedProfile>}
   */
  async getProfile(/* session */) { throw notImplemented('getProfile', this); }

  /**
   * "Can this account book at all" — a third question, distinct from both
   * `metered` (does a class draw down a credit balance) and `creditPurchase`
   * (can we sell top-ups in-app). A membership gym answers this from whether
   * a membership is active; a metered gym answers it from whether there is
   * any usable credit. Never derive this from credit arithmetic done
   * elsewhere for a DIFFERENT purpose (per-class affordance) — an unmetered
   * gym's credit total is Infinity by design and says nothing about
   * membership status, which is the bug this method exists to fix.
   *
   * Default is permissive ({ canBook: true }): an adapter that hasn't
   * implemented this yet should not silently block every booking attempt —
   * same "unknown flag defaults ON" rule as capability flags.
   *
   * @param {AuthSession} session
   * @returns {Promise<NormalizedEligibility>}
   */
  async getEligibility(/* session */) { return { canBook: true }; }

  /**
   * The account's primary membership, when the provider exposes one.
   * Credit-based providers return null rather than manufacturing membership
   * semantics from a balance.
   * @param {AuthSession} session
   * @returns {Promise<NormalizedMembership|null>}
   */
  async getMembership(/* session */) { return null; }

  /**
   * Resolve THIS user's booking window from their profile + credit inventory.
   *
   * The platform half is knowing WHERE the cutoff lives in its own payload; the
   * policy half (which weekday, how many days, which credit type extends it)
   * belongs to the gym config and is evaluated by providers/booking-window.js.
   * Never put a gym's numbers in an adapter — a platform serves many gyms.
   *
   * @param {Object} profile  Raw provider profile payload.
   * @param {Object[]=} credits  Raw provider credit rows, if the platform has them.
   * @returns {{offsetDays:number, cutoffISO:(string|null), source:string}|null}
   *          null when this gym publishes a per-class release instead (the event
   *          already carries `releaseAt`, so there is no window to compute).
   */
  resolveBookingWindow(/* profile, credits */) { return null; }

  /**
   * When booking opens for a class, given a window from resolveBookingWindow().
   * @returns {string|undefined} ISO 8601, or undefined when this gym publishes a
   *          per-class release (use the event's own `releaseAt`).
   */
  releaseAtFor(/* startAt, window */) { return undefined; }

  // --- Bookings & waitlists -------------------------------------------------

  /**
   * Book ONE spot. Callers wanting several loop and call this once per spot.
   *
   * Singular by contract, because it is singular in the platform that constrains
   * it: MarianaTek's POST /me/reservations takes `spot: { id }` and creates one
   * reservation per request. CodexFit can accept several in one call, but a
   * contract shaped around that would be unimplementable for MT — and the
   * scheduler already books one slot at a time regardless.
   *
   * @param {string}   eventId
   * @param {string[]} slotIds   Empty array → book "any" / FCFS. Only the FIRST
   *                             entry is used; extras are ignored, not batched.
   * @param {AuthSession} session
   * @returns {Promise<NormalizedBookingResult>}  Exactly one { bookingId, slotId }.
   */
  async bookSlot(/* eventId, slotIds, session */) { throw notImplemented('bookSlot', this); }

  /**
   * @param {string} bookingId
   * @param {AuthSession} session
   * @returns {Promise<boolean>}
   */
  async cancelBooking(/* bookingId, session */) { throw notImplemented('cancelBooking', this); }

  /**
   * @param {string} bookingId
   * @param {AuthSession} session
   * @returns {Promise<CancelPenalty>}
   */
  async getCancelPenalty(/* bookingId, session */) { throw notImplemented('getCancelPenalty', this); }

  async joinWaitlist(/* eventId, session */) { throw notImplemented('joinWaitlist', this); }
  async leaveWaitlist(/* eventId, session */) { throw notImplemented('leaveWaitlist', this); }

  /**
   * List the user's active (upcoming, non-cancelled) bookings.
   * @param {AuthSession} session
   * @returns {Promise<NormalizedBooking[]>}
   */
  async listBookings(/* session */) { throw notImplemented('listBookings', this); }

  /**
   * List the user's active waitlist entries.
   * @param {AuthSession} session
   * @returns {Promise<NormalizedBooking[]>}  (isWaitlist: true)
   */
  async listWaitlists(/* session */) { throw notImplemented('listWaitlists', this); }

  // --- Auto-upgrade / spot swapping ----------------------------------------

  /**
   * Move an existing booking to a different spot. Providers with `atomicSwap`
   * do this natively; others implement cancel-then-rebook internally.
   * @param {string} bookingId
   * @param {string} currentSlotId
   * @param {string} targetSlotId
   * @param {AuthSession} session
   * @returns {Promise<NormalizedBookingResult>}
   */
  async swapSpots(/* bookingId, currentSlotId, targetSlotId, session */) { throw notImplemented('swapSpots', this); }

  /**
   * Credit inventory for a metered gym. Returns [] for membership gyms.
   * @param {AuthSession} session
   * @returns {Promise<NormalizedCredit[]>}
   */
  async getCredits(/* session */) { return []; }

  // --- Capability-gated extras ----------------------------------------------
  //
  // These three are NOT universal gym concepts, and pretending otherwise would
  // be its own mistake. They exist on the contract so the raw `/api/proxy`
  // passthrough can be deleted: the client must never know a provider's URL
  // shape, even for a feature only one platform has. A provider without the
  // matching capability simply never has these called — the route rejects
  // first, on the gym's capability flag.

  /**
   * Purchasable credit packs. Only meaningful where `capabilities.metered` and
   * `capabilities.creditPurchase` are set.
   * @param {AuthSession} session
   * @returns {Promise<{ bundles: Array, bundleTypes: Object= }>}
   */
  async listBundles(/* session */) { throw notImplemented('listBundles', this); }

  /**
   * Add or remove a saved-class bookmark. `identifier` is the provider's own
   * bookmark key, produced by the adapter, not composed by the client.
   * Gated on `capabilities.bookmarks`.
   * @param {string} identifier
   * @param {boolean} on
   * @param {AuthSession} session
   * @returns {Promise<boolean>}
   */
  async setBookmark(/* identifier, on, session */) { throw notImplemented('setBookmark', this); }

  /**
   * Write arbitrary fields back to the account profile. Debug-surface only
   * (the Profile Explorer's hidden edit mode); no normal flow calls this.
   * @param {Object} payload
   * @param {AuthSession} session
   * @returns {Promise<Object>}
   */
  async updateProfile(/* payload, session */) { throw notImplemented('updateProfile', this); }
}

function notImplemented(method, provider) {
  return new Error(`[${provider.gym && provider.gym.provider}] ${method}() not implemented for gym "${provider.gymId}".`);
}

/**
 * Classify an HTTP response as provider rate-limiting/blocking distress,
 * gym- and platform-agnostically (C2-3). Adapters call this from their write
 * paths (bookSlot today) and attach the result to NormalizedBookingResult's
 * `code`/`retryAfterMs`; callers (scheduler.js) react to that normalized code,
 * never to a raw status or a platform name.
 *
 * Classification rule (documented here because it is a judgement call, not a
 * fact the provider states plainly):
 *   - HTTP 429 is unambiguous: always rate-limited.
 *   - HTTP 403 is NOT always rate-limiting — it is also the ordinary shape of
 *     "not authorized to do this" (wrong credit type, class full to non-members,
 *     etc.), which must NOT trip a gym-wide backoff. A 403 counts as throttling
 *     only when there is corroborating evidence: a `Retry-After` header, or the
 *     error body's message containing throttle language (rate/too many
 *     requests/temporarily blocked/try again later). Anything else is treated
 *     as an ordinary permission error and left alone.
 *
 * @param {Response} res  Raw fetch Response (for status + headers).
 * @param {Object=} data  Parsed JSON body, if any (for `.message`).
 * @returns {{ limited: boolean, retryAfterMs: (number|undefined) }}
 */
function classifyProviderThrottle(res, data) {
  const retryAfterMs = parseRetryAfterMs(res);
  if (res && res.status === 429) return { limited: true, retryAfterMs };
  if (res && res.status === 403) {
    const msg = String((data && data.message) || '').toLowerCase();
    const THROTTLE_PHRASES = ['too many requests', 'rate limit', 'throttle', 'temporarily blocked', 'try again later'];
    if (retryAfterMs !== undefined || THROTTLE_PHRASES.some((p) => msg.includes(p))) {
      return { limited: true, retryAfterMs };
    }
  }
  return { limited: false, retryAfterMs: undefined };
}

function parseRetryAfterMs(res) {
  const header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  // Retry-After MAY be an HTTP-date instead of seconds; CodexFit hasn't been
  // observed to send one, so this is left unhandled rather than guessed at.
  return undefined;
}

module.exports = { GymProvider, classifyProviderThrottle };
