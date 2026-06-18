import { debugLog } from './main.js';

// API Abstraction layer for communicating with the Psycle PWA server

let localToken = localStorage.getItem('psycleLocalToken') || null;

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

  if (options.body && !(options.body instanceof FormData)) {
    headers['content-type'] = 'application/json';
  }

  const fetchOptions = {
    ...options,
    headers,
    // Same-origin ensures the browser forwards Cloudflare Zero Trust (CF_Authorization) cookies
    credentials: 'same-origin'
  };

  const res = await fetch(url, fetchOptions);

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

  async getStatus() {
    const res = await apiFetch('/api/auth/status');
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
  },

  // CodexFit API Proxy
  async proxyGet(path) {
    debugLog(`GET ${path}`, 'network');
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
    return res.json();
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
    return res.json();
  },

  // Auto-Book Queue
  async getAutoBookings() {
    const res = await apiFetch('/api/auto-book');
    return res.json();
  },

  async addAutoBooking(bookingData) {
    const res = await apiFetch('/api/auto-book', {
      method: 'POST',
      body: JSON.stringify(bookingData)
    });
    return res.json();
  },

  async updateAutoBooking(id, preferences) {
    const res = await apiFetch(`/api/auto-book/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences })
    });
    return res.json();
  },

  async deleteAutoBooking(id) {
    const res = await apiFetch(`/api/auto-book/${id}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  async simulateRelease() {
    const res = await apiFetch('/api/simulate-release', { method: 'POST' });
    return res.json();
  },

  // Auto-Upgrade
  async getAutoUpgrades() {
    const res = await apiFetch('/api/auto-upgrade');
    return res.json();
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
    return res.json();
  },

  async deleteAutoUpgrade(id) {
    const res = await apiFetch(`/api/auto-upgrade/${id}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  // Settings & Preferences
  async getSettings() {
    const res = await apiFetch('/api/settings');
    return res.json();
  },

  async updateSettings(settings) {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    });
    return res.json();
  },

  async getStudioPreferences() {
    const res = await apiFetch('/api/studio-preferences');
    return res.json();
  },

  async updateStudioPreferences(studioId, preferences) {
    const res = await apiFetch(`/api/studio-preferences/${studioId}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences })
    });
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
    return res.json();
  },

  async getCart() {
    const res = await apiFetch('/api/cart');
    return res.json();
  }
};
