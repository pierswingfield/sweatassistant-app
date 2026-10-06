import { parseLocation, legacyHashToPath } from './url-state.js';
import { currentRoute, navigate, pathFor, migrateLegacyHash, initRouter } from './router.js';
import { api, setToken, isLoggedIn } from './api';
import { setLinkedGyms, setGymCatalogue, getLinkedGyms, getGymShortName, getDefaultGymId, getGymPresentation } from './gym-context.js';
import { initTooltips } from './ui/tooltips';
import { setupPullToRefresh, cancelPullToRefresh } from './ui/pulltorefresh';
import { markScrollBusy, isScrollBusy, isDocScroll, docScroller } from './ui/scroll-state.js';
import { nextCollapseState } from './ui/scroll-collapse.js';
import { initGymLogoLoader } from './ui/gym-logo-loader.js';
import { setCacheKeyPrefix, clearApiCache, invalidateApiCache } from './cache.js';
import { appConfig, initConfig } from './config';
import { shouldShowOnboarding, resumeOnboarding, getPostLoginDestination, isOnboardingActive, advanceAfterLogin, promoteInstallDismissal, offerInstallBeforeLogin } from './ui/onboarding';
import { detectBookingWindow, noSept } from './lib';
import { canBookAtAll, getIneligibleReason, hasConfirmedAccess } from './ui/credit-allowance.js';
import { escapeHtml, gymBrand, wordmarkElement } from './ui/cards';
import { installBookingState } from './ui/booking-state.js';
import { applyGymLoadState, onGymLoadChange } from './ui/gym-load-state.js';
import { applyStaticCopy } from './copy.js';
import { COPY, formatCopyText } from './copy.js';

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
  document.querySelectorAll('.psycle-logo').forEach((el) => {
    el.setAttribute('alt', `${appConfig.appName} logo`);
  });
  applyStaticCopy(document, { appName: appConfig.appName });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((registration) => {
      registration.active?.postMessage({ type: 'SET_APP_NAME', appName: appConfig.appName });
    }).catch(() => {});
  }
}

applyStaticCopy();
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
  bookingWindow: null, // last detected booking window { offsetDays, weeks, cutoffISO, ... } (default/first gym; see profilesByGym)
  // C3-17 / C3-18: per-gym, keyed by gym id. `profile` above is only "the first
  // linked gym's", kept for the few single-gym fallbacks; anything asking about
  // ONE gym reads these through profileForGym() / gymSetting().
  profilesByGym: {},
  gymSettings: {},
};

// The gym-scoped half of settings for one gym, e.g. autoUpgradeByDefault. Falls
// back to the merged `userSettings` blob only when no gym is named or none has
// loaded yet (the same "unknown is permissive" rule as the capability flags).
export function gymSetting(gymId, key) {
  const perGym = gymId && cache.gymSettings ? cache.gymSettings[gymId] : null;
  if (perGym && key in perGym) return perGym[key];
  return userSettings[key];
}

export function setGymSettingLocal(gymId, key, value) {
  if (!gymId) { userSettings[key] = value; return; }
  cache.gymSettings[gymId] = { ...(cache.gymSettings[gymId] || {}), [key]: value };
}

// One gym's profile (bookmarks live here). null when that gym's profile has not
// loaded, which callers treat as "no bookmarks", never as another gym's list.
export function profileForGym(gymId) {
  return (gymId && cache.profilesByGym && cache.profilesByGym[gymId]) || null;
}

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
  syncThemeColorMeta();
}

// Status-bar / safe-area colour comes from the EXPLICIT solid tokens (--header-solid while the header
// shows, --page-solid once it has scrolled away): no runtime alpha compositing, so the value is exactly
// what the design tokens say (light #EBEAE4 / #F4F2EC, dark #070A12 / #090D16).
function headerBackgroundHex() {
  const cs = getComputedStyle(document.documentElement);
  const name = document.documentElement.hasAttribute('data-hdr-hidden') ? '--page-solid' : '--header-solid';
  return (cs.getPropertyValue(name).trim() || '#090d16').toLowerCase();
}
// iOS does not re-read a media-scoped <meta name="theme-color"> when its content
// attribute changes, so drop the static tags and REPLACE one unscoped tag each time.
export function syncThemeColorMeta() {
  if (!document.body) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = headerBackgroundHex();
  document.head.appendChild(meta);
}

export function setTheme(mode) {
  if (mode === 'auto') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
}

// Apply persisted choice immediately (before first paint of the app shell).
applyTheme();
// <body> may not exist yet when this module first runs; colour it once it does.
document.addEventListener('DOMContentLoaded', syncThemeColorMeta);

// Re-sync theme-color when the OS theme changes (only matters in 'auto' mode,
// where the app follows the system and the notch colour must follow too).
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'auto') applyTheme('auto');
});

// --- TOAST NOTIFICATIONS ---
export function showToast(message, type = 'info') {
  const container = document.getElementById('psycle-toast-container');
  if (!container) return;

  // Dismiss any existing toasts gracefully so only one clean canopy is active
  container.querySelectorAll('.psycle-toast').forEach((t) => {
    t.classList.remove('show');
    t.style.transform = 'translateY(-100%)';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  });

  const toast = document.createElement('div');
  toast.className = `psycle-toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

  const icons = {
    success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  };

  const inner = document.createElement('div');
  inner.className = 'psycle-toast-inner';

  const iconEl = document.createElement('span');
  iconEl.className = 'psycle-toast-icon toast-icon';
  iconEl.innerHTML = icons[type] || icons.info;

  const msgEl = document.createElement('span');
  msgEl.className = 'psycle-toast-message toast-message';
  msgEl.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'psycle-toast-close toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', COPY.notifications.dismiss);
  closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  inner.append(iconEl, msgEl, closeBtn);
  toast.appendChild(inner);

  let hideTimer = null;
  const dismiss = () => {
    if (hideTimer) clearTimeout(hideTimer);
    toast.classList.remove('show');
    toast.style.transform = 'translateY(-100%)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 320);
  };
  closeBtn.addEventListener('click', dismiss);

  // Swipe up to dismiss gesture
  let startTouchY = 0;
  let currentTouchDelta = 0;
  let isTrackingTouch = false;

  toast.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isTrackingTouch = true;
      startTouchY = e.touches[0].clientY;
      currentTouchDelta = 0;
    }
  }, { passive: true });

  toast.addEventListener('touchmove', (e) => {
    if (!isTrackingTouch) return;
    const dy = e.touches[0].clientY - startTouchY;
    if (dy < 0) {
      currentTouchDelta = dy;
      toast.style.transition = 'none';
      toast.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: true });

  toast.addEventListener('touchend', () => {
    if (!isTrackingTouch) return;
    isTrackingTouch = false;
    if (currentTouchDelta < -18) {
      dismiss();
    } else {
      toast.style.transition = '';
      toast.style.transform = '';
    }
  }, { passive: true });

  // Auto-hide: pause on hover for desktop users reading long text
  const scheduleAutoDismiss = () => {
    // Every variant auto-dismisses; errors linger longer so they can be read.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, type === 'error' ? 6000 : 4000);
  };
  // Tap anywhere on the toast to dismiss it.
  toast.addEventListener('click', dismiss);

  toast.addEventListener('mouseenter', () => {
    if (hideTimer) clearTimeout(hideTimer);
  });
  toast.addEventListener('mouseleave', () => {
    scheduleAutoDismiss();
  });

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });
  });

  scheduleAutoDismiss();
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
  applyCreditsTabGate();
}

// TEMP: credits hidden unless debugMode (restore by removing gate).
// Remove creditsTabAllowed/applyCreditsTabGate and their call sites (switchTab,
// updateDebugTerminalVisibility, init, popstate) to bring the Credits tab back.
function creditsTabAllowed() {
  return !!userSettings.debugMode;
}

function applyCreditsTabGate() {
  const allowed = creditsTabAllowed();
  document.querySelectorAll('.psycle-nav-btn[data-tab="buy-credits"]').forEach(btn => {
    btn.hidden = !allowed;
    btn.style.display = allowed ? '' : 'none';
  });
  if (!allowed && currentTabId === 'buy-credits') switchTab('class-timetable');
  applyBackupMigrationGate();
}

// TEMP: hidden unless debugMode. Backup & Migration (config export/import) card in
// Settings > General. Export/import code is intact; remove this gate (and the card's
// hidden/display:none in index.html) to restore it. Rides on applyCreditsTabGate's
// call sites, so it applies at init and whenever debug toggles, no reload needed.
function applyBackupMigrationGate() {
  const card = document.getElementById('psycle-settings-backup-card');
  if (!card) return;
  const allowed = !!userSettings.debugMode;
  card.hidden = !allowed;
  card.style.display = allowed ? '' : 'none';
}

// --- TAB ROUTING ---
const tabButtons = document.querySelectorAll('.psycle-nav-btn');
const panels = document.querySelectorAll('.psycle-tab-content');

// Expose on window so inline onclick handlers (e.g. "Buy Credits" button in timetable) can call it
window.switchTab = switchTab;


// The currently active tab — used by the shared pull-to-refresh dispatcher.
let currentTabId = null;

// opts.history: 'push' (default: a user-initiated tab change adds an entry), 'replace',
// or 'none' (boot / popstate: the URL already says where we are). opts.section: settings pane.
function switchTab(tabId, opts = {}) {
  let historyMode = opts.history || 'push';
  // TEMP: credits hidden unless debugMode (restore by removing gate)
  if (tabId === 'buy-credits' && !creditsTabAllowed()) { tabId = 'class-timetable'; if (historyMode === 'none') historyMode = 'replace'; }
  cancelPullToRefresh();
  // Leaving the timetable ends search: its own filter scope is dropped and the normal filters return.
  if (tabId !== 'class-timetable') import('./ui/timetable-search-state.js').then(m => { if (m.inSearchScope()) import('./ui/timetable').then(t => t.exitSearch()); });
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

  // Each tab starts at the top (window on mobile, inner scroller on desktop).
  try { window.scrollTo(0, 0); document.querySelector('main.psycle-body')?.scrollTo?.(0, 0); } catch (e) { /* jsdom */ }

  // U4-19: the tab lives in the PATH (/bookings, /settings/about ...) so refresh, back/forward
  // and shared links restore it. Skip when the URL already names this tab (keeps any query).
  if (historyMode !== 'none' && routeDiffers(tabId, opts.section)) {
    navigate(pathFor(tabId === 'about' ? { tab: 'settings', section: 'about' } : { tab: tabId, section: opts.section }),
      { replace: historyMode === 'replace' });
  }

  // Trigger tab-specific loading/rendering
  triggerTabRender(tabId);
}

function routeDiffers(tabId, section) {
  const r = currentRoute();
  const want = tabId === 'about' ? 'settings' : tabId;
  if (!r.valid || r.tab !== want) return true;
  return want === 'settings' && !!section && r.section !== section;
}

async function triggerTabRender(tabId) {
  try {
    if (tabId === 'home') {
      const { initHome } = await import('./ui/home');
      initHome();
    } else if (tabId === 'class-timetable') {
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
    showToast(formatCopyText(COPY.static.errorOpeningTab, { error: err.message }), 'error');
  }
}

// Attach Tab Navigation Listeners
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    // Re-tapping Settings while already in the Settings area (mobile) returns to the settings menu.
    const group = (btn.getAttribute('data-tab-group') || '').split(' ');
    if ((tabId === 'settings' || group.includes('settings')) && (currentTabId === 'settings' || currentTabId === 'about')
        && window.matchMedia('(max-width: 900px)').matches) {
      const lay = document.querySelector('.psycle-settings-layout');
      if (lay && lay.classList.contains('show-pane')) { lay.classList.remove('show-pane'); return; }
    }
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
    if (currentTabId === 'home') {
      await invalidateApiCache('/api/auto-book');
      await invalidateApiCache('/api/bookings');
      await invalidateApiCache('/api/profile');
      await invalidateApiCache('/api/credits');
      const { refreshHome } = await import('./ui/home');
      await refreshHome();
    } else if (currentTabId === 'class-timetable') {
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
  // Settings has no refreshable data and its panes are long forms: pull-to-refresh stays off there.
  setupPullToRefresh(scrollBody, refreshActiveTab, {
    isEnabled: () => currentTabId !== 'settings',
    // Mobile scrolls the document, desktop the inner <main>: read whichever is live.
    getScrollTop: () => (isDocScroll() ? docScroller().scrollTop : scrollBody.scrollTop),
    getMaxScroll: () => (isDocScroll() ? Math.max(0, docScroller().scrollHeight - window.innerHeight) : Math.max(0, scrollBody.scrollHeight - scrollBody.clientHeight)),
    scrollTargets: [scrollBody, window],
  });
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
        // New SW sends {path}; a still-cached old SW sends {hash}. Either way go through the router.
        const target = event.data.path || (event.data.hash ? legacyHashToPath(event.data.hash) : null);
        if (target) {
          const r = parseLocation(target.split('?')[0], '');
          if (r.valid) switchTab(r.tab, { section: r.section });
        }
      } else if (event.data.type === 'PUSH_RECEIVED') {
        // If we are on the bookings tab, refresh it automatically so they see the new spot
        if (currentTabId === 'my-bookings') {
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
      toggleBtn.textContent = COPY.notifications.requiresInstall;
      toggleBtn.disabled = true;
      statusDesc.textContent = COPY.notifications.iosInstallHelp;
    } else {
      toggleBtn.textContent = COPY.notifications.unsupported;
      toggleBtn.disabled = true;
      statusDesc.textContent = COPY.notifications.unsupportedHelp;
    }
    return;
  }

  if (!('PushManager' in window)) {
    if (isIOS && isStandalone) {
      toggleBtn.textContent = COPY.notifications.unsupported;
      toggleBtn.disabled = true;
      statusDesc.textContent = COPY.notifications.iosVersionHelp;
    } else {
      toggleBtn.textContent = COPY.notifications.unsupported;
      toggleBtn.disabled = true;
      statusDesc.textContent = COPY.notifications.unsupportedHelp;
    }
    return;
  }

  const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
  if (subscription) {
    toggleBtn.textContent = COPY.notifications.disablePush;
    toggleBtn.className = 'psycle-btn-mini success';
    statusDesc.textContent = COPY.notifications.pushEnabled;
  } else {
    toggleBtn.textContent = COPY.notifications.enablePush;
    toggleBtn.className = 'psycle-btn-mini';
    statusDesc.textContent = COPY.notifications.pushHelp;
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
      showToast(COPY.notifications.pushDisabled, 'info');
    } else {
      // Request permissions
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error(COPY.notifications.permissionDenied);
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
      showToast(COPY.notifications.pushEnabledToast, 'success');
      
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

// Gym logo on the gym's brand plate. Both wordmark sizes are always in the DOM;
// `.psycle-badges-compact` on the container (see fitHeaderBadges) picks the mark.
// Assets and plate come from the same presentation contract gymBrand() reads.
function gymBadgeLogo(gymId, shortName) {
  const brand = gymBrand(gymId);
  const w = getGymPresentation(gymId)?.wordmark || {};
  const wide = w.compact || w.full, mark = w.mark;
  const name = escapeHtml(brand.name || shortName);
  if (!wide && !mark) {
    return `<span class="psycle-hgb-logo" aria-hidden="true" style="background:${brand.brandBg}"><span class="psycle-hgb-logo-text">${name}</span></span>`;
  }
  const img = (cls, src) => wordmarkElement(cls, src);
  // squareMark gyms (very wide wordmark): the header pill shows the short MARK, like the other gyms' marks.
  if (brand.squareMark && mark) {
    return `<span class="psycle-hgb-logo is-markonly" aria-hidden="true" style="background:${brand.brandBg}">${img('psycle-hgb-logo-mark', mark.src)}</span>`;
  }
  return `<span class="psycle-hgb-logo" aria-hidden="true" style="background:${brand.brandBg}">`
    + (wide ? wordmarkElement('psycle-hgb-logo-wide', wide.src, brand.logoWidth ? ' style="height:9px"' : '') : '')
    + (mark ? img('psycle-hgb-logo-mark', mark.src) : (wide ? img('psycle-hgb-logo-mark', wide.src) : ''))
    + `</span>`;
}

function renderGymBadge(container, gymId, shortName, isMetered, total, credits) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'psycle-header-gym-badge';
  badge.setAttribute('data-gym', gymId);
  if (isMetered) {
    badge.innerHTML = `${gymBadgeLogo(gymId, shortName)}<span class="psycle-hgb-pill">${total}<span class="psycle-hgb-unit"> ${COPY.shell.creditUnit}</span></span>`;
    badge.title = formatCopyText(COPY.shell.creditBadgeTitle, { gymName: shortName, total, plural: total !== 1 ? 's' : '' });
  } else if (canBookAtAll(gymId)) {
    // "Active" alone reads as "this is the currently-selected gym" rather than
    // "your membership is active" — found ambiguous 2026-09-02, back when the
    // app did have a gym switcher. The switcher is gone, but "Member" is still
    // the clearer word for what this badge means; the full sentence lives in
    // the hover title. Gated on `canBookAtAll` (C3-3): permissive while
    // eligibility hasn't loaded yet (same unknown-defaults-ON rule as
    // capabilities), but never shown once the server has confirmed this
    // account has no active membership at this gym.
    badge.innerHTML = `${gymBadgeLogo(gymId, shortName)}<span class="psycle-hgb-pill member">${hasConfirmedAccess(gymId) ? '\u221E' : COPY.shell.member}</span>`;
    badge.title = formatCopyText(COPY.shell.membershipBadgeTitle, { gymName: shortName });
  } else {
    // C3-3: an unmetered gym with no active membership (and no usable
    // credits) is a real, confirmed state — showing "Member" here was the
    // bug this branch exists to fix, not a permissive default to preserve.
    badge.innerHTML = `${gymBadgeLogo(gymId, shortName)}<span class="psycle-hgb-pill">${COPY.shell.noMembershipBadge}</span>`;
    badge.title = formatCopyText(COPY.shell.ineligibleBadgeTitle, { gymName: shortName, reason: getIneligibleReason(gymId) || COPY.shell.noActiveMembership });
  }
  // The chip is a shortcut to that gym's own Settings pane (the credit modal it
  // used to open is gone). Keep the hover title (it carries the balance) but
  // give assistive tech the action.
  badge.setAttribute('aria-label', formatCopyText(COPY.shell.openGymSettings, { gymName: shortName }));
  badge.onclick = () => {
    switchTab('settings');
    import('./ui/settings').then((m) => m.openGymSettings(gymId)).catch((err) => console.error('Open gym settings failed:', err));
  };
  container.appendChild(badge);
  // U4-2: a chip rebuilt mid-load must keep animating.
  applyGymLoadState(container);
  fitHeaderBadges(true);
  requestAnimationFrame(() => fitHeaderBadges(true)); // re-check once layout has settled
}

// Switch ALL badges to the small mark when the full set would overflow the header.
// Full width is measured (with the wide logos) on each render and cached; resize
// only compares against that cache, with 24px hysteresis so it cannot oscillate.
// U4-2: header chips double as per-gym loading indicators (state in gym-load-state.js).
onGymLoadChange(() => applyGymLoadState(document.getElementById('psycle-header-credits')));
let fullBadgesWidth = 0;
let badgeFitObserver = null;
function fitHeaderBadges(remeasure) {
  const box = document.getElementById('psycle-header-credits');
  const header = document.querySelector('.psycle-header');
  if (!box || !header) return;
  const wasCompact = box.classList.contains('psycle-badges-compact');
  if (remeasure) {
    box.classList.remove('psycle-badges-compact');
    const kids = [...box.children];
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
    fullBadgesWidth = kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
  }
  const cs = getComputedStyle(header);
  const title = header.querySelector('.psycle-title-area');
  const email = header.querySelector('.psycle-user-email');
  const emailW = email && getComputedStyle(email).display !== 'none' ? email.getBoundingClientRect().width + 16 : 0;
  const avail = header.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    - (title ? title.getBoundingClientRect().width : 0) - emailW - 16;
  const compact = wasCompact ? fullBadgesWidth + 24 > avail : fullBadgesWidth > avail;
  box.classList.toggle('psycle-badges-compact', compact);
  if (!badgeFitObserver && typeof ResizeObserver !== 'undefined') {
    badgeFitObserver = new ResizeObserver(() => fitHeaderBadges(false));
    badgeFitObserver.observe(header);
  }
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
    renderGymBadge(creditsContainer, getDefaultGymId(), getGymShortName(getDefaultGymId()), true, total, credits);
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
  // A gym whose fetch failed is absent from `byGym` (unknown); keep the last
  // value we DID have for it rather than dropping to zero (U1-13).
  cache.creditsByGym = { ...(cache.creditsByGym || {}), ...byGym };
  // Same reason as eligibilityByGym: rows rendered before this landed were
  // rendered permissively and need the real answer.
  repaintTimetableIfVisible();
  repaintAutoBookIfVisible();
  creditsContainer.innerHTML = '';
  linked.forEach(gym => {
    const gymId = gym.gym_id || gym.id;
    const credits = cache.creditsByGym[gymId] || [];
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

/**
 * U1-13: the Auto-Book / Auto-Upgrade cards decide "Insufficient Credits" from
 * cache.creditsByGym / eligibilityByGym at paint time and used to never repaint,
 * so a card painted before (or without) the real answer kept its wrong state.
 * Repaints from the already-loaded queue; no refetch.
 */
function repaintAutoBookIfVisible() {
  if (currentTabId !== 'auto-book') return;
  import('./ui/autobook')
    .then((m) => { if (typeof m.repaintAutoBookFromCache === 'function') m.repaintAutoBookFromCache(); })
    .catch(() => {});
}

// --- OFFLINE CONNECTIVITY ---
let isOffline = false;
let probeTimeout = null;
let lastOfflineSnapshotAt = null;

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
  lastOfflineSnapshotAt = null;
  document.documentElement.classList.remove('psycle-offline');
  hideOfflineBanner();
  debugLog('Back online', 'success');
}

function showOfflineBanner(reason) {
  const banner = document.getElementById('psycle-offline-banner');
  if (!banner) return;
  const textSpan = banner.querySelector('.offline-text');
  if (textSpan) {
    textSpan.textContent = lastOfflineSnapshotAt
      ? formatCopyText(COPY.shell.offlineSavedData, {
        time: noSept(new Date(lastOfflineSnapshotAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })),
      })
      : COPY.shell.offline;
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

// Real reachability check. ANY HTTP response from our own server (even 401/5xx)
// proves the network path works; only a thrown fetch means unreachable.
async function checkReachable() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch('/api/health?_=' + Date.now(), { cache: 'no-store', signal: controller.signal });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

let recoveryTimer = null;
function scheduleRecovery(delayMs = 5000) {
  if (recoveryTimer || !isOffline) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (!isOffline) return;
    await probeConnectivity(0);
    if (isOffline) scheduleRecovery(Math.min(delayMs * 2, 30000));
  }, delayMs);
}

// Resolves true when online. delayMs=0 probes immediately (Retry button).
function probeConnectivity(delayMs = 300) {
  if (probeTimeout) clearTimeout(probeTimeout);
  return new Promise((resolve) => {
    probeTimeout = setTimeout(async () => {
      probeTimeout = null;
      let ok = await checkReachable();
      if (!ok && navigator.onLine !== false) ok = await checkReachable(); // one fresh-socket retry
      if (ok) setOnline();
      resolve(ok);
    }, delayMs);
  });
}

// A failed request is only a hint: confirm with a real probe before latching offline.
async function verifyThenSetOffline(reason) {
  if (isOffline) return;
  if (navigator.onLine === false) { setOffline(reason); return; }
  const ok = await checkReachable() || await checkReachable();
  if (ok) { setOnline(); return; }
  setOffline(reason);
  scheduleRecovery();
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
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.innerHTML = '<span class="offline-icon" aria-hidden="true">⚠</span><span class="offline-text"></span><button type="button" class="psycle-offline-retry">Retry</button>';
  container.insertBefore(banner, container.firstChild);

  banner.querySelector('.psycle-offline-retry')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '…';
    try { await probeConnectivity(0); } finally { btn.disabled = false; btn.textContent = label; }
  });

  window.addEventListener('offline', () => { setOffline('browser'); scheduleRecovery(); });
  window.addEventListener('online', () => probeConnectivity(0));
  window.addEventListener('psycle-network-fail', () => verifyThenSetOffline('network-error'));
  // A successful API response IS proof of connectivity — no extra probe needed.
  window.addEventListener('psycle-network-ok', () => { if (isOffline && navigator.onLine !== false) setOnline(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isOffline) probeConnectivity(0);
  });
  window.addEventListener('psycle-offline-snapshot', (event) => {
    const savedAt = Number(event.detail?.savedAt);
    if (!Number.isFinite(savedAt)) return;
    lastOfflineSnapshotAt = Math.max(lastOfflineSnapshotAt || 0, savedAt);
    if (isOffline) showOfflineBanner('snapshot');
  });

  if (!navigator.onLine) {
    setOffline('initial');
    scheduleRecovery();
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
    setGymCatalogue(catalogue);
    const linkedFull = (linked || []).map(lg => {
      const found = catalogue.find(cg => cg.id === (lg.gym_id || lg.id));
      return found ? { ...found, ...lg } : lg;
    });
    // C3-6: this used to also pick ONE gym (`linked[0]`) and call
    // `setGymContext(active)` — an ambient "the active gym" the rest of
    // gym-context.js defaulted to whenever a caller hadn't been threaded with
    // an explicit gym, the client twin of the server-side "active gym" bug
    // class removed 2026-09-16. `setLinkedGyms()` now does everything that
    // mattered without picking one: it gates capabilities per row
    // (`canForGym`/`capabilityForGym`, already explicit-gym everywhere they're
    // called) and fans theming/copy out across every linked gym instead of
    // guessing one (`applyGymFonts`/`applyGymNames`).
    setLinkedGyms(linkedFull);
    if (linkedFull.length > 0) {
      debugLog(`Linked gyms: ${linkedFull.map((g) => `${g.name} (${Object.entries(g.capabilities || {}).filter(([, v]) => v === true).map(([k]) => k).join(', ') || 'no flags'})`).join('; ')}`, 'info');
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
    //
    // C3-17: one fetch set PER LINKED GYM, each naming its gym. These used to be
    // asked with no gym, so on a multi-gym account the answer was whichever gym
    // the server defaults to, and everything downstream (bookmarks, the
    // detected booking window, credit fallbacks) silently read that one gym's
    // data as if it were the account's. A gym whose fetch fails is left out; the
    // refresh only fails if every gym does.
    const linkedGyms = getLinkedGyms() || [];
    const gymIds = linkedGyms.map((g) => g.gym_id || g.id).filter(Boolean);
    const targets = gymIds.length ? gymIds : [null]; // no gym linked yet: ambient, as before
    const perGym = await Promise.all(targets.map(async (gymId) => {
      try {
        const [normalized, credits, eligibility, gymSettings] = await Promise.all([
          api.getNormalizedProfile(gymId),
          api.getNormalizedCredits(gymId).catch(() => null),
          // Allowed to fail on its own too — an adapter with no real
          // implementation defaults permissive server-side, so losing this
          // fetch should never itself block booking; see credit-allowance.js.
          api.getEligibility(gymId).catch(() => null),
          api.getSettings(gymId).catch(() => null),
        ]);
        return { gymId, profile: { ...(normalized.raw || {}), ...normalized }, credits, eligibility, gymSettings };
      } catch (error) {
        return { gymId, error };
      }
    }));
    const loaded = perGym.filter((r) => r.profile);
    if (!loaded.length) throw perGym[0].error;

    cache.profilesByGym = {};
    cache.gymSettings = { ...(cache.gymSettings || {}) };
    for (const r of loaded) {
      if (!r.gymId) continue;
      cache.profilesByGym[r.gymId] = r.profile;
      if (r.gymSettings) cache.gymSettings[r.gymId] = r.gymSettings;
    }

    // `cache.profile`/`cache.eligibility` remain as the SINGLE-gym fallbacks the
    // credit arithmetic reads when no gym is named. With several gyms they are
    // simply the first loaded gym's; nothing that asks about one gym reads them.
    const first = loaded[0];
    const profile = first.profile;
    cache.profile = profile;
    cache.eligibility = first.eligibility;
    if (gymIds.length) {
      // Per-gym eligibility for merged lists. Until it lands the unknown-defaults-
      // permissive rule keeps rows safe; a failed gym is null, not the default's.
      cache.eligibilityByGym = Object.fromEntries(
        perGym.map((r) => [r.gymId, r.error ? null : r.eligibility]),
      );
      // Re-render now that the real per-gym answers exist: rows painted before
      // this were rendered permissively (see credit-allowance.js).
      repaintTimetableIfVisible();
      repaintAutoBookIfVisible();
      // C3-3: same for the header "Member" badge.
      updateCreditBadge().catch(() => {});
    }

    const emailEl = document.querySelector('.psycle-user-email');
    if (emailEl) {
      emailEl.textContent = currentUser?.email || profile.email || '';
    }

    // 2. Settings. The account-scoped keys are identical whichever gym's merged
    // blob they come from; the gym-scoped keys live in `cache.gymSettings` and
    // are read through gymSetting(). The blob is only the no-gym fallback.
    const settings = first.gymSettings || (gymIds.length ? null : await api.getSettings());
    if (settings && Object.keys(settings).length > 0) {
      Object.assign(userSettings, settings);
    }

    // 3. Credit inventory, via the gym-agnostic route. Empty for a membership
    // gym, which is correct — there is no balance to draw down.
    const availableCredits = first.credits ?? (profile.available_credits || []);
    cache.credits = availableCredits;
    // Keep `.available_credits` populated for the credit arithmetic, which reads
    // it off the cached profile.
    cache.profile.available_credits = availableCredits;

    // Update credit badge in header
    updateCreditBadge(availableCredits);

    // 4. Auto-detect each gym's booking window from ITS OWN profile cutoffs and
    // persist it against that gym so the server scheduler reads the same window.
    // The detector encodes the weekly-release model, so only gyms that use one.
    for (const r of loaded) {
      const kind = (linkedGyms.find((g) => (g.gym_id || g.id) === r.gymId)?.capabilities || {}).bookingWindow;
      if (kind && kind !== 'rolling-weekly') continue;
      await syncDetectedBookingWindow(r.profile, r.credits ?? (r.profile.available_credits || []), r.gymId);
    }

  } catch (err) {
    console.error('[App] Failed to refresh user credentials:', err);
  }
}

// Detect the booking window and persist it to settings when it changes. Stores the
// full detection result on cache.bookingWindow for the Settings indicator to render.
async function syncDetectedBookingWindow(profile, credits, gymId = null) {
  try {
    const detected = detectBookingWindow(profile, credits);
    if (!detected) return;
    // The Settings indicator reads this; with several gyms it holds the last
    // detected gym's window, and the per-gym truth is cache.gymSettings[gymId].
    cache.bookingWindow = detected;

    // Persist the offset (read by the server scheduler) plus the full detection result
    // (so the admin panel can render the same window the user sees). Re-persist when
    // either the offset or the serialised window changes. Both keys are gym-scoped,
    // so the comparison is against THIS gym's stored values (C3-18), not a blob
    // that holds whichever gym was mirrored into it last.
    const stored = (gymId && cache.gymSettings[gymId]) || userSettings;
    const windowChanged = JSON.stringify(stored.bookingWindow) !== JSON.stringify(detected);
    if (stored.detectedBookingOffset !== detected.offsetDays || windowChanged) {
      // The window was derived from THIS profile's cutoffs, so it is saved
      // against the gym the profile came from.
      const newSettings = { detectedBookingOffset: detected.offsetDays, bookingWindow: detected };
      await api.updateSettings(newSettings, gymId || profile.gymId || null);
      if (gymId) cache.gymSettings[gymId] = { ...(cache.gymSettings[gymId] || {}), ...newSettings };
      else Object.assign(userSettings, newSettings);
      debugConsole(`[App] Detected booking window (${gymId || 'default'}): ${detected.weeks} week(s) / ${detected.offsetDays}d (${detected.source})`);
    }
  } catch (err) {
    console.warn('[App] Booking window detection failed:', err.message);
  }
}

export async function initApp() {
  // U1-15: any booking/cancel/swap/waitlist mutation updates the shared booked
  // state at once and repaints the timetable (idempotent).
  installBookingState(() => repaintTimetableIfVisible());
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
  if (buildTimeEl) buildTimeEl.textContent = noSept(new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));

  // Restore tab from URL hash if available, otherwise default to Home
  // A valid hash (deep link / push click / refresh) wins; a fresh session lands on Home.
  // U4-19: legacy #hash (old bookmarks / push payloads) -> clean path first, permanently.
  migrateLegacyHash();
  const route = currentRoute();
  applyCreditsTabGate(); // TEMP: credits hidden unless debugMode (restore by removing gate)
  // The URL already names the tab ('none'); an unknown path is normalised to Home ('replace').
  switchTab(route.valid ? route.tab : 'home', { section: route.section, history: route.valid ? 'none' : 'replace' });
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
      const destination = await getPostLoginDestination().catch(() => null);
      if (destination === 'full') {
        resumeOnboarding();
        return;
      }
      if (destination === 'optional') {
        resumeOnboarding({ optionalOnly: true });
        return;
      }
      initApp();
    } catch (err) {
      // Distinguish auth failure (401) from network error (offline).
      // 401 errors fire 'psycle-logout-triggered' which already calls showLogin() + clears cache.
      // Network errors (offline) should NOT log out — the token may still be valid.
      const isAuthError = err.message && err.message.includes('session has expired');
      if (isAuthError) {
        // 401 — showLogin() already called by psycle-logout-triggered handler
      } else if (getIsOffline() || err instanceof TypeError) {
        // Network error (server unreachable) with valid token — init app with cached data.
        // The offline banner is already showing via the psycle-network-fail event handler.
        // Cache prefix was restored above from localStorage.
        // A cold reload can reach this catch before the connectivity event has
        // updated module state, so the fetch TypeError is also authoritative.
        if (!getIsOffline()) { setOffline('status-request'); scheduleRecovery(); }
        // Onboarding can only advance with live requests. A returning account
        // with cached data must see its read-only app while offline instead of
        // an onboarding shell that hides both the login and app containers.
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
    // Existing, logged-out user: on a mobile browser tab offer the install step once, then the login screen.
    offerInstallBeforeLogin().catch(() => {}).finally(showLogin);
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
  // Per-gym copies belong to the previous account too.
  cache.profilesByGym = {};
  cache.gymSettings = {};
  document.body.id = 'psycle-helper-container';
  document.body.className = 'psycle-helper-expanded';
  document.getElementById('psycle-app-container').style.display = 'none';
  document.getElementById('psycle-login-container').style.display = 'flex';
}

// Shared post-login routing. During onboarding we hand control back to the flow
// (which calls initApp() at its finish step); otherwise we boot the app directly.
async function onLoginSuccess() {
  promoteInstallDismissal();
  if (isOnboardingActive()) {
    advanceAfterLogin();
    return;
  }
  const destination = await getPostLoginDestination().catch(() => null);
  if (destination === 'full') {
    resumeOnboarding();
    return;
  }
  if (destination === 'optional') {
    resumeOnboarding({ optionalOnly: true });
    return;
  }
  if (destination === 'home') {
    await initApp();
    return;
  }

  if (shouldShowOnboarding()) {
    resumeOnboarding();
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
      submitBtn.querySelector('span').textContent = COPY.auth.loggingIn;

      const user = await api.login(email, password);
      currentUser = user;
      setCacheKeyPrefix(currentUser.id);
      localStorage.setItem('psycleUserId', currentUser.id);
      showToast(COPY.auth.loginSuccess, 'success');

      await onLoginSuccess();
    } catch (err) {
      const isNetworkErr = err instanceof TypeError;
      const msg = isNetworkErr
        ? COPY.auth.connectionFailed
        : COPY.auth.incorrectCredentials;
      if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
      else showToast(msg, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = COPY.auth.logIn;
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
  document.getElementById('psycle-auth-title').textContent = COPY.auth.connectGym;
  document.getElementById('psycle-auth-subtitle').textContent =
    formatCopyText(COPY.auth.accountReady, { appName: appConfig.appName });
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
      <label for="psycle-nogym-gym">${COPY.static.gym}</label>
      <select id="psycle-nogym-gym" class="psycle-select" style="width:100%;"><option>${COPY.static.loading}</option></select>
    </div>
    <div class="psycle-form-group">
      <label for="psycle-nogym-email">${COPY.auth.gymEmail}</label>
      <input type="email" id="psycle-nogym-email" placeholder="${COPY.static.emailPlaceholder}" autocomplete="off">
    </div>
    <div class="psycle-form-group">
      <label for="psycle-nogym-password">${COPY.auth.gymPassword}</label>
      <input type="password" id="psycle-nogym-password" placeholder="${COPY.static.passwordPlaceholder}" autocomplete="off">
    </div>
    <div id="psycle-nogym-error" class="psycle-login-error" style="display:none;"></div>
    <button type="button" id="psycle-nogym-submit" class="psycle-btn-primary"><span>${COPY.auth.connectGymButton}</span></button>
  `;

  const sel = panel.querySelector('#psycle-nogym-gym');
  const errorEl = panel.querySelector('#psycle-nogym-error');
  api.getGyms().then(gyms => {
    const available = gyms.filter(g => g.enabled);
    sel.innerHTML = available.length
      ? available.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')
      : `<option value="">${COPY.auth.noGymsAvailable}</option>`;
  }).catch(() => { sel.innerHTML = `<option value="">${COPY.auth.couldNotLoadGyms}</option>`; });

  panel.querySelector('#psycle-nogym-submit').onclick = async () => {
    const btn = panel.querySelector('#psycle-nogym-submit');
    errorEl.style.display = 'none';
    const gymId = sel.value;
    const email = panel.querySelector('#psycle-nogym-email').value.trim();
    const password = panel.querySelector('#psycle-nogym-password').value;
    if (!gymId || !email || !password) {
      errorEl.textContent = COPY.auth.requiredGymCredentials;
      errorEl.style.display = 'block';
      return;
    }
    btn.disabled = true;
    btn.querySelector('span').textContent = COPY.auth.connecting;
    try {
      await api.linkGym(gymId, email, password);
      panel.style.display = 'none';
      showToast(COPY.auth.gymConnected, 'success');
      await onLoginSuccess();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.querySelector('span').textContent = COPY.auth.connectGymButton;
    }
  };
  applyAppName();
}

// ─── Auth screen modes (WP-C2 / Decision D4) ──────────────────────────────────
// One card, three modes: sign in, create account, recover. A Sweat Assistant
// account is its own thing now, so signing up no longer means handing over a gym
// credential — gyms are linked afterwards.
const AUTH_MODES = {
  login:  { title: COPY.auth.logInSentenceCase, subtitle: COPY.auth.signInSubtitle },
  signup: { title: COPY.auth.createAccount, subtitle: COPY.auth.signupSubtitle },
  // C1-4: this used to describe the gym-login recovery flow removed by
  // Decision D5 (2026-08-31) — a gym credential can no longer prove identity
  // for the Sweat Assistant account. There is no self-service reset yet
  // (Workstreams C6-1); say so plainly instead of describing a flow that
  // can't complete.
  recover:{ title: COPY.auth.resetPassword, subtitle: COPY.auth.resetUnavailable },
};

function setAuthMode(mode) {
  const cfg = AUTH_MODES[mode] || AUTH_MODES.login;
  document.getElementById('psycle-auth-title').textContent = cfg.title;
  document.getElementById('psycle-auth-subtitle').textContent =
    formatCopyText(cfg.subtitle, { appName: appConfig.appName });
  document.getElementById('psycle-login-form').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('psycle-signup-form').style.display = mode === 'signup' ? '' : 'none';
  document.getElementById('psycle-recover-form').style.display = mode === 'recover' ? '' : 'none';

  // Recovery always restarts at step 1 — landing mid-flow with a stale gym list
  // would be confusing and could show gyms for a different email.
  //
  // C1-4: `#psycle-recover-step2` was the gym-picker step of the self-service
  // gym-login recovery flow removed by Decision D5 (2026-08-31, see the
  // AGENTS.md "Never make a gym credential a recovery factor" note). The
  // markup went with it (client/index.html now has only `#psycle-recover-
  // step1`), but this reference to step2 didn't, so every "Forgot password?"
  // click threw a TypeError on `.style` of null and the mode never rendered.
  if (mode === 'recover') {
    document.getElementById('psycle-recover-step1').style.display = 'block';
  }
  document.querySelectorAll('.psycle-login-error').forEach(el => { el.style.display = 'none'; });
  const noGym = document.getElementById('psycle-nogym-panel');
  if (noGym) noGym.style.display = 'none';

  const switcher = document.getElementById('psycle-auth-switcher');
  switcher.innerHTML = mode === 'login'
    ? `<a href="#" id="psycle-auth-to-signup">${COPY.auth.createAnAccount}</a>&nbsp;·&nbsp;<a href="#" id="psycle-auth-to-recover">${COPY.auth.forgotPassword}</a>`
    : `<a href="#" id="psycle-auth-to-login">${COPY.auth.backToLogIn}</a>`;
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

    if (password.length < 8) return fail(COPY.auth.passwordMinLength);
    if (password !== confirm) return fail(COPY.auth.passwordMismatch);

    btn.disabled = true;
    btn.querySelector('span').textContent = COPY.auth.creating;
    try {
      const { user } = await api.signup(email, password);
      currentUser = user;
      setCacheKeyPrefix(currentUser.id || email);
      localStorage.setItem('psycleUserId', currentUser.id || email);
      showToast(COPY.auth.accountCreated, 'success');
      await onLoginSuccess();
    } catch (err) {
      fail(err instanceof TypeError ? COPY.auth.connectionFailed : err.message);
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = COPY.auth.createAccountButton;
    }
  });
}

// Account recovery is currently ADMIN-ONLY. The previous self-service flow proved
// identity with a linked gym's login, which re-coupled the account to the gym and
// defeated Decision D4 — removed 2026-08-31. The replacement mechanism is an open
// decision (Workstreams C6-1); until it lands the screen says so plainly rather than
// offering a flow that cannot complete.
const recoverFindBtn = document.getElementById('psycle-recover-find-btn');
if (recoverFindBtn) {
  recoverFindBtn.onclick = () => {
    const errorEl = document.getElementById('psycle-recover-error');
    errorEl.textContent = COPY.auth.recoveryUnavailableLong;
    errorEl.style.display = 'block';
  };
}

// Listen for global logout triggers (e.g. from api.js 401 interceptor)
window.addEventListener('psycle-logout-triggered', () => {
  setCacheKeyPrefix('');
  clearApiCache().catch(() => {});
  showToast(COPY.auth.sessionExpired, 'warning');
  showLogin();
});

// C1-2: a single gym's session dying (`GYM_SESSION_EXPIRED`, see
// client/src/auth-failure.js) must route to THAT gym's needs-relogin state,
// not to the whole-app logout above. The server already flags the link
// `needs_relogin` (db.setUserGymStatus) before this fires, so the fix here is
// just to reflect it without delay: toast which gym, and refresh the "Your
// Gyms" list if Settings happens to be open so the "Re-authenticate" prompt
// shows immediately rather than on the next visit to the tab.
window.addEventListener('psycle-gym-needs-relogin', async (e) => {
  const gymId = e.detail?.gymId;
  const name = (gymId && getGymShortName(gymId)) || COPY.static.linkedGymFallback;
  showToast(formatCopyText(COPY.shell.gymSessionExpired, { gymName: name }), 'warning');
  try {
    const { renderGymsCard } = await import('./ui/settings');
    await renderGymsCard();
  } catch (_) { /* Settings not mounted / not the active tab — nothing to refresh */ }
});

// Back/forward: apply the tab/section from the path. modal-nav's capture-phase popstate
// listener runs first and flags events it consumed (sweatNavHandled); the router skips those.
initRouter((route) => {
  const tab = route.valid ? route.tab : 'home';
  switchTab(tab, { section: route.section, history: 'none' });
  if (tab === 'settings') document.getElementById('psycle-settings-layout-wrapper')?.__applySettingsRoute?.(route.section);
});

// App Launch
/**
 * Mobile: hide the top header on scroll down, reveal on scroll up / at top.
 * Scroll-safe by construction: the header is an overlay (see styles.css), so toggling it
 * never changes scrollHeight/clientHeight. Direction detection ignores iOS overscroll
 * (scrollTop < 0 or > max), uses a dead zone, a cool-down after each toggle, and does
 * nothing on pages too short to scroll or inside the top/bottom bounce zones.
 */
function initHeaderAutoHide() {
  const mq = window.matchMedia('(max-width: 768px)');
  const COOLDOWN_MS = 300;   // ignore samples right after a toggle (transition + momentum)
  let app = null, header = null, ticking = false, target = null;
  let anchor = 0, hidden = false;

  const els = () => {
    if (!app) app = document.getElementById('psycle-app-container');
    if (!header) header = document.querySelector('.psycle-header');
    return app && header;
  };
  const measure = () => {
    if (els() && header.offsetHeight) app.style.setProperty('--psycle-header-h', header.offsetHeight + 'px');
  };
  const setHidden = (hide) => {
    if (!els() || hide === hidden) return;
    hidden = hide;
    app.classList.toggle('psycle-hdr-hidden', hide);
    app.classList.toggle('psycle-tt-compact', hide); // timetable date strip + location chip shrink with the header
    // Safe-area cap + theme-color follow the header: header colour while it shows, page colour once it is gone.
    document.documentElement.toggleAttribute('data-hdr-hidden', hide);
    syncThemeColorMeta();
    markScrollBusy(COOLDOWN_MS);
  };
  const modalOpen = () =>
    !!document.querySelector('.psycle-modal[style*="display: flex"], .psycle-modal[style*="display: block"], .psycle-modal.open, .psycle-modal.active');

  const update = () => {
    ticking = false;
    if (!target) return;
    if (!mq.matches) { setHidden(false); return; }
    const sc = isDocScroll() ? docScroller() : target;
    const max = sc.scrollHeight - sc.clientHeight;
    // Pure hysteresis (scroll-collapse.js): header hide and the timetable's compact bar share this one state.
    const next = nextCollapseState({
      top: sc.scrollTop, max, anchor, collapsed: hidden, busy: isScrollBusy(),
      modalOpen: modalOpen(), headerH: (header && header.offsetHeight) || 47,
    });
    anchor = next.anchor;
    setHidden(next.collapsed);
  };

  document.addEventListener('scroll', (e) => {
    let t = e.target;
    if (isDocScroll()) {
      // Mobile: the DOCUMENT scrolls (scroll events target `document`); ignore inner boxes.
      if (t !== document && t !== document.documentElement && t !== document.body) return;
      t = docScroller();
    } else if (!t || !t.classList || !(t.classList.contains('psycle-body') || t.classList.contains('psycle-main'))) return;
    if (t !== target) { target = t; anchor = t.scrollTop; }
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true, capture: true });

  mq.addEventListener?.('change', () => { setHidden(false); measure(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('.psycle-bottom-nav-btn, .psycle-nav-btn')) { setHidden(false); anchor = 0; }
  }, true);
  measure();
  if (typeof ResizeObserver !== 'undefined' && els()) new ResizeObserver(measure).observe(header);
  window.addEventListener('resize', measure, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  initConnectivity();  // Set up offline listeners BEFORE checkAuth so psycle-network-fail is caught
  initGymLogoLoader();
  // Once the inline-SVG sprite is ready, repaint the header badges so they use it (no <img> decode).
  document.addEventListener('gym-logos-ready', () => { updateCreditBadge().catch(() => {}); });
  // Reveal the shell once auth has decided which screen to show AND the fonts are ready
  // (each capped), so the first visible paint is the styled one. index.html also force-reveals at 3s.
  const reveal = () => document.documentElement.classList.add('psycle-ready');
  Promise.resolve(checkAuth()).catch(() => {}).then(() =>
    Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 1200))])
  ).then(() => requestAnimationFrame(reveal));
  initTooltips();
  initHeaderAutoHide();

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

  // `initApp()` restores the hash after it has restored the account cache key.
  // Do not switch here: this DOM-ready handler runs while `checkAuth()` is
  // awaiting `/api/auth/status`, so an offline reload used to initialise the
  // timetable against the unscoped cache key. Its in-flight empty request then
  // suppressed the correctly scoped initialisation from `initApp()`.
});
