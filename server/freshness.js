// C2-5 (rebuilt 2026-10-06): provider freshness stamps for schedule-cache.
//
// A provider that implements the optional hook pair
//     hasFreshnessStamps() -> true
//     getFreshnessStamps(session?) -> Promise<{ [resource]: ISO string }>   (tiny, unauthenticated)
// gets its cache entries stamp-validated (see schedule-cache.js). Providers without the hook
// (MarianaTek) get NO stamp function, so their TTL behaviour is untouched. Nothing here names a
// platform: CodexFit's /heartbeat lives in providers/codexfit.js behind the hook (WP-D7).
//
// This module owns the heartbeat call's discipline: per-gym memo (a few seconds), single-flight,
// a timeout, and a short negative memo after a failure/429 so a throttled gym is not hammered.
// Every failure degrades to "no stamp" (callers fall back to TTL behaviour, never empty).
const MEMO_MS = 5 * 1000;
const FAIL_MEMO_MS = 15 * 1000;
const TIMEOUT_MS = 4 * 1000;

function createFreshness({ memoMs = MEMO_MS, failMemoMs = FAIL_MEMO_MS, timeoutMs = TIMEOUT_MS } = {}) {
  const memo = new Map();     // gymId -> { value: map|null, expires }
  const inflight = new Map(); // gymId -> Promise<map|null>
  const stats = { heartbeatChecks: 0, heartbeatFailures: 0 };

  function snapshot(gymId, provider, session) {
    const m = memo.get(gymId);
    if (m && m.expires > Date.now()) return Promise.resolve(m.value);
    if (inflight.has(gymId)) return inflight.get(gymId);
    const p = (async () => {
      stats.heartbeatChecks++;
      let timer;
      try {
        const value = await Promise.race([
          provider.getFreshnessStamps(session),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('heartbeat timeout')), timeoutMs); }),
        ]);
        const ok = value && typeof value === 'object';
        if (!ok) stats.heartbeatFailures++;
        memo.set(gymId, { value: ok ? value : null, expires: Date.now() + (ok ? memoMs : failMemoMs) });
        return ok ? value : null;
      } catch (_) {
        stats.heartbeatFailures++;
        memo.set(gymId, { value: null, expires: Date.now() + failMemoMs });
        return null;
      } finally {
        clearTimeout(timer);
        inflight.delete(gymId);
      }
    })();
    inflight.set(gymId, p);
    return p;
  }

  /**
   * @returns {(() => Promise<string|null>)|undefined} a stamp function for schedule-cache's
   * `opts.stamp`, or undefined when the provider has no freshness hook. The stamp is the joined
   * values of `resources`; null when the heartbeat is unavailable or a resource is missing.
   */
  function stampFor(gymId, provider, session, resources) {
    if (!provider || typeof provider.hasFreshnessStamps !== 'function' || !provider.hasFreshnessStamps()) return undefined;
    return async () => {
      const snap = await snapshot(gymId, provider, session);
      if (!snap) return null;
      const parts = resources.map((r) => snap[r]);
      return parts.every((v) => typeof v === 'string' && v) ? parts.join('|') : null;
    };
  }

  const getStats = () => ({ ...stats });
  return { stampFor, getStats };
}

const shared = createFreshness();
module.exports = { ...shared, createFreshness, MEMO_MS, FAIL_MEMO_MS, TIMEOUT_MS };
