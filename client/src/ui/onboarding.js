// Sweat Assistant — first-run onboarding flow.
//
// Runs BEFORE login on first launch and walks the user through:
//   intro carousel → install to home screen → login → notifications → spot-map nudge → app.
//
// It is *resumable*: progress is persisted to localStorage so that iOS (which
// cold-launches a fresh standalone instance after "Add to Home Screen") can pick
// the flow back up at the right step instead of restarting. Every step is
// skippable and steps that don't apply (already installed / already granted /
// already has spot maps) auto-advance.
//
// Visual language follows DESIGN.md (warm token system) — all styling lives in
// the `/* === ONBOARDING === */` section of styles.css. No inline colours here.

import { api, isLoggedIn } from '../api';
import { consumeInstallPrompt, initApp, togglePushSubscription, warmCaches, showToast } from '../main';
import { openManageSpotMapsModal } from './settings';
import { appConfig } from '../config';

const COMPLETE_KEY = 'psycleOnboardingComplete';
const STEP_KEY = 'psycleOnboardingStep';
// Bump to re-trigger onboarding for all users after a significant change.
// v3: added sequential multi-gym connection step.
const ONBOARDING_VERSION = '3';

const STEPS = ['intro', 'install', 'login', 'gyms', 'notifications', 'spotmaps', 'calendar'];

// --- platform / capability detection (mirrors main.js:279) ---
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let active = false;
let loginResolver = null;

export function isOnboardingActive() {
  return active;
}

export function shouldShowOnboarding() {
  // `api.getToken()` doesn't exist — `getToken` is a standalone export of
  // api.js, not a method on the `api` object — so this threw on every
  // logged-out page load (crashing the whole boot sequence before the login
  // form could render), never on a logged-in one, since `isLoggedIn()` short-
  // circuits the `||` first. The clause was redundant anyway: both read the
  // exact same `localToken` variable, so dropping it changes nothing.
  if (isLoggedIn()) {
    localStorage.setItem(COMPLETE_KEY, ONBOARDING_VERSION);
    return false;
  }
  return localStorage.getItem(COMPLETE_KEY) !== ONBOARDING_VERSION;
}

// Called by main.js onLoginSuccess() while onboarding is active.
export function advanceAfterLogin() {
  if (loginResolver) {
    const r = loginResolver;
    loginResolver = null;
    r();
  }
}

function container() {
  return document.getElementById('psycle-onboarding-container');
}

function show() {
  document.getElementById('psycle-login-container').style.display = 'none';
  document.getElementById('psycle-app-container').style.display = 'none';
  const c = container();
  c.style.display = 'flex';
  return c;
}

// ---- public entry points ----

export function startOnboarding() {
  return runFrom(0);
}

export function resumeOnboarding() {
  const saved = localStorage.getItem(STEP_KEY);
  let idx = saved ? STEPS.indexOf(saved) : 0;
  if (idx < 0) idx = 0;
  // If we're not logged in yet, never resume past the login step.
  if (!isLoggedIn()) idx = Math.min(idx, STEPS.indexOf('login'));
  return runFrom(idx);
}

async function runFrom(startIndex) {
  active = true;
  // Apply the body id that unlocks all #psycle-helper-container-scoped CSS
  // (font-family, .psycle-btn-mini, etc.) so modals opened during onboarding
  // look identical to those opened from the main app.
  document.body.id = 'psycle-helper-container';
  try {
    for (let i = startIndex; i < STEPS.length; i++) {
      const step = STEPS[i];
      localStorage.setItem(STEP_KEY, step);
      await STEP_HANDLERS[step]();
    }
  } finally {
    active = false;
  }
  await finish();
}

async function finish() {
  localStorage.setItem(COMPLETE_KEY, ONBOARDING_VERSION);
  localStorage.removeItem(STEP_KEY);
  container().style.display = 'none';
  container().innerHTML = '';
  await initApp();
}

// ---- shared layout helpers ----

// Renders a standard centred step "sheet" and returns its inner body element.
function renderSheet({ eyebrow, title, body, footer }) {
  const c = show();
  c.innerHTML = `
    <div class="psycle-onb-sheet" role="dialog" aria-modal="true">
      ${eyebrow ? `<div class="psycle-onb-eyebrow">${eyebrow}</div>` : ''}
      ${title ? `<h2 class="psycle-onb-title">${title}</h2>` : ''}
      <div class="psycle-onb-body">${body || ''}</div>
      <div class="psycle-onb-footer">${footer || ''}</div>
    </div>`;
  return c.querySelector('.psycle-onb-sheet');
}

// ---- feature icons (inline SVG, themed via currentColor) ----
const ICON = {
  autobook: '<svg viewBox="0 0 32 32" fill="currentColor"><g data-name="Layer 2" id="Layer_2"><path d="M18,11a1,1,0,0,1-1,1,5,5,0,0,0-5,5,1,1,0,0,1-2,0,5,5,0,0,0-5-5,1,1,0,0,1,0-2,5,5,0,0,0,5-5,1,1,0,0,1,2,0,5,5,0,0,0,5,5A1,1,0,0,1,18,11Z"/><path d="M19,24a1,1,0,0,1-1,1,2,2,0,0,0-2,2,1,1,0,0,1-2,0,2,2,0,0,0-2-2,1,1,0,0,1,0-2,2,2,0,0,0,2-2,1,1,0,0,1,2,0,2,2,0,0,0,2,2A1,1,0,0,1,19,24Z"/><path d="M28,17a1,1,0,0,1-1,1,4,4,0,0,0-4,4,1,1,0,0,1-2,0,4,4,0,0,0-4-4,1,1,0,0,1,0-2,4,4,0,0,0,4-4,1,1,0,0,1,2,0,4,4,0,0,0,4,4A1,1,0,0,1,28,17Z"/></g></svg>',
  autoupgrade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  quickbook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11a9 9 0 0 1 18 0M7 15a5 5 0 0 1 10 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>',
  push: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  calendarSync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 16.5A2.5 2.5 0 0 1 13 15"/><path d="M16 15.5A2.5 2.5 0 0 1 11 17"/><path d="M13 13.5v2h2"/><path d="M11 18.5v-2H9"/></svg>',
};

// Lazy getter — reads appConfig.appName at render time, not at module load,
// so it picks up the runtime value from /api/config (initConfig runs before
// onboarding starts).
function getSlides() {
  return [
    { welcome: true, title: 'Unofficial client', text: 'Your personal gym companion — auto-booking, smart upgrades, and your favourite spots, taken care of.' },
    { feat: 'autobook', icon: ICON.autobook, title: 'Auto-Book', text: `No more release-time rush! Queue the classes you want and ${appConfig.appName} books them the instant they're released. You can even set your favourite spots in each studio.` },
    { feat: 'autoupgrade', icon: ICON.autoupgrade, title: 'Auto-Upgrade', text: `Didn't get your favourite spot? ${appConfig.appName} can monitor for a better one from your preferred spot map, and move you up automatically.` },
    { feat: 'quickbook', icon: ICON.quickbook, title: 'Quick-Book', text: 'Once you\'ve set your favourite spots, booking happens in a single tap.' },
    { feat: 'offline', icon: ICON.offline, title: 'Works Offline', text: 'Your timetable and bookings stay readable on the tube or anywhere signal drops.' },
    { feat: 'push', icon: ICON.push, title: 'Stay Notified', text: 'Get a push when you\'re booked in, upgraded, or to remind you about an upcoming class.' },
    { feat: 'calendar', icon: ICON.calendarSync, title: 'Calendar Sync', text: 'Automatically sync your classes to your calendar, so you never forget an upcoming session.' },
  ];
}

// ---- STEP: intro carousel ----
function stepIntro() {
  return new Promise((resolve) => {
    const slides = getSlides();
    const c = show();
    c.innerHTML = `
      <div class="psycle-onb-sheet psycle-onb-intro" role="dialog" aria-modal="true">
        <button class="psycle-onb-skip" type="button" aria-label="Skip introduction">Skip</button>
        <div class="psycle-onb-carousel">
          <div class="psycle-onb-track">
            ${slides.map((s) => s.welcome ? `
              <div class="psycle-onb-slide psycle-onb-slide-welcome">
                <div class="psycle-onb-wordmark">${appConfig.appName}</div>
                <h2 class="psycle-onb-title psycle-onb-welcome-title">${s.title}</h2>
                <p class="psycle-onb-slide-text">${s.text}</p>
                <p class="psycle-onb-secondary-note">This app needs to securely store your gym login to work in the background. You could alternatively use this <a href="https://github.com/piersjones/psycle-chrome">chrome extension</a> for similar functionality on Psycle, but it requires the Psycle website to be open for automatic features to work.</p>
              </div>` : `
              <div class="psycle-onb-slide">
                <div class="psycle-onb-icon" style="color: var(--feat-${s.feat}, var(--accent));">${s.icon}</div>
                <h2 class="psycle-onb-title">${s.title}</h2>
                <p class="psycle-onb-slide-text">${s.text}</p>
              </div>`).join('')}
          </div>
        </div>
        <div class="psycle-onb-dots">
          ${slides.map((_, i) => `<button class="psycle-onb-dot${i === 0 ? ' is-active' : ''}" type="button" aria-label="Go to slide ${i + 1}"></button>`).join('')}
        </div>
        <div class="psycle-onb-footer">
          <button class="psycle-btn-primary psycle-onb-next" type="button"><span>Next</span></button>
        </div>
      </div>`;

    const track = c.querySelector('.psycle-onb-track');
    const dots = [...c.querySelectorAll('.psycle-onb-dot')];
    const nextBtn = c.querySelector('.psycle-onb-next');
    const nextLabel = nextBtn.querySelector('span');
    let index = 0;

    const goto = (i) => {
      index = Math.max(0, Math.min(slides.length - 1, i));
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((d, di) => d.classList.toggle('is-active', di === index));
      nextLabel.textContent = index === slides.length - 1 ? 'Get started' : 'Next';
    };

    nextBtn.addEventListener('click', () => {
      if (index === slides.length - 1) resolve();
      else goto(index + 1);
    });
    dots.forEach((d, di) => d.addEventListener('click', () => goto(di)));
    c.querySelector('.psycle-onb-skip').addEventListener('click', resolve);

    // Touch swipe
    let startX = 0, dragging = false;
    const carousel = c.querySelector('.psycle-onb-carousel');
    carousel.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; dragging = true; }, { passive: true });
    carousel.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) goto(index + (dx < 0 ? 1 : -1));
    }, { passive: true });

    goto(0);
  });
}

// ---- STEP: install to home screen ----
function stepInstall() {
  return new Promise((resolve) => {
    if (isStandalone()) return resolve(); // already installed — skip

    const promptEvent = consumeInstallPrompt();
    const ios = isIOS();

    const reasoning = `
      <ul class="psycle-onb-reasons">
        <li><span class="psycle-onb-reason-icon">${ICON.push}</span><div><strong>Push notifications</strong><br>Booking, upgrade & cancellation alerts (required on iPhone & iPad).</div></li>
        <li><span class="psycle-onb-reason-icon">${ICON.offline}</span><div><strong>Offline viewing</strong><br>Your timetable & bookings stay available without signal.</div></li>
      </ul>`;

    let body;
    let primary;
    if (promptEvent) {
      // Android / desktop Chromium — native one-tap install
      body = `<p class="psycle-onb-lead">Add ${appConfig.appName} to your device for the full experience.</p>${reasoning}`;
      primary = `<button class="psycle-btn-primary psycle-onb-install" type="button"><span>Install app</span></button>`;
    } else if (ios) {
      body = `<p class="psycle-onb-lead">Add ${appConfig.appName} to your Home Screen for the full experience.</p>${reasoning}
        <ol class="psycle-onb-steps">
<li>Tap the <strong>Share</strong> button <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.1em; height: 1.1em; display: inline-block; vertical-align: middle; margin: 0 2px;"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> in Safari’s toolbar.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Open ${appConfig.appName} from your new icon to continue.</li>
        </ol>`;
      primary = '';
    } else {
      // Android browser without beforeinstallprompt, or other
      body = `<p class="psycle-onb-lead">Add ${appConfig.appName} to your device for the full experience.</p>${reasoning}
        <ol class="psycle-onb-steps">
          <li>Open your browser’s <strong>⋮ menu</strong>.</li>
          <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
        </ol>`;
      primary = '';
    }

    const sheet = renderSheet({
      eyebrow: 'Get the full experience',
      title: `Install ${appConfig.appName}`,
      body,
      footer: `${primary}<button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Continue in browser</button>`,
    });

    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    const installBtn = sheet.querySelector('.psycle-onb-install');
    if (installBtn && promptEvent) {
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        try {
          promptEvent.prompt();
          await promptEvent.userChoice;
        } catch (_) {}
        resolve();
      });
    }
  });
}

// ---- STEP: login ----
function stepLogin() {
  return new Promise((resolve) => {
    if (isLoggedIn()) return resolve(); // already authenticated (resume case)

    // Hand off to the existing login container + handler in main.js. On success,
    // main.js onLoginSuccess() calls advanceAfterLogin() → resolves this promise.
    loginResolver = () => {
      // Kick off background cache warm so the app feels instant at finish.
      warmCaches();
      resolve();
    };
    container().style.display = 'none';
    document.getElementById('psycle-login-container').style.display = 'flex';
  });
}

// ---- STEP: gym linking (sequential multi-gym setup) ----
function stepGyms() {
  return new Promise(async (resolve) => {
    let allGyms = [];
    let myGyms = [];

    const loadData = async () => {
      try {
        const [gymsRes, mineRes] = await Promise.all([
          api.getGyms(),
          api.getMyGyms(),
        ]);
        const rawGyms = gymsRes.gyms || gymsRes || [];
        allGyms = rawGyms.filter((g) => g.enabled !== false);
        myGyms = mineRes.gyms || mineRes || [];
      } catch (_) {
        allGyms = [];
        myGyms = [];
      }
    };

    await loadData();

    // If no enabled gyms exist in system, auto-advance
    if (allGyms.length === 0) return resolve();

    const render = () => {
      const linkedGymIds = new Set(myGyms.map((g) => g.gym_id || g.gymId || g.id));
      const unlinkedGyms = allGyms.filter((g) => !linkedGymIds.has(g.id));
      const hasLinked = myGyms.length > 0;

      const connectedListHtml = hasLinked
        ? `<div class="psycle-onb-connected-gyms" style="margin-bottom:16px;">
            <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-tertiary);margin-bottom:8px;">Connected Gyms</div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${myGyms.map(g => {
                const targetId = g.gym_id || g.gymId || g.id;
                const matchedGym = allGyms.find(ag => ag.id === targetId);
                const gName = g.gym_name || g.name || matchedGym?.name || targetId;
                const gEmail = g.gym_email || g.gymEmail || '';
                return `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-inset);border:1px solid var(--border);border-radius:10px;">
                  <div style="display:flex;align-items:center;gap:10px;">
                    <span style="color:var(--success, #10b981);font-weight:bold;font-size:16px;">✓</span>
                    <div>
                      <div style="font-size:14px;font-weight:600;">${gName}</div>
                      ${gEmail ? `<div style="font-size:12px;color:var(--text-tertiary);">${gEmail}</div>` : ''}
                    </div>
                  </div>
                  <span class="psycle-badge" style="font-size:11px;background:color-mix(in srgb,var(--success) 15%,transparent);color:var(--success);">Connected</span>
                </div>
              `;}).join('')}
            </div>
          </div>`
        : '';

      let formHtml = '';
      if (unlinkedGyms.length > 0) {
        formHtml = `
          <div class="psycle-onb-link-form" style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);border:1px solid var(--border);border-radius:12px;padding:16px;">
            <div style="font-size:13px;font-weight:600;color:var(--text-secondary);">
              ${hasLinked ? 'Connect Another Gym' : 'Connect Your Gym Account'}
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-tertiary);display:block;margin-bottom:4px;">Select Gym</label>
              <select id="psycle-onb-gym-select" class="psycle-select" style="width:100%;">
                ${unlinkedGyms.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-tertiary);display:block;margin-bottom:4px;">Gym Login Email</label>
              <input type="email" id="psycle-onb-gym-email" placeholder="name@example.com" autocomplete="off" style="width:100%;box-sizing:border-box;">
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-tertiary);display:block;margin-bottom:4px;">Gym Password</label>
              <input type="password" id="psycle-onb-gym-password" placeholder="••••••••" autocomplete="off" style="width:100%;box-sizing:border-box;">
            </div>
            <div id="psycle-onb-gym-error" class="psycle-login-error" style="display:none;margin-top:4px;"></div>
            <button type="button" id="psycle-onb-gym-submit" class="psycle-btn-primary" style="margin-top:4px;"><span>${hasLinked ? 'Connect Another Gym' : 'Connect Gym'}</span></button>
          </div>
        `;
      } else {
        formHtml = `
          <div style="padding:16px;text-align:center;background:color-mix(in srgb,var(--success) 10%,transparent);border:1px solid color-mix(in srgb,var(--success) 20%,transparent);border-radius:12px;color:var(--text-primary);margin-bottom:12px;">
            <strong style="color:var(--success);">All available gyms are connected!</strong><br>
            <span style="font-size:12px;color:var(--text-secondary);">You're all set to book across your connected gyms.</span>
          </div>
        `;
      }

      const continueBtnHtml = hasLinked
        ? `<button class="psycle-btn-primary psycle-onb-continue" type="button" style="${unlinkedGyms.length > 0 ? 'background:var(--surface-inset);border:1px solid var(--border);color:var(--text-primary);' : ''}"><span>Continue</span></button>`
        : `<button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Connect later in Settings</button>`;

      const sheet = renderSheet({
        eyebrow: 'Your Gyms',
        title: 'Connect your gym accounts',
        body: `
          <p class="psycle-onb-lead" style="margin-bottom:16px;">Sweat Assistant connects directly to your gym accounts to automate bookings, spot selections, and upgrades.</p>
          ${connectedListHtml}
          ${formHtml}
        `,
        footer: continueBtnHtml,
      });

      const continueBtn = sheet.querySelector('.psycle-onb-continue');
      if (continueBtn) {
        continueBtn.addEventListener('click', resolve);
      }
      const skipBtn = sheet.querySelector('.psycle-onb-skip-inline');
      if (skipBtn) {
        skipBtn.addEventListener('click', resolve);
      }

      const submitBtn = sheet.querySelector('#psycle-onb-gym-submit');
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          const gymSelect = sheet.querySelector('#psycle-onb-gym-select');
          const emailInput = sheet.querySelector('#psycle-onb-gym-email');
          const passInput = sheet.querySelector('#psycle-onb-gym-password');
          const errorEl = sheet.querySelector('#psycle-onb-gym-error');

          const gymId = gymSelect?.value;
          const email = emailInput?.value?.trim();
          const password = passInput?.value;

          if (!gymId || !email || !password) {
            errorEl.textContent = 'Please enter your gym email and password.';
            errorEl.style.display = 'block';
            return;
          }

          errorEl.style.display = 'none';
          submitBtn.disabled = true;
          submitBtn.querySelector('span').textContent = 'Connecting…';

          try {
            await api.linkGym(gymId, email, password);
            showToast('Gym connected successfully!', 'success');
            await loadData();
            render();
          } catch (err) {
            errorEl.textContent = err.message || 'Connection failed';
            errorEl.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.querySelector('span').textContent = hasLinked ? 'Connect Another Gym' : 'Connect Gym';
          }
        });
      }
    };

    render();
  });
}

// ---- STEP: notifications ----
function stepNotifications() {
  return new Promise((resolve) => {
    if (!pushSupported() || Notification.permission === 'granted') return resolve();

    // iOS can only push when installed to the Home Screen.
    if (isIOS() && !isStandalone()) {
      const sheet = renderSheet({
        eyebrow: 'Notifications',
        title: 'One more step on iPhone',
        body: `<p class="psycle-onb-lead">To get push alerts on iOS, open ${appConfig.appName} from your Home Screen icon, then enable notifications from Settings.</p>`,
        footer: `<button class="psycle-btn-primary psycle-onb-continue" type="button"><span>Continue</span></button>`,
      });
      sheet.querySelector('.psycle-onb-continue').addEventListener('click', resolve);
      return;
    }

    const sheet = renderSheet({
      eyebrow: 'Stay in the loop',
      title: 'Enable push notifications',
      body: `<div class="psycle-onb-icon" style="color: var(--feat-push, var(--accent));">${ICON.push}</div>
        <p class="psycle-onb-lead">Get instant alerts when your auto-bookings succeed, upgrades go through, or cancellation reminders fire.</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-notif-enable" type="button"><span>Enable notifications</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Maybe later</button>`,
    });

    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    sheet.querySelector('.psycle-onb-notif-enable').addEventListener('click', async () => {
      try {
        await togglePushSubscription();
      } catch (_) {}
      resolve();
    });
  });
}

// ---- STEP: calendar feed ----
// Unlike push, a subscribed calendar works in any browser context, so this step
// runs whether or not the PWA is installed — and always shows (so a replay still
// offers the subscribe links even when the feed is already enabled server-side).
// Phase 1: prompt to enable. Phase 2: offer Apple/Google + note Settings options.
async function stepCalendar() {
  return new Promise(async (resolve) => {
    const calendarStatus = await api.getCalendarStatus().catch(() => ({ enabled: false }));
    if (calendarStatus.enabled) return resolve(); // already enabled — skip

    const ios = isIOS();

    const showSubscribe = (links) => {
      const webcalUrl = links?.webcal || '';
      const gcalUrl = links?.google || '';
      const icsUrl = links?.ics || '';

      const sheet = renderSheet({
        eyebrow: 'Calendar enabled',
        title: 'Subscribe in your calendar app',
        body: `
          <div class="psycle-onb-icon" style="color: var(--accent);">${ICON.calendar}</div>
          <p class="psycle-onb-lead">Tap below to add the live feed to your calendar.</p>
          <div class="psycle-onb-cal-links">
            ${webcalUrl ? `<a href="${webcalUrl}" class="psycle-btn-primary" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;"><span>${ios ? 'Add to Apple Calendar' : 'Subscribe via Webcal'}</span></a>` : ''}
            ${gcalUrl && !ios ? `<a href="${gcalUrl}" target="_blank" rel="noopener noreferrer" class="psycle-btn-secondary" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;"><span>Add to Google Calendar</span></a>` : ''}
            ${icsUrl ? `<button class="psycle-btn-mini psycle-onb-copy-ics" type="button" style="width:100%;">Copy feed URL</button>` : ''}
          </div>`,
        footer: `<button class="psycle-btn-primary psycle-onb-continue" type="button"><span>Done</span></button>`,
      });

      const copyBtn = sheet.querySelector('.psycle-onb-copy-ics');
      if (copyBtn && icsUrl) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(icsUrl);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy feed URL'; }, 2000);
          } catch (_) {}
        });
      }

      sheet.querySelector('.psycle-onb-continue').addEventListener('click', resolve);
    };

    const sheet = renderSheet({
      eyebrow: 'Stay organised',
      title: 'Add classes to your calendar',
      body: `<div class="psycle-onb-icon" style="color: var(--accent);">${ICON.calendar}</div>
        <p class="psycle-onb-lead">Get your booked or tentative classes in ${ios ? 'Apple' : 'your'} Calendar, kept in sync automatically — bookings, upgrades and cancellations all update on their own.</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-cal-enable" type="button"><span>Enable calendar</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Set up later</button>`,
    });

    const enableBtn = sheet.querySelector('.psycle-onb-cal-enable');
    enableBtn.addEventListener('click', async () => {
      enableBtn.disabled = true;
      try {
        const res = await api.enableCalendar({});
        showSubscribe(res.links || null);
      } catch (_) {
        resolve();
      }
    });
    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
  });
}

// ---- STEP: spot-map setup ----
async function stepSpotMaps() {
  let prefs = {};
  try { prefs = await api.getStudioPreferences(); } catch (_) { prefs = {}; }
  if (prefs && Object.keys(prefs).length > 0) return; // already has maps — skip

  return new Promise((resolve) => {
    const sheet = renderSheet({
      eyebrow: 'Your favourite spots',
      title: 'Set up your preferred spots and bikes',
      body: `<div class="psycle-onb-icon" style="color: var(--feat-quickbook, var(--accent));">${ICON.quickbook}</div>
        <p class="psycle-onb-lead">Set up your preferred spots in each studio so <b>Auto-Book</b>, <b>Quick-Book</b> and <b>Auto-Upgrade</b> can do the hard work for you. You can change your spots any time in Settings.</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-setup" type="button"><span>Set up now</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Maybe later</button>`,
    });

    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    sheet.querySelector('.psycle-onb-setup').addEventListener('click', () => {
      openManageSpotMapsModal({ zIndex: 1000000, onDone: resolve });
    });
  });
}

const STEP_HANDLERS = {
  intro: stepIntro,
  install: stepInstall,
  login: stepLogin,
  gyms: stepGyms,
  notifications: stepNotifications,
  calendar: stepCalendar,
  spotmaps: stepSpotMaps,
};
