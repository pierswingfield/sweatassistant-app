self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const notification = payload.notification || {};
    // The page persists its configured app name here. Before the page has
    // booted (or when no name was received), the configured static default is
    // the only available fallback because this worker may be fully offline.
    const titlePromise = notification.title
      ? Promise.resolve(notification.title)
      : configuredAppName().then((name) => `${name || '__APP_NAME__'} Alert`);
    
    const options = {
      body: notification.body || '',
      icon: notification.icon || '/icons/icon-192.png',
      badge: notification.badge || '/icons/icon-192.png',
      data: notification.data || {}
    };

    event.waitUntil(
      titlePromise.then((title) => self.registration.showNotification(title, options)).then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clientList => {
          for (const client of clientList) {
            client.postMessage({ type: 'PUSH_RECEIVED', payload });
          }
        });
      })
    );
  } catch (err) {
    console.error('[Service Worker] Error displaying push notification:', err);
  }
});

const APP_CONFIG_CACHE = 'app-config-v1';
const APP_CONFIG_KEY = new Request('/__app_config__');

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SET_APP_NAME' || typeof event.data.appName !== 'string') return;
  event.waitUntil(caches.open(APP_CONFIG_CACHE).then((cache) =>
    cache.put(APP_CONFIG_KEY, new Response(JSON.stringify({ appName: event.data.appName }), {
      headers: { 'Content-Type': 'application/json' },
    }))));
});

async function configuredAppName() {
  try {
    const cache = await caches.open(APP_CONFIG_CACHE);
    const response = await cache.match(APP_CONFIG_KEY);
    if (!response) return null;
    const value = await response.json();
    return typeof value.appName === 'string' && value.appName ? value.appName : null;
  } catch (_) {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Handle clicking on the notification - focus or open PWA window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window of this app is already open, focus it and ask it to go to My Bookings.
      // (U4-19: the app lives at clean paths now, so any same-origin window qualifies; the old
      // check for pathname === '/' would miss /timetable etc. and open a second window.)
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus().then(c => {
            (c || client).postMessage({ type: 'NAVIGATE', path: '/bookings' });
          });
        }
      }
      // Otherwise, open a new window
      if (clients.openWindow) {
        return clients.openWindow('/bookings');
      }
    })
  );
});

// ─── Cache config ───────────────────────────────────────────────────────────

// C7-2: the cache name used to be hand-versioned — a
// forgotten bump meant a rebuilt client kept serving the OLD cached shell/JS
// forever, because `activate` only ever deletes caches NOT in its own
// whitelist, and an unbumped name is trivially "in" it. `__BUILD_STAMP__` is
// replaced by the `stampServiceWorker` Vite plugin (vite.config.js) with a
// unique per-build token when this file is copied into `dist/` — every build
// is now its own cache generation with no human in the loop. In `npm run dev`
// (vite serves this file from `public/` unprocessed, never through the
// build) the placeholder is left literal, which is still a perfectly valid,
// stable string — dev doesn't need per-build invalidation.
//
// Gym-neutral prefix: this product serves more than one gym brand.
const BUILD_STAMP = '__BUILD_STAMP__';
const CACHE_PREFIX = 'app-cache';
const CACHE_NAME = `${CACHE_PREFIX}-${BUILD_STAMP}`;
const ASSETS_CACHE_NAME = `${CACHE_PREFIX}-assets-${BUILD_STAMP}`;
// F-15 proxy images are immutable (their source URL hash is in `v=`). Keep a
// small browser-local copy as the fastest tier; the server's `/data` cache is
// the durable, bounded source of truth.
const IMAGES_CACHE_NAME = 'app-images-v2';
const IMAGES_MAX_ENTRIES = 160;
// Vite replaces the token only in dist/sw.js. In dev it is deliberately an
// invalid JSON string, which yields an empty extra list while retaining a
// runnable worker.
const PRECACHE_ASSETS = (() => {
  try { return JSON.parse('__PRECACHE_ASSETS_JSON__'); } catch (_) { return []; }
})();

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-128.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  ...PRECACHE_ASSETS
];

// ─── Install: precache shell + skip waiting ─────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate: purge stale caches, claim clients ────────────────────────────

// Whitelist, not prefix match: anything that isn't THIS build's exact two
// cache names is deleted, which covers every previous stamped build (and any
// older naming scheme) on the first activate after a version bump.
const CACHE_WHITELIST = [CACHE_NAME, ASSETS_CACHE_NAME, IMAGES_CACHE_NAME];

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (!CACHE_WHITELIST.includes(key)) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── Fetch strategies ───────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Passthrough conditions (never intercepted) ───────────────────────────

  // Only cache GET requests
  if (request.method !== 'GET') return;

  // Range requests (e.g. audio/video partials) — pass through
  if (request.headers.get('range')) return;

  // Same-origin instructor photos are public, immutable WebP responses. This
  // must precede the general /api/ bypass below: unlike JSON API reads, these
  // are safe to cache and a browser-cache hit avoids even a local server hop.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/instructor-photo/')) {
    event.respondWith(
      caches.open(IMAGES_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.status === 200) {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          if (keys.length > IMAGES_MAX_ENTRIES) {
            await Promise.all(keys.slice(0, keys.length - IMAGES_MAX_ENTRIES).map((key) => cache.delete(key)));
          }
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // API calls — handled by IndexedDB layer in the client; never cache
  if (url.pathname.startsWith('/api/')) return;

  // No cross-origin provider images should remain after F-15. Let any other
  // third-party image use normal browser behaviour rather than caching opaque
  // responses whose status and size cannot be inspected.
  if (url.origin !== self.location.origin) {
    return; // everything else cross-origin: browser default
  }

  // ── Navigation requests: network-first, fallback to /index.html ─────────

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        // Cache the page response for future offline access
        // U4-19: every app path serves the same shell, so keep ONE copy under the shell key
        // (no per-URL growth for /settings/x or ?filters) and never cache an error page.
        // /admin is its own page, not the app shell: never let it overwrite the shell copy.
        if (response.ok && !/^\/admin(\/|$)/.test(url.pathname)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone));
        }
        return response;
      }).catch(() => {
        // Offline: serve the SPA shell so client-side path routing still works
        return caches.match('/index.html', { ignoreSearch: true });
      })
    );
    return;
  }

  // ── Immutable / content-hashed assets: cache-first ─────────────────────
  //
  // Vite outputs content-hashed files under /assets/ (JS chunks, CSS).
  // Icons, fonts, and images are also safe to cache indefinitely.
  //
  // Strategy: cache hit → return immediately.
  //           cache miss → fetch from network, store in separate assets
  //                        cache, then return.

  const isImmutableAsset =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/gyms/') ||
    url.pathname === '/manifest.json' ||
    /\.(woff2?|ttf)$/i.test(url.pathname) ||
    /\.(png|jpe?g|svg|webp|gif|avif)$/i.test(url.pathname);

  if (isImmutableAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(ASSETS_CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // ── Everything else (same-origin GET, not nav, not immutable): network-first ─

  event.respondWith(
    fetch(request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});
