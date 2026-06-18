import { api, setToken, isLoggedIn } from './api';
import { initTooltips } from './ui/tooltips';

// Global App State
export let currentUser = null;
export let userSettings = {
  advancedBooking: false,
  autoUpgradeEnabled: true,
  autoUpgradeInterval: '15min',
  autoUpgradeByDefault: false,
  debugMode: false,
  prefetchWeeks: 4
};

// UI Cache data to avoid constant reloading
export let cache = {
  profile: null,
  bookings: [],
  waitlists: [],
  bundles: [],
  timetable: {} // keyed by date string
};

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
    info: '#94a3b8',
    success: '#34d399',
    error: '#f87171',
    warning: '#fbbf24',
    network: '#60a5fa',
    action: '#a78bfa'
  };
  const color = colors[type] || colors.info;
  const prefix = type === 'network' ? '→' : type === 'action' ? '⚡' : type === 'error' ? '✕' : type === 'success' ? '✓' : '•';
  
  const line = document.createElement('div');
  line.style.cssText = `margin: 2px 0; line-height: 1.4; word-break: break-all;`;
  line.innerHTML = `<span style="color: #64748b;">${timestamp}</span> <span style="color: ${color};">${prefix}</span> <span style="color: ${color};">${message}</span>`;
  logEl.appendChild(line);
  
  // Keep max 200 entries
  while (logEl.children.length > 200) {
    logEl.removeChild(logEl.firstChild);
  }
  
  if (debugLogExpanded) {
    logEl.scrollTop = logEl.scrollHeight;
  }
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

const VALID_TABS = ['class-timetable', 'my-bookings', 'auto-book', 'buy-credits', 'settings', 'about'];

function switchTab(tabId) {
  const targetPanelId = `psycle-panel-${tabId}`;

  // Update nav buttons
  tabButtons.forEach(btn => {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
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
      const { renderAutoUpgrades } = await import('./ui/autoupgrade');
      initAutoBook();
      renderAutoUpgrades();
    } else if (tabId === 'buy-credits') {
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

// --- SERVICE WORKER & PUSH REGISTRATION ---
let serviceWorkerRegistration = null;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    serviceWorkerRegistration = reg;
    console.log('[SW] Service Worker registered successfully scope:', reg.scope);
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
    background: rgba(167, 139, 250, 0.15);
    border: 1px solid rgba(167, 139, 250, 0.3);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    color: #c4b5fd;
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
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    padding: 24px;
    max-width: 450px;
    max-height: 80vh;
    overflow-y: auto;
    color: #e2e8f0;
  `;

  let html = `<h2 style="margin-top: 0; color: #c4b5fd; font-size: 18px;">Credit Details</h2>`;
  html += `<div class="psycle-spinner" style="margin: 20px auto;"></div>`;

  content.innerHTML = html;
  modal.appendChild(content);
  document.body.appendChild(modal);

  try {
    // Fetch detailed credits from API
    const res = await api.proxyGet('/credits?type=unused&per_page=999');
    const creditsData = res.data || [];
    const creditTypes = res.relations?.credit_types || {};

    content.innerHTML = `<h2 style="margin-top: 0; color: #c4b5fd; font-size: 18px;">Credit Details</h2>`;

    if (!creditsData || creditsData.length === 0) {
      content.innerHTML += `<p style="color: #94a3b8;">No credits available.</p>`;
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
          <div style="margin-bottom: 16px; padding: 12px; background: rgba(99, 102, 241, 0.05); border-radius: 8px; border-left: 3px solid #a78bfa;">
            <div style="font-weight: 600; color: #c4b5fd; margin-bottom: 8px;">${typeName}: <strong>${total}</strong></div>
            <div style="font-size: 11px; color: #94a3b8;">
              ${typeCredits.map(c => {
                const expiryDate = c.expires_at
                  ? new Date(c.expires_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
                  : 'No expiry';
                const isExpired = c.expires_at && new Date(c.expires_at) < new Date();
                const expiryColor = isExpired ? '#f87171' : '#94a3b8';
                return `<div style="margin-bottom: 6px; color: ${expiryColor};">• 1 credit (Expires: ${expiryDate})</div>`;
              }).join('')}
            </div>
          </div>
        `;
        content.innerHTML += html_section;
      });
    }

    content.innerHTML += `<button id="close-credit-modal" class="psycle-btn" style="width: 100%; margin-top: 16px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #e2e8f0;">Close</button>`;

  } catch (err) {
    console.error('[Credits] Failed to load details:', err);
    content.innerHTML = `
      <h2 style="margin-top: 0; color: #c4b5fd; font-size: 18px;">Credit Details</h2>
      <p style="color: #f87171;">Failed to load credit details: ${err.message}</p>
      <button id="close-credit-modal" class="psycle-btn" style="width: 100%; margin-top: 16px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #e2e8f0;">Close</button>
    `;
  }

  const closeBtn = content.querySelector('#close-credit-modal');
  closeBtn.onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

// --- INITIALIZATION & USER SESSION ---

// Fetch core user data and update UI header
export async function refreshUserData() {
  try {
    // 1. Fetch user profile from CodexFit via proxy
    const res = await api.proxyGet('/profile');
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

  } catch (err) {
    console.error('[App] Failed to refresh user credentials:', err);
  }
}

async function initApp() {
  document.getElementById('psycle-login-container').style.display = 'none';
  document.getElementById('psycle-app-container').style.display = 'flex';
  
  // Set helper expanded classes to trigger standard styles
  document.body.id = 'psycle-helper-container';
  document.body.className = 'psycle-helper-expanded';

  await refreshUserData();

  // Setup debug terminal
  updateDebugTerminalVisibility();
  const debugHeader = document.getElementById('psycle-debug-terminal-header');
  const debugLog = document.getElementById('psycle-debug-log');
  const debugClearBtn = document.getElementById('psycle-debug-clear-btn');
  const debugToggleIcon = document.getElementById('psycle-debug-toggle-icon');
  
  if (debugHeader) {
    debugHeader.addEventListener('click', (e) => {
      if (e.target === debugClearBtn) return;
      debugLogExpanded = !debugLogExpanded;
      debugLog.style.maxHeight = debugLogExpanded ? '230px' : '0';
      debugLog.style.padding = debugLogExpanded ? '8px 12px' : '0 12px';
      debugToggleIcon.textContent = debugLogExpanded ? '▼' : '▶';
    });
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
  const initialTab = VALID_TABS.includes(hash) ? hash : 'class-timetable';
  switchTab(initialTab);
}

// Check auth status on launch
async function checkAuth() {
  if (isLoggedIn()) {
    try {
      await api.getStatus();
      initApp();
    } catch (err) {
      // Local token expired or invalid
      showLogin();
    }
  } else {
    showLogin();
  }
}

function showLogin() {
  document.body.id = 'psycle-helper-container';
  document.body.className = 'psycle-helper-expanded';
  document.getElementById('psycle-app-container').style.display = 'none';
  document.getElementById('psycle-login-container').style.display = 'flex';
}

// Login Form Submit Listener
const loginForm = document.getElementById('psycle-login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('psycle-login-email').value;
    const password = document.getElementById('psycle-login-password').value;
    const submitBtn = document.getElementById('psycle-login-submit-btn');

    try {
      submitBtn.disabled = true;
      submitBtn.querySelector('span').textContent = 'Logging in...';
      
      await api.login(email, password);
      showToast('Logged in successfully!', 'success');
      
      // Trigger App startup
      await initApp();
      
      // Register push automatically
      if (serviceWorkerRegistration) {
        // Try enabling push automatically if permissions are already granted
        const permission = await navigator.permissions?.query({ name: 'notifications' });
        if (permission?.state === 'granted') {
          togglePushSubscription();
        }
      }
    } catch (err) {
      showToast(`Auth Failed: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = 'Log In to CodexFit';
    }
  });
}

// Listen for global logout triggers (e.g. from api.js 401 interceptor)
window.addEventListener('psycle-logout-triggered', () => {
  showToast('Session expired. Please log in again.', 'warning');
  showLogin();
});

// Restore tab from URL hash on back/forward navigation
window.addEventListener('popstate', () => {
  const hash = location.hash.replace('#', '');
  if (VALID_TABS.includes(hash)) switchTab(hash);
});

// App Launch
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  checkAuth();
  initTooltips();

  // Restore tab from URL hash (e.g. after page refresh)
  const hash = location.hash.replace('#', '');
  if (VALID_TABS.includes(hash)) {
    // Defer until after checkAuth initialises the app
    setTimeout(() => switchTab(hash), 0);
  }
});
