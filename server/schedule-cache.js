// Shared, user-agnostic cache for provider reads (WP — 2026-09-14).
//
// WHY THIS EXISTS
// ---------------
// The timetable was slow on EVERY load, including the second, because nothing
// cached it server-side: each user's each visit paid a full provider round
// trip, and a merged multi-gym view paid one per gym. A client cache cannot fix
// that — it is per browser, so the first load after any sign-in, new device or
// cache clear is still cold, and two users looking at the same Tuesday both pay
// full price for identical data.
//
// THE KEY INSIGHT: a gym's schedule is not user-specific. The classes, times,
// instructors, studios and occupancy are the same for everyone. What IS
// user-specific is layered on afterwards — `releaseAt` depends on the member's
// own booking-window tier, and booked/waitlisted state depends on the account.
// So the cache stores the SHARED half and the route stamps the personal half
// per request. Caching the stamped result instead would serve one member's
// booking window to another, which is a correctness bug, not a staleness one.
//
// SEMANTICS (stale-while-revalidate)
//   fresh  → return immediately
//   stale  → return immediately AND refresh in the background
//   miss   → await the fetch
// Plus SINGLE-FLIGHT: concurrent callers for the same key share one in-flight
// provider call. That matters most at a release instant, when every queued user
// asks for the same day at the same second.
//
// Deliberately in-process: one container, no shared store, and a cache that
// survives a restart would be a new class of stale-data bug for a few seconds
// of saved latency. If this ever runs multi-instance, move it to SQLite or
// Redis — do not reach for a longer TTL to compensate.

const DEFAULT_TTL_MS = 60 * 1000;

function createCache() {

  const store = new Map();   // key -> { value, fetchedAt, ttlMs }
  const inFlight = new Map(); // key -> Promise

  const stats = { hits: 0, staleHits: 0, misses: 0, coalesced: 0, refreshes: 0, errors: 0 };

  function isFresh(entry, now) {
    return entry && (now - entry.fetchedAt) < entry.ttlMs;
  }

  /**
   * @param {string} key      Must include every input that changes the RESULT —
   *                          gym and date range at minimum. A key that omits one
   *                          serves another gym's Tuesday.
   * @param {() => Promise<any>} fetcher
   * @param {{ ttlMs?: number, force?: boolean }} [opts]
   */
  async function getOrFetch(key, fetcher, opts = {}) {
    const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    const now = Date.now();
    const entry = store.get(key);

    if (opts.force) {
      stats.misses++;
      return single(key, fetcher, ttlMs);
    }

    if (isFresh(entry, now)) {
      stats.hits++;
      return entry.value;
    }

    // Beyond the usable-stale window the entry is too old to serve blindly: wait
    // for the provider, but single() still falls back to it if the fetch fails
    // (stale-if-error).
    if (entry && opts.maxStaleMs && (now - entry.fetchedAt) > entry.ttlMs + opts.maxStaleMs) {
      stats.misses++;
      return single(key, fetcher, ttlMs);
    }

    if (entry) {
      // Stale but usable: answer now, refresh behind the request. The user sees a
      // fast page with data that is at most one TTL old, instead of waiting for
      // the provider to decide how slow it feels today.
      stats.staleHits++;
      if (!inFlight.has(key)) {
        stats.refreshes++;
        single(key, fetcher, ttlMs).catch(() => {});
      }
      return entry.value;
    }

    stats.misses++;
    return single(key, fetcher, ttlMs);
  }

  function single(key, fetcher, ttlMs) {
    const existing = inFlight.get(key);
    if (existing) {
      stats.coalesced++;
      return existing;
    }
    const p = (async () => {
      try {
        const value = await fetcher();
        store.set(key, { value, fetchedAt: Date.now(), ttlMs });
        return value;
      } catch (err) {
        stats.errors++;
        // A failed refresh must NOT evict a usable stale entry — that turns a
        // provider blip into an empty timetable for everyone.
        const stale = store.get(key);
        if (stale) return stale.value;
        throw err;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  /** Drop cached entries whose key starts with `prefix` (e.g. one gym's). */
  function invalidate(prefix) {
    let n = 0;
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) { store.delete(key); n++; }
    }
    return n;
  }

  function getStats() {
    const total = stats.hits + stats.staleHits + stats.misses;
    return {
      ...stats,
      entries: store.size,
      inFlight: inFlight.size,
      hitRate: total ? Number(((stats.hits + stats.staleHits) / total).toFixed(3)) : null,
    };
  }

  return { getOrFetch, invalidate, getStats };
}

const shared = createCache();

module.exports = { ...shared, createCache, DEFAULT_TTL_MS };
