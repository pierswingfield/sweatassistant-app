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
// The client's POST /api/bookings/sync goes through acceptClientBookings() here:
// it is ignored for a gym this module synced recently or is syncing now, and
// otherwise merged so the sync's enrichment (duration, address) survives. The
// admin detail page reads only.

const { DateTime } = require('luxon');
const db = require('./db');
const auth = require('./auth'); // called as auth.triggerAutoRelogin so tests can stub it
const { getProvider } = require('./providers');
const gymOutbound = require('./gym-outbound');
const { isGymRateLimited, noteThrottleError } = require('./rate-limit-backoff');
const { formatSpotLabel } = require('./spot-label');

const HOUR = 3600 * 1000;
const PRIORITY_CADENCE_MS = 2 * HOUR;   // members a Team can see (supplied by T-2)
const CALENDAR_CADENCE_MS = 3 * HOUR;   // calendar-feed users: the feed's pre-T-B cadence, kept
const DEFAULT_CADENCE_MS = 6 * HOUR;    // everyone else (the reminder sweep's old cadence)
const FAILURE_RETRY_MS = 30 * 60 * 1000; // a failed gym is retried no sooner than this
const CLIENT_PUSH_GRACE_MS = 5 * 60 * 1000; // a server sync this recent beats a client push
const MAX_LANES = 3;                      // gyms fetched concurrently in one cycle (one lane per gym)
const BOOT_STAGGER_MS = 60 * 1000;        // first cycle after boot: each lane starts after a random 0-60 s
// T-2: a gym's booking list drops a class once it starts, but a Team's day (done classes,
// the mascot's ring) still needs it. Server rows that started within this window survive
// a re-sync; the cycle prunes anything older.
const RETAIN_STARTED_MS = 24 * HOUR;
// Forced syncs (calendar refresh after a book/cancel, an explicit refresh) skip the
// cadence, so they get their own budget per (user, gym): at most FORCED_MAX in any
// FORCED_WINDOW_MS. Past it a forced call is skipped quietly ('forceLimited'; the stored
// rows stay) and ONE trailing forced sync is deferred to the moment the window frees a
// slot, so the latest book/cancel still lands in minutes rather than waiting for the 2-6 h
// cadence (a cancelled booking would otherwise keep showing to the Team, and keep granting
// D13 spot visibility, that long). The trailing run takes a slot like any other, so one gym
// hit by one account cannot be driven harder than this however often its client asks.
const FORCED_WINDOW_MS = 10 * 60 * 1000;
const FORCED_MAX = 6;

// ── Priority set (pluggable) ─────────────────────────────────────────────────
// Returns the user ids that get the 2 h cadence. Teams do not exist yet, so the
// default is empty; server.js installs teams.priorityMemberIds() (T-2): members a
// Team can see the upcoming classes of.
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
  cycles: 0, ticksSkipped: 0, usersSynced: 0, gymsSynced: 0, gymsFailed: 0, gymsSkipped: 0,
  skipped: { disabled: 0, throttled: 0, needsRelogin: 0, forceLimited: 0 },
  forceDeferred: 0,
  lastCycleAt: null, lastCycleMs: null,
};
// ── New-booking listener (T-5) ───────────────────────────────────────────────
// Teams' "a teammate booked a class you're in" push. Called after a successful
// server write with the rows that are NEW as server rows for that (user, gym):
// absent before, or held only as a client push until now. Never on a link's
// first ever sync (every row would look new). Fire-and-forget: a failing
// listener never fails the sync.
let newBookingsListener = null;
function setNewBookingsListener(fn) { newBookingsListener = typeof fn === 'function' ? fn : null; }

/** Pure: rows of `incoming` whose gym-qualified booking id was not a server row in `prevRows`. */
function newServerBookings(prevRows, incoming, gymId) {
  const had = new Set((prevRows || []).filter((r) => r && r.origin === 'server').map((r) => `${gymId}:${r.booking_id}`));
  return (incoming || []).filter((b) => b && b.bookingId != null && !had.has(`${gymId}:${b.bookingId}`));
}

const seenBookingKey = (gymId, bookingId) => `team:seen:${gymId}:${bookingId}`;

function getStats() { return { ...stats, skipped: { ...stats.skipped } }; }

// ── Fetch + enrich ───────────────────────────────────────────────────────────
async function listWithRelogin(userId, gymId, method) {
  gymOutbound.assertOutboundAllowed(gymId, userId);
  const provider = getProvider(gymId);
  const session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) throw new Error(`no session for ${gymId}`);
  try {
    return await provider[method](session);
  } catch (err) {
    if (!err || err.status !== 401) throw err;
    const jwt = await auth.triggerAutoRelogin(userId, gymId);
    return require('./gym-connection').retrySessionCall(userId, gymId, jwt, () => provider[method]({ ...session, accessToken: jwt }));
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

// One fetch per (user, gym) at a time, shared by the cycle and forced syncs, so
// an older fetch can never land after a newer one and overwrite post-mutation
// rows. A non-forced caller joins the fetch in flight; a FORCED caller (after a
// book/cancel) may have mutated after that fetch began, so it gets one more
// fetch that starts once the in-flight one has written (concurrent forced
// callers share that rerun).
const inflight = new Map(); // `${userId}:${gymId}` -> { promise, rerun }
const flightKey = (userId, gymId) => `${userId}:${gymId}`;
function isSyncInFlight(userId, gymId) { return inflight.has(flightKey(userId, gymId)); }

/**
 * Fetch and store one (user, gym): bookings and waitlists, each written only if
 * its own fetch succeeded, scoped to this gym. `last_synced_at` moves only when
 * both succeeded, so a half-failed gym never passes as fresh.
 */
function syncUserGym(userId, gymId, { force = false } = {}) {
  const key = flightKey(userId, gymId);
  const cur = inflight.get(key);
  if (cur) {
    if (!force) return cur.promise;
    if (!cur.rerun) cur.rerun = cur.promise.catch(() => {}).then(() => syncUserGym(userId, gymId));
    return cur.rerun;
  }
  const entry = { promise: null, rerun: null };
  entry.promise = fetchAndStore(userId, gymId).finally(() => {
    if (inflight.get(key) === entry) inflight.delete(key);
  });
  inflight.set(key, entry);
  return entry.promise;
}

async function fetchAndStore(userId, gymId, allowRestart = true) {
  const revision = db.getUserGym(userId, gymId)?.connection_revision;
  const assertCurrent = () => { if (db.getUserGym(userId, gymId)?.connection_revision !== revision || require('./gym-connection').unavailable(userId, gymId)) throw Object.assign(new Error('Gym connection changed during sync'), { code: 'GYM_CONNECTION_CHANGED' }); };
  // A successful renewal advances the revision too. Discard that read and
  // restart once from the now-current connection, retaining the write fence.
  // Repeated changes, manual reconnects still syncing, and incidents stop here.
  const canRestart = (err) => allowRestart && err.code === 'GYM_CONNECTION_CHANGED'
    && db.isUserGymAvailable(userId, gymId) && !isGymRateLimited(gymId);
  const startedAt = new Date().toISOString();
  db.setBookingSyncState(userId, gymId, { lastAttemptAt: startedAt });
  const errors = [];
  let bookings = null;
  let waitlists = null;
  try {
    bookings = await bookingRowsFor(userId, gymId);
    assertCurrent();
    const listening = !!newBookingsListener;
    const prevState = listening ? db.getBookingSyncState(userId, gymId) : null;
    const firstSync = !(prevState && prevState.last_synced_at);
    const prevRows = listening && !firstSync
      ? db.db.prepare('SELECT booking_id, origin FROM booking_cache WHERE user_id = ? AND gym_id = ?').all(userId, gymId)
      : null;
    db.replaceBookingCache(userId, bookings, [gymId], { origin: 'server', retainStartedMs: RETAIN_STARTED_MS });
    if (listening) {
      // T-5 review: absent from booking_cache is not the same as never seen. A client push
      // can drop a server row (a stale client list) and the next sync re-imports it; that
      // re-import is not a new booking. Every booking a server sync lists is recorded in the
      // booker's ledger (gym-qualified), and only ids never seen before count as new.
      const candidates = prevRows ? newServerBookings(prevRows, bookings, gymId) : [];
      const fresh = candidates.filter((b) => !db.wasNotificationSent(userId, seenBookingKey(gymId, b.bookingId)));
      db.db.transaction(() => {
        for (const b of bookings) if (b && b.bookingId != null) db.markNotificationSent(userId, seenBookingKey(gymId, b.bookingId));
      })();
      if (fresh.length) {
        Promise.resolve().then(() => newBookingsListener(userId, gymId, fresh))
          .catch((err) => console.error(`[BookingSync] new-booking listener failed for user ${userId}:`, err && err.message));
      }
    }
  } catch (err) {
    if (canRestart(err)) return fetchAndStore(userId, gymId, false);
    noteThrottleError(gymId, err); errors.push(`bookings: ${err.message}`);
  }
  // A gym that just failed (or got throttled) is not asked again in this pass;
  // its stored waitlist rows stay as they were.
  if (!errors.length && isGymRateLimited(gymId)) errors.push('waitlists: gym throttled mid-sync');
  if (!errors.length) {
    try {
      waitlists = await waitlistRowsFor(userId, gymId);
      assertCurrent();
      db.replaceWaitlistCache(userId, waitlists, [gymId]);
    } catch (err) {
      if (canRestart(err)) return fetchAndStore(userId, gymId, false);
      noteThrottleError(gymId, err); errors.push(`waitlists: ${err.message}`);
    }
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

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);
// Per-gym pacing, unchanged from before lanes: 2-8 s between two calls to one gym.
const pause = (jitter) => sleep(jitter ? 2000 + Math.floor(Math.random() * 6000) : 0);

// (user, gym) -> start times of recent forced fetches (process-local; a restart forgets,
// which only ever allows a little more, never blocks the background cycle).
const forcedLog = new Map();
let clock = () => Date.now();
// (user, gym) -> the one deferred trailing forced sync (coalesces every skipped call).
const forcedDeferred = new Map();
let setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
const DEFER_SLACK_MS = 1000;
/** Queue one trailing forced sync for (user, gym) when its budget frees a slot. */
function deferForced(userId, gymId, now = clock()) {
  const key = flightKey(userId, gymId);
  if (forcedDeferred.has(key)) return;
  const live = (forcedLog.get(key) || []).filter((t) => now - t < FORCED_WINDOW_MS);
  const oldest = live.length ? Math.min(...live) : now - FORCED_WINDOW_MS;
  const wait = Math.max(0, oldest + FORCED_WINDOW_MS - now) + DEFER_SLACK_MS;
  stats.forceDeferred++;
  forcedDeferred.set(key, setTimer(() => {
    forcedDeferred.delete(key);
    syncUser(userId, { force: true, gymIds: [gymId] })
      .catch((err) => console.error(`[BookingSync] deferred forced sync failed for user ${userId} ${gymId}:`, err && err.message));
  }, wait));
}
/** Take one forced-sync slot for (user, gym); false when the budget is spent. */
function takeForcedSlot(userId, gymId, now = clock()) {
  const key = flightKey(userId, gymId);
  const recent = (forcedLog.get(key) || []).filter((t) => now - t < FORCED_WINDOW_MS);
  if (recent.length >= FORCED_MAX) { forcedLog.set(key, recent); return false; }
  recent.push(now);
  forcedLog.set(key, recent);
  if (forcedLog.size > 5000) { // bound the map: drop keys with nothing in the window
    for (const [k, ts] of forcedLog) if (!ts.some((t) => now - t < FORCED_WINDOW_MS)) forcedLog.delete(k);
  }
  return true;
}

/** Fetch one (user, gym) unless skipped; true when anything was stored. */
async function syncLink(userId, link, { force = false } = {}) {
  const gymId = link.gym_id;
  if (link.status === 'syncing' && link.account_enabled && !isGymRateLimited(gymId)) {
    return require('./gym-connection').withRecovery(userId, gymId, async () => {
      const result = await syncUserGym(userId, gymId, { force });
      if (result.ok) db.finishGymReconnect(userId, gymId, link.connection_revision);
      return !!result.ok;
    });
  }
  const reason = skipReason(userId, gymId, link);
  if (reason) { stats.gymsSkipped++; stats.skipped[reason]++; return false; }
  if (force && !takeForcedSlot(userId, gymId)) {
    stats.gymsSkipped++; stats.skipped.forceLimited++;
    deferForced(userId, gymId);
    return false;
  }
  try {
    const r = await syncUserGym(userId, gymId, { force });
    return !!(r.ok || r.bookings || r.waitlists);
  } catch (err) {
    console.error(`[BookingSync] user ${userId} ${gymId}:`, err.message);
    return false;
  }
}

async function afterUserSynced(userId, synced) {
  if (!synced.length) return;
  stats.usersSynced++;
  if (calendarEnabled(userId)) {
    try { await require('./calendar').afterBookingSync(userId, synced); }
    catch (err) { console.error(`[BookingSync] calendar publish failed for user ${userId}:`, err.message); }
  }
}

/**
 * Sync one account. `force` ignores the cadence (calendar refresh after a
 * booking mutation, explicit refresh); `gymIds` limits it to those gyms (a
 * mutation refreshes only the gym it changed). Calendar users get their
 * snapshot regenerated from the stored rows afterwards.
 */
async function syncUser(userId, { force = false, gymIds = null, links = null, priority = null, now = Date.now() } = {}) {
  let userLinks = links || (db.getUserGyms(userId) || []).filter((l) => l.account_enabled);
  if (Array.isArray(gymIds)) userLinks = userLinks.filter((l) => gymIds.includes(l.gym_id));
  const cadence = force ? 0 : cadenceFor(userId, priority || prioritySet());
  const synced = [];
  for (const link of userLinks) {
    if (!force && !isDue(userId, link.gym_id, cadence, now)) continue;
    if (await syncLink(userId, link, { force })) synced.push(link.gym_id);
  }
  await afterUserSynced(userId, synced);
  return synced;
}

/** Random start offset per lane on the boot cycle, so gyms are not all hit at once. */
function laneStartDelays({ boot = false, lanes = 0, maxMs = BOOT_STAGGER_MS, rand = Math.random } = {}) {
  return Array.from({ length: lanes }, () => (boot ? Math.floor(rand() * maxMs) : 0));
}

let running = null;
/**
 * One pass of the single background loop: every enabled link, synced if due.
 * Work runs in one lane per gym (serial within the lane, paced as before), with
 * up to MAX_LANES gyms in parallel, so a cold cycle costs ~5·N s rather than
 * ~5·N·G s and one gym is never called twice at once by the cycle. A tick that
 * arrives while a pass is running is skipped (it gets the running pass back).
 * `boot: true` (the first pass after start) staggers each lane's start.
 */
function runCycle(opts = {}) {
  require('./gym-connection').deliverPending().catch(() => {});
  if (running) { stats.ticksSkipped++; return running; }
  running = (async () => {
    const started = Date.now();
    const jitter = opts.jitter !== false;
    const priority = prioritySet();
    const byUser = new Map();
    for (const l of db.getEnabledGymLinks()) {
      if (gymOutbound.isFixtureUser(l.user_id)) continue; // demo fixture: planned out quietly, never fetched
      if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
      byUser.get(l.user_id).push({ ...l, account_enabled: 1 });
    }
    // Plan: due links, grouped by gym; per-user countdown so each account's
    // calendar is republished once, when its last due gym has finished.
    const lanes = new Map(); // gymId -> [{ userId, link }]
    const perUser = new Map(); // userId -> { remaining, synced: [] }
    for (const [userId, links] of byUser) {
      let cadence;
      try { cadence = cadenceFor(userId, priority); } catch (_) { cadence = DEFAULT_CADENCE_MS; }
      for (const link of links) {
        if (!isDue(userId, link.gym_id, cadence, started)) continue;
        if (!lanes.has(link.gym_id)) lanes.set(link.gym_id, []);
        lanes.get(link.gym_id).push({ userId, link });
        if (!perUser.has(userId)) perUser.set(userId, { remaining: 0, synced: [] });
        perUser.get(userId).remaining++;
      }
    }
    const queue = [...lanes.values()];
    const delays = laneStartDelays({ boot: !!opts.boot, lanes: queue.length });
    let laneIdx = 0;
    const worker = async () => {
      while (laneIdx < queue.length) {
        const i = laneIdx++;
        await sleep(delays[i]);
        let first = true;
        for (const { userId, link } of queue[i]) {
          if (!first) await pause(jitter);
          first = false;
          const u = perUser.get(userId);
          try { if (await syncLink(userId, link)) u.synced.push(link.gym_id); }
          catch (err) { console.error(`[BookingSync] cycle failed for user ${userId}:`, err.message); }
          if (--u.remaining === 0) await afterUserSynced(userId, u.synced);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_LANES, queue.length) }, worker));
    // Housekeeping: past classes and stale dedupe keys.
    const nowIso = DateTime.now().toISO();
    db.pruneBookingCache(new Date(Date.now() - RETAIN_STARTED_MS).toISOString());
    db.pruneWaitlistCache(nowIso);
    db.pruneSentNotifications(DateTime.now().minus({ days: 30 }).toISO());
    stats.cycles++;
    stats.lastCycleAt = new Date().toISOString();
    stats.lastCycleMs = Date.now() - started;
  })().finally(() => { running = null; });
  return running;
}

/**
 * The client's POST /api/bookings/sync. The background sync is authoritative:
 * a gym it is syncing now, or synced within CLIENT_PUSH_GRACE_MS, ignores the
 * push. Otherwise the client's list (a fresh fetch, so it may drop a cancelled
 * booking) replaces that gym's rows, keeping the sync's enriched fields
 * (duration, address) for bookings both lists know. Never recorded as a server
 * sync, so the cadence is unaffected. Returns the gyms written.
 */
function acceptClientBookings(userId, bookings, scope, now = Date.now()) {
  const list = Array.isArray(bookings) ? bookings : [];
  const gyms = (scope || []).filter((gymId) => {
    if (isSyncInFlight(userId, gymId)) return false;
    const st = db.getBookingSyncState(userId, gymId);
    const synced = st && st.last_synced_at ? Date.parse(st.last_synced_at) : 0;
    return now - synced >= CLIENT_PUSH_GRACE_MS;
  });
  if (!gyms.length) return [];
  const existing = new Map();
  const sel = db.db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?');
  for (const gymId of gyms) for (const r of sel.all(userId, gymId)) existing.set(`${gymId}:${r.booking_id}`, r);
  // T-2: a booking the server's own sync already holds keeps the SERVER's fields and
  // stays 'server' (Team-visible); one only the client knows is stored as 'client' and
  // never reaches a Team. The client's list can still remove a row (a cancel).
  const serverBookingIds = new Set();
  const merged = list.map((b) => {
    const gymId = b && b.gymId;
    const prev = gymId && b.bookingId != null ? existing.get(`${gymId}:${b.bookingId}`) : null;
    if (!prev) return b;
    if (prev.origin === 'server') {
      serverBookingIds.add(`${gymId}:${b.bookingId}`); // gym-qualified: ids collide across gyms
      return {
        bookingId: prev.booking_id, gymId, eventId: prev.event_id, startAt: prev.start_at,
        className: prev.class_name, groupName: prev.group_name, instructorName: prev.instructor_name,
        studioName: prev.studio_name, locationName: prev.location_name, slotLabel: prev.slot_label,
        durationMin: prev.duration_min, locationAddress: prev.location_address,
      };
    }
    return { ...b, durationMin: b.durationMin ?? prev.duration_min, locationAddress: b.locationAddress ?? prev.location_address };
  });
  db.replaceBookingCache(userId, merged, gyms, { serverBookingIds, retainStartedMs: RETAIN_STARTED_MS, now });
  return gyms;
}

module.exports = {
  runCycle,
  acceptClientBookings,
  isSyncInFlight,
  _laneStartDelays: laneStartDelays,
  syncUser,
  syncUserGym,
  bookingRowsFor,
  waitlistRowsFor,
  skipReason,
  cadenceFor,
  setPriorityPredicate,
  setNewBookingsListener,
  _newServerBookings: newServerBookings,
  getStats,
  PRIORITY_CADENCE_MS,
  CALENDAR_CADENCE_MS,
  DEFAULT_CADENCE_MS,
  FAILURE_RETRY_MS,
  CLIENT_PUSH_GRACE_MS,
  MAX_LANES,
  RETAIN_STARTED_MS,
  FORCED_WINDOW_MS,
  FORCED_MAX,
  _takeForcedSlot: takeForcedSlot,
  _setClock: (fn) => { clock = typeof fn === 'function' ? fn : () => Date.now(); },
  _resetForcedLog: () => {
    forcedLog.clear();
    for (const t of forcedDeferred.values()) { try { clearTimeout(t); } catch (_) {} }
    forcedDeferred.clear();
  },
  _setTimer: (fn) => { setTimer = typeof fn === 'function' ? fn : (f, ms) => { const t = setTimeout(f, ms); if (t && t.unref) t.unref(); return t; }; },
  _deferredForcedCount: () => forcedDeferred.size,
};
