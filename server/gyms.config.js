// Sweat Assistant — static gym registry (single source of truth for provider wiring).
//
// Why a static registry (not a DB table): gyms are few, and adding one is a code
// change anyway (new provider config, theme, capability flags). Secrets stay in
// env, not the DB. A thin `gyms` DB table mirrors this for referential integrity
// and admin display, but THIS file is authoritative for provider behavior.
// See Documentation/Archive/2026-09-26/Backlog/modular-gyms/PLAN.md §2.3.
//
// Each entry is passed verbatim to the provider adapter constructor (base.js).

/** @type {Record<string, Object>} keyed by gym id */
const GYMS = {
  'psycle-london': {
    id: 'psycle-london',
    name: 'Psycle London',
    shortName: 'Psycle',
    websiteUrl: 'https://psyclelondon.com/',
    provider: 'codexfit',
    // The gym's local timezone. CodexFit serves timezone-NAIVE datetimes
    // ("2026-09-01T19:30:00", no offset), so every parse has to be anchored
    // somewhere — and where is a property of this gym, not of CodexFit. A
    // CodexFit gym in New York would set America/New_York here and need no
    // adapter change. Never parse a naive gym datetime with bare `new Date()`:
    // that resolves in the SERVER's zone and drifts across DST.
    timezone: 'Europe/London',
    enabled: true,
    // CodexFit HTTP wiring (previously hardcoded in auth.js / server.js / scheduler.js).
    apiBaseUrl: 'https://psycle.codexfit.com/api/v1/customer',
    // CodexFit's v2 cart/checkout API lives at a genuinely different base path
    // (`/api/customer/v2`, not `/api/v2/customer`) — confirmed via a live
    // capture 2026-09-26 (server/fixtures/codexfit-v2/PARITY.md, gate G3).
    // Only the cart lifecycle uses this; every other CodexFit call still goes
    // through the v1 base above. See providers/codexfit-cart.js.
    v2ApiBaseUrl: 'https://psycle.codexfit.com/api/customer/v2',
    // origin/referer/x-organisation were already confirmed from earlier research;
    // accept-language/user-agent added 2026-07-03 from a real browser DevTools
    // capture (LIVE_VERIFICATION_PLAYBOOK.md §3 client-fidelity rationale — same
    // treatment as jab-boxing's headers below: stable, common-to-many-clients
    // values only, no Client-Hints headers).
    headers: {
      origin: 'https://psyclelondon.com',
      referer: 'https://psyclelondon.com/',
      'x-organisation': '[object Object]',
      'accept-language': 'en-GB,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    },
    loginPath: '/auth/login',
    // GET paths that CodexFit serves without a Bearer token.
    publicPathPattern: /^\/(events|locations|studios|instructors|event-types|event-type-groups|bundles)(\/|$|\?)/,
    theme: { key: 'violet', primary: '#7c3aed' },
    labels: { class: 'class', spot: 'spot' },
    // Booking-window POLICY (WP-D8). These are Psycle's rules, not CodexFit's —
    // another gym on the same platform could release Sundays at 09:00 with a
    // 21-day window, so none of this belongs in providers/codexfit.js. The
    // adapter's job is only to know WHERE CodexFit exposes the cutoff; what the
    // cutoff means is here. Evaluated by providers/booking-window.js.
    //
    // Confirmed with a member 2026-08-31: the standard window is a fortnight
    // (was 8 days), and membership tiers extend it by DAYS, not weeks —
    // Psycle 10 +2 (to Thursday), Psycle 15 +3 (to Friday), Unlimited +8. Those
    // tiers are NOT listed here on purpose: they arrive per-account on the
    // profile cutoff, which is server-authoritative. Never snap a detected
    // window to a whole week — that was the pre-2026-08-31 model and it
    // mis-computed 3 of the 4 current tiers in both directions.
    bookingWindow: {
      kind: 'rolling-weekly',
      releaseWeekday: 1,                 // Luxon: Monday
      releaseTime: { hour: 12, minute: 0 },
      // 15, not 14. The window always ends on a TUESDAY: booking for any given
      // Tuesday opens on the Monday, so cutoff = releaseMonday + 15 days
      // (M+14 is a Monday; M+15 is the Tuesday). The old 8-day base landed on a
      // Tuesday the same way (M+8), so the alignment has always held — a 14 here
      // would silently hold Tuesday classes back a whole extra week for anyone
      // on the standard tier. Corrected by the stakeholder 2026-09-01.
      baseOffsetDays: 15,
      minOffsetDays: 1,
      maxOffsetDays: 35,
      // NOTE: Psycle no longer issues Advanced Booking credits (stakeholder,
      // 2026-09-01). The window is the 15-day base plus the member tier's extra
      // days, full stop — and the tier's extra days already arrive on the profile
      // cutoff, so nothing here needs to encode them.
      //
      // The old `extendedCredit: { typeId: 8, floorDays: 15 }` floor is gone, and
      // its evaluation removed from providers/booking-window.js. If a gym ever
      // does need a rule like that again, it belongs in THAT GYM'S adapter
      // (codexfit.js resolveBookingWindow composes the window and is the seam),
      // not back in the shared evaluator where it looked platform-neutral while
      // encoding one gym's promotion.
      // Pre-auto-detection manual toggles; reachable only on a cold start before
      // a profile has been read.
      legacy: { advancedBookingDays: 7 },
    },
    capabilities: {
      atomicSwap: false,        // no spot-swap API → cancel-then-rebook
      nativeWaitlist: false,
      metered: true,            // classes cost credits from a balance
      creditPurchase: true,     // in-app Stripe cart
      bookmarks: true,          // native CodexFit bookmarks
      bookingWindow: 'rolling-weekly',   // mirrors bookingWindow.kind, for the UI
      maxSpotsPerClass: null,   // unmetered/credits-limited
    },
    // Per-gym notification DEFAULTS. A member can override each one for this
    // gym; this is what they get before they touch anything.
    notifications: {
      // Psycle releases at one moment a week, so "booking opens in an hour" is
      // a real, actionable event worth a push.
      bookingWindowReminder: true,
    },
  },

  'jab-boxing': {
    id: 'jab-boxing',
    name: 'JAB Boxing Club',
    shortName: 'JAB',
    websiteUrl: 'https://jabboxing.club/',
    provider: 'marianatek',
    // MarianaTek returns offset-bearing ISO timestamps, so this is used for
    // display grouping rather than for parsing.
    timezone: 'Europe/London',
    // Keep JAB dark in PRODUCTION by default. Staging can opt in with
    // JAB_BOXING_ENABLED=true for live account verification without making a
    // future production deploy expose an unfinished provider integration by
    // accident.
    //
    // In dev it is enabled automatically, because the gate being off is
    // indistinguishable from the feature being broken: with no second gym in the
    // catalogue nothing is "addable", so the Settings → Your Gyms card renders
    // no "Connect another gym" button and collapses to the single-gym inline
    // view — i.e. the multi-gym build looks absent rather than gated. Set
    // JAB_BOXING_ENABLED=false to force it dark in dev too.
    enabled: process.env.JAB_BOXING_ENABLED === 'true'
      || (process.env.NODE_ENV !== 'production' && process.env.JAB_BOXING_ENABLED !== 'false'),
    tenant: 'jabboxingclub',
    apiBaseUrl: 'https://jabboxingclub.marianatek.com/api/customer/v1',
    oauthBaseUrl: 'https://jabboxingclub.marianatek.com/o',
    loginPageUrl: 'https://jabboxingclub.marianatek.com/auth/login/',
    // Shared across all MarianaTek tenants (extracted from web-integrations OAuth).
    clientId: 'sbLziNCoF5HcOhkSV6zRL8O7betwd3mDDIQbWZa3',
    redirectUri: 'https://jabboxingclub.marianaiframes.com/iframe/callback/',
    scope: 'read:account',
    // Client-fidelity headers (LIVE_VERIFICATION_PLAYBOOK.md §3) — captured 2026-07-03
    // from a real browser DevTools network-tab request to GET /classes on the real
    // JAB Boxing widget (confirms origin/referer = the marianaiframes.com iframe
    // domain, matching redirectUri above — not the tenant's own marianatek.com
    // domain). Deliberately does NOT include Client-Hints headers (sec-ch-ua*,
    // sec-fetch-*, priority) — those are generated by the real browser's TLS/HTTP2
    // stack; hand-setting them from a Node server without the matching transport
    // fingerprint would be a MORE detectable mismatch than omitting them, and
    // they'd need constant upkeep (e.g. the captured Chrome build number) to not
    // look stale. accept/accept-language/origin/referer/user-agent are stable,
    // meaningful, and common to many legitimate non-browser HTTP clients too.
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en',
      origin: 'https://jabboxingclub.marianaiframes.com',
      referer: 'https://jabboxingclub.marianaiframes.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    },
    theme: { key: 'navy', primary: '#18214D', font: 'Gothic A1' },
    labels: { class: 'class', spot: 'spot' },
    // MarianaTek publishes a per-class release instant (`booking_start_datetime`),
    // already resolved server-side for the viewing account — MT supports both
    // interval (weekly) and rolling window configs and just tells us the answer.
    // Confirmed against two independent production captures (marianatek.md §1
    // "Booking window: confirmed self-describing per class"). So: READ it, never
    // compute it.
    //
    // `fallback` is used ONLY if the API omits the field. JAB's window is
    // rolling-continuous and exact to the minute — at 13:30 on 1 Sep the 13:30
    // class on 15 Sep is open and the 14:00 class the same day is not — which is
    // a different shape from Psycle's weekly release, not a variant of it.
    // Confirmed 14 days on captures, matching the membership's own
    // `booking_window_display: "Reserve 14 days in advance"`.
    //
    // NOT confirmed: what a non-member (base tier) sees. If tiers differ, the
    // published value still covers it — this fallback is the only thing that
    // would be wrong, and only when the field is missing entirely.
    bookingWindow: {
      kind: 'per-class',
      fallback: { kind: 'rolling-continuous', offsetDays: 14 },
    },
    capabilities: {
      atomicSwap: true,         // POST /me/reservations/{id}/swap_spots
      nativeWaitlist: true,     // MT auto-fills + SMS
      // Membership-based: a class doesn't draw down a credit balance, so any
      // "you need N more credits" arithmetic is meaningless here. Distinct from
      // creditPurchase, which is only about whether we can SELL credits — a gym
      // could be metered without us being able to top it up in-app.
      metered: false,
      creditPurchase: false,    // membership-based; no confirmed purchase API (D3)
      bookmarks: false,         // no MT bookmarks API
      bookingWindow: 'per-class',   // mirrors bookingWindow.kind, for the UI
      maxSpotsPerClass: 1,      // 1 primary spot per member per class session
    },
    notifications: {
      // JAB's window rolls continuously — each class opens at its own instant,
      // so there is no weekly moment to warn about. A "booking opens in an
      // hour" push here would be both untrue and unactionable.
      bookingWindowReminder: false,
    },
  },
};

/** @returns {Object|null} gym config or null if unknown. */
function getGymConfig(gymId) {
  return GYMS[gymId] || null;
}

/** @returns {Object[]} all gym configs (including disabled). */
function listGyms() {
  return Object.values(GYMS);
}

/** @returns {Object[]} only enabled gym configs (what users can pick). */
function listEnabledGyms() {
  return Object.values(GYMS).filter((g) => g.enabled);
}

/** The default gym existing single-tenant users are backfilled to. */
const DEFAULT_GYM_ID = 'psycle-london';

module.exports = { GYMS, getGymConfig, listGyms, listEnabledGyms, DEFAULT_GYM_ID };
