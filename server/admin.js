const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const { triggerAutoRelogin } = require('./auth');
const { getProvider } = require('./providers');
const gymsConfig = require('./gyms.config');

// Interim single-gym bridge: live CodexFit reads (bookings, profile) are always
// against Psycle London for now — real per-request gym resolution lands with
// Phase 5's client gym picker (see resolveActiveGymId in db.js). DB-backed data
// (below) is already gym-aware as of WP-D3/D4.
// No module-level provider (WP-D7). An admin request reads ANOTHER account's
// data, so the gym must be resolved from THAT user — db.resolveActiveGymId is
// already scoped to the user id it is passed, not to the requester.

// Constant-time string comparison via fixed-length SHA-256 digests, so the
// comparison time doesn't leak how many leading characters matched (and length
// differences don't throw, unlike a raw timingSafeEqual on the buffers).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const router = express.Router();

// C7-3: one-line audit helper. Detail must never contain secrets (db also redacts by key name).
function audit(req, action, targetUserId, detail) {
  db.recordAdminAudit({ action, targetUserId: targetUserId ?? null, ip: req.ip || null, detail });
}

// Admin auth uses the same JWT_SECRET as user auth but requires { admin: true } in the payload.
// ADMIN_PASSWORD must be set in the environment; if absent all admin routes return 503.
const JWT_SECRET = (() => {
  let s = process.env.JWT_SECRET;
  if (!s) {
    s = db.getKV('jwt_secret');
    if (!s) { s = require('crypto').randomBytes(32).toString('hex'); db.setKV('jwt_secret', s); }
  }
  return s;
})();

function adminUnavailable(res) {
  return res.status(503).json({ message: 'Admin access is not configured (ADMIN_PASSWORD not set).' });
}

function authenticateAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return adminUnavailable(res);

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Admin token required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || !decoded.admin) return res.status(403).json({ message: 'Invalid or expired admin session.' });
    next();
  });
}

// Call a normalized provider method with the viewed user's selected-gym
// session. Admin requests do not carry the account owner's gym context.
async function gymProviderCall(userId, gymId, method, ...args) {
  const user = db.runWithGymContext(userId, gymId, () => db.getUserById(userId));
  if (!user || !user.jwt) throw new Error('User has no active gym session.');
  const provider = getProvider(gymId);
  const run = (token) => provider[method](...args, { accessToken: token });
  try {
    return await run(user.jwt);
  } catch (err) {
    if (err.status !== 401) throw err;
    const newJwt = await triggerAutoRelogin(userId, gymId);
    return run(newJwt);
  }
}

function adminBookingFromNormalized(b) {
  const event = b.event || {};
  if (!event.startAt) return null;
  return {
    booking_id: b.bookingId,
    event_id: b.eventId || event.id || null,
    start_at: event.startAt,
    class_name: event.name || 'Class',
    group_name: event.discipline || '',
    instructor_name: event.instructors?.[0]?.name || '',
    studio_name: event.studioName || '',
    location_name: event.locationName || '',
    slot_label: b.slotId ?? '',
  };
}

// POST /api/admin/login — verify ADMIN_PASSWORD, issue admin JWT (1h)
router.post('/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return adminUnavailable(res);
  const { password } = req.body;
  if (!password || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    audit(req, 'login.failure');
    return res.status(401).json({ message: 'Invalid admin password.' });
  }
  audit(req, 'login.success');
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

// GET /api/admin/users — list all users with queue counts
router.get('/users', authenticateAdmin, (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/users/:id[?gymId=] — full detail bundle for the drawer (profile,
// credits, subscriptions, stats, bookings + spot/upgrade status, queue, monitors,
// spot maps).
//
// C3-8: this used to always resolve ONE ambient gym (db.resolveActiveGymId's
// default-gym fallback), so a JAB-only or second-gym view of a multi-gym
// account was never reachable from the admin panel — a two-gym user's detail
// silently showed only their Psycle side. `?gymId=` lets the admin pick which
// linked gym's session/profile/queue/monitors/spot-maps to view; it is
// validated against `user_gyms` (never trusted blind — same rule as the
// `x-gym-id` header in auth.js's withGymContext) and, when present, threaded
// through `db.runWithGymContext` so every accessor below (getUserDetail,
// gymGet's resolveActiveGymId/getUserById) resolves consistently to THAT gym
// rather than the account's default. With no `?gymId=`, behaviour is
// unchanged — the same default-gym resolution as before.
router.get('/users/:id', authenticateAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ message: 'Invalid user ID.' });
  const requestedGymId = req.query.gymId ? String(req.query.gymId) : null;
  if (requestedGymId && !db.isGymLinked(userId, requestedGymId)) {
    return res.status(403).json({ message: `User is not linked to gym "${requestedGymId}".` });
  }
  const handle = async () => {
    const detail = db.getUserDetail(userId);
    if (!detail) return res.status(404).json({ message: 'User not found.' });

    const profile = detail.profile || {};
    const stats = profile.stats || {};

    const gymId = db.resolveActiveGymId(userId);

    // Block A — live bookings through the selected gym's normalized provider,
    // falling back to booking_cache if the live fetch fails or returns empty.
    let bookings = detail.bookings;
    try {
      const list = await gymProviderCall(userId, gymId, 'listBookings');
      const normalized = (Array.isArray(list) ? list : []).map(adminBookingFromNormalized).filter(Boolean);
      if (normalized.length > 0) {
        bookings = normalized;
        // Warm the reminder cache (camelCase shape expected by replaceBookingCache).
        try {
          db.replaceBookingCache(userId, normalized.map(b => ({
            bookingId: b.booking_id, eventId: b.event_id, startAt: b.start_at,
            className: b.class_name, groupName: b.group_name, instructorName: b.instructor_name,
            studioName: b.studio_name, locationName: b.location_name, slotLabel: b.slot_label,
            gymId,
          })), [gymId]);
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[Admin] Live bookings fetch failed for user', userId, err.message);
    }

    // Block B — provider-normalized studio metadata. Cache by gym because
    // provider studio ids are only unique within a gym.
    let studioNames = {};
    try {
      studioNames = db.getStudioNameMap(gymId); // DB-derived fallback
    } catch (_) {}
    try {
      const cacheSuffix = `:${gymId}`;
      const cachedAt = db.getKV(`studio_name_map_at${cacheSuffix}`);
      const fresh = cachedAt && (Date.now() - new Date(cachedAt).getTime()) < 7 * 864e5;
      let fetchedMap = null;
      if (fresh) {
        const raw = db.getKV(`studio_name_map${cacheSuffix}`);
        if (raw) { try { fetchedMap = JSON.parse(raw); } catch (_) {} }
      } else {
        const metadata = await gymProviderCall(userId, gymId, 'fetchMetadata', {});
        const studios = metadata?.studios || [];
        fetchedMap = {};
        for (const studio of studios) {
          if (studio && studio.id != null && studio.name) fetchedMap[String(studio.id)] = studio.name;
        }
        db.setKV(`studio_name_map${cacheSuffix}`, JSON.stringify(fetchedMap));
        db.setKV(`studio_name_map_at${cacheSuffix}`, new Date().toISOString());
      }
      if (fetchedMap) studioNames = { ...studioNames, ...fetchedMap }; // fetched wins
    } catch (err) {
      console.warn('[Admin] Studio name map fetch failed for user', userId, err.message);
    }

    // Cross-reference resolved bookings with active upgrade monitors so each
    // booked class can show its auto-upgrade status. Match on booking_id first,
    // then event_id. Maps are built from detail.autoUpgrades (unchanged).
    const upgradeByBooking = new Map();
    const upgradeByEvent = new Map();
    for (const u of detail.autoUpgrades) {
      if (u.booking_id != null) upgradeByBooking.set(String(u.booking_id), u);
      if (u.event_id != null) upgradeByEvent.set(String(u.event_id), u);
    }
    const bookingsWithUpgrade = bookings.map(b => {
      const u = upgradeByBooking.get(String(b.booking_id)) || upgradeByEvent.get(String(b.event_id));
      return {
        ...b,
        upgrade: u ? { status: u.status, statusMessage: u.status_message, preferences: u.preferences } : null,
      };
    });

    res.json({
      user: detail.user,
      bookingWindow: detail.settings?.bookingWindow || null,
      detectedBookingOffset: detail.settings?.detectedBookingOffset ?? null,
      profile: {
        id: profile.id,
        firstName: profile.first_name,
        lastName: profile.last_name,
        email: profile.email,
        telephone: profile.telephone,
        createdAt: profile.created_at,
        bookingCutoff: profile.booking_cutoff,
        extendedCutoff: profile.extended_cutoff,
      },
      stats: {
        totalBookings: stats.total_bookings,
        totalUniqueBookings: stats.total_unique_bookings,
        totalUniqueBookingsAttended: stats.total_unique_bookings_attended,
        creditsRemaining: stats.credits_remaining,
        totalAttendedMinutes: stats.total_attended_minutes,
      },
      credits: Array.isArray(profile.available_credits) ? profile.available_credits : [],
      subscriptions: Array.isArray(profile.subscriptions) ? profile.subscriptions : [],
      subscriptionStatuses: Array.isArray(profile.subscription_statuses) ? profile.subscription_statuses : [],
      bookings: bookingsWithUpgrade,
      autoBookings: detail.autoBookings,
      autoUpgrades: detail.autoUpgrades,
      studioPreferences: detail.studioPreferences,
      studioNames,
      gyms: detail.gyms,
      viewedGymId: requestedGymId || db.resolveActiveGymId(userId),
    });
  };
  try {
    if (requestedGymId) {
      await db.runWithGymContext(userId, requestedGymId, handle);
    } else {
      await handle();
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/users/:id/priority — update a user's priority tier
router.put('/users/:id/priority', authenticateAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const priority = parseInt(req.body.priority, 10);
  if (isNaN(userId) || isNaN(priority) || priority < 1 || priority > 999) {
    return res.status(400).json({ message: 'Priority must be an integer between 1 and 999.' });
  }
  try {
    // No per-gym control in the admin UI — applies to every linked gym.
    db.setUserPriority(userId, priority);
    audit(req, 'user.priority', userId, { priority });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/admin/users/:id — delete user + all their data (CASCADE handles related rows)
router.delete('/users/:id', authenticateAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ message: 'Invalid user ID.' });
  try {
    const gone = db.getUserById(userId);
    db.deleteUser(userId);
    audit(req, 'user.delete', userId, { email: gone ? gone.email : null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// F-7 Stage B: gym presentation editor. ONLY the presentation contract is
// editable; tenant URLs, headers, capabilities and booking policy stay in
// gyms.config.js. Nothing here returns headers, credentials or provider URLs.
// ---------------------------------------------------------------------------
function presentationView(g) {
  const overrides = db.readPresentationOverrides();
  return {
    id: g.id, name: g.name, provider: g.provider, enabled: g.enabled,
    presentation: g.presentation,
    baseline: gymsConfig.getBaselinePresentation(g.id),
    overridden: Object.prototype.hasOwnProperty.call(overrides, g.id),
  };
}

router.get('/gym-presentations', authenticateAdmin, (req, res) => {
  res.json({ gyms: gymsConfig.listGyms().map(presentationView) });
});

// Dry-run validation: same validator as boot, nothing persisted.
router.post('/gym-presentations/:gymId/validate', authenticateAdmin, (req, res) => {
  if (!gymsConfig.getGymConfig(req.params.gymId)) return res.status(404).json({ message: 'Unknown gym.' });
  try {
    res.json({ ok: true, presentation: gymsConfig.sanitizePresentation(req.body && req.body.presentation, req.params.gymId) });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

router.put('/gym-presentations/:gymId', authenticateAdmin, (req, res) => {
  const { gymId } = req.params;
  if (!gymsConfig.getGymConfig(gymId)) return res.status(404).json({ message: 'Unknown gym.' });
  try {
    const clean = gymsConfig.sanitizePresentation(req.body && req.body.presentation, gymId);
    const map = db.readPresentationOverrides();
    map[gymId] = clean;
    db.writePresentationOverrides(map);
    audit(req, 'gym-presentation.update', null, { gymId });
    gymsConfig.setPresentation(gymId, clean);
    res.json(presentationView(gymsConfig.getGymConfig(gymId)));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/gym-presentations/:gymId', authenticateAdmin, (req, res) => {
  const { gymId } = req.params;
  if (!gymsConfig.getGymConfig(gymId)) return res.status(404).json({ message: 'Unknown gym.' });
  const map = db.readPresentationOverrides();
  delete map[gymId];
  db.writePresentationOverrides(map);
  audit(req, 'gym-presentation.reset', null, { gymId });
  gymsConfig.resetPresentation(gymId);
  res.json(presentationView(gymsConfig.getGymConfig(gymId)));
});

// Connection test: read-only. Calls the adapter's unauthenticated metadata read
// (GET requests only) with a hard timeout. It never books, logs in, or writes,
// and the response carries counts and timing only.
router.post('/gym-presentations/:gymId/test-connection', authenticateAdmin, async (req, res) => {
  const { gymId } = req.params;
  if (!gymsConfig.getGymConfig(gymId)) return res.status(404).json({ message: 'Unknown gym.' });
  const started = Date.now();
  let timer;
  try {
    const meta = await Promise.race([
      getProvider(gymId).fetchMetadata({}, null),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Timed out after 15s'), { status: 504 })), 15000); }),
    ]);
    res.json({
      ok: true, latencyMs: Date.now() - started,
      counts: {
        locations: (meta.locations || []).length, studios: (meta.studios || []).length,
        instructors: (meta.instructors || []).length,
      },
    });
  } catch (err) {
    res.json({ ok: false, latencyMs: Date.now() - started, status: err.status || null, message: String(err.message || err).slice(0, 200) });
  } finally { clearTimeout(timer); }
});

// GET /api/admin/gyms — list the gym registry (for the admin panel's "link a gym" picker)
router.get('/gyms', authenticateAdmin, (req, res) => {
  try {
    res.json({ gyms: db.getGyms() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/users/:id/link-gym — link a gym to a user's account (WP-D3/D4).
// Support/testing entry point ahead of Phase 5's client-side gym picker; no
// credential verification is performed here — it just creates the DB link.
router.post('/users/:id/link-gym', authenticateAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { gymId } = req.body;
  if (isNaN(userId) || !gymId) {
    return res.status(400).json({ message: 'userId and gymId are required.' });
  }
  try {
    db.linkGym(userId, gymId);
    audit(req, 'user.link-gym', userId, { gymId });
    // Return the stripped/public shape — never echo encrypted_password/session_json,
    // even ciphertext, back over an API response.
    const gyms = db.getUserGymsPublic(userId);
    res.json({ success: true, gyms });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST /api/admin/users/:id/reset-password — the account-recovery escape hatch.
//
// Self-service recovery does not exist: the gym-login mechanism was removed
// (Decision D5, it re-coupled the account to the gym) and no replacement has
// been chosen yet, so without this a forgotten the app password means a
// permanently unreachable account. See Documentation/Workstreams/C6-accounts-auth.md (C6-1).
//
// The admin does NOT choose the password. The server generates a strong
// single-use one and returns it exactly once, for the admin to relay
// out-of-band; it is never stored in plaintext and cannot be read back.
//
// `resetGymCredentials` defaults to TRUE, per the settled half of D5: if an
// account needed recovering, its stored secrets should not be assumed safe.
// The admin can opt out for a routine "I just forgot it" where they know the
// account was never at risk — that is a judgement call, so it is explicit
// rather than silently one way or the other. Clearing a credential never
// deletes the gym link: queues, spot maps and priority tiers survive, and the
// user simply re-authenticates each gym.
router.post('/users/:id/reset-password', authenticateAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ message: 'A valid user id is required.' });

  const resetGyms = req.body?.resetGymCredentials !== false; // default true

  try {
    const user = db.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // 24 bytes of base64url ≈ 32 chars — comfortably past the 8-char minimum and
    // not something a human will retype by accident.
    const tempPassword = crypto.randomBytes(24).toString('base64url');
    db.setAccountPassword(userId, tempPassword);

    const clearedGyms = resetGyms ? db.resetGymCredentials(userId) : [];

    // Audit trail. There is no structured logging yet (Workstreams C7-3), so this is
    // the only record that an account's credentials were administratively
    // changed — worth keeping even once proper logging lands.
    audit(req, 'user.reset-password', userId, { gymCredentialsCleared: clearedGyms });
    console.log(`[Admin] Password reset for user ${userId} (${user.email}); ` +
      `gym credentials cleared: ${clearedGyms.length ? clearedGyms.join(', ') : 'none'}`);

    res.json({
      success: true,
      email: user.email,
      tempPassword,      // shown once; the admin relays it out-of-band
      clearedGyms,
      note: 'Give this to the user over a trusted channel. They should change it in Settings once they are back in.',
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/admin/audit?limit=&offset= — read-only, newest first, capped at 500 (C7-3)
router.get('/audit', authenticateAdmin, (req, res) => {
  res.json({ entries: db.listAdminAudit({ limit: req.query.limit, offset: req.query.offset }) });
});

// Used by GET /metrics (server.js): true when the bearer token is a valid admin session JWT.
router.verifyAdminToken = (token) => { try { return !!jwt.verify(token, JWT_SECRET).admin; } catch (_) { return false; } };

module.exports = router;
