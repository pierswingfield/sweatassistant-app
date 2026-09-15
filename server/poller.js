const cron = require('node-cron');
const { DateTime } = require('luxon');
const db = require('./db');
const pushService = require('./push');
const notifications = require('./notifications');
const { triggerAutoRelogin } = require('./auth');
const { getCachedEvent, setCachedEvent } = require('./scheduler');
const { getProvider } = require('./providers');
const { getGymConfig } = require('./gyms.config');

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
  if (!user || !user.jwt) {
    throw new Error('User has no active session. Please log in.');
  }

  if (user.email === 'dev@psycle.com') {
    const mock = require('./mock');
    return mock.handleMockRequest(path, options.method || 'GET', options.body ? JSON.parse(options.body) : null);
  }

  const runFetch = (token) => getProvider(gymId).request(path, {
    token,
    method: options.method || 'GET',
    body: options.body,
    headers: options.headers,
  });

  let res = await runFetch(user.jwt);

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
  const user = db.getUserById(userId);
  if (!user || !user.jwt) throw new Error('User has no active session. Please log in.');
  const provider = getProvider(gymId);
  let session = { accessToken: user.jwt };
  let result = await provider.swapSpots(bookingId, currentSlotId, targetSlot, session);
  if (result && result.status === 401) {
    const newJwt = await triggerAutoRelogin(userId, gymId);
    result = await provider.swapSpots(bookingId, currentSlotId, targetSlot, { ...session, accessToken: newJwt });
  }
  return result;
}

async function bookSlotWithRelogin(userId, gymId, eventId, targetSlot) {
  const user = db.getUserById(userId);
  if (!user || !user.jwt) throw new Error('User has no active session. Please log in.');
  let session = { accessToken: user.jwt };
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
  const liveMap = db.getStudioPreference(userId, upgrade.studio_id) || {};
  const preferredSlots = (liveMap.preferredSlots || prefs.preferredSlots || []).map(String);
  const preferredRows = liveMap.preferredRows || prefs.preferredRows || [];

  if (preferredSlots.length === 0 && preferredRows.length === 0) return;

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
      const claimKey = `${eventId}:${candidateSlot}`;
      if (availableSlots.includes(candidateSlot) && !claimedSlots.has(claimKey)) {
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
            try { db.cacheUserProfile(userId, profile); } catch (_) {}
            const hasCredits = profile.available_credits && profile.available_credits.some(c => c.count > 0);

            if (!hasCredits) {
              console.log(`[Poller] Auto-upgrade paused for user ${userId}: No available credits.`);
              db.updateAutoUpgrade(upgrade.id, userId, 'paused_no_credits', 'No credits available to claim upgraded slot.', { lastCheckedAt: new Date().toISOString() });
              pushService.sendNotification(userId, 'Upgrade Paused ⏳', `No credits available to upgrade ${upgrade.class_name}.`);
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
            if (!bookResult.ok) {
              console.warn(`[Poller] Atomic swap failed:`, bookResult.error || bookResult.status);
              claimedSlots.delete(claimKey);
              return; // Retry next cycle — nothing was given up.
            }
            usedAtomicSwap = true;
          } else {
            bookResult = await bookSlotWithRelogin(userId, gymId, eventId, candidateSlot);
          }

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
            await apiCancelBooking(userId, upgrade.booking_id);
            console.log(`[Poller] Successfully cancelled original booking ${upgrade.booking_id}`);
          } catch (cancelErr) {
            console.error(`[Poller] Failed to cancel original booking ${upgrade.booking_id}:`, cancelErr.message);
            // Even if cancellation failed, the upgrade booking succeeded
            pushService.sendNotification(
              userId,
              'Upgrade Warning ⚠️',
              `Upgraded to slot ${candidateSlot} for ${upgrade.class_name}, but original booking cancellation failed. Please cancel manually.`
            );
          }
        }

        // Update database upgrade job record
        const nowStr = new Date().toISOString();
        if (isCutoffMode) {
          db.updateAutoUpgrade(upgrade.id, userId, 'cutoff_booked', `Upgraded to slot ${candidateSlot} within 12h window — original seat kept. Please ask Psycle to cancel original booking ${upgrade.booking_id}.`, {
            upgradedSlotId: candidateSlot,
            upgradedAt: nowStr,
            newBookingId,
            lastCheckedAt: nowStr
          });
          notifications.notify(userId, 'upgrade', {
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
            newBookingId,
            upgradedSlotId: candidateSlot,
            upgradedAt: nowStr,
            lastCheckedAt: nowStr
          });
          notifications.notify(userId, 'upgrade', {
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
    console.error(`[Poller] Error in upgrade worker for event ${eventId}:`, err.message);
  }
}

// Orchestrate all upgrades checks
async function executeAutoUpgradeChecks() {
  claimedSlots.clear();
  const active = db.getActiveAutoUpgrades();
  if (active.length === 0) return;

  const now = DateTime.now();

  for (const upgrade of active) {
    try {
      const settings = db.getUserSettings(upgrade.user_id) || {};
      if (settings.autoUpgradeEnabled === false) continue;

      if (!shouldCheckUpgrade(upgrade, settings)) continue;

      const classStart = DateTime.fromISO(upgrade.start_at, { zone: 'Europe/London' });
      const hoursUntilClass = classStart.diff(now, 'hours').hours;

      // Class already started or ≤1h away — hard stop
      if (hoursUntilClass <= 1) {
        db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Class is within 1 hour — monitoring stopped.', { lastCheckedAt: now.toISO() });
        continue;
      }

      const prefs = JSON.parse(upgrade.preferences) || {};

      // 12h cutoff boundary — trigger 5 seconds early to avoid race conditions
      // at the exact cancel-free boundary that could incur a late-cancel penalty.
      const CUTOFF_BUFFER_S = 5;
      if (classStart.diff(now, 'seconds').seconds <= 12 * 3600 + CUTOFF_BUFFER_S) {
        if (prefs.keepOriginalOnCutoff) {
          // User opted in to continue past 12h: one final attempt (no cancel), then stop
          if (!prefs.cutoffAttempted) {
            console.log(`[Poller] Under 12h for event ${upgrade.event_id}. Final attempt — original seat will be kept.`);
            prefs.cutoffAttempted = true;
            db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'active', 'Running final upgrade attempt within 12h window...', {
              preferences: prefs,
              lastCheckedAt: now.toISO()
            });
            await attemptUpgradeSlot(upgrade, true);
          } else {
            // Already ran the one cutoff attempt — stop
            db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Final 12h upgrade attempt already made. Monitoring stopped.', { lastCheckedAt: now.toISO() });
          }
        } else {
          // Not opted in — stop at 12h, no attempt
          db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Stopped at 12h cutoff to avoid cancellation penalty.', { lastCheckedAt: now.toISO() });
          pushService.sendNotification(upgrade.user_id, 'Upgrade Monitor Stopped ⏳', `No better seat found for ${upgrade.class_name} before the 12h cutoff.`);
        }
        continue;
      }

      // Standard active check (>12h before class)
      await attemptUpgradeSlot(upgrade, false);

    } catch (err) {
      console.error(`[Poller] Upgrade check failed for upgrade ID ${upgrade.id}:`, err.message);
    }
  }
}

// ─── Booking-schedule discovery (infrequent CodexFit poll) ───────────────────
// Normalise a raw CodexFit booking into our cache shape (mirrors client parsing).
function normalizeBooking(b) {
  const event = b.event || {};
  const startAt = event.start_at || b.start_at;
  if (!startAt) return null;
  return {
    bookingId: b.id,
    eventId: event.id || b.event_id || null,
    startAt,
    className: event.event_type?.name || event.name || 'Class',
    groupName: event.event_type?.group?.name || '',
    instructorName: event.instructor?.full_name || event.instructor?.name || '',
    studioName: event.studio?.name || '',
    locationName: event.studio?.location?.name || '',
    slotLabel: b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? '',
  };
}

// Refresh booking caches for users who have cancellation reminders enabled and at
// least one push subscription. Runs every few hours — reminders themselves fire
// locally from the cache with no extra API cost.
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

      await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 6000)));
      const url = '/bookings?limit=100&page=1';
      const res = await fetchFromGym(userId, db.resolveActiveGymId(userId), url);
      if (!res.ok) continue;
      const payload = await res.json();
      const list = payload.data || payload || [];
      const normalized = (Array.isArray(list) ? list : []).map(normalizeBooking).filter(Boolean);
      db.replaceBookingCache(userId, normalized);
      console.log(`[Reminders] Cached ${normalized.length} upcoming booking(s) for user ${userId}.`);
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
  const now = DateTime.now().setZone('Europe/London');
  const cached = db.getAllBookingCache();
  for (const bk of cached) {
    try {
      const prefs = notifications.getPrefs(bk.user_id);
      if (!prefs.cancellationReminder.enabled) continue;

      const timing = prefs.cancellationReminder.timing === '14h' ? 14 : 24;
      const start = DateTime.fromISO(bk.start_at, { zone: 'Europe/London' });
      if (!start.isValid) continue;

      const hoursUntil = start.diff(now, 'hours').hours;
      // Only inside the free-cancellation window and at/after the chosen offset.
      if (hoursUntil <= 12) continue;
      if (hoursUntil > timing) continue;

      const key = `cancel:${bk.booking_id}:${timing}h`;
      if (db.wasNotificationSent(bk.user_id, key)) continue;
      db.markNotificationSent(bk.user_id, key);

      notifications.notify(bk.user_id, 'cancellationReminder', {
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
async function checkBookingWindowReminder() {
  const now = DateTime.now().setZone('Europe/London');
  let mondayNoon = now.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (now > mondayNoon) mondayNoon = mondayNoon.plus({ weeks: 1 });
  const fireAt = mondayNoon.minus({ hours: 1 });
  if (now < fireAt || now >= mondayNoon) return;

  const key = `window:${mondayNoon.toISODate()}`;
  const userIds = db.getUserIdsWithPushSubs();
  for (const userId of userIds) {
    try {
      const prefs = notifications.getPrefs(userId);
      if (!prefs.bookingWindow.enabled) continue;
      if (db.wasNotificationSent(userId, key)) continue;
      db.markNotificationSent(userId, key);
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30000)));
      await sendBookingWindowTip(userId);
    } catch (err) {
      console.error(`[Reminders] Booking-window reminder failed for user ${userId}:`, err.message);
    }
  }
}

async function sendBookingWindowTip(userId) {
  const pending = db.getUserAutoBookings(userId).filter(b => b.status === 'pending');
  const count = pending.length;
  let tip;
  if (count === 0) {
    tip = "Don't forget to set up Auto-Book!";
  } else {
    let enough = true;
    try {
      const res = await fetchFromGym(userId, db.resolveActiveGymId(userId), '/profile');
      if (res.ok) {
        const payload = await res.json();
        const profile = payload.data || payload;
        // Cache the full profile (also backfills display_name) for the admin view.
        try { db.cacheUserProfile(userId, profile); } catch (_) {}
        const totalCredits = (profile.available_credits || []).reduce((s, c) => s + (c.count || 0), 0);
        const needed = pending.reduce((s, b) => {
          let p = {};
          try { p = JSON.parse(b.preferences || '{}'); } catch (_) {}
          return s + (p.requiredCount || 1);
        }, 0);
        enough = totalCredits >= needed;
      }
    } catch (_) { /* fall back to the neutral tip */ }
    const plural = count !== 1 ? 'es' : '';
    tip = enough
      ? `You have ${count} class${plural} set to Auto-Book.`
      : `⚠️ You have ${count} class${plural} set to Auto-Book, but you don't have enough credits.`;
  }
  await notifications.notify(userId, 'bookingWindow', { tip });
}

module.exports = {
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
    // Warm the cache shortly after startup with a small random offset.
    setTimeout(() => { refreshBookingCaches().catch(() => {}); }, 45000 + Math.floor(Math.random() * 45000));
  },
  executeAutoUpgradeChecks,
  refreshBookingCaches,
  fetchFromGym,
  normalizeBooking
};
