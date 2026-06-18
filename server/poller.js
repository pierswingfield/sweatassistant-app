const cron = require('node-cron');
const { DateTime } = require('luxon');
const db = require('./db');
const pushService = require('./push');
const { triggerAutoRelogin } = require('./auth');

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

// Check if polling interval has elapsed
function shouldCheckUpgrade(upgrade, settings) {
  if (!upgrade.last_checked_at) return true;

  const interval = settings.autoUpgradeInterval || '15min';
  const lastChecked = DateTime.fromISO(upgrade.last_checked_at);
  const now = DateTime.now();

  let diffMinutes = now.diff(lastChecked, 'minutes').minutes;

  if (interval === '1min') return diffMinutes >= 1.0;
  if (interval === '15min') return diffMinutes >= 15.0;
  if (interval === '1hr') return diffMinutes >= 60.0;
  
  return diffMinutes >= 15.0;
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
    // 1. Fetch live slot availability
    const url = `https://psycle.codexfit.com/api/v1/customer/events/${eventId}`;
    const res = await fetchCodexFit(userId, url);
    if (!res.ok) return;

    const payload = await res.json();
    const eventData = payload.data || payload;
    const availableSlots = (payload.slots || eventData.slots || []).map(id => Number(id));

    // 2. Iterate preferred slots to find a better one
    for (let i = 0; i < preferredSlots.length; i++) {
      const candidateSlot = preferredSlots[i];

      // If we've hit our current slot or worse, stop checking
      if (currentIndex !== -1 && i >= currentIndex) break;

      // Candidate slot is available! Let's upgrade
      if (availableSlots.includes(candidateSlot)) {
        console.log(`[Poller] Better slot ${candidateSlot} available for event ${eventId} (current: ${currentSlotId}). Upgrading...`);

        // Check if user has credits
        const profileUrl = 'https://psycle.codexfit.com/api/v1/customer/profile';
        const profileRes = await fetchCodexFit(userId, profileUrl);
        if (!profileRes.ok) return;

        const profileData = await profileRes.json();
        const profile = profileData.data || profileData;
        const hasCredits = profile.available_credits && profile.available_credits.some(c => c.count > 0);

        if (!hasCredits) {
          console.log(`[Poller] Auto-upgrade paused for user ${userId}: No available credits.`);
          db.updateAutoUpgrade(upgrade.id, userId, 'paused_no_credits', 'No credits available to claim upgraded slot.', { lastCheckedAt: new Date().toISOString() });
          pushService.sendNotification(userId, 'Upgrade Paused ⏳', `No credits available to upgrade ${upgrade.class_name}.`);
          return;
        }

        // Book the new slot
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
          pushService.sendNotification(
            userId,
            'Seat Upgraded! 🚀 Action Required',
            `We grabbed slot ${candidateSlot} for ${upgrade.class_name}. As you're within 12 hours, we kept your original seat — please contact Psycle to cancel it.`
          );
        } else {
          db.updateAutoUpgrade(upgrade.id, userId, 'active', `Upgraded to slot ${candidateSlot}. Monitoring for better slots...`, {
            currentSlotId: candidateSlot,
            newBookingId,
            upgradedSlotId: candidateSlot,
            upgradedAt: nowStr,
            lastCheckedAt: nowStr
          });
          pushService.sendNotification(
            userId,
            'Auto-Upgrade Success! 🚀',
            `Upgraded to slot ${candidateSlot} for ${upgrade.class_name}.`
          );
        }
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
        db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Class is within 1 hour — monitoring stopped.', { lastCheckedAt: now.toISOString() });
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
              lastCheckedAt: now.toISOString()
            });
            await attemptUpgradeSlot(upgrade, true);
          } else {
            // Already ran the one cutoff attempt — stop
            db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Final 12h upgrade attempt already made. Monitoring stopped.', { lastCheckedAt: now.toISOString() });
          }
        } else {
          // Not opted in — stop at 12h, no attempt
          db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', 'Stopped at 12h cutoff to avoid cancellation penalty.', { lastCheckedAt: now.toISOString() });
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

module.exports = {
  init() {
    console.log('[Poller] Auto-Upgrade Poller initialized.');
    // Run upgrade checks every minute
    cron.schedule('* * * * *', async () => {
      console.log('[Poller] Running auto-upgrade check cycle...');
      await executeAutoUpgradeChecks();
    });
  },
  executeAutoUpgradeChecks
};
