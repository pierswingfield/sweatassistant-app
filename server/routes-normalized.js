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
const db = require('./db');
const auth = require('./auth');
const { authenticateToken, triggerAutoRelogin } = auth;
const { getProvider } = require('./providers');
const { listGyms } = require('./gyms.config');

const router = express.Router();

// Resolve (gymId, provider, session) for the current authenticated user, via
// the same seam every other gym-aware code path uses (db.resolveActiveGymId).
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
  const gymId = db.resolveActiveGymId(userId);
  const provider = getProvider(gymId);
  const user = db.getUserById(userId);
  if (!user || !user.jwt) {
    const err = new Error('No active session for this gym. Please log in.');
    err.status = 401;
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
  // message — NO_GYM_LINKED in particular drives a whole different screen.
  const body = { message: err.message };
  if (err.code) body.code = err.code;
  res.status(status).json(body);
}

// GET /api/gyms — public: the gym registry + capability flags, for a future
// client gym picker (Phase 5). No auth required — mirrors /api/config.
router.get('/gyms', (req, res) => {
  const gyms = listGyms().map((g) => ({
    id: g.id, name: g.name, provider: g.provider, enabled: g.enabled,
    theme: g.theme, labels: g.labels, capabilities: g.capabilities,
  }));
  res.json({ gyms });
});

// GET /api/my-gyms — the gyms THIS account is linked to, plus which one is
// currently active. The catalogue (`GET /gyms`) is public and lists everything
// configured; this is the per-account view the switcher renders from.
router.get('/my-gyms', authenticateToken, (req, res) => {
  try {
    const linked = db.getUserGymsPublic(req.userId);
    res.json({ gyms: linked, activeGymId: db.getActiveGymId(req.userId) });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/my-gyms/active  { gymId } — persist the user's gym choice.
// db.setActiveGym re-validates the link itself; this route does not pre-check,
// so there is exactly one place that decides whether a switch is allowed.
router.post('/my-gyms/active', authenticateToken, (req, res) => {
  const { gymId } = req.body || {};
  if (!gymId) return res.status(400).json({ message: 'gymId is required' });
  try {
    res.json({ activeGymId: db.setActiveGym(req.userId, gymId) });
  } catch (err) {
    // Unknown / disabled / unlinked are all "you may not select this", not 500s.
    return res.status(403).json({ message: err.message });
  }
});

// POST /api/my-gyms/link  { gymId, email, password }
// Link a new gym, or re-authenticate one whose stored password has gone stale.
// Same endpoint for both — see auth.linkGymAccount.
router.post('/my-gyms/link', authenticateToken, async (req, res) => {
  const { gymId, email, password } = req.body || {};
  try {
    const link = await auth.linkGymAccount(req.userId, gymId, email, password);
    res.json({ gym: link, gyms: db.getUserGymsPublic(req.userId) });
  } catch (err) {
    // A rejected gym credential is the user's problem to fix, not a server fault.
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/my-gyms/:gymId — unlink. The account survives (Decision D4).
router.delete('/my-gyms/:gymId', authenticateToken, (req, res) => {
  try {
    res.json({ gyms: auth.unlinkGymAccount(req.userId, req.params.gymId) });
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
router.get('/timetable', authenticateToken, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const events = await withRelogin(req.userId, session, (s) =>
      provider.fetchTimetable({ startDate: req.query.startDate, endDate: req.query.endDate }, s)
    );
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
router.get('/metadata', authenticateToken, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const meta = await withRelogin(req.userId, session, (s) =>
      provider.fetchMetadata({ startDate: req.query.startDate, endDate: req.query.endDate }, s)
    );
    res.json(meta);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/events/:id
router.get('/events/:id', authenticateToken, async (req, res) => {
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

// GET /api/studios/:id/layout — event-independent studio floor plan (WP-C5),
// for the shared preferred-spot-map editor. Empty `slots` means "no floor map
// available for this studio", not an error (see GymProvider.fetchStudioLayout).
// `objects` are non-bookable fixtures (podium/stage) drawn alongside the slots.
router.get('/studios/:id/layout', authenticateToken, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const { slots, objects } = await withRelogin(req.userId, session, (s) => provider.fetchStudioLayout(req.params.id, s));
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
    const { provider, session } = resolveContext(req.userId);
    const result = await withRelogin(req.userId, session, (s) => provider.bookSlot(eventId, slotIds || [], s));
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/cancel  { bookingId }
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });
    const { provider, session } = resolveContext(req.userId);
    const ok = await provider.cancelBooking(bookingId, session);
    res.json({ ok });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/cancel-penalty/:bookingId
router.get('/cancel-penalty/:bookingId', authenticateToken, async (req, res) => {
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
    const { provider, session } = resolveContext(req.userId);
    const ok = await provider.joinWaitlist(eventId, session);
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
    const { provider, session } = resolveContext(req.userId);
    const ok = await provider.leaveWaitlist(eventId, session);
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
    const { provider, session } = resolveContext(req.userId);
    const result = await withRelogin(req.userId, session, (s) => provider.swapSpots(bookingId, currentSlotId, targetSlotId, s));
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/bookings — normalized active bookings. NOTE: for CodexFit these come
// back WITHOUT embedded event details (see providers/codexfit.js listBookings
// doc comment) — callers needing full metadata should join via /api/events/:id
// or /api/timetable, same as the existing client already does for the raw proxy.
router.get('/bookings', authenticateToken, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const bookings = await withRelogin(req.userId, session, (s) => provider.listBookings(s));
    res.json({ bookings });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/waitlists — normalized active waitlist entries.
router.get('/waitlists', authenticateToken, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const waitlists = await withRelogin(req.userId, session, (s) => provider.listWaitlists(s));
    res.json({ waitlists });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/profile — normalized profile.
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const { provider, session } = resolveContext(req.userId);
    const profile = await withRelogin(req.userId, session, (s) => provider.getProfile(s));
    res.json(profile);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/credits — provider-specific: CodexFit embeds credits in its
// profile response, MT exposes a separate getCredits() extension method (see
// providers/marianatek.js WP-M4). Branch on which the active provider offers
// rather than assuming one shape.
router.get('/credits', authenticateToken, async (req, res) => {
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

module.exports = router;
// Exposed for direct testing of the 401-relogin ladder (test-routes-normalized.js),
// same rationale calendar.js exports listWithRelogin — router itself stays the
// default export so `require('./routes-normalized')` in server.js is unchanged.
module.exports.withRelogin = withRelogin;
