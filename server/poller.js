const cron = require('node-cron');
const { DateTime } = require('luxon');
const db = require('./db');
const pushService = require('./push');
const notifications = require('./notifications');
const { triggerAutoRelogin } = require('./auth');
const { getCachedEvent, setCachedEvent } = require('./scheduler');

// Calculate booking offset/headers like scheduler
function getCodexFitHeaders(token, isJSON = false) {
  const headers = {
    'accept': 'application/json',
    'origin': 'https://psyclelondon.com',
    'referer': 'https://psyclelondon.com/',
    'x-organisation': '[object Object]',
    'authorization': `Bearer ${token}`
  };
  if (isJSON) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

async function fetchCodexFit(userId, url, options = {}) {
  const user = db.getUserById(userId);
  if (!user || !user.jwt) {
    throw new Error('User has no active session. Please log in.');
  }

  const runFetch = async (token) => {
    const fetchOptions = { ...options };
    fetchOptions.headers = {
      ...getCodexFitHeaders(token, !!options.body),
      ...options.headers
    };
    return fetch(url, fetchOptions);
  };

  let res = await runFetch(user.jwt);

  if (res.status === 401) {
    try {
      const newJwt = await triggerAutoRelogin(userId);
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
async function apiCancelBooking(userId, bookingId) {
  const url = `https://psycle.codexfit.com/api/v1/customer/bookings/${bookingId}`;
  const res = await fetchCodexFit(userId, url, { method: 'DELETE' });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.message || `Failed to cancel booking ${bookingId}`);
  }
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
  const eventId = upgrade.event_id;
  const userId = upgrade.user_id;
  const currentSlotId = Number(upgrade.current_slot_id);
  const prefs = JSON.parse(upgrade.preferences) || {};
  // Preferred slots come from the LIVE shared studio map; fall back to snapshot for legacy records.
  const liveMap = db.getStudioPreference(userId, upgrade.studio_id);
  const sourceSlots = (liveMap && liveMap.preferredSlots?.length) ? liveMap.preferredSlots : (prefs.preferredSlots || []);
  const preferredSlots = sourceSlots.map(Number);

  if (preferredSlots.length === 0) return;

  const currentIndex = preferredSlots.indexOf(currentSlotId);
  // If current slot is already the absolute best, nothing to upgrade
  if (currentIndex === 0) {
    db.updateAutoUpgrade(upgrade.id, userId, 'stopped', 'Already in the most preferred slot.', { lastCheckedAt: new Date().toISOString() });
    return;
  }

  try {
    // 1. Get live slot availability — use shared cache to avoid N fetches/min for the same class
    let payload = getCachedEvent(eventId);
    if (payload) {
      console.log(`[Poller] Cache hit for event ${eventId} (user ${userId}).`);
    } else {
      const url = `https://psycle.codexfit.com/api/v1/customer/events/${eventId}`;
      const res = await fetchCodexFit(userId, url);
      if (!res.ok) return;
      payload = await res.json();
      setCachedEvent(eventId, payload, 60000);
    }
    const eventData = payload.data || payload;
    const availableSlots = (payload.slots || eventData.slots || []).map(id => Number(id));
    const upgradeStudio = payload.relations?.studios?.[0] || eventData.relations?.studios?.[0] || eventData.studio;
    const upgradeLayout = upgradeStudio?.layout?.slots || [];
    const labelForSlot = (id) => {
      const s = upgradeLayout.find(ls => Number(ls.id) === Number(id));
      return s?.label ?? id;
    };

    // 2. Iterate preferred slots to find a better one
    for (let i = 0; i < preferredSlots.length; i++) {
      const candidateSlot = preferredSlots[i];

      // If we've hit our current slot or worse, stop checking
      if (currentIndex !== -1 && i >= currentIndex) break;

      // Candidate slot is available! Let's upgrade
      if (availableSlots.includes(candidateSlot)) {
        console.log(`[Poller] Better slot ${candidateSlot} available for event ${eventId} (current: ${currentSlotId}). Upgrading...`);

        // Check if user has credits
        await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 600)));
        const profileUrl = 'https://psycle.codexfit.com/api/v1/customer/profile';
        const profileRes = await fetchCodexFit(userId, profileUrl);
        if (!profileRes.ok) return;

        const profileData = await profileRes.json();
        const profile = profileData.data || profileData;
        // Cache the full profile (also backfills display_name) so the admin view stays
        // warm even while the user's app is closed.
        try { db.cacheUserProfile(userId, profile); } catch (_) {}
        const hasCredits = profile.available_credits && profile.available_credits.some(c => c.count > 0);

        if (!hasCredits) {
          console.log(`[Poller] Auto-upgrade paused for user ${userId}: No available credits.`);
          db.updateAutoUpgrade(upgrade.id, userId, 'paused_no_credits', 'No credits available to claim upgraded slot.', { lastCheckedAt: new Date().toISOString() });
          pushService.sendNotification(userId, 'Upgrade Paused ⏳', `No credits available to upgrade ${upgrade.class_name}.`);
          return;
        }

        // Book the new slot
        await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 600)));
        const bookUrl = 'https://psycle.codexfit.com/api/v1/customer/bookings';
        const bookRes = await fetchCodexFit(userId, bookUrl, {
          method: 'POST',
          body: JSON.stringify({
            event_id: eventId,
            slots: [candidateSlot]
          })
        });

        if (!bookRes.ok) {
          const errData = await bookRes.json().catch(() => ({}));
          console.warn(`[Poller] Auto-upgrade slot booking failed:`, errData.message || bookRes.status);
          return; // Retry next time
        }

        const bookData = await bookRes.json().catch(() => ({}));
        const newBookingId = bookData?.id || bookData?.data?.id || 0;

        // Cancel the original booking (if not in cutoff mode)
        if (!isCutoffMode && upgrade.booking_id) {
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

      // 12h cutoff boundary
      if (hoursUntilClass <= 12) {
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
      const url = 'https://psycle.codexfit.com/api/v1/customer/bookings?limit=100&page=1';
      const res = await fetchCodexFit(userId, url);
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
      const res = await fetchCodexFit(userId, 'https://psycle.codexfit.com/api/v1/customer/profile');
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
  fetchCodexFit,
  normalizeBooking
};
