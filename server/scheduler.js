const { DateTime } = require('luxon');
const db = require('./db');
const pushService = require('./push');
const notifications = require('./notifications');
const { triggerAutoRelogin } = require('./auth');

let mainTimeout = null;
let prefetchTimeout = null;
let preciseInterval = null;

// SSE clients registry: userId → Set of response objects for streaming status updates
const sseClients = new Map();

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

// Calculate booking offset in days based on settings
function getBookingOffset(settings) {
  let days = 8; // base: 8 days after release Monday
  if (settings.advancedBooking) days += 7;
  if (settings.advancedBookingCredit) days += 7;
  return days;
}

// Calculate when booking opens for a specific class date (London timezone)
function getClassReleaseTime(classDateStr, settings = {}) {
  if (!classDateStr) return DateTime.now().setZone('Europe/London');
  
  const daysToAdd = getBookingOffset(settings);
  const classDt = DateTime.fromISO(classDateStr, { zone: 'Europe/London' });

  // Start M as Monday 12:00 PM of the class week
  let M = classDt.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });

  while (true) {
    const cutoff = M.plus({ days: daysToAdd }).set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    if (cutoff < classDt) {
      M = M.plus({ weeks: 1 });
      break;
    }
    M = M.minus({ weeks: 1 });
  }

  return M.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
}

// Get standard headers for CodexFit requests
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

// Perform a request to CodexFit API with automatic re-login on 401
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
      console.error(`[Scheduler] Auto-relogin failed during api fetch for user ${userId}:`, err.message);
      pushService.sendNotification(userId, 'Session Expired ⚠️', 'Failed to renew session. Auto-booking skipped.');
      throw err;
    }
  }
  return res;
}

// Prefetch slots map for active bookings. Each user is staggered randomly within
// a window so all fetches complete before T-30s. windowMs is the total stagger
// budget (default 18s → start at T-50s, finish by ~T-30s).
async function prefetchAutoBookSlots(bookings, windowMs = 18000) {
  console.log(`[Scheduler] Prefetch triggered for ${bookings.length} booking(s), staggered over ${windowMs / 1000}s window.`);
  const promises = bookings.map(async (booking) => {
    const delay = Math.floor(Math.random() * windowMs);
    await new Promise(r => setTimeout(r, delay));
    try {
      emitStatusUpdate(booking.user_id, {
        eventId: booking.event_id,
        status: 'prefetching',
        message: 'Fetching latest spot occupancy data...'
      });
      const url = `https://psycle.codexfit.com/api/v1/customer/events/${booking.event_id}`;
      const res = await fetchCodexFit(booking.user_id, url);
      if (res.ok) {
        const payload = await res.json();
        const eventData = payload.data || payload;
        const available = payload.slots || eventData.slots || [];
        console.log(`[Scheduler] Prefetched ${available.length} available slots for event ${booking.event_id}`);
      }
    } catch (err) {
      console.error(`[Scheduler] Prefetch failed for event ${booking.event_id}:`, err.message);
    }
  });
  await Promise.allSettled(promises);
}

// Resolve the live shared studio spot map; fall back to the entry snapshot for
// legacy records that predate studio_id or studios with no saved map.
function resolveLiveMap(userId, studioId, snapshot) {
  const live = db.getStudioPreference(userId, studioId);
  if (live && (live.preferredSlots?.length || live.preferredRows?.length)) {
    return {
      preferredSlots: live.preferredSlots || [],
      preferredRows: live.preferredRows || []
    };
  }
  return {
    preferredSlots: snapshot.preferredSlots || [],
    preferredRows: snapshot.preferredRows || []
  };
}

// Execute auto-book process for a single class slot booking
async function executeAutoBookForClass(booking) {
  const eventId = booking.event_id;
  const userId = booking.user_id;
  const prefs = JSON.parse(booking.preferences) || { preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true };
  // Slots/rows come from the LIVE shared studio map; requiredCount/bookAny are per-entry.
  const liveMap = resolveLiveMap(userId, booking.studio_id, prefs);
  const preferredSlots = liveMap.preferredSlots;
  const preferredRows = liveMap.preferredRows;
  const requiredCount = prefs.requiredCount || 1;
  const bookAny = prefs.bookAny !== false;

  console.log(`[Scheduler] Running booking worker for User ${userId}, Event ${eventId}. Needs ${requiredCount} slots.`);

  try {
    // 1. Fetch live slot availability
    const url = `https://psycle.codexfit.com/api/v1/customer/events/${eventId}`;
    const res = await fetchCodexFit(userId, url);
    if (!res.ok) {
      throw new Error(`Failed to load event data. Status: ${res.status}`);
    }

    const payload = await res.json();
    const eventData = payload.data || payload;
    const studio = payload.relations?.studios?.[0] || eventData.relations?.studios?.[0] || eventData.studio;
    const layoutSlots = studio?.layout?.slots || [];
    const liveAvailable = (payload.slots || eventData.slots || []).map(id => Number(id));

    console.log(`[Scheduler] Live available slots for event ${eventId}:`, liveAvailable);

    // 2. Filter preferred slots by availability
    const primarySlots = preferredSlots.map(Number).filter(id => liveAvailable.includes(id));

    // 3. Filter preferred rows by availability
    const rowSlots = [];
    if (preferredRows.length > 0 && layoutSlots.length > 0) {
      preferredRows.forEach(ry => {
        // Round coordinate coordinates to match extension rendering
        const slotsInRow = layoutSlots.filter(s => Math.round(s.y * 10) / 10 === Number(ry));
        const rowSlotIds = slotsInRow.map(s => Number(s.id));
        rowSlotIds.forEach(id => {
          if (liveAvailable.includes(id) && !primarySlots.includes(id) && !rowSlots.includes(id)) {
            rowSlots.push(id);
          }
        });
      });
    }

    // 4. Combine priority lists
    const slotsToTry = [...primarySlots, ...rowSlots];
    const finalBookAny = layoutSlots.length === 0 || bookAny;

    if (finalBookAny) {
      const remainingAvailable = liveAvailable.filter(id => !slotsToTry.includes(id));
      slotsToTry.push(...remainingAvailable);
    }

    let bookedCount = 0;
    const bookedSlots = [];
    let newBookingId = 0;
    let attemptIdx = 0;

    console.log(`[Scheduler] Event ${eventId}: planning to attempt slots in order: [${slotsToTry.join(', ')}]`);

    // Emit status: planned slots
    emitStatusUpdate(userId, {
      eventId,
      status: 'planning',
      plannedSlots: slotsToTry,
      message: `Planning to book from: [${slotsToTry.join(', ')}]`
    });

    // Try booking candidate slots with 500ms cooldown between attempts
    while (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
      const targetSlot = slotsToTry[attemptIdx];
      const isPreferred = preferredSlots.includes(targetSlot);
      console.log(`[Scheduler] Attempting to book ${isPreferred ? 'preferred' : 'fallback'} slot ${targetSlot} for event ${eventId}...`);

      emitStatusUpdate(userId, {
        eventId,
        status: 'attempting',
        attemptingSlot: targetSlot,
        isPreferred,
        attempt: attemptIdx + 1,
        message: `Attempting ${isPreferred ? 'preferred' : 'fallback'} slot ${targetSlot}...`
      });

      try {
        const bookUrl = 'https://psycle.codexfit.com/api/v1/customer/bookings';
        const bookRes = await fetchCodexFit(userId, bookUrl, {
          method: 'POST',
          body: JSON.stringify({
            event_id: eventId,
            slots: [targetSlot]
          })
        });

        if (bookRes.ok) {
          bookedCount++;
          bookedSlots.push(targetSlot);
          const bookData = await bookRes.json().catch(() => ({}));
          newBookingId = bookData?.id || bookData?.data?.id || 0;
          console.log(`[Scheduler] Successfully booked slot ${targetSlot} for event ${eventId} (booking ID: ${newBookingId})`);
        } else {
          const errData = await bookRes.json().catch(() => ({}));
          console.warn(`[Scheduler] Slot ${targetSlot} booking failed:`, errData.message || bookRes.status);
        }
      } catch (err) {
        console.error(`[Scheduler] Booking attempt error for slot ${targetSlot}:`, err.message);
      }

      attemptIdx++;
      if (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
        await new Promise(resolve => setTimeout(resolve, 400 + Math.floor(Math.random() * 400)));
      }
    }

    // 5. Check if booking succeeded
    if (bookedCount > 0) {
      const msg = `Successfully booked slot${bookedSlots.length > 1 ? 's' : ''} ${bookedSlots.join(', ')}!`;
      db.markAutoBookingExecuted(eventId, userId, 'success', msg, new Date().toISOString());

      emitStatusUpdate(userId, {
        eventId,
        status: 'success',
        bookedSlots,
        message: msg
      });

      // Notify the user (Spot Booked) — map slot IDs to labels where possible
      const bookedLabels = bookedSlots.map(id => {
        const s = layoutSlots.find(ls => Number(ls.id) === Number(id));
        return s?.label ?? id;
      });
      notifications.notify(userId, 'booking', {
        source: 'autobook',
        startAt: booking.start_at,
        groupName: booking.group_name,
        className: booking.class_name,
        instructorName: booking.instructor_name,
        slots: bookedLabels,
      });

      // Automatically register auto-upgrade if studio layout exists
      if (layoutSlots.length > 0) {
        const settings = db.getUserSettings(userId) || {};
        if (settings.autoUpgradeEnabled !== false) {
          console.log(`[Scheduler] Auto-registering Auto-Upgrade monitoring for booking ${eventId}`);
          db.addAutoUpgrade(
            userId,
            eventId,
            newBookingId, // Use the actual booking ID we just got
            bookedSlots[0],
            booking.class_name,
            booking.instructor_name,
            booking.studio_name,
            booking.location_name,
            booking.start_at,
            { keepOriginalOnCutoff: true },
            booking.studio_id,
            booking.group_name
          );
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

      const wlUrl = `https://psycle.codexfit.com/api/v1/customer/waitlists/${eventId}`;
      const wlRes = await fetchCodexFit(userId, wlUrl, { method: 'PUT' });

      if (wlRes.ok) {
        db.markAutoBookingExecuted(eventId, userId, 'waitlist', 'All slots occupied. Joined waitlist fallback successfully.', new Date().toISOString());

        emitStatusUpdate(userId, {
          eventId,
          status: 'waitlist-success',
          message: 'Joined waitlist successfully'
        });

        pushService.sendNotification(
          userId,
          'Auto-Book Waitlist ⏳',
          `All slots taken. Joined waitlist fallback for ${booking.class_name} with ${booking.instructor_name}.`
        );
      } else {
        const wlErr = await wlRes.json().catch(() => ({}));
        const errMsg = wlErr.message || 'Class is fully booked and waitlist closed';
        db.markAutoBookingExecuted(eventId, userId, 'failed', `Booking and Waitlist fallback failed: ${errMsg}`, new Date().toISOString());

        emitStatusUpdate(userId, {
          eventId,
          status: 'failed',
          message: `Failed: ${errMsg}`
        });

        pushService.sendNotification(
          userId,
          'Auto-Book Failed ❌',
          `Failed to book ${booking.class_name}: ${errMsg}`
        );
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Auto-book worker failed for user ${userId}, event ${eventId}:`, err.message);
    db.markAutoBookingExecuted(eventId, userId, 'failed', `Worker execution failed: ${err.message}`, new Date().toISOString());
    pushService.sendNotification(userId, 'Auto-Book Error ⚠️', `Error executing booking for ${booking.class_name}: ${err.message}`);
  }
}

// Core execution loop — all classes fire simultaneously, slot attempts within each are serialised
async function executeAutoBookQueue(bookings) {
  if (bookings.length === 0) return;
  console.log(`[Scheduler] Dispatching ${bookings.length} class booking routine(s) in parallel...`);

  const workers = bookings.map(booking =>
    executeAutoBookForClass(booking).catch(err => {
      console.error(`[Scheduler] Worker routine crash for event ${booking.event_id}:`, err.message);
    })
  );

  await Promise.allSettled(workers);
}

// Calculate the next Monday 12:00 PM London time
function getNextMondayNoonLondon() {
  const now = DateTime.now().setZone('Europe/London');
  let target = now.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (now >= target) {
    target = target.plus({ weeks: 1 });
  }
  return target;
}

// Core scheduler orchestrator
function scheduleReleaseWindow() {
  if (mainTimeout) clearTimeout(mainTimeout);
  if (prefetchTimeout) clearTimeout(prefetchTimeout);
  if (preciseInterval) clearInterval(preciseInterval);

  const targetRelease = getNextMondayNoonLondon();
  const now = DateTime.now().setZone('Europe/London');
  const diffMs = targetRelease.diff(now).milliseconds;

  console.log(`[Scheduler] Next release scheduled for: ${targetRelease.toLocaleString(DateTime.DATETIME_FULL_WITH_ZONE)} (in ${(diffMs / 3600000).toFixed(2)} hours)`);

  // 1. Set Prefetch Timeout at T-50s; individual fetches are staggered randomly
  //    within an 18s window so all complete before T-30s.
  const prefetchDelay = diffMs - 50000;
  if (prefetchDelay > 0) {
    prefetchTimeout = setTimeout(async () => {
      const pending = db.getPendingAutoBookings();
      const active = pending.filter(b => {
        const settings = db.getUserSettings(b.user_id) || {};
        const releaseTime = getClassReleaseTime(b.start_at, settings);
        // Release time matches targetRelease
        return Math.abs(releaseTime.diff(targetRelease).milliseconds) < 10000;
      });
      if (active.length > 0) {
        await prefetchAutoBookSlots(active);
      }
    }, prefetchDelay);
  }

  // 2. Set precise execution trigger waking up 5s before T-0
  const executionDelay = diffMs - 5000;
  if (executionDelay > 0) {
    mainTimeout = setTimeout(() => {
      console.log('[Scheduler] Within 5 seconds of release window. Enabling precision high-frequency check loop...');
      
      const targetTimeMs = targetRelease.toMillis();
      // Tick fast to execute exactly on the millisecond
      preciseInterval = setInterval(() => {
        const nowMs = Date.now();
        if (nowMs >= targetTimeMs) {
          clearInterval(preciseInterval);
          preciseInterval = null;
          
          // Trigger bookings!
          const pending = db.getPendingAutoBookings();
          const active = pending.filter(b => {
            const settings = db.getUserSettings(b.user_id) || {};
            const releaseTime = getClassReleaseTime(b.start_at, settings);
            return Math.abs(releaseTime.diff(targetRelease).milliseconds) < 10000;
          });
          
          executeAutoBookQueue(active).then(() => {
            // Re-schedule for next week once execution finishes
            setTimeout(scheduleReleaseWindow, 10000);
          });
        }
      }, 10); // Check every 10ms
    }, executionDelay);
  } else {
    // If we're starting up and the release is within 5 seconds or in the past
    // check if there are pending bookings that should have been run in the last minute
    const recentRelease = targetRelease.minus({ weeks: 1 });
    const elapsedMinutes = now.diff(recentRelease, 'minutes').minutes;
    
    if (elapsedMinutes >= 0 && elapsedMinutes <= 5) {
      console.log(`[Scheduler] Server started within ${elapsedMinutes.toFixed(1)} mins of release window. Running missed bookings immediately.`);
      const pending = db.getPendingAutoBookings();
      const active = pending.filter(b => {
        const settings = db.getUserSettings(b.user_id) || {};
        const releaseTime = getClassReleaseTime(b.start_at, settings);
        return Math.abs(releaseTime.diff(recentRelease).milliseconds) < 10000;
      });
      executeAutoBookQueue(active);
    }
    
    // Schedule next week's release
    setTimeout(scheduleReleaseWindow, 1000);
  }
}

// Immediate execution runner for beyond-cutoff booking
function checkAndRunImmediateBookings(userId) {
  const pending = db.getPendingAutoBookings().filter(b => b.user_id === userId);
  const now = DateTime.now().setZone('Europe/London');

  const immediateBookings = pending.filter(b => {
    const settings = db.getUserSettings(b.user_id) || {};
    const releaseTime = getClassReleaseTime(b.start_at, settings);
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
    scheduleReleaseWindow();
  },
  getClassReleaseTime,
  checkAndRunImmediateBookings,
  runAllPendingBookings,
  registerSSEClient,
  unregisterSSEClient,
  emitStatusUpdate
};
