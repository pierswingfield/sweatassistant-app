const cron = require('node-cron');
const { cleanClassName: _cleanClassName } = require('./class-name');
// U1-19b: push/SSE text names a class the way the UI does (no discipline prefix).
const displayClass = (row) => _cleanClassName(row.class_name, row.group_name) || row.class_name;
const { DateTime } = require('luxon');
const db = require('./db');
const { log } = require('./logger');
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
const { planGroupUpgrade } = require('./group-upgrade');
const cancelRebook = require('./cancel-rebook-policy');

// No module-level provider (WP-D7). Every fetch below resolves its gym — from
// the ROW being processed where there is one (background work must run for a gym
// the user isn't currently looking at), otherwise from the user's active gym.

// Track slots upgraded in the current poller check cycle to prevent double-booking/race conditions
const claimedSlots = new Set();

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
      log.error('relogin failed', { component: 'poller', userId, err });
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
    log.info('auto-upgrade booking got 401, attempting relogin and retry', { component: 'poller', userId, gymId });
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
  log.error('gym rate-limited an auto-upgrade attempt, backing off', { component: 'poller', gymId, userId, reason: result.error, backoffUntil: new Date(until).toISOString() });
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


// ─── Group Auto-Upgrade ──────────────────────────────────────────────────────
// A monitor with >1 rows in auto_upgrade_members moves ALL its reservations or none
// "by design": it upgrades only when planGroupUpgrade() finds a target SET that is
// better by preferred-map rank and at least as together as the current set.
//
//   atomic-swap gyms (MarianaTek): sequential swapSpots, one call per reservation.
//   Psycle (no atomic swap), per move:
//     book-first   - when a spare credit AND the per-class self limit allow one more
//                    reservation: BOOK the target, and only once confirmed CANCEL the old.
//     cancel-first - otherwise: cancel old then rebook target; if the rebook fails, rebook
//                    the original spot, then the nearest free one.
//   The first failed move aborts the rest. Cancels are restricted to the group's
//   own pre-move booking ids (`oldSet`), so this path can never cancel a seat that
//   is not part of the group.

// No preferred spot map exists for the monitor's studio (removed or never set):
// there is nothing to upgrade towards. Stop the monitor and tell the member once.
function stopForMissingSpotMap(upgrade) {
  const msg = 'Stopped: no preferred spot map for this studio. Set one in Settings > Spot Maps, then re-enable.';
  db.updateAutoUpgrade(upgrade.id, upgrade.user_id, 'stopped', msg, { lastCheckedAt: new Date().toISOString() });
  const key = `nomap:upgrade:${upgrade.id}`;
  if (db.wasNotificationSent(upgrade.user_id, key)) return;
  db.markNotificationSent(upgrade.user_id, key);
  notifications.notify(upgrade.user_id, 'upgrade', {
    kind: 'noSpotMap', gymId: upgrade.gym_id, groupName: upgrade.group_name,
    className: upgrade.class_name, studioName: upgrade.studio_name,
  });
}

function preferredOrderFor(layout, preferredSlots, preferredRows) {
  const ordered = [...preferredSlots.map(String)];
  (preferredRows || []).forEach((ry) => {
    layout.filter((s) => Math.round(s.y * 10) / 10 === Number(ry)).forEach((s) => {
      if (!ordered.includes(String(s.id))) ordered.push(String(s.id));
    });
  });
  return ordered;
}

function groupSlotLabels(layout, ids) {
  return ids.map((id) => {
    const s = layout.find((l) => String(l.id) === String(id));
    return s?.label ?? String(id);
  });
}

// [Claude 2026-10-11] One run per group monitor at a time, and the seats an in-flight run
// holds survive the next cycle's claimedSlots.clear().
const groupInFlight = new Set();
const heldGroupClaims = new Set();
const GROUP_COOLDOWN_MS = 30 * 60 * 1000;
const GROUP_MAX_RECOVERIES = 3;

async function attemptGroupUpgrade(upgrade, members, isCutoffMode) {
  if (groupInFlight.has(upgrade.id)) return;
  groupInFlight.add(upgrade.id);
  try { return await attemptGroupUpgradeInner(upgrade, members, isCutoffMode); }
  finally { groupInFlight.delete(upgrade.id); }
}

async function attemptGroupUpgradeInner(upgrade, members, isCutoffMode) {
  const eventId = String(upgrade.event_id);
  const userId = upgrade.user_id;
  const gymId = upgrade.gym_id; // the ROW's gym (C3-12)
  const gym = getGymConfig(gymId);
  const isAtomic = !!(gym && gym.capabilities && gym.capabilities.atomicSwap);
  const nowIso = () => new Date().toISOString();
  const stop = (msg) => db.updateAutoUpgrade(upgrade.id, userId, 'stopped', msg, { lastCheckedAt: nowIso() });

  // Guests: a swap of a guest reservation is unproven on every platform, so a group
  // that includes one is never moved (and a guest on the same class blocks it too).
  if (members.some((m) => m.is_guest) || db.hasGuestBookingGroupForEvent(userId, gymId, eventId)) {
    return stop("Auto-Upgrade isn't available yet for bookings that include a guest.");
  }
  if (!isAtomic && isCutoffMode) return stop('Stopped at 12h cutoff to avoid cancellation penalty.');

  const prefs = JSON.parse(upgrade.preferences) || {};
  // Back off after a recovery (target taken): no cancel/rebook churn every cycle.
  if (prefs.groupCooldownUntil && Date.parse(prefs.groupCooldownUntil) > Date.now()) return;
  const liveMap = db.getStudioPreference(userId, upgrade.studio_id, gymId) || {};
  const preferredSlots = (liveMap.preferredSlots || []).map(String);
  const preferredRows = liveMap.preferredRows || [];
  if (preferredSlots.length === 0 && preferredRows.length === 0) return stopForMissingSpotMap(upgrade);
  if (isGymRateLimited(gymId)) return;

  const claimed = [];
  let committed = false;
  try {
    let details = getCachedEvent(gymId, eventId);
    if (!details) {
      const provider = getProvider(gymId);
      details = await provider.fetchEventDetails(eventId, db.getUserSession(userId, gymId));
      if (!details) return;
      setCachedEvent(gymId, eventId, details, 30000);
    }
    const layout = details.slots || [];
    const available = layout.filter((s) => s && s.isAvailable).map((s) => String(s.id));
    const preferredOrder = preferredOrderFor(layout, preferredSlots, preferredRows);
    if (preferredOrder.length === 0) return;

    // Fail closed: every member must still be held, and none may be a guest.
    let bookings;
    try { bookings = await listBookingsWithRelogin(userId, gymId); }
    catch (err) { console.warn(`[Poller] Could not verify group ${upgrade.id}:`, err.message); return; }
    const live = (bookings || []).filter((b) => b && !b.isWaitlist);
    const resolved = [];
    for (const m of members) {
      // Ownership: a member must be one of the user's own live reservations on THIS event.
      const row = live.find((b) => String(b.bookingId) === String(m.booking_id) && String(b.eventId) === eventId)
        || live.find((b) => String(b.eventId) === eventId && String(b.slotId) === String(m.slot_id) && !members.some((o) => o !== m && String(o.booking_id) === String(b.bookingId)));
      if (!row) return stop('A booking in the group no longer exists — monitoring stopped.');
      if (row.isGuest) return stop("Auto-Upgrade isn't available yet for bookings that include a guest.");
      if (String(row.bookingId) !== String(m.booking_id)) db.replaceAutoUpgradeMember(upgrade.id, m.booking_id, row.bookingId, row.slotId);
      else if (String(row.slotId) !== String(m.slot_id)) db.setAutoUpgradeMemberSlot(upgrade.id, m.booking_id, row.slotId);
      resolved.push({ bookingId: String(row.bookingId), slotId: String(row.slotId) });
    }
    // The ONLY ids this path may ever cancel.
    const oldSet = new Set(resolved.map((m) => m.bookingId));

    const plan = planGroupUpgrade({
      layoutSlots: layout,
      availableSlotIds: available,
      currentSlotIds: resolved.map((m) => m.slotId),
      preferredOrder,
      prioritizeTogether: prefs.prioritizeTogether === true,
    });
    if (!plan || plan.moves.length === 0) {
      db.updateAutoUpgrade(upgrade.id, userId, 'active', 'No better arrangement for the whole group. Monitoring...', { lastCheckedAt: nowIso() });
      return;
    }

    // Fail before mutating anything: the ROW's gym must have a usable session.
    {
      const sess = db.getUserSession(userId, gymId);
      const adapter = getProvider(gymId);
      let mock = false;
      try { mock = !!adapter.isMockUser(db.getUserById(userId), sess); } catch (_) {}
      if (!mock && !(sess && sess.accessToken)) {
        db.updateAutoUpgrade(upgrade.id, userId, 'active', 'No active session for this gym; the group was not touched. Monitoring...', { lastCheckedAt: nowIso() });
        return;
      }
    }

    for (const mv of plan.moves) {
      const key = `${gymId}:${eventId}:${mv.to}`; // gym-qualified (C3-23)
      if (claimedSlots.has(key)) return; // another monitor of this cycle holds a target seat
    }
    for (const mv of plan.moves) {
      const key = `${gymId}:${eventId}:${mv.to}`;
      claimedSlots.add(key); claimed.push(key); heldGroupClaims.add(key);
    }

    // Book-first needs a spare credit AND room under the per-class self limit.
    let bookFirst = false;
    if (!isAtomic) {
      const isMetered = gym?.capabilities?.metered !== false;
      let creditOk = true;
      if (isMetered) {
        const profileRes = await fetchFromGym(userId, gymId, '/profile');
        if (!profileRes.ok) return;
        const profileData = await profileRes.json();
        const profile = profileData.data || profileData;
        try { db.cacheUserProfile(userId, profile, gymId); } catch (_) {}
        creditOk = hasUsableCredits(
          (profile.available_credits || []).map((c) => ({
            typeId: c.credit_type && c.credit_type.id != null ? String(c.credit_type.id) : undefined,
            count: Number(c.count) || 0,
            expiresAt: c.expires_at || undefined,
            isGuestOnly: c.credit_type && typeof c.credit_type.is_guest_use_only === 'boolean' ? c.credit_type.is_guest_use_only : undefined,
          })),
          details && details.event && details.event.credits
        );
      }
      const limit = Number(details.maxBookableSlots);
      bookFirst = creditOk && Number.isFinite(limit) && resolved.length + 1 <= limit;

      // Cancel penalties: fail closed. Any penalty (or unreadable answer) means no move at all.
      const provider = getProvider(gymId);
      for (const mv of plan.moves) {
        const old = resolved.find((m) => m.slotId === mv.from);
        try {
          const pen = await provider.getCancelPenalty(old.bookingId, db.getUserSession(userId, gymId));
          if (!cancelRebook.penaltyIsNone(pen)) {
            db.updateAutoUpgrade(upgrade.id, userId, 'active', 'Moving the group would incur a cancellation penalty. Monitoring...', { lastCheckedAt: nowIso() });
            return;
          }
        } catch (_) { return; }
      }

      // Cancel & rebook (no direct swap, book-first impossible): only under the
      // policy's conditions, judged on LIVE availability, else skip this cycle.
      if (!bookFirst) {
        let freeSpots = 0;
        let targetsFree = false;
        try {
          const fresh = await getProvider(gymId).fetchEventDetails(eventId, db.getUserSession(userId, gymId));
          if (fresh) {
            setCachedEvent(gymId, eventId, fresh, 30000);
            const freeNow = new Set((fresh.slots || []).filter((s) => s && s.isAvailable).map((s) => String(s.id)));
            freeSpots = freeNow.size;
            targetsFree = plan.moves.every((mv) => freeNow.has(String(mv.to)));
          }
        } catch (_) { return; }
        const decision = cancelRebook.evaluateCancelRebook({
          enabled: cancelRebook.cancelRebookEnabled(db.getUserSettings(userId, gymId), getGymConfig(gymId) || null),
          atomic: false, bookFirstPossible: false, freeSpots,
          hoursUntilClass: DateTime.fromISO(upgrade.start_at, { zone: zoneOfGym(gymId) }).diff(DateTime.now(), 'hours').hours,
          isCutoffMode, penaltyNone: true, // every move's penalty answer was 'none' above
        });
        if (!decision.allowed || !targetsFree) {
          db.updateAutoUpgrade(upgrade.id, userId, 'active', cancelRebook.SKIP_MESSAGES[decision.reason] || 'The better spots were taken. Monitoring...', { lastCheckedAt: nowIso() });
          return;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 600)));

    const moved = [];            // { fromSlot, toSlot }
    let failure = null;          // { message, lost }
    const usedTargets = new Set(plan.moves.map((m) => m.to));
    const heldNow = new Set(resolved.map((m) => m.slotId));

    const cancelOld = async (bookingId) => {
      if (!oldSet.has(String(bookingId))) throw new Error(`Refusing to cancel booking ${bookingId}: not part of this group.`);
      await apiCancelBooking(userId, gymId, bookingId);
    };
    const bookedIdFor = async (res, slot) => {
      if (Number(res.bookingId) > 0) return Number(res.bookingId);
      try {
        const fresh = (await listBookingsWithRelogin(userId, gymId)) || [];
        const hit = fresh.find((b) => !b.isWaitlist && String(b.eventId) === eventId && String(b.slotId) === String(slot) && !oldSet.has(String(b.bookingId)));
        return hit ? Number(hit.bookingId) : 0;
      } catch (_) { return 0; }
    };

    const doMove = async (mv) => {
      const old = resolved.find((m) => m.slotId === mv.from);
      if (isAtomic) {
        const r = await swapSpotsWithRelogin(userId, gymId, old.bookingId, old.slotId, mv.to);
        if (!r.ok && handleUpgradeThrottle(r, userId, gymId, `${gymId}:${eventId}:${mv.to}`)) { failure = { message: 'The gym is rate-limiting requests.', nochange: true }; return false; }
        if (!r.ok) { failure = { message: r.error || 'Spot swap failed.', nochange: true }; return false; }
        // swap keeps the reservation id on this platform; follow whatever it reports.
        const nid = Number(r.bookingId) > 0 ? Number(r.bookingId) : Number(old.bookingId);
        db.replaceAutoUpgradeMember(upgrade.id, old.bookingId, nid, mv.to);
        oldSet.add(String(nid));
        moved.push({ fromSlot: mv.from, toSlot: mv.to });
        return true;
      }

      if (bookFirst) {
        let r;
        try { r = await bookSlotWithRelogin(userId, gymId, eventId, mv.to); }
        catch (err) { failure = { message: `The new spot could not be booked (${err.message}); your current spot is untouched.`, nochange: true }; return false; }
        if (!r.ok && handleUpgradeThrottle(r, userId, gymId, `${gymId}:${eventId}:${mv.to}`)) { failure = { message: 'The gym is rate-limiting requests.', nochange: true }; return false; }
        if (!r.ok) { failure = { message: r.error || 'The new spot could not be booked; your current spot is untouched.', nochange: true }; return false; }
        const nid = await bookedIdFor(r, mv.to);
        if (!nid) { failure = { message: 'EXTRA spot held: the new spot was booked but could not be confirmed, so your old spot is still held too. Please check My Bookings.', extra: true }; return false; }
        let cancelled = true;
        try { await cancelOld(old.bookingId); } catch (err) {
          cancelled = false;
          console.error(`[Poller] Group ${upgrade.id}: booked ${mv.to} but could not cancel old ${old.bookingId}:`, err.message);
        }
        // Persist after EVERY mutation: the member now follows the new reservation.
        db.replaceAutoUpgradeMember(upgrade.id, old.bookingId, nid, mv.to);
        moved.push({ fromSlot: mv.from, toSlot: mv.to });
        if (!cancelled) { failure = { message: `An extra spot is held: the new spot was booked but the old one (booking ${old.bookingId}, spot ${mv.from}) could not be cancelled. Please cancel it manually.`, extra: true, keep: true }; return false; }
        return true;
      }

      // cancel-first: release, rebook; on failure recover original, then nearest.
      try { await cancelOld(old.bookingId); }
      catch (err) { failure = { message: `Could not release the old spot: ${err.message}`, nochange: true }; return false; }
      // The old reservation is gone: persist that now, so a later failure never leaves a cancelled id behind.
      const origSlot = (db.getAutoUpgradeMembers(upgrade.id).find((m) => String(m.booking_id) === String(old.bookingId)) || {}).original_slot_id || old.slotId;
      db.removeAutoUpgradeMember(upgrade.id, old.bookingId);
      const tryBook = async (slot) => {
        try { return await bookSlotWithRelogin(userId, gymId, eventId, slot); }
        catch (err) { return { ok: false, error: err.message }; }
      };
      let r = await tryBook(mv.to);
      let landed = mv.to;
      if (!r.ok) {
        const taken = new Set([...heldNow, ...usedTargets].filter((id) => id !== mv.from));
        const byId = new Map(layout.map((s) => [String(s.id), s]));
        const origin = byId.get(String(mv.from));
        const nearest = available
          .filter((id) => !taken.has(id) && id !== mv.to)
          .sort((a, b) => {
            const d = (id) => { const s = byId.get(id); return origin && s ? Math.hypot(s.x - origin.x, s.y - origin.y) : Infinity; };
            return d(a) - d(b) || a.localeCompare(b);
          })
          .slice(0, 2);
        landed = null;
        for (const cand of [mv.from, ...nearest]) {
          const rr = await tryBook(cand);
          if (rr.ok) { r = rr; landed = cand; break; }
        }
        if (landed === null) {
          failure = { message: 'A spot was released but could not be re-booked.', lost: true };
          return false;
        }
        const rid = await bookedIdFor(r, landed);
        // rid 0 (id unreadable): keep the old id with the REAL slot; the next verify re-matches by event+slot.
        db.addAutoUpgradeMember(upgrade.id, rid || old.bookingId, landed, origSlot);
        failure = { message: landed === mv.from ? 'The new spot was taken; your original spot was re-booked.' : 'The new spot was taken; a nearby spot was booked instead.', restoredOriginal: landed === mv.from, recovered: true, unconfirmedId: !rid };
        return false;
      }
      const nid = await bookedIdFor(r, mv.to);
      db.addAutoUpgradeMember(upgrade.id, nid || old.bookingId, mv.to, origSlot);
      moved.push({ fromSlot: mv.from, toSlot: mv.to });
      if (!nid) { failure = { message: 'The new spot was booked but its reservation id could not be confirmed; please check My Bookings.', unconfirmedId: true }; return false; }
      return true;
    };

    for (const mv of plan.moves) {
      let okMove = false;
      try { okMove = await doMove(mv); }
      catch (err) {
        console.error(`[Poller] Group ${upgrade.id}: unexpected error during a move:`, err.message);
        failure = failure || { message: `Unexpected error during the move: ${err.message}`, unexpected: true };
      }
      if (!okMove) break;
    }

    const finalMembers = db.getAutoUpgradeMembers(upgrade.id);
    const lead = finalMembers[0];
    const leadUpdate = lead ? { currentSlotId: lead.slot_id, bookingId: lead.booking_id } : {};
    const finalSlots = finalMembers.map((m) => m.slot_id);
    const labels = groupSlotLabels(layout, finalSlots);
    const startedAt = nowIso();
    const common = { lastCheckedAt: startedAt, ...leadUpdate };

    if (!failure) {
      committed = true;
      db.updateAutoUpgrade(upgrade.id, userId, 'active', `Moved the group to ${labels.join(', ')}. Monitoring for better spots...`, {
        ...common, upgradedSlotId: lead ? lead.slot_id : undefined, upgradedAt: startedAt,
      });
      notifications.notify(userId, 'upgrade', {
        gymId, slot: labels.join(', '), startAt: upgrade.start_at, groupName: upgrade.group_name,
        className: upgrade.class_name, instructorName: upgrade.instructor_name, keptOriginal: false,
      });
      try { require('./calendar').regenerateSnapshot(userId); } catch (_) {}
      return;
    }

    if (moved.length === 0 && failure.nochange) {
      // Nothing changed: stay armed and retry next cycle.
      db.updateAutoUpgrade(upgrade.id, userId, 'active', `Group move did not start: ${failure.message} Monitoring...`, { lastCheckedAt: startedAt });
      return;
    }
    if (moved.length === 0 && failure.restoredOriginal && !failure.unconfirmedId) {
      // A spot was cancelled and re-booked as it was: back off (and give up after repeats) so
      // the next cycles cannot churn cancel/rebook on the same taken target.
      committed = true;
      const n = (prefs.groupRecoveries || 0) + 1;
      if (n >= GROUP_MAX_RECOVERIES) {
        db.updateAutoUpgrade(upgrade.id, userId, 'stopped', `${failure.message} Stopped after ${n} failed attempts; your spots are as before.`, { ...common, preferences: { ...prefs, groupRecoveries: n } });
      } else {
        db.updateAutoUpgrade(upgrade.id, userId, 'active', `${failure.message} Retrying later. Monitoring...`, {
          ...common, preferences: { ...prefs, groupRecoveries: n, groupCooldownUntil: new Date(Date.now() + GROUP_COOLDOWN_MS).toISOString() },
        });
      }
      return;
    }

    // Something moved, was lost, or a recovery spot was used: the group may no longer be
    // arranged as planned. Stop monitoring (no further changes) and tell the member.
    committed = true;
    const where = labels.length ? ` Current spots: ${labels.join(', ')}.` : '';
    const title = failure.lost ? 'Auto-Upgrade: a spot was lost ⚠️'
      : failure.extra ? 'Auto-Upgrade: an extra spot is held ⚠️'
      : 'Auto-Upgrade moved only part of your group ⚠️';
    const msg = `${failure.message}${where} Please check your bookings for ${displayClass(upgrade)}.`;
    db.updateAutoUpgrade(upgrade.id, userId, 'stopped', msg, { ...common, upgradedSlotId: moved.length ? moved[moved.length - 1].toSlot : undefined, upgradedAt: moved.length ? startedAt : undefined });
    pushService.sendNotification(userId, title, msg);
    try { require('./calendar').regenerateSnapshot(userId); } catch (_) {}
  } catch (err) {
    if (noteThrottleError(gymId, err)) {
      log.error('gym rate-limited, backing off group auto-upgrade', { component: 'poller', gymId, userId, err });
      notifyRateLimited(userId, gymId);
    } else {
      console.error(`[Poller] Error in group upgrade worker for event ${eventId}:`, err.message);
    }
  } finally {
    // Unused claims must not block another monitor this cycle.
    if (!committed) claimed.forEach((k) => claimedSlots.delete(k));
    claimed.forEach((k) => heldGroupClaims.delete(k));
  }
}

/**
 * Single-spot cancel & rebook (no spare credit, no direct swap). Runs only when
 * cancel-rebook-policy.js allows: setting on, class outside the 12h cutoff, >= 3 free
 * spots on LIVE availability, and the provider says cancelling has no penalty.
 * Returns { done:true } when this cycle is finished (skipped / recovered / lost), or
 * { bookResult } after a successful cancel + rebook of `candidateSlot`.
 */
async function cancelRebookSingle({ upgrade, candidateSlot, claimKey, isCutoffMode }) {
  const userId = upgrade.user_id;
  const gymId = upgrade.gym_id; // the ROW's gym (C3-12)
  const eventId = String(upgrade.event_id);
  const nowIso = () => new Date().toISOString();
  const skip = (msg) => {
    claimedSlots.delete(claimKey);
    db.updateAutoUpgrade(upgrade.id, userId, 'active', msg, { lastCheckedAt: nowIso() });
    return { done: true };
  };
  const provider = getProvider(gymId);
  const session = db.getUserSession(userId, gymId);

  let fresh;
  try { fresh = await provider.fetchEventDetails(eventId, session); }
  catch (_) { claimedSlots.delete(claimKey); return { done: true }; }
  if (!fresh) { claimedSlots.delete(claimKey); return { done: true }; }
  setCachedEvent(gymId, eventId, fresh, 30000);
  const freeNow = new Set((fresh.slots || []).filter((s) => s && s.isAvailable).map((s) => String(s.id)));

  let penaltyNone = false;
  try { penaltyNone = cancelRebook.penaltyIsNone(await provider.getCancelPenalty(upgrade.booking_id, session)); }
  catch (_) { penaltyNone = false; } // fail closed
  const decision = cancelRebook.evaluateCancelRebook({
    enabled: cancelRebook.cancelRebookEnabled(db.getUserSettings(userId, gymId), getGymConfig(gymId) || null),
    atomic: false, bookFirstPossible: false, freeSpots: freeNow.size,
    hoursUntilClass: DateTime.fromISO(upgrade.start_at, { zone: zoneOfGym(gymId) }).diff(DateTime.now(), 'hours').hours,
    isCutoffMode, penaltyNone,
  });
  if (!decision.allowed || !freeNow.has(String(candidateSlot))) {
    return skip(cancelRebook.SKIP_MESSAGES[decision.reason] || 'The better spot was taken. Monitoring...');
  }

  // Persist first, notify in its own try/catch: a throw must never skip state.
  const settleStop = (msg, title) => {
    claimedSlots.delete(claimKey);
    try { db.updateAutoUpgrade(upgrade.id, userId, 'stopped', msg, { lastCheckedAt: nowIso() }); }
    catch (e) { console.error(`[Poller] Could not persist stop for monitor ${upgrade.id}:`, e.message); }
    try { Promise.resolve(pushService.sendNotification(userId, title, msg)).catch((e) => console.error('[Poller] notify failed:', e.message)); } catch (e) { console.error('[Poller] notify failed:', e.message); }
    return { done: true };
  };
  // The truth about a booking after an ambiguous result: true/false, or null if unreadable.
  const heldNow = async (bookingId) => {
    try {
      const live = (await listBookingsWithRelogin(userId, gymId)) || [];
      return live.some((b) => b && !b.isWaitlist && String(b.eventId) === eventId && String(b.bookingId) === String(bookingId));
    } catch (_) { return null; }
  };
  // Resolve the reservation id of our spot on this event from live bookings; 0 if unknown.
  const idForSlot = async (res, slot) => {
    if (Number(res && res.bookingId) > 0) return Number(res.bookingId);
    try {
      const live = (await listBookingsWithRelogin(userId, gymId)) || [];
      const hit = live.find((b) => b && !b.isWaitlist && String(b.eventId) === eventId && String(b.slotId) === String(slot));
      return hit ? Number(hit.bookingId) : 0;
    } catch (_) { return 0; }
  };
  const label = displayClass(upgrade);

  try { await apiCancelBooking(userId, gymId, upgrade.booking_id); }
  catch (err) {
    // The cancel may have succeeded upstream: learn the truth before deciding.
    const still = await heldNow(upgrade.booking_id);
    if (still === true) return skip(`Could not release the old spot (${err.message}); nothing changed. Monitoring...`);
    if (still === null) return settleStop(`We could not confirm whether your spot for ${label} was released. Please check your bookings.`, 'Auto-Upgrade stopped ⚠️');
    // still === false: it is gone; carry on as if the cancel succeeded.
  }

  let r;
  try { r = await bookSlotWithRelogin(userId, gymId, eventId, candidateSlot); }
  catch (err) { r = { ok: false, error: err.message }; }
  if (r.ok) {
    const nid = await idForSlot(r, candidateSlot);
    if (!nid) return settleStop(`Your new spot for ${label} was booked but its reservation could not be confirmed. Please check your bookings.`, 'Auto-Upgrade stopped ⚠️');
    return { bookResult: { ...r, bookingId: nid } };
  }

  // The new spot failed after the old one was released: put the original back.
  claimedSlots.delete(claimKey);
  let back;
  try { back = await bookSlotWithRelogin(userId, gymId, eventId, upgrade.current_slot_id); }
  catch (err) { back = { ok: false, error: err.message }; }
  if (back.ok) {
    const oid = await idForSlot(back, upgrade.current_slot_id);
    if (!oid) return settleStop(`Your original spot for ${label} was re-booked but its reservation could not be confirmed. Please check your bookings.`, 'Auto-Upgrade stopped ⚠️');
    try {
      db.updateAutoUpgrade(upgrade.id, userId, 'active', 'The new spot was taken; your original spot was re-booked. Monitoring...', { bookingId: oid, lastCheckedAt: nowIso() });
    } catch (e) { console.error(`[Poller] Could not persist recovery for monitor ${upgrade.id}:`, e.message); }
    return { done: true };
  }
  return settleStop(`Your spot for ${label} was released but could not be re-booked. Please check your bookings.`, 'Auto-Upgrade: a spot was lost ⚠️');
}

async function attemptUpgradeSlot(upgrade, isCutoffMode) {
  // Group monitors (several reservations) are planned and moved together.
  const groupMembers = db.getAutoUpgradeMembers(upgrade.id);
  if (groupMembers.length > 1) return attemptGroupUpgrade(upgrade, groupMembers, isCutoffMode);
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
  let usedCancelFirst = false; // the old spot was already cancelled before the rebook
  const currentSlotId = String(upgrade.current_slot_id);
  const prefs = JSON.parse(upgrade.preferences) || {};
  // Preferred slots come from the LIVE shared studio map only (no snapshot fallback).
  const liveMap = db.getStudioPreference(userId, upgrade.studio_id, gymId) || {};
  const preferredSlots = (liveMap.preferredSlots || []).map(String);
  const preferredRows = liveMap.preferredRows || [];

  if (preferredSlots.length === 0 && preferredRows.length === 0) return stopForMissingSpotMap(upgrade);

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
        let cancelFirst = false; // no spare credit: cancel the old spot, then book the new one
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

            // Book-first is possible only with a spare credit AND room under the per-class
            // self limit. Otherwise a non-atomic gym may cancel & rebook, if the member's
            // per-gym setting allows (gated again below by cancel-rebook-policy.js).
            const selfLimit = Number(details && details.maxBookableSlots);
            const bookFirstPossible = hasCredits && !(Number.isFinite(selfLimit) && selfLimit < 2);
            if (!bookFirstPossible && cancelRebook.cancelRebookEnabled(db.getUserSettings(userId, gymId), getGymConfig(gymId) || null) && upgrade.booking_id) {
              cancelFirst = true;
            } else if (!hasCredits) {
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
          } else if (cancelFirst) {
            const out = await cancelRebookSingle({ upgrade, candidateSlot, claimKey, isCutoffMode, labelForSlot });
            if (out.done) return;
            bookResult = out.bookResult;
            usedCancelFirst = true;
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
        if (!usedAtomicSwap && !isCutoffMode && !usedCancelFirst && upgrade.booking_id) {
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
      log.error('gym rate-limited, backing off auto-upgrade polling', { component: 'poller', gymId, userId, err });
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
  heldGroupClaims.forEach((k) => claimedSlots.add(k)); // seats an in-flight group run still holds
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
        // A group on a gym without an atomic swap cannot keep its originals (it would
        // hold 2N seats), so the final-attempt opt-in does not apply: it stops at 12h.
        const groupWithoutSwap = db.getAutoUpgradeMembers(upgrade.id).length > 1 && !getGymConfig(upgrade.gym_id)?.capabilities?.atomicSwap;
        if (prefs.keepOriginalOnCutoff && pollingOn && !groupWithoutSwap) {
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
    // M step 3: nightly purge of landing analytics older than 13 months.
    cron.schedule('40 3 * * *', () => {
      try { require('./landing-events').purgeOld(); } catch (e) { console.warn('[Landing] purge failed:', e.message); }
    });
    // Warm the cache shortly after startup with a small random offset.
    setTimeout(() => { refreshBookingCaches().catch(() => {}); }, 45000 + Math.floor(Math.random() * 45000));
  },
  executeAutoUpgradeChecks,
  refreshBookingCaches,
  bookingCacheRowsFor,
  fetchFromGym,
  listBookingsWithRelogin
};
