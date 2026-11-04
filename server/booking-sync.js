// T-B (PLAN-teams.md §7.2): universal background booking sync.
//
// THE ONLY background writer of booking_cache and waitlist_cache. Every account,
// every linked gym the member has switched on, is refreshed on a cadence whether
// or not they open the app, have push, have reminders on or use the calendar.
// Before T-B the poller refreshed only push subscribers with cancellation
// reminders on, and calendar.js ran a second fetch-and-write for feed users, so
// a member with neither feature who booked on the gym's website had no upcoming
// classes stored at all, and calendar users were fetched by two jobs.
//
// Consumers read the stored rows: reminders (poller.checkCancellationReminders),
// the calendar feed (calendar.regenerateSnapshot, called after each user's sync),
// Home, and later Teams (T-2). calendar.refreshUser asks this module for a forced
// sync instead of fetching for itself.
//
// Rules this module keeps:
//   - the ROW's gym session (db.getUserSession(userId, gymId)), never the active gym's;
//   - skip, without fetching and without touching stored rows: a disabled gym or
//     link (gymOutbound), a throttled gym (rate-limit-backoff), a link flagged
//     needs_relogin or with relogin suspended (C6-4);
//   - a failed fetch keeps that gym's last good rows; other gyms are unaffected;
//   - writes are scoped to the one gym just fetched.
//
// Other writers that remain: POST /api/bookings/sync (the client pushing what it
// already fetched) and the admin detail page's cache warm. Neither fetches in
// the background.

const { DateTime } = require('luxon');
const db = require('./db');
const { triggerAutoRelogin } = require('./auth');
const { getProvider } = require('./providers');
const gymOutbound = require('./gym-outbound');
const { isGymRateLimited, noteThrottleError } = require('./rate-limit-backoff');
const { formatSpotLabel } = require('./spot-label');

const HOUR = 3600 * 1000;
const PRIORITY_CADENCE_MS = 2 * HOUR;   // members a Team can see (supplied by T-2)
const CALENDAR_CADENCE_MS = 3 * HOUR;   // calendar-feed users: the feed's pre-T-B cadence, kept
const DEFAULT_CADENCE_MS = 6 * HOUR;    // everyone else (the reminder sweep's old cadence)
const FAILURE_RETRY_MS = 30 * 60 * 1000; // a failed gym is retried no sooner than this

// ── Priority set (pluggable) ─────────────────────────────────────────────────
// Returns the user ids that get the 2 h cadence. Teams do not exist yet, so the
// default is empty. T-2 supplies Team members whose upcoming classes a Team can
// see, via setPriorityPredicate(() => teams.visibleMemberIds()).
const EMPTY_PRIORITY = () => new Set();
let priorityPredicate = EMPTY_PRIORITY;
function setPriorityPredicate(fn) { priorityPredicate = typeof fn === 'function' ? fn : EMPTY_PRIORITY; }
function prioritySet() {
  try { return new Set([...(priorityPredicate() || [])].map(Number)); }
  catch (err) { console.warn('[BookingSync] priority predicate failed:', err.message); return new Set(); }
}

function calendarEnabled(userId) {
  try { const s = db.getUserSettings(userId); return !!(s && s.calendar && s.calendar.enabled); }
  catch (_) { return false; }
}

/** The refresh interval for one account. `priority` may be passed to avoid recomputing the set. */
function cadenceFor(userId, priority = prioritySet()) {
  if (priority.has(Number(userId))) return PRIORITY_CADENCE_MS;
  if (calendarEnabled(userId)) return CALENDAR_CADENCE_MS;
  return DEFAULT_CADENCE_MS;
}

// ── Counters (aggregate only: /api/health and /metrics) ─────────────────────
const stats = {
  cycles: 0, usersSynced: 0, gymsSynced: 0, gymsFailed: 0, gymsSkipped: 0,
  skipped: { disabled: 0, throttled: 0, needsRelogin: 0 },
  lastCycleAt: null, lastCycleMs: null,
};
function getStats() { return { ...stats, skipped: { ...stats.skipped } }; }

// ── Fetch + enrich ───────────────────────────────────────────────────────────
async function listWithRelogin(userId, gymId, method) {
  const provider = getProvider(gymId);
  const session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) throw new Error(`no session for ${gymId}`);
  try {
    return await provider[method](session);
  } catch (err) {
    if (!err || err.status !== 401) throw err;
    const jwt = await triggerAutoRelogin(userId, gymId);
    return provider[method]({ ...session, accessToken: jwt });
  }
}

// CodexFit's list endpoints carry no embedded event, so the start time and names
// come from the event; MarianaTek embeds it. The shared per-gym event cache
// (gym-qualified keys) keeps repeat sweeps from re-reading the same class.
async function eventFor(userId, gymId, nb) {
  if (nb.event && nb.event.startAt) return nb.event;
  const { getCachedEvent, setCachedEvent } = require('./scheduler');
  const cached = getCachedEvent(gymId, nb.eventId);
  if (cached && cached.event) return cached.event;
  const details = await getProvider(gymId).fetchEventDetails(nb.eventId, db.getUserSession(userId, gymId));
  if (!details) return null;
  setCachedEvent(gymId, nb.eventId, details, 30000);
  return details.event;
}

function eventFields(ev) {
  return {
    startAt: ev.startAt,
    className: ev.name || 'Class',
    groupName: ev.discipline || '',
    instructorName: ev.instructors?.[0]?.name || '',
    studioName: ev.studioName || '',
    locationName: ev.locationName || '',
    locationAddress: ev.locationAddress || null,
  };
}

/** booking_cache rows for one gym (throws when the gym cannot be read). */
async function bookingRowsFor(userId, gymId) {
  const list = await listWithRelogin(userId, gymId, 'listBookings');
  const rows = [];
  for (const nb of list || []) {
    if (!nb || nb.isWaitlist || !nb.eventId) continue;
    const ev = await eventFor(userId, gymId, nb);
    if (!ev || !ev.startAt) continue;
    rows.push({
      bookingId: nb.bookingId, gymId, eventId: nb.eventId, ...eventFields(ev),
      durationMin: ev.durationMin ?? null,
      slotLabel: formatSpotLabel(gymId, nb.slotLabel ?? nb.slotId ?? '', nb.spotSection),
    });
  }
  return rows;
}

/** waitlist_cache rows for one gym (throws when the gym cannot be read). */
async function waitlistRowsFor(userId, gymId) {
  const list = await listWithRelogin(userId, gymId, 'listWaitlists');
  const rows = [];
  for (const nb of list || []) {
    if (!nb || !nb.eventId) continue;
    const ev = await eventFor(userId, gymId, nb);
    if (!ev || !ev.startAt) continue;
    rows.push({ gymId, eventId: nb.eventId, ...eventFields(ev), studioId: ev.studioId || null });
  }
  return rows;
}

/** Why this link must not be fetched now, or null. Skipped links keep their rows. */
function skipReason(userId, gymId, link = db.getUserGym(userId, gymId)) {
  if (!link || !link.account_enabled || gymOutbound.isOutboundBlocked(gymId, userId)) return 'disabled';
  if (isGymRateLimited(gymId)) return 'throttled';
  if (link.status === 'needs_relogin' || link.relogin_suspended) return 'needsRelogin';
  return null;
}

/**
 * Fetch and store one (user, gym): bookings and waitlists, each written only if
 * its own fetch succeeded, scoped to this gym. `last_synced_at` moves only when
 * both succeeded, so a half-failed gym never passes as fresh.
 */
async function syncUserGym(userId, gymId) {
  const startedAt = new Date().toISOString();
  db.setBookingSyncState(userId, gymId, { lastAttemptAt: startedAt });
  const errors = [];
  let bookings = null;
  let waitlists = null;
  try {
    bookings = await bookingRowsFor(userId, gymId);
    db.replaceBookingCache(userId, bookings, [gymId]);
  } catch (err) { noteThrottleError(gymId, err); errors.push(`bookings: ${err.message}`); }
  // A gym that just failed (or got throttled) is not asked again in this pass;
  // its stored waitlist rows stay as they were.
  if (!errors.length && isGymRateLimited(gymId)) errors.push('waitlists: gym throttled mid-sync');
  if (!errors.length) {
    try {
      waitlists = await waitlistRowsFor(userId, gymId);
      db.replaceWaitlistCache(userId, waitlists, [gymId]);
    } catch (err) { noteThrottleError(gymId, err); errors.push(`waitlists: ${err.message}`); }
  }
  const ok = errors.length === 0;
  db.setBookingSyncState(userId, gymId, ok
    ? { lastSyncedAt: startedAt, lastError: null }
    : { lastError: errors.join('; ').slice(0, 500) });
  if (ok) stats.gymsSynced++; else {
    stats.gymsFailed++;
    console.error(`[BookingSync] ${gymId} failed for user ${userId}: ${errors.join('; ')}`);
  }
  return { ok, bookings, waitlists, error: ok ? null : errors.join('; ') };
}

function isDue(userId, gymId, cadenceMs, now) {
  const st = db.getBookingSyncState(userId, gymId);
  if (!st) return true;
  const synced = st.last_synced_at ? Date.parse(st.last_synced_at) : 0;
  if (now - synced < cadenceMs) return false;
  // Failed recently: wait a little before trying again rather than every tick.
  const attempted = st.last_attempt_at ? Date.parse(st.last_attempt_at) : 0;
  if (st.last_error && now - attempted < FAILURE_RETRY_MS) return false;
  return true;
}

const pause = (jitter) => (jitter ? new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 6000))) : null);

/**
 * Sync one account. `force` ignores the cadence (calendar refresh after a
 * booking mutation, explicit refresh). Calendar users get their snapshot
 * regenerated from the stored rows afterwards.
 */
async function syncUser(userId, { force = false, jitter = false, links = null, priority = null, now = Date.now() } = {}) {
  const userLinks = links || (db.getUserGyms(userId) || []).filter((l) => l.account_enabled);
  const cadence = force ? 0 : cadenceFor(userId, priority || prioritySet());
  const synced = [];
  for (const link of userLinks) {
    const gymId = link.gym_id;
    if (!force && !isDue(userId, gymId, cadence, now)) continue;
    const reason = skipReason(userId, gymId, link);
    if (reason) { stats.gymsSkipped++; stats.skipped[reason]++; continue; }
    await pause(jitter);
    try {
      const r = await syncUserGym(userId, gymId);
      if (r.ok || r.bookings || r.waitlists) synced.push(gymId);
    } catch (err) {
      console.error(`[BookingSync] user ${userId} ${gymId}:`, err.message);
    }
  }
  if (synced.length) {
    stats.usersSynced++;
    if (calendarEnabled(userId)) {
      try { await require('./calendar').afterBookingSync(userId, synced); }
      catch (err) { console.error(`[BookingSync] calendar publish failed for user ${userId}:`, err.message); }
    }
  }
  return synced;
}

let running = null;
/**
 * One pass of the single background loop: every enabled link, synced if due.
 * Overlapping calls share the pass in flight (a slow cycle never doubles up).
 */
function runCycle(opts = {}) {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const jitter = opts.jitter !== false;
    const priority = prioritySet();
    const byUser = new Map();
    for (const l of db.getEnabledGymLinks()) {
      if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
      byUser.get(l.user_id).push({ ...l, account_enabled: 1 });
    }
    for (const [userId, links] of byUser) {
      try { await syncUser(userId, { links, priority, jitter, now: started }); }
      catch (err) { console.error(`[BookingSync] cycle failed for user ${userId}:`, err.message); }
    }
    // Housekeeping: past classes and stale dedupe keys.
    const nowIso = DateTime.now().toISO();
    db.pruneBookingCache(nowIso);
    db.pruneWaitlistCache(nowIso);
    db.pruneSentNotifications(DateTime.now().minus({ days: 30 }).toISO());
    stats.cycles++;
    stats.lastCycleAt = new Date().toISOString();
    stats.lastCycleMs = Date.now() - started;
  })().finally(() => { running = null; });
  return running;
}

module.exports = {
  runCycle,
  syncUser,
  syncUserGym,
  bookingRowsFor,
  waitlistRowsFor,
  skipReason,
  cadenceFor,
  setPriorityPredicate,
  getStats,
  PRIORITY_CADENCE_MS,
  CALENDAR_CADENCE_MS,
  DEFAULT_CADENCE_MS,
  FAILURE_RETRY_MS,
};
