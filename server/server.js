require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const { handleLogin, authenticateToken, authenticateTokenSSE, triggerAutoRelogin } = require('./auth');
const pushService = require('./push');
const notifications = require('./notifications');
const scheduler = require('./scheduler');
const poller = require('./poller');
const calendar = require('./calendar');
const adminRouter = require('./admin');
const config = require('./config');
const { appName } = config;

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
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ? String(req.userId) : ipKeyGenerator(req.ip),
  message: { message: 'Too many requests — please slow down.' },
  skip: (req) => process.env.NODE_ENV !== 'production', // no limits in dev
});

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

app.get('/api/health', (req, res) => {
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

  // Surface the next armed auto-book release so you can confirm a Monday window
  // is actually scheduled (not just that the scheduler process is ticking).
  const nextRelease = db.getKV('scheduler_next_release') || null;

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    time: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    nextReleaseAt: nextRelease,
    services,
  });
});

// -------------------------------------------------------------
// TEMPLATED STATIC FILES
// In production, intercept specific static files that contain the app name
// and replace the default "Psycle Assistant" with the configured value.
// This lets the same built client serve under a different name without a
// rebuild. Files are read once and cached; the replace is a no-op when the
// configured name equals the default.
// -------------------------------------------------------------

const fs = require('fs');
const fileCache = {};

function sendTemplated(filePath, res, contentType) {
  if (!fileCache[filePath]) {
    try {
      fileCache[filePath] = fs.readFileSync(filePath, 'utf8');
    } catch {
      return res.status(404).send('Not found');
    }
  }
  let content = fileCache[filePath];
  if (config.appName !== 'Psycle Assistant') {
    content = content.replaceAll('Psycle Assistant', config.appName);
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
    sendTemplated(path.join(__dirname, 'public', 'index.html'), res, 'text/html');
  });
  app.get('/manifest.json', (req, res) => {
    sendTemplated(path.join(__dirname, 'public', 'manifest.json'), res, 'application/manifest+json');
  });
  app.get('/sw.js', (req, res) => {
    sendTemplated(path.join(__dirname, 'public', 'sw.js'), res, 'application/javascript');
  });
  app.use(express.static(path.join(__dirname, 'public')));
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
    const { eventId, className, groupName, instructorName, startAt, slots, source } = req.body;
    await notifications.notify(req.userId, 'booking', {
      source: source || 'manual', eventId, className, groupName, instructorName, startAt, slots,
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
    db.replaceBookingCache(req.userId, Array.isArray(bookings) ? bookings : []);
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

app.get('/api/auto-book', authenticateToken, (req, res) => {
  try {
    const bookings = db.getUserAutoBookings(req.userId);
    // Parse preferences JSON string
    const formatted = bookings.map(b => ({
      ...b,
      preferences: JSON.parse(b.preferences)
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/auto-book', authenticateToken, bookingMutationLimiter, (req, res) => {
  const { eventId, studioId, className, instructorName, studioName, locationName, startAt, preferences, skipImmediate, groupName, creditShortfall } = req.body;
  if (!eventId || !preferences) {
    return res.status(400).json({ message: 'eventId and preferences are required' });
  }
  try {
    const pendingCount = db.countPendingAutoBookings(req.userId);
    if (pendingCount >= 15) {
      return res.status(429).json({ message: 'Auto-book queue limit reached (15 pending entries). Please remove some entries before adding more.' });
    }
    const id = db.addAutoBooking(req.userId, eventId, className, instructorName, studioName, locationName, startAt, preferences, studioId ?? null, groupName ?? null);

    // Warn (via push) if the user set this up without enough credits.
    if (creditShortfall && creditShortfall > 0) {
      notifications.notify(req.userId, 'creditWarning', {
        kind: 'autobook', startAt, groupName, className, instructorName,
        spots: preferences.requiredCount || 1, creditsShort: creditShortfall,
      });
    }

    // Check if the release window is already open; if so, trigger booking immediately in background
    // UNLESS skipImmediate is set (e.g., for forcing open classes to wait until next release window)
    if (!skipImmediate) {
      scheduler.checkAndRunImmediateBookings(req.userId);
    }

    res.json({ id, success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    const upgrades = db.getUserAutoUpgrades(req.userId);
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
  const { eventId, studioId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, groupName, creditShortfall } = req.body;
  if (eventId == null || bookingId == null || currentSlotId == null || isNaN(Number(currentSlotId)) || !preferences) {
    return res.status(400).json({ message: 'Missing required auto-upgrade fields' });
  }
  try {
    // Quota: cap active monitors per user
    const activeCount = db.countActiveAutoUpgrades(req.userId);
    if (activeCount >= 10) {
      return res.status(429).json({ message: 'Auto-upgrade monitor limit reached (10 active monitors). Please cancel some before adding more.' });
    }

    // Check if an active auto-upgrade already exists for this booking
    const activeUpgrades = db.getUserAutoUpgrades(req.userId).filter(u => Number(u.booking_id) === Number(bookingId) && u.status === 'active');
    if (activeUpgrades.length > 0) {
      return res.status(400).json({ message: 'An active auto-upgrade monitor already exists for this booking.' });
    }

    const id = db.addAutoUpgrade(req.userId, eventId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, studioId ?? null, groupName ?? null);

    // Warn (via push) if auto-upgrade is enabled without a spare credit to book the upgraded seat.
    if (creditShortfall && creditShortfall > 0) {
      notifications.notify(req.userId, 'creditWarning', {
        kind: 'autoupgrade', startAt, groupName, className, instructorName,
      });
    }

    res.json({ id, success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/auto-upgrade/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  const { preferences } = req.body;
  if (!preferences) return res.status(400).json({ message: 'Missing preferences' });
  try {
    // Reset cutoffAttempted so the new prefs get a fresh attempt window
    const cleanPrefs = { ...preferences, cutoffAttempted: false };
    db.updateAutoUpgrade(id, req.userId, 'active', 'Preferences updated. Monitoring...', { preferences: cleanPrefs });
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
    db.setUserSettings(req.userId, req.body);
    // Calendar prefs (includeTentative / alarm) live in settings — republish on change.
    try { if (req.body && req.body.calendar) calendar.regenerateSnapshot(req.userId); } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    const token = db.getCalendarToken(req.userId);
    const snap = db.getCalendarSnapshot(req.userId);
    res.json({
      enabled: !!cal.enabled,
      includeTentative: !!cal.includeTentative,
      alarm: cal.alarm || 'none',
      links: token ? calendar.buildLinks(token) : null,
      generatedAt: snap ? snap.generated_at : null,
      classCount: snap ? snap.class_count : 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/calendar/enable', authenticateToken, (req, res) => {
  try {
    const token = calendar.ensureToken(req.userId);
    const settings = db.getUserSettings(req.userId) || {};
    settings.calendar = { ...(settings.calendar || {}), enabled: true };
    if (typeof req.body?.includeTentative === 'boolean') settings.calendar.includeTentative = req.body.includeTentative;
    if (typeof req.body?.alarm === 'string') settings.calendar.alarm = req.body.alarm;
    db.setUserSettings(req.userId, settings);
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
    const settings = db.getUserSettings(req.userId) || {};
    settings.calendar = { ...(settings.calendar || {}), enabled: false };
    db.setUserSettings(req.userId, settings);
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
  const studioId = parseInt(req.params.id);
  const { preferences } = req.body;
  try {
    db.setStudioPreference(req.userId, studioId, preferences);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// CONFIG EXPORT & IMPORT
// -------------------------------------------------------------

app.get('/api/config/export', authenticateToken, (req, res) => {
  try {
    const settings = db.getUserSettings(req.userId) || {};
    const studioPrefs = db.getStudioPreferences(req.userId) || [];
    const autoBookings = db.getUserAutoBookings(req.userId) || [];
    
    const formattedPrefs = {};
    studioPrefs.forEach(p => {
      formattedPrefs[p.studio_id] = JSON.parse(p.preferences);
    });

    const formattedBookings = autoBookings.map(b => ({
      eventId: b.event_id,
      className: b.class_name,
      instructorName: b.instructor_name,
      studioName: b.studio_name,
      locationName: b.location_name,
      startAt: b.start_at,
      preferences: JSON.parse(b.preferences)
    }));

    res.json({
      version: '1.0.0',
      psycleSettings: settings,
      psycleStudioPreferences: formattedPrefs,
      psycleAutoBookings: formattedBookings
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/config/import', authenticateToken, (req, res) => {
  const { psycleSettings, psycleStudioPreferences, psycleAutoBookings } = req.body;
  try {
    if (psycleSettings) {
      db.setUserSettings(req.userId, psycleSettings);
    }
    if (psycleStudioPreferences) {
      Object.entries(psycleStudioPreferences).forEach(([studioId, prefs]) => {
        db.setStudioPreference(req.userId, parseInt(studioId), prefs);
      });
    }
    if (psycleAutoBookings && Array.isArray(psycleAutoBookings)) {
      psycleAutoBookings.forEach(b => {
        // Avoid adding duplicate bookings by checking if event is already in queue
        const existing = db.getUserAutoBookings(req.userId).filter(x => x.event_id === b.eventId && x.executed_at === null);
        if (existing.length === 0) {
          db.addAutoBooking(
            req.userId,
            b.eventId,
            b.className,
            b.instructorName,
            b.studioName,
            b.locationName,
            b.startAt,
            b.preferences
          );
        }
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// CODEXFIT PROXY WITH AUTO-REAUTH INTERCEPTOR
// -------------------------------------------------------------

// Convenience wrapper: run a proxied CodexFit call and return parsed JSON + status.
async function proxyJson(userId, pathName, method, body) {
  const response = await proxyRequest(userId, pathName, method, body);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function proxyRequest(userId, pathName, method, body) {
  const user = db.getUserById(userId);
  if (!user || !user.jwt) {
    throw new Error('User has no active CodexFit session. Please log in.');
  }

  if (user.email === 'dev@psycle.com') {
    const { handleMockRequest } = require('./mock');
    return handleMockRequest(pathName, method, body);
  }

  const runCall = async (token) => {
    const url = `https://psycle.codexfit.com/api/v1/customer${pathName}`;
    const options = {
      method,
      headers: {
        'accept': 'application/json',
        'origin': 'https://psyclelondon.com',
        'referer': 'https://psyclelondon.com/',
        'x-organisation': '[object Object]',
        'authorization': `Bearer ${token}`
      }
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (body && Object.keys(body).length > 0) {
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
    }

    return fetch(url, options);
  };

  let response = await runCall(user.jwt);

  // If 401 Unauthorized, intercept and attempt automatic re-login once
  if (response.status === 401) {
    try {
      const newJwt = await triggerAutoRelogin(userId);
      response = await runCall(newJwt);
    } catch (err) {
      console.warn(`[Proxy] Auto-relogin failed for user ${userId}:`, err.message);
      // Notify client via push notification that they need to re-login
      pushService.sendNotification(userId, 'Session Expired ⚠️', 'Your Psycle session expired. Please open the app and log in again.');
      throw new Error('CodexFit session expired and could not be renewed. Please log in again.');
    }
  }

  return response;
}

app.all('/api/proxy/*', authenticateToken, proxyLimiter, async (req, res) => {
  const pathWithQuery = req.url.slice('/api/proxy'.length);
  const method = req.method;
  const body = req.body;

  // Stamp "last seen" on any client activity through the proxy.
  try { db.touchUserLastSeen(req.userId); } catch (_) {}

  try {
    const response = await proxyRequest(req.userId, pathWithQuery, method, body);
    const contentType = response.headers.get('content-type');

    // A booking/waitlist mutation in the web app → refresh the calendar feed ~1 min
    // later (debounced) so the change shows without waiting for the 3-hourly cycle.
    if (response.ok && (method === 'POST' || method === 'DELETE') && /^\/(bookings|waitlists)\b/.test(pathWithQuery)) {
      try { calendar.scheduleRefresh(req.userId); } catch (_) {}
    }

    res.status(response.status);

    if (contentType && contentType.includes('application/json')) {
      try {
        const data = await response.json();
        // Cache the full profile snapshot for the admin detail view (GET /profile only,
        // not /profile/metafields/* sub-paths).
        if (method === 'GET' && response.ok && /^\/profile(\?|$)/.test(pathWithQuery)) {
          try { db.cacheUserProfile(req.userId, data.data || data); } catch (_) {}
        }
        res.json(data);
      } catch {
        // CodexFit sometimes returns content-type: application/json with an
        // empty body (e.g. DELETE on a metafield). Parsing throws, which
        // would surface as a 500 to the client and break the mutation flow.
        // Send an empty object instead so the client can proceed.
        res.json({});
      }
    } else {
      const text = await response.text();
      if (text) {
        res.send(text);
      } else {
        // Empty body, non-JSON content-type — end the response cleanly.
        res.end();
      }
    }
  } catch (err) {
    console.error(`[Proxy Error] ${method} ${pathWithQuery}:`, err.message);
    const status = err.message.includes('log in again') ? 401 : 500;
    res.status(status).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// CART MANAGEMENT (CodexFit Cart Proxy)
// -------------------------------------------------------------


const { randomUUID } = require('crypto');

// Pull the cart "instance" UUID out of whatever shape add_bundle returns.
function extractInstance(data) {
  return (
    data?.instance || data?.uuid ||
    data?.cart?.instance || data?.cart?.uuid ||
    data?.data?.instance || data?.data?.uuid ||
    null
  );
}

// Add a bundle to the user's cart (kept for the legacy "open website cart" fallback).
app.post('/api/cart/add-bundle/:bundleId', authenticateToken, async (req, res) => {
  const { bundleId } = req.params;
  const { quantity } = req.body || {};
  const qty = quantity || 1;

  try {
    let lastCartData = null;
    for (let i = 0; i < qty; i++) {
      const addRes = await proxyRequest(req.userId, `/cart/add_bundle/${bundleId}`, 'POST', {});
      const addData = await addRes.json();
      console.log('[Cart] add_bundle response:', JSON.stringify(addData));
      if (!addRes.ok) {
        return res.status(addRes.status).json(addData);
      }
      lastCartData = addData;
    }

    const instanceId = extractInstance(lastCartData);
    res.json({ success: true, cart: lastCartData, instanceId });
  } catch (err) {
    console.error('[Cart] Add bundle error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// IN-APP CHECKOUT (no redirect to psyclelondon.com)
// -------------------------------------------------------------
// The whole transaction is driven server-side with the user's JWT, so the
// browser-specific Shopify cart instance is never needed. NOTE: 3-D Secure is
// NOT supported here — if the saved card requires authentication the off-session
// charge fails and we surface a graceful error (see BACKLOG: "In-app 3-D Secure").

// Step 1: add the bundle to a fresh cart (qty times) and list the customer's saved cards.
app.post('/api/cart/checkout/init/:bundleId', authenticateToken, async (req, res) => {
  const { bundleId } = req.params;
  const qty = Math.max(1, Math.min(10, parseInt(req.body?.quantity) || 1));
  const generatedInstance = randomUUID();

  try {
    let instance = generatedInstance;
    for (let i = 0; i < qty; i++) {
      const add = await proxyJson(req.userId, `/cart/add_bundle/${bundleId}`, 'POST', { instance });
      if (!add.ok) {
        return res.status(add.status).json({ message: add.data?.message || 'Failed to add bundle to cart' });
      }
      instance = extractInstance(add.data) || instance;
    }

    const pm = await proxyJson(req.userId, `/cart/get_payment_methods?instance=${instance}`, 'GET');
    if (!pm.ok || !pm.data?.success) {
      return res.status(pm.status || 502).json({ message: pm.data?.message || 'Could not load saved cards' });
    }

    res.json({ success: true, instance, methods: pm.data.methods || [] });
  } catch (err) {
    console.error('[Checkout] init error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Step 2: set the chosen card, place the order, and poll until Stripe settles.
app.post('/api/cart/checkout/confirm', authenticateToken, async (req, res) => {
  const { instance, paymentMethodId } = req.body || {};
  if (!instance || !paymentMethodId) {
    return res.status(400).json({ message: 'instance and paymentMethodId are required' });
  }

  try {
    const setPm = await proxyJson(req.userId, `/cart/set_payment_method/${paymentMethodId}`, 'POST', { instance });
    if (!setPm.ok || !setPm.data?.success) {
      return res.status(setPm.status || 502).json({ message: setPm.data?.message || 'Failed to set payment method' });
    }

    const checkout = await proxyJson(req.userId, '/cart/ajaxCheckoutProcess', 'POST', { instance });
    if (!checkout.ok || !checkout.data?.success) {
      return res.status(checkout.status || 502).json({ message: checkout.data?.message || 'Checkout failed' });
    }

    const orderId = checkout.data.order?.id;
    if (!orderId) {
      return res.status(502).json({ message: 'Order was created but no order ID was returned' });
    }

    // Poll the order. Off-session charge resolves to Paid, or fails (decline /
    // 3-D Secure required), or hangs in "Payment pending" past our window.
    const maxAttempts = 40; // ~40s
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ord = await proxyJson(req.userId, `/orders/${orderId}`, 'GET');
      const order = ord.data?.data;

      if (order?.status === 'Paid') {
        return res.json({ status: 'paid', orderId });
      }

      const payErr = order?.metadata?.payment_intent?.last_payment_error;
      if (payErr) {
        const needsAuth = payErr.code === 'authentication_required'
          || payErr.decline_code === 'authentication_required';
        return res.json({
          status: needsAuth ? 'requires_action' : 'failed',
          orderId,
          error: payErr.message || 'The card was declined.',
        });
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    // Never settled in our window — almost always a 3-D Secure challenge the
    // saved-card off-session flow can't complete.
    res.json({ status: 'requires_action', orderId, error: 'Payment requires authentication.' });
  } catch (err) {
    console.error('[Checkout] confirm error:', err.message);
    res.status(500).json({ message: err.message });
  }
});


// -------------------------------------------------------------
// SPA FALLBACK
// -------------------------------------------------------------

// Fallback index.html for SPA router in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    sendTemplated(path.join(__dirname, 'public', 'index.html'), res, 'text/html');
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
