// IndexedDB-based read-through cache for API GET responses
// Uses the same 'app-cache' DB as timetable.js but version 2, adding an 'api-responses' store.
// Raw IndexedDB (no idb library) — matches pattern in timetable.js.
//
// Exports a shared openDB() that creates BOTH stores at version 2.
// timetable.js should import openDB() instead of its own openCacheDB to
// avoid version-conflict blocking. Uses per-user key prefixes for isolation.

const DB_NAME = 'app-cache';
const DB_VERSION = 3;
const STORE = 'api-responses';
const SNAPSHOT_STORE = 'offline-snapshots';

// --- Per-user key prefix ---
// Set via setCacheKeyPrefix() after login (e.g. to currentUser.id).
//
// There is NO gym segment (C3-24). WP-G once derived one from a localStorage key,
// `appActiveGymId`, written by the old gym switcher; the switcher is gone and
// api.js removes that key on load, so the segment was always empty and
// `gymScopedKey()` returned the bare key — dead code that read as isolation.
// Gym isolation now lives where it is real: gym-specific responses carry the gym
// in their URL (`/api/credits?gymId=`) or are keyed by gym id at the call site,
// and the merged timetable is account-scoped on purpose (accountScopedKey below).
let keyPrefix = '';

export function setCacheKeyPrefix(prefix) {
  keyPrefix = prefix || '';
}

// Exported for the clear-by-pattern cursor scan below and for unit tests.
export function cacheKeyPrefix() {
  return keyPrefix;
}

// Scope a caller-owned cache key to the signed-in account. This is for merged
// data that deliberately contains every linked gym (for example the unified
// timetable). Anything that represents ONE gym must put that gym id in its own
// key at the call site.
export function accountScopedKey(base) {
  return keyPrefix ? `${base}:${keyPrefix}` : base;
}

function cacheKey(endpoint) {
  const prefix = cacheKeyPrefix();
  return prefix ? `${prefix}:${endpoint}` : endpoint;
}

// --- Database ---


/**
 * Open (or create) the shared IndexedDB database at version 2.
 * Creates both stores on first install or upgrade:
 *   - 'cache'          — used by timetable.js for raw timetable cache data
 *   - 'api-responses'  — used by this module for API GET response caching
 *
 * Handles onversionchange so that if another tab requests a higher version,
 * this connection closes cleanly and doesn't block the upgrade.
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Create 'cache' store if missing (used by timetable.js for raw timetable data)
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache');
      }
      // Create 'api-responses' store if missing (used by this module for API responses)
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Close this connection when another connection requests a version upgrade,
      // preventing the infamous "blocked" state.
      db.onversionchange = () => { db.close(); };
      resolve(db);
    };
    req.onerror = () => {
      reject(req.error);
    };
  });
}

// --- Internal IDB helpers ---

async function idbRead(key) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    return new Promise((resolve) => {
      req.onsuccess = () => {
        resolve(req.result || null);
        db.close();
      };
      req.onerror = () => {
        resolve(null);
        db.close();
      };
    });
  } catch (e) {
    return null;
  }
}

async function idbWrite(key, value) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(value, key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    // IDB unavailable or write failed — silently skip cache writes
  }
}

async function idbClearStore() {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE, 'cache', SNAPSHOT_STORE], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore('cache').clear();
    tx.objectStore(SNAPSHOT_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    // IDB unavailable — silently skip
  }
}

// Read-only offline snapshots are deliberately separate from the generic GET
// cache. Callers opt in with named, normalized responses; this makes it clear
// which personal data survives an offline relaunch and keeps credentials,
// tokens and calendar feed URLs out of durable storage.
const SENSITIVE_SNAPSHOT_KEY = /password|token|secret|credential|authori[sz]ation|cookie|session/i;
const CALENDAR_LINK_KEY = /^(links|webcal|webcals|https)$/i;

export function sanitiseOfflineSnapshot(value) {
  if (Array.isArray(value)) return value.map(sanitiseOfflineSnapshot);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  Object.entries(value).forEach(([key, child]) => {
    if (SENSITIVE_SNAPSHOT_KEY.test(key) || CALENDAR_LINK_KEY.test(key)) return;
    clean[key] = sanitiseOfflineSnapshot(child);
  });
  return clean;
}

function snapshotKey(name) {
  const prefix = cacheKeyPrefix();
  return prefix ? `${prefix}:snapshot:${name}` : null;
}

export async function setOfflineSnapshot(name, data) {
  const key = snapshotKey(name);
  if (!key) return;
  try {
    const db = await openDB();
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
    tx.objectStore(SNAPSHOT_STORE).put({ data: sanitiseOfflineSnapshot(data), savedAt: Date.now() }, key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (_) {
    // Offline snapshots improve resilience but are never required for a live response.
  }
}

export async function getOfflineSnapshot(name) {
  const key = snapshotKey(name);
  if (!key) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
    const req = tx.objectStore(SNAPSHOT_STORE).get(key);
    return await new Promise((resolve) => {
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (_) {
    return null;
  }
}

export async function deleteOfflineSnapshot(name) {
  const key = snapshotKey(name);
  if (!key) return;
  try {
    const db = await openDB();
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
    tx.objectStore(SNAPSHOT_STORE).delete(key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (_) {
    // Offline snapshots are best-effort and must never fail a live mutation.
  }
}

// --- Public API ---

/**
 * Read-through cache: try network first, fall back to cache on failure.
 * @param {string} endpoint - The full URL/path to fetch
 * @param {object} [options]
 * @param {number} [options.ttlMs=300000] - Time-to-live in milliseconds
 * @param {boolean} [options.allowStale=true] - Whether to return stale cached data when offline
 * @param {function} [options.fetcher] - Custom fetch function (e.g. apiFetch for auth headers)
 * @returns {Promise<{data: any, stale: boolean}>}
 */
export async function getCached(endpoint, options = {}) {
  const { ttlMs = 300000, allowStale = true, fetcher } = options;
  const doFetch = fetcher || window.fetch.bind(window);

  try {
    const res = await doFetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // On success: write to cache (failures silently ignored)
    try {
      await setCached(endpoint, data, ttlMs);
    } catch (writeErr) {
      console.warn(`[Cache] Failed to cache ${endpoint}:`, writeErr);
    }
    return { data, stale: false };
  } catch (err) {
    // On network failure: read from cache
    const cached = await readCached(endpoint);
    if (cached) {
      if (cached.stale && !allowStale) throw err;
      return cached;
    }
    // Not in cache — throw the original error
    throw err;
  }
}

/**
 * Stale-while-revalidate: serve cached immediately, refresh in background.
 * @param {string} endpoint - The full URL/path to fetch
 * @param {object} [options]
 * @param {number} [options.ttlMs=300000] - Time-to-live in milliseconds
 * @param {function} [options.fetcher] - Custom fetch function (e.g. apiFetch for auth headers)
 * @returns {Promise<{data: any, stale: boolean}>}
 */
export async function getCachedSWR(endpoint, options = {}) {
  const { ttlMs = 300000, fetcher } = options;
  const doFetch = fetcher || window.fetch.bind(window);

  // 1. Read from cache first
  const cached = await readCached(endpoint);

  if (cached) {
    if (!cached.stale) {
      // 2. Fresh cache — return immediately, no network call
      return cached;
    }

    // 3. Stale cache — return stale immediately AND fire background fetch
    performBackgroundFetch(endpoint, doFetch, ttlMs).catch(() => {});
    return cached;
  }

  // 4. Not cached — must do network fetch (blocking)
  return getCached(endpoint, { ttlMs, allowStale: true, fetcher });
}

/**
 * Background refresh helper for SWR strategy.
 * Fires a network request and updates cache on success.
 * Dispatches 'app-data-refreshed' event with { endpoint, data } on success.
 * Silently ignores failures.
 */
async function performBackgroundFetch(endpoint, doFetch, ttlMs) {
  try {
    const res = await doFetch(endpoint);
    if (!res.ok) return;
    const data = await res.json();
    try {
      await setCached(endpoint, data, ttlMs);
    } catch (writeErr) {
      console.warn(`[Cache] Background write failed for ${endpoint}:`, writeErr);
    }
    window.dispatchEvent(new CustomEvent('app-data-refreshed', {
      detail: { endpoint, data }
    }));
  } catch (err) {
    // Background refresh failed — stay stale, do nothing
    console.warn(`[Cache] Background refresh failed for ${endpoint}:`, err);
  }
}

/**
 * Write data to the API cache manually.
 * Silently ignores write failures (quota exceeded, private browsing, etc.).
 * @param {string} endpoint - Cache key (URL/path)
 * @param {any} data - The data to cache
 * @param {number} [ttlMs=300000] - Time-to-live in milliseconds
 */
export async function setCached(endpoint, data, ttlMs = 300000) {
  try {
    await idbWrite(cacheKey(endpoint), { data, ts: Date.now(), ttlMs });
  } catch (e) {
    console.warn(`[Cache] setCached failed for ${endpoint}:`, e);
  }
}

/**
 * Read from cache only (no network).
 * @param {string} endpoint - Cache key (URL/path)
 * @returns {Promise<{data: any, stale: boolean}|null>}
 */
export async function readCached(endpoint) {
  const entry = await idbRead(cacheKey(endpoint));
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  const stale = age > entry.ttlMs;
  return { data: entry.data, stale };
}

/**
 * Clear ALL cached API responses regardless of user prefix.
 * Does NOT touch the 'cache' store used by timetable.js.
 * Call on logout / account deletion to prevent cross-user data leakage.
 */
export async function clearApiCache() {
  await idbClearStore();
}

/**
 * Invalidate cached API responses whose key (after removing the user prefix)
 * starts with the given pattern. Call after a POST/PUT/DELETE mutation so the
 * next GET re-fetches fresh data instead of returning stale cache.
 *
 * If pattern is empty, clears ALL entries (same as clearApiCache).
 * When a user prefix is active, only the current user's matching entries are deleted.
 *
 * @param {string} pattern - Endpoint prefix to match (e.g. '/api/auto-book')
 */
export async function invalidateApiCache(pattern) {
  if (!pattern) {
    await clearApiCache();
    return;
  }

  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);

    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const key = cursor.key; // e.g. "user123@psycle-london:/api/auto-book"
          // Only delete entries for the current user AND gym
          const prefix = cacheKeyPrefix();
          const prefixStr = prefix ? prefix + ':' : '';
          if (key.startsWith(prefixStr)) {
            const unprefixed = key.slice(prefixStr.length);
            if (unprefixed.startsWith(pattern)) {
              cursor.delete();
            }
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    // IDB unavailable — silently ignore
  }
}
