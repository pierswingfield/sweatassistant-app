import { debugLog } from './main.js';
import { getDefaultGymId } from './gym-context.js';
import { createLayoutCache, MAX_AGE_MS as LAYOUT_MAX_AGE_MS } from './layout-cache.js';
import { readCached, setCached, getCachedSWR, clearApiCache, setCacheKeyPrefix, invalidateApiCache, getOfflineSnapshot, setOfflineSnapshot, deleteOfflineSnapshot } from './cache.js';
import { classifyAuthFailure } from './auth-failure.js';
import { COPY, formatCopyText } from './copy.js';
import { createProgressiveMerge } from './ui/progressive-merge.js';
import { beginGymLoad, endGymLoad } from './ui/gym-load-state.js';
import { assertMutationNetworkAvailable, isOfflineForMutation } from './network-write-guard.js';
import { validateSelfBookingRequest } from './ui/booking-entitlement.js';

// API Abstraction layer for communicating with the Psycle PWA server

// U1-15: every successful booking mutation is announced so booking-state.js can
// update the shared booked/waitlisted cache at once, whichever tab made it.
function announceBookingMutation(detail) {
  try { window.dispatchEvent(new CustomEvent('psycle-bookings-mutated', { detail })); } catch (_) {}
}

let localToken = localStorage.getItem('psycleLocalToken') || null;
const offlineSnapshotMeta = new Map();
let lastLoadedGymIds = new Set(); // Track which gyms loaded successfully in getBookings/getWaitlists

function publishOfflineSnapshot(name, snapshot) {
  offlineSnapshotMeta.set(name, snapshot.savedAt);
  try { window.dispatchEvent(new CustomEvent('psycle-offline-snapshot', { detail: { name, savedAt: snapshot.savedAt } })); } catch (_) {}
  return snapshot.data;
}

async function withOfflineSnapshot(name, readLive) {
  // A 401/403 must never revive old private data. Only the app's explicit
  // offline state permits a snapshot fallback.
  const fromSnapshot = async () => {
    const snapshot = await getOfflineSnapshot(name);
    if (snapshot) return publishOfflineSnapshot(name, snapshot);
    return null;
  };
  if (isOfflineForMutation()) {
    const data = await fromSnapshot();
    if (data !== null) return data;
  }
  try {
    const data = await readLive();
    offlineSnapshotMeta.delete(name);
    setOfflineSnapshot(name, data);
    return data;
  } catch (err) {
    // A thrown fetch (TypeError) is a transport failure, not an auth answer, so the
    // last good snapshot is safe even before the offline probe has latched the flag.
    if (isOfflineForMutation() || err instanceof TypeError) {
      const data = await fromSnapshot();
      if (data !== null) return data;
    }
    throw err;
  }
}

export function getOfflineSnapshotSavedAt(name) {
  return offlineSnapshotMeta.get(name) || null;
}

// Active gym context (WP-C1). Persisted per-account so the normalized API can
// tell the server which linked gym a request is scoped to (via the `x-gym-id`
// header).
//
// THERE IS NO AMBIENT ACTIVE GYM ON THE CLIENT. The app presents one unified
// view — every list shows every linked gym at once, and every per-gym call
// passes `options.gymId` explicitly. A sticky "current gym" only ever existed to
// serve a switcher, and a switcher is exactly what a unified view removes.
//
// Any request that needs a specific gym says so at the call site; anything else
// lets the server resolve (db.resolveActiveGymId), which still exists because
// background cron has no request context. Do not reintroduce module-level gym
// state here: it reintroduces "which gym am I looking at?", the question this
// design exists to make unaskable.
//
// One legacy key is cleared on load: `sweatActiveGymId` was written by the old
// switcher and would otherwise keep stamping x-gym-id on every request forever.
try { localStorage.removeItem('sweatActiveGymId'); } catch (_) {}

export function setToken(token) {
  localToken = token;
  if (token) {
    localStorage.setItem('psycleLocalToken', token);
  } else {
    localStorage.removeItem('psycleLocalToken');
  }
}

export function getToken() {
  return localToken;
}

export function isLoggedIn() {
  return !!localToken;
}

  // Cache staleness tracking — last cached GET response was stale

// Global fetch wrapper with local auth and Cloudflare Zero Trust Access support
export async function apiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  assertMutationNetworkAvailable(options.method, COPY.api.offlineMutationBlocked);
  
  const headers = {
    'accept': 'application/json',
    ...options.headers
  };

  if (localToken) {
    headers['authorization'] = `Bearer ${localToken}`;
  }

  // Only ever explicit: see the note at the top of this file.
  const targetGym = options.gymId;
  if (targetGym) {
    headers['x-gym-id'] = targetGym;
  }

  if (options.body && !(options.body instanceof FormData)) {
    headers['content-type'] = 'application/json';
  }

  const fetchOptions = {
    ...options,
    headers,
    // Same-origin ensures the browser forwards Cloudflare Zero Trust (CF_Authorization) cookies
    credentials: 'same-origin'
  };

  let res;
  try {
    res = await fetch(url, fetchOptions);
  } catch (err) {
    // Safari's generic "Load failed" TypeError also fires for a stale keep-alive
    // socket after the PWA resumes. An idempotent read is safe to retry once on a
    // fresh connection before anyone is told the network is down.
    const method = String(options.method || 'GET').toUpperCase();
    const quiet = !!options.quiet;
    if (err instanceof TypeError && (method === 'GET' || method === 'HEAD') && !options.signal) {
      await new Promise(r => setTimeout(r, 350));
      try {
        res = await fetch(url, fetchOptions);
      } catch (retryErr) {
        if (!quiet) window.dispatchEvent(new CustomEvent('psycle-network-fail'));
        throw retryErr;
      }
    } else {
      if (!quiet) window.dispatchEvent(new CustomEvent('psycle-network-fail'));
      throw err;
    }
  }

  window.dispatchEvent(new CustomEvent('psycle-network-ok'));

  // A 403 naming an unlinked gym means this call asked for a gym the account is
  // not linked to — it was unlinked, disabled, or this is a different account on
  // the same browser. With no ambient gym state there is nothing to clear, so
  // just make the cause obvious in the console and let the caller handle it.
  if (res.status === 403 && targetGym) {
    const peek = res.clone();
    try {
      const body = await peek.json();
      if (body && /not linked to gym/i.test(body.message || '')) {
        console.warn(`[API] Gym "${targetGym}" is not linked to this account.`);
      }
    } catch (_) { /* not JSON; leave the 403 to the caller */ }
  }

  if (res.status === 401 && localToken) {
    // C1-2: a 401 here is NOT necessarily the Sweat Assistant session expiring.
    // The server (routes-normalized.js resolveContext / auth.js
    // triggerAutoRelogin) tags a dead GYM session — one linked gym's own
    // login going stale — with `code: 'GYM_SESSION_EXPIRED'` and the gym it
    // belongs to, precisely so this handler doesn't have to guess. An invalid
    // or expired SA JWT is a 403 from authenticateToken, a different code path
    // entirely (see below). Logging the whole account out for one gym's dead
    // session was QA-08: a two-gym user lost their session the moment EITHER
    // gym's credential went stale, even though the other gym and the SA
    // account itself were both fine.
    const decision = classifyAuthFailure(res.status, await peekJson(res), targetGym);
    if (decision.kind === 'gym') {
      console.warn(`[API] Gym "${decision.gymId || 'unknown'}" session expired — needs relogin.`);
      window.dispatchEvent(new CustomEvent('psycle-gym-needs-relogin', { detail: { gymId: decision.gymId } }));
      return res;
    }
    console.warn('[API] Received 401. Session expired. Logging out.');
    setToken(null);
    window.dispatchEvent(new CustomEvent('psycle-logout-triggered'));
    throw new Error(COPY.api.sessionExpired);
  }

  return res;
}

// Reads the JSON body without consuming the response the caller still needs.
// Swallows a non-JSON or empty body — plenty of error responses have neither.
async function peekJson(res) {
  try {
    return await res.clone().json();
  } catch (_) {
    return null;
  }
}

// Floor plans: cache-first (IndexedDB `api-responses`, per-user prefix + gym + studio),
// background revalidation is quiet so a flaky network never trips the offline banner.
const layoutCache = createLayoutCache({
  read: async (key) => {
    const c = await readCached(key);
    return c ? c.data : null;
  },
  write: (key, entry) => setCached(key, entry, LAYOUT_MAX_AGE_MS),
  fetchLayout: async (studioId, gymId) => {
    debugLog(`GET /api/studios/${studioId}/layout`, 'network');
    const res = await apiFetch(`/api/studios/${encodeURIComponent(studioId)}/layout`, { gymId, quiet: true });
    if (!res.ok) throw new Error('Failed to load studio layout');
    const data = await res.json();
    return { slots: data.slots || [], objects: data.objects || [] };
  },
  onChange: (detail) => {
    try { window.dispatchEvent(new CustomEvent('psycle-layout-updated', { detail })); } catch (_) {}
  },
});

export const api = {
  // Auth BFF
  async login(email, password) {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Login failed');
    }
    const data = await res.json();
    setToken(data.token);
    return data.user;
  },

  // Create a Sweat Assistant account — no gym involved (Decision D4). Returns
  // { user, needsGym } so the caller can route straight to "link a gym".
  async signup(email, password) {
    const res = await apiFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not create account');
    setToken(data.token);
    return { user: data.user, needsGym: !!data.needsGym };
  },

  // Account-recovery client methods were REMOVED 2026-08-31 along with the
  // gym-login-as-recovery-credential mechanism (it re-coupled the account to the
  // gym, defeating Decision D4). Re-add them when a replacement is chosen —
  // see Documentation/Workstreams/C6-accounts-auth.md.

  async getStatus() {
    const res = await apiFetch('/api/auth/status');
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
  },

  // ---- Capability-gated provider extras -------------------------------------
  // These replaced the raw /api/proxy passthrough (WP-D9). They are features
  // only some platforms have, but the client still knows nothing about any
  // provider's URL shape — it names the FEATURE and the server's adapter owns
  // the path. A gym without the capability answers 501 CAPABILITY_UNSUPPORTED.

  // Purchasable credit packs. `ttlMs` opts into the same SWR cache the old
  // proxyGet had, since the bundle catalogue changes rarely.
  async getBundles({ gymId = null, ttlMs } = {}) {
    debugLog('GET /api/bundles', 'network');
    if (ttlMs) {
      // C3-25: the gym goes in the CACHE KEY (the way getMembership does it). It
      // used to ride only in the x-gym-id header, so a second creditPurchase gym
      // would have been served the first gym's packs from cache.
      const url = gymId ? `/api/bundles?gymId=${encodeURIComponent(gymId)}` : '/api/bundles';
      const result = await getCachedSWR(url, { ttlMs, fetcher: (u, o) => apiFetch(u.split('?')[0], { ...o, gymId }) });
      return result.data;
    }
    const res = await apiFetch('/api/bundles', { gymId });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to load bundles: ${res.status}`);
    }
    return res.json();
  },

  // Add or remove a saved-class bookmark. `identifier` is the provider's own
  // bookmark key, round-tripped verbatim — the client never composes it into a
  // path. Returns nothing useful; throws on failure.
  async setBookmark(identifier, on, gymId = null) {
    debugLog(`${on ? 'PUT' : 'DELETE'} /api/bookmarks/${identifier}`, 'network');
    const res = await apiFetch(`/api/bookmarks/${encodeURIComponent(identifier)}`, {
      method: on ? 'PUT' : 'DELETE',
      gymId,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to update bookmark: ${res.status}`);
    }
    // The profile carries the bookmark list, so a stale cached profile would
    // re-render the heart in its old state.
    await invalidateApiCache('/api/profile').catch(() => {});
    return true;
  },

  // Profile Explorer's hidden edit mode. No normal flow calls this.
  async updateProfileFields(payload, gymId = null) {
    debugLog('POST /api/profile/update', 'network');
    const res = await apiFetch('/api/profile/update', {
      method: 'POST',
      body: JSON.stringify(payload),
      gymId,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to update profile: ${res.status}`);
    }
    await invalidateApiCache('/api/profile').catch(() => {});
    return res.json().catch(() => ({}));
  },

  // ---- Normalized gym-agnostic API (WP-C1) ----------------------------------
  // New surface backed by server/routes-normalized.js (provider adapters).
  // Returns NormalizedEvent / NormalizedSlot / NormalizedProfile /
  // NormalizedBookingResult shapes (see server/providers/base.js), independent
  // of the underlying gym platform. The raw /api/proxy passthrough this
  // replaced is gone (WP-D9) — there is no longer any path by which the client
  // can name a provider's own URL.

  // Public gym registry + capability flags (for the Phase 5 gym picker).
  async getGyms() {
    return withOfflineSnapshot('gym-catalogue', async () => {
      const res = await apiFetch('/api/gyms');
      if (!res.ok) throw new Error('Failed to load gyms');
      const data = await res.json();
      return data.gyms || [];
    });
  },

  // The gyms THIS account is linked to, plus which one is currently active.
  // `getGyms()` above is the public catalogue of everything configured; this is
  // the per-account view Settings → Your Gyms renders from.
  async getMyGyms() {
    return withOfflineSnapshot('my-gyms', async () => {
      const res = await apiFetch('/api/my-gyms');
      if (!res.ok) throw new Error('Failed to load your gyms');
      return res.json(); // { gyms: [...], activeGymId }
    });
  },

  // NOTE: `setActiveGym()` used to live here and is deliberately gone, along
  // with the switcher it served. `POST /api/my-gyms/active` still exists
  // server-side for the persisted default that background cron resolves from —
  // but nothing user-facing chooses a gym any more.

  // Link a new gym, or re-authenticate one whose stored password went stale.
  // Same endpoint for both (see auth.linkGymAccount).
  async linkGym(gymId, email, password) {
    const res = await apiFetch('/api/my-gyms/link', {
      method: 'POST',
      body: JSON.stringify({ gymId, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not link that gym');
    return data;
  },

  async unlinkGym(gymId) {
    const res = await apiFetch(`/api/my-gyms/${encodeURIComponent(gymId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not unlink that gym');
    return data.gyms || [];
  },

  // Change the Sweat Assistant account password — independent of any gym's.
  async changeAccountPassword(currentPassword, newPassword) {
    const res = await apiFetch('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not change password');
    return true;
  },

  // `ttlMs` opts into the same IndexedDB stale-while-revalidate cache
  // proxyGet(path, {ttlMs}) already uses (getCachedSWR) — needed for
  // timetable.js's migration off proxyGet, which relies on this to avoid a
  // full network round-trip on every tab switch/render.
  async getTimetable(params = {}) {
    const qs = new URLSearchParams();
    if (params.startDate) qs.set('startDate', params.startDate);
    if (params.endDate) qs.set('endDate', params.endDate);
    // `refresh: true` reaches past the SHARED server cache to the provider.
    // Only the explicit refresh control sets it — an automatic refresh on every
    // render would make the cache pointless, which is how it ended up absent.
    if (params.refresh) qs.set('refresh', '1');
    const suffix = qs.toString() ? `?${qs}` : '';

    if (params.gymId) {
      const res = await apiFetch(`/api/timetable${suffix}`, { gymId: params.gymId });
      if (!res.ok) throw new Error('Failed to load timetable');
      const data = await res.json();
      return (data.events || []).map((ev) => ({ ...ev, gymId: ev.gymId || params.gymId }));
    }

    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];

    if (linked.length <= 1) {
      const endpoint = `/api/timetable${suffix}`;
      debugLog(`GET ${endpoint}`, 'network');
      const res = await apiFetch(endpoint);
      if (!res.ok) throw new Error('Failed to load timetable');
      const data = await res.json();
      const gymId = linked[0]?.gym_id || getDefaultGymId();
      const gymName = linked[0]?.gym_name || linked[0]?.name || 'Psycle';
      return (data.events || []).map((ev) => ({
        ...ev,
        gymId: ev.gymId || gymId,
        gymName: ev.gymName || gymName,
      }));
    }

    // Parallel multi-gym query across all linked gyms
    const results = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        const gName = g.gym_name || g.name || gymId;
        try {
          const res = await apiFetch(`/api/timetable${suffix}`, { gymId });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.events || []).map((ev) => ({
            ...ev,
            gymId: ev.gymId || gymId,
            gymName: ev.gymName || gName,
          }));
        } catch (_) {
          return [];
        }
      })
    );
    const allEvents = results.flat();
    allEvents.sort((a, b) => new Date(a.startAt || a.start_at) - new Date(b.startAt || b.start_at));
    return allEvents;
  },

  // U4-7: same data as getTimetable, but delivered progressively. `onFlush`
  // receives { events, pending, final } per createProgressiveMerge's grace rule
  // (all gyms together if they land inside graceMs, else first-arrivals then
  // each late gym). Gyms in flight are published to the header chips (U4-2).
  // Resolves to the final merged events.
  async getTimetableProgressive(params = {}, { graceMs = 4000, onFlush } = {}) {
    const qs = new URLSearchParams();
    if (params.startDate) qs.set('startDate', params.startDate);
    if (params.endDate) qs.set('endDate', params.endDate);
    if (params.refresh) qs.set('refresh', '1');
    const suffix = qs.toString() ? `?${qs}` : '';

    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];
    const idOf = (g) => g.gym_id || g.gymId || g.id;

    if (linked.length <= 1) {
      const gid = linked[0] ? idOf(linked[0]) : getDefaultGymId();
      beginGymLoad(gid);
      try {
        const events = await this.getTimetable(params);
        onFlush?.({ events, pending: [], final: true, arrivedGyms: [String(gid)] });
        return events;
      } finally { endGymLoad(gid); }
    }

    const merge = createProgressiveMerge({
      gymIds: linked.map(idOf),
      graceMs,
      onFlush: (info) => onFlush?.(info),
    });
    linked.forEach((g) => {
      const gymId = idOf(g);
      const gName = g.gym_name || g.name || gymId;
      beginGymLoad(gymId);
      (async () => {
        try {
          const res = await apiFetch(`/api/timetable${suffix}`, { gymId });
          if (!res.ok) return merge.fail(gymId);
          const data = await res.json();
          merge.arrive(gymId, (data.events || []).map((ev) => ({
            ...ev, gymId: ev.gymId || gymId, gymName: ev.gymName || gName,
          })));
        } catch (_) {
          merge.fail(gymId);
        } finally {
          endGymLoad(gymId);
        }
      })();
    });
    return merge.done;
  },

  // The four timetable filter lists, gym-agnostic (WP-D9). Replaces four raw
  // /api/proxy reads that only worked because they were CodexFit endpoints —
  // MarianaTek has none of them and derives all four from its class list.
  // Returns { locations, studios, instructors, classTypes }.
  async getMetadata(params = {}) {
    // The timetable cache also retains metadata, but this explicit snapshot is
    // needed before the timetable has restored that cache (for example when a
    // filter pane opens during an offline relaunch).
    const snapshotName = `metadata:${params.startDate || ''}:${params.endDate || ''}`;
    return withOfflineSnapshot(snapshotName, async () => {
    const qs = new URLSearchParams();
    if (params.startDate) qs.set('startDate', params.startDate);
    if (params.endDate) qs.set('endDate', params.endDate);
    // `refresh: true` reaches past the SHARED server cache to the provider.
    // Only the explicit refresh control sets it — an automatic refresh on every
    // render would make the cache pointless, which is how it ended up absent.
    if (params.refresh) qs.set('refresh', '1');
    const suffix = qs.toString() ? `?${qs}` : '';

    if (params.gymId) {
      const res = await apiFetch(`/api/metadata${suffix}`, { gymId: params.gymId });
      if (!res.ok) throw new Error('Failed to load timetable metadata');
      const data = await res.json();
      const withGym = (items) => (items || []).map(item => ({ ...item, gymId: params.gymId }));
      return {
        locations: withGym(data.locations),
        studios: withGym(data.studios),
        instructors: withGym(data.instructors),
        eventTypes: withGym(data.eventTypes),
      };
    }

    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];

    // C3-10: a gym-less Sweat Assistant account (post-signup, or after unlinking
    // the last gym) is a legitimate state, not an error — the server would answer
    // /api/metadata with 409 NO_GYM_LINKED for it. Answering empty here avoids the
    // request entirely rather than surfacing a "failed to load" toast for a state
    // that has nothing to load.
    if (linked.length === 0) {
      return { locations: [], studios: [], instructors: [], eventTypes: [] };
    }

    if (linked.length <= 1) {
      const res = await apiFetch(`/api/metadata${suffix}`);
      if (!res.ok) throw new Error('Failed to load timetable metadata');
      const data = await res.json();
      const gymId = linked[0]?.gym_id || getDefaultGymId();
      const gymName = linked[0]?.gym_name || linked[0]?.name || 'Psycle';
      return {
        locations: (data.locations || []).map((l) => ({ ...l, gymId, gymName })),
        studios: (data.studios || []).map((s) => ({ ...s, gymId, gymName })),
        instructors: (data.instructors || []).map((i) => ({ ...i, gymId, gymName })),
        eventTypes: (data.eventTypes || []).map((t) => ({ ...t, gymId, gymName })),
      };
    }

    const results = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        const gName = g.gym_name || g.name || gymId;
        try {
          const res = await apiFetch(`/api/metadata${suffix}`, { gymId });
          if (!res.ok) return null;
          const data = await res.json();
          return { gymId, gymName: gName, ...data };
        } catch (_) {
          return null;
        }
      })
    );

    const locations = [];
    const studios = [];
    const instructors = [];
    const eventTypes = [];

    const locIds = new Set();
    const studioIds = new Set();
    const instrIds = new Set();
    const typeIds = new Set();

    results.filter(Boolean).forEach((meta) => {
      (meta.locations || []).forEach((l) => {
        const key = `${meta.gymId}:${l.id}`;
        if (!locIds.has(key)) { locIds.add(key); locations.push({ ...l, gymId: meta.gymId, gymName: meta.gymName }); }
      });
      (meta.studios || []).forEach((s) => {
        const key = `${meta.gymId}:${s.id}`;
        if (!studioIds.has(key)) { studioIds.add(key); studios.push({ ...s, gymId: meta.gymId, gymName: meta.gymName }); }
      });
      (meta.instructors || []).forEach((i) => {
        const key = `${meta.gymId}:${i.id}`;
        if (!instrIds.has(key)) { instrIds.add(key); instructors.push({ ...i, gymId: meta.gymId, gymName: meta.gymName }); }
      });
      (meta.eventTypes || []).forEach((t) => {
        const key = `${meta.gymId}:${t.id}`;
        if (!typeIds.has(key)) { typeIds.add(key); eventTypes.push({ ...t, gymId: meta.gymId, gymName: meta.gymName }); }
      });
    });

    return { locations, studios, instructors, eventTypes };
    });
  },

  // Returns { event: NormalizedEvent, slots: NormalizedSlot[] } (slots [] for FCFS).
  async getEventDetails(eventId, gymId = null) {
    debugLog(`GET /api/events/${eventId}`, 'network');
    const res = await apiFetch(`/api/events/${encodeURIComponent(eventId)}`, { gymId });
    if (!res.ok) throw new Error('Failed to load event details');
    return res.json();
  },

  async getBookingEntitlement(eventId, gymId = null) {
    const res = await apiFetch(`/api/events/${encodeURIComponent(eventId)}/booking-entitlement`, { gymId });
    if (!res.ok) throw new Error('Could not confirm booking eligibility');
    return res.json();
  },

  // Returns NormalizedSlot[] (empty if the studio has no floor map — see
  // GymProvider.fetchStudioLayout doc comment; not an error case).
  // Returns { slots: NormalizedSlot[], objects: NormalizedLayoutObject[] }.
  // Empty `slots` means "no floor map available for this studio", not an error.
  async getStudioLayout(studioId, gymId = null) {
    return layoutCache.get(gymId, studioId);
  },
  // Sync read + seeding for the booking modal (one cache for floor plans).
  peekStudioLayout(studioId, gymId = null) { return layoutCache.peek(gymId, studioId); },
  rememberStudioLayout(studioId, gymId, slots, objects) { return layoutCache.remember(gymId, studioId, slots, objects); },

  // Returns a NormalizedBookingResult { ok, bookingId, slotId, error?, status? }.
  async book(eventId, slotIds = [], gymId = null, { timeoutMs = 20_000, selfBookingLimit, currentSelfBookings = 0 } = {}) {
    if (selfBookingLimit !== undefined) {
      const validation = validateSelfBookingRequest({ slotIds, currentSelfBookings, selfBookingLimit });
      if (!validation.ok) {
        return {
          ok: false,
          status: 400,
          code: validation.code,
          error: validation.code === 'ATTENDEE_LIMIT_EXCEEDED'
            ? formatCopyText(COPY.bookingEditor.selfBookingLimit, { count: validation.limit })
            : COPY.bookingEditor.bookingLimitUnavailable,
        };
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await apiFetch('/api/book', {
        method: 'POST',
        body: JSON.stringify({ eventId, slotIds }),
        gymId,
        signal: controller.signal,
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          code: result.code,
          error: result.error || result.message || `Booking failed (${res.status}).`,
        };
      }
      if (result && result.ok) announceBookingMutation({ type: 'book', eventId, gymId });
      return result;
    } catch (err) {
      if (timedOut) {
        return { ok: false, status: 504, code: 'BOOKING_TIMEOUT', error: 'Booking timed out. Check My Bookings before trying again.' };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },

  async bookGuest(eventId, slotId, guestEmail, gymId = null) {
    const res = await apiFetch('/api/book-guest', {
      method: 'POST',
      body: JSON.stringify({ eventId, slotId: slotId ?? null, guestEmail }),
      gymId,
    });
    const result = await res.json().catch(() => ({}));
    if (result && result.ok) announceBookingMutation({ type: 'bookGuest', eventId, gymId });
    return result;
  },

  // cancel / joinWaitlist / leaveWaitlist are COMMANDS: they either happen or
  // they don't, so they throw on refusal rather than returning a flag. That
  // matches what every caller was written against (the raw proxy threw), and it
  // means a failed cancel can never render a success toast.
  //
  // `book` deliberately does NOT throw — a decline there carries information the
  // caller needs (which spot, why), so it returns a NormalizedBookingResult.
  async _command(endpoint, body, whatFailed, gymId = null) {
    const res = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body), gymId });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.error || formatCopyText(COPY.api.commandFailed, { action: whatFailed }));
    }
    return data;
  },

  async cancel(bookingId, gymId = null) {
    const out = await this._command('/api/cancel', { bookingId }, COPY.api.cancelAction, gymId);
    announceBookingMutation({ type: 'cancel', bookingId, gymId });
    return out;
  },

  // Returns { isPenalty, message? } — prefer provider truth over client window math.
  async getCancelPenalty(bookingId, gymId = null) {
    const res = await apiFetch(`/api/cancel-penalty/${encodeURIComponent(bookingId)}`, { gymId });
    if (!res.ok) throw new Error(COPY.api.cancelPenaltyCheckFailed);
    return res.json();
  },

  async joinWaitlist(eventId, gymId = null) {
    const out = await this._command('/api/waitlist/join', { eventId }, COPY.api.joinWaitlistAction, gymId);
    announceBookingMutation({ type: 'joinWaitlist', eventId, gymId });
    return out;
  },

  async leaveWaitlist(eventId, gymId = null) {
    const out = await this._command('/api/waitlist/leave', { eventId }, COPY.api.leaveWaitlistAction, gymId);
    announceBookingMutation({ type: 'leaveWaitlist', eventId, gymId });
    return out;
  },

  async swapSpot(bookingId, currentSlotId, targetSlotId, gymId = null) {
    const res = await apiFetch('/api/swap', {
      method: 'POST',
      body: JSON.stringify({ bookingId, currentSlotId, targetSlotId }),
      gymId,
    });
    const result = await res.json(); // NormalizedBookingResult
    if (result && result.ok) announceBookingMutation({ type: 'swap', bookingId, gymId });
    return result;
  },

  // Returns NormalizedBooking[], .event populated for both providers (fixed
  // 2026-07-03 for CodexFit — see providers/codexfit.js listBookings doc
  // comment — it resolves via the response's embedded `relations` block when
  // not already inline). bookings.js's renderBookings() is the first caller.
  async getBookings() {
    return withOfflineSnapshot('bookings', async () => {
    debugLog('GET /api/bookings', 'network');
    const myGymsRes = await this.getMyGyms();
    const linked = myGymsRes.gyms || [];
    if (linked.length <= 1) {
      const res = await apiFetch('/api/bookings');
      if (!res.ok) throw new Error('Failed to load bookings');
      const data = await res.json();
      const gymId = linked[0]?.gym_id || getDefaultGymId();
      const gymName = linked[0]?.gym_name || linked[0]?.name || 'Psycle';
      lastLoadedGymIds = new Set([gymId]); // Single gym always loaded
      return (data.bookings || []).map((b) => ({
        ...b,
        gymId: b.gymId || gymId,
        gymName: b.gymName || gymName,
        event: b.event ? { ...b.event, gymId: b.event.gymId || gymId, gymName: b.event.gymName || gymName } : b.event,
      }));
    }

    const results = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        const gName = g.gym_name || g.name || gymId;
        try {
          beginGymLoad(gymId);
          let res;
          try { res = await apiFetch('/api/bookings', { gymId }); } finally { endGymLoad(gymId); }
          if (!res.ok) return { data: [], gymId, loaded: false };
          const data = await res.json();
          return {
            data: (data.bookings || []).map((b) => ({
              ...b,
              gymId: b.gymId || gymId,
              gymName: b.gymName || gName,
              event: b.event ? { ...b.event, gymId: b.event.gymId || gymId, gymName: b.event.gymName || gName } : b.event,
            })),
            gymId,
            loaded: true,
          };
        } catch (err) {
          if (isOfflineForMutation()) throw err;
          return { data: [], gymId, loaded: false };
        }
      })
    );

    // Track which gyms successfully loaded
    lastLoadedGymIds = new Set(results.filter(r => r.loaded).map(r => r.gymId));

    const all = results.flatMap(r => r.data);
    all.sort((a, b) => new Date(a.event?.startAt || a.event?.start_at || a.start_at || 0) - new Date(b.event?.startAt || b.event?.start_at || b.start_at || 0));
    return all;
    });
  },

  async getWaitlists() {
    return withOfflineSnapshot('waitlists', async () => {
    debugLog('GET /api/waitlists', 'network');
    const myGymsRes = await this.getMyGyms();
    const linked = myGymsRes.gyms || [];
    if (linked.length <= 1) {
      const res = await apiFetch('/api/waitlists');
      if (!res.ok) throw new Error('Failed to load waitlists');
      const data = await res.json();
      const gymId = linked[0]?.gym_id || getDefaultGymId();
      const gymName = linked[0]?.gym_name || linked[0]?.name || 'Psycle';
      return (data.waitlists || []).map((w) => ({
        ...w,
        gymId: w.gymId || gymId,
        gymName: w.gymName || gymName,
        event: w.event ? { ...w.event, gymId: w.event.gymId || gymId, gymName: w.event.gymName || gymName } : w.event,
      }));
    }

    const results = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        const gName = g.gym_name || g.name || gymId;
        try {
          beginGymLoad(gymId);
          let res;
          try { res = await apiFetch('/api/waitlists', { gymId }); } finally { endGymLoad(gymId); }
          if (!res.ok) return { data: [], gymId, loaded: false };
          const data = await res.json();
          return {
            data: (data.waitlists || []).map((w) => ({
              ...w,
              gymId: w.gymId || gymId,
              gymName: w.gymName || gName,
              event: w.event ? { ...w.event, gymId: w.event.gymId || gymId, gymName: w.event.gymName || gName } : w.event,
            })),
            gymId,
            loaded: true,
          };
        } catch (err) {
          if (isOfflineForMutation()) throw err;
          return { data: [], gymId, loaded: false };
        }
      })
    );


    const all = results.flatMap(r => r.data);
    all.sort((a, b) => new Date(a.event?.startAt || a.event?.start_at || a.start_at || 0) - new Date(b.event?.startAt || b.event?.start_at || b.start_at || 0));
    return all;
    });
  },

  // "Can this account book at all" (WP-J) — distinct from credit arithmetic,
  // which answers "can it afford THIS class".
  async getEligibility(gymId = null) {
    return withOfflineSnapshot(`eligibility:${gymId || 'default'}`, async () => {
      const res = await apiFetch('/api/eligibility', { gymId });
      if (!res.ok) throw new Error('Failed to load eligibility');
      return res.json();
    });
  },

  // Eligibility for EVERY linked gym, keyed by gym id. A merged list needs each
  // row's own gym's answer: one gym being ineligible (no credits, lapsed
  // membership) must not disable booking on another gym's classes.
  async getEligibilityByGym() {
    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];
    const entries = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        try { return [gymId, await this.getEligibility(gymId)]; }
        catch (_) { return [gymId, null]; }
      })
    );
    return Object.fromEntries(entries);
  },

  // Membership changes on renewal, not between page views, so it rides the same
  // IndexedDB SWR cache as every other GET. Without a TTL the Credits &
  // Membership tab re-fetched one provider call PER GYM on every visit, which is
  // why it took seconds to show data that had not changed since the last look.
  async getMembership(gymId = null, { ttlMs = 10 * 60 * 1000 } = {}) {
    const url = gymId ? `/api/membership?gymId=${encodeURIComponent(gymId)}` : '/api/membership';
    const result = await getCachedSWR(url, {
      ttlMs,
      fetcher: (u, o) => apiFetch(u.split('?')[0], { ...o, gymId }),
    });
    const data = result.data || {};
    return data.membership || null;
  },

  // One normalized membership result per linked gym. A credit-based gym
  // contributes null; one provider failing does not blank the other sections.
  async getMembershipsByGym() {
    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];
    const entries = await Promise.all(linked.map(async (g) => {
      const gymId = g.gym_id || g.gymId || g.id;
      try {
        return [gymId, await this.getMembership(gymId)];
      } catch (_) {
        return [gymId, null];
      }
    }));
    return Object.fromEntries(entries);
  },

  async getNormalizedProfile(gymId = null) {
    return withOfflineSnapshot(`profile:${gymId || 'default'}`, async () => {
      const res = await apiFetch('/api/profile', { gymId });
      if (!res.ok) throw new Error('Failed to load profile');
      return res.json();
    });
  },

  // Cached with a SHORT ttl: a balance changes when you book or a purchase
  // lands, so it must not be as stale as membership — but re-fetching it per
  // gym on every tab visit is what made Credits & Membership take seconds.
  // Booking invalidates it explicitly (see invalidateApiCache callers).
  async getNormalizedCredits(gymId = null, { ttlMs = 60 * 1000 } = {}) {
    const url = gymId ? `/api/credits?gymId=${encodeURIComponent(gymId)}` : '/api/credits';
    const result = await getCachedSWR(url, {
      ttlMs,
      fetcher: (u, o) => apiFetch(u.split('?')[0], { ...o, gymId }),
    });
    return (result.data && result.data.credits) || [];
  },

  // Per-gym credit inventories, one call per linked gym. `/api/credits` (above)
  // only ever answers for the currently active gym — the header shows one badge
  // per linked gym, so it needs one balance per linked gym, not the active
  // gym's balance repeated under every badge (the bug this method exists to fix).
  // Returns { [gymId]: NormalizedCredit[] }. A gym whose fetch FAILS is left OUT of
  // the map, never given `[]` (U1-13): `[]` means "you hold no credits", and the
  // Auto-Book card read that as "Insufficient Credits" for a member with credit.
  // A missing key is "unknown", which credit-allowance.js answers permissively.
  async getCreditsByGym() {
    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];
    const entries = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        try {
          return [gymId, await this.getNormalizedCredits(gymId)];
        } catch (_) {
          return null;
        }
      })
    );
    return Object.fromEntries(entries.filter(Boolean));
  },

  // U1-12: ask the server (competing-bookings.js, cross-gym) whether booking this
  // class now would clash with anything the member already holds or has queued.
  // Returns the warnings; the client never derives an overlap itself.
  async checkOverlap(subject, gymId = null) {
    const res = await apiFetch('/api/overlap-check', {
      method: 'POST',
      body: JSON.stringify({
        eventId: subject.eventId, startAt: subject.startAt,
        durationMin: subject.durationMin, className: subject.className, gymId,
      }),
      gymId,
    });
    if (!res.ok) throw new Error('Overlap check failed');
    return (await res.json()).warnings || [];
  },

  // Auto-Book Queue
  async getAutoBookings() {
    const result = await getCachedSWR('/api/auto-book', { ttlMs: 30000, fetcher: apiFetch });
    return result.data;
  },

  async addAutoBooking(bookingData) {
    const res = await apiFetch('/api/auto-book', {
      method: 'POST',
      body: JSON.stringify(bookingData)
    });
    if (res.ok) invalidateApiCache('/api/auto-book').catch(() => {});
    const body = await res.json().catch(() => ({}));
    // Throw on a refusal (409 duplicate, 429 quota, ...): callers used to announce
    // "Successfully scheduled" over any JSON body, whatever the status (C5-3).
    if (!res.ok) {
      const err = new Error(body.message || `Could not schedule auto-book (${res.status})`);
      // Structured, so a caller can branch on the refusal without parsing prose:
      // 'OVERLAP_CONFIRM_REQUIRED' (nothing was queued; resubmit with
      // `confirmOverlap: true` after showing `warnings`), 'DUPLICATE_AUTO_BOOK'.
      err.status = res.status;
      err.code = body.code || null;
      err.warnings = Array.isArray(body.warnings) ? body.warnings : [];
      throw err;
    }
    return body;
  },

  async updateAutoBooking(id, preferences) {
    const res = await apiFetch(`/api/auto-book/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences })
    });
    if (res.ok) invalidateApiCache('/api/auto-book').catch(() => {});
    return res.json();
  },

  async deleteAutoBooking(id) {
    const res = await apiFetch(`/api/auto-book/${id}`, {
      method: 'DELETE'
    });
    if (res.ok) invalidateApiCache('/api/auto-book').catch(() => {});
    return res.json();
  },

  async simulateRelease() {
    const res = await apiFetch('/api/simulate-release', { method: 'POST' });
    return res.json();
  },

  // Auto-Upgrade
  async getAutoUpgrades() {
    const result = await getCachedSWR('/api/auto-upgrade', { ttlMs: 30000, fetcher: apiFetch });
    return result.data;
  },

  async addAutoUpgrade(upgradeData) {
    const res = await apiFetch('/api/auto-upgrade', {
      method: 'POST',
      body: JSON.stringify(upgradeData)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to add auto-upgrade monitor');
    }
    invalidateApiCache('/api/auto-upgrade').catch(() => {});
    return res.json();
  },

  async updateAutoUpgrade(id, preferences, bookingId = null) {
    const res = await apiFetch(`/api/auto-upgrade/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences, bookingId })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to update auto-upgrade monitor');
    }
    invalidateApiCache('/api/auto-upgrade').catch(() => {});
    return res.json();
  },

  async deleteAutoUpgrade(id, gymId = null) {
    const res = await apiFetch(`/api/auto-upgrade/${id}`, {
      method: 'DELETE',
      gymId,
    });
    if (res.ok) invalidateApiCache('/api/auto-upgrade').catch(() => {});
    return res.json();
  },

  // Settings & Preferences
  async getSettings(gymId = null) {
    if (gymId) {
      return withOfflineSnapshot(`settings:${gymId}`, async () => {
        const res = await apiFetch('/api/settings', { gymId });
        if (!res.ok) throw new Error('Failed to load settings');
        return res.json();
      });
    }
    return withOfflineSnapshot('settings:account', async () => {
      const result = await getCachedSWR('/api/settings', { ttlMs: 300000, fetcher: apiFetch });
      return result.data;
    });
  },

  /**
   * Save ONLY the settings you changed — `{ theme: 'dark' }`, not the whole blob.
   *
   * Settings are stored in two places: account-scoped keys belong to the person,
   * everything else belongs to one gym. Sending the whole blob meant every save
   * rewrote the gym half too, with nothing saying WHICH gym — so a theme change
   * silently wrote settings against whichever gym the server happened to pick.
   *
   * Pass `gymId` whenever the patch touches a gym-scoped key; the server refuses
   * to guess one on a multi-gym account (400).
   */
  async updateSettings(patch, gymId = null) {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
      gymId,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to save settings');
    }
    if (res.ok) invalidateApiCache('/api/settings').catch(() => {});
    return res.json();
  },

  // Spot-map preferences were never fanned out across linked gyms (found
  // 2026-09-02, alongside the metadata-collision bugs) — `/api/studio-
  // preferences` resolves to whichever gym is currently ACTIVE server-side,
  // so a merged multi-gym view reading `prefs[studioId]` for a non-active
  // gym's studio got either nothing or (worse, on an id collision) the
  // active gym's preference for an unrelated studio. Fans out like getBookings/
  // getCreditsByGym. The returned object carries BOTH the bare `studioId` key
  // (back-compat for n=1 / single-gym contexts that don't have a gymId to
  // hand) and a `${gymId}:${studioId}` key — callers with a gymId in scope
  // should prefer the qualified key.
  async getStudioPreferences(gymId = null) {
    if (gymId) {
      return withOfflineSnapshot(`studio-preferences:${gymId}`, async () => {
        const res = await apiFetch('/api/studio-preferences', { gymId });
        if (!res.ok) throw new Error('Failed to load studio preferences');
        const data = await res.json();
        const scoped = {};
        Object.entries(data || {}).forEach(([studioId, prefs]) => {
          scoped[studioId] = prefs;
          scoped[`${gymId}:${studioId}`] = prefs;
        });
        return scoped;
      });
    }
    return withOfflineSnapshot('studio-preferences', async () => {
    const myGymsRes = await this.getMyGyms().catch(() => ({ gyms: [] }));
    const linked = myGymsRes.gyms || [];
    if (linked.length <= 1) {
      const result = await getCachedSWR('/api/studio-preferences', { ttlMs: 300000, fetcher: apiFetch });
      return result.data;
    }
    const results = await Promise.all(
      linked.map(async (g) => {
        const gymId = g.gym_id || g.gymId || g.id;
        try {
          const res = await apiFetch('/api/studio-preferences', { gymId });
          if (!res.ok) return null;
          return { gymId, data: await res.json() };
        } catch (err) {
          if (isOfflineForMutation()) throw err;
          return null;
        }
      })
    );
    const merged = {};
    results.filter(Boolean).forEach(({ gymId, data }) => {
      Object.entries(data || {}).forEach(([studioId, prefs]) => {
        merged[studioId] = prefs; // back-compat bare key — last gym processed wins, same as before this fix
        merged[`${gymId}:${studioId}`] = prefs;
      });
    });
    return merged;
    });
  },

  async updateStudioPreferences(studioId, preferences, gymId = null) {
    const res = await apiFetch(`/api/studio-preferences/${studioId}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences }),
      gymId,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to update studio preferences');
    await invalidateApiCache('/api/studio-preferences').catch(() => {});
    await Promise.all([
      deleteOfflineSnapshot('studio-preferences'),
      deleteOfflineSnapshot(`studio-preferences:${gymId || 'default'}`),
    ]);
    try {
      window.dispatchEvent(new CustomEvent('psycle-studio-preferences-mutated', {
        detail: { gymId, studioId, preferences },
      }));
    } catch (_) { /* non-browser test/runtime */ }
    return data;
  },

  // Backup & Import/Export
  async exportConfig() {
    const res = await apiFetch('/api/config/export');
    return res.json();
  },

  async importConfig(configData) {
    const res = await apiFetch('/api/config/import', {
      method: 'POST',
      body: JSON.stringify(configData)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Import failed (${res.status})`);
    invalidateApiCache('').catch(() => {});
    return data;
  },

  // Web Push Notifications
  async getVapidPublicKey() {
    const res = await apiFetch('/api/push/vapid-public-key');
    const data = await res.json();
    return data.publicKey;
  },

  async subscribePush(subscription) {
    const res = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription })
    });
    return res.json();
  },

  async unsubscribePush(endpoint) {
    const res = await apiFetch('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint })
    });
    return res.json();
  },

  async triggerPushTest() {
    const res = await apiFetch('/api/push/test', {
      method: 'POST'
    });
    return res.json();
  },

  // Send a sample of a specific notification type to all devices (debug).
  async triggerPushTestType(type) {
    const res = await apiFetch(`/api/push/test/${encodeURIComponent(type)}`, {
      method: 'POST'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to send test notification');
    }
    return res.json();
  },

  // Report a successful manual/quick booking so the server can fan out a push to all devices.
  async notifyBookingSuccess(ctx) {
    const res = await apiFetch('/api/notify/booking-success', {
      method: 'POST',
      body: JSON.stringify(ctx)
    });
    return res.json();
  },

  // Push freshly-fetched bookings to the server to keep the reminder cache warm.
  // Only syncs gyms that successfully loaded (lastLoadedGymIds), so a transient
  // fetch failure doesn't wipe that gym's reminder cache (C3-x, 2026-10-06).
  async syncBookings(bookings) {
    // Skip sync if nothing loaded (withOfflineSnapshot returned cached snapshot)
    if (lastLoadedGymIds.size === 0) return { success: true };
    const res = await apiFetch('/api/bookings/sync', {
      method: 'POST',
      body: JSON.stringify({ bookings, gymIds: Array.from(lastLoadedGymIds) })
    });
    return res.json();
  },

  // Calendar feed
  async getCalendarStatus(gymId = null) {
    return withOfflineSnapshot('calendar-status', async () => {
      const res = await apiFetch('/api/calendar/status', { gymId });
      if (!res.ok) throw new Error('Failed to load calendar status');
      return res.json();
    });
  },
  async enableCalendar(opts = {}, gymId = null) {
    const res = await apiFetch('/api/calendar/enable', {
      method: 'POST',
      body: JSON.stringify(opts),
      gymId,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to enable calendar');
    return data;
  },
  async disableCalendar(gymId = null) {
    const res = await apiFetch('/api/calendar/disable', { method: 'POST', gymId });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to disable calendar');
    return data;
  },
  async rotateCalendar(gymId = null) {
    const res = await apiFetch('/api/calendar/rotate', { method: 'POST', gymId });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to rotate calendar');
    return data;
  },
  async refreshCalendar(gymId = null) {
    const res = await apiFetch('/api/calendar/refresh', { method: 'POST', gymId });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to refresh calendar');
    return data;
  },

  // NOTE: `addBundleToCart`/`getCart` (a standalone "add to website cart" /
  // "view cart" pair, distinct from the in-app checkout below) were removed
  // here 2026-09-26 (C2-1) — dead code even before the v1→v2 cart migration:
  // no UI ever called them, `/api/cart/add-bundle/:bundleId` called the now-
  // retired v1 `/cart/add_bundle`, and `GET /api/cart` this hit never existed
  // as a server route at all. The website-cart fallback these implied is
  // handled by the static `creditGymWebsiteUrl` link in credits.js instead.

  // In-app checkout: add bundle (qty times) + fetch saved cards
  async checkoutInit(bundleId, quantity = 1, gymId = null) {
    const res = await apiFetch(`/api/cart/checkout/init/${bundleId}`, {
      method: 'POST',
      body: JSON.stringify({ quantity }),
      gymId,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to start checkout');
    }
    return res.json();
  },

  // In-app checkout: set card, place order, await Stripe settlement.
  // Returns { status: 'paid' | 'failed' | 'requires_action', orderId, error }
  async checkoutConfirm(instance, paymentMethodId, gymId = null) {
    const res = await apiFetch('/api/cart/checkout/confirm', {
      method: 'POST',
      body: JSON.stringify({ instance, paymentMethodId }),
      gymId,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Checkout failed');
    }
    return res.json();
  }
};

// Clear API response cache on logout to prevent cross-user data leakage
window.addEventListener('psycle-logout-triggered', () => {
  setCacheKeyPrefix('');
  clearApiCache().catch(() => {});
});
