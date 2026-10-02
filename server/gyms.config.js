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
    // Short display aliases for locations, keyed by the location's name with the
    // gym prefix stripped and lower-cased. Used wherever space is tight (mobile
    // timetable rows, the filter bar). A location with no entry shows its full
    // name. Display-only: never used as an id or for lookups.
    locationAliases: {
      'oxford circus': 'OC',
      'notting hill': 'NH',
      'london bridge': 'LB',
      'clapham': 'CP',
      'victoria': 'VIC',
      'bank': 'BNK',
    },
    websiteUrl: 'https://psyclelondon.com/',
    // The gym's own public page for one class ({id} = the provider event id), for
    // the debug modal's "Open native booking page". Per gym because the path is
    // that gym's website, not the platform's; a gym with no such page omits it and
    // the button is hidden (C3-27).
    classPageUrl: 'https://psyclelondon.com/pages/class/{id}',
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
    theme: { key: 'violet', primary: '#27272A' },
    // Presentation contract (F-7 Stage A). Display only; validated at load.
    presentation: {
      shortName: 'Psycle',
      wordmark: {
        text: 'PSYCLE',
        full: { src: '/gyms/psycle-london.svg?v=1' },
        compact: { src: '/gyms/psycle-london-half.svg?v=1' },
        mark: { src: '/gyms/psycle-london-small.svg?v=1' },
      },
      plate: '#212121',
      // tint stays a SOLID base colour (consumers colour-mix it at 3-36%);
      // wash is the alpha overlay, btn the filled-button bg (`on` sits on it).
      light: { ink: '#27272A', inkHover: '#18181B', tint: '#27272A', on: '#ffffff', btn: '#27272A', wash: 'rgba(39,39,42,0.06)', pip: '#D4F400' },
      dark: { ink: '#E4E4E7', inkHover: '#FFFFFF', tint: '#E4E4E7', on: '#09090b', btn: '#FFFFFF', wash: 'rgba(228,228,231,0.10)', pip: '#D4F400' },
      displayAliases: {},
    },
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
    // Local mock identity is intentionally separate from the live tenant slug.
    // The original JAB mock predates the public tenant name.
    mockEmail: 'dev@jabboxing.mock',
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
    theme: { key: 'navy', primary: '#6C1F20', font: 'Gothic A1' },
    // Presentation contract (F-7 Stage A). Display only; validated at load.
    presentation: {
      shortName: 'JAB',
      wordmark: {
        text: 'JAB',
        full: { src: '/gyms/jab-boxing.svg' },
        compact: { src: '/gyms/jab-boxing.svg' },
        mark: { src: '/gyms/jab-boxing-mark.svg?v=3' },
        scale: 0.855, // optical: the wordmark sits at 85.5% (0.95 x 0.9) inside its unchanged chip; scales the inner image only
      },
      plate: '#6C1F20',
      light: { ink: '#6C1F20', inkHover: '#4F1617', tint: '#6C1F20', on: '#ffffff', btn: '#6C1F20', wash: 'rgba(108,31,32,0.08)' },
      dark: { ink: '#F87171', inkHover: '#FCA5A5', tint: '#F87171', on: '#2D0A0B', btn: '#F87171', wash: 'rgba(248,113,113,0.12)' },
      // Scoped, exact-match (lower-cased raw name) display aliases. Raw provider
      // names are never rewritten for lookups.
      displayAliases: { studios: { 'recovery 2.0': 'Recovery' } },
    },
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

  // Aarmy is a separate MarianaTek tenant. Its platform protocol remains in
  // providers/marianatek.js; this entry owns only tenant wiring, presentation,
  // and Aarmy-specific policy.
  'aarmy': {
    id: 'aarmy',
    name: 'Aarmy',
    shortName: 'Aarmy',
    locationAliases: {
      'noho': 'NoHo',
    },
    websiteUrl: 'https://www.aarmy.com/',
    provider: 'marianatek',
    timezone: 'America/New_York',
    // Optional per-location override ({locationId: IANA}) for a gym spanning zones.
    // Precedence: this -> provider-published zone -> `timezone` (providers/timezone.js).
    locationTimezones: {},
    // Keep the tenant dark in production until live-account acceptance is
    // recorded. It remains available in development so onboarding is testable.
    enabled: process.env.AARMY_ENABLED === 'true'
      || (process.env.NODE_ENV !== 'production' && process.env.AARMY_ENABLED !== 'false'),
    tenant: 'aarmy',
    mockEmail: 'dev@aarmy.mock',
    apiBaseUrl: 'https://aarmy.marianatek.com/api/customer/v1',
    oauthBaseUrl: 'https://aarmy.marianatek.com/o',
    loginPageUrl: 'https://aarmy.marianatek.com/auth/login/',
    clientId: 'sbLziNCoF5HcOhkSV6zRL8O7betwd3mDDIQbWZa3',
    redirectUri: 'https://aarmy.marianaiframes.com/iframe/callback/',
    scope: 'read:account',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en',
      origin: 'https://aarmy.marianaiframes.com',
      referer: 'https://aarmy.marianaiframes.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    },
    theme: { key: 'mono', primary: '#000000' },
    presentation: {
      shortName: 'Aarmy',
      wordmark: {
        text: 'AARMY',
        full: { src: '/gyms/aarmy-logo.png?v=2' },
        compact: { src: '/gyms/aarmy-logo.png?v=2' },
        mark: { src: '/gyms/aarmy-mark.png?v=2' },
        logoWidth: 60, // px width of the (wide) wordmark inside table chips; chips widen to fit (see gymChip)
        squareMark: true, // wide wordmark: use the mark in square/narrow chips (header badge, settings nav, card rail)
      },
      plate: '#111111', // dark plate + WHITE wordmark/mark, like Psycle and JAB
      light: { ink: '#000000', inkHover: '#27272A', tint: '#000000', on: '#FFFFFF', btn: '#000000', wash: 'rgba(0,0,0,0.06)' },
      dark: { ink: '#FFFFFF', inkHover: '#E4E4E7', tint: '#FFFFFF', on: '#000000', btn: '#FFFFFF', wash: 'rgba(255,255,255,0.10)' },
      displayAliases: {},
    },
    labels: { class: 'class', spot: 'spot' },
    // MarianaTek publishes the server-resolved release time per class. Aarmy
    // falls back to the observed 14-day rolling window only when that field is
    // absent, preserving any membership-specific release in normal operation.
    bookingWindow: {
      kind: 'per-class',
      // Shown in Settings -> gym -> Booking Window. 'ET' not 'EST' (DST). All 475 observed classes release Mon 11:00 America/New_York.
      summary: 'Booking opens 11:00 AM ET on Mondays. There is nothing to configure.',
      fallback: { kind: 'rolling-continuous', offsetDays: 14 },
    },
    capabilities: {
      atomicSwap: true,
      nativeWaitlist: true,
      metered: true,            // credits-only gym: classes draw from a credit balance (like Psycle)
      creditPurchase: false,    // no confirmed in-app purchase API for MarianaTek
      bookmarks: false,
      bookingWindow: 'per-class',
      maxSpotsPerClass: 1,
    },
    notifications: {
      bookingWindowReminder: false,
    },
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const ALIAS_SCOPES = ['studios', 'locations', 'instructors', 'classTypes'];
const COLOUR_KEYS = ['ink', 'inkHover', 'tint', 'on'];
// Optional: button bg, alpha wash (rgba allowed) and accent pip. Clients fall back to ink/tint.
const OPTIONAL_COLOUR_KEYS = ['btn', 'wash', 'pip'];
const CSS_COLOUR = /^(#[0-9a-fA-F]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

/**
 * Validate a gym's presentation contract. Throws on anything malformed so a bad
 * entry fails at boot, not as an invisible logo in the browser.
 * @returns {Object} the same presentation object
 */
function validatePresentation(p, gymId = '?') {
  const bad = (m) => { throw new Error(`gym ${gymId}: presentation ${m}`); };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  if (!p || typeof p !== 'object') bad('is required');
  if (!str(p.shortName)) bad('.shortName must be a non-empty string');
  const w = p.wordmark;
  if (!w || typeof w !== 'object') bad('.wordmark is required');
  if (!str(w.text)) bad('.wordmark.text (text fallback) must be a non-empty string');
  if (w.scale != null && !(typeof w.scale === 'number' && w.scale >= 0.5 && w.scale <= 1.5)) bad('.wordmark.scale must be a number between 0.5 and 1.5');
  if (w.logoWidth != null && !(typeof w.logoWidth === 'number' && w.logoWidth >= 20 && w.logoWidth <= 140)) bad('.wordmark.logoWidth must be a number between 20 and 140');
  if (w.squareMark != null && typeof w.squareMark !== 'boolean') bad('.wordmark.squareMark must be a boolean');
  for (const k of ['full', 'compact', 'mark']) {
    if (w[k] == null) continue;
    if (!w[k] || !str(w[k].src) || !/^\/gyms\/[\w.\-]+(\?[\w=&.\-]*)?$/.test(w[k].src)) {
      bad(`.wordmark.${k}.src must be a /gyms/ asset path`);
    }
  }
  if (!HEX.test(p.plate || '')) bad('.plate must be a #rrggbb colour');
  for (const mode of ['light', 'dark']) {
    if (!p[mode] || typeof p[mode] !== 'object') bad(`.${mode} is required`);
    for (const k of COLOUR_KEYS) {
      if (!HEX.test(p[mode][k] || '')) bad(`.${mode}.${k} must be a #rrggbb colour`);
    }
    for (const k of OPTIONAL_COLOUR_KEYS) {
      const v = p[mode][k];
      if (v != null && !CSS_COLOUR.test(v)) bad(`.${mode}.${k} must be #rrggbb or rgb()/rgba()`);
    }
  }
  const a = p.displayAliases;
  if (!a || typeof a !== 'object' || Array.isArray(a)) bad('.displayAliases must be an object');
  for (const [scope, map] of Object.entries(a)) {
    if (!ALIAS_SCOPES.includes(scope)) bad(`.displayAliases has unknown scope "${scope}"`);
    if (!map || typeof map !== 'object' || Array.isArray(map)) bad(`.displayAliases.${scope} must be an object`);
    for (const [raw, shown] of Object.entries(map)) {
      if (raw !== raw.trim().toLowerCase() || !raw) bad(`.displayAliases.${scope} key "${raw}" must be trimmed lower-case`);
      if (!str(shown)) bad(`.displayAliases.${scope}["${raw}"] must be a non-empty string`);
    }
  }
  return p;
}

for (const g of Object.values(GYMS)) {
  validatePresentation(g.presentation, g.id);
  const s = g.bookingWindow && g.bookingWindow.summary;
  if (s != null && (typeof s !== 'string' || s.trim() === '')) throw new Error(`gym ${g.id}: bookingWindow.summary must be a non-empty string when present`);
}

// --- Editable presentation (F-7 Stage B) -------------------------------------
// Only the presentation contract is editable at runtime; protocol, tenant URLs,
// headers and booking policy stay authoritative in this file. The registry's
// own values are kept as a baseline so an admin override can be reset.
const PRESENTATION_KEYS = ['shortName', 'wordmark', 'plate', 'light', 'dark', 'displayAliases'];
const BASELINE_PRESENTATION = {};
for (const g of Object.values(GYMS)) BASELINE_PRESENTATION[g.id] = JSON.parse(JSON.stringify(g.presentation));

/** Whitelist to the contract's keys, then validate. Throws on any problem. */
function sanitizePresentation(input, gymId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`gym ${gymId}: presentation is required`);
  }
  const clean = {};
  for (const k of PRESENTATION_KEYS) if (input[k] !== undefined) clean[k] = JSON.parse(JSON.stringify(input[k]));
  return validatePresentation(clean, gymId);
}

/** Validate and apply an override to the live registry. Unknown gym throws. */
function setPresentation(gymId, input) {
  if (!GYMS[gymId]) throw new Error(`Unknown gym id: "${gymId}"`);
  GYMS[gymId].presentation = sanitizePresentation(input, gymId);
  return GYMS[gymId].presentation;
}

/** Restore the registry's own presentation for a gym. */
function resetPresentation(gymId) {
  if (!GYMS[gymId]) throw new Error(`Unknown gym id: "${gymId}"`);
  GYMS[gymId].presentation = JSON.parse(JSON.stringify(BASELINE_PRESENTATION[gymId]));
  return GYMS[gymId].presentation;
}

/** @returns {Object|null} the registry's own (non-overridden) presentation. */
function getBaselinePresentation(gymId) {
  return BASELINE_PRESENTATION[gymId] ? JSON.parse(JSON.stringify(BASELINE_PRESENTATION[gymId])) : null;
}

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

module.exports = { GYMS, validatePresentation, sanitizePresentation, setPresentation, resetPresentation, getBaselinePresentation, getGymConfig, listGyms, listEnabledGyms, DEFAULT_GYM_ID };
