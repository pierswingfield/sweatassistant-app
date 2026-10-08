// Sweat Assistant — normalized API routes (WP-N1).
//
// The first gym-agnostic surface: routes here call through a GymProvider
// adapter and return NormalizedEvent/NormalizedSlot/NormalizedBookingResult
// shapes, instead of raw provider JSON like /api/proxy/* does. AC (PLAN.md
// §4): these return correct normalized shapes for CodexFit — multi-gym
// routing isn't real yet (resolveActiveGymId is still the D3 stub, always
// resolving to the default gym), that's Phase 5 + a real WP-D4.
//
// 401 auto-relogin retry: closed (see withRelogin() below) for every route
// backed by a method that surfaces its HTTP status — reads (fetchTimetable/
// fetchEventDetails/getProfile/getCancelPenalty/listBookings/listWaitlists,
// all fixed in providers/codexfit.js to throw with `.status`) and writes that
// return a NormalizedBookingResult (bookSlot/swapSpots). Mirrors the ladder
// server.js/scheduler.js/poller.js/calendar.js already have.
//
// Deliberately NOT implemented here (documented gap, not an oversight):
//   - cancelBooking/joinWaitlist/leaveWaitlist return a bare boolean today,
//     with no HTTP status attached — a 401 is indistinguishable from any
//     other failure, so retrying blindly would risk masking a real decline.
//     Giving them a status signal is a separate adapter-level change.
//   - The old /api/proxy/* path is UNCHANGED and still what the live client
//     uses (see gyms.config.js comment + PROGRESS.md WP-N2, not started).
//     These routes are additive, not a replacement yet.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const auth = require('./auth');
const classHistory = require('./class-history');
const { authenticateToken, triggerAutoRelogin } = auth;
const { getProvider } = require('./providers');
const { listGyms, getGymConfig } = require('./gyms.config');
const { countSelfBookings, validateSelfBookingLimit } = require('./booking-entitlement');
const calendar = require('./calendar');
const scheduleCache = require('./schedule-cache');
const freshness = require('./freshness');
// Studio floor plans change rarely and are identical for every member: own cache
// instance (own counters), keyed gymId:studioId — provider ids collide across gyms.
const layoutCache = scheduleCache.createCache();
const LAYOUT_TTL_MS = 24 * 60 * 60 * 1000;
const LAYOUT_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// TTLs. The schedule's OCCUPANCY moves minute to minute, so it gets a short TTL
// with stale-while-revalidate — a page is always instant and at most a minute
// behind. Metadata (locations, studios, instructors, class types) changes when
// a gym reorganises, i.e. rarely.
const TIMETABLE_TTL_MS = 60 * 1000;
const METADATA_TTL_MS = 30 * 60 * 1000;

// C2-5 (rebuilt): for providers with freshness stamps (CodexFit /heartbeat) a TTL-stale entry is
// kept while its stamp is unchanged, up to these hard max-ages. The schedule's `events` stamp does
// NOT move on occupancy changes, so spot counts can lag up to TIMETABLE_STAMP_CEILING_MS (accepted,
// as on the official website); write paths (book/cancel) still invalidate immediately.
const TIMETABLE_STAMP_CEILING_MS = 5 * 60 * 1000;
const METADATA_STAMP_CEILING_MS = 6 * 60 * 60 * 1000;
const LAYOUT_STAMP_CEILING_MS = 7 * 24 * 60 * 60 * 1000;

// A booking/waitlist mutation should show in the .ics feed without waiting for
// the 3-hourly cron. This used to be stamped inside the `/api/proxy` handler,
// which meant it silently stopped applying as write paths migrated to the
// normalized routes — and never applied at all to MarianaTek, which never went
// through the proxy. Debounced inside calendar.js; safe to call per mutation.
function refreshCalendar(userId) {
  try { calendar.scheduleRefresh(userId); } catch (_) {}
}

/**
 * A write changed this gym's occupancy, so the shared schedule is stale for
 * EVERYONE, not just the person who booked. Dropping the gym's entries makes
 * the next read re-fetch.
 *
 * Without this the booker refreshes, gets the cached page, and sees the class
 * they just took still showing its old count — which reads as "the booking
 * didn't work" and invites a double booking.
 */
function invalidateSchedule(gymId) {
  if (!gymId) return;
  try {
    scheduleCache.invalidate(`timetable|${gymId}|`);
  } catch (_) {}
}

const router = express.Router();

// C2-4: every GET here is per-user and, for gym-scoped routes, per-gym, but the
// gym travels in the `x-gym-id` HEADER, which is not part of an HTTP cache key.
// Without Vary a browser/proxy cache can hand one gym's (or user's) response to
// another request for the same URL. Routes that set their own Cache-Control
// later (layout, entitlement) override the default below; the Vary stays.
router.use((req, res, next) => {
  if (req.method === 'GET') {
    res.vary('x-gym-id');
    res.vary('Authorization');
    res.set('Cache-Control', 'private, no-cache');
  }
  next();
});

// Resolve (gymId, provider, session) for the current authenticated user, via
// the same seam every other gym-aware code path uses (db.resolveActiveGymId).
// The gym half of resolveContext, for routes that need NO provider session (F-12 local
// favourites): the same NO_GYM_LINKED / GYM_REQUIRED rules, without the 401 for a dead
// gym session, since a local read must not depend on the gym being reachable.
function resolveGymOnly(userId) {
  if (db.getUserGyms(userId).length === 0) {
    const err = new Error('No gym linked to this account yet.');
    err.status = 409;
    err.code = 'NO_GYM_LINKED';
    throw err;
  }
  try {
    return db.resolveGymStrict(userId, null, 'gym-scoped route');
  } catch (e) {
    e.status = 400;
    e.code = 'GYM_REQUIRED';
    throw e;
  }
}

function resolveContext(userId) {
  // A Sweat Assistant account can now exist with NO gym linked at all (signup is
  // gym-independent since Decision D4). That is a legitimate, expected state —
  // not a broken session — so it gets its own signal. Without this the account
  // would resolve to the default gym, find no credential, and surface as
  // "please log in", sending the user round a login loop they cannot win.
  if (db.getUserGyms(userId).length === 0) {
    const err = new Error('No gym linked to this account yet.');
    err.status = 409;
    err.code = 'NO_GYM_LINKED';
    throw err;
  }
  // C3-28: there is no ambient gym. With several linked, a request that names none
  // (no `x-gym-id`) used to fall back to whichever gym the server defaults to and
  // answer for it; now it is a 400, so a forgotten header is an error rather than
  // a plausible answer about the wrong gym. One linked gym is unambiguous.
  let gymId;
  try {
    gymId = db.resolveGymStrict(userId, null, 'gym-scoped route');
  } catch (e) {
    e.status = 400;
    e.code = 'GYM_REQUIRED';
    throw e;
  }
  const provider = getProvider(gymId);
  const user = db.getUserById(userId);
  if (!user || !user.jwt) {
    // C1-2: this 401 means ONE gym's session is missing/dead, not that the
    // Sweat Assistant JWT itself is invalid (that case is a 403 — see
    // auth.js authenticateToken). `code` lets the client branch on that
    // distinction instead of treating every 401 as SA logout.
    const err = new Error('No active session for this gym. Please log in.');
    err.status = 401;
    err.code = 'GYM_SESSION_EXPIRED';
    err.gymId = gymId;
    throw err;
  }
  return { gymId, provider, session: { accessToken: user.jwt } };
}

// Retry an authenticated provider call once after a relogin, if it signals a
// 401 — either by throwing an error with `.status === 401` (reads:
// fetchTimetable/fetchEventDetails/getProfile/getCancelPenalty/listBookings/
// listWaitlists, all fixed to carry `.status` alongside this WP) or by
// resolving with `.status === 401` on a NormalizedBookingResult (writes:
// bookSlot/swapSpots). Mirrors scheduler.js/poller.js/calendar.js's own
// bookSlotWithRelogin/listWithRelogin ladder (WP-N3) — closes the same
// documented gap for routes-normalized.js (previously: "no 401 auto-relogin
// retry", see this file's header comment).
//
// NOT covered: cancelBooking/joinWaitlist/leaveWaitlist, which return a bare
// boolean with no HTTP status signal today — a 401 there is indistinguishable
// from any other failure, so retrying blindly would risk masking a real
// decline as "just needed a relogin." Giving those a status signal is a
// separate, adapter-level change — see PROGRESS.md handoff.
async function withRelogin(userId, session, fn) {
  try {
    const result = await fn(session);
    if (result && result.status === 401) {
      const newJwt = await triggerAutoRelogin(userId);
      return fn({ ...session, accessToken: newJwt });
    }
    return result;
  } catch (err) {
    if (err.status !== 401) throw err;
    const newJwt = await triggerAutoRelogin(userId);
    return fn({ ...session, accessToken: newJwt });
  }
}

function handleError(res, err) {
  const status = err.status || 500;
  // `code` lets the client branch on a state rather than string-matching a
  // message — NO_GYM_LINKED in particular drives a whole different screen,
  // and GYM_SESSION_EXPIRED (C1-2) is what keeps a single gym's dead session
  // from reading as the whole account's SA session expiring.
  const body = { message: err.message };
  if (err.code) body.code = err.code;
  if (err.gymId) body.gymId = err.gymId;
  res.status(status).json(body);
}

// Read limiter (WP-C7-1). Every route below was completely unlimited — only
// /bundles, /bookmarks and /profile/update (extrasLimiter, below) had a
// budget. This is per-USER (all routes below share ONE counter, like
// extrasLimiter), sized from a measured real two-gym browser session
// (dev@psycle.com + JAB linked): app boot + touring all 5 tabs + back to
// timetable produced ~73 combined calls to these routes in under a minute,
// with /my-gyms alone peaking at 16 (every tab/settings render re-checks the
// active gym) — see Documentation/Workstreams/C7-platform-ops.md for the
// full count. A merged N-gym view fires one request per linked gym per
// fetch, so the budget needs multiplicative headroom, not just additive.
// 300/min leaves ~4x over that measured peak. Production-only, same as every
// other limiter here; RATE_LIMIT_TEST_FORCE lets a test force it on without
// NODE_ENV=production, which would also disable the dev@psycle.com mock
// login these routes need in order to be testable at all (see
// providers/codexfit.js DEV_EMAIL gate).
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  message: { message: 'Too many requests — please slow down.' },
  skip: () => process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_TEST_FORCE !== '1',
});

// Tighter budget for the explicit `?refresh=1` bypass on /timetable and
// /metadata — the one read path that skips the shared schedule cache
// (schedule-cache.js) and always hits the provider directly, so it is the
// one read that can genuinely fan out upstream per call. Measured: 3 rapid
// manual-refresh clicks on a two-gym account produced 6 calls (one per gym
// per click) in ~4s. 30/min leaves comfortable headroom for a genuinely
// impatient user while still bounding upstream fan-out from a scripted
// hammer on the refresh control. Only counts refresh=1 requests; a normal
// cached read never touches this counter.
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  message: { message: 'Too many refreshes — please slow down.' },
  skip: (req) => req.query.refresh !== '1'
    || (process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_TEST_FORCE !== '1'),
});

// GET /api/gyms — public: the gym registry + capability flags, for a future
// client gym picker (Phase 5). No auth required — mirrors /api/config.
router.get('/gyms', (req, res) => {
  const gyms = listGyms().map((g) => ({
    id: g.id, name: g.name, shortName: g.shortName, websiteUrl: g.websiteUrl, classPageUrl: g.classPageUrl || null,
    provider: g.provider, enabled: g.enabled,
    // Gym default display zone (client fallback when an event/booking carries none).
    timezone: g.timezone,
    theme: g.theme, labels: g.labels, capabilities: g.capabilities,
    spotSectionPrefixes: g.spotSectionPrefixes || {},
    locationAliases: g.locationAliases || {},
    presentation: g.presentation,
    // Optional human summary of the gym's booking window (gym config bookingWindow.summary).
    bookingWindowSummary: (g.bookingWindow && g.bookingWindow.summary) || null,
    // Per-gym notification DEFAULTS, so the settings UI can show the state a
    // member actually gets before they override anything.
    notifications: g.notifications || {},
  }));
  res.json({ gyms });
});

// GET /api/my-gyms — the gyms THIS account is linked to. The catalogue
// (`GET /gyms`) is public and lists everything configured; this is the
// per-account view Settings → Your Gyms renders from.
//
// No `activeGymId` any more, and no `POST /api/my-gyms/active` — both removed
// in the active-gym audit's stage 4 (2026-09-15). There is no gym switcher:
// every list is merged, and a "current gym" is not a concept this product has.
router.get('/my-gyms', authenticateToken, readLimiter, (req, res) => {
  try {
    const linked = db.getUserGymsPublic(req.userId);
    res.json({ gyms: linked });
  } catch (err) {
    handleError(res, err);
  }
});

// C3-22: the calendar feed spans every linked gym, so changing that set changes
// the feed. Republish now (an unlinked gym's classes must leave the .ics at once,
// not at the next 3-hourly cron) and schedule a refresh so a newly linked gym's
// bookings are pulled in. Only for accounts that actually use the feed; never
// allowed to fail the link/unlink itself.
function refreshCalendarAfterGymSetChange(userId) {
  try {
    const cal = (db.getUserSettings(userId) || {}).calendar || {};
    if (!cal.enabled) return;
    calendar.regenerateSnapshot(userId);
    calendar.scheduleRefresh(userId, 2000);
  } catch (_) { /* best effort */ }
}

// POST /api/my-gyms/link  { gymId, email, password }
// Link a new gym, or re-authenticate one whose stored password has gone stale.
// Same endpoint for both — see auth.linkGymAccount.
router.post('/my-gyms/link', authenticateToken, async (req, res) => {
  const { gymId, email, password } = req.body || {};
  try {
    const link = await auth.linkGymAccount(req.userId, gymId, email, password);
    refreshCalendarAfterGymSetChange(req.userId);
    // F-10-0: backfill class history for the gym just linked (or re-authenticated).
    // Fire-and-forget; syncUserGym never throws and records its own failures.
    classHistory.syncUserGym(req.userId, gymId).catch(() => {});
    res.json({ gym: link, gyms: db.getUserGymsPublic(req.userId) });
  } catch (err) {
    // A rejected gym credential is the user's problem to fix, not a server fault.
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/my-gyms/:gymId — unlink. The account survives (Decision D4).
router.delete('/my-gyms/:gymId', authenticateToken, (req, res) => {
  try {
    const gyms = auth.unlinkGymAccount(req.userId, req.params.gymId);
    refreshCalendarAfterGymSetChange(req.userId);
    res.json({ gyms });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST /api/account/password  { currentPassword, newPassword }
// Change the Sweat Assistant account password — independent of any gym's.
router.post('/account/password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    // A legacy account with no SA password yet can set one without proving an
    // old one — there is nothing to prove, and they already hold a valid session.
    if (db.hasAccountPassword(req.userId) && !db.verifyAccountPassword(req.userId, currentPassword)) {
      return res.status(403).json({ message: 'Current password is incorrect' });
    }
    db.setAccountPassword(req.userId, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});


// Stamp `releaseAt` on events whose gym computes it rather than publishing it
// (WP-D8).
//
// This is the one place the two booking-window worlds meet. A per-class gym
// (MarianaTek) already carries `releaseAt` from its API and is left untouched. A
// rolling-weekly gym (Psycle) has no per-class release to read — the instant
// depends on THIS user's membership window — so the adapter composes it from the
// user's resolved window and the gym's policy.
//
// Doing it here, once, is what lets the client read a timestamp and compute
// nothing. It used to reimplement Psycle's Monday-noon model in lib.js, which
// meant every gym got Psycle's rule whether it applied or not.
function stampReleaseAt(events, provider, userId) {
  if (!Array.isArray(events) || events.length === 0) return events;
  // Nothing to compute for a gym that publishes per-class releases.
  if (events.every((e) => e && e.releaseAt)) return events;

  let window = null;
  try {
    const user = db.getUserById(userId);
    const profile = user && user.profile_json ? JSON.parse(user.profile_json) : null;
    const settings = db.getUserSettings(userId) || {};
    window = provider.resolveBookingWindow(profile, settings.cachedCredits || []);
    // A debug override still wins, so the "simulate a different tier" workflow
    // keeps working — but it is now scoped to the gym whose window it describes.
    if (settings.debugMode && settings.manualBookingWindowDays) {
      window = { offsetDays: Number(settings.manualBookingWindowDays), source: 'debug' };
    }
  } catch (_) { /* fall through to the adapter's own default */ }

  return events.map((e) => (e && e.releaseAt) ? e : { ...e, releaseAt: provider.releaseAtFor(e.startAt, window) });
}

// GET /api/timetable?startDate=&endDate=
router.get('/timetable', authenticateToken, refreshLimiter, readLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';

    // SHARED cache: a gym's schedule is identical for every member, so one
    // provider call serves everyone asking for the same range. Before this,
    // each user's each visit paid a full round trip — which is why the
    // timetable was slow on the SECOND load too, not just the first.
    //
    // The key carries gym AND range; omitting either serves one gym's Tuesday
    // as another's. It deliberately carries NO user id — that is the point.
    const events = await scheduleCache.getOrFetch(
      `timetable|${gymId}|${startDate}|${endDate}`,
      () => withRelogin(req.userId, session, (s) =>
        provider.fetchTimetable({ startDate, endDate }, s)
      ),
      { ttlMs: TIMETABLE_TTL_MS, force: req.query.refresh === '1',
        stamp: freshness.stampFor(gymId, provider, session, ['events']), ceilingMs: TIMETABLE_STAMP_CEILING_MS }
    );

    // `releaseAt` is stamped per request, AFTER the cache. It depends on the
    // member's own booking-window tier, so caching the stamped result would
    // serve one member's release times to another — a correctness bug, where
    // the cache itself is only ever a staleness trade.
    res.json({ events: stampReleaseAt(events, provider, req.userId) });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/metadata — the four lists the timetable filters on (WP-D9).
//
// Replaces four separate raw /api/proxy reads (/locations /studios /instructors
// /event-types), which only ever worked because they were CodexFit endpoints.
// MarianaTek has none of them and derives all four from its class list.
router.get('/metadata', authenticateToken, refreshLimiter, readLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    // Also user-agnostic, and for MarianaTek it is derived from the class list —
    // so an uncached metadata call is a second full timetable fetch.
    const meta = await scheduleCache.getOrFetch(
      `metadata|${gymId}|${startDate}|${endDate}`,
      () => withRelogin(req.userId, session, (s) =>
        provider.fetchMetadata({ startDate, endDate }, s)
      ),
      { ttlMs: METADATA_TTL_MS, force: req.query.refresh === '1',
        stamp: freshness.stampFor(gymId, provider, session, ['locations', 'studios', 'instructors', 'event-types']),
        ceilingMs: METADATA_STAMP_CEILING_MS }
    );
    res.json(meta);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/events/:id
router.get('/events/:id', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const details = await withRelogin(req.userId, session, (s) => provider.fetchEventDetails(req.params.id, s));
    if (details && details.event) {
      details.event = stampReleaseAt([details.event], provider, req.userId)[0];
    }
    res.json(details);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/events/:id/booking-entitlement — fresh, account-scoped provider
// limits for the booking UI. Only adapters with live entitlement data expose
// this; other providers continue using their normalized class cap and credits.
router.get('/events/:id/booking-entitlement', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    if (typeof provider.getBookingEntitlement !== 'function') {
      return res.status(404).json({ code: 'ENTITLEMENT_UNAVAILABLE' });
    }
    const entitlement = await withRelogin(req.userId, session, (s) => provider.getBookingEntitlement(req.params.id, s));
    res.set('Cache-Control', 'no-store');
    res.json(entitlement);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/studios/:id/layout — event-independent studio floor plan (WP-C5),
// for the shared preferred-spot-map editor. Empty `slots` means "no floor map
// available for this studio", not an error (see GymProvider.fetchStudioLayout).
// `objects` are non-bookable fixtures (podium/stage) drawn alongside the slots.
router.get('/studios/:id/layout', authenticateToken, refreshLimiter, readLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    const { slots, objects } = await layoutCache.getOrFetch(
      `layout|${gymId}|${req.params.id}`,
      () => withRelogin(req.userId, session, (s) => provider.fetchStudioLayout(req.params.id, s)),
      { ttlMs: LAYOUT_TTL_MS, maxStaleMs: LAYOUT_MAX_STALE_MS, force: req.query.refresh === '1',
        stamp: freshness.stampFor(gymId, provider, session, ['studios']), ceilingMs: LAYOUT_STAMP_CEILING_MS }
    );
    // Private (per-account auth) but safe to reuse; Express adds the ETag so the
    // client gets conditional 304s.
    res.set('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
    res.json({ slots, objects });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/book  { eventId, slotIds: string[] }
router.post('/book', authenticateToken, async (req, res) => {
  try {
    const { eventId, slotIds } = req.body;
    if (!eventId) return res.status(400).json({ message: 'eventId is required' });
    const { gymId, provider, session } = resolveContext(req.userId);
    // Enforce provider-published per-class limits at the authenticated route,
    // so a caller cannot bypass the spot picker or the client's request check.
    // Guests are separate reservations and do not consume this self-booking cap.
    if (getGymConfig(gymId)?.capabilities?.bookingEntitlement === true) {
      if (typeof provider.getBookingEntitlement !== 'function') {
        return res.status(503).json({ code: 'BOOKING_LIMIT_UNAVAILABLE', message: 'Booking limits could not be confirmed.' });
      }
      const [bookings, entitlement] = await Promise.all([
        withRelogin(req.userId, session, (s) => provider.listBookings(s)),
        withRelogin(req.userId, session, (s) => provider.getBookingEntitlement(eventId, s)),
      ]);
      const currentSelfBookings = countSelfBookings(bookings, eventId);
      const requestedSelfBookings = Array.isArray(slotIds) && slotIds.length ? slotIds.length : 1;
      const check = validateSelfBookingLimit({
        currentSelfBookings,
        requestedSelfBookings,
        selfBookingLimit: entitlement && entitlement.selfBookingLimit,
      });
      if (!check.ok) {
        const message = check.code === 'ATTENDEE_LIMIT_EXCEEDED'
          ? `You can book up to ${check.limit} personal spot${check.limit === 1 ? '' : 's'} for this class.`
          : 'Booking limits could not be confirmed.';
        return res.status(check.code === 'ATTENDEE_LIMIT_EXCEEDED' ? 400 : 503)
          .json({ code: check.code, message });
      }
    }
    const result = await withRelogin(req.userId, session, (s) => provider.bookSlot(eventId, slotIds || [], s));
    if (result && result.ok) { refreshCalendar(req.userId); invalidateSchedule(gymId); }
    if (result && !result.ok && Number.isInteger(result.status) && result.status >= 400) return res.status(result.status).json(result);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/book-guest { eventId, slotId?, guestEmail }
// Guest bookings are a separate attendee flow. The provider rechecks the
// account's pass balance, class eligibility, current availability and payment
// option immediately before creating the reservation.
router.post('/book-guest', authenticateToken, async (req, res) => {
  try {
    const { eventId, slotId, guestEmail } = req.body || {};
    if (!eventId) return res.status(400).json({ code: 'EVENT_REQUIRED', message: 'eventId is required' });
    const { gymId, provider, session } = resolveContext(req.userId);
    if (typeof provider.bookGuestSlot !== 'function') {
      return res.status(403).json({ code: 'GUEST_BOOKING_UNSUPPORTED', message: 'Guest booking is not available at this gym.' });
    }
    // A guest belongs to the member's reservation, not a standalone class
    // attendee. Resolve the live host first so cancellation can retain a
    // durable provider-independent relationship.
    const existing = await withRelogin(req.userId, session, (s) => provider.listBookings(s));
    const primary = existing.find((booking) => String(booking.eventId) === String(eventId) && !booking.isGuest);
    if (!primary) {
      return res.status(409).json({ code: 'PRIMARY_BOOKING_REQUIRED', message: 'Book your own spot before adding a guest.' });
    }
    const result = await withRelogin(req.userId, session, (s) => provider.bookGuestSlot(eventId, slotId ?? null, guestEmail, s));
    if (result && result.ok) {
      db.upsertGuestBookingGroup(req.userId, gymId, eventId, primary.bookingId, result.bookingId);
      refreshCalendar(req.userId); invalidateSchedule(gymId);
    }
    if (result && !result.ok && Number.isInteger(result.status) && result.status >= 400) return res.status(result.status).json(result);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Cancel one reservation without allowing a member reservation to leave behind
 * a guest. The durable edge is the fast path; the provider list repairs groups
 * created before it existed or after a stale client. Guest cancellations happen
 * first. A guest failure leaves the member reservation untouched.
 */
async function cancelReservationGroup({ userId, gymId, provider, session, bookingId }) {
  const edges = db.getGuestBookingGroupByMember(userId, gymId, bookingId);
  let bookings;
  try {
    bookings = await withRelogin(userId, session, (s) => provider.listBookings(s));
  } catch (_) {
    const err = new Error('Could not confirm linked guest reservations. Your booking has not been cancelled; refresh and try again.');
    err.status = 503;
    err.code = 'CANCELLATION_STATE_UNAVAILABLE';
    throw err;
  }
  const target = bookings.find((booking) => String(booking.bookingId) === String(bookingId));
  const targetIsGuest = !!target?.isGuest || edges.some((edge) => String(edge.guest_booking_id) === String(bookingId));
  if (targetIsGuest) {
    const ok = await provider.cancelBooking(bookingId, session);
    if (ok) db.deleteGuestBookingGroupForGuest(userId, gymId, bookingId);
    return { ok, cancelledIds: ok ? [String(bookingId)] : [], primaryBookingId: null };
  }

  const eventId = target?.eventId || edges.find((edge) => String(edge.primary_booking_id) === String(bookingId))?.event_id;
  const persistedGuestIds = db.getGuestBookingIdsForPrimary(userId, gymId, bookingId);
  const liveGuestIds = eventId == null ? [] : bookings
    .filter((booking) => booking.isGuest && String(booking.eventId) === String(eventId))
    .map((booking) => String(booking.bookingId));
  const guestIds = [...new Set([...persistedGuestIds, ...liveGuestIds])];
  const cancelledIds = [];
  for (const guestId of guestIds) {
    const guestOk = await provider.cancelBooking(guestId, session);
    if (!guestOk) {
      return {
        ok: false,
        code: 'GUEST_CANCELLATION_FAILED',
        message: 'Your guest spot could not be cancelled. Your own booking is unchanged; try again or cancel the guest from Edit booking.',
        cancelledIds,
        primaryBookingId: String(bookingId),
      };
    }
    db.deleteGuestBookingGroupForGuest(userId, gymId, guestId);
    cancelledIds.push(guestId);
  }
  const ok = await provider.cancelBooking(bookingId, session);
  if (ok) db.deleteGuestBookingGroupsForPrimary(userId, gymId, bookingId);
  return {
    ok,
    code: ok ? undefined : 'PRIMARY_CANCELLATION_FAILED',
    message: ok ? undefined : 'Your guest spot was cancelled, but your own booking is unchanged. Refresh before trying again.',
    cancelledIds: ok ? [...cancelledIds, String(bookingId)] : cancelledIds,
    primaryBookingId: String(bookingId),
  };
}

// POST /api/cancel  { bookingId }
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });
    const { gymId, provider, session } = resolveContext(req.userId);
    const result = await cancelReservationGroup({ userId: req.userId, gymId, provider, session, bookingId });
    if (result.ok) {
      // Server-side, so every cancel path (timetable, bookings, edit modal) is covered.
      try { db.stopAutoUpgradesForBooking(req.userId, gymId, bookingId); } catch (e) { console.error('[Cancel] stop monitor failed:', e.message); }
      refreshCalendar(req.userId); invalidateSchedule(gymId);
    }
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/cancel-penalty/:bookingId
router.get('/cancel-penalty/:bookingId', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const penalty = await withRelogin(req.userId, session, (s) => provider.getCancelPenalty(req.params.bookingId, s));
    res.json(penalty);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/waitlist/join  { eventId }
router.post('/waitlist/join', authenticateToken, async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ message: 'eventId is required' });
    const { gymId, provider, session } = resolveContext(req.userId);
    const ok = await provider.joinWaitlist(eventId, session);
    if (ok) { refreshCalendar(req.userId); invalidateSchedule(gymId); }
    res.json({ ok });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/waitlist/leave  { eventId }
router.post('/waitlist/leave', authenticateToken, async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ message: 'eventId is required' });
    const { gymId, provider, session } = resolveContext(req.userId);
    const ok = await provider.leaveWaitlist(eventId, session);
    if (ok) { refreshCalendar(req.userId); invalidateSchedule(gymId); }
    res.json({ ok });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/swap  { bookingId, currentSlotId, targetSlotId }
router.post('/swap', authenticateToken, async (req, res) => {
  try {
    const { bookingId, currentSlotId, targetSlotId } = req.body;
    if (!bookingId || !targetSlotId) return res.status(400).json({ message: 'bookingId and targetSlotId are required' });
    const { gymId, provider, session } = resolveContext(req.userId);
    const result = await withRelogin(req.userId, session, (s) => provider.swapSpots(bookingId, currentSlotId, targetSlotId, s));
    if (result && result.ok) { refreshCalendar(req.userId); invalidateSchedule(gymId); }
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/bookings — normalized active bookings. NOTE: for CodexFit these come
// back WITHOUT embedded event details (see providers/codexfit.js listBookings
// doc comment) — callers needing full metadata should join via /api/events/:id
// or /api/timetable, same as the existing client already does for the raw proxy.
router.get('/bookings', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const bookings = await withRelogin(req.userId, session, (s) => provider.listBookings(s));
    res.json({ bookings });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/waitlists — normalized active waitlist entries.
router.get('/waitlists', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const waitlists = await withRelogin(req.userId, session, (s) => provider.listWaitlists(s));
    res.json({ waitlists });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/history?days=30&limit=200&top=5 — F-10-0: the member's class history for
// the gym named by x-gym-id (normalized rows from the local store, never `.raw`), plus
// the sync state and the top instructors over the same window. The first call for a
// gym backfills (awaited); later calls serve the store and refresh it in the background
// when stale. A failed pull still answers 200 with whatever is stored and the error
// on `sync`, so one dead gym cannot blank a widget.
router.get('/history', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { gymId } = resolveContext(req.userId);
    const days = Math.max(1, Math.min(3650, parseInt(req.query.days, 10) || 365));
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 200));
    const top = Math.max(0, Math.min(20, req.query.top === undefined ? 5 : parseInt(req.query.top, 10) || 0));
    await classHistory.ensureHistory(req.userId, gymId);
    const sinceDate = new Date(Date.now() - days * 864e5).toISOString();
    res.json({
      gymId,
      sync: classHistory.getSyncState(req.userId, gymId),
      history: classHistory.listHistory(req.userId, gymId, { sinceDate, limit }),
      topInstructors: top ? classHistory.topInstructors(req.userId, gymId, { days, limit: top }) : [],
      // All-time normalized-history activity. This remains a booking summary;
      // official attendance belongs to the capability-gated route below.
      summary: classHistory.summary(req.userId, gymId),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/profile — normalized profile.
router.get('/profile', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    const profile = await withRelogin(req.userId, session, (s) => provider.getProfile(s));
    // Stamped so the client never has to infer which gym this profile describes.
    // The booking window is derived from ITS cutoffs and saved as a gym-scoped
    // setting, so the answer has to travel with the data rather than be guessed.
    res.json({ ...profile, gymId });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/credits — provider-specific: CodexFit embeds credits in its
// profile response, MT exposes a separate getCredits() extension method (see
// providers/marianatek.js WP-M4). Branch on which the active provider offers
// rather than assuming one shape.
router.get('/credits', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    if (typeof provider.getCredits === 'function') {
      const credits = await withRelogin(req.userId, session, (s) => provider.getCredits(s));
      return res.json({ credits });
    }
    const profile = await withRelogin(req.userId, session, (s) => provider.getProfile(s));
    res.json({ credits: (profile.raw && profile.raw.available_credits) || [] });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/eligibility — "can this account book at all" (WP-J), distinct from
// `metered`/`creditPurchase`. Every adapter answers this (base.js defaults to
// permissive so an adapter with no real implementation never blocks booking).
router.get('/eligibility', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const eligibility = await withRelogin(req.userId, session, (s) => provider.getEligibility(s));
    res.json(eligibility);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/membership — normalized account membership. Credit-based providers
// return null; they remain represented by /api/credits rather than a synthetic
// membership object.
router.get('/membership', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const membership = await withRelogin(req.userId, session, (s) => provider.getMembership(s));
    res.json({ membership });
  } catch (err) {
    handleError(res, err);
  }
});

// --- Capability-gated provider extras (WP-D9: what replaced /api/proxy) ------
//
// These three features exist on one platform only. That is precisely why they
// get routes: the alternative was the client composing raw CodexFit URLs and
// posting them through a passthrough, which is what kept `/api/proxy` alive.
// A route that only one platform implements is fine; a client that knows a
// platform's URL shape is not.
//
// Each rejects on the GYM'S capability flag before touching the provider, so a
// gym without the feature answers 501 rather than a confusing adapter error.
// Same budget the removed `/api/proxy/*` had (60/min per user, production
// only), so the routes that replaced its callers are no less protected than
// what they replaced.
//
// NOTE the wider gap this does NOT close: the rest of the normalized surface
// (timetable, metadata, bookings, book/cancel/waitlist…) has never been rate
// limited, because the limiters live in server.js and are applied per route
// while these are mounted as a router. Applying one blanket limiter here would
// change live behaviour for read paths that legitimately burst — an 8-week
// timetable prefetch is many requests in a few seconds — so it needs its own
// measured budget rather than inheriting this one. Logged in Documentation.
const extrasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  message: { message: 'Too many requests — please slow down.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

function requireCapability(gymId, capability) {
  const gym = getGymConfig(gymId);
  if (!gym || !gym.capabilities || !gym.capabilities[capability]) {
    const err = new Error(`This gym does not support ${capability}.`);
    err.status = 501;
    err.code = 'CAPABILITY_UNSUPPORTED';
    throw err;
  }
}

// GET /api/bundles — purchasable credit packs (metered gyms with creditPurchase).
router.get('/bundles', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    requireCapability(gymId, 'creditPurchase');
    const result = await withRelogin(req.userId, session, (s) => provider.listBundles(s));
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/attendance-totals — provider-published attended total, this week/month/year and
// milestones (gyms with capabilities.attendanceTotals; 501 otherwise). F-10-8 "provided" stats.
router.get('/attendance-totals', authenticateToken, readLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    requireCapability(gymId, 'attendanceTotals');
    const totals = await withRelogin(req.userId, session, (s) => provider.getMilestones(s));
    res.json({ gymId, ...totals });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT|DELETE /api/bookmarks/:identifier — add/remove a saved class.
// The identifier is the provider's own bookmark key; the client round-trips
// whatever the adapter gave it and composes no path of its own.
router.put('/bookmarks/:identifier', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    requireCapability(gymId, 'bookmarks');
    const ok = await withRelogin(req.userId, session, (s) => provider.setBookmark(req.params.identifier, true, s));
    res.json({ ok });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/bookmarks/:identifier', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    requireCapability(gymId, 'bookmarks');
    const ok = await withRelogin(req.userId, session, (s) => provider.setBookmark(req.params.identifier, false, s));
    res.json({ ok });
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// F-12 — gym-neutral FAVOURITES. One contract for every gym: a favourite is a recurring
// slot (studio + weekday + start time, class-local). A gym that declares
// `capabilities.bookmarks` stores them natively (provider.listFavourites/setFavourite);
// every other gym uses the local `favourites` table. The route reads the CAPABILITY,
// never the platform, so a future gym with native favourites needs no change here.
// The id is the native-style key (`studio0000dow0000HHmm`) in both modes. The older
// /api/bookmarks/:identifier routes above stay for compatibility; the client uses these.
// -------------------------------------------------------------
const favouriteStore = require('./favourites');
const MAX_FAVOURITES_PER_GYM = 200;
const hasNativeFavourites = (gymId) => !!(getGymConfig(gymId)?.capabilities?.bookmarks);

// GET /api/favourites → { gymId, native, favourites: [{ id, studioId, dayOfWeek, startTime, …labels }] }
router.get('/favourites', authenticateToken, readLimiter, async (req, res) => {
  try {
    if (hasNativeFavourites(resolveGymOnly(req.userId))) {
      const { gymId, provider, session } = resolveContext(req.userId);
      const slots = await withRelogin(req.userId, session, (s) => provider.listFavourites(s));
      return res.json({ gymId, native: true, favourites: slots.map(favouriteStore.makeFavourite) });
    }
    const gymId = resolveGymOnly(req.userId);
    res.json({ gymId, native: false, favourites: db.listFavourites(req.userId, gymId).map(favouriteStore.makeFavourite) });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/favourites  { studioId, dayOfWeek, startTime, className?, … } → { ok, id }   (idempotent)
router.put('/favourites', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const v = favouriteStore.validateSlot(req.body);
    if (!v.ok) return res.status(400).json({ message: v.error, code: 'INVALID_FAVOURITE' });
    const gymId = resolveGymOnly(req.userId);
    if (hasNativeFavourites(gymId)) {
      const ctx = resolveContext(req.userId);
      await withRelogin(req.userId, ctx.session, (s) => ctx.provider.setFavourite(v.value, true, s));
    } else {
      const existing = db.listFavourites(req.userId, gymId);
      const isNew = !existing.some((f) => favouriteStore.toIdentifier(f) === favouriteStore.toIdentifier(v.value));
      if (isNew && existing.length >= MAX_FAVOURITES_PER_GYM) {
        return res.status(429).json({ message: `You can save up to ${MAX_FAVOURITES_PER_GYM} favourites per gym.`, code: 'FAVOURITE_LIMIT' });
      }
      db.addFavourite(req.userId, gymId, v.value);
    }
    res.json({ ok: true, gymId, id: favouriteStore.toIdentifier(v.value) });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/favourites/:id   (id = the key GET returned)
router.delete('/favourites/:id', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const slot = favouriteStore.parseIdentifier(req.params.id);
    if (!slot) return res.status(400).json({ message: 'Unrecognised favourite id.', code: 'INVALID_FAVOURITE' });
    const gymId = resolveGymOnly(req.userId);
    if (hasNativeFavourites(gymId)) {
      const ctx = resolveContext(req.userId);
      await withRelogin(req.userId, ctx.session, (s) => ctx.provider.setFavourite(slot, false, s));
    } else {
      db.removeFavourite(req.userId, gymId, slot);
    }
    res.json({ ok: true, gymId, id: req.params.id });
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// In-app credit purchase — CodexFit v2 cart (C2-1, 2026-09-26)
// -------------------------------------------------------------
// Moved here (from server.js, which used to hardcode CodexFit's retired v1
// cart paths directly) so the route layer stays gym-agnostic like every other
// route in this file — everything provider-specific lives behind
// provider.initCart/addBundleToCart/finaliseCart/... (providers/codexfit.js,
// protocol in its codexfit-cart.js helper), gated on `creditPurchase` exactly
// like /api/bundles above. Client contract is UNCHANGED from the old v1 flow
// (POST /api/cart/checkout/init/:bundleId → POST /api/cart/checkout/confirm,
// including the `requires_action` → website-fallback shape client/src/ui/
// credits.js already handles) — see Documentation/Workstreams/
// C2-psycle-api-v2.md's C2-1 scope. The payment-method/checkout/finalise
// steps are UNVERIFIED against live Psycle (no purchase was ever made — see
// server/fixtures/codexfit-v2/PARITY.md G3); flagged again on
// provider.finaliseCart's doc comment.

// Step 1: create a v2 cart, add the bundle `quantity` times, list saved cards.
router.post('/cart/checkout/init/:bundleId', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    requireCapability(gymId, 'creditPurchase');
    // Express route params are always strings; CodexFit's bundle ids are
    // numeric and the v2 add-line body must send a number (mock.js and — per
    // psycle_codexfit.md §2.5.2 #3 — the real API both compare/serialize it
    // as one). Falls back to the raw param if somehow non-numeric rather than
    // silently sending NaN.
    const parsedBundleId = Number(req.params.bundleId);
    const bundleId = Number.isFinite(parsedBundleId) ? parsedBundleId : req.params.bundleId;
    const qty = Math.max(1, Math.min(10, parseInt(req.body?.quantity) || 1));

    const cartData = await withRelogin(req.userId, session, (s) => provider.initCart(s));
    await withRelogin(req.userId, session, (s) => provider.addBundleToCart(cartData.uuid, bundleId, qty, s));
    const methods = await withRelogin(req.userId, session, (s) => provider.listCartPaymentMethods(s));

    res.json({ success: true, instance: cartData.uuid, methods: methods || [] });
  } catch (err) {
    handleError(res, err);
  }
});

// Step 2: attach the chosen saved card, checkout, finalise, and poll until
// Stripe settles (mirrors the old v1 flow's polling exactly — the v2 doc
// names no distinct status endpoint, and GET /orders/{id} is unaffected by
// the cart migration; see provider.getOrder's doc comment). NOTE: 3-D Secure
// is not supported — an off-session charge that needs authentication comes
// back as `requires_action` and the client falls back to the website.
router.post('/cart/checkout/confirm', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const { gymId, provider, session } = resolveContext(req.userId);
    requireCapability(gymId, 'creditPurchase');
    const { instance, paymentMethodId } = req.body || {};
    if (!instance || !paymentMethodId) {
      return res.status(400).json({ message: 'instance and paymentMethodId are required' });
    }

    await withRelogin(req.userId, session, (s) => provider.attachCartPaymentMethod(instance, paymentMethodId, s));
    const { orderId } = await withRelogin(req.userId, session, (s) => provider.finaliseCart(instance, {
      user_agent: req.headers['user-agent'],
    }, s));

    if (!orderId) {
      return res.status(502).json({ message: 'Checkout was accepted but no order ID was returned' });
    }

    const maxAttempts = 40; // ~40s, same window the retired v1 flow polled for
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const order = await withRelogin(req.userId, session, (s) => provider.getOrder(orderId, s));

      if (order && order.status === 'Paid') {
        return res.json({ status: 'paid', orderId });
      }

      const payErr = order && order.metadata && order.metadata.payment_intent && order.metadata.payment_intent.last_payment_error;
      if (payErr) {
        const needsAuth = payErr.code === 'authentication_required' || payErr.decline_code === 'authentication_required';
        return res.json({
          status: needsAuth ? 'requires_action' : 'failed',
          orderId,
          error: payErr.message || 'The card was declined.',
        });
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    // Never settled in our window — almost always a 3-D Secure challenge the
    // saved-card off-session flow can't complete.
    res.json({ status: 'requires_action', orderId, error: 'Payment requires authentication.' });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/profile/update — the Profile Explorer's hidden edit mode.
// Not capability-gated on a flag (there isn't one): it is gated by the adapter,
// which throws notImplemented for any provider that has not implemented it.
router.post('/profile/update', authenticateToken, extrasLimiter, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const result = await withRelogin(req.userId, session, (s) => provider.updateProfile(req.body || {}, s));
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
// Exposed for direct testing of the 401-relogin ladder (test-routes-normalized.js),
// same rationale calendar.js exports listWithRelogin — router itself stays the
// default export so `require('./routes-normalized')` in server.js is unchanged.
module.exports.withRelogin = withRelogin;
module.exports.layoutCacheStats = () => layoutCache.getStats();
module.exports.cancelReservationGroup = cancelReservationGroup;
