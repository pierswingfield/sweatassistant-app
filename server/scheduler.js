const { DateTime } = require('luxon');
const { cleanClassName: _cleanClassName } = require('./class-name');
// U1-19b: push/SSE text names a class the way the UI does (no discipline prefix).
const displayClass = (row) => _cleanClassName(row.class_name, row.group_name) || row.class_name;
const db = require('./db');
const { log } = require('./logger');
const pushService = require('./push');
const notifications = require('./notifications');
const { triggerAutoRelogin } = require('./auth');
const { getProvider } = require('./providers');
const { resolveZone, zoneOfGym } = require('./providers/timezone');
const { getGymConfig } = require('./gyms.config');
const { planAutoBookSlots, planCompanionSlots } = require('./spot-selection');

// Interim single-gym bridge: until multi-gym login lands (WP-D3), the
// scheduler only dispatches CodexFit / Psycle London bookings. See
// server/auth.js for the same bridge.
// No module-level provider (WP-D7). Every fetch below resolves its gym — from
// the ROW being processed where there is one (background work must run for a gym
// the user isn't currently looking at), otherwise from the user's active gym.

let mainTimeout = null;
let prefetchTimeout = null;
let preciseInterval = null;

// SSE clients registry: userId → Set of response objects for streaming status updates
const sseClients = new Map();

// Shared event payload cache: eventId → { payload, expiresAt }
// Eliminates duplicate GET /events/:id fetches when multiple users target the same class.
// TTL: 30s during the booking window (covers all T-0 dispatch); 60s for upgrade polling.
const eventCache = new Map();

// Cross-user slot coordination for the current release window — both keyed
// "gymId:eventId:slotId" (WP-G). Event and slot ids are PROVIDER ids, unique only
// within a gym: two gyms can both publish event 12345 slot 7, and an unqualified
// key would make one gym's claim silently suppress the other gym's POST.
// claimedSlots: slot is in-flight or successfully booked by one of our users → others skip (no POST).
// burnedSlots:  slot POST failed (external user took it) → others skip without attempting.
// Both are cleared at the start of each release window dispatch.
const claimedSlots = new Set();
const burnedSlots = new Set();

// --- Rate-limit distress abort (C2-3) ---------------------------------------
//
// The per-gym backoff state, and the notification helper, live in
// rate-limit-backoff.js so the poller shares the SAME state (C2-3b) instead of
// keeping a second copy. When a provider signals PROVIDER_RATE_LIMITED
// (base.js classifyProviderThrottle, wired from providers/codexfit.js
// bookSlot), THIS gym's queue stops attempting new bookings until the backoff
// expires — other gyms are unaffected because everything is keyed by gymId.
const {
  isGymRateLimited,
  applyRateLimitBackoff,
  notifyRateLimited,
  _resetRateLimitBackoffForTests,
} = require('./rate-limit-backoff');

// Same reasoning as the claim sets: an event id alone is not unique across gyms,
// and a collision here is worse than a skipped booking — it serves one gym's slot
// occupancy as another gym's, so the scheduler books against the wrong floor plan.
function eventCacheKey(gymId, eventId) {
  return `${gymId}:${eventId}`;
}

function setCachedEvent(gymId, eventId, payload, ttlMs) {
  eventCache.set(eventCacheKey(gymId, eventId), { payload, expiresAt: Date.now() + ttlMs });
}

function getCachedEvent(gymId, eventId) {
  const entry = eventCache.get(eventCacheKey(gymId, eventId));
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.payload;
}

function clearEventCache() {
  eventCache.clear();
}

// Emit a status update to all connected clients for a user
function emitStatusUpdate(userId, update) {
  const clients = sseClients.get(userId);
  if (!clients) return;

  const statusMsg = JSON.stringify(update);
  clients.forEach(res => {
    try {
      res.write(`data: ${statusMsg}\n\n`);
    } catch (err) {
      console.error(`[Scheduler] SSE write failed for user ${userId}:`, err.message);
      clients.delete(res);
    }
  });
}

// Sane bounds for a booking-window offset, in days after the release Monday.
// A guard against a garbled offset, NOT a set of allowed tiers.
// Mirrors client/src/lib.js MIN_OFFSET_DAYS / MAX_OFFSET_DAYS.
const MIN_OFFSET_DAYS = 1;
const MAX_OFFSET_DAYS = 35;

// LEGACY / DEBUG ONLY — whole-week tiers (1→8, 2→15, 3→22, 4→29).
// Psycle's window is no longer whole weeks (confirmed 2026-08-31: standard moved
// to a fortnight, membership tiers extend by DAYS — +2/+3/+8). Detection no
// longer snaps to these; they survive only for the debug week-override and the
// pre-detection legacy path. Mirrors client/src/lib.js weeksToOffsetDays.
function weeksToOffsetDays(weeks) {
  const w = Math.min(4, Math.max(1, Math.round(weeks) || 1));
  return 8 + (w - 1) * 7;
}

// Mirrors client/src/lib.js clampOffsetDays.
function clampOffsetDays(days) {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n)) return 15;
  return Math.min(MAX_OFFSET_DAYS, Math.max(MIN_OFFSET_DAYS, n));
}

// Calculate booking offset in days based on settings.
// Priority: debug manual override → auto-detected window → legacy manual toggles.
// Mirrors client/src/lib.js getBookingOffset exactly. **Keep the two in step** —
// a divergence here means auto-book fires at a different instant than the
// countdown the user is watching.
function getBookingOffset(settings = {}) {
  // Debug-only exact-day override (preferred — real windows aren't whole weeks).
  if (settings.debugMode && settings.manualBookingWindowDays) {
    return clampOffsetDays(settings.manualBookingWindowDays);
  }
  // Debug-only manual override for testing a specific window (1-4 weeks).
  if (settings.debugMode && settings.manualBookingWindowWeeks) {
    return weeksToOffsetDays(settings.manualBookingWindowWeeks);
  }
  // Auto-detected from membership cutoffs + credit inventory (client persists this).
  if (typeof settings.detectedBookingOffset === 'number' && settings.detectedBookingOffset > 0) {
    return clampOffsetDays(settings.detectedBookingOffset);
  }
  // Legacy fallback (manual toggles, pre-auto-detection). Base is 14 since
  // 2026-08-31 — Psycle's standard window is a fortnight, not the old 8 days.
  let days = 15; // base: releaseMonday + 15 days = end of the Tuesday
  if (settings.advancedBooking) days += 7;

  return days;
}

// When booking opens for a queued class (WP-D8).
//
// Two worlds, and the order matters:
//   1. A release the GYM published for this class (`booking.release_at`, captured
//      when the entry was queued). Per-class gyms like MarianaTek have no weekday
//      rule to derive this from — recomputing would invent one.
//   2. Otherwise, compose it from the gym's own rolling-weekly policy via the
//      adapter. That is where Psycle's Monday-noon model now lives.
//
// Accepts a booking ROW, not a bare date string: the row is what carries both the
// published release and the gym whose policy applies.
function getClassReleaseTime(booking, settings = {}) {
  const row = booking || {};
  const classDateStr = row.start_at;
  // A row names its own gym; a bare string names none, and there is no default gym
  // to guess (no gym => no policy => nothing to resolve => null, the "skip" answer).
  const gymId = row.gym_id;
  if (!gymId) return null;

  if (row.release_at) {
    const published = DateTime.fromISO(row.release_at);
    if (published.isValid) return published.setZone(getGymZone(gymId));
  }
  // No published release AND no class start to derive one from: there is nothing
  // to resolve, so refuse — same contract as the unresolvable case below.
  //
  // This used to `return DateTime.now()`, which is the one answer the rest of
  // this function exists to avoid giving. It was survivable only by accident:
  // the old orchestrator woke solely at Monday noon, so a "releases now" entry
  // was quietly filtered out for not matching. Once the queue became the wake
  // clock (WP-I), that same row armed the precision loop immediately and
  // dispatched — surfaced by test-wake-clock.js failing intermittently, because
  // whether "now" landed a millisecond before or after the caller's own `now`
  // decided it.
  if (!classDateStr) {
    console.warn(`[Scheduler] Auto-booking ${row.id ?? '?'} (event ${row.event_id}) has neither release_at nor start_at — cannot resolve a release, skipping.`);
    return null;
  }

  const provider = getProvider(gymId);
  // The per-member offset in `settings` is a ROLLING-WEEKLY concept: it comes
  // from a CodexFit profile cutoff and describes how far past the release Monday
  // that member can book. Handing it to a gym with any other window kind applies
  // one gym's membership tier to another gym's classes — the precise asymmetry
  // this phase exists to remove. So it is only passed where it means something;
  // every other gym resolves its own window from its own policy.
  const gym = getGymConfig(gymId);
  const isRollingWeekly = gym && gym.bookingWindow && gym.bookingWindow.kind === 'rolling-weekly';
  const window = isRollingWeekly ? { offsetDays: getBookingOffset(settings) } : null;
  const iso = provider.releaseAtFor(classDateStr, window);
  if (iso) return DateTime.fromISO(iso).setZone(getGymZone(gymId));

  // Nothing published, and the gym declares no fallback policy either. Treating
  // this as "open now" would be actively wrong — it would fire auto-book on a
  // class weeks before its window, burning the queue entry. Refuse instead: the
  // caller skips the entry rather than acting on a guess.
  //
  // (This is reachable only for a misconfigured gym. Every gym in the registry
  // declares either a rolling-weekly policy or a per-class fallback, and
  // test-no-gym-privilege.js asserts the registry stays complete.)
  console.warn(`[Scheduler] No release time resolvable for event ${row.event_id} at gym ${gymId} — skipping.`);
  return null;
}

function getGymZone(gymId) {
  const gym = getGymConfig(gymId);
  return resolveZone(gym);
}

// Perform a request to CodexFit API with automatic re-login on 401
// `gymId` is explicit: background callers pass the row's own gym. `path` is a
// PATH, not a URL — the provider prepends its gym's base, which is the whole
// point (an absolute URL would bypass it and pin every gym to Psycle's host).
async function fetchFromGym(userId, gymId, path, options = {}) {
  // The ROW's gym session — NOT db.getUserById(userId).jwt, which resolves the
  // user's ACTIVE gym (db.resolveActiveGymId) and is wrong for a background
  // call site processing a gym the user isn't currently looking at (C3-12).
  const session = db.getUserSession(userId, gymId);
  // Dev mock: the adapter decides (never a dev email compared here), and serves it
  // through its own request() via the mock sentinel token.
  const adapter = getProvider(gymId);
  if (adapter.isMockUser(db.getUserById(userId), session)) {
    return adapter.request(path, { token: adapter.mockToken, method: options.method || 'GET', body: options.body, headers: options.headers });
  }
  if (!session || !session.accessToken) {
    throw new Error('User has no active session. Please log in.');
  }

  const runFetch = (token) => getProvider(gymId).request(path, {
    token,
    method: options.method || 'GET',
    body: options.body,
    headers: options.headers,
  });

  let res = await runFetch(session.accessToken);

  if (res.status === 401) {
    try {
      const newJwt = await triggerAutoRelogin(userId, gymId);
      res = await runFetch(newJwt);
    } catch (err) {
      log.error('relogin failed during api fetch', { component: 'scheduler', userId, err });
      pushService.sendNotification(userId, 'Session Expired ⚠️', 'Failed to renew session. Auto-booking skipped.');
      throw err;
    }
  }
  return res;
}

// Prefetch slots map for active bookings. Deduplicated by event — one GET per
// unique event_id regardless of how many users target the same class. Each event
// is staggered randomly within the window so all fetches complete before T-30s.
// Results are stored in the shared event cache (TTL 30s) so executeAutoBookForClass
// reads from cache instead of re-fetching, collapsing 2×N fetches → N unique events.
async function prefetchAutoBookSlots(bookings, windowMs = 18000) {
  // Provider ids are only unique within a gym, matching the event cache key.
  const eventMap = new Map();
  for (const b of bookings) {
    const key = eventCacheKey(b.gym_id, b.event_id);
    if (!eventMap.has(key)) eventMap.set(key, b);
  }
  const uniqueEvents = [...eventMap.values()];
  console.log(`[Scheduler] Prefetch: ${bookings.length} booking(s) across ${uniqueEvents.length} unique event(s), staggered over ${windowMs / 1000}s.`);

  const promises = uniqueEvents.map(async (booking) => {
    const delay = Math.floor(Math.random() * windowMs);
    await new Promise(r => setTimeout(r, delay));
    try {
      // Notify all users targeting this event
      for (const b of bookings) {
        if (b.gym_id === booking.gym_id && b.event_id === booking.event_id) {
          emitStatusUpdate(b.user_id, {
            eventId: booking.event_id,
            status: 'prefetching',
            message: 'Fetching latest spot occupancy data...'
          });
        }
      }
      // Authenticated with the ROW's gym session (as fetchFromGym did before the
      // adapter move): an unauthenticated call bypasses the dev mock and hits the
      // live gym, so dev-mode event 1000 read as having no free slots.
      const details = await getProvider(booking.gym_id).fetchEventDetails(
        booking.event_id, db.getUserSession(booking.user_id, booking.gym_id) || undefined);
      if (details) {
        setCachedEvent(booking.gym_id, booking.event_id, details, 30000);
        const available = (details.slots || []).filter((slot) => slot.isAvailable);
        console.log(`[Scheduler] Prefetched event ${booking.event_id}: ${available.length} available slot(s) (cached 30s).`);
      }
    } catch (err) {
      console.error(`[Scheduler] Prefetch failed for event ${booking.event_id}:`, err.message);
    }
  });
  await Promise.allSettled(promises);
}

// Resolve the LIVE shared studio spot map. There is deliberately no fallback to
// the queue entry's snapshot: a map the member removed must stay removed, and a
// snapshot would silently keep driving bookings (and recreate it on edit).
// `exists` is false when the studio has no map at all.
function resolveLiveMap(userId, studioId, gymId = null) {
  const live = db.getStudioPreference(userId, studioId, gymId);
  const preferredSlots = (live && live.preferredSlots) || [];
  const preferredRows = (live && live.preferredRows) || [];
  return { preferredSlots, preferredRows, exists: preferredSlots.length > 0 || preferredRows.length > 0 };
}

// Attempt one booking via the adapter, with the same 401-triggers-relogin
// ladder the old inline fetchCodexFit() gave every authenticated call (WP-N3).
// The adapter itself never retries (base.js's request() convention — see
// providers/codexfit.js) so that ladder has to live at the call site, same as
// it always did; this is the one spot in the retry loop it's actually needed.
// Not needed for the waitlist fallback below: by the time that path is
// reached, the last bookSlot() attempt already proved (or refreshed) the
// session, so a second independent retry ladder there would be redundant.
async function bookSlotWithRelogin(userId, gymId, eventId, targetSlot) {
  // The ROW's gym session — see fetchFromGym's note above (C3-12).
  let session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) throw new Error('User has no active session. Please log in.');
  const provider = getProvider(gymId);
  let result = await provider.bookSlot(eventId, [targetSlot], session);
  if (!result.ok && result.status === 401) {
    log.info('booking got 401, attempting relogin and retry', { component: 'scheduler', userId, gymId });
    const newJwt = await triggerAutoRelogin(userId, gymId);
    session = { accessToken: newJwt };
    result = await provider.bookSlot(eventId, [targetSlot], session);
  }
  return result;
}

// Execute auto-book process for a single class slot booking
async function executeAutoBookForClass(booking) {
  const eventId = booking.event_id;
  const userId = booking.user_id;
  // The gym this queue entry belongs to — taken from the ROW, never resolved
  // from the user's active gym: background execution must work for a gym the
  // user isn't currently looking at (see db.js's gym scoping rule).
  const gymId = booking.gym_id;
  const prefs = JSON.parse(booking.preferences) || { preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true };
  // Slots/rows come from the LIVE shared studio map; requiredCount/bookAny are per-entry.
  const liveMap = resolveLiveMap(userId, booking.studio_id, gymId);
  const preferredSlots = liveMap.preferredSlots;
  const preferredRows = liveMap.preferredRows;
  const capabilities = getGymConfig(gymId)?.capabilities || {};
  const configuredLimit = Number(capabilities.maxSpotsPerClass);
  const requestedCount = Math.max(1, Number(prefs.requiredCount) || 1);
  // Imported/older JAB rows can predate the provider entitlement contract.
  // A guest is separate from this queue, so stale self preferences can never
  // turn into multiple primary reservations.
  const requiredCount = capabilities.selfBookingPolicy === 'one-per-class'
    ? 1
    : (Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.min(requestedCount, configuredLimit) : requestedCount);
  // Named guests are separate provider reservations. The self loop must never
  // spend their total-place count as extra member reservations.
  const scheduledGuests = Array.isArray(prefs.guests) ? prefs.guests : [];
  const selfRequiredCount = scheduledGuests.length ? 1 : requiredCount;
  const participantRows = booking.id ? db.getAutoBookingParticipants(booking.id, userId) : [];
  const selfParticipant = participantRows.find((row) => row.participant_key === 'self');
  // Imported rows are defensively normalised here as well as at the API boundary.
  // Togetherness needs fallback candidates to fulfil its stated wider search.
  const prioritizeTogether = requiredCount > 1 && prefs.prioritizeTogether === true;
  const bookAny = prioritizeTogether || prefs.bookAny !== false;

  // No preferred map for this studio (removed, or never set): explain why the
  // booking is not following one. Once per class, respects notification prefs.
  if (!liveMap.exists) {
    const key = `nomap:autobook:${gymId}:${eventId}`;
    if (!db.wasNotificationSent(userId, key)) {
      db.markNotificationSent(userId, key);
      notifications.notify(userId, 'booking', {
        source: 'autobook', kind: 'noSpotMap', bookAny, gymId,
        startAt: booking.start_at, groupName: booking.group_name,
        className: booking.class_name, studioName: booking.studio_name,
      });
    }
  }

  // C2-3: a prior attempt this window already got PROVIDER_RATE_LIMITED for
  // this gym — don't start a new attempt (no network call at all) until the
  // backoff clears. Jobs already in flight when the backoff was set can't be
  // recalled, but every job that hasn't started yet (the common case, thanks
  // to CLAIM_STAGGER_MS staggering) is stopped here.
  if (isGymRateLimited(gymId)) {
    log.warn('gym rate-limited, skipping booking attempt', { component: 'scheduler', gymId, eventId, userId });
    emitStatusUpdate(userId, {
      eventId,
      status: 'rate-limited',
      message: 'Booking paused: the gym is rate-limiting requests. Will resume automatically.',
    });
    return;
  }

  console.log(`[Scheduler] Running booking worker for User ${userId}, Event ${eventId}. Needs ${requiredCount} total places.`);

  try {
    // 1. Get live slot availability — use shared cache if prefetch populated it
    let details = getCachedEvent(gymId, eventId);
    if (details) {
      console.log(`[Scheduler] Cache hit for event ${eventId} (user ${userId}).`);
    } else {
      details = await getProvider(gymId).fetchEventDetails(
        eventId, db.getUserSession(userId, gymId) || undefined);
      if (!details) throw new Error('Failed to load event data.');
      setCachedEvent(gymId, eventId, details, 30000);
    }

    const layoutSlots = details.slots || [];
    const liveAvailable = layoutSlots.filter((slot) => slot.isAvailable).map((slot) => String(slot.id));

    console.log(`[Scheduler] Live available slots for event ${eventId}:`, liveAvailable);

    // Keep the selected map as the first search boundary. The planner uses
    // normalised x/y layout data only (never labels), detects aisle-sized gaps,
    // and appends every permitted fallback so a smaller contiguous group cannot
    // reduce the total number of successful reservations.
    const slotsToTry = planAutoBookSlots({
      layoutSlots,
      availableSlotIds: liveAvailable,
      preferredSlots,
      preferredRows,
      bookAny,
      prioritizeTogether,
    });

    const selfAlreadySucceeded = selfParticipant?.status === 'success' && selfParticipant.booking_id;
    let bookedCount = selfAlreadySucceeded ? selfRequiredCount : 0;
    let terminalBookingFailure = null;
    const bookedSlots = selfAlreadySucceeded && selfParticipant.slot_id ? [String(selfParticipant.slot_id)] : [];
    // A durable successful primary must seed re-entry; never create it again.
    const bookedPairs = selfAlreadySucceeded ? [{ bookingId: String(selfParticipant.booking_id), slotId: selfParticipant.slot_id }] : [];
    let attemptIdx = 0;

    console.log(`[Scheduler] Event ${eventId}: planning to attempt slots in order: [${slotsToTry.join(', ')}]`);

    // Emit status: planned slots
    emitStatusUpdate(userId, {
      eventId,
      status: 'planning',
      plannedSlots: slotsToTry,
      message: `Planning to book from: [${slotsToTry.join(', ')}]`
    });

    // Try booking candidate slots. Two cross-user coordination sets are checked first:
    //   claimedSlots — slot is in-flight or booked by another of our users → skip (no POST)
    //   burnedSlots  — slot POST already failed for another user this window → skip (externally taken)
    // Both short-circuit without a network call, letting subsequent users reach live slots faster.
    while (bookedCount < selfRequiredCount && attemptIdx < slotsToTry.length) {
      const targetSlot = slotsToTry[attemptIdx++];
      // Gym-qualified: provider slot ids collide across gyms (WP-G).
      const claimKey = `${gymId}:${eventId}:${targetSlot}`;

      if (claimedSlots.has(claimKey)) {
        console.log(`[Scheduler] Slot ${targetSlot} (event ${eventId}) claimed by another user — skipping.`);
        emitStatusUpdate(userId, {
          eventId, status: 'slot-claimed', skippedSlot: targetSlot,
          message: `Slot ${targetSlot} is being claimed by another user — trying next.`
        });
        continue;
      }

      if (burnedSlots.has(claimKey)) {
        console.log(`[Scheduler] Slot ${targetSlot} (event ${eventId}) already failed for another user — skipping.`);
        emitStatusUpdate(userId, {
          eventId, status: 'slot-burned', skippedSlot: targetSlot,
          message: `Slot ${targetSlot} already taken externally — trying next.`
        });
        continue;
      }

      // Claim before POST so concurrent users see it immediately (Node.js Set ops are synchronous)
      claimedSlots.add(claimKey);
      const isPreferred = preferredSlots.includes(targetSlot);
      console.log(`[Scheduler] Attempting to book ${isPreferred ? 'preferred' : 'fallback'} slot ${targetSlot} for event ${eventId}...`);

      emitStatusUpdate(userId, {
        eventId,
        status: 'attempting',
        attemptingSlot: targetSlot,
        isPreferred,
        attempt: attemptIdx,
        message: `Attempting ${isPreferred ? 'preferred' : 'fallback'} slot ${targetSlot}...`
      });

      try {
        // WP-N3: routes through the CodexFit adapter's bookSlot() instead of a
        // raw fetchCodexFit POST. Response parsing (bookings map -> bookingId)
        // now lives in the adapter (see codexfit.js bookSlot) — this call site
        // only handles the scheduler-specific bits: claim/burn bookkeeping and
        // the 401-relogin ladder (bookSlotWithRelogin, defined above).
        const result = await bookSlotWithRelogin(userId, gymId, eventId, targetSlot);

        if (result.ok) {
          bookedCount++;
          bookedSlots.push(targetSlot);
          const thisBookingId = result.bookingId != null ? String(result.bookingId) : null;
          bookedPairs.push({ bookingId: thisBookingId, slotId: targetSlot });
          if (selfParticipant) db.markAutoBookingParticipant(booking.id, userId, 'self', { status: 'success', bookingId: thisBookingId, slotId: targetSlot });
          console.log(`[Scheduler] Successfully booked slot ${targetSlot} for event ${eventId} (booking ID: ${thisBookingId})`);
          // Claim stays in claimedSlots — other users see it and skip without POSTing
        } else if (result.code === 'ALREADY_BOOKED' || result.code === 'BOOKING_TIMEOUT') {
          claimedSlots.delete(claimKey);
          terminalBookingFailure = result;
          break;
        } else if (result.code === 'PROVIDER_RATE_LIMITED') {
          // C2-3: the provider is telling us to stop, not just refusing this
          // slot. Back off THIS gym (never a global backoff — WP-D7/WP-G),
          // notify once (deduped), and abort the rest of this class's attempts
          // rather than burning through the remaining fallback slots.
          log.error('gym rate-limited booking, backing off and aborting further attempts', { component: 'scheduler', gymId, eventId, slot: targetSlot, userId, reason: result.error });
          claimedSlots.delete(claimKey);
          const until = applyRateLimitBackoff(gymId, result.retryAfterMs);
          notifyRateLimited(userId, gymId);
          emitStatusUpdate(userId, {
            eventId,
            status: 'rate-limited',
            skippedSlot: targetSlot,
            message: `Provider rate limit hit — pausing this gym's bookings until ${new Date(until).toISOString()}.`,
          });
          break;
        } else {
          console.warn(`[Scheduler] Slot ${targetSlot} booking failed:`, result.error);
          // Burn the slot: externally taken, no point other users attempting it
          claimedSlots.delete(claimKey);
          burnedSlots.add(claimKey);
        }
      } catch (err) {
        console.error(`[Scheduler] Booking attempt error for slot ${targetSlot}:`, err.message);
        claimedSlots.delete(claimKey);
        burnedSlots.add(claimKey);
      }

      if (bookedCount < selfRequiredCount && attemptIdx < slotsToTry.length) {
        await new Promise(resolve => setTimeout(resolve, 400 + Math.floor(Math.random() * 400)));
      }
    }

    // A duplicate is not a full class and a timed-out POST may have succeeded;
    // neither state may cascade into another candidate or an automatic waitlist.
    if (terminalBookingFailure) {
      const alreadyBooked = terminalBookingFailure.code === 'ALREADY_BOOKED';
      const message = terminalBookingFailure.error || (alreadyBooked
        ? 'You already have a spot booked for this class.'
        : 'Booking timed out. Check My Bookings before trying again.');
      db.markAutoBookingExecuted(eventId, userId, gymId, 'failed', message, new Date().toISOString());
      emitStatusUpdate(userId, {
        eventId,
        status: alreadyBooked ? 'already-booked' : 'booking-timeout',
        message,
      });
      return;
    }

    // A named guest is only attempted after a verified primary reservation. A
    // successful participant is skipped on any re-entry. A timeout/transport
    // ambiguity is reconciled from the provider list once, then halted as
    // unknown rather than risking a duplicate guest charge.
    let guestUnknown = false;
    let guestFailures = 0;
    if (scheduledGuests.length && bookedPairs.length) {
      const provider = getProvider(gymId);
      const primaryBookingId = bookedPairs[0].bookingId;
      for (const guest of scheduledGuests) {
        const key = `guest:${String(guest.email || '').trim().toLowerCase()}`;
        const participant = participantRows.find((row) => row.participant_key === key);
        if (participant?.status === 'success') continue;
        let guestResult = null;
        let guestBooked = false;
        // Re-plan around the primary's ACTUAL spot (it may differ from the plan): with togetherness the
        // guest gets the nearest free spot; otherwise the normal plan minus spots already taken.
        const primarySlotId = bookedPairs[0].slotId != null ? String(bookedPairs[0].slotId) : null;
        const takenIds = [...bookedSlots, ...bookedPairs.map((p) => p.slotId)].filter((v) => v != null).map(String);
        const guestOrder = planCompanionSlots({
          layoutSlots, availableSlotIds: liveAvailable, primarySlotId, excludeIds: takenIds,
          preferredSlots, preferredRows, bookAny, prioritizeTogether,
        }).filter((id) => !claimedSlots.has(`${gymId}:${eventId}:${id}`) && !burnedSlots.has(`${gymId}:${eventId}:${id}`));
        let guestIdx = 0;
        while (guestIdx < guestOrder.length) {
          const targetSlot = guestOrder[guestIdx++];
          try { guestResult = await provider.bookGuestSlot(eventId, targetSlot, guest.email, db.getUserSession(userId, gymId) || undefined); }
          catch (_) { guestResult = { ok: false, code: 'BOOKING_TIMEOUT', error: 'Guest booking result could not be confirmed.' }; }
          if (guestResult?.ok) {
            db.markAutoBookingParticipant(booking.id, userId, key, { status: 'success', bookingId: guestResult.bookingId, slotId: guestResult.slotId || targetSlot });
            db.upsertGuestBookingGroup(userId, gymId, eventId, primaryBookingId, guestResult.bookingId);
            bookedSlots.push(guestResult.slotId || targetSlot);
            guestBooked = true;
            break;
          }
          if (guestResult?.code === 'SPOT_UNAVAILABLE') continue;
          if (guestResult?.code === 'BOOKING_TIMEOUT') {
            let liveGuest;
            try { liveGuest = (await provider.listBookings(db.getUserSession(userId, gymId) || undefined)).find((row) => String(row.eventId) === String(eventId) && row.isGuest && String(row.guestEmail || '').toLowerCase() === String(guest.email).toLowerCase()); } catch (_) {}
            if (liveGuest) {
              db.markAutoBookingParticipant(booking.id, userId, key, { status: 'success', bookingId: liveGuest.bookingId, slotId: liveGuest.slotId });
              db.upsertGuestBookingGroup(userId, gymId, eventId, primaryBookingId, liveGuest.bookingId);
            } else {
              db.markAutoBookingParticipant(booking.id, userId, key, { status: 'unknown', failureCode: 'GUEST_RESULT_UNKNOWN', failureMessage: 'Guest booking result could not be confirmed.' });
              guestUnknown = true;
            }
          } else {
            db.markAutoBookingParticipant(booking.id, userId, key, { status: 'failed', failureCode: guestResult?.code || 'GUEST_BOOKING_FAILED', failureMessage: guestResult?.error || 'Guest booking failed.' });
            guestFailures++;
          }
          break;
        }
        if (!guestBooked && !guestResult) {
          db.markAutoBookingParticipant(booking.id, userId, key, { status: 'failed', failureCode: 'NO_GUEST_SLOT_AVAILABLE', failureMessage: 'No remaining spot was available for this guest.' });
          guestFailures++;
        }
      }
    }
    if (guestUnknown) {
      const message = 'Your spot is booked, but a guest booking result is unknown. Check My Bookings before changing this Auto-Book.';
      db.markAutoBookingExecuted(eventId, userId, gymId, 'failed', message, new Date().toISOString());
      emitStatusUpdate(userId, { eventId, status: 'guest-result-unknown', message });
      return;
    }

    // 5. Check if booking succeeded
    if (bookedCount > 0) {
      const msg = guestFailures
        ? `Your spot is booked; ${guestFailures} guest booking could not be completed.`
        : `Successfully booked slot${bookedSlots.length > 1 ? 's' : ''} ${bookedSlots.join(', ')}!`;
      db.markAutoBookingExecuted(eventId, userId, gymId, 'success', msg, new Date().toISOString());

      emitStatusUpdate(userId, {
        eventId,
        status: 'success',
        bookedSlots,
        message: msg
      });

      // Notify the user (Spot Booked) — map slot IDs to labels where possible
      const bookedLabels = bookedSlots.map(id => {
        const s = layoutSlots.find(ls => String(ls.id) === String(id));
        return s?.label ?? id;
      });
      notifications.notify(userId, 'booking', {
        source: 'autobook',
        gymId,
        startAt: booking.start_at,
        groupName: booking.group_name,
        className: booking.class_name,
        instructorName: booking.instructor_name,
        slots: bookedLabels,
      });

      // Refresh the calendar feed so the new booking shows immediately.
      try { require('./calendar').regenerateSnapshot(userId); } catch (_) {}

      // Several reservations register ONE group monitor (moved together). Scheduled
      // guests never opt in: swapping a guest reservation is unproven.
      if (layoutSlots.length > 0 && bookedPairs.length > 0 && scheduledGuests.length === 0) {
        // THIS booking's gym — autoUpgradeEnabled/autoUpgradeByDefault are
        // gym-scoped, and the ambient default would apply one gym's
        // auto-upgrade preference to a booking on another.
        const settings = db.getUserSettings(userId, gymId) || {};
        if (settings.autoUpgradeEnabled !== false) {
          const wantAutoUpgrade = prefs.autoUpgrade !== undefined
            ? prefs.autoUpgrade
            : settings.autoUpgradeByDefault;
          if (wantAutoUpgrade) {
            console.log(`[Scheduler] Auto-registering Auto-Upgrade monitoring for ${bookedPairs.length} booking(s) for event ${eventId}`);
            const upgradePrefs = {
              keepOriginalOnCutoff: settings.autoUpgradeKeepOriginalByDefault === true,
              // The Auto-Book "together" option rides along so the group is upgraded to a tighter set too.
              ...(prefs.prioritizeTogether === true ? { prioritizeTogether: true } : {}),
            };
            const addMonitor = (pair, members) => db.addAutoUpgrade(
              userId, eventId, pair.bookingId, pair.slotId, booking.class_name, booking.instructor_name,
              booking.studio_name, booking.location_name, booking.start_at, upgradePrefs, booking.studio_id,
              booking.group_name, gymId, members
            );
            if (bookedPairs.length > 1) {
              // ONE monitor for the whole group (moved together, never one by one).
              addMonitor(bookedPairs[0], bookedPairs.map((p) => ({ bookingId: p.bookingId, slotId: p.slotId })));
            } else {
              for (const pair of bookedPairs) addMonitor(pair, null);
            }
          } else {
            console.log(`[Scheduler] Skipping auto-upgrade for booking ${eventId} because user disabled it for this booking/by default.`);
          }
        }
      }
    } else {
      // 6. Fail fallback: join waitlist
      console.log(`[Scheduler] All slots taken for event ${eventId}. Attempting waitlist fallback...`);

      emitStatusUpdate(userId, {
        eventId,
        status: 'waitlist-fallback',
        message: 'All slots taken. Attempting waitlist...'
      });

      const wlUrl = `/waitlists/${eventId}`;
      const wlRes = await fetchFromGym(userId, gymId, wlUrl, { method: 'PUT' });

      if (wlRes.ok) {
        db.markAutoBookingExecuted(eventId, userId, gymId, 'waitlist', 'All slots occupied. Joined waitlist fallback successfully.', new Date().toISOString());

        emitStatusUpdate(userId, {
          eventId,
          status: 'waitlist-success',
          message: 'Joined waitlist successfully'
        });

        pushService.sendNotification(
          userId,
          'Auto-Book Waitlist ⏳',
          `All slots taken. Joined waitlist fallback for ${displayClass(booking)} with ${booking.instructor_name}.`
        );
      } else {
        const wlErr = await wlRes.json().catch(() => ({}));
        const errMsg = wlErr.message || 'Class is fully booked and waitlist closed';
        db.markAutoBookingExecuted(eventId, userId, gymId, 'failed', `Booking and Waitlist fallback failed: ${errMsg}`, new Date().toISOString());

        emitStatusUpdate(userId, {
          eventId,
          status: 'failed',
          message: `Failed: ${errMsg}`
        });

        pushService.sendNotification(
          userId,
          'Auto-Book Failed ❌',
          `Failed to book ${displayClass(booking)}: ${errMsg}`
        );
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Auto-book worker failed for user ${userId}, event ${eventId}:`, err.message);
    db.markAutoBookingExecuted(eventId, userId, gymId, 'failed', `Worker execution failed: ${err.message}`, new Date().toISOString());
    pushService.sendNotification(userId, 'Auto-Book Error ⚠️', `Error executing booking for ${displayClass(booking)}: ${err.message}`);
  }
}

// Sort a same-class group by priority tier (lower = higher), then apply Fisher-Yates
// shuffle within each tier so equal-priority users get fair random ordering each week.
function priorityShuffleGroup(group) {
  // Gather distinct tiers in ascending order
  const tiers = [...new Set(group.map(b => b.priority ?? 100))].sort((a, b) => a - b);
  const result = [];
  for (const tier of tiers) {
    const tierGroup = group.filter(b => (b.priority ?? 100) === tier);
    // Fisher-Yates shuffle in place
    for (let i = tierGroup.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tierGroup[i], tierGroup[j]] = [tierGroup[j], tierGroup[i]];
    }
    result.push(...tierGroup);
  }
  return result;
}

// Core execution loop.
// Groups bookings by event_id so different classes run fully in parallel.
// Within a class, users run concurrently but are staggered by CLAIM_STAGGER_MS per user
// in tier+shuffle order. This gives higher-priority users just enough of a head start to
// claim their preferred slot before the next user's slot-selection loop begins, without
// forcing anyone to wait for the previous user's full booking flow to complete.
// The claimedSlots set (atomic in Node.js single-threaded event loop) prevents duplicate
// POSTs even though all bookings are in flight simultaneously once started.
const CLAIM_STAGGER_MS = 80; // time between consecutive users' start within the same class

async function executeAutoBookQueue(bookings) {
  if (bookings.length === 0) return;

  // Both sets are scoped to this release window; clear before dispatch
  claimedSlots.clear();
  burnedSlots.clear();

  // Group by event_id
  const groups = new Map();
  for (const b of bookings) {
    if (!groups.has(b.event_id)) groups.set(b.event_id, []);
    groups.get(b.event_id).push(b);
  }

  const uniqueEvents = groups.size;
  const totalBookings = bookings.length;
  console.log(`[Scheduler] Dispatching ${totalBookings} booking(s) across ${uniqueEvents} class(es). Different classes run in parallel; same-class users staggered ${CLAIM_STAGGER_MS}ms apart.`);

  const groupJobs = [...groups.entries()].map(async ([eventId, group]) => {
    // Sort by priority tier, then Fisher-Yates shuffle within each tier for week-to-week fairness.
    const tierSorted = priorityShuffleGroup(group);

    // Small per-group jitter (0–200ms) to spread the initial burst across parallel classes
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 200)));

    // Staggered-parallel: each user starts CLAIM_STAGGER_MS after the previous, but does NOT
    // wait for the previous user to finish booking before starting. All are in flight together.
    const jobs = tierSorted.map((booking, i) =>
      new Promise(resolve => {
        setTimeout(() => {
          executeAutoBookForClass(booking)
            .catch(err => console.error(`[Scheduler] Worker crash for event ${eventId}, user ${booking.user_id}:`, err.message))
            .finally(resolve);
        }, i * CLAIM_STAGGER_MS);
      })
    );

    await Promise.allSettled(jobs);
  });

  await Promise.allSettled(groupJobs);
}

// --- The wake clock (layer I) ------------------------------------------------
//
// This used to be one instant: Psycle's Monday 12:00 London, hardcoded. That is
// gym POLICY, not scheduler mechanics, and it made a per-class gym's auto-book
// unreachable twice over — the process never woke at the right time, and the
// dispatch filter then rejected the class for not matching the wrong time. A JAB
// entry releasing Saturday 09:47 measured 50.2 hours from the armed instant and
// simply never fired.
//
// The QUEUE is now the clock. Every pending entry already resolves its own
// release instant through `getClassReleaseTime()` — the gym's published
// per-class time, or its own declared policy — so the soonest still-future one
// of those is the only thing worth arming for. Psycle's behaviour is unchanged
// in effect: its entries still resolve to Monday noon, they just arrive via the
// queue instead of a hardcoded weekday, and its whole release group still fires
// together because the dispatch filter below is unchanged.
//
// Two things follow that are easy to get wrong:
//   - An entry whose release cannot be resolved is DROPPED, never defaulted to
//     "now". Assuming a class is open fires auto-book weeks early and burns the
//     queue entry (see getClassReleaseTime's own note).
//   - The armed instant is recomputed after every dispatch AND whenever the
//     queue changes (`rearm()`), because a newly queued class can release sooner
//     than whatever is currently armed.

// Bookings within this much of the armed instant fire as one release group.
const DISPATCH_WINDOW_MS = 10000;
// With an empty queue there is nothing to wake for. Re-check on a slow timer as
// a backstop; `rearm()` is what normally brings the clock forward.
const IDLE_RECHECK_MS = 15 * 60 * 1000;
// A release missed while the process was down is only worth catching if it just
// happened. Beyond this, the spots are long gone and firing would be noise.
const MISSED_RELEASE_GRACE_MS = 5 * 60 * 1000;

// Every pending entry paired with its resolved release instant.
function resolvePendingReleases() {
  const out = [];
  for (const booking of db.getPendingAutoBookings()) {
    // THIS booking's own gym — reading the ambient/default gym's settings here
    // silently applied Psycle's rolling-weekly member-tier offset to it (or
    // omitted it) regardless of which gym the row is actually for.
    const settings = db.getUserSettings(booking.user_id, booking.gym_id) || {};
    const releaseAt = getClassReleaseTime(booking, settings);
    if (!releaseAt) continue; // unresolvable → never dispatch on a guess
    out.push({ booking, releaseAt });
  }
  return out;
}

// The soonest release still ahead of us, or null when nothing is queued.
function getNextReleaseInstant(now = DateTime.now()) {
  let soonest = null;
  for (const { releaseAt } of resolvePendingReleases()) {
    if (releaseAt <= now) continue;
    if (!soonest || releaseAt < soonest) soonest = releaseAt;
  }
  return soonest;
}

// The release group for an armed instant. Same predicate the old inline filter
// used, so a Psycle Monday-noon cohort still dispatches exactly as before.
function bookingsReleasingAt(target) {
  return resolvePendingReleases()
    .filter(({ releaseAt }) => Math.abs(releaseAt.diff(target).milliseconds) < DISPATCH_WINDOW_MS)
    .map(({ booking }) => booking);
}

// Entries whose release slipped past while the process was down.
function runMissedReleases(now = DateTime.now()) {
  const missed = resolvePendingReleases()
    .filter(({ releaseAt }) => {
      const agoMs = now.diff(releaseAt).milliseconds;
      return agoMs > 0 && agoMs <= MISSED_RELEASE_GRACE_MS;
    })
    .map(({ booking }) => booking);

  if (missed.length > 0) {
    console.log(`[Scheduler] ${missed.length} booking(s) released in the last ${MISSED_RELEASE_GRACE_MS / 60000} mins while we were down — running now.`);
    executeAutoBookQueue(missed);
  }
  return missed.length;
}

// Enter the 10ms precision loop for an instant that is at most seconds away.
function armPrecisionLoop(targetRelease) {
  console.log('[Scheduler] Within 5 seconds of release window. Enabling precision high-frequency check loop...');
  const targetTimeMs = targetRelease.toMillis();
  preciseInterval = setInterval(() => {
    if (Date.now() < targetTimeMs) return;
    clearInterval(preciseInterval);
    preciseInterval = null;

    // Clear the event cache first so dispatch uses the freshest occupancy.
    clearEventCache();
    const active = bookingsReleasingAt(targetRelease);
    executeAutoBookQueue(active).then(() => {
      // Re-arm for whatever the queue releases next — not "next week".
      setTimeout(scheduleReleaseWindow, 10000);
    });
  }, 10);
}

// Core scheduler orchestrator
function scheduleReleaseWindow() {
  if (mainTimeout) clearTimeout(mainTimeout);
  if (prefetchTimeout) clearTimeout(prefetchTimeout);
  if (preciseInterval) clearInterval(preciseInterval);
  mainTimeout = prefetchTimeout = preciseInterval = null;

  const now = DateTime.now();
  const targetRelease = getNextReleaseInstant(now);

  if (!targetRelease) {
    // Nothing queued, or nothing with a resolvable future release.
    db.setKV('scheduler_next_release', '');
    console.log(`[Scheduler] No pending auto-booking has a future release — idling (re-check in ${IDLE_RECHECK_MS / 60000} mins).`);
    mainTimeout = setTimeout(scheduleReleaseWindow, IDLE_RECHECK_MS);
    return;
  }

  const diffMs = targetRelease.diff(now).milliseconds;
  const groupSize = bookingsReleasingAt(targetRelease).length;
  console.log(`[Scheduler] Next release scheduled for: ${targetRelease.toLocaleString(DateTime.DATETIME_FULL_WITH_ZONE)} (in ${(diffMs / 3600000).toFixed(2)} hours, ${groupSize} booking(s))`);
  db.setKV('scheduler_next_release', targetRelease.toISO());

  // 1. Prefetch at T-50s; individual fetches are staggered randomly within an
  //    18s window so all complete before T-30s.
  const prefetchDelay = diffMs - 50000;
  if (prefetchDelay > 0) {
    prefetchTimeout = setTimeout(async () => {
      // Re-resolved rather than captured: the queue can change during the wait.
      const active = bookingsReleasingAt(targetRelease);
      if (active.length > 0) {
        await prefetchAutoBookSlots(active);
      }
    }, prefetchDelay);
  }

  // 2. Precise execution trigger, waking 5s before T-0.
  const executionDelay = diffMs - 5000;
  if (executionDelay > 0) {
    mainTimeout = setTimeout(() => armPrecisionLoop(targetRelease), executionDelay);
  } else {
    // Already inside the final 5s (a boot or a re-arm landed in the window).
    // getNextReleaseInstant only returns future instants, so this is imminent,
    // never stale — go straight into the precision loop.
    armPrecisionLoop(targetRelease);
  }
}

// Recompute the wake clock. Call after anything that changes the pending queue:
// a newly queued class may release sooner than what is currently armed, and a
// deleted one may have been the only reason we were armed at all.
function rearm() {
  const armed = db.getKV('scheduler_next_release') || null;
  const next = getNextReleaseInstant();
  const nextIso = next ? next.toISO() : null;
  if (armed === nextIso) return; // nothing moved — don't churn the timers
  console.log(`[Scheduler] Queue changed; re-arming wake clock (${armed || 'idle'} → ${nextIso || 'idle'}).`);
  scheduleReleaseWindow();
}

// Immediate execution runner for beyond-cutoff booking
function checkAndRunImmediateBookings(userId) {
  const pending = db.getPendingAutoBookings().filter(b => b.user_id === userId);
  const now = DateTime.now();

  const immediateBookings = pending.filter(b => {
    const settings = db.getUserSettings(b.user_id, b.gym_id) || {};
    const releaseTime = getClassReleaseTime(b, settings);
    if (!releaseTime) return false;
    // Release time is in the past
    return releaseTime <= now;
  });

  if (immediateBookings.length > 0) {
    console.log(`[Scheduler] Found ${immediateBookings.length} bookings with past release windows. Executing immediately.`);
    executeAutoBookQueue(immediateBookings);
  }
}

// Run all pending auto-bookings for a user regardless of release window — used for simulated releases
function runAllPendingBookings(userId) {
  const pending = db.getPendingAutoBookings().filter(b => b.user_id === userId);
  if (pending.length > 0) {
    console.log(`[Scheduler] Simulated release: executing ${pending.length} pending booking(s) for user ${userId}.`);
    executeAutoBookQueue(pending);
  } else {
    console.log(`[Scheduler] Simulated release: no pending bookings for user ${userId}.`);
  }
}

// Register an SSE client for a user
function registerSSEClient(userId, res) {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId).add(res);
  console.log(`[Scheduler] SSE client connected for user ${userId}. Total clients: ${sseClients.get(userId).size}`);
}

// Unregister an SSE client for a user
function unregisterSSEClient(userId, res) {
  const clients = sseClients.get(userId);
  if (clients) {
    clients.delete(res);
    console.log(`[Scheduler] SSE client disconnected for user ${userId}. Remaining clients: ${clients.size}`);
    if (clients.size === 0) {
      sseClients.delete(userId);
    }
  }
}

module.exports = {
  init() {
    console.log('[Scheduler] Precision Auto-Book Scheduler initialized.');
    // Liveness heartbeat for /api/health — proves the scheduler process is alive
    // even between weekly release windows (it's otherwise timer-driven and idle).
    db.setKV('heartbeat:scheduler', Date.now().toString());
    setInterval(() => db.setKV('heartbeat:scheduler', Date.now().toString()), 60000);
    // A release that landed while the process was down, if it only just happened.
    // Previously this was inferred from "Monday noon minus a week"; it now comes
    // from the queue, so it works for a per-class gym too.
    runMissedReleases();
    scheduleReleaseWindow();
  },
  getClassReleaseTime,
  // Layer I: the wake clock. Exported for test-wake-clock.js, which asserts the
  // armed instant for a mixed Psycle+JAB queue — the assertion whose absence let
  // the hardcoded Monday noon survive WP-D8.
  getNextReleaseInstant,
  bookingsReleasingAt,
  scheduleReleaseWindow,
  rearm,
  // Exported for test-booking-window.js, which asserts this stays byte-for-byte
  // equivalent to client/src/lib.js's copy. The two are hand-mirrored; drift
  // means auto-book fires at a different instant than the countdown shown.
  getBookingOffset,
  checkAndRunImmediateBookings,
  runAllPendingBookings,
  registerSSEClient,
  unregisterSSEClient,
  emitStatusUpdate,
  prefetchAutoBookSlots,
  getCachedEvent,
  setCachedEvent,
  // C2-3: rate-limit distress abort. Exported for test-rate-limit-abort.js.
  executeAutoBookForClass,
  executeAutoBookQueue,
  isGymRateLimited,
  applyRateLimitBackoff,
  _resetRateLimitBackoffForTests,
};
