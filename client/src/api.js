import { debugLog } from './main.js';
import { getCachedSWR, clearApiCache, setCacheKeyPrefix, invalidateApiCache } from './cache.js';

// API Abstraction layer for communicating with the Psycle PWA server

let localToken = localStorage.getItem('psycleLocalToken') || null;

// Active gym context (WP-C1). Persisted per-account so the normalized API can
// tell the server which linked gym a request is scoped to (via the `x-gym-id`
// header). Null until the Phase 5 gym picker sets it — while null the server
// falls back to the default gym (db.resolveActiveGymId), so single-gym Psycle
// users are entirely unaffected (the header isn't even sent).
let activeGymId = localStorage.getItem('sweatActiveGymId') || null;

export function setActiveGymId(gymId) {
  activeGymId = gymId || null;
  if (activeGymId) {
    localStorage.setItem('sweatActiveGymId', activeGymId);
  } else {
    localStorage.removeItem('sweatActiveGymId');
  }
}

export function getActiveGymId() {
  return activeGymId;
}

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

// Invalidate cached proxy GET responses for a given path after a mutation.
// Extracts the base resource (e.g., '/bookings' from '/bookings/123') and
// invalidates all cached entries under '/api/proxy/bookings'.
// Returns a promise — callers MUST await it before reading the cache again,
// otherwise getCachedSWR may return stale data (e.g. profile still showing
// a deleted bookmark).
function invalidateProxyCache(path) {
  const cleanPath = path.split('?')[0];
  const segments = cleanPath.split('/').filter(Boolean);
  const base = segments.length > 0 ? '/' + segments[0] : '';
  return invalidateApiCache('/api/proxy' + base).catch(() => {});
}

// Global fetch wrapper with local auth and Cloudflare Zero Trust Access support
export async function apiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  const headers = {
    'accept': 'application/json',
    ...options.headers
  };

  if (localToken) {
    headers['authorization'] = `Bearer ${localToken}`;
  }

  // Scope the request to the active gym (WP-C1). Only sent when a gym has been
  // selected — omitted entirely for today's single-gym users, so no existing
  // request changes. The server ignores it until real per-request resolution
  // lands (WP-D4); harmless to send in the meantime.
  if (activeGymId) {
    headers['x-gym-id'] = activeGymId;
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
    window.dispatchEvent(new CustomEvent('psycle-network-fail'));
    throw err;
  }

  window.dispatchEvent(new CustomEvent('psycle-network-ok'));

  // A 403 naming an unlinked gym means our stored `x-gym-id` is stale — the gym
  // was unlinked, disabled, or this is a different account on the same browser.
  // Clear it and let the server fall back to its own resolution, otherwise EVERY
  // request 403s and the app looks broken while the account is perfectly fine.
  if (res.status === 403 && activeGymId) {
    const peek = res.clone();
    try {
      const body = await peek.json();
      if (body && /not linked to gym/i.test(body.message || '')) {
        console.warn(`[API] Stored gym "${activeGymId}" is not linked to this account — clearing it.`);
        setActiveGymId(null);
      }
    } catch (_) { /* not JSON; leave the 403 to the caller */ }
  }

  if (res.status === 401 && localToken) {
    // Session expired locally or backend CodexFit token expired
    console.warn('[API] Received 401. Session expired. Logging out.');
    setToken(null);
    window.dispatchEvent(new CustomEvent('psycle-logout-triggered'));
    throw new Error('Your session has expired. Please log in again.');
  }

  return res;
}

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
  // see BACKLOG.md "Account setup & recovery".

  async getStatus() {
    const res = await apiFetch('/api/auth/status');
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
  },

  // CodexFit API Proxy
  async proxyGet(path, options = {}) {
    const { ttlMs } = options;
    debugLog(`GET ${path}`, 'network');
    if (ttlMs) {
      const result = await getCachedSWR(`/api/proxy${path}`, { ttlMs, fetcher: apiFetch });
      return result.data;
    }
    const res = await apiFetch(`/api/proxy${path}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Proxy GET failed: ${res.status}`);
    }
    return res.json();
  },

  async proxyPost(path, body) {
    debugLog(`POST ${path}`, 'network');
    const res = await apiFetch(`/api/proxy${path}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Proxy POST failed: ${res.status}`);
    }
    await invalidateProxyCache(path);
    return res.json();
  },

  async proxyDelete(path) {
    debugLog(`DELETE ${path}`, 'network');
    const res = await apiFetch(`/api/proxy${path}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Proxy DELETE failed: ${res.status}`);
    }
    await invalidateProxyCache(path);
    // CodexFit DELETEs (e.g. bookmark removal) often return 200/204 with an
    // empty or non-JSON body. The extension deliberately ignores the body;
    // we must too — calling res.json() on an empty body throws SyntaxError,
    // which would prevent refreshUserData() from running and leave the UI
    // showing the stale (still-bookmarked) state.
    if (res.status === 204) return {};
    try {
      return await res.json();
    } catch {
      return {};
    }
  },

  async proxyPut(path, body = {}) {
    debugLog(`PUT ${path}`, 'network');
    const res = await apiFetch(`/api/proxy${path}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Proxy PUT failed: ${res.status}`);
    }
    await invalidateProxyCache(path);
    // Some CodexFit PUTs (e.g. bookmark add) may return an empty or non-JSON
    // body — tolerate it so the caller's await doesn't throw and block the
    // subsequent refreshUserData() / re-render.
    try {
      return await res.json();
    } catch {
      return {};
    }
  },

  // ---- Normalized gym-agnostic API (WP-C1) ----------------------------------
  // New surface backed by server/routes-normalized.js (provider adapters).
  // Returns NormalizedEvent / NormalizedSlot / NormalizedProfile /
  // NormalizedBookingResult shapes (see server/providers/base.js), independent
  // of the underlying gym platform. The legacy proxyGet/Post/... methods above
  // still back the live Psycle UI; modules migrate onto these incrementally
  // (WP-C1/N2), keeping the proxy shim during the transition. Do NOT rip out
  // the proxy methods until every caller has moved and the real app is verified
  // end-to-end in a browser (see AGENT_INSTRUCTIONS §7).

  // Public gym registry + capability flags (for the Phase 5 gym picker).
  async getGyms() {
    const res = await apiFetch('/api/gyms');
    if (!res.ok) throw new Error('Failed to load gyms');
    const data = await res.json();
    return data.gyms || [];
  },

  // The gyms THIS account is linked to, plus which one is currently active.
  // `getGyms()` above is the public catalogue of everything configured; this is
  // the per-account view the switcher renders from.
  async getMyGyms() {
    const res = await apiFetch('/api/my-gyms');
    if (!res.ok) throw new Error('Failed to load your gyms');
    return res.json(); // { gyms: [...], activeGymId }
  },

  // Persist the user's gym choice server-side AND locally — the server resolves
  // sessions/credentials from its copy, the local one sets the `x-gym-id` header
  // on subsequent requests. Both must move together or the next request asks for
  // one gym while the server believes another is active.
  async setActiveGym(gymId) {
    const res = await apiFetch('/api/my-gyms/active', {
      method: 'POST',
      body: JSON.stringify({ gymId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not switch gym');
    setActiveGymId(data.activeGymId);
    return data.activeGymId;
  },

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
    const suffix = qs.toString() ? `?${qs}` : '';
    const endpoint = `/api/timetable${suffix}`;
    debugLog(`GET ${endpoint}`, 'network');
    if (params.ttlMs) {
      const result = await getCachedSWR(endpoint, { ttlMs: params.ttlMs, fetcher: apiFetch });
      return (result.data && result.data.events) || [];
    }
    const res = await apiFetch(endpoint);
    if (!res.ok) throw new Error('Failed to load timetable');
    const data = await res.json();
    return data.events || [];
  },

  // The four timetable filter lists, gym-agnostic (WP-D9). Replaces four raw
  // /api/proxy reads that only worked because they were CodexFit endpoints —
  // MarianaTek has none of them and derives all four from its class list.
  // Returns { locations, studios, instructors, classTypes }.
  async getMetadata(params = {}) {
    const qs = new URLSearchParams();
    if (params.startDate) qs.set('startDate', params.startDate);
    if (params.endDate) qs.set('endDate', params.endDate);
    const endpoint = `/api/metadata${qs.toString() ? `?${qs}` : ''}`;
    debugLog(`GET ${endpoint}`, 'network');
    if (params.ttlMs) {
      const result = await getCachedSWR(endpoint, { ttlMs: params.ttlMs, fetcher: apiFetch });
      return result.data || { locations: [], studios: [], instructors: [], classTypes: [] };
    }
    const res = await apiFetch(endpoint);
    if (!res.ok) throw new Error('Failed to load timetable metadata');
    return res.json();
  },

  // Returns { event: NormalizedEvent, slots: NormalizedSlot[] } (slots [] for FCFS).
  async getEventDetails(eventId) {
    debugLog(`GET /api/events/${eventId}`, 'network');
    const res = await apiFetch(`/api/events/${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error('Failed to load event details');
    return res.json();
  },

  // Returns NormalizedSlot[] (empty if the studio has no floor map — see
  // GymProvider.fetchStudioLayout doc comment; not an error case).
  // Returns { slots: NormalizedSlot[], objects: NormalizedLayoutObject[] }.
  // Empty `slots` means "no floor map available for this studio", not an error.
  async getStudioLayout(studioId) {
    debugLog(`GET /api/studios/${studioId}/layout`, 'network');
    const res = await apiFetch(`/api/studios/${encodeURIComponent(studioId)}/layout`);
    if (!res.ok) throw new Error('Failed to load studio layout');
    const data = await res.json();
    return { slots: data.slots || [], objects: data.objects || [] };
  },

  // Returns a NormalizedBookingResult { ok, bookingId, slotId, error?, status? }.
  async book(eventId, slotIds = []) {
    const res = await apiFetch('/api/book', {
      method: 'POST',
      body: JSON.stringify({ eventId, slotIds })
    });
    return res.json();
  },

  // cancel / joinWaitlist / leaveWaitlist are COMMANDS: they either happen or
  // they don't, so they throw on refusal rather than returning a flag. That
  // matches what every caller was written against (the raw proxy threw), and it
  // means a failed cancel can never render a success toast.
  //
  // `book` deliberately does NOT throw — a decline there carries information the
  // caller needs (which spot, why), so it returns a NormalizedBookingResult.
  async _command(endpoint, body, whatFailed) {
    const res = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.error || `${whatFailed} failed`);
    }
    return data;
  },

  async cancel(bookingId) {
    return this._command('/api/cancel', { bookingId }, 'Cancelling');
  },

  // Returns { isPenalty, message? } — prefer provider truth over client window math.
  async getCancelPenalty(bookingId) {
    const res = await apiFetch(`/api/cancel-penalty/${encodeURIComponent(bookingId)}`);
    if (!res.ok) throw new Error('Failed to check cancel penalty');
    return res.json();
  },

  async joinWaitlist(eventId) {
    return this._command('/api/waitlist/join', { eventId }, 'Joining the waitlist');
  },

  async leaveWaitlist(eventId) {
    return this._command('/api/waitlist/leave', { eventId }, 'Leaving the waitlist');
  },

  async swapSpot(bookingId, currentSlotId, targetSlotId) {
    const res = await apiFetch('/api/swap', {
      method: 'POST',
      body: JSON.stringify({ bookingId, currentSlotId, targetSlotId })
    });
    return res.json(); // NormalizedBookingResult
  },

  // Returns NormalizedBooking[], .event populated for both providers (fixed
  // 2026-07-03 for CodexFit — see providers/codexfit.js listBookings doc
  // comment — it resolves via the response's embedded `relations` block when
  // not already inline). bookings.js's renderBookings() is the first caller.
  async getBookings() {
    debugLog('GET /api/bookings', 'network');
    const res = await apiFetch('/api/bookings');
    if (!res.ok) throw new Error('Failed to load bookings');
    const data = await res.json();
    return data.bookings || [];
  },

  async getWaitlists() {
    debugLog('GET /api/waitlists', 'network');
    const res = await apiFetch('/api/waitlists');
    if (!res.ok) throw new Error('Failed to load waitlists');
    const data = await res.json();
    return data.waitlists || [];
  },

  async getNormalizedProfile() {
    const res = await apiFetch('/api/profile');
    if (!res.ok) throw new Error('Failed to load profile');
    return res.json();
  },

  async getNormalizedCredits() {
    const res = await apiFetch('/api/credits');
    if (!res.ok) throw new Error('Failed to load credits');
    const data = await res.json();
    return data.credits || [];
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
    return res.json();
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

  async updateAutoUpgrade(id, preferences) {
    const res = await apiFetch(`/api/auto-upgrade/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to update auto-upgrade monitor');
    }
    invalidateApiCache('/api/auto-upgrade').catch(() => {});
    return res.json();
  },

  async deleteAutoUpgrade(id) {
    const res = await apiFetch(`/api/auto-upgrade/${id}`, {
      method: 'DELETE'
    });
    if (res.ok) invalidateApiCache('/api/auto-upgrade').catch(() => {});
    return res.json();
  },

  // Settings & Preferences
  async getSettings() {
    const result = await getCachedSWR('/api/settings', { ttlMs: 300000, fetcher: apiFetch });
    return result.data;
  },

  async updateSettings(settings) {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    });
    if (res.ok) invalidateApiCache('/api/settings').catch(() => {});
    return res.json();
  },

  async getStudioPreferences() {
    const result = await getCachedSWR('/api/studio-preferences', { ttlMs: 300000, fetcher: apiFetch });
    return result.data;
  },

  async updateStudioPreferences(studioId, preferences) {
    const res = await apiFetch(`/api/studio-preferences/${studioId}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences })
    });
    if (res.ok) invalidateApiCache('/api/studio-preferences').catch(() => {});
    return res.json();
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
    if (res.ok) invalidateApiCache('').catch(() => {});
    return res.json();
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
  async syncBookings(bookings) {
    const res = await apiFetch('/api/bookings/sync', {
      method: 'POST',
      body: JSON.stringify({ bookings })
    });
    return res.json();
  },

  // Calendar feed
  async getCalendarStatus() {
    const res = await apiFetch('/api/calendar/status');
    return res.json();
  },
  async enableCalendar(opts = {}) {
    const res = await apiFetch('/api/calendar/enable', {
      method: 'POST',
      body: JSON.stringify(opts)
    });
    return res.json();
  },
  async disableCalendar() {
    const res = await apiFetch('/api/calendar/disable', { method: 'POST' });
    return res.json();
  },
  async rotateCalendar() {
    const res = await apiFetch('/api/calendar/rotate', { method: 'POST' });
    return res.json();
  },
  async refreshCalendar() {
    const res = await apiFetch('/api/calendar/refresh', { method: 'POST' });
    return res.json();
  },

  // Cart
  async addBundleToCart(bundleId, quantity = 1) {
    const res = await apiFetch(`/api/cart/add-bundle/${bundleId}`, {
      method: 'POST',
      body: JSON.stringify({ quantity })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to add bundle to cart');
    }
    invalidateApiCache('/api/cart').catch(() => {});
    return res.json();
  },

  async getCart() {
    const result = await getCachedSWR('/api/cart', { ttlMs: 120000, fetcher: apiFetch });
    return result.data;
  },

  // In-app checkout: add bundle (qty times) + fetch saved cards
  async checkoutInit(bundleId, quantity = 1) {
    const res = await apiFetch(`/api/cart/checkout/init/${bundleId}`, {
      method: 'POST',
      body: JSON.stringify({ quantity })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to start checkout');
    }
    return res.json();
  },

  // In-app checkout: set card, place order, await Stripe settlement.
  // Returns { status: 'paid' | 'failed' | 'requires_action', orderId, error }
  async checkoutConfirm(instance, paymentMethodId) {
    const res = await apiFetch('/api/cart/checkout/confirm', {
      method: 'POST',
      body: JSON.stringify({ instance, paymentMethodId })
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
