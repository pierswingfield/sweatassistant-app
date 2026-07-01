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

// Shared event payload cache: eventId → { payload, expiresAt }
// Eliminates duplicate GET /events/:id fetches when multiple users target the same class.
// TTL: 30s during the booking window (covers all T-0 dispatch); 60s for upgrade polling.
const eventCache = new Map();

// Cross-user slot coordination for the current release window — both keyed "eventId:slotId".
// claimedSlots: slot is in-flight or successfully booked by one of our users → others skip (no POST).
// burnedSlots:  slot POST failed (external user took it) → others skip without attempting.
// Both are cleared at the start of each release window dispatch.
const claimedSlots = new Set();
const burnedSlots = new Set();

function setCachedEvent(eventId, payload, ttlMs) {
  eventCache.set(String(eventId), { payload, expiresAt: Date.now() + ttlMs });
}

function getCachedEvent(eventId) {
  const entry = eventCache.get(String(eventId));
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

// Booking-window tiers: 8 days base (≈1 week), +7 per extra week. 1→8, 2→15, 3→22, 4→29.
// Mirrors client/src/lib.js weeksToOffsetDays.
function weeksToOffsetDays(weeks) {
  const w = Math.min(4, Math.max(1, Math.round(weeks) || 1));
  return 8 + (w - 1) * 7;
}

// Calculate booking offset in days based on settings.
// Priority: debug manual override → auto-detected window → legacy manual toggles.
// Mirrors client/src/lib.js getBookingOffset exactly.
function getBookingOffset(settings = {}) {
  // Debug-only manual override for testing a specific window (1-4 weeks).
  if (settings.debugMode && settings.manualBookingWindowWeeks) {
    return weeksToOffsetDays(settings.manualBookingWindowWeeks);
  }
  // Auto-detected from membership cutoffs + credit inventory (client persists this).
  if (typeof settings.detectedBookingOffset === 'number' && settings.detectedBookingOffset > 0) {
    return settings.detectedBookingOffset;
  }
  // Legacy fallback (manual toggles, pre-auto-detection).
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

// Fetch public (no-auth) CodexFit endpoints (events, locations, studios, instructors).
// These are documented as public — no Bearer token required.
async function fetchCodexFitPublic(url) {
  const headers = {
    'accept': 'application/json',
    'origin': 'https://psyclelondon.com',
    'referer': 'https://psyclelondon.com/',
    'x-organisation': '[object Object]'
  };
  return fetch(url, { headers });
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

// Prefetch slots map for active bookings. Deduplicated by event — one GET per
// unique event_id regardless of how many users target the same class. Each event
// is staggered randomly within the window so all fetches complete before T-30s.
// Results are stored in the shared event cache (TTL 30s) so executeAutoBookForClass
// reads from cache instead of re-fetching, collapsing 2×N fetches → N unique events.
async function prefetchAutoBookSlots(bookings, windowMs = 18000) {
  // Deduplicate: pick one representative booking per event_id for the fetch.
  const eventMap = new Map();
  for (const b of bookings) {
    if (!eventMap.has(b.event_id)) eventMap.set(b.event_id, b);
  }
  const uniqueEvents = [...eventMap.values()];
  console.log(`[Scheduler] Prefetch: ${bookings.length} booking(s) across ${uniqueEvents.length} unique event(s), staggered over ${windowMs / 1000}s.`);

  const promises = uniqueEvents.map(async (booking) => {
    const delay = Math.floor(Math.random() * windowMs);
    await new Promise(r => setTimeout(r, delay));
    try {
      // Notify all users targeting this event
      for (const b of bookings) {
        if (b.event_id === booking.event_id) {
          emitStatusUpdate(b.user_id, {
            eventId: booking.event_id,
            status: 'prefetching',
            message: 'Fetching latest spot occupancy data...'
          });
        }
      }
      // /events/:id is a public CodexFit endpoint — no Bearer token needed
      const url = `https://psycle.codexfit.com/api/v1/customer/events/${booking.event_id}`;
      const res = await fetchCodexFitPublic(url);
      if (res.ok) {
        const payload = await res.json();
        const eventData = payload.data || payload;
        const available = payload.slots || eventData.slots || [];
        setCachedEvent(booking.event_id, payload, 30000);
        console.log(`[Scheduler] Prefetched event ${booking.event_id}: ${available.length} available slot(s) (cached 30s).`);
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
    // 1. Get live slot availability — use shared cache if prefetch populated it
    let payload = getCachedEvent(eventId);
    if (payload) {
      console.log(`[Scheduler] Cache hit for event ${eventId} (user ${userId}).`);
    } else {
      // /events/:id is a public CodexFit endpoint — no Bearer token needed
      const url = `https://psycle.codexfit.com/api/v1/customer/events/${eventId}`;
      const res = await fetchCodexFitPublic(url);
      if (!res.ok) {
        throw new Error(`Failed to load event data. Status: ${res.status}`);
      }
      payload = await res.json();
      setCachedEvent(eventId, payload, 30000);
    }

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

    // Try booking candidate slots. Two cross-user coordination sets are checked first:
    //   claimedSlots — slot is in-flight or booked by another of our users → skip (no POST)
    //   burnedSlots  — slot POST already failed for another user this window → skip (externally taken)
    // Both short-circuit without a network call, letting subsequent users reach live slots faster.
    while (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
      const targetSlot = slotsToTry[attemptIdx];
      const claimKey = `${eventId}:${targetSlot}`;
      attemptIdx++;

      if (claimedSlots.has(claimKey)) {
        console.log(`[Scheduler] Slot ${targetSlot} (event ${eventId}) claimed by another user — skipping.`);
        emitStatusUpdate(userId, {
          eventId, status: 'slot-claimed', skippedSlot: targetSlot,
          message: `Slot ${targetSlot} taken by another user — trying next.`
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
        const bookUrl = 'https://psycle.codexfit.com/api/v1/customer/bookings';
        const bookRes = await fetchCodexFit(userId, bookUrl, {
          method: 'POST',
          body: JSON.stringify({ event_id: eventId, slots: [targetSlot] })
        });

        if (bookRes.ok) {
          bookedCount++;
          bookedSlots.push(targetSlot);
          const bookData = await bookRes.json().catch(() => ({}));
          newBookingId = bookData?.id || bookData?.data?.id || 0;
          console.log(`[Scheduler] Successfully booked slot ${targetSlot} for event ${eventId} (booking ID: ${newBookingId})`);
          // Claim stays in claimedSlots — other users see it and skip without POSTing
        } else {
          const errData = await bookRes.json().catch(() => ({}));
          console.warn(`[Scheduler] Slot ${targetSlot} booking failed:`, errData.message || bookRes.status);
          // Burn the slot: externally taken, no point other users attempting it
          claimedSlots.delete(claimKey);
          burnedSlots.add(claimKey);
        }
      } catch (err) {
        console.error(`[Scheduler] Booking attempt error for slot ${targetSlot}:`, err.message);
        claimedSlots.delete(claimKey);
        burnedSlots.add(claimKey);
      }

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

      // Refresh the calendar feed so the new booking shows immediately.
      try { require('./calendar').regenerateSnapshot(userId); } catch (_) {}

      // Automatically register auto-upgrade if studio layout exists
      if (layoutSlots.length > 0) {
        const settings = db.getUserSettings(userId) || {};
        if (settings.autoUpgradeEnabled !== false) {
          const wantAutoUpgrade = prefs.autoUpgrade !== undefined
            ? prefs.autoUpgrade
            : settings.autoUpgradeByDefault;
          if (wantAutoUpgrade) {
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
  db.setKV('scheduler_next_release', targetRelease.toISO());

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
          
          // Trigger bookings! Clear event cache first so dispatch uses freshest data.
          clearEventCache();
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
    // Liveness heartbeat for /api/health — proves the scheduler process is alive
    // even between weekly release windows (it's otherwise timer-driven and idle).
    db.setKV('heartbeat:scheduler', Date.now().toString());
    setInterval(() => db.setKV('heartbeat:scheduler', Date.now().toString()), 60000);
    scheduleReleaseWindow();
  },
  getClassReleaseTime,
  checkAndRunImmediateBookings,
  runAllPendingBookings,
  registerSSEClient,
  unregisterSSEClient,
  emitStatusUpdate,
  getCachedEvent,
  setCachedEvent,
};
