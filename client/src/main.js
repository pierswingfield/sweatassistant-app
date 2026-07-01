import { api, setToken, isLoggedIn } from './api';
import { initTooltips } from './ui/tooltips';
import { setupPullToRefresh } from './ui/pulltorefresh';
import { setCacheKeyPrefix, clearApiCache, invalidateApiCache } from './cache.js';
import { appConfig, initConfig } from './config';
import { shouldShowOnboarding, resumeOnboarding, isOnboardingActive, advanceAfterLogin } from './ui/onboarding';
import { detectBookingWindow } from './lib';

// --- PWA install prompt capture ---
// Android/desktop Chromium fire `beforeinstallprompt` before the page is ready
// to act on it. Stash the event so the onboarding install step can trigger a
// native one-tap install. iOS never fires this — that path uses manual steps.
let installPromptEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPromptEvent = e;
});
// Returns the captured prompt event once, then clears it (it's single-use).
export function consumeInstallPrompt() {
  const e = installPromptEvent;
  installPromptEvent = null;
  return e;
}

// Warm the caches the app needs to feel instant after onboarding: timetable
// (also feeds the active-studio list for spot maps) and the Auto-Book tab data.
export async function warmCaches() {
  try {
    const { prefetchTimetableData } = await import('./ui/timetable');
    prefetchTimetableData().catch(() => {});
  } catch (_) {}
  import('./ui/autobook').then(m => m.prefetchAutoBookData()).catch(() => {});
}

// Propagate the app name from the single source of truth (app.config.json at
// build time, /api/config at runtime) to all user-visible static surfaces that
// can't import it at runtime. initConfig() is called in checkAuth() to override
// the build-time default with the server's configured value.
const appleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');

// Propagate the configured app name to the document title, the iOS web-app
// title meta, and every static [data-app-name] span in the SPA shell. The
// variable is the primary source; the server-side template-replace of the
// literal "Psycle Assistant" remains only as a no-JS fallback.
function applyAppName() {
  document.title = appConfig.appName;
  if (appleMeta) appleMeta.setAttribute('content', appConfig.appName);
  document.querySelectorAll('[data-app-name]').forEach((el) => {
    el.textContent = appConfig.appName;
  });
}

applyAppName();

// Default settings — the single source of truth for new-user defaults.
// Reset to this on logout so a new user never inherits the previous user's settings.
const DEFAULT_SETTINGS = {
  detectedBookingOffset: null,    // auto-detected booking window in days (null until detected)
  manualBookingWindowWeeks: null, // debug-only override (1-4 weeks), null = use detected
  autoUpgradeEnabled: true,
  autoUpgradeInterval: '15min',
  autoUpgradeByDefault: true,     // auto-upgrade spots after every booking by default
  autoUpgradeKeepOriginalByDefault: false,
  debugMode: false,
  prefetchWeeks: 4
};

// Global App State
export let currentUser = null;
export let userSettings = { ...DEFAULT_SETTINGS };

// UI Cache data to avoid constant reloading
export let cache = {
  profile: null,
  bookings: [],
  waitlists: [],
  bundles: [],
  timetable: {}, // keyed by date string
  autoBookings: null, // prefetch target for Auto-Book tab
  upgrades: undefined, // prefetch target for Auto-Book/Auto-Upgrade
  studioPrefs: null, // prefetch target for Auto-Book/Auto-Upgrade
  bookingWindow: null // last detected booking window { offsetDays, weeks, cutoffISO, ... }
};

// --- THEME (Auto / Light / Dark) ---
// 'auto' follows the OS via prefers-color-scheme; 'light'/'dark' force via data-theme.
const THEME_KEY = 'psycleTheme';

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'auto';
}

export function applyTheme(mode = getTheme()) {
  const root = document.documentElement;
  let effective;
  if (mode === 'light' || mode === 'dark') {
    root.setAttribute('data-theme', mode);
    effective = mode;
  } else {
    root.removeAttribute('data-theme'); // auto → CSS prefers-color-scheme decides
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  // Sync all theme-color meta tags with the app's actual (possibly overridden)
  // theme so the iOS notch / status-bar area matches the app background instead
  // of the OS theme. Without this, a user in light mode on a dark-mode phone
  // gets a black notch over a light app. The media-query-based tags in
  // index.html handle the initial render; this JS override keeps them in sync
  // for manual light/dark modes and OS-theme changes.
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  const color = effective === 'dark' ? '#090d16' : '#f5f2ec';
  metas.forEach(m => m.setAttribute('content', color));
}

export function setTheme(mode) {
  if (mode === 'auto') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
}

// Apply persisted choice immediately (before first paint of the app shell).
applyTheme();

// Re-sync theme-color when the OS theme changes (only matters in 'auto' mode,
// where the app follows the system and the notch colour must follow too).
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'auto') applyTheme('auto');
});

// --- TOAST NOTIFICATIONS ---
export function showToast(message, type = 'info') {
  const container = document.getElementById('psycle-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `psycle-toast ${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';

  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message">${message}</span>`;
  container.appendChild(toast);

  // Animate in
  setTimeout(() => toast.classList.add('show'), 10);

  // Remove after 3.5 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// --- DEBUG LOG TERMINAL ---
let debugLogExpanded = true;

export function debugLog(message, type = 'info') {
  if (!userSettings.debugMode) return;
  
  const logEl = document.getElementById('psycle-debug-log');
  const terminal = document.getElementById('psycle-debug-terminal');
  if (!logEl || !terminal) return;
  
  terminal.style.display = 'block';
  
  const timestamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const colors = {
    info: 'var(--text-secondary)',
    success: 'var(--success)',
    error: 'var(--danger)',
    warning: 'var(--warning)',
    network: 'var(--info)',
    action: 'var(--feat-autoupgrade)'
  };
  const color = colors[type] || colors.info;
  const prefix = type === 'network' ? '→' : type === 'action' ? '⚡' : type === 'error' ? '✕' : type === 'success' ? '✓' : '•';
  
  const line = document.createElement('div');
  line.style.cssText = `margin: 2px 0; line-height: 1.4; word-break: break-all;`;
  line.innerHTML = `<span style="color: var(--text-tertiary);">${timestamp}</span> <span style="color: ${color};">${prefix}</span> <span style="color: ${color};">${message}</span>`;
  logEl.appendChild(line);
  
  // Keep max 200 entries
  while (logEl.children.length > 200) {
    logEl.removeChild(logEl.firstChild);
  }
  
  if (debugLogExpanded) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// Developer console logging, gated behind debug mode so production consoles
// stay quiet. Use for diagnostics that don't belong in the on-screen debug
// terminal (e.g. raw payload dumps during the auto-upgrade flow).
export function debugConsole(...args) {
  if (userSettings.debugMode) console.log(...args);
}

export function updateDebugTerminalVisibility() {
  const terminal = document.getElementById('psycle-debug-terminal');
  if (!terminal) return;
  terminal.style.display = userSettings.debugMode ? 'block' : 'none';
}

// --- TAB ROUTING ---
const tabButtons = document.querySelectorAll('.psycle-nav-btn');
const panels = document.querySelectorAll('.psycle-tab-content');

// Expose on window so inline onclick handlers (e.g. "Buy Credits" button in timetable) can call it
window.switchTab = switchTab;

const VALID_TABS = ['class-timetable', 'my-bookings', 'auto-book', 'buy-credits', 'settings'];

// The currently active tab — used by the shared pull-to-refresh dispatcher.
let currentTabId = null;

function switchTab(tabId) {
  currentTabId = tabId;
  const targetPanelId = `psycle-panel-${tabId}`;

  // Update nav buttons (top, bottom, and subnav share the .psycle-nav-btn class).
  // data-tab-group lets one button (e.g. the merged mobile Settings tab) stay
  // active across several tab ids (settings + about).
  tabButtons.forEach(btn => {
    const group = btn.getAttribute('data-tab-group');
    const match = btn.getAttribute('data-tab') === tabId
      || (group && group.split(' ').includes(tabId));
    btn.classList.toggle('active', match);
  });

  // Update panels
  panels.forEach(panel => {
    if (panel.id === targetPanelId) {
      panel.style.display = 'flex';
    } else {
      panel.style.display = 'none';
    }
  });

  // Persist tab in URL hash so refresh restores location
  if (history.replaceState) {
    history.replaceState(null, '', `#${tabId}`);
  }

  // Trigger tab-specific loading/rendering
  triggerTabRender(tabId);
}

async function triggerTabRender(tabId) {
  try {
    if (tabId === 'class-timetable') {
      const { initTimetable } = await import('./ui/timetable');
      initTimetable();
    } else if (tabId === 'my-bookings') {
      const { renderBookings } = await import('./ui/bookings');
      renderBookings();
    } else if (tabId === 'auto-book') {
      const { initAutoBook } = await import('./ui/autobook');
      initAutoBook();
    } else if (tabId === 'buy-credits') {
      refreshUserData(true); // fire-and-forget — update credit badge with fresh counts
      const { initBundles } = await import('./ui/credits');
      initBundles();
    } else if (tabId === 'settings') {
      const { initSettings } = await import('./ui/settings');
      initSettings();
    }
  } catch (err) {
    console.error(`Error rendering tab ${tabId}:`, err);
    showToast(`Error opening tab: ${err.message}`, 'error');
  }
}

// Attach Tab Navigation Listeners
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    switchTab(tabId);
  });
});

// --- PULL-TO-REFRESH ---
// On mobile the whole app scrolls inside a single <main class="psycle-body"> — the
// individual tab panels (#psycle-timetable-grid etc.) grow to fit content and never
// scroll themselves, so their scrollTop is always 0. Attaching pull-to-refresh to
// those panels made every downward drag read as "at the top" and fire a refresh.
// Instead, attach ONE pull-to-refresh to the real scroll container and dispatch the
// refresh action based on which tab is active.
async function refreshActiveTab() {
  try {
    if (currentTabId === 'class-timetable') {
      // Events are fetched without TTL (always fresh), but bookings/waitlists
      // use a 2-min API cache — invalidate so the refresh is a true reload.
      // Profile too, so the credit badge updates on refresh.
      await invalidateApiCache('/api/proxy/bookings');
      await invalidateApiCache('/api/proxy/waitlists');
      await invalidateApiCache('/api/proxy/profile');
      const { prefetchTimetableData } = await import('./ui/timetable');
      await prefetchTimetableData(true);
      refreshUserData(true); // fire-and-forget badge update
    } else if (currentTabId === 'my-bookings') {
      await invalidateApiCache('/api/proxy/bookings');
      await invalidateApiCache('/api/proxy/waitlists');
      await invalidateApiCache('/api/auto-upgrade');
      await invalidateApiCache('/api/proxy/profile');
      const { renderBookings } = await import('./ui/bookings');
      await renderBookings();
      refreshUserData(true); // fire-and-forget badge update
    } else if (currentTabId === 'auto-book') {
      await invalidateApiCache('/api/auto-book');
      await invalidateApiCache('/api/auto-upgrade');
      await invalidateApiCache('/api/proxy/profile');
      await invalidateApiCache('/api/settings');
      const { refreshAutoBookTab } = await import('./ui/autobook');
      await refreshAutoBookTab();
    } else if (currentTabId === 'buy-credits') {
      await invalidateApiCache('/api/proxy/bundles');
      await invalidateApiCache('/api/proxy/profile');
      cache.bundles = [];
      const { initBundles } = await import('./ui/credits');
      await initBundles();
      refreshUserData(true); // fire-and-forget badge update
    } else if (currentTabId === 'settings') {
      // Re-fetch settings from the server so the refresh is a true data reload,
      // not just a re-application of in-memory state.
      await invalidateApiCache('/api/settings');
      const settings = await api.getSettings();
      if (settings && Object.keys(settings).length > 0) {
        Object.assign(userSettings, settings);
      }
      const { initSettings } = await import('./ui/settings');
      await initSettings();
    }
  } catch (err) {
    console.error('[PullToRefresh] refreshActiveTab failed:', err);
  }
}

const scrollBody = document.querySelector('main.psycle-body');
if (scrollBody) {
  setupPullToRefresh(scrollBody, refreshActiveTab);
}

// --- TAB REFRESH BUTTONS ---
document.querySelectorAll('.psycle-tab-refresh-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('refreshing')) return;
    btn.classList.add('refreshing');
    try {
      await refreshActiveTab();
    } finally {
      btn.classList.remove('refreshing');
    }
  });
});

// --- SERVICE WORKER & PUSH REGISTRATION ---
let serviceWorkerRegistration = null;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    serviceWorkerRegistration = reg;
    debugConsole('[SW] Service Worker registered successfully scope:', reg.scope);
    
    // Listen for messages from the service worker (e.g. push notification deep links)
    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (!event.data) return;
      if (event.data.type === 'NAVIGATE') {
        window.location.hash = event.data.hash;
      } else if (event.data.type === 'PUSH_RECEIVED') {
        // If we are on the bookings tab, refresh it automatically so they see the new spot
        if (window.location.hash === '#my-bookings') {
          try {
            const { renderBookings } = await import('./ui/bookings');
            renderBookings();
          } catch (e) {
            console.warn('[App] Failed to auto-refresh bookings after push', e);
          }
        }
      }
    });
    
    updatePushStatusUI();
  } catch (err) {
    console.error('[SW] Service Worker registration failed:', err);
    updatePushStatusUI();
  }
}

export async function updatePushStatusUI() {
  const toggleBtn = document.getElementById('psycle-push-toggle-btn');
  const statusDesc = document.getElementById('psycle-push-status-desc');
  if (!toggleBtn || !statusDesc) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  // If SW not yet registered in this session, try to get existing registration (e.g. page reload)
  if (!serviceWorkerRegistration && 'serviceWorker' in navigator) {
    try {
      const existing = await navigator.serviceWorker.getRegistration('/');
      if (existing) serviceWorkerRegistration = existing;
    } catch (_) {}
  }

  if (!serviceWorkerRegistration) {
    if (isIOS && !isStandalone) {
      toggleBtn.textContent = 'Requires Install';
      toggleBtn.disabled = true;
      statusDesc.textContent = 'Add this app to your Home Screen to enable push notifications on iOS. Tap the Share button, then "Add to Home Screen".';
    } else {
      toggleBtn.textContent = 'Unsupported';
      toggleBtn.disabled = true;
      statusDesc.textContent = 'Push notifications are not supported on this browser/device.';
    }
    return;
  }

  if (!('PushManager' in window)) {
    if (isIOS && isStandalone) {
      toggleBtn.textContent = 'Unsupported';
      toggleBtn.disabled = true;
      statusDesc.textContent = 'Push notifications require iOS 16.4 or later. Please update your device.';
    } else {
      toggleBtn.textContent = 'Unsupported';
      toggleBtn.disabled = true;
      statusDesc.textContent = 'Push notifications are not supported on this browser/device.';
    }
    return;
  }

  const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
  if (subscription) {
    toggleBtn.textContent = 'Disable Push';
    toggleBtn.className = 'psycle-btn-mini success';
    statusDesc.textContent = 'Push notifications are enabled on this device!';
  } else {
    toggleBtn.textContent = 'Enable Push';
    toggleBtn.className = 'psycle-btn-mini';
    statusDesc.textContent = 'Click to enable Web Push alerts on auto-bookings and upgrades.';
  }
}

// Convert URL-safe base64 string to Uint8Array for VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function togglePushSubscription() {
  if (!serviceWorkerRegistration) return;

  try {
    const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
    const toggleBtn = document.getElementById('psycle-push-toggle-btn');
    toggleBtn.disabled = true;

    if (subscription) {
      // Unsubscribe
      await subscription.unsubscribe();
      await api.unsubscribePush(subscription.endpoint);
      showToast('Push notifications disabled.', 'info');
    } else {
      // Request permissions
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Push notification permission denied by user.');
      }

      // Get VAPID public key from server
      const vapidKeyStr = await api.getVapidPublicKey();
      const convertedKey = urlBase64ToUint8Array(vapidKeyStr);

      // Subscribe on push server
      const newSub = await serviceWorkerRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey
      });

      // Save on server
      await api.subscribePush(newSub);
      showToast('Push notifications enabled successfully! 🔔', 'success');
      
      // Fire a test push to verify it works
      setTimeout(() => api.triggerPushTest(), 500);
    }
  } catch (err) {
    console.error('[Push] Toggle failed:', err);
    showToast(err.message, 'error');
  } finally {
    const toggleBtn = document.getElementById('psycle-push-toggle-btn');
    toggleBtn.disabled = false;
    updatePushStatusUI();
  }
}

// --- CREDIT BADGE UPDATE ---

export function updateCreditBadge(availableCredits = null) {
  const credits = availableCredits || cache.credits || [];
  const creditsContainer = document.getElementById('psycle-header-credits');

  if (!creditsContainer) return;

  creditsContainer.innerHTML = '';

  const counts = {};
  credits.forEach(c => {
    if (c.count > 0 && c.credit_type) {
      const name = c.credit_type.name || 'Credits';
      counts[name] = (counts[name] || 0) + c.count;
    }
  });

  const totalCredits = Object.values(counts).reduce((sum, count) => sum + count, 0);

  // Create main counter badge
  const mainBadge = document.createElement('button');
  mainBadge.className = 'psycle-credit-badge';
  mainBadge.style.cssText = `
    cursor: pointer;
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    border: none;
  `;
  mainBadge.innerHTML = `<strong>${totalCredits}</strong> Credit${totalCredits !== 1 ? 's' : ''} available`;
  mainBadge.onclick = () => { if (totalCredits > 0) showCreditDetailsModal(credits); };
  creditsContainer.appendChild(mainBadge);

  debugLog(`Credits updated: ${totalCredits} total`, 'info');
}

// --- CREDIT DETAILS MODAL ---

async function showCreditDetailsModal(credits) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: color-mix(in srgb, var(--bg) 60%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: color-mix(in srgb, var(--bg) 95%, transparent);
    border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
    border-radius: 16px;
    padding: 24px;
    max-width: 450px;
    max-height: 80vh;
    overflow-y: auto;
    color: var(--text);
  `;

  let html = `<h2 style="margin-top: 0; color: var(--feat-autoupgrade); font-size: 18px;">Credit Details</h2>`;
  html += `<div class="psycle-spinner" style="margin: 20px auto;"></div>`;

  content.innerHTML = html;
  modal.appendChild(content);
  document.body.appendChild(modal);

  try {
    // Fetch detailed credits from API
    const res = await api.proxyGet('/credits?type=unused&per_page=999');
    const creditsData = res.data || [];
    const creditTypes = res.relations?.credit_types || {};

    content.innerHTML = `<h2 style="margin-top: 0; color: var(--feat-autoupgrade); font-size: 18px;">Credit Details</h2>`;

    if (!creditsData || creditsData.length === 0) {
      content.innerHTML += `<p style="color: var(--text-secondary);">No credits available.</p>`;
    } else {
      // Group credits by type
      const groupedCredits = {};
      creditsData.forEach(credit => {
        const typeId = credit.credit_type_id;
        const typeInfo = creditTypes.find(t => t.id === typeId);
        const typeName = typeInfo?.name || 'Credits';

        if (!groupedCredits[typeName]) {
          groupedCredits[typeName] = [];
        }
        groupedCredits[typeName].push(credit);
      });

      // Render grouped credits
      Object.entries(groupedCredits).forEach(([typeName, typeCredits]) => {
        const total = typeCredits.length;
        const html_section = `
          <div style="margin-bottom: 16px; padding: 12px; background: color-mix(in srgb, var(--feat-autoupgrade) 5%, transparent); border-radius: 8px; border-left: 3px solid var(--feat-autoupgrade);">
            <div style="font-weight: 600; color: var(--feat-autoupgrade); margin-bottom: 8px;">${typeName}: <strong>${total}</strong></div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              ${typeCredits.map(c => {
                const expiryDate = c.expires_at
                  ? new Date(c.expires_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
                  : 'No expiry';
                const isExpired = c.expires_at && new Date(c.expires_at) < new Date();
                const expiryColor = isExpired ? 'var(--danger)' : 'var(--text-secondary)';
                return `<div style="margin-bottom: 6px; color: ${expiryColor};">• 1 credit (Expires: ${expiryDate})</div>`;
              }).join('')}
            </div>
          </div>
        `;
        content.innerHTML += html_section;
      });
    }

    content.innerHTML += `<button id="close-credit-modal" class="psycle-btn" style="width: 100%; margin-top: 16px; background: color-mix(in srgb, var(--text) 6%, transparent); border: 1px solid color-mix(in srgb, var(--text) 15%, transparent); color: var(--text);">Close</button>`;

  } catch (err) {
    console.error('[Credits] Failed to load details:', err);
    content.innerHTML = `
      <h2 style="margin-top: 0; color: var(--feat-autoupgrade); font-size: 18px;">Credit Details</h2>
      <p style="color: var(--danger);">Failed to load credit details: ${err.message}</p>
      <button id="close-credit-modal" class="psycle-btn" style="width: 100%; margin-top: 16px; background: color-mix(in srgb, var(--text) 6%, transparent); border: 1px solid color-mix(in srgb, var(--text) 15%, transparent); color: var(--text);">Close</button>
    `;
  }

  const closeBtn = content.querySelector('#close-credit-modal');
  closeBtn.onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

// --- OFFLINE CONNECTIVITY ---
let isOffline = false;
let probeTimeout = null;

function setOffline(reason) {
  if (isOffline) return;
  isOffline = true;
  document.documentElement.classList.add('psycle-offline');
  showOfflineBanner(reason);
  debugLog(`Offline: ${reason}`, 'warning');
}

function setOnline() {
  if (!isOffline) return;
  isOffline = false;
  document.documentElement.classList.remove('psycle-offline');
  hideOfflineBanner();
  debugLog('Back online', 'success');
}

function showOfflineBanner(reason) {
  const banner = document.getElementById('psycle-offline-banner');
  if (!banner) return;
  const textSpan = banner.querySelector('.offline-text');
  if (textSpan) {
    textSpan.textContent = "You're offline! Some features are unavailable.";
  }
  if (banner.style.display === 'flex') return;
  banner.style.display = 'flex';
  void banner.offsetHeight;
  banner.classList.add('show');
}

function hideOfflineBanner() {
  const banner = document.getElementById('psycle-offline-banner');
  if (!banner) return;
  banner.classList.remove('show');
  setTimeout(() => {
    if (!isOffline) {
      banner.style.display = 'none';
    }
  }, 350);
}

function probeConnectivity() {
  if (probeTimeout) {
    clearTimeout(probeTimeout);
  }
  probeTimeout = setTimeout(async () => {
    const token = localStorage.getItem('psycleLocalToken');
    if (!token) {
      if (navigator.onLine) setOnline();
      return;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('/api/auth/status', {
        headers: { Authorization: 'Bearer ' + token },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        setOnline();
      }
    } catch (err) {
      // Stay offline — probe failed
    }
  }, 500);
}

export function getIsOffline() {
  return isOffline;
}

function initConnectivity() {
  const container = document.getElementById('psycle-app-container');
  if (!container) return;
  if (document.getElementById('psycle-offline-banner')) return;

  const banner = document.createElement('div');
  banner.className = 'psycle-offline-banner';
  banner.id = 'psycle-offline-banner';
  banner.style.display = 'none';
  banner.innerHTML = '<span class="offline-icon">⚠</span><span class="offline-text"></span>';
  container.insertBefore(banner, container.firstChild);

  window.addEventListener('offline', () => setOffline('browser'));
  window.addEventListener('online', () => probeConnectivity());
  window.addEventListener('psycle-network-fail', () => setOffline('network-error'));
  window.addEventListener('psycle-network-ok', () => probeConnectivity());

  if (!navigator.onLine) {
    setOffline('initial');
  }
}

// --- INITIALIZATION & USER SESSION ---

// Fetch core user data and update UI header. Pass force=true after mutations
// (booking, cancellation, spot edits) to bypass the 5-min profile cache and
// fetch fresh credit counts from CodexFit.
export async function refreshUserData(force = false) {
  try {
    if (force) {
      await invalidateApiCache('/api/proxy/profile');
    }
    // 1. Fetch user profile from CodexFit via proxy
    const res = await api.proxyGet('/profile', { ttlMs: 300000 });
    const profile = res.data || res;
    cache.profile = profile;

    const emailEl = document.querySelector('.psycle-user-email');
    if (emailEl) {
      emailEl.textContent = profile.email;
    }

    // 2. Fetch settings and studio preferences
    const settings = await api.getSettings();
    if (settings && Object.keys(settings).length > 0) {
      Object.assign(userSettings, settings);
    }

    // 3. Use available_credits from profile
    const availableCredits = profile.available_credits || [];
    cache.credits = availableCredits;

    // Update credit badge in header
    updateCreditBadge(availableCredits);

    // 4. Auto-detect the user's booking window from profile cutoffs + credit inventory.
    // Persist the detected day-offset so the server scheduler reads the same window.
    await syncDetectedBookingWindow(profile, availableCredits);

  } catch (err) {
    console.error('[App] Failed to refresh user credentials:', err);
  }
}

// Detect the booking window and persist it to settings when it changes. Stores the
// full detection result on cache.bookingWindow for the Settings indicator to render.
async function syncDetectedBookingWindow(profile, credits) {
  try {
    const detected = detectBookingWindow(profile, credits);
    if (!detected) return;
    cache.bookingWindow = detected;

    // Persist the offset (read by the server scheduler) plus the full detection result
    // (so the admin panel can render the same window the user sees). Re-persist when
    // either the offset or the serialised window changes.
    const windowChanged = JSON.stringify(userSettings.bookingWindow) !== JSON.stringify(detected);
    if (userSettings.detectedBookingOffset !== detected.offsetDays || windowChanged) {
      const newSettings = { ...userSettings, detectedBookingOffset: detected.offsetDays, bookingWindow: detected };
      await api.updateSettings(newSettings);
      Object.assign(userSettings, newSettings);
      debugConsole(`[App] Detected booking window: ${detected.weeks} week(s) / ${detected.offsetDays}d (${detected.source})`);
    }
  } catch (err) {
    console.warn('[App] Booking window detection failed:', err.message);
  }
}

export async function initApp() {
  document.getElementById('psycle-login-container').style.display = 'none';
  document.getElementById('psycle-app-container').style.display = 'flex';
  
  // Set helper expanded classes to trigger standard styles
  document.body.id = 'psycle-helper-container';
  document.body.className = 'psycle-helper-expanded';

  await refreshUserData();

  // Prefetch auto-book tab data in the background for instant tab load
  import('./ui/autobook').then(m => m.prefetchAutoBookData()).catch(() => {});

  // Setup debug terminal
  updateDebugTerminalVisibility();
  const terminal = document.getElementById('psycle-debug-terminal');
  const debugHeader = document.getElementById('psycle-debug-terminal-header');
  const debugLog = document.getElementById('psycle-debug-log');
  const debugClearBtn = document.getElementById('psycle-debug-clear-btn');
  const debugToggleIcon = document.getElementById('psycle-debug-toggle-icon');
  const debugFab = document.getElementById('psycle-debug-fab');

  // Minimize: collapse to a tiny "D" circle. Expand: restore full panel.
  function setDebugMinimized(minimized) {
    debugLogExpanded = !minimized;
    if (minimized) {
      terminal.classList.add('psycle-debug-minimized');
      debugLog.style.maxHeight = '0';
      debugLog.style.padding = '0 12px';
      if (debugToggleIcon) debugToggleIcon.textContent = '▶';
    } else {
      terminal.classList.remove('psycle-debug-minimized');
      debugLog.style.maxHeight = '230px';
      debugLog.style.padding = '8px 12px';
      if (debugToggleIcon) debugToggleIcon.textContent = '▼';
    }
  }

  // Header click → toggle minimize (but not when clicking Clear)
  if (debugHeader) {
    debugHeader.addEventListener('click', (e) => {
      if (e.target === debugClearBtn) return;
      setDebugMinimized(debugLogExpanded);
    });
  }
  // FAB circle click → expand
  if (debugFab) {
    debugFab.addEventListener('click', () => setDebugMinimized(false));
  }
  if (debugClearBtn) {
    debugClearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      debugLog.innerHTML = '';
    });
  }
  
  // Set build timestamp in version stamp
  const buildTimeEl = document.getElementById('psycle-build-time');
  if (buildTimeEl) buildTimeEl.textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Restore tab from URL hash if available, otherwise default to Timetable
  const hash = location.hash.replace('#', '');
  let initialTab = VALID_TABS.includes(hash) ? hash : 'class-timetable';
  if (hash === 'about') initialTab = 'settings';
  switchTab(initialTab);
}

// Check auth status on launch
async function checkAuth() {
  // Fetch runtime config (app name, public host) before any UI renders so
  // onboarding, login, and the app shell all show the correct name.
  await initConfig();
  applyAppName();

  if (isLoggedIn()) {
    // Restore per-user cache key prefix from localStorage so cached data
    // is found on reload (the prefix was set during login but is lost on reload).
    const storedUserId = localStorage.getItem('psycleUserId');
    if (storedUserId) setCacheKeyPrefix(storedUserId);

    try {
      const status = await api.getStatus();
      currentUser = { id: status.userId, email: status.email };
      setCacheKeyPrefix(currentUser.id);
      localStorage.setItem('psycleUserId', currentUser.id);
      initApp();
    } catch (err) {
      // Distinguish auth failure (401) from network error (offline).
      // 401 errors fire 'psycle-logout-triggered' which already calls showLogin() + clears cache.
      // Network errors (offline) should NOT log out — the token may still be valid.
      const isAuthError = err.message && err.message.includes('session has expired');
      if (isAuthError) {
        // 401 — showLogin() already called by psycle-logout-triggered handler
      } else if (getIsOffline()) {
        // Network error (server unreachable) with valid token — init app with cached data.
        // The offline banner is already showing via the psycle-network-fail event handler.
        // Cache prefix was restored above from localStorage.
        initApp();
      } else {
        // Online but getStatus failed for unknown reason — show login as fallback
        showLogin();
      }
    }
  } else if (shouldShowOnboarding()) {
    // First run (or onboarding not yet completed) — run the guided flow, which
    // shows the login form at the right step. Resumes mid-flow on iOS after the
    // install relaunch.
    resumeOnboarding();
  } else {
    showLogin();
  }
}

function showLogin() {
  setCacheKeyPrefix('');
  clearApiCache().catch(() => {});
  localStorage.removeItem('psycleUserId');
  // Reset settings to defaults so a new user doesn't inherit the previous
  // user's settings (e.g. debugMode). The server returns {} for a brand-new
  // user, which would skip the Object.assign merge and leave stale values.
  Object.keys(userSettings).forEach(k => delete userSettings[k]);
  Object.assign(userSettings, DEFAULT_SETTINGS);
  document.body.id = 'psycle-helper-container';
  document.body.className = 'psycle-helper-expanded';
  document.getElementById('psycle-app-container').style.display = 'none';
  document.getElementById('psycle-login-container').style.display = 'flex';
}

// Shared post-login routing. During onboarding we hand control back to the flow
// (which calls initApp() at its finish step); otherwise we boot the app directly.
async function onLoginSuccess() {
  if (isOnboardingActive()) {
    advanceAfterLogin();
    return;
  }

  await initApp();

  // Auto-enable push if the user has already granted notification permission.
  if (serviceWorkerRegistration) {
    const permission = await navigator.permissions?.query({ name: 'notifications' });
    if (permission?.state === 'granted') {
      togglePushSubscription();
    }
  }
}

// Login Form Submit Listener
const loginForm = document.getElementById('psycle-login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('psycle-login-email').value;
    const password = document.getElementById('psycle-login-password').value;
    const submitBtn = document.getElementById('psycle-login-submit-btn');

    const errorEl = document.getElementById('psycle-login-error');
    if (errorEl) errorEl.style.display = 'none';

    try {
      submitBtn.disabled = true;
      submitBtn.querySelector('span').textContent = 'Logging in...';

      const user = await api.login(email, password);
      currentUser = user;
      setCacheKeyPrefix(currentUser.id);
      localStorage.setItem('psycleUserId', currentUser.id);
      showToast('Logged in successfully!', 'success');

      await onLoginSuccess();
    } catch (err) {
      const isNetworkErr = err instanceof TypeError;
      const msg = isNetworkErr
        ? 'Unable to connect. Check your internet connection.'
        : 'Incorrect email or password. Please try again.';
      if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
      else showToast(msg, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = 'Log In to CodexFit';
    }
  });
}

// Listen for global logout triggers (e.g. from api.js 401 interceptor)
window.addEventListener('psycle-logout-triggered', () => {
  setCacheKeyPrefix('');
  clearApiCache().catch(() => {});
  showToast('Session expired. Please log in again.', 'warning');
  showLogin();
});

// Restore tab from URL hash on back/forward navigation
window.addEventListener('popstate', () => {
  const hash = location.hash.replace('#', '');
  if (VALID_TABS.includes(hash)) {
    switchTab(hash);
  } else if (hash === 'about') {
    switchTab('settings');
  }
});

// App Launch
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  initConnectivity();  // Set up offline listeners BEFORE checkAuth so psycle-network-fail is caught
  checkAuth();
  initTooltips();

  // Global Esc-to-close for all modals
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    // Collect all visible modal candidates with their z-index
    const candidates = [];

    // Static .psycle-modal elements (booking, profile explorer, debug)
    document.querySelectorAll('.psycle-modal').forEach(m => {
      if (m.classList.contains('show') || m.style.display === 'flex') {
        const z = parseInt(getComputedStyle(m).zIndex) || 0;
        candidates.push({ el: m, z, type: 'static' });
      }
    });

    // Dynamic overlay divs (spot maps, auto-book favourites — direct children of body)
    document.body.querySelectorAll(':scope > div').forEach(d => {
      if (d.classList.contains('psycle-modal')) return;
      const s = d.style;
      if (s.position === 'fixed' && s.display !== 'none' && s.zIndex) {
        const z = parseInt(s.zIndex) || 0;
        if (z > 0) candidates.push({ el: d, z, type: 'dynamic' });
      }
    });

    if (candidates.length === 0) return;

    // Close the topmost modal (highest z-index)
    candidates.sort((a, b) => b.z - a.z);
    const top = candidates[0];

    if (top.type === 'static') {
      // Click the close button to trigger existing cleanup handlers (state reset, etc.)
      const closeBtn = top.el.querySelector('.psycle-modal-close-btn');
      if (closeBtn) {
        closeBtn.click();
      } else {
        top.el.classList.remove('show');
        setTimeout(() => { top.el.style.display = 'none'; }, 300);
      }
    } else {
      // Dynamic overlay — remove from DOM
      top.el.remove();
    }

    e.preventDefault();
    e.stopPropagation();
  });

  // Restore tab from URL hash (e.g. after page refresh)
  const hash = location.hash.replace('#', '');
  if (VALID_TABS.includes(hash) || hash === 'about') {
    const targetTab = hash === 'about' ? 'settings' : hash;
    // Defer until after checkAuth initialises the app
    setTimeout(() => switchTab(targetTab), 0);
  }
});
