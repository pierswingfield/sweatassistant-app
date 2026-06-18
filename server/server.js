require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { handleLogin, authenticateToken, authenticateTokenSSE, triggerAutoRelogin } = require('./auth');
const pushService = require('./push');
const notifications = require('./notifications');
const scheduler = require('./scheduler');
const poller = require('./poller');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serves the client SPA files in production Docker container
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'public')));
}

// -------------------------------------------------------------
// BFF AUTHENTICATION
// -------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
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
    await pushService.sendNotification(req.userId, 'Test Notification 🔔', 'Your Psycle server is ready to notify you!');
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

app.post('/api/auto-book', authenticateToken, (req, res) => {
  const { eventId, studioId, className, instructorName, studioName, locationName, startAt, preferences, skipImmediate, groupName, creditShortfall } = req.body;
  if (!eventId || !preferences) {
    return res.status(400).json({ message: 'eventId and preferences are required' });
  }
  try {
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

app.post('/api/simulate-release', authenticateToken, (req, res) => {
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

app.post('/api/auto-upgrade', authenticateToken, (req, res) => {
  const { eventId, studioId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, groupName, creditShortfall } = req.body;
  if (eventId == null || bookingId == null || currentSlotId == null || isNaN(Number(currentSlotId)) || !preferences) {
    return res.status(400).json({ message: 'Missing required auto-upgrade fields' });
  }
  try {
    // Check if an active auto-upgrade already exists for this event
    const activeUpgrades = db.getUserAutoUpgrades(req.userId).filter(u => u.event_id === eventId && u.status === 'active');
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
    res.json({ success: true });
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

    if (['POST', 'PUT', 'DELETE'].includes(method) && body && Object.keys(body).length > 0) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
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

app.all('/api/proxy/*', authenticateToken, async (req, res) => {
  const pathWithQuery = req.url.slice('/api/proxy'.length);
  const method = req.method;
  const body = req.body;

  try {
    const response = await proxyRequest(req.userId, pathWithQuery, method, body);
    const contentType = response.headers.get('content-type');
    
    res.status(response.status);

    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      res.send(text);
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

// Create or get a cart instance for the user
app.post('/api/cart/create', authenticateToken, async (req, res) => {
  try {
    const response = await proxyRequest(req.userId, '/cart', 'POST', {});
    const data = await response.json();
    // Store the instance ID in the user's settings for future use
    if (data.uuid || data.instance) {
      const settings = db.getUserSettings(req.userId) || {};
      settings.cartInstanceId = data.uuid || data.instance;
      db.setUserSettings(req.userId, settings);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add a bundle to the user's cart
app.post('/api/cart/add-bundle/:bundleId', authenticateToken, async (req, res) => {
  const { bundleId } = req.params;
  const { quantity } = req.body || {};
  const qty = quantity || 1;

  try {
    // Get or create cart instance
    let settings = db.getUserSettings(req.userId) || {};
    let instanceId = settings.cartInstanceId;

    if (!instanceId) {
      // Create a new cart instance
      const createRes = await proxyRequest(req.userId, '/cart', 'POST', {});
      const createData = await createRes.json();
      instanceId = createData.uuid || createData.instance;
      if (instanceId) {
        settings.cartInstanceId = instanceId;
        db.setUserSettings(req.userId, settings);
      }
    }

    // Add bundle to cart (repeat for quantity)
    let lastCartData = null;
    for (let i = 0; i < qty; i++) {
      const url = `/cart/add_bundle/${bundleId}${instanceId ? '?instance=' + instanceId : ''}`;
      const addRes = await proxyRequest(req.userId, url, 'GET', null);
      if (!addRes.ok) {
        const errData = await addRes.json().catch(() => ({}));
        // If instance expired, try creating a new one
        if (addRes.status === 404 || addRes.status === 410) {
          const newCreateRes = await proxyRequest(req.userId, '/cart', 'POST', {});
          const newCreateData = await newCreateRes.json();
          instanceId = newCreateData.uuid || newCreateData.instance;
          if (instanceId) {
            settings.cartInstanceId = instanceId;
            db.setUserSettings(req.userId, settings);
          }
          // Retry with new instance
          const retryUrl = `/cart/add_bundle/${bundleId}${instanceId ? '?instance=' + instanceId : ''}`;
          const retryRes = await proxyRequest(req.userId, retryUrl, 'GET', null);
          lastCartData = await retryRes.json();
        } else {
          return res.status(addRes.status).json(errData);
        }
      } else {
        lastCartData = await addRes.json();
      }
    }

    res.json({ success: true, cart: lastCartData, instanceId });
  } catch (err) {
    console.error('[Cart] Add bundle error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Get current cart
app.get('/api/cart', authenticateToken, async (req, res) => {
  try {
    const settings = db.getUserSettings(req.userId) || {};
    const instanceId = settings.cartInstanceId;

    if (!instanceId) {
      return res.json({ items: [], total: 0 });
    }

    const url = `/cart?instance=${instanceId}`;
    const response = await proxyRequest(req.userId, url, 'GET', null);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -------------------------------------------------------------
// SPA FALLBACK
// -------------------------------------------------------------

// Fallback index.html for SPA router in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

// Start Server
app.listen(PORT, () => {
  console.log(`[Server] Express server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode.`);
  
  // Start schedulers
  scheduler.init();
  poller.init();
});
