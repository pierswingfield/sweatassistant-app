self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const notification = payload.notification || {};
    const title = notification.title || 'Sweat Assistant Alert';
    
    const options = {
      body: notification.body || '',
      icon: notification.icon || '/icons/icon-192.png',
      badge: notification.badge || '/icons/icon-192.png',
      data: notification.data || {}
    };

    event.waitUntil(
      self.registration.showNotification(title, options).then(() => {
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Handle clicking on the notification - focus or open PWA window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (new URL(client.url).pathname === '/' && 'focus' in client) {
          return client.focus().then(c => {
            c.postMessage({ type: 'NAVIGATE', hash: '#my-bookings' });
          });
        }
      }
      // Otherwise, open a new window
      if (clients.openWindow) {
        return clients.openWindow('/#my-bookings');
      }
    })
  );
});

// ─── Cache config ───────────────────────────────────────────────────────────

// C7-2: the cache name used to be hand-versioned ('psycle-cache-v2') — a
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
// Gym-neutral prefix ('sweat-cache', not 'psycle-cache'): this product now
// serves more than one gym brand, and the cache name should say so.
const BUILD_STAMP = '__BUILD_STAMP__';
const CACHE_PREFIX = 'sweat-cache';
const CACHE_NAME = `${CACHE_PREFIX}-${BUILD_STAMP}`;
const ASSETS_CACHE_NAME = `${CACHE_PREFIX}-assets-${BUILD_STAMP}`;

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-128.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
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
// cache names is deleted. That already covers every previous stamped build
// AND the legacy hand-versioned names ('psycle-cache-v2' / 'psycle-assets-v2')
// — neither is in this whitelist, so an existing install upgrading to the
// stamped scheme cleans its old cache on the very first activate, same as any
// other version bump.
const CACHE_WHITELIST = [CACHE_NAME, ASSETS_CACHE_NAME];

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

  // API calls — handled by IndexedDB layer in the client; never cache
  if (url.pathname.startsWith('/api/')) return;

  // Only cache GET requests
  if (request.method !== 'GET') return;

  // Range requests (e.g. audio/video partials) — pass through
  if (request.headers.get('range')) return;

  // Cross-origin requests — let the browser handle natively
  if (url.origin !== self.location.origin) return;

  // ── Navigation requests: network-first, fallback to /index.html ─────────

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        // Cache the page response for future offline access
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => {
        // Offline: serve the SPA shell so client-side hash routing still works
        return caches.match('/index.html');
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
    url.pathname === '/manifest.json' ||
    /\.(woff2?|ttf)$/i.test(url.pathname) ||
    /\.(png|jpe?g|svg|webp|gif)$/i.test(url.pathname);

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
