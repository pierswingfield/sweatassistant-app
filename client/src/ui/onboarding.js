// Psycle Assistant — first-run onboarding flow.
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
import { consumeInstallPrompt, initApp, togglePushSubscription, warmCaches } from '../main';
import { openManageSpotMapsModal } from './settings';

const COMPLETE_KEY = 'psycleOnboardingComplete';
const STEP_KEY = 'psycleOnboardingStep';
// Bump to re-trigger onboarding for all users after a significant change.
// v2: added the Calendar step.
const ONBOARDING_VERSION = '2';

const STEPS = ['intro', 'install', 'login', 'notifications', 'calendar', 'spotmaps'];

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
  const ctx = { openMapsAfter: false };
  try {
    for (let i = startIndex; i < STEPS.length; i++) {
      const step = STEPS[i];
      localStorage.setItem(STEP_KEY, step);
      await STEP_HANDLERS[step](ctx);
    }
  } finally {
    active = false;
  }
  await finish(ctx);
}

async function finish(ctx) {
  localStorage.setItem(COMPLETE_KEY, ONBOARDING_VERSION);
  localStorage.removeItem(STEP_KEY);
  container().style.display = 'none';
  container().innerHTML = '';
  await initApp();
  if (ctx.openMapsAfter) {
    try { openManageSpotMapsModal(); } catch (_) {}
  }
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
  autobook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2c0 3.5 1.5 5 5 5-3.5 0-5 1.5-5 5 0-3.5-1.5-5-5-5 3.5 0 5-1.5 5-5z"/><path d="M18 7c0 2 1 3 3 3-2 0-3 1-3 3 0-2-1-3-3-3 2 0 3-1 3-3z"/><path d="M6 14c0 1.5.5 2 2 2-1.5 0-2 .5-2 2 0-1.5-.5-2-2-2 1.5 0 2-.5 2-2z"/></svg>',
  autoupgrade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  quickbook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11a9 9 0 0 1 18 0M7 15a5 5 0 0 1 10 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>',
  push: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  calendarSync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 16.5A2.5 2.5 0 0 1 13 15"/><path d="M16 15.5A2.5 2.5 0 0 1 11 17"/><path d="M13 13.5v2h2"/><path d="M11 18.5v-2H9"/></svg>',
};

const SLIDES = [
  { welcome: true, title: 'Unofficial client', text: 'Your personal Psycle companion — auto-booking, smart upgrades, and your favourite spots, taken care of.' },
  { feat: 'autobook', icon: ICON.autobook, title: 'Auto-Book', text: 'No more Monday 12:00PM rush! Queue the classes you want and Psycle Assistant books them the instant they\'re released. You can even set your favourite spots in each studio.' },
  { feat: 'autoupgrade', icon: ICON.autoupgrade, title: 'Auto-Upgrade', text: 'Didn\'t get your favourite spot? Psycle Assistant can monitor for a better one from your preferred spot map, and move you up automatically.' },
  { feat: 'quickbook', icon: ICON.quickbook, title: 'Quick-Book', text: 'Once you\'ve set your favourite spots, booking happens in a single tap.' },
  { feat: 'offline', icon: ICON.offline, title: 'Works Offline', text: 'Your timetable and bookings stay readable on the tube or anywhere signal drops.' },
  { feat: 'push', icon: ICON.push, title: 'Stay Notified', text: 'Get a push when you\'re booked in, upgraded, or to remind you about an upcoming class.' },
  { feat: 'calendar', icon: ICON.calendarSync, title: 'Calendar Sync', text: 'Automatically sync your classes to your calendar, so you never forget your birthday ride.' },
];

// ---- STEP: intro carousel ----
function stepIntro() {
  return new Promise((resolve) => {
    const c = show();
    c.innerHTML = `
      <div class="psycle-onb-sheet psycle-onb-intro" role="dialog" aria-modal="true">
        <button class="psycle-onb-skip" type="button" aria-label="Skip introduction">Skip</button>
        <div class="psycle-onb-carousel">
          <div class="psycle-onb-track">
            ${SLIDES.map((s) => s.welcome ? `
              <div class="psycle-onb-slide psycle-onb-slide-welcome">
                <div class="psycle-onb-wordmark">Psycle Assistant</div>
                <h2 class="psycle-onb-title psycle-onb-welcome-title">${s.title}</h2>
                <p class="psycle-onb-slide-text">${s.text}</p>
                <p class="psycle-onb-secondary-note">This app needs to securely store your Psycle login to work in the background. You could alternatively use this <a href="https://github.com/piersjones/psycle-chrome">chrome extension</a> for similar functionality, but it requires the Psycle website to be open for automatic features to work.</p>
              </div>` : `
              <div class="psycle-onb-slide">
                <div class="psycle-onb-icon" style="color: var(--feat-${s.feat}, var(--accent));">${s.icon}</div>
                <h2 class="psycle-onb-title">${s.title}</h2>
                <p class="psycle-onb-slide-text">${s.text}</p>
              </div>`).join('')}
          </div>
        </div>
        <div class="psycle-onb-dots">
          ${SLIDES.map((_, i) => `<button class="psycle-onb-dot${i === 0 ? ' is-active' : ''}" type="button" aria-label="Go to slide ${i + 1}"></button>`).join('')}
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
      index = Math.max(0, Math.min(SLIDES.length - 1, i));
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((d, di) => d.classList.toggle('is-active', di === index));
      nextLabel.textContent = index === SLIDES.length - 1 ? 'Get started' : 'Next';
    };

    nextBtn.addEventListener('click', () => {
      if (index === SLIDES.length - 1) resolve();
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
      body = `<p class="psycle-onb-lead">Add Psycle Assistant to your device for the full experience.</p>${reasoning}`;
      primary = `<button class="psycle-btn-primary psycle-onb-install" type="button"><span>Install app</span></button>`;
    } else if (ios) {
      body = `<p class="psycle-onb-lead">Add Psycle Assistant to your Home Screen for the full experience.</p>${reasoning}
        <ol class="psycle-onb-steps">
<li>Tap the <strong>Share</strong> button <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.1em; height: 1.1em; display: inline-block; vertical-align: middle; margin: 0 2px;"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> in Safari’s toolbar.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Open Psycle Assistant from your new icon to continue.</li>
        </ol>`;
      primary = '';
    } else {
      // Android browser without beforeinstallprompt, or other
      body = `<p class="psycle-onb-lead">Add Psycle Assistant to your device for the full experience.</p>${reasoning}
        <ol class="psycle-onb-steps">
          <li>Open your browser’s <strong>⋮ menu</strong>.</li>
          <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
        </ol>`;
      primary = '';
    }

    const sheet = renderSheet({
      eyebrow: 'Get the full experience',
      title: 'Install Psycle Assistant',
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

// ---- STEP: notifications ----
function stepNotifications() {
  return new Promise((resolve) => {
    if (!pushSupported() || Notification.permission === 'granted') return resolve();

    // iOS can only push when installed to the Home Screen.
    if (isIOS() && !isStandalone()) {
      const sheet = renderSheet({
        eyebrow: 'Notifications',
        title: 'One more step on iPhone',
        body: `<p class="psycle-onb-lead">To get push alerts on iOS, open Psycle Assistant from your Home Screen icon, then enable notifications from Settings.</p>`,
        footer: `<button class="psycle-btn-primary psycle-onb-continue" type="button"><span>Continue</span></button>`,
      });
      sheet.querySelector('.psycle-onb-continue').addEventListener('click', resolve);
      return;
    }

    const sheet = renderSheet({
      eyebrow: 'Notifications',
      title: 'Never miss a booking',
      body: `<div class="psycle-onb-icon" style="color: var(--accent);">${ICON.push}</div>
        <p class="psycle-onb-lead">Get a push the moment an auto-book lands, an upgrade succeeds, or a free-cancel window opens. You can fine-tune which alerts you get later in Settings.</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-enable" type="button"><span>Enable notifications</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Maybe later</button>`,
    });

    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    const enableBtn = sheet.querySelector('.psycle-onb-enable');
    enableBtn.addEventListener('click', async () => {
      enableBtn.disabled = true;
      try { await togglePushSubscription(); } catch (_) {}
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
  let status = null;
  try { status = await api.getCalendarStatus(); } catch (_) { status = null; }

  const ios = isIOS();
  return new Promise((resolve) => {
    // --- Phase 2: subscribe options ---
    const showSubscribe = (links) => {
      const sheet = renderSheet({
        eyebrow: 'Calendar on',
        title: 'Subscribe to your class calendar',
        body: `<div class="psycle-onb-icon" style="color: var(--accent);">${ICON.calendar}</div>
          <p class="psycle-onb-lead">Pick your calendar below. Your classes will keep themselves in sync from now on.</p>
          <p class="psycle-onb-secondary-note">You can turn on reminders and change other options anytime in <strong>Settings → Calendar</strong>.</p>`,
        footer: `<div class="psycle-onb-cal-actions" style="display:flex;flex-direction:column;gap:8px;width:100%;">
            <button class="psycle-btn-primary psycle-onb-cal-apple" type="button"><span>Add to Apple Calendar</span></button>
            <button class="psycle-btn-primary psycle-onb-cal-google" type="button"><span>Add to Google Calendar</span></button>
          </div>
          <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Done</button>`,
      });

      const apple = sheet.querySelector('.psycle-onb-cal-apple');
      const google = sheet.querySelector('.psycle-onb-cal-google');
      if (!ios && apple && google) { apple.style.order = '1'; google.style.order = '0'; }

      apple?.addEventListener('click', () => {
        if (links?.webcal) window.location.href = links.webcal;
      });
      google?.addEventListener('click', () => {
        if (links?.google) {
          const a = document.createElement('a');
          a.href = links.google; a.target = '_blank'; a.rel = 'noopener noreferrer';
          document.body.appendChild(a); a.click(); a.remove();
        }
      });
      sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    };

    // Already enabled (e.g. onboarding replay) → jump straight to the subscribe options.
    if (status && status.enabled && status.links) {
      showSubscribe(status.links);
      return;
    }

    // --- Phase 1: enable prompt ---
    const sheet = renderSheet({
      eyebrow: 'Stay organised',
      title: 'Add classes to your calendar',
      body: `<div class="psycle-onb-icon" style="color: var(--accent);">${ICON.calendar}</div>
        <p class="psycle-onb-lead">Get your booked classes in ${ios ? 'Apple' : 'your'} or Google Calendar, kept in sync automatically — bookings, upgrades and cancellations all update on their own. No install needed.</p>`,
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

// ---- STEP: spot-map nudge ----
async function stepSpotMaps(ctx) {
  let prefs = {};
  try { prefs = await api.getStudioPreferences(); } catch (_) { prefs = {}; }
  if (prefs && Object.keys(prefs).length > 0) return; // already has maps — skip

  return new Promise((resolve) => {
    const sheet = renderSheet({
      eyebrow: 'Almost there',
      title: 'Set your preferred spots',
      body: `<div class="psycle-onb-icon" style="color: var(--feat-quickbook, var(--accent));">${ICON.quickbook}</div>
        <p class="psycle-onb-lead">Pick your favourite seats for each studio once, and Quick-Book, Auto-Book and Auto-Upgrade will all aim for them automatically. You can always do this later in Settings.</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-setup" type="button"><span>Set up my spots</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">Set up later</button>`,
    });

    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    sheet.querySelector('.psycle-onb-setup').addEventListener('click', () => {
      // Finish onboarding into the app, then open the spot-maps manager on top.
      ctx.openMapsAfter = true;
      resolve();
    });
  });
}

const STEP_HANDLERS = {
  intro: stepIntro,
  install: stepInstall,
  login: stepLogin,
  notifications: stepNotifications,
  calendar: stepCalendar,
  spotmaps: stepSpotMaps,
};
