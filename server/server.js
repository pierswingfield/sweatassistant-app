require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const auth = require('./auth');
const { handleLogin, authenticateToken, authenticateTokenSSE } = auth;
const pushService = require('./push');
const notifications = require('./notifications');
const scheduler = require('./scheduler');
const poller = require('./poller');
const calendar = require('./calendar');
const { normalizeCalendarPrefs, applyCalendarPatch } = require('./calendar-prefs');
const { isRollingWeekly } = require('./providers/booking-window');
const adminRouter = require('./admin');
const normalizedRouter = require('./routes-normalized');
const instructorPhotoRouter = require('./instructor-photo-routes');
const config = require('./config');
const competing = require('./competing-bookings');
const { getGymConfig } = require('./gyms.config');
const { appName } = config;

// The old CodexFit proxy + cart routes that lived here (WP-D9's removed
// `/api/proxy/*`, and C2-1's retired v1 cart flow) are both gone now — every
// gym-aware call goes through server/routes-normalized.js, which resolves its
// provider per request from the calling user's active gym (WP-D7). Nothing
// in this file should import `./providers` directly again.

const app = express();
const PORT = process.env.PORT || 3000;

// CORS allowlist. The PWA is served same-origin in production, so only the
// configured public host (and localhost in dev) are permitted. Requests with no
// Origin header (curl, server-to-server, same-origin navigations, native
// calendar clients hitting the .ics feed) are allowed through.
const allowedOrigins = new Set(config.corsOrigins);
if (process.env.NODE_ENV !== 'production') {
  ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000']
    .forEach((o) => allowedOrigins.add(o));
}
app.use(cors({
  origin(origin, cb) {
    // Allow listed origins (and requests with no Origin: curl, native calendar
    // clients, same-origin navigations). For a disallowed origin, omit the CORS
    // headers rather than throwing — the browser then blocks the response, and
    // we avoid leaking a 500 + stack trace to non-browser callers.
    cb(null, !origin || allowedOrigins.has(origin));
  },
}));
app.use(express.json());

// Strict brute-force limiters for the two password endpoints, keyed by IP.
// Active in production only (consistent with the other limiters); dev login
// (dev@psycle.com) stays frictionless.
// No custom keyGenerator — the library's default keys by client IP with correct
// IPv6 subnet handling (in v8 the `ipKeyGenerator` helper takes an IP string,
// not a req, so a hand-rolled key here would mis-key every request and never
// accumulate a count).
const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts — please try again later.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many admin login attempts — please try again later.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

// Per-user rate limiters (keyed on userId set by authenticateToken, not IP —
// all users share the Pi's egress IP so IP-based limiting would be wrong).
// (The former `proxyLimiter` lived here. Its budget moved to
// routes-normalized.js `extrasLimiter` along with the routes that replaced the
// `/api/proxy/*` callers — see the removal note further down.)

const bookingMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ? String(req.userId) : ipKeyGenerator(req.ip),
  message: { message: 'Too many booking requests — please wait before retrying.' },
  skip: (req) => process.env.NODE_ENV !== 'production',
});

// Public calendar feed is keyed by IP (no userId — it's token-by-URL). Generous
// limit; calendar clients poll infrequently but several apps may share an IP.
// Uses the library's default IP keyGenerator (correct IPv6 handling in v8) — a
// hand-rolled `ipKeyGenerator(req)` mis-keys every request and never limits.
const calendarFeedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests.',
  skip: (req) => process.env.NODE_ENV !== 'production',
});

// Per-user background-work quotas. Both are enforced PER GYM, not per account:
// the counters they compare against (db.countPendingAutoBookings /
// countActiveAutoUpgrades) scope to db.resolveActiveGymId, so linking a second
// gym grants a fresh allowance there rather than eating into the first gym's.
// That is deliberate — the cost these caps exist to bound (scheduler dispatch
// work, upgrade polling) is per-gym too. Named so the limit and the message it
// quotes cannot drift apart (WP-G).
const MAX_PENDING_AUTO_BOOKINGS_PER_GYM = 15;
const MAX_ACTIVE_AUTO_UPGRADES_PER_GYM = 10;

// -------------------------------------------------------------
// PUBLIC CONFIG (no auth — needed before login for app name in UI)
// -------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({ appName: config.appName, publicHost: config.publicHost });
});

// -------------------------------------------------------------
// HEALTH CHECK (no auth)
// Liveness probe for the background services. Each service (scheduler, poller,
// calendar) writes a heartbeat timestamp to server_kv on a fixed cadence; a
// plain HTTP 200 only proves Express is up, so we check those heartbeats to
// detect a silently-crashed in-process timer/cron. Returns 200 when every
// service is fresh, 503 when any is stale — so an uptime monitor watching the
// status code alerts automatically. See AGENTS.md "Health Check & Uptime
// Monitoring" for wiring instructions.
// -------------------------------------------------------------

// Max age (ms) before a service's heartbeat is considered stale. Scheduler and
// poller tick every 60s; calendar polls every 3h.
const HEARTBEAT_LIMITS = {
  scheduler: 3 * 60 * 1000,
  poller: 3 * 60 * 1000,
  calendar: 3.5 * 60 * 60 * 1000,
};

app.get('/api/health', async (req, res) => {
  const now = Date.now();
  const services = {};
  let allHealthy = true;

  for (const [name, limit] of Object.entries(HEARTBEAT_LIMITS)) {
    const raw = db.getKV(`heartbeat:${name}`);
    const last = raw ? Number(raw) : null;
    const ageMs = last ? now - last : null;
    const healthy = last != null && ageMs <= limit;
    if (!healthy) allHealthy = false;
    services[name] = {
      healthy,
      lastHeartbeatAgoSec: ageMs != null ? Math.round(ageMs / 1000) : null,
      staleAfterSec: Math.round(limit / 1000),
    };
  }

  // Surface the instant the auto-book scheduler is actually armed for, so a wrong
  // wake clock is visible from outside the process (layer I). Since the clock is
  // driven by the queue, this is **null when nothing is queued** — that is the
  // honest answer, not a fault. It is no longer always a Monday: a per-class gym
  // arms whatever instant its API published.
  const nextRelease = db.getKV('scheduler_next_release') || null;

  // Shared schedule-cache counters. Exposed because "the timetable is slow" was
  // diagnosable only by asking a user whether the SECOND load was slow too —
  // a hit rate makes the same question answerable from outside the process.
  // A hit rate near zero with a healthy entry count means keys are too specific
  // (a user id crept into one); misses climbing with entries flat means the TTL
  // is shorter than the gap between visits.
  let scheduleCacheStats = null;
  try { scheduleCacheStats = require('./schedule-cache').getStats(); } catch (_) {}
  let layoutCacheStats = null;
  try { layoutCacheStats = require('./routes-normalized').layoutCacheStats(); } catch (_) {}
  let instructorPhotoCache = null;
  try {
    const photoCache = require('./instructor-photo');
    instructorPhotoCache = { ...photoCache.getStats(), ...(await photoCache.cacheUsage()) };
  } catch (_) {}

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    time: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    scheduleCache: scheduleCacheStats,
    layoutCache: layoutCacheStats,
    instructorPhotoCache,
    nextReleaseAt: nextRelease,
    services,
  });
});

// -------------------------------------------------------------
// TEMPLATED STATIC FILES
// In production, intercept specific static files that contain the app name
// and replace the default "Sweat Assistant" with the configured value.
// This lets the same built client serve under a different name without a
// rebuild. Files are read once and cached; the replace is a no-op when the
// configured name equals the default.
// -------------------------------------------------------------

const fs = require('fs');
const fileCache = {};
// Built client directory. Overridable so tests (and the browser check) can serve a build from elsewhere.
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

function sendTemplated(filePath, res, contentType) {
  if (!fileCache[filePath]) {
    try {
      fileCache[filePath] = fs.readFileSync(filePath, 'utf8');
    } catch {
      return res.status(404).send('Not found');
    }
  }
  let content = fileCache[filePath];
  if (config.appName !== 'Sweat Assistant') {
    content = content.replaceAll('Sweat Assistant', config.appName);
  }
  res.type(contentType).send(content);
}

// Serves the client SPA files in production Docker container.
// index.html, manifest.json and sw.js are served via templated routes so the
// app name can be injected; everything else goes through express.static.
if (process.env.NODE_ENV === 'production') {
  // Intercept index.html (both '/' and '/index.html') before express.static
  // so the app name can be template-replaced.
  app.get(['/', '/index.html'], (req, res) => {
    sendTemplated(path.join(PUBLIC_DIR, 'index.html'), res, 'text/html');
  });
  app.get('/manifest.json', (req, res) => {
    sendTemplated(path.join(PUBLIC_DIR, 'manifest.json'), res, 'application/manifest+json');
  });
  app.get('/sw.js', (req, res) => {
    sendTemplated(path.join(PUBLIC_DIR, 'sw.js'), res, 'application/javascript');
  });
  // Gym wordmarks: long-lived + stale-while-revalidate (art changes bump the ?v= in gyms.config.js), and the
  // right MIME (avif was served as application/octet-stream). Everything else keeps Express's defaults.
  app.use('/gyms', express.static(path.join(PUBLIC_DIR, 'gyms'), {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      if (/\.avif$/i.test(filePath)) res.type('image/avif');
      if (/\.svg$/i.test(filePath)) res.type('image/svg+xml');
    },
  }));
  app.use(express.static(PUBLIC_DIR));
}

// -------------------------------------------------------------
// ADMIN PANEL
// Requires ADMIN_PASSWORD env var. All routes protected by admin JWT.
// -------------------------------------------------------------

app.get('/admin', (req, res) => {
  sendTemplated(path.join(__dirname, 'admin.html'), res, 'text/html');
});

app.use('/api/admin/login', adminLoginLimiter);
app.use('/api/admin', adminRouter);
app.use('/api', instructorPhotoRouter);
app.use('/api', normalizedRouter);

// -------------------------------------------------------------
// BFF AUTHENTICATION
// -------------------------------------------------------------

app.post('/api/auth/login', authLoginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await handleLogin(email, password);
    res.json(result);
  } catch (err) {
    console.error('[Auth] BFF login error:', err.message);
    res.status(401).json({ message: err.message });
  }
});

// Create a Sweat Assistant account (Decision D4) — no gym involved. Shares the
// login limiter: both are unauthenticated credential endpoints on the same IP.
app.post('/api/auth/signup', authLoginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  try {
    res.json(await auth.handleSignup(email, password));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Account recovery endpoints were REMOVED 2026-08-31 — they proved identity via
// a linked gym's login, which re-coupled the account to the gym and defeated
// Decision D4. The replacement mechanism is an open decision (Workstreams C6-1);
// until then a forgotten account password requires an admin reset.

app.get('/api/auth/status', authenticateToken, (req, res) => {
  res.json({ userId: req.userId, email: req.email });
});

app.delete('/api/auth/me', authenticateToken, (req, res) => {
  try {
    db.deleteAllUserData(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// WEB PUSH SUBSCRIPTIONS
// -------------------------------------------------------------

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushService.vapidPublicKey });
});

app.post('/api/push/subscribe', authenticateToken, (req, res) => {
  const { subscription } = req.body;
  if (!subscription) {
    return res.status(400).json({ message: 'Subscription object required' });
  }
  db.addPushSubscription(req.userId, subscription);
  res.json({ success: true });
});

app.post('/api/push/unsubscribe', authenticateToken, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ message: 'Subscription endpoint required' });
  }
  db.deletePushSubscription(req.userId, endpoint);
  res.json({ success: true });
});

// For testing push notifications manually
app.post('/api/push/test', authenticateToken, async (req, res) => {
  try {
    await pushService.sendNotification(req.userId, 'Test Notification 🔔', `Your ${appName} server is ready to notify you!`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Debug: send a fully-formed sample of a specific notification type to all devices.
app.post('/api/push/test/:type', authenticateToken, async (req, res) => {
  try {
    await notifications.sendSample(req.userId, req.params.type);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Client-reported booking success → fan out a "Spot Booked" notification to all
// devices (honours the user's scope preference: all bookings vs auto-book only).
app.post('/api/notify/booking-success', authenticateToken, async (req, res) => {
  try {
    const { eventId, className, groupName, instructorName, startAt, slots, source, gymId: bodyGymId } = req.body;
    // C3-19: the booking's OWN gym names the push. A gym the account is not
    // linked to is refused, never quietly replaced. Only a caller that sends
    // none (an out-of-date PWA) falls back to the ambient resolution.
    if (bodyGymId && !db.isGymLinked(req.userId, bodyGymId)) {
      return res.status(403).json({ message: 'That gym is not linked to this account.' });
    }
    await notifications.notify(req.userId, 'booking', {
      source: source || 'manual', eventId, className, groupName, instructorName, startAt, slots,
      gymId: bodyGymId || db.resolveActiveGymId(req.userId),
    });
    // Refresh the calendar feed shortly after a manual/quick booking.
    try { calendar.scheduleRefresh(req.userId); } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Client pushes its freshly-fetched bookings to keep the reminder cache warm (no extra CodexFit calls).
app.post('/api/bookings/sync', authenticateToken, (req, res) => {
  try {
    const { bookings } = req.body;
    // The client syncs the MERGED list, so this call is authoritative for every
    // linked gym: each row is filed under its own `gymId`, and a gym with no
    // rows left is cleared rather than left holding stale reminders.
    db.replaceBookingCache(
      req.userId,
      Array.isArray(bookings) ? bookings : [],
      db.getUserGyms(req.userId).map((g) => g.gym_id),
    );
    // Keep the calendar feed current the moment the client reports a change.
    try { calendar.regenerateSnapshot(req.userId); } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// AUTO-BOOK QUEUE MANAGEMENT
// -------------------------------------------------------------

// C5-3: the member's pending queue + cached bookings, in the shape the pure
// detector (competing-bookings.js) wants. Cross-gym on purpose; own user only.
function competingContextFor(userId) {
  return {
    queued: db.getPendingAutoBookingsAllGyms(userId).map(r => ({
      id: r.id, gymId: r.gym_id, eventId: r.event_id, startAt: r.start_at,
      durationMin: r.duration_min, className: r.class_name,
      groupName: r.group_name, instructorName: r.instructor_name,
      instructorImageUrl: r.instructor_image_url, locationName: r.location_name, studioName: r.studio_name,
    })),
    // booking_cache is client/poller-synced, so it can lag the gym slightly:
    // fine for a warning, which is all it feeds.
    booked: db.getBookingCacheAllGyms(userId).map(r => ({
      gymId: r.gym_id, eventId: r.event_id, startAt: r.start_at,
      durationMin: r.duration_min, className: r.class_name,
      groupName: r.group_name, instructorName: r.instructor_name,
      locationName: r.location_name, studioName: r.studio_name,
    })),
    opts: {
      zoneOf: (g) => getGymConfig(g)?.timezone,
      labelOf: (g) => getGymConfig(g)?.shortName || getGymConfig(g)?.name || null,
    },
  };
}

// U1-12: "does booking this class right now clash with something I already hold?"
// Asked by the client BEFORE a manual Book / Quick-Book, so the same confirmation
// as auto-book (U1-6) can precede every other modal. Read-only: nothing is
// inserted. The rule is competing-bookings.js's, cross-gym, own user only; the
// client never re-derives an overlap.
app.post('/api/overlap-check', authenticateToken, (req, res) => {
  const { eventId, startAt, durationMin, className, gymId: reqGymId } = req.body || {};
  if (!eventId || !startAt) {
    return res.status(400).json({ message: 'eventId and startAt are required' });
  }
  try {
    const gymId = reqGymId || req.headers['x-gym-id'] || null;
    const ctx = competingContextFor(req.userId);
    const targetGymId = gymId || db.resolveActiveGymId(req.userId);
    const warnings = competing.detectManualBookingOverlaps(
      { gymId: targetGymId, eventId, startAt, durationMin, className }, ctx.queued, ctx.booked, ctx.opts);
    res.json({ warnings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/auto-book', authenticateToken, (req, res) => {
  try {
    const gymId = req.query.gymId || (req.headers['x-gym-id'] ? undefined : 'all');
    // History is bounded: pending rows always come back; executed rows only for
    // the last 90 days and at most the 50 most recent (rows are id DESC).
    const historyCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    let keptHistory = 0;
    const bookings = db.getUserAutoBookings(req.userId, gymId).filter(b => {
      if (!b.executed_at) return true;
      const t = Date.parse(b.executed_at);
      if (Number.isFinite(t) && t < historyCutoff) return false;
      return ++keptHistory <= 50;
    });
    // C5-3: judged against the member's WHOLE queue + bookings, not just the
    // gym filter above, or a cross-gym overlap would vanish from a per-gym view.
    const ctx = competingContextFor(req.userId);
    const conflicts = competing.detectQueueConflicts(ctx.queued, ctx.booked, ctx.opts);
    // Parse preferences JSON string
    const formatted = bookings.map(b => ({
      ...b,
      preferences: JSON.parse(b.preferences),
      warnings: conflicts[b.id] || [],
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/auto-book', authenticateToken, bookingMutationLimiter, (req, res) => {
  const { eventId, studioId, className, instructorName, instructorImageUrl, studioName, locationName, startAt, preferences, skipImmediate, groupName, creditShortfall, releaseAt, durationMin, confirmOverlap, gymId: reqGymId } = req.body;
  if (!eventId || !preferences) {
    return res.status(400).json({ message: 'eventId and preferences are required' });
  }
  const gymId = reqGymId || req.headers['x-gym-id'] || null;
  try {
    const targetGymId = gymId || db.resolveActiveGymId(req.userId);
    const caps = getGymConfig(targetGymId)?.capabilities || {};
    const maxSpots = caps.selfBookingPolicy === 'one-per-class' ? 1 : Number(caps.maxSpotsPerClass);
    const requestedSpots = Math.max(1, Number(preferences.requiredCount) || 1);
    if (Number.isFinite(maxSpots) && maxSpots > 0 && requestedSpots > maxSpots) {
      return res.status(400).json({
        code: 'ATTENDEE_LIMIT_EXCEEDED',
        message: `This gym allows at most ${maxSpots} self spot per class.`,
      });
    }
    const pendingCount = db.countPendingAutoBookings(req.userId, gymId);
    if (pendingCount >= MAX_PENDING_AUTO_BOOKINGS_PER_GYM) {
      return res.status(429).json({ message: `Auto-book queue limit reached (${MAX_PENDING_AUTO_BOOKINGS_PER_GYM} pending entries). Please remove some entries before adding more.` });
    }
    // C5-3: competing bookings. An exact duplicate (same gym + event, already
    // pending) is rejected: a second entry can never help — at best a no-op, at
    // worst a double claim — and the client would otherwise announce success for
    // something that did nothing. Everything else (overlaps, already booked) is a
    // WARNING returned alongside the success: auto-book is speculative and a
    // member may deliberately queue two alternatives, so the server can't block it.
    const ctx = competingContextFor(req.userId);
    const warnings = competing.detectCompetingBookings(
      { gymId: targetGymId, eventId, startAt, durationMin, className }, ctx.queued, ctx.booked, ctx.opts);
    const dup = warnings.find(w => w.code === 'DUPLICATE_QUEUED');
    if (dup) {
      return res.status(409).json({ code: 'DUPLICATE_AUTO_BOOK', message: dup.message, warnings });
    }
    // U1-6: overlaps are still allowed, but only once the member has SEEN them.
    // Without `confirmOverlap: true` the request is refused with 409
    // OVERLAP_CONFIRM_REQUIRED and NOTHING is inserted — no row to delete if they
    // back out, no scheduler re-arm, no queue churn — and the client shows the
    // clashing classes and resubmits the same body with the flag. The rule itself
    // stays here (competing-bookings.js); the client never re-derives an overlap.
    if (warnings.length > 0 && confirmOverlap !== true) {
      return res.status(409).json({
        code: 'OVERLAP_CONFIRM_REQUIRED',
        message: warnings.length === 1
          ? warnings[0].message
          : `This class clashes with ${warnings.length} other classes you have queued or booked.`,
        warnings,
      });
    }

    // Capture the class's own release instant when the gym publishes one (WP-D8).
    // A per-class gym's release has no weekday rule to recompute it from later,
    // so if it isn't stored now it is gone.
    const id = db.addAutoBooking(req.userId, eventId, className, instructorName, studioName, locationName, startAt, preferences, studioId ?? null, groupName ?? null, releaseAt ?? null, gymId, instructorImageUrl ?? null, durationMin ?? null);

    // Warn (via push) if the user set this up without enough credits.
    if (creditShortfall && creditShortfall > 0) {
      notifications.notify(req.userId, 'creditWarning', {
        kind: 'autobook', startAt, groupName, className, instructorName, gymId,
        spots: preferences.requiredCount || 1, creditsShort: creditShortfall,
      });
    }

    // Check if the release window is already open; if so, trigger booking immediately in background
    // UNLESS skipImmediate is set (e.g., for forcing open classes to wait until next release window)
    if (!skipImmediate) {
      scheduler.checkAndRunImmediateBookings(req.userId);
    }
    // The wake clock is driven by the queue (layer I), and this class may release
    // sooner than whatever is currently armed — so re-arm rather than waiting for
    // the next dispatch to recompute it.
    scheduler.rearm();

    res.json({ id, success: true, warnings });
  } catch (err) {
    // A gym-ambiguous write is a client bug (the caller didn't name its gym),
    // not a server fault — say so with a 400 rather than a generic 500.
    res.status(/no gym specified/i.test(err.message) ? 400 : 500).json({ message: err.message });
  }
});

app.post('/api/simulate-release', authenticateToken, bookingMutationLimiter, (req, res) => {
  try {
    console.log(`[Server] Simulated release triggered by user ${req.userId}`);
    scheduler.runAllPendingBookings(req.userId);
    res.json({ success: true, message: 'Simulated release fired — check auto-book history shortly.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/auto-book/stream', authenticateTokenSSE, (req, res) => {
  // Server-Sent Events endpoint for real-time auto-book status updates
  const userId = req.userId;
  console.log(`[Server] SSE stream connected for user ${userId}`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Register this client
  scheduler.registerSSEClient(userId, res);

  // Handle disconnect
  req.on('close', () => {
    console.log(`[Server] SSE stream closed for user ${userId}`);
    scheduler.unregisterSSEClient(userId, res);
  });

  // Send a connection confirmation
  res.write(': SSE stream connected\n\n');
});

app.put('/api/auto-book/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  const { preferences } = req.body;
  if (!preferences) {
    return res.status(400).json({ message: 'preferences are required' });
  }
  try {
    const entry = db.getUserAutoBookings(req.userId, 'all').find((row) => Number(row.id) === id);
    const caps = entry ? (getGymConfig(entry.gym_id)?.capabilities || {}) : {};
    const maxSpots = caps.selfBookingPolicy === 'one-per-class' ? 1 : Number(caps.maxSpotsPerClass);
    const requestedSpots = Math.max(1, Number(preferences.requiredCount) || 1);
    if (Number.isFinite(maxSpots) && maxSpots > 0 && requestedSpots > maxSpots) {
      return res.status(400).json({
        code: 'ATTENDEE_LIMIT_EXCEEDED',
        message: `This gym allows at most ${maxSpots} self spot per class.`,
      });
    }
    db.updateAutoBookingPreferences(id, req.userId, preferences);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/auto-book/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  try {
    db.deleteAutoBooking(id, req.userId);
    // This may have been the only entry the wake clock was armed for (layer I).
    scheduler.rearm();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// AUTO-UPGRADE JOBS
// -------------------------------------------------------------

app.get('/api/auto-upgrade', authenticateToken, (req, res) => {
  try {
    const gymId = req.query.gymId || (req.headers['x-gym-id'] ? undefined : 'all');
    const upgrades = db.getUserAutoUpgrades(req.userId, gymId);
    const formatted = upgrades.map(u => ({
      ...u,
      preferences: JSON.parse(u.preferences)
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/auto-upgrade', authenticateToken, bookingMutationLimiter, (req, res) => {
  const { eventId, studioId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, groupName, creditShortfall, gymId: reqGymId } = req.body;
  if (eventId == null || bookingId == null || currentSlotId == null || !preferences) {
    return res.status(400).json({ message: 'Missing required auto-upgrade fields' });
  }
  const gymId = reqGymId || req.headers['x-gym-id'] || null;
  try {
    // Quota: cap active monitors per user
    const activeCount = db.countActiveAutoUpgrades(req.userId, gymId);
    if (activeCount >= MAX_ACTIVE_AUTO_UPGRADES_PER_GYM) {
      return res.status(429).json({ message: `Auto-upgrade monitor limit reached (${MAX_ACTIVE_AUTO_UPGRADES_PER_GYM} active monitors). Please cancel some before adding more.` });
    }

    // One live monitor per held seat. Matches on booking id OR event+slot (a re-booked
    // seat has a new booking id) and counts paused monitors too — the same set the
    // client list shows as "has a monitor".
    const live = db.getUserAutoUpgrades(req.userId, gymId).find(u =>
      ['active', 'paused_no_credits'].includes(u.status) &&
      (String(u.booking_id) === String(bookingId) ||
        (String(u.event_id) === String(eventId) && String(u.current_slot_id) === String(currentSlotId)))
    );
    if (live) {
      if (String(live.booking_id) !== String(bookingId)) db.relinkAutoUpgradeBooking(live.id, req.userId, bookingId);
      return res.status(409).json({ code: 'DUPLICATE_AUTO_UPGRADE', existingId: live.id, message: 'This spot already has an auto-upgrade monitor.' });
    }

    const id = db.addAutoUpgrade(req.userId, eventId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, studioId ?? null, groupName ?? null, gymId);

    // Warn (via push) if auto-upgrade is enabled without a spare credit to book the upgraded seat.
    if (creditShortfall && creditShortfall > 0) {
      notifications.notify(req.userId, 'creditWarning', {
        kind: 'autoupgrade', startAt, groupName, className, instructorName, gymId,
      });
    }

    res.json({ id, success: true });
  } catch (err) {
    // See POST /api/auto-book: an unnamed gym on a multi-gym account is a 400.
    res.status(/no gym specified/i.test(err.message) ? 400 : 500).json({ message: err.message });
  }
});

app.put('/api/auto-upgrade/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  const { preferences, bookingId } = req.body;
  if (!preferences) return res.status(400).json({ message: 'Missing preferences' });
  try {
    // Reset cutoffAttempted so the new prefs get a fresh attempt window
    const cleanPrefs = { ...preferences, cutoffAttempted: false };
    db.updateAutoUpgrade(id, req.userId, 'active', 'Preferences updated. Monitoring...', { preferences: cleanPrefs, bookingId: bookingId ?? undefined });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/auto-upgrade/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  try {
    db.deleteAutoUpgrade(id, req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// USER SETTINGS & STUDIO PREFERENCES
// -------------------------------------------------------------

app.get('/api/settings', authenticateToken, (req, res) => {
  try {
    const settings = db.getUserSettings(req.userId);
    res.json(settings || {});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/settings', authenticateToken, (req, res) => {
  try {
    // A PATCH of just the changed keys. The gym comes from `x-gym-id` context
    // and is only needed when the patch touches a gym-scoped key.
    db.setUserSettings(req.userId, req.body);
    // Calendar prefs (includeTentative / alarm) live in settings — republish on change.
    try { if (req.body && req.body.calendar) calendar.regenerateSnapshot(req.userId); } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    res.status(/no gym specified/i.test(err.message) ? 400 : 500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// CALENDAR FEED
// -------------------------------------------------------------

// Public-by-token feed. MUST be excluded from Cloudflare Access (see
// Documentation/CALENDAR_FEED_PLAN.md §7) — calendar clients can't pass Access auth.
app.get('/api/calendar/:token.ics', calendarFeedLimiter, (req, res) => {
  try {
    const token = req.params.token;
    const user = db.getUserByCalendarToken(token);
    if (!user) return res.status(410).type('text/plain').send('This calendar feed has been turned off.');

    const settings = db.getUserSettings(user.id) || {};
    if (!settings.calendar || !settings.calendar.enabled) {
      return res.status(410).type('text/plain').send('This calendar feed has been turned off.');
    }

    let snap = db.getCalendarSnapshot(user.id);
    if (!snap || !snap.ics) {
      calendar.regenerateSnapshot(user.id);
      snap = db.getCalendarSnapshot(user.id);
    }
    if (!snap || !snap.ics) return res.status(503).type('text/plain').send('Calendar not ready yet, try again shortly.');

    if (req.headers['if-none-match'] && req.headers['if-none-match'] === snap.etag) {
      return res.status(304).end();
    }

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="psycle.ics"');
    res.set('ETag', snap.etag);
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.send(snap.ics);
  } catch (err) {
    res.status(500).type('text/plain').send('Error generating calendar.');
  }
});

app.get('/api/calendar/status', authenticateToken, (req, res) => {
  try {
    const settings = db.getUserSettings(req.userId) || {};
    const cal = settings.calendar || {};
    const prefs = normalizeCalendarPrefs(cal);
    const token = db.getCalendarToken(req.userId);
    const snap = db.getCalendarSnapshot(req.userId);
    res.json({
      enabled: !!cal.enabled,
      ...prefs,
      // Legacy shape, derived, for older clients.
      includeTentative: prefs.includeWaitlists || prefs.includeAutoBook,
      // Gyms on a weekly release schedule (from gyms.config bookingWindow.kind).
      // The client shows "remind me when booking opens" only when this is non-empty.
      weeklyGyms: (db.getUserGymsPublic(req.userId) || [])
        .filter((g) => { const cfg = getGymConfig(g.gym_id); return cfg && isRollingWeekly(cfg); })
        .map((g) => ({ id: g.gym_id, name: (getGymConfig(g.gym_id).shortName || g.gym_name || g.gym_id) })),
      links: token ? calendar.buildLinks(token) : null,
      generatedAt: snap ? snap.generated_at : null,
      classCount: snap ? snap.class_count : 0,
      // Which gyms feed this calendar. The feed is account-level, so the UI has
      // to be able to say "every class from X and Y" — otherwise a user with two
      // gyms has no way to tell whether the single URL really covers both.
      gyms: (db.getUserGymsPublic(req.userId) || []).map((g) => ({ id: g.gym_id, name: g.gym_name || g.gym_id })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/calendar/enable', authenticateToken, (req, res) => {
  try {
    const token = calendar.ensureToken(req.userId);
    // C3-14: patch ONLY the account-scoped `calendar` key. Writing back the whole
    // merged blob dragged the default gym's gym-scoped keys along, which a
    // multi-gym account rightly refuses to place.
    const cal = applyCalendarPatch((db.getUserSettings(req.userId) || {}).calendar || {}, req.body);
    cal.enabled = true;
    db.setUserSettings(req.userId, { calendar: cal });
    calendar.regenerateSnapshot(req.userId);
    // Warm the location-address cache + pull fresh bookings/waitlists shortly after,
    // so the feed gains addresses and the latest classes without waiting for the cycle.
    try { calendar.scheduleRefresh(req.userId, 2000); } catch (_) {}
    res.json({ success: true, links: calendar.buildLinks(token) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/calendar/disable', authenticateToken, (req, res) => {
  try {
    const cal = { ...((db.getUserSettings(req.userId) || {}).calendar || {}), enabled: false };
    db.setUserSettings(req.userId, { calendar: cal });
    // Revoke the token so the public URL stops working (device subscription goes stale).
    db.setCalendarToken(req.userId, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/calendar/rotate', authenticateToken, (req, res) => {
  try {
    const token = calendar.rotateToken(req.userId);
    calendar.regenerateSnapshot(req.userId);
    res.json({ success: true, links: calendar.buildLinks(token) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/calendar/refresh', authenticateToken, (req, res) => {
  try {
    const settings = db.getUserSettings(req.userId);
    const cal = settings.calendar || {};
    if (!cal.enabled) return res.status(400).json({ message: 'Calendar feed is not enabled.' });
    calendar.scheduleRefresh(req.userId, 5000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/studio-preferences', authenticateToken, (req, res) => {
  try {
    const prefs = db.getStudioPreferences(req.userId);
    const formatted = {};
    prefs.forEach(p => {
      formatted[p.studio_id] = JSON.parse(p.preferences);
    });
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/studio-preferences/:id', authenticateToken, (req, res) => {
  // MarianaTek provider ids can be opaque strings; preserve them exactly.
  const studioId = req.params.id;
  const { preferences } = req.body;
  try {
    // The gym comes from the request's `x-gym-id` context (the client names it
    // on every spot-map save); a multi-gym account with none is a 400, not a
    // silent write to whichever gym resolved.
    db.setStudioPreference(req.userId, studioId, preferences);
    res.json({ success: true });
  } catch (err) {
    res.status(/no gym specified/i.test(err.message) ? 400 : 500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// CONFIG EXPORT & IMPORT
// -------------------------------------------------------------

app.get('/api/config/export', authenticateToken, (req, res) => {
  try {
    const settings = db.getUserSettings(req.userId) || {};
    const gymIds = db.getUserGyms(req.userId).map((g) => g.gym_id).filter(Boolean);
    // C3-16: settings split by scope, each gym's block naming its gym. The merged
    // `psycleSettings` below cannot say which gym a gym-scoped key belongs to.
    const accountSettings = db.getAccountSettings(req.userId);
    const gymSettings = gymIds.map((gymId) => ({ gymId, settings: db.getGymSettings(req.userId, gymId) }));

    // EVERY linked gym. Both of these are keyed by PROVIDER ids, which are
    // unique only within one gym, so a backup that captured a single gym would
    // restore one gym's spot maps over another's identically-numbered studios.
    const formattedPrefs = {};      // legacy shape: { studioId: prefs } — one gym only
    const studioPreferences = [];   // gym-qualified, what an import should read
    const formattedBookings = [];
    for (const gymId of gymIds) {
      db.runWithGymContext(req.userId, gymId, () => {
        for (const p of db.getStudioPreferences(req.userId) || []) {
          const prefs = JSON.parse(p.preferences);
          studioPreferences.push({ gymId, studioId: p.studio_id, preferences: prefs });
          if (gymIds.length === 1) formattedPrefs[p.studio_id] = prefs;
        }
        for (const b of db.getUserAutoBookings(req.userId, gymId) || []) {
          formattedBookings.push({
            gymId,
            eventId: b.event_id,
            className: b.class_name,
            instructorName: b.instructor_name,
            studioName: b.studio_name,
            locationName: b.location_name,
            startAt: b.start_at,
            preferences: JSON.parse(b.preferences),
          });
        }
      });
    }

    res.json({
      version: '1.2.0',
      accountSettings,
      gymSettings,
      // Merged blob, kept only so an older build can still read the file. An
      // import prefers accountSettings/gymSettings above.
      psycleSettings: settings,
      // Kept for single-gym accounts so an export stays readable by an older
      // build; `studioPreferences` is the one an import prefers.
      psycleStudioPreferences: formattedPrefs,
      studioPreferences,
      psycleAutoBookings: formattedBookings,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/config/import', authenticateToken, (req, res) => {
  const { psycleSettings, accountSettings, gymSettings, psycleStudioPreferences, studioPreferences, psycleAutoBookings } = req.body;
  const skipped = []; // human-readable notes on anything not restored
  try {
    const linkedIds = db.getUserGyms(req.userId).map((g) => g.gym_id).filter(Boolean);
    if (accountSettings || Array.isArray(gymSettings)) {
      // New format: account keys, then each gym block onto ITS OWN gym.
      if (accountSettings && Object.keys(accountSettings).length) {
        db.setUserSettings(req.userId, db.splitSettingsByScope(accountSettings).account);
      }
      for (const block of (Array.isArray(gymSettings) ? gymSettings : [])) {
        if (!block || !block.gymId || !block.settings) continue;
        if (!linkedIds.includes(block.gymId)) {
          skipped.push(`Settings for ${block.gymId} were skipped: that gym is not linked to this account.`);
          continue;
        }
        const gymKeys = db.splitSettingsByScope(block.settings).gym;
        if (Object.keys(gymKeys).length) db.setUserSettings(req.userId, gymKeys, block.gymId);
      }
    } else if (psycleSettings) {
      // Old flat blob: account keys are unambiguous. Its gym keys carry no gym, so
      // they can only go to the account's sole gym; with several, skip and say so.
      const { account, gym } = db.splitSettingsByScope(psycleSettings);
      if (Object.keys(account).length) db.setUserSettings(req.userId, account);
      const gymKeyNames = Object.keys(gym);
      if (gymKeyNames.length) {
        if (linkedIds.length === 1) {
          db.setUserSettings(req.userId, gym, linkedIds[0]);
        } else {
          skipped.push(`Per-gym settings (${gymKeyNames.join(', ')}) were skipped: this backup does not say which gym they belong to and your account has ${linkedIds.length} linked gyms. Export a fresh backup to include per-gym settings.`);
        }
      }
    }

    // Prefer the gym-qualified list. The legacy `{ studioId: prefs }` object
    // carries no gym, so it can only be restored unambiguously onto a
    // single-gym account — `setStudioPreference` refuses to guess otherwise
    // rather than writing one gym's map onto another's studio.
    if (Array.isArray(studioPreferences)) {
      studioPreferences.forEach((p) => {
        if (p.gymId && !linkedIds.includes(p.gymId)) { skipped.push(`Spot map for studio ${p.studioId} was skipped: ${p.gymId} is not linked.`); return; }
        db.setStudioPreference(req.userId, p.studioId, p.preferences, p.gymId || null);
      });
    } else if (psycleStudioPreferences && Object.keys(psycleStudioPreferences).length) {
      if (linkedIds.length > 1) {
        skipped.push('Studio spot maps were skipped: this backup does not say which gym they belong to. Export a fresh backup.');
      } else {
        Object.entries(psycleStudioPreferences).forEach(([studioId, prefs]) => {
          db.setStudioPreference(req.userId, parseInt(studioId), prefs);
        });
      }
    }

    if (psycleAutoBookings && Array.isArray(psycleAutoBookings)) {
      psycleAutoBookings.forEach(b => {
        if (!b.gymId && linkedIds.length > 1) { skipped.push(`Auto-book entry for ${b.className || b.eventId} was skipped: no gym recorded and several are linked.`); return; }
        if (b.gymId && !linkedIds.includes(b.gymId)) { skipped.push(`Auto-book entry for ${b.className || b.eventId} was skipped: ${b.gymId} is not linked.`); return; }
        // Duplicate check is per gym: the same provider event id can legitimately
        // exist in two gyms' queues.
        const existing = db.getUserAutoBookings(req.userId, b.gymId || undefined)
          .filter(x => x.event_id === b.eventId && x.executed_at === null);
        if (existing.length === 0) {
          db.addAutoBooking(
            req.userId,
            b.eventId,
            b.className,
            b.instructorName,
            b.studioName,
            b.locationName,
            b.startAt,
            b.preferences,
            null,
            null,
            null,
            b.gymId || null,
          );
        }
      });
    }
    res.json({ success: true, skipped });
  } catch (err) {
    res.status(/no gym specified/i.test(err.message) ? 400 : 500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// SPA FALLBACK
// -------------------------------------------------------------

// U4-19: the client uses clean paths (/, /timetable, /bookings, /auto-book, /credits,
// /settings[/:section]). ONLY those get index.html; this is an allowlist, never a
// catch-all, so a mistyped /api/* can never come back as HTML. Keep in step with
// client/src/url-state.js TAB_TO_PATH.
const SPA_PATH_RE = /^\/(?:index\.html|timetable|bookings|auto-book|credits|settings(?:\/[a-z0-9][a-z0-9_-]{0,79})?)\/?$/i;

if (process.env.NODE_ENV === 'production') {
  app.get(SPA_PATH_RE, (req, res) => {
    sendTemplated(path.join(PUBLIC_DIR, 'index.html'), res, 'text/html');
  });
}

// Unknown /api/* is a JSON 404 in every mode (never the SPA shell).
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
});

// Anything else unmatched (production): plain 404.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
}

// Start Server
app.listen(PORT, () => {
  console.log(`[Server] Express server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode.`);
  
  // Start schedulers
  scheduler.init();
  poller.init();
  calendar.init();
});
