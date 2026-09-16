import { api, setToken, isLoggedIn } from './api';
import { setGymContext, setLinkedGyms, applyCapabilityGates, getLinkedGyms } from './gym-context.js';
import { initTooltips } from './ui/tooltips';
import { setupPullToRefresh } from './ui/pulltorefresh';
import { setCacheKeyPrefix, clearApiCache, invalidateApiCache } from './cache.js';
import { appConfig, initConfig } from './config';
import { shouldShowOnboarding, resumeOnboarding, isOnboardingActive, advanceAfterLogin } from './ui/onboarding';
import { detectBookingWindow } from './lib';
import { escapeHtml } from './ui/cards';

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
// literal "Sweat Assistant" remains only as a no-JS fallback.
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
  // Toasts are the app's ONLY feedback channel for booking, cancellation and
  // errors; without a live region a screen-reader user books a class and is
  // told nothing at all. Errors interrupt, everything else waits its turn.
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';

  // The icon is ours; the message is not — callers pass `err.message` straight
  // from server and provider responses, so it goes in as text, never markup.
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.textContent = icon;
  const msgEl = document.createElement('span');
  msgEl.className = 'toast-message';
  msgEl.textContent = message;
  toast.append(iconEl, msgEl);
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
      await invalidateApiCache('/api/bookings');
      await invalidateApiCache('/api/waitlists');
      await invalidateApiCache('/api/profile');
      // Credits are now cached too; a refresh that drops the profile but keeps
      // a stale balance shows the old credit count next to fresh bookings.
      await invalidateApiCache('/api/credits');
      const { prefetchTimetableData } = await import('./ui/timetable');
      await prefetchTimetableData(true);
      refreshUserData(true); // fire-and-forget badge update
    } else if (currentTabId === 'my-bookings') {
      await invalidateApiCache('/api/bookings');
      await invalidateApiCache('/api/waitlists');
      await invalidateApiCache('/api/auto-upgrade');
      await invalidateApiCache('/api/profile');
      // Credits are now cached too; a refresh that drops the profile but keeps
      // a stale balance shows the old credit count next to fresh bookings.
      await invalidateApiCache('/api/credits');
      const { renderBookings } = await import('./ui/bookings');
      await renderBookings();
      refreshUserData(true); // fire-and-forget badge update
    } else if (currentTabId === 'auto-book') {
      await invalidateApiCache('/api/auto-book');
      await invalidateApiCache('/api/auto-upgrade');
      await invalidateApiCache('/api/profile');
      // Credits are now cached too; a refresh that drops the profile but keeps
      // a stale balance shows the old credit count next to fresh bookings.
      await invalidateApiCache('/api/credits');
      await invalidateApiCache('/api/settings');
      const { refreshAutoBookTab } = await import('./ui/autobook');
      await refreshAutoBookTab();
    } else if (currentTabId === 'buy-credits') {
      await invalidateApiCache('/api/bundles');
      await invalidateApiCache('/api/profile');
      // Credits are now cached too; a refresh that drops the profile but keeps
      // a stale balance shows the old credit count next to fresh bookings.
      await invalidateApiCache('/api/credits');
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
            const { invalidateApiCache } = await import('./cache');
            await invalidateApiCache('/api/bookings').catch(() => {});
            await invalidateApiCache('/api/auto-upgrade').catch(() => {});
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

// --- MULTI-GYM CREDIT & STATUS BADGE UPDATE ---

// Sums NormalizedCredit (`{ typeName, count }`). It used to require a raw
// `c.credit_type` object and skipped every entry without one — once /api/credits
// started returning normalized rows, the header badge read "0 cr" for an account
// holding 14 credits. A credit total that silently reads zero is worse than an
// error: it looks like a real balance.
function sumCredits(credits) {
  return (credits || []).reduce((sum, c) => {
    const count = Number(c.count) || 0;
    return count > 0 ? sum + count : sum;
  }, 0);
}

function renderGymBadge(container, gymId, shortName, isMetered, total, credits) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `psycle-header-gym-badge psycle-header-gym-${gymId}`;
  if (isMetered) {
    badge.innerHTML = `<span class="psycle-hgb-name">${shortName}</span><span class="psycle-hgb-pill">${total} cr</span>`;
    badge.title = `${shortName}: ${total} credit${total !== 1 ? 's' : ''} available`;
    badge.onclick = () => { if (total > 0) showCreditDetailsModal(credits); };
  } else {
    // "Active" alone reads as "this is the currently-selected gym" rather than
    // "your membership is active" — found ambiguous 2026-09-02, back when the
    // app did have a gym switcher. The switcher is gone, but "Member" is still
    // the clearer word for what this badge means; the full sentence lives in
    // the hover title.
    badge.innerHTML = `<span class="psycle-hgb-name">${shortName}</span><span class="psycle-hgb-pill member">Member</span>`;
    badge.title = `${shortName}: Membership active`;
  }
  container.appendChild(badge);
}

// `availableCredits`, when passed, is always the ACTIVE gym's inventory (the
// only kind `/api/credits` ever returns without an explicit gymId). With a
// single linked gym that's also the only badge shown, so no fan-out is
// needed (WP-D8: n=1 must not pay for multi-gym plumbing). With 2+ linked
// gyms each badge needs ITS OWN gym's balance, which `availableCredits` can't
// provide — those are fetched here via `api.getCreditsByGym()`.
export async function updateCreditBadge(availableCredits = null) {
  const creditsContainer = document.getElementById('psycle-header-credits');
  if (!creditsContainer) return;

  const linked = getLinkedGyms();

  if (!linked || linked.length === 0) {
    const credits = availableCredits || cache.credits || [];
    const total = sumCredits(credits);
    creditsContainer.innerHTML = '';
    renderGymBadge(creditsContainer, 'psycle-london', 'Psycle', true, total, credits);
    debugLog(`Credits updated: ${total} total (no linked gyms, fallback)`, 'info');
    return;
  }

  if (linked.length === 1) {
    const gym = linked[0];
    const gymId = gym.gym_id || gym.id;
    const credits = availableCredits || cache.credits || [];
    const total = sumCredits(credits);
    creditsContainer.innerHTML = '';
    cache.creditsByGym = { [gymId]: credits };
    renderGymBadge(creditsContainer, gymId, gym.shortName || gym.name || gymId, gym.capabilities?.metered !== false, total, credits);
    debugLog(`Credits updated: ${total} total for ${gymId}`, 'info');
    return;
  }

  const byGym = await api.getCreditsByGym().catch(() => ({}));
  // Publish for the credit arithmetic: a merged timetable needs EACH row's own
  // gym's balance, and `cache.credits` only ever holds one gym's.
  cache.creditsByGym = byGym;
  // Same reason as eligibilityByGym: rows rendered before this landed were
  // rendered permissively and need the real answer.
  repaintTimetableIfVisible();
  creditsContainer.innerHTML = '';
  linked.forEach(gym => {
    const gymId = gym.gym_id || gym.id;
    const credits = byGym[gymId] || [];
    const total = sumCredits(credits);
    renderGymBadge(creditsContainer, gymId, gym.shortName || gym.name || gymId, gym.capabilities?.metered !== false, total, credits);
  });
  debugLog(`Credits updated per-gym across ${linked.length} linked gyms`, 'info');
}

/**
 * Re-render the timetable rows in place, if that tab is on screen.
 *
 * Used when per-gym credit/eligibility data arrives after the first paint. Safe
 * to call when the tab is hidden or the module is not loaded — it does nothing.
 */
function repaintTimetableIfVisible() {
  if (currentTabId !== 'class-timetable') return;
  import('./ui/timetable')
    .then((m) => { if (typeof m.renderTimetableGrid === 'function') m.renderTimetableGrid(); })
    .catch(() => {});
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
    // Credit detail modal — metered gyms only (the badge that opens it is
    // capability-gated). Reads NormalizedCredit only: `{ typeName, count,
    // expiresAt }`. It used to reach through `profile.raw.relations.credit_types`
    // for type names — a bag CodexFit does not put on the profile — default it
    // to `{}`, then call `.find()` on that object, which threw on open.
    const creditsData = await api.getNormalizedCredits();

    content.innerHTML = `<h2 style="margin-top: 0; color: var(--feat-autoupgrade); font-size: 18px;">Credit Details</h2>`;

    if (!Array.isArray(creditsData) || creditsData.length === 0) {
      content.innerHTML += `<p style="color: var(--text-secondary);">No credits available.</p>`;
    } else {
      // Entries arrive GROUPED by type with a count — one entry is not one
      // credit. Several entries can still share a type name with different
      // expiry dates, so merge by name and keep each expiry line.
      const grouped = new Map();
      creditsData.forEach(credit => {
        const typeName = credit.typeName || 'Credits';
        if (!grouped.has(typeName)) grouped.set(typeName, []);
        grouped.get(typeName).push(credit);
      });

      grouped.forEach((entries, typeName) => {
        const total = entries.reduce((sum, c) => sum + (Number(c.count) || 0), 0);
        content.innerHTML += `
          <div style="margin-bottom: 16px; padding: 12px; background: color-mix(in srgb, var(--feat-autoupgrade) 5%, transparent); border-radius: 8px; border-left: 3px solid var(--feat-autoupgrade);">
            <div style="font-weight: 600; color: var(--feat-autoupgrade); margin-bottom: 8px;">${escapeHtml(typeName)}: <strong>${total}</strong></div>
            <div style="font-size: var(--text-xs); color: var(--text-secondary);">
              ${entries.map(c => {
                const n = Number(c.count) || 0;
                const expiryDate = c.expiresAt
                  ? new Date(c.expiresAt).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
                  : 'No expiry';
                const isExpired = c.expiresAt && new Date(c.expiresAt) < new Date();
                const expiryColor = isExpired ? 'var(--danger)' : 'var(--text-secondary)';
                return `<div style="margin-bottom: 6px; color: ${expiryColor};">• ${n} credit${n === 1 ? '' : 's'} (${isExpired ? 'Expired' : 'Expires'}: ${expiryDate})</div>`;
              }).join('')}
            </div>
          </div>
        `;
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
export async function loadGymContext() {
  try {
    const [{ gyms: linked }, catalogueRes] = await Promise.all([
      api.getMyGyms(),
      api.getGyms(),
    ]);
    const catalogue = catalogueRes.gyms || catalogueRes || [];
    const linkedFull = (linked || []).map(lg => {
      const found = catalogue.find(cg => cg.id === (lg.gym_id || lg.id));
      return found ? { ...found, ...lg } : lg;
    });
    setLinkedGyms(linkedFull);

    // No "active gym" from the server any more (stage 4 of the active-gym
    // audit) — `setGymContext` below is purely a client-side convenience
    // default for single-gym accounts and any code that hasn't been threaded
    // with an explicit gym yet, not a persisted choice.
    const activeId = linked && linked[0] && linked[0].gym_id;
    const active = catalogue.find((g) => g.id === activeId);
    if (active) {
      setGymContext(active);
      applyCapabilityGates();
      debugLog(`Gym context: ${active.name} (${Object.entries(active.capabilities || {}).filter(([, v]) => v === true).map(([k]) => k).join(', ') || 'no flags'})`, 'info');
    }
  } catch (err) {
    // Leave the defaults in place: a gym whose flags we couldn't fetch keeps the
    // full feature set rather than losing features to a failed request.
    console.warn('[App] Could not load gym capabilities:', err.message);
  }
}

export async function refreshUserData(force = false) {
  try {
    if (force) {
      await invalidateApiCache('/api/profile');
      // Credits are now cached too; a refresh that drops the profile but keeps
      // a stale balance shows the old credit count next to fresh bookings.
      await invalidateApiCache('/api/credits');
    }
    // 1. Profile, via the gym-agnostic route (WP-D12).
    //
    // `.raw` is the provider's own payload and is deliberately still used below:
    // `available_credits` and `metafields.bookmarks` have no normalized
    // equivalent yet, and both are CodexFit-only concepts (a membership gym has
    // neither). They are read through capability-gated helpers rather than
    // assumed — see credit-allowance.js — and reaching into `.raw` is the honest
    // marker that this is provider-shaped data, not a normalized field.
    // Profile and credits are independent, so they go in parallel — sequentially
    // they add a visible delay before the header badge appears. Credits are
    // allowed to fail on their own: a membership gym has no credit route worth
    // blocking the whole refresh on.
    const [normalized, fetchedCredits, fetchedEligibility] = await Promise.all([
      api.getNormalizedProfile(),
      api.getNormalizedCredits().catch(() => null),
      // Allowed to fail on its own too — an adapter with no real
      // implementation defaults permissive server-side, so losing this
      // fetch should never itself block booking; see credit-allowance.js.
      api.getEligibility().catch(() => null),
    ]);
    const profile = { ...(normalized.raw || {}), ...normalized };
    cache.profile = profile;
    cache.eligibility = fetchedEligibility;
    // Per-gym eligibility for merged lists — fire-and-forget so it never delays
    // the first paint. Until it lands, the single-gym value above applies, and
    // the unknown-defaults-permissive rule keeps that safe.
    api.getEligibilityByGym()
      .then((byGym) => {
        cache.eligibilityByGym = byGym;
        // Re-render once the per-gym answers land. Until they do, every row is
        // rendered permissively (see credit-allowance.js) — correct, but it can
        // still be showing Book on a class this account genuinely cannot
        // afford. Without this the only thing that corrected it was the user
        // switching days, which is not a fix, it is a coincidence.
        repaintTimetableIfVisible();
      })
      .catch(() => {});

    const emailEl = document.querySelector('.psycle-user-email');
    if (emailEl) {
      emailEl.textContent = currentUser?.email || profile.email || '';
    }

    // 2. Fetch settings and studio preferences
    const settings = await api.getSettings();
    if (settings && Object.keys(settings).length > 0) {
      Object.assign(userSettings, settings);
    }

    // 3. Credit inventory, via the gym-agnostic route. Empty for a membership
    // gym, which is correct — there is no balance to draw down.
    const availableCredits = fetchedCredits ?? (profile.available_credits || []);
    cache.credits = availableCredits;
    // Keep `.available_credits` populated for the credit arithmetic, which reads
    // it off the cached profile.
    cache.profile.available_credits = availableCredits;

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
      // Both keys are gym-scoped, and the window was derived from THIS profile's
      // cutoffs — so it is saved against the gym the profile came from, which
      // the route stamps on. Without that this wrote one gym's booking window
      // onto whichever gym the server happened to resolve.
      const newSettings = { detectedBookingOffset: detected.offsetDays, bookingWindow: detected };
      await api.updateSettings(newSettings, profile.gymId || null);
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

  // Load the active gym's capabilities + theme BEFORE the first render, so the
  // UI doesn't briefly show features this gym lacks. Awaited rather than
  // fire-and-forget: it is two small requests, and the alternative is a visible
  // flash of Buy Credits on a membership gym.
  await loadGymContext();

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

  // A Sweat Assistant account can exist with no gym linked (signup is
  // gym-independent since Decision D4). Booting the full app in that state shows
  // an empty timetable and a wall of failing requests, so route to a dedicated
  // "connect a gym" screen instead. The server tells us with a 409/NO_GYM_LINKED.
  try {
    const mine = await api.getMyGyms();
    if (!mine.gyms || mine.gyms.length === 0) {
      showNoGymScreen();
      return;
    }
  } catch (_) {
    // Best-effort: if this check itself fails, fall through and let the app boot
    // normally rather than stranding a working account on a setup screen.
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
      submitBtn.querySelector('span').textContent = 'Logging in…';

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
      submitBtn.querySelector('span').textContent = 'Log In';
    }
  });
}

// Shown when a Sweat Assistant account has no gym attached — after signup, or
// after unlinking the last one. Reuses the login card so there is no third
// full-screen layout to maintain.
function showNoGymScreen() {
  document.getElementById('psycle-app-container').style.display = 'none';
  const loginContainer = document.getElementById('psycle-login-container');
  loginContainer.style.display = 'flex';
  document.getElementById('psycle-auth-title').textContent = 'Connect a gym';
  document.getElementById('psycle-auth-subtitle').innerHTML =
    'Your account is ready. Add a gym login to start booking.';
  ['psycle-login-form', 'psycle-signup-form', 'psycle-recover-form'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  let panel = document.getElementById('psycle-nogym-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'psycle-nogym-panel';
    panel.className = 'psycle-login-form';
    document.querySelector('.psycle-login-card').insertBefore(
      panel, document.querySelector('.psycle-login-footer'));
  }
  panel.style.display = '';
  panel.innerHTML = `
    <div class="psycle-form-group">
      <label for="psycle-nogym-gym">Gym</label>
      <select id="psycle-nogym-gym" class="psycle-select" style="width:100%;"><option>Loading…</option></select>
    </div>
    <div class="psycle-form-group">
      <label for="psycle-nogym-email">Gym email</label>
      <input type="email" id="psycle-nogym-email" placeholder="name@example.com" autocomplete="off">
    </div>
    <div class="psycle-form-group">
      <label for="psycle-nogym-password">Gym password</label>
      <input type="password" id="psycle-nogym-password" placeholder="••••••••" autocomplete="off">
    </div>
    <div id="psycle-nogym-error" class="psycle-login-error" style="display:none;"></div>
    <button type="button" id="psycle-nogym-submit" class="psycle-btn-primary"><span>Connect Gym</span></button>
  `;

  const sel = panel.querySelector('#psycle-nogym-gym');
  const errorEl = panel.querySelector('#psycle-nogym-error');
  api.getGyms().then(gyms => {
    const available = gyms.filter(g => g.enabled);
    sel.innerHTML = available.length
      ? available.map(g => `<option value="${g.id}">${g.name}</option>`).join('')
      : '<option value="">No gyms available</option>';
  }).catch(() => { sel.innerHTML = '<option value="">Could not load gyms</option>'; });

  panel.querySelector('#psycle-nogym-submit').onclick = async () => {
    const btn = panel.querySelector('#psycle-nogym-submit');
    errorEl.style.display = 'none';
    const gymId = sel.value;
    const email = panel.querySelector('#psycle-nogym-email').value.trim();
    const password = panel.querySelector('#psycle-nogym-password').value;
    if (!gymId || !email || !password) {
      errorEl.textContent = 'Gym, email and password are all required.';
      errorEl.style.display = 'block';
      return;
    }
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Connecting…';
    try {
      await api.linkGym(gymId, email, password);
      panel.style.display = 'none';
      showToast('Gym connected', 'success');
      await onLoginSuccess();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Connect Gym';
    }
  };
  applyAppName();
}

// ─── Auth screen modes (WP-C2 / Decision D4) ──────────────────────────────────
// One card, three modes: sign in, create account, recover. A Sweat Assistant
// account is its own thing now, so signing up no longer means handing over a gym
// credential — gyms are linked afterwards.
const AUTH_MODES = {
  login:  { title: 'Log in',          subtitle: 'Sign in to your <span data-app-name>Sweat Assistant</span> account.' },
  signup: { title: 'Create account',  subtitle: 'Set up your <span data-app-name>Sweat Assistant</span> account. You’ll connect a gym next.' },
  recover:{ title: 'Reset password',  subtitle: 'Confirm it’s you by signing in to a gym you’ve linked.' },
};

function setAuthMode(mode) {
  const cfg = AUTH_MODES[mode] || AUTH_MODES.login;
  document.getElementById('psycle-auth-title').textContent = cfg.title;
  document.getElementById('psycle-auth-subtitle').innerHTML = cfg.subtitle;
  document.getElementById('psycle-login-form').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('psycle-signup-form').style.display = mode === 'signup' ? '' : 'none';
  document.getElementById('psycle-recover-form').style.display = mode === 'recover' ? '' : 'none';

  // Recovery always restarts at step 1 — landing mid-flow with a stale gym list
  // would be confusing and could show gyms for a different email.
  if (mode === 'recover') {
    document.getElementById('psycle-recover-step1').style.display = 'block';
    document.getElementById('psycle-recover-step2').style.display = 'none';
  }
  document.querySelectorAll('.psycle-login-error').forEach(el => { el.style.display = 'none'; });
  const noGym = document.getElementById('psycle-nogym-panel');
  if (noGym) noGym.style.display = 'none';

  const switcher = document.getElementById('psycle-auth-switcher');
  switcher.innerHTML = mode === 'login'
    ? `<a href="#" id="psycle-auth-to-signup">Create an account</a>&nbsp;·&nbsp;<a href="#" id="psycle-auth-to-recover">Forgot password?</a>`
    : `<a href="#" id="psycle-auth-to-login">Back to log in</a>`;
  wireAuthSwitcher();
  applyAppName();
}

function wireAuthSwitcher() {
  const bind = (id, mode) => {
    const el = document.getElementById(id);
    if (el) el.onclick = (e) => { e.preventDefault(); setAuthMode(mode); };
  };
  bind('psycle-auth-to-signup', 'signup');
  bind('psycle-auth-to-recover', 'recover');
  bind('psycle-auth-to-login', 'login');
}
wireAuthSwitcher();

// --- create account ---
const signupForm = document.getElementById('psycle-signup-form');
if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('psycle-signup-email').value.trim();
    const password = document.getElementById('psycle-signup-password').value;
    const confirm = document.getElementById('psycle-signup-confirm').value;
    const errorEl = document.getElementById('psycle-signup-error');
    const btn = document.getElementById('psycle-signup-submit-btn');
    const fail = (m) => { errorEl.textContent = m; errorEl.style.display = 'block'; };
    errorEl.style.display = 'none';

    if (password.length < 8) return fail('Password must be at least 8 characters.');
    if (password !== confirm) return fail('The two passwords don’t match.');

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating…';
    try {
      const { user } = await api.signup(email, password);
      currentUser = user;
      setCacheKeyPrefix(currentUser.id || email);
      localStorage.setItem('psycleUserId', currentUser.id || email);
      showToast('Account created — now connect a gym', 'success');
      await onLoginSuccess();
    } catch (err) {
      fail(err instanceof TypeError ? 'Unable to connect. Check your internet connection.' : err.message);
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Create Account';
    }
  });
}

// Account recovery is currently ADMIN-ONLY. The previous self-service flow proved
// identity with a linked gym's login, which re-coupled the account to the gym and
// defeated Decision D4 — removed 2026-08-31. The replacement mechanism is an open
// decision (BACKLOG.md); until it lands the screen says so plainly rather than
// offering a flow that cannot complete.
const recoverFindBtn = document.getElementById('psycle-recover-find-btn');
if (recoverFindBtn) {
  recoverFindBtn.onclick = () => {
    const errorEl = document.getElementById('psycle-recover-error');
    errorEl.textContent = 'Self-service password reset isn’t available yet. Contact the admin to have your password reset.';
    errorEl.style.display = 'block';
  };
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
