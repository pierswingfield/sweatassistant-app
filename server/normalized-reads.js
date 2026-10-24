// Shared normalized read boundary for the PWA routes and MCP tools.
const db = require('./db');
const { triggerAutoRelogin } = require('./auth');
const { getProvider } = require('./providers');
const { isRollingWeekly } = require('./providers/booking-window');
const scheduleCache = require('./schedule-cache');
const freshness = require('./freshness');
function resolveContext(userId) {
  // An app account can now exist with NO gym linked at all (signup is
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
    // The app JWT itself is invalid (that case is a 403 — see
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

async function getCurrentProfile(userId, gymId, provider, session) {
  const profile = await withRelogin(userId, session, (s) => provider.getProfile(s));
  // The raw provider profile is the shared persistence shape used by the
  // adapter's booking-window resolver and the admin profile view. Keep it
  // explicitly scoped: merged accounts can refresh several gyms in parallel.
  if (profile && profile.raw && typeof profile.raw === 'object') {
    try { db.cacheUserProfile(userId, profile.raw, gymId); } catch (_) { /* best-effort snapshot; the current response still has the profile */ }
  }
  return profile;
}

async function stampReleaseAt(events, provider, userId, gymId, session) {
  if (!Array.isArray(events) || events.length === 0) return events;
  // Nothing to compute for a gym that publishes per-class releases.
  if (events.every((e) => e && e.releaseAt)) return events;

  const settings = db.getUserSettings(userId, gymId) || {};
  // A rolling-weekly window is per member, so a timetable-first request must
  // fetch this member's profile before it can stamp any computed releases. This
  // uses the provider's existing memo/single-flight path. A provider error must
  // reach the route error handler: falling back to yesterday's persisted cutoff
  // can put the release after the class and make Quick-Book appear available.
  // Other policies (including a per-class gym's declared fallback) do not need
  // the member profile and remain available during an unrelated profile outage.
  const profile = isRollingWeekly(provider.gym)
    ? await getCurrentProfile(userId, gymId, provider, session)
    : null;
  let window = provider.resolveBookingWindow(profile && profile.raw, settings.cachedCredits || []);
  // A debug override still wins, so the "simulate a different tier" workflow
  // keeps working — and is scoped to the same gym as the timetable.
  if (settings.debugMode && settings.manualBookingWindowDays) {
    window = { offsetDays: Number(settings.manualBookingWindowDays), source: 'debug' };
  }

  return events.map((e) => (e && e.releaseAt) ? e : { ...e, releaseAt: provider.releaseAtFor(e.startAt, window) });
}


async function timetable(userId, { startDate = '', endDate = '', refresh = false } = {}) {
  const { gymId, provider, session } = resolveContext(userId);
  const events = await scheduleCache.getOrFetch(`timetable|${gymId}|${startDate}|${endDate}`,
    () => withRelogin(userId, session, s => provider.fetchTimetable({ startDate, endDate }, s)),
    { ttlMs: 60000, force: refresh, ...(require('./mcp/context').current() ? { backgroundRefresh: false, maxStaleMs: 120000, staleIfError: false } : {}), stamp: freshness.stampFor(gymId, provider, session, ['events']), ceilingMs: 300000 });
  return { events: await stampReleaseAt(events, provider, userId, gymId, session) };
}
async function eventDetails(userId, eventId) {
  const { gymId, provider, session } = resolveContext(userId);
  const details = await withRelogin(userId, session, s => provider.fetchEventDetails(eventId, s));
  if (details && details.event) details.event = (await stampReleaseAt([details.event], provider, userId, gymId, session))[0];
  return details;
}
async function bookings(userId) {
  const { provider, session } = resolveContext(userId);
  return { bookings: await withRelogin(userId, session, s => provider.listBookings(s)) };
}
async function credits(userId) {
  const { provider, session } = resolveContext(userId);
  if (typeof provider.getCredits === 'function') return { credits: await withRelogin(userId, session, s => provider.getCredits(s)) };
  const profile = await withRelogin(userId, session, s => provider.getProfile(s));
  return { credits: (profile.raw && profile.raw.available_credits) || [] };
}
function linkedGyms(userId) { return db.getUserGymsPublic(userId); }
function automation(userId, gymId, { limit = 25, offset = 0 } = {}) {
  if (!db.isGymLinked(userId, gymId)) throw Object.assign(new Error('Gym is not linked'), { status: 403 });
  const autoBookings = db.db.prepare('SELECT id, event_id, class_name, start_at, status, release_at, studio_name, location_name FROM auto_bookings WHERE user_id = ? AND gym_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, gymId, limit + 1, offset);
  const autoUpgrades = db.db.prepare('SELECT id, event_id, class_name, start_at, status, studio_name, location_name FROM auto_upgrades WHERE user_id = ? AND gym_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, gymId, limit + 1, offset);
  return { autoBookings: autoBookings.slice(0, limit), autoUpgrades: autoUpgrades.slice(0, limit), hasMore: autoBookings.length > limit || autoUpgrades.length > limit };
}

module.exports = { resolveContext, withRelogin, getCurrentProfile, stampReleaseAt, timetable, eventDetails, bookings, credits, linkedGyms, automation };
