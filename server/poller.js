const cron = require('node-cron');
const { cleanClassName: _cleanClassName } = require('./class-name');
// U1-19b: push/SSE text names a class the way the UI does (no discipline prefix).
const displayClass = (row) => _cleanClassName(row.class_name, row.group_name) || row.class_name;
const { DateTime } = require('luxon');
const db = require('./db');
const pushService = require('./push');
const notifications = require('./notifications');
const { triggerAutoRelogin } = require('./auth');
const { getCachedEvent, setCachedEvent } = require('./scheduler');
// C2-3b: one backoff state shared with the scheduler (see rate-limit-backoff.js).
const {
  isGymRateLimited,
  applyRateLimitBackoff,
  noteThrottleError,
  noteThrottleResponse,
  notifyRateLimited,
} = require('./rate-limit-backoff');
const { getProvider } = require('./providers');
const { zoneOfGym } = require('./providers/timezone');
const { getGymConfig } = require('./gyms.config');
const { formatSpotLabel } = require('./spot-label');
const { policyOf, isRollingWeekly, mostRecentRelease } = require('./providers/booking-window');

// Interim single-gym bridge: until multi-gym login lands (WP-D3), all polling
// is CodexFit / Psycle London. See server/auth.js for the same bridge.
// No module-level provider (WP-D7). Every fetch below resolves its gym — from
// the ROW being processed where there is one (background work must run for a gym
// the user isn't currently looking at), otherwise from the user's active gym.

// Track slots upgraded in the current poller check cycle to prevent double-booking/race conditions
const claimedSlots = new Set();

// Fetch public (no-auth) CodexFit endpoints (events, locations, studios, instructors).
// These are documented as public — no Bearer token required.
// Unauthenticated read (e.g. /events/:id, which most providers serve without a
// token). `gymId` is explicit for the same reason as fetchFromGym: background
// callers pass the row's gym, not the user's active one.
async function fetchPublicFromGym(userId, gymId, path) {
  const user = userId ? db.getUserById(userId) : null;
  const isMock = (user && user.email === 'dev@psycle.com') || /\/events\/\d{4}(\b|$)/.test(path) || path.includes('/locations') || path.includes('/studios');
  if (isMock) {
    const mock = require('./mock');
    return mock.handleMockRequest(path, 'GET', null);
  }

  return getProvider(gymId).publicRequest(path, { method: 'GET' });
}

// `gymId` is explicit: background callers pass the row's own gym. `path` is a
// PATH, not a URL — the provider prepends its gym's base, which is the whole
// point (an absolute URL would bypass it and pin every gym to Psycle's host).
async function fetchFromGym(userId, gymId, path, options = {}) {
  const user = db.getUserById(userId);
  if (user && user.email === 'dev@psycle.com') {
    const mock = require('./mock');
    return mock.handleMockRequest(path, options.method || 'GET', options.body ? JSON.parse(options.body) : null);
  }

  // The ROW's gym session — NOT db.getUserById(userId).jwt, which resolves the
  // user's ACTIVE gym (db.resolveActiveGymId) and is wrong for a background
  // call site processing a gym the user isn't currently looking at (C3-12).
  const session = db.getUserSession(userId, gymId);
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
      console.error(`[Poller] Auto-relogin failed for user ${userId}:`, err.message);
      pushService.sendNotification(userId, 'Session Expired ⚠️', 'Failed to renew session. Auto-upgrade paused.');
      throw err;
    }
  }
  // C2-3b: a 429 (or Retry-After 403) from ANY poller read/write backs the gym off.
  if (!res.ok) noteThrottleResponse(gymId, res);
  return res;
}

// Cancel a booking
async function apiCancelBooking(userId, gymId, bookingId) {
  const res = await fetchFromGym(userId, gymId, `/bookings/${bookingId}`, { method: 'DELETE' });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.message || `Failed to cancel booking ${bookingId}`);
  }
}

// Attempt one auto-upgrade booking via the adapter, with the same
// 401-triggers-relogin ladder the old inline fetchCodexFit() gave every
// authenticated call (WP-N3). The adapter's bookSlot() never retries itself
// (base.js request() convention — see providers/codexfit.js), so the ladder
// lives here, exactly mirroring scheduler.js's bookSlotWithRelogin. Only the
// booking HTTP call + response parsing move to the adapter; the surrounding
// claim/credit/cutoff logic in attemptUpgradeSlot is unchanged.
// Atomic spot swap with the same 401→relogin→retry ladder as bookSlotWithRelogin.
// Only reachable for gyms whose capabilities declare `atomicSwap`.
async function swapSpotsWithRelogin(userId, gymId, bookingId, currentSlotId, targetSlot) {
  // The ROW's gym session — see fetchFromGym's note above (C3-12).
  let session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) throw new Error('User has no active session. Please log in.');
  const provider = getProvider(gymId);
  let result = await provider.swapSpots(bookingId, currentSlotId, targetSlot, session);
  if (result && result.status === 401) {
    const newJwt = await triggerAutoRelogin(userId, gymId);
    result = await provider.swapSpots(bookingId, currentSlotId, targetSlot, { ...session, accessToken: newJwt });
  }
  return result;
}

async function bookSlotWithRelogin(userId, gymId, eventId, targetSlot) {
  // The ROW's gym session — see fetchFromGym's note above (C3-12).
  let session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) throw new Error('User has no active session. Please log in.');
  const provider = getProvider(gymId);
  let result = await provider.bookSlot(eventId, [targetSlot], session);
  if (!result.ok && result.status === 401) {
    console.log(`[Poller] Auto-upgrade booking got 401 for user ${userId} — attempting relogin and retry.`);
    const newJwt = await triggerAutoRelogin(userId, gymId);
    session = { accessToken: newJwt };
    result = await provider.bookSlot(eventId, [targetSlot], session);
  }
  return result;
}

// Returns a stable per-monitor jitter offset in seconds (0–55), derived from the
// monitor's ID so it's consistent across restarts without storing it in the DB.
function upgradeJitterSeconds(upgradeId) {
  return (upgradeId * 7919) % 56; // 7919 is prime; result in [0, 55]
}

// Check if polling interval has elapsed (with per-monitor jitter baked into the threshold)
function shouldCheckUpgrade(upgrade, settings) {
  if (!upgrade.last_checked_at) return true;

  const interval = settings.autoUpgradeInterval || '15min';
  const lastChecked = DateTime.fromISO(upgrade.last_checked_at);
  const now = DateTime.now();

  const diffMinutes = now.diff(lastChecked, 'minutes').minutes;
  const jitterMinutes = upgradeJitterSeconds(upgrade.id) / 60;

  if (interval === '1min') return diffMinutes >= 1.0 + jitterMinutes;
  if (interval === '15min') return diffMinutes >= 15.0 + jitterMinutes;
  if (interval === '1hr') return diffMinutes >= 60.0 + jitterMinutes;

  return diffMinutes >= 15.0 + jitterMinutes;
}

// Attempt upgrade for a single active upgrade monitor
// C2-3b: a booking/swap result that says PROVIDER_RATE_LIMITED (the normalized
// code from classifyProviderThrottle) arms THIS gym's backoff, notifies once per
// user+gym+day, and releases the slot claim. Returns true when it handled one, so
// the caller stops instead of logging an ordinary failed attempt.
function handleUpgradeThrottle(result, userId, gymId, claimKey) {
  if (!result || result.code !== 'PROVIDER_RATE_LIMITED') return false;
  const until = applyRateLimitBackoff(gymId, result.retryAfterMs);
  console.error(`[Poller] Gym ${gymId} rate-limited an auto-upgrade attempt (${result.error}). Backing off until ${new Date(until).toISOString()}.`);
  claimedSlots.delete(claimKey);
  notifyRateLimited(userId, gymId);
  return true;
}

// true = still booked, false = gone (cancelled), null = could not tell.
// A booking id can go stale (cancel-then-rebook mints a new one); if the id is gone
// but the member still holds this event in this monitor's slot, follow the new id.
async function originalBookingStillHeld(upgrade) {
  try {
    const bookings = await listBookingsWithRelogin(upgrade.user_id, upgrade.gym_id);
    const live = (bookings || []).filter(b => b && !b.isWaitlist);
    const wanted = String(upgrade.booking_id ?? '');
    if (live.some(b => wanted ? String(b.bookingId) === wanted : String(b.eventId) === String(upgrade.event_id))) return true;
    if (wanted) {
      const moved = live.find(b => String(b.eventId) === String(upgrade.event_id) &&
        String(b.slotId) === String(upgrade.current_slot_id));
      if (moved) {
        upgrade.booking_id = Number(moved.bookingId);
        try { db.relinkAutoUpgradeBooking(upgrade.id, upgrade.user_id, moved.bookingId); } catch (_) {}
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(`[Poller] Could not verify booking for upgrade ${upgrade.id}:`, err.message);
    return null;
  }
}

async function attemptUpgradeSlot(upgrade, isCutoffMode) {
  const eventId = String(upgrade.event_id);
  const userId = upgrade.user_id;
  // From the ROW, not the active gym: the poller scans every gym's monitors, and
  // a JAB upgrade must run while the user is looking at Psycle (see db.js's gym
  // scoping rule).
  const gymId = upgrade.gym_id;
  const gym = getGymConfig(gymId);
  // Set when an atomic swap moved the reservation, so the cancel-then-rebook
  // cleanup below knows there is nothing left to cancel.
  let usedAtomicSwap = false;
  const currentSlotId = String(upgrade.current_slot_id);
  const prefs = JSON.parse(upgrade.preferences) || {};
  // Preferred slots come from the LIVE shared studio map; fall back to snapshot for legacy records.
  const liveMap = db.getStudioPreference(userId, upgrade.studio_id, gymId) || {};
  const preferredSlots = (liveMap.preferredSlots || prefs.preferredSlots || []).map(String);
  const preferredRows = liveMap.preferredRows || prefs.preferredRows || [];

  if (preferredSlots.length === 0 && preferredRows.length === 0) return;

  // C2-3b: this gym is refusing us — send nothing until the backoff expires.
  // Returns before touching the monitor row, so it is simply due again after.
  if (isGymRateLimited(gymId)) return;

  try {
    // 1. Get live slot availability via provider adapter — use shared cache to avoid N fetches/min
    let details = getCachedEvent(gymId, eventId);
    if (details) {
      console.log(`[Poller] Cache hit for event ${eventId} (user ${userId}).`);
    } else {
      const provider = getProvider(gymId);
      const session = db.getUserSession(userId, gymId);
      details = await provider.fetchEventDetails(eventId, session);
      if (!details) return;
      setCachedEvent(gymId, eventId, details, 30000);
    }

    const upgradeLayout = details.slots || [];
    const availableSlots = upgradeLayout.filter(s => s && s.isAvailable).map(s => String(s.id));
    const labelForSlot = (id) => {
      const s = upgradeLayout.find(ls => String(ls.id) === String(id));
      return s?.label ?? String(id);
    };

    // Combine preferred slots and resolve row preferences
    const combinedPreferredSlots = [...preferredSlots];
    if (preferredRows.length > 0 && upgradeLayout.length > 0) {
      preferredRows.forEach(ry => {
        const slotsInRow = upgradeLayout.filter(s => Math.round(s.y * 10) / 10 === Number(ry));
        slotsInRow.forEach(s => {
          const idStr = String(s.id);
          if (!combinedPreferredSlots.includes(idStr)) {
            combinedPreferredSlots.push(idStr);
          }
        });
      });
    }

    if (combinedPreferredSlots.length === 0) return;

    const currentIndex = combinedPreferredSlots.indexOf(currentSlotId);
    // If current slot is already the absolute best, nothing to upgrade
    if (currentIndex === 0) {
      db.updateAutoUpgrade(upgrade.id, userId, 'stopped', 'Already in the most preferred slot.', { lastCheckedAt: new Date().toISOString() });
      return;
    }

    // 2. Iterate preferred slots to find a better one
    for (let i = 0; i < combinedPreferredSlots.length; i++) {
      const candidateSlot = combinedPreferredSlots[i];

      // If we've hit our current slot or worse, stop checking
      if (currentIndex !== -1 && i >= currentIndex) break;

      // Candidate slot is available! Let's upgrade
      const claimKey = `${gymId}:${eventId}:${candidateSlot}`; // C3-23: provider ids collide across gyms
      if (availableSlots.includes(candidateSlot) && !claimedSlots.has(claimKey)) {
        // Second line of defence: a monitor must never book a class the member no
        // longer holds. Fails CLOSED — if the bookings list can't be read, book nothing.
        const held = await originalBookingStillHeld(upgrade);
        if (held === false) {
          console.log(`[Poller] Booking ${upgrade.booking_id} for event ${eventId} no longer exists — stopping monitor ${upgrade.id}.`);
          db.updateAutoUpgrade(upgrade.id, userId, 'stopped', 'Original booking no longer exists — monitoring stopped.', { lastCheckedAt: new Date().toISOString() });
          return;
        }
        if (held === null) return;
        console.log(`[Poller] Better slot ${candidateSlot} available for event ${eventId} (current: ${currentSlotId}). Upgrading...`);
        claimedSlots.add(claimKey);

        let bookResult;
        try {
          const isMetered = gym?.capabilities?.metered !== false;
          const isAtomic = !!(gym && gym.capabilities && gym.capabilities.atomicSwap && upgrade.booking_id);

          // Check credits ONLY for metered gyms where we are NOT doing an atomic swap
          if (isMetered && !isAtomic) {
            await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 600)));
            const profileUrl = '/profile';
            const profileRes = await fetchFromGym(userId, gymId, profileUrl);
            if (!profileRes.ok) {
              claimedSlots.delete(claimKey);
              return;
            }

            const profileData = await profileRes.json();
            const profile = profileData.data || profileData;
            try { db.cacheUserProfile(userId, profile, gymId); } catch (_) {}
            // Same rule the resume path uses (C5-1), so a monitor can't flap
            // pause/resume: guest-only, expired and wrong-type credits don't count.
            const hasCredits = hasUsableCredits(
              (profile.available_credits || []).map(c => ({
                typeId: c.credit_type && c.credit_type.id != null ? String(c.credit_type.id) : undefined,
                count: Number(c.count) || 0,
                expiresAt: c.expires_at || undefined,
                isGuestOnly: c.credit_type && typeof c.credit_type.is_guest_use_only === 'boolean' ? c.credit_type.is_guest_use_only : undefined,
              })),
              details && details.event && details.event.credits
            );

            if (!hasCredits) {
              console.log(`[Poller] Auto-upgrade paused for user ${userId}: No available credits.`);
              db.updateAutoUpgrade(upgrade.id, userId, 'paused_no_credits', 'No credits available to claim upgraded slot.', { lastCheckedAt: new Date().toISOString() });
              pushService.sendNotification(userId, 'Upgrade Paused ⏳', `No credits available to upgrade ${displayClass(upgrade)}.`);
              claimedSlots.delete(claimKey);
              return;
            }
          }

          await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 600)));

          // Prefer an ATOMIC swap where the platform has one (WP-D14).
          //
          // Cancel-then-rebook exists because CodexFit has no swap API — see
          // AGENTS.md "Spot Swapping Limitations". On a platform that does, it is
          // actively dangerous: the cancel can succeed and the rebook fail,
          // leaving the user with no spot at all in a class they had one in.
          // MarianaTek's POST /reservations/{id}/swap_spots is one call that
          // either moves them or doesn't.
          if (isAtomic) {
            bookResult = await swapSpotsWithRelogin(userId, gymId, upgrade.booking_id, upgrade.current_slot_id, candidateSlot);
            if (!bookResult.ok && handleUpgradeThrottle(bookResult, userId, gymId, claimKey)) return;
            if (!bookResult.ok) {
              console.warn(`[Poller] Atomic swap failed:`, bookResult.error || bookResult.status);
              claimedSlots.delete(claimKey);
              return; // Retry next cycle — nothing was given up.
            }
            usedAtomicSwap = true;
          } else {
            bookResult = await bookSlotWithRelogin(userId, gymId, eventId, candidateSlot);
          }

          if (!bookResult.ok && handleUpgradeThrottle(bookResult, userId, gymId, claimKey)) return;
          if (!bookResult.ok) {
            console.warn(`[Poller] Auto-upgrade slot booking failed:`, bookResult.error || bookResult.status);
            claimedSlots.delete(claimKey);
            return; // Retry next time
          }
        } catch (err) {
          claimedSlots.delete(claimKey);
          throw err;
        }

        // bookResult.bookingId is the CodexFit booking id the adapter parsed from
        // the { bookings: { id: slot } } response map (AGENTS.md "Booking response
        // shape"). The old inline code read bookData?.id — a field that response
        // NEVER has — so newBookingId was ALWAYS 0 here. new_booking_id is a
        // write-only column (nothing reads it today), so yielding the real id is a
        // latent-bug fix with no observable behavior change. Number() matches the
        // INTEGER column + the old numeric type (same coercion scheduler.js uses).
        const newBookingId = Number(bookResult.bookingId) || 0;

        // Cancel the original booking (if not in cutoff mode).
        // An atomic swap already moved the reservation — there is no second
        // booking to clean up, and cancelling here would cancel the upgrade.
        if (!usedAtomicSwap && !isCutoffMode && upgrade.booking_id) {
          try {
            // Found during the C3-12 audit: this was missing gymId entirely
            // (apiCancelBooking(userId, gymId, bookingId)), so it silently
            // cancelled `/bookings/undefined` against whatever gym happened to
            // land in the gymId slot.
            await apiCancelBooking(userId, gymId, upgrade.booking_id);
            console.log(`[Poller] Successfully cancelled original booking ${upgrade.booking_id}`);
          } catch (cancelErr) {
            console.error(`[Poller] Failed to cancel original booking ${upgrade.booking_id}:`, cancelErr.message);
            // Even if cancellation failed, the upgrade booking succeeded
            pushService.sendNotification(
              userId,
              'Upgrade Warning ⚠️',
              `Upgraded to slot ${candidateSlot} for ${displayClass(upgrade)}, but original booking cancellation failed. Please cancel manually.`
            );
          }
        }

        // Update database upgrade job record
        const nowStr = new Date().toISOString();
        if (isCutoffMode) {
          db.updateAutoUpgrade(upgrade.id, userId, 'cutoff_booked', `Upgraded to slot ${candidateSlot} within 12h window — original seat kept. Please ask ${gym?.shortName || gym?.name || 'the gym'} to cancel original booking ${upgrade.booking_id}.`, {
            upgradedSlotId: candidateSlot,
            upgradedAt: nowStr,
            newBookingId,
            lastCheckedAt: nowStr
          });
          notifications.notify(userId, 'upgrade', {
            gymId,
            slot: labelForSlot(candidateSlot),
            startAt: upgrade.start_at,
            groupName: upgrade.group_name,
            className: upgrade.class_name,
            instructorName: upgrade.instructor_name,
            keptOriginal: true,
          });
        } else {
          db.updateAutoUpgrade(upgrade.id, userId, 'active', `Upgraded to slot ${candidateSlot}. Monitoring for better slots...`, {
            currentSlotId: candidateSlot,
            // The original booking was cancelled and re-booked: follow the new id,
            // or the card loses its indicator and the next check stops the monitor.
            bookingId: (!usedAtomicSwap && newBookingId > 0) ? newBookingId : undefined,
            newBookingId,
            upgradedSlotId: candidateSlot,
            upgradedAt: nowStr,
            lastCheckedAt: nowStr
          });
          notifications.notify(userId, 'upgrade', {
            gymId,
            slot: labelForSlot(candidateSlot),
            startAt: upgrade.start_at,
            groupName: upgrade.group_name,
            className: upgrade.class_name,
            instructorName: upgrade.instructor_name,
            keptOriginal: false,
          });
        }
        // Refresh the calendar feed so the upgraded seat shows immediately.
        try { require('./calendar').regenerateSnapshot(userId); } catch (_) {}
        return; // Success! Exit check loop
      }
    }

    // No better slot found, just update check timestamp
    db.updateAutoUpgrade(upgrade.id, userId, 'active', 'No better slot available. Monitoring...', { lastCheckedAt: new Date().toISOString() });

  } catch (err) {
    // C2-3b: a thrown 429 from a read (event details, profile) backs the gym off too.
    if (noteThrottleError(gymId, err)) {
      console.error(`[Poller] Gym ${gymId} rate-limited (${err.message}). Backing off auto-upgrade polling for this gym.`);
      notifyRateLimited(userId, gymId);
    } else {
      console.error(`[Poller] Error in upgrade worker for event ${eventId}:`, err.message);
    }
  }
}

// ─── Paused-monitor resume (C5-1) ────────────────────────────────────────────

/**
 * Can this credit inventory pay for a class? Pure.
 *
 * Counts only credits the member can spend on THEMSELVES: not guest-only, not
 * expired, and — where the class's requirement is known — of an accepted type.
 * Compares the usable total to `credits.required` (default 1). An absent
 * `classCredits` means "the payload said nothing", which falls back to cost 1 /
 * any type, never to "free" (AGENTS.md, per-class credit cost).
 *
 * @param {Array<{typeId?:string,count:number,expiresAt?:string,isGuestOnly?:boolean}>} credits
 * @param {{required?:number, acceptedTypeIds?:string[]}=} classCredits
 */
function hasUsableCredits(credits, classCredits, now = Date.now()) {
  const accepted = classCredits && Array.isArray(classCredits.acceptedTypeIds)
    ? classCredits.acceptedTypeIds.map(String) : [];
  const required = classCredits && Number.isFinite(Number(classCredits.required)) && Number(classCredits.required) > 0
    ? Number(classCredits.required) : 1;
  let usable = 0;
  for (const c of credits || []) {
    if (!c || !(c.count > 0)) continue;
    if (c.isGuestOnly === true) continue;
    if (c.expiresAt && Date.parse(c.expiresAt) <= now) continue;
    if (accepted.length > 0 && !(c.typeId != null && accepted.includes(String(c.typeId)))) continue;
    usable += c.count;
  }
  return usable >= required;
}

// A paused monitor is re-checked no more often than this, whatever its interval
// setting: an out-of-credits member isn't racing anyone for a seat.
const PAUSED_RECHECK_MIN_INTERVAL = '15min';

/**
 * Re-check monitors paused for credits and put back the ones that can now pay.
 *
 * Per ROW and per gym: credits come from the row's own gym session, one read per
 * user+gym per cycle (shared by all that user's paused monitors there). Never
 * touches a gym under a C2-3 rate-limit backoff. A failed or unavailable read
 * leaves the monitor paused — "not loaded" is not "has credits".
 */
async function resumePausedUpgrades() {
  const paused = db.getPausedNoCreditsAutoUpgrades();
  if (paused.length === 0) return;

  const now = DateTime.now();
  const creditReads = new Map(); // `${userId}:${gymId}` -> Promise<credits|null>

  for (const upgrade of paused) {
    try {
      const { user_id: userId, gym_id: gymId } = upgrade;
      const settings = db.getUserSettings(userId, gymId) || {};
      if (settings.autoUpgradeEnabled === false) continue;

      // Pausing only ever happens on a metered, non-atomic gym; if the gym has
      // since changed, there is nothing credit-shaped to wait for.
      const gym = getGymConfig(gymId);
      if (gym && gym.capabilities && gym.capabilities.metered === false) {
        db.updateAutoUpgrade(upgrade.id, userId, 'active', 'Gym no longer credit-metered. Monitoring resumed.', { lastCheckedAt: null });
        continue;
      }

      // The window can close while a monitor sits paused. Mirror the active
      // loop's limits so it neither resumes into a dead window nor lingers as
      // "paused" forever.
      const prefs = JSON.parse(upgrade.preferences) || {};
      const classStart = DateTime.fromISO(upgrade.start_at, { zone: zoneOfGym(upgrade.gym_id) });
      const hoursUntil = classStart.diff(now, 'hours').hours;
      if (hoursUntil <= 1) {
        db.updateAutoUpgrade(upgrade.id, userId, 'stopped', 'Class is within 1 hour — monitoring stopped.', { lastCheckedAt: now.toISO() });
        continue;
      }
      const pastCutoff = classStart.diff(now, 'seconds').seconds <= 12 * 3600 + 5;
      if (pastCutoff && !(prefs.keepOriginalOnCutoff && !prefs.cutoffAttempted)) {
        db.updateAutoUpgrade(upgrade.id, userId, 'stopped', 'Stopped at 12h cutoff while paused for credits.', { lastCheckedAt: now.toISO() });
        continue;
      }

      if (!shouldCheckUpgrade(upgrade, { autoUpgradeInterval: PAUSED_RECHECK_MIN_INTERVAL })) continue;
      if (isGymRateLimited(gymId)) continue; // C2-3: don't add load to a throttled gym

      const key = `${userId}:${gymId}`;
      if (!creditReads.has(key)) {
        creditReads.set(key, (async () => {
          try {
            const session = db.getUserSession(userId, gymId);
            if (!session || !session.accessToken) return null;
            return await getProvider(gymId).getCredits(session);
          } catch (err) {
            noteThrottleError(gymId, err);
            console.warn(`[Poller] Resume check: credits read failed for user ${userId} (${gymId}): ${err.message}`);
            return null;
          }
        })());
      }
      const credits = await creditReads.get(key);
      if (credits === null) continue; // unknown: leave paused, retry next cycle

      // Accepted types/cost only when the event is already cached — no extra fetch.
      const cached = getCachedEvent(gymId, String(upgrade.event_id));
      if (hasUsableCredits(credits, cached && cached.event && cached.event.credits)) {
        console.log(`[Poller] Auto-upgrade monitor ${upgrade.id} resumed for user ${userId}: credits available.`);
        // lastCheckedAt null => due immediately, so the attempt runs this cycle.
        db.updateAutoUpgrade(upgrade.id, userId, 'active', 'Credits available again. Monitoring resumed.', { lastCheckedAt: null });
        pushService.sendNotification(userId, 'Upgrade Resumed ✅', `Credits are back — monitoring ${displayClass(upgrade)} for a better spot again.`);
      } else {
        db.updateAutoUpgrade(upgrade.id, userId, 'paused_no_credits', upgrade.status_message || 'No credits available to claim upgraded slot.', { lastCheckedAt: now.toISO() });
      }
    } catch (err) {
      console.error(`[Poller] Resume check failed for upgrade ID ${upgrade.id}:`, err.message);
    }
  }
}

// Stop rules that need no network and no polling: the 1h hard stop and the 12h
// cutoff. Shared by the active loop and the paused_disabled sweep so a paused
// monitor can never outlive its window. Returns true when it stopped the row.
const CUTOFF_BUFFER_S = 5;
function stopIfWindowClosed(upgrade, prefs, now, why) {
  const classStart = DateTime.fromISO(upgrade.start_at, { zone: zoneOfGym(upgrade.gym_id) });
  if (classStart.diff(now, 'hours').hours <= 1) {
    db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Class is within 1 hour — monitoring stopped.', { lastCheckedAt: now.toISO() });
    return true;
  }
  if (classStart.diff(now, 'seconds').seconds <= 12 * 3600 + CUTOFF_BUFFER_S
      && !(prefs.keepOriginalOnCutoff && !prefs.cutoffAttempted)) {
    db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', why, { lastCheckedAt: now.toISO() });
    return true;
  }
  return false;
}

/**
 * Per-gym "polling" switch -> monitors. Least destructive model: turning polling
 * OFF pauses that gym's monitors as 'paused_disabled' (rows, spot maps and
 * prefs survive); turning it back ON resumes them, due immediately. A paused
 * monitor whose class window closes meanwhile is stopped, never left dangling.
 * Settings are read per ROW's gym, never the active gym's.
 */
function syncDisabledUpgrades(now) {
  for (const upgrade of db.getPausedDisabledAutoUpgrades()) {
    try {
      const settings = db.getUserSettings(upgrade.user_id, upgrade.gym_id) || {};
      if (settings.autoUpgradeEnabled === false) {
        const prefs = JSON.parse(upgrade.preferences) || {};
        stopIfWindowClosed(upgrade, prefs, now, 'Stopped at 12h cutoff while auto-upgrade polling was off.');
      } else {
        db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'active', 'Polling turned back on. Monitoring resumed.', { lastCheckedAt: null });
      }
    } catch (err) {
      console.error(`[Poller] Disabled-sync failed for upgrade ID ${upgrade.id}:`, err.message);
    }
  }
}

// Orchestrate all upgrades checks
async function executeAutoUpgradeChecks() {
  claimedSlots.clear();
  await resumePausedUpgrades();
  syncDisabledUpgrades(DateTime.now());
  const active = db.getActiveAutoUpgrades();
  if (active.length === 0) return;

  const now = DateTime.now();

  for (const upgrade of active) {
    try {
      // THIS monitor's own gym (settings are per user+gym, not the active gym's).
      const settings = db.getUserSettings(upgrade.user_id, upgrade.gym_id) || {};
      const pollingOn = settings.autoUpgradeEnabled !== false;

      const classStart = DateTime.fromISO(upgrade.start_at, { zone: zoneOfGym(upgrade.gym_id) });
      const hoursUntilClass = classStart.diff(now, 'hours').hours;

      // Class already started or <=1h away: hard stop. Runs BEFORE the interval
      // gate so a 1hr interval can't delay a stop by up to an hour.
      if (hoursUntilClass <= 1) {
        db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Class is within 1 hour — monitoring stopped.', { lastCheckedAt: now.toISO() });
        continue;
      }

      const prefs = JSON.parse(upgrade.preferences) || {};
      // C2-3b: a backed-off gym gets no attempts. Checked before the one-shot
      // cutoff attempt is marked used, so backoff can't burn the final attempt.
      const gymLimited = isGymRateLimited(upgrade.gym_id);

      // 12h cutoff boundary (5s early, to avoid the cancel-free boundary race).
      // Also before the interval gate, so the stop / final attempt lands at the
      // cutoff rather than up to one interval late.
      if (classStart.diff(now, 'seconds').seconds <= 12 * 3600 + CUTOFF_BUFFER_S) {
        if (prefs.keepOriginalOnCutoff && pollingOn) {
          // Opted in to continue past 12h: one final attempt (no cancel), then stop
          if (!prefs.cutoffAttempted) {
            if (gymLimited) continue;
            console.log(`[Poller] Under 12h for event ${upgrade.event_id}. Final attempt — original seat will be kept.`);
            prefs.cutoffAttempted = true;
            db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'active', 'Running final upgrade attempt within 12h window...', {
              preferences: prefs,
              lastCheckedAt: now.toISO()
            });
            await attemptUpgradeSlot(upgrade, true);
          } else {
            db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Final 12h upgrade attempt already made. Monitoring stopped.', { lastCheckedAt: now.toISO() });
          }
        } else {
          // Not opted in (or polling off) — stop at 12h, no attempt
          db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Stopped at 12h cutoff to avoid cancellation penalty.', { lastCheckedAt: now.toISO() });
          pushService.sendNotification(upgrade.user_id, 'Upgrade Monitor Stopped ⏳', `No better seat found for ${displayClass(upgrade)} before the 12h cutoff.`);
        }
        continue;
      }

      // Polling switched off for this gym: pause (reversible) instead of polling.
      if (!pollingOn) {
        db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'paused_disabled', 'Paused — auto-upgrade polling is off for this gym. Resumes when turned back on.', { lastCheckedAt: upgrade.last_checked_at });
        continue;
      }

      // The gym's CURRENT interval setting applies to existing monitors too.
      if (!shouldCheckUpgrade(upgrade, settings)) continue;

      // Standard active check (>12h before class)
      if (gymLimited) continue;
      await attemptUpgradeSlot(upgrade, false);

    } catch (err) {
      console.error(`[Poller] Upgrade check failed for upgrade ID ${upgrade.id}:`, err.message);
    }
  }
}

// ─── Booking-schedule discovery ──────────────────────────────────────────────
// Refresh booking caches for users who have cancellation reminders enabled and at
// least one push subscription. Runs every few hours — reminders themselves fire
// locally from the cache with no extra API cost.
// One gym's bookings, via its own adapter, with the usual 401→relogin→retry.
async function listBookingsWithRelogin(userId, gymId) {
  const provider = getProvider(gymId);
  let session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) throw new Error(`no session for ${gymId}`);
  try {
    return await provider.listBookings(session);
  } catch (err) {
    if (err && err.status !== 401) throw err;
    const newJwt = await triggerAutoRelogin(userId, gymId);
    return provider.listBookings({ ...session, accessToken: newJwt });
  }
}

/**
 * Turn one gym's NormalizedBooking[] into booking_cache rows.
 *
 * CodexFit's list endpoint carries no embedded event, so the start time — the
 * one field a reminder cannot work without — has to be fetched per booking.
 * MarianaTek embeds it, and is used directly. The shared per-gym event cache
 * keeps this from becoming N live calls every sweep.
 */
async function bookingCacheRowsFor(userId, gymId) {
  const bookings = await listBookingsWithRelogin(userId, gymId);
  const rows = [];
  for (const nb of bookings || []) {
    if (!nb || nb.isWaitlist || !nb.eventId) continue;
    let ev = nb.event;
    if (!ev || !ev.startAt) {
      ev = getCachedEvent(gymId, nb.eventId)?.event;
      if (!ev) {
        const details = await getProvider(gymId)
          .fetchEventDetails(nb.eventId, db.getUserSession(userId, gymId));
        if (!details) continue;
        setCachedEvent(gymId, nb.eventId, details, 30000);
        ev = details.event;
      }
    }
    if (!ev || !ev.startAt) continue;
    rows.push({
      bookingId: nb.bookingId,
      gymId,
      eventId: nb.eventId,
      startAt: ev.startAt,
      className: ev.name || '',
      groupName: ev.discipline || '',
      instructorName: ev.instructors?.[0]?.name || '',
      studioName: ev.studioName || '',
      locationName: ev.locationName || '',
      locationAddress: ev.locationAddress || null,
      durationMin: ev.durationMin ?? null,
      slotLabel: formatSpotLabel(gymId, nb.slotLabel ?? nb.slotId ?? '', nb.spotSection),
    });
  }
  return rows;
}

async function refreshBookingCaches() {
  const userIds = db.getUserIdsWithPushSubs();
  for (const userId of userIds) {
    try {
      const prefs = notifications.getPrefs(userId);
      if (!prefs.cancellationReminder.enabled) continue;
      // Calendar-enabled users have their booking_cache kept fresh (and correctly
      // event-enriched) by calendar.js — skip here so we don't overwrite it.
      const settings = db.getUserSettings(userId);
      if (settings && settings.calendar && settings.calendar.enabled) continue;

      // EVERY linked gym. This used to read whichever single gym resolved from
      // the account, so a two-gym member got cancellation reminders for one of
      // them and silence for the other — and it used a raw CodexFit path, so
      // the gym it did read was only ever right for a CodexFit gym.
      const gymIds = (db.getUserGyms(userId) || []).map((g) => g.gym_id).filter(Boolean);
      const rows = [];
      const synced = [];
      for (const gymId of gymIds) {
        // C2-3b: skip a throttled gym. Not counted as "synced", so its cached
        // rows are kept rather than cleared.
        if (isGymRateLimited(gymId)) continue;
        await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 6000)));
        try {
          rows.push(...await bookingCacheRowsFor(userId, gymId));
          synced.push(gymId);
        } catch (err) {
          // Scope the write to the gyms that actually answered: a gym that
          // failed must keep its existing rows rather than have them cleared.
          noteThrottleError(gymId, err);
          console.error(`[Reminders] ${gymId} failed for user ${userId}:`, err.message);
        }
      }
      if (synced.length === 0) continue;
      db.replaceBookingCache(userId, rows, synced);
      console.log(`[Reminders] Cached ${rows.length} upcoming booking(s) for user ${userId} across ${synced.length} gym(s).`);
    } catch (err) {
      console.error(`[Reminders] Failed to refresh bookings for user ${userId}:`, err.message);
    }
  }
  // Housekeeping: drop past classes and stale dedupe keys.
  const now = DateTime.now().toISO();
  db.pruneBookingCache(now);
  db.pruneSentNotifications(DateTime.now().minus({ days: 30 }).toISO());
}

// ─── Local reminder firing (no API calls) ────────────────────────────────────
function checkCancellationReminders() {
  const now = DateTime.now();
  const cached = db.getAllBookingCache();
  for (const bk of cached) {
    try {
      const prefs = notifications.getPrefs(bk.user_id);
      if (!prefs.cancellationReminder.enabled) continue;

      const timing = prefs.cancellationReminder.timing === '14h' ? 14 : 24;
      const start = DateTime.fromISO(bk.start_at, { zone: zoneOfGym(bk.gym_id) });
      if (!start.isValid) continue;

      const hoursUntil = start.diff(now, 'hours').hours;
      // Only inside the free-cancellation window and at/after the chosen offset.
      if (hoursUntil <= 12) continue;
      if (hoursUntil > timing) continue;

      const key = `cancel:${bk.booking_id}:${timing}h`;
      if (db.wasNotificationSent(bk.user_id, key)) continue;
      db.markNotificationSent(bk.user_id, key);

      notifications.notify(bk.user_id, 'cancellationReminder', {
        gymId: bk.gym_id,
        startAt: bk.start_at,
        groupName: bk.group_name,
        className: bk.class_name,
        instructorName: bk.instructor_name,
        slot: bk.slot_label,
      });
    } catch (err) {
      console.error(`[Reminders] Cancellation reminder failed for booking ${bk.booking_id}:`, err.message);
    }
  }
}

// Weekly "booking opens in 1 hour" reminder, fired once per Monday-noon release.
/**
 * "Booking opens in an hour" — per gym, at THAT gym's own release moment.
 *
 * This used to be a single hardcoded Monday-noon-London check for every user and
 * every gym: Psycle's policy sitting in the orchestrator, the same mistake WP-I
 * removed from the scheduler. A rolling gym like JAB has no weekly moment at
 * all, so the notification was simply untrue there.
 *
 * Only a `rolling-weekly` gym has something to announce; whether a member wants
 * it is `notifications.bookingWindowEnabledForGym` (their override → the gym's
 * configured default → the gym's window kind).
 */
async function checkBookingWindowReminder() {
  const userIds = db.getUserIdsWithPushSubs();
  for (const userId of userIds) {
    const gymIds = (db.getUserGyms(userId) || []).map((g) => g.gym_id).filter(Boolean);
    for (const gymId of gymIds) {
      try {
        const cfg = getGymConfig(gymId);
        if (!cfg || !isRollingWeekly(cfg)) continue;
        if (!notifications.bookingWindowEnabledForGym(userId, gymId)) continue;

        const policy = policyOf(cfg);
        const now = DateTime.now().setZone(policy.timezone);
        const nextRelease = mostRecentRelease(policy, now).plus({ weeks: 1 });
        const fireAt = nextRelease.minus({ hours: 1 });
        if (now < fireAt || now >= nextRelease) continue;

        // Gym-qualified: two gyms can release on the same date, and each needs
        // its own reminder rather than one silently deduping the other away.
        const key = `window:${gymId}:${nextRelease.toISODate()}`;
        if (db.wasNotificationSent(userId, key)) continue;
        db.markNotificationSent(userId, key);
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30000)));
        await sendBookingWindowTip(userId, gymId);
      } catch (err) {
        console.error(`[Reminders] Booking-window reminder failed for user ${userId} (${gymId}):`, err.message);
      }
    }
  }
}

async function sendBookingWindowTip(userId, gymId) {
  // THIS gym's queue — a Psycle reminder must not count JAB's entries.
  const pending = db.getUserAutoBookings(userId, gymId).filter(b => b.status === 'pending');
  const count = pending.length;
  let tip;
  if (count === 0) {
    tip = "Don't forget to set up Auto-Book!";
  } else {
    let enough = true;
    const cfg = getGymConfig(gymId);
    // Credit arithmetic only means anything at a metered gym: a membership gym
    // has no balance to run short of, so "not enough credits" is never the
    // reason it would fail.
    if (cfg?.capabilities?.metered && !isGymRateLimited(gymId)) {
      try {
        const credits = await getProvider(gymId).getCredits(db.getUserSession(userId, gymId));
        const totalCredits = (credits || []).reduce((s, c) => s + (Number(c.count) || 0), 0);
        const needed = pending.reduce((s, b) => {
          let p = {};
          try { p = JSON.parse(b.preferences || '{}'); } catch (_) {}
          return s + (p.requiredCount || 1);
        }, 0);
        enough = totalCredits >= needed;
      } catch (err) { noteThrottleError(gymId, err); /* fall back to the neutral tip */ }
    }
    const plural = count !== 1 ? 'es' : '';
    tip = enough
      ? `You have ${count} class${plural} set to Auto-Book.`
      : `⚠️ You have ${count} class${plural} set to Auto-Book, but you don't have enough credits.`;
  }
  await notifications.notify(userId, 'bookingWindow', { tip, gymId });
}

module.exports = {
  hasUsableCredits,
  init() {
    console.log('[Poller] Auto-Upgrade Poller initialized.');
    // Liveness heartbeat for /api/health (seed now, refresh each cron tick).
    db.setKV('heartbeat:poller', Date.now().toString());
    // Auto-upgrade checks every minute (respects each monitor's own interval).
    cron.schedule('* * * * *', async () => {
      db.setKV('heartbeat:poller', Date.now().toString());
      console.log('[Poller] Running auto-upgrade check cycle...');
      await executeAutoUpgradeChecks();
    });
    // Scheduled-notification engine every minute — purely local, no API calls
    // (except the once-weekly booking-window tip which fetches credits once).
    cron.schedule('* * * * *', async () => {
      checkCancellationReminders();
      await checkBookingWindowReminder();
    });
    // Infrequent booking-schedule discovery to keep the local cache fresh.
    cron.schedule('0 */6 * * *', async () => {
      console.log('[Reminders] Running booking-cache discovery poll...');
      await refreshBookingCaches();
    });
    // F-10-0: class-history incremental refresh (missing or >6h stale, every gym of every user).
    cron.schedule('25 */6 * * *', async () => {
      try { await require('./class-history').syncStale(); } catch (e) { console.warn('[History] sync scan failed:', e.message); }
    });
    // Warm the cache shortly after startup with a small random offset.
    setTimeout(() => { refreshBookingCaches().catch(() => {}); }, 45000 + Math.floor(Math.random() * 45000));
  },
  executeAutoUpgradeChecks,
  refreshBookingCaches,
  bookingCacheRowsFor,
  fetchFromGym
};
