// first-run onboarding flow.
//
// Runs before login on first launch and guides the user through:
//   welcome → account access → gym connection → optional setup.
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
import { openCalendarSettingsModal } from './calendar-section.js';
import { appConfig } from '../config';
import { setGymCatalogue } from '../gym-context.js';
import { COPY, formatCopyText, appCopy } from '../copy.js';
import { escapeHtml, gymChip } from './cards';
import { enableAutoUpgradeForGyms, shouldAnimateGymLogos, getPostLoginDestination as choosePostLoginDestination, detectInstallContext, shouldOfferInstall } from './onboarding-routing.js';
import { cleanFirstName, inferFirstName } from './name-capture.js';

const COMPLETE_KEY = 'appOnboardingComplete';
const STEP_KEY = 'appOnboardingStep';
// Bump to re-trigger onboarding for all users after a significant change.
// v4: focused, resumable flow with one optional setup roll-up.
const ONBOARDING_VERSION = '4';

const STEPS = ['intro', 'install', 'authchoice', 'login', 'gyms', 'name', 'features'];

// --- platform / capability detection (mirrors main.js:279) ---
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let active = false;
let loginResolver = null;
let requestedAuthMode = 'login';
let justAuthenticated = false;

// ---- presentation state (animation direction + progress capsule); no effect on step logic ----
// `enter` says whether the next show() is a NEW step (play the entrance) or a re-render of the same one.
const enter = { pending: false, dir: 'fwd' };
// Progress phases: Welcome, Install (only if offered), Account (authchoice + login), Gyms, Name, Setup.
const PHASE_OF = { intro: 'intro', install: 'install', authchoice: 'account', login: 'account', gyms: 'gyms', name: 'name', features: 'features' };
let phases = ['intro', 'gyms', 'name', 'features'];
let lastProgress = 0;
let currentStep = 'intro';

function planPhases(optionalOnly) {
  phases = ['intro', 'install', 'account', 'gyms', 'name', 'features'].filter((ph) => {
    if (optionalOnly) return ph === 'features'; // the post-login "finish setup" roll-up is one screen
    if (ph === 'install') return installOffered();
    if (ph === 'account') return !isLoggedIn();
    return true;
  });
}

/** Glass top bar: optional Back (left) + progress capsule (centre). Presentation only. */
function topBarHtml(backHtml = '') {
  const idx = phases.indexOf(PHASE_OF[currentStep]);
  const total = phases.length;
  const show = active && idx >= 0 && total > 1;
  const p = show ? (idx + 1) / total : 0;
  const label = formatCopyText(COPY.onboarding.progressLabel, { current: idx + 1, total });
  const bar = show
    ? `<div class="app-onb-progress" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${idx + 1}" style="--p:${p.toFixed(3)};--p-from:${lastProgress.toFixed(3)}"><span class="app-onb-progress-fill"></span></div>`
    : '';
  if (show) lastProgress = p;
  return `<div class="app-onb-top">${backHtml}${bar}</div>`;
}

export function isOnboardingActive() {
  return active;
}

export function shouldShowOnboarding() {
  // Completion belongs to an account, not this browser. In the pre-login state
  // there is no account to complete, so always keep onboarding available.
  return localStorage.getItem(onboardingKey(COMPLETE_KEY)) !== ONBOARDING_VERSION;
}

function onboardingKey(base) {
  const accountId = localStorage.getItem('appUserId');
  return accountId ? `${base}:${accountId}` : `${base}:anonymous`;
}

// Called by main.js onLoginSuccess() while onboarding is active.
export function advanceAfterLogin() {
  if (loginResolver) {
    const r = loginResolver;
    loginResolver = null;
    justAuthenticated = true;
    r();
  }
}

function container() {
  return document.getElementById('app-onboarding-container');
}

function show() {
  document.getElementById('app-login-container').style.display = 'none';
  document.getElementById('app-container').style.display = 'none';
  const c = container();
  c.style.display = 'flex';
  c.dataset.step = currentStep;
  c.dataset.dir = enter.dir;
  c.classList.toggle('is-entering', enter.pending);
  enter.pending = false;
  return c;
}

// ---- public entry points ----

export function startOnboarding() {
  return runFrom(0);
}

export function resumeOnboarding({ optionalOnly = false } = {}) {
  if (optionalOnly) return runFrom(STEPS.indexOf('features'), true);
  const saved = localStorage.getItem(onboardingKey(STEP_KEY));
  let idx = saved ? STEPS.indexOf(saved) : 0;
  if (idx < 0) idx = 0;
  // If we're not logged in yet, never resume past the login step.
  if (!isLoggedIn()) idx = Math.min(idx, STEPS.indexOf('login'));
  return runFrom(idx);
}

async function runFrom(startIndex, optionalOnly = false) {
  active = true;
  // Apply the body id that unlocks all #app-helper-container-scoped CSS
  // (font-family, .app-btn-mini, etc.) so modals opened during onboarding
  // look identical to those opened from the main app.
  document.body.id = 'app-helper-container';
  try {
    let i = startIndex;
    planPhases(optionalOnly);
    lastProgress = 0;
    enter.dir = 'fwd';
    while (i < STEPS.length) {
      const step = STEPS[i];
      localStorage.setItem(onboardingKey(STEP_KEY), step);
      currentStep = step;
      enter.pending = true;
      const action = await STEP_HANDLERS[step]();
      enter.dir = action === 'back' ? 'back' : 'fwd';
      // On login, route existing connected accounts according to their actual
      // setup state. The local completion flag alone can be stale after account
      // changes, or after a user finishes setup in Settings.
      if (step === 'login' && justAuthenticated) {
        justAuthenticated = false;
        const destination = await getPostLoginDestination().catch(() => null);
        if (destination === 'home') {
          i = STEPS.length;
          break;
        }
        if (destination === 'optional') {
          i = STEPS.indexOf('features');
          continue;
        }
      }
      if (action === 'back') {
        i = Math.max(0, i - 1);
        // Back never lands on a step that has nothing to show.
        while (i > 0 && !stepApplies(STEPS[i])) i--;
      }
      else if (action === 'welcome') i = 0;
      else i++;
    }
  } finally {
    active = false;
  }
  await finish();
}

export async function getPostLoginDestination() {
  const mine = await api.getMyGyms();
  const linkedGyms = mine.gyms || [];
  if (!linkedGyms.length) return 'full';

  const gymIds = linkedGyms.map((gym) => gym.gym_id || gym.gymId || gym.id).filter(Boolean);
  const [preferences, calendar, notificationsEnabled] = await Promise.all([
    Promise.all(gymIds.map((gymId) => api.getStudioPreferences(gymId).catch(() => null))),
    api.getCalendarStatus().catch(() => ({ enabled: false })),
    (async () => {
      try {
        if (!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return false;
        const registration = await navigator.serviceWorker.getRegistration();
        return !!(await registration?.pushManager?.getSubscription());
      } catch (_) { return false; }
    })(),
  ]);
  const hasPreferredSpotMap = preferences.some((prefs) => Object.values(prefs || {})
    .some((pref) => pref?.preferredSlots?.length || pref?.preferredRows?.length));
  return choosePostLoginDestination({
    linkedGymCount: linkedGyms.length,
    hasPreferredSpotMap,
    calendarEnabled: !!calendar.enabled,
    notificationsEnabled,
  });
}

async function finish() {
  const accountId = localStorage.getItem('appUserId');
  if (accountId) {
    localStorage.setItem(onboardingKey(COMPLETE_KEY), ONBOARDING_VERSION);
    localStorage.removeItem(onboardingKey(STEP_KEY));
  }
  container().style.display = 'none';
  container().innerHTML = '';
  container().classList.remove('is-entering');
  // U4-19: leave the URL alone. initApp() reads the path, so a deep link survives onboarding and a
  // fresh login (which starts at '/') lands on Home.
  await initApp();
}

// ---- shared layout helpers ----

// Renders a standard centred step "sheet" and returns its inner body element.
// `onBack` adds the shared top Back button (same position and style on every screen).
const backButtonHtml = () => `<button class="app-onb-back-top" type="button">${COPY.onboarding.back}</button>`;
// `hero` is a glass medallion with the step's glyph (decorative; aria-hidden).
const heroHtml = (svg, cls = '') => (svg ? `<div class="app-onb-hero ${cls}" aria-hidden="true">${svg}</div>` : '');
function renderSheet({ eyebrow, title, body, footer, onBack, hero }) {
  const c = show();
  c.innerHTML = `
    ${topBarHtml(onBack ? backButtonHtml() : '')}
    <div class="app-onb-sheet" role="dialog" aria-modal="true">
      ${heroHtml(hero)}
      ${eyebrow ? `<div class="app-onb-eyebrow">${eyebrow}</div>` : ''}
      ${title ? `<h2 class="app-onb-title">${title}</h2>` : ''}
      <div class="app-onb-body">${body || ''}</div>
      <div class="app-onb-footer">${footer || ''}</div>
    </div>`;
  if (onBack) c.querySelector('.app-onb-back-top').addEventListener('click', onBack);
  return c.querySelector('.app-onb-sheet');
}

// ---- feature icons (inline SVG, themed via currentColor) ----
const ICON = {
  autobook: '<svg viewBox="0 0 32 32" fill="currentColor"><g data-name="Layer 2" id="Layer_2"><path d="M18,11a1,1,0,0,1-1,1,5,5,0,0,0-5,5,1,1,0,0,1-2,0,5,5,0,0,0-5-5,1,1,0,0,1,0-2,5,5,0,0,0,5-5,1,1,0,0,1,2,0,5,5,0,0,0,5,5A1,1,0,0,1,18,11Z"/><path d="M19,24a1,1,0,0,1-1,1,2,2,0,0,0-2,2,1,1,0,0,1-2,0,2,2,0,0,0-2-2,1,1,0,0,1,0-2,2,2,0,0,0,2-2,1,1,0,0,1,2,0,2,2,0,0,0,2,2A1,1,0,0,1,19,24Z"/><path d="M28,17a1,1,0,0,1-1,1,4,4,0,0,0-4,4,1,1,0,0,1-2,0,4,4,0,0,0-4-4,1,1,0,0,1,0-2,4,4,0,0,0,4-4,1,1,0,0,1,2,0,4,4,0,0,0,4,4A1,1,0,0,1,28,17Z"/></g></svg>',
  autoupgrade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  quickbook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11a9 9 0 0 1 18 0M7 15a5 5 0 0 1 10 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>',
  push: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 8v6M9.5 11.5 12 14l2.5-2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7"/></svg>',
  calendarSync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 16.5A2.5 2.5 0 0 1 13 15"/><path d="M16 15.5A2.5 2.5 0 0 1 11 17"/><path d="M13 13.5v2h2"/><path d="M11 18.5v-2H9"/></svg>',
};

// Lazy getter — reads appConfig.appName at render time, not at module load,
// so it picks up the runtime value from /api/config (initConfig runs before
// onboarding starts).
function getSlides() {
  return [
    { welcome: true, title: appCopy(COPY.onboarding.welcomeTitle) },
  ];
}

// ---- STEP: intro carousel ----
function stepIntro() {
  return new Promise((resolve) => {
    const slides = getSlides();
    const c = show();
    const O = COPY.onboarding;
    introContinuesToInstall = !isLoggedIn() && installOffered();
    const perks = [
      { icon: 'autobook', title: O.perkAutoBookTitle, text: O.perkAutoBookText },
      { icon: 'autoupgrade', title: O.perkAutoUpgradeTitle, text: O.perkAutoUpgradeText },
      { icon: 'calendarSync', title: O.perkCalendarTitle, text: O.perkCalendarText },
      { icon: 'push', title: O.perkNotifyTitle, text: O.perkNotifyText },
    ].map((p) => ({ ...p, text: appCopy(p.text) }));
    c.innerHTML = `
      ${topBarHtml()}
      <div class="app-onb-sheet app-onb-intro" role="dialog" aria-modal="true" aria-labelledby="app-onb-welcome-title">
        <div class="app-onb-carousel">
          <div class="app-onb-track">
            ${slides.map((s) => s.welcome ? `
              <div class="app-onb-slide app-onb-slide-welcome">
                <img class="app-onb-mascot" src="/characters/droplet.gif" alt="" aria-hidden="true" decoding="async">
                <div class="app-onb-wordmark">${escapeHtml(appConfig.appName)}</div>
                <h2 class="app-onb-title app-onb-welcome-title" id="app-onb-welcome-title">${s.title}</h2>
                <ul class="app-onb-perks" role="list">
                  ${perks.map((p, i) => `
                  <li class="app-onb-perk" style="--i: ${i};">
                    <span class="app-onb-perk-icon" aria-hidden="true">${ICON[p.icon]}</span>
                    <div class="app-onb-perk-body">
                      <strong>${p.title}</strong>
                      <span>${p.text}</span>
                    </div>
                  </li>`).join('')}
                </ul>
                <p class="app-onb-gyms-line">${COPY.onboarding.welcomeGyms}</p>
              </div>` : `
              <div class="app-onb-slide">
                <div class="app-onb-icon">${s.icon}</div>
                <h2 class="app-onb-title">${s.title}</h2>
                <p class="app-onb-slide-text">${s.text}</p>
              </div>`).join('')}
          </div>
        </div>
          ${slides.length > 1 ? `<div class="app-onb-dots">${slides.map((_, i) => `<button class="app-onb-dot${i === 0 ? ' is-active' : ''}" type="button" aria-label="${COPY.onboarding.slideLabel.replace('{number}', i + 1)}"></button>`).join('')}</div>` : ''}
        <div class="app-onb-footer">
          ${isLoggedIn() ? `<button class="app-btn-primary app-onb-auth" type="button" data-auth-mode="continue">${COPY.onboarding.continueSetup}</button>` : introContinuesToInstall ? `<button class="app-btn-primary app-onb-auth" type="button" data-auth-mode="login">${COPY.onboarding.continue}</button>` : `<button class="app-btn-primary app-onb-auth" type="button" data-auth-mode="login">${COPY.onboarding.logInButton}</button><button class="app-btn-secondary app-onb-auth" type="button" data-auth-mode="signup">${COPY.onboarding.createAccountButton}</button>`}
        </div>
      </div>`;

    const track = c.querySelector('.app-onb-track');
    const dots = [...c.querySelectorAll('.app-onb-dot')];
    let index = 0;

    const goto = (i) => {
      index = Math.max(0, Math.min(slides.length - 1, i));
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((d, di) => d.classList.toggle('is-active', di === index));
    };

    c.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => {
      requestedAuthMode = button.dataset.authMode;
      resolve();
    }));
    dots.forEach((d, di) => d.addEventListener('click', () => goto(di)));
    c.querySelector('.app-onb-skip')?.addEventListener('click', resolve);

    // Touch swipe
    let startX = 0, dragging = false;
    const carousel = c.querySelector('.app-onb-carousel');
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
// Mobile browser tabs only (never an installed app), at most once per browser session, with a skip.
// Install step: shown on EVERY flow entry in a mobile browser tab until BOTH the user has chosen "Continue in
// browser" (pending, session-scoped) AND has logged in (which promotes it to the persistent dismissed flag).
// Merely showing the step sets nothing.
const INSTALL_PENDING_KEY = 'appInstallPending';
const INSTALL_DISMISSED_KEY = 'appInstallDismissed';
const installContext = () => detectInstallContext({
  userAgent: navigator.userAgent,
  standalone: window.navigator.standalone === true,
  displayStandalone: window.matchMedia('(display-mode: standalone)').matches,
  maxTouchPoints: navigator.maxTouchPoints || 0,
  viewportWidth: window.innerWidth,
});
const installDismissed = () => { try { return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'; } catch (_) { return false; } };
const markInstallPending = () => { try { sessionStorage.setItem(INSTALL_PENDING_KEY, '1'); } catch (_) {} };
/** Called on every successful login/account creation: a pending "Continue in browser" becomes permanent. */
export function promoteInstallDismissal() {
  try {
    if (sessionStorage.getItem(INSTALL_PENDING_KEY) === '1') localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
  } catch (_) {}
}
const installOffered = () => shouldOfferInstall(installContext(), installDismissed());
// Mobile-browser first screen shows a single Continue (next screen is the install step, not login).
let introContinuesToInstall = false;
// Which steps apply right now (used to skip them when walking Back).
const stepApplies = (step) => (step === 'install' ? installOffered() : step === 'authchoice' ? introContinuesToInstall : true);

// Inline glyphs for the numbered steps (currentColor, so they follow the theme tokens).
const INSTALL_ICON = {
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>',
  addSquare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  kebab: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 8v6M9.5 11.5 12 14l2.5-2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 12h8M13 9l3 3-3 3"/></svg>',
};

/** Numbered, illustrated steps for a platform. */
function installStepsHtml(platform) {
  const O = COPY.onboarding;
  const s = (icon, html) => `<li class="app-install-step"><span class="app-install-ico" aria-hidden="true">${INSTALL_ICON[icon]}</span><span class="app-install-txt">${html}</span></li>`;
  let steps;
  if (platform === 'ios-safari' || platform === 'ios-other') {
    steps = [s('share', O.installStepIosShare), s('addSquare', O.installStepIosAdd), s('check', O.installStepIosConfirm), s('open', appCopy(O.installStepIosOpen))];
  } else if (platform === 'android-chrome') {
    steps = [s('kebab', O.installStepAndroidMenu), s('install', O.installStepAndroidInstall), s('check', O.installStepAndroidConfirm)];
  } else if (platform === 'android-samsung') {
    steps = [s('menu', O.installStepSamsungMenu), s('addSquare', O.installStepSamsungAdd), s('check', O.installStepIosConfirm)];
  } else {
    steps = [s('kebab', O.installStepGenericMenu), s('addSquare', O.installStepGenericAdd)];
  }
  const note = platform === 'ios-other' ? `<p class="app-install-note">${O.installIosOtherNote}</p>` : '';
  return `${note}<ol class="app-install-steps">${steps.join('')}</ol>`;
}

function stepInstall() {
  return new Promise((resolve) => {
    // Back only exists inside the onboarding flow (the pre-login offer has nothing before it).
    const onBack = active ? () => resolve('back') : null;
    const ctx = installContext();
    if (!shouldOfferInstall(ctx, installDismissed())) return resolve();

    const promptEvent = consumeInstallPrompt();
    const reasoning = `
      <ul class="app-onb-reasons">
        <li><span class="app-onb-reason-icon">${ICON.push}</span><div><strong>${COPY.onboarding.pushReasonTitle}</strong><br>${COPY.onboarding.pushReason}</div></li>
        <li><span class="app-onb-reason-icon">${ICON.offline}</span><div><strong>${COPY.onboarding.offlineReasonTitle}</strong><br>${COPY.onboarding.offlineReason}</div></li>
      </ul>`;
    const ios = ctx.platform.startsWith('ios');
    const lead = appCopy(ios ? COPY.onboarding.installForHomeScreen : COPY.onboarding.installForExperience);
    // Android Chrome: a native one-tap Install when the browser handed us the prompt; steps otherwise.
    const body = `<p class="app-onb-lead">${lead}</p>${reasoning}${promptEvent ? '' : installStepsHtml(ctx.platform)}`;
    const primary = promptEvent
      ? `<button class="app-btn-primary app-onb-install" type="button"><span>${COPY.onboarding.installButton}</span></button>` : '';

    const sheet = renderSheet({
      eyebrow: COPY.onboarding.installEyebrow,
      title: appCopy(COPY.onboarding.installTitle),
      body,
      footer: `${primary}<button class="app-btn-mini app-onb-skip-inline" type="button">${COPY.onboarding.continueInBrowser}</button>`,
      onBack,
      hero: ICON.phone,
    });

    sheet.querySelector('.app-onb-skip-inline').addEventListener('click', () => { markInstallPending(); resolve(); });
    const installBtn = sheet.querySelector('.app-onb-install');
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

/**
 * Standalone entry for EXISTING users who are logged out (login screen) on a mobile browser: shows the
 * install step once per session without starting onboarding, then hands back to the caller (showLogin).
 */
export async function offerInstallBeforeLogin() {
  if (active || !installOffered()) return;
  document.body.id = 'app-helper-container';
  await stepInstall();
  const c = container();
  if (c) { c.style.display = 'none'; c.innerHTML = ''; }
}

// ---- STEP: log in / create account choice (only after the install step, when the intro showed Continue) ----
function stepAuthChoice() {
  return new Promise((resolve) => {
    if (isLoggedIn() || !introContinuesToInstall) return resolve();
    const O = COPY.onboarding;
    const sheet = renderSheet({
      title: appCopy(O.authChoiceTitle),
      hero: ICON.user,
      body: `<p class="app-onb-lead">${appCopy(O.authChoiceLead)}</p>`,
      footer: `<button class="app-btn-primary app-onb-auth" type="button" data-auth-mode="login">${O.logInButton}</button><button class="app-btn-secondary app-onb-auth" type="button" data-auth-mode="signup">${O.createAccountButton}</button>`,
      onBack: () => resolve('back'),
    });
    sheet.querySelectorAll('[data-auth-mode]').forEach((b) => b.addEventListener('click', () => { requestedAuthMode = b.dataset.authMode; resolve(); }));
  });
}

// ---- STEP: login ----
function stepLogin() {
  return new Promise((resolve) => {
    if (isLoggedIn()) return resolve(); // already authenticated (resume case)

    const login = document.getElementById('app-login-container');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'app-onb-back-top';
    back.textContent = COPY.onboarding.back;
    back.addEventListener('click', () => {
      loginResolver = null;
      back.remove();
      login.style.display = 'none';
      show();
      resolve('back');
    });
    login.prepend(back);


    // Hand off to the existing login container + handler in main.js. On success,
    // main.js onLoginSuccess() calls advanceAfterLogin() → resolves this promise.
    loginResolver = () => {
      back.remove();
      // Kick off background cache warm so the app feels instant at finish.
      warmCaches();
      resolve();
    };
    container().style.display = 'none';
    login.style.display = 'flex';
    // The login card keeps its mode between visits, so always select the one that was chosen.
    document.getElementById(requestedAuthMode === 'signup' ? 'app-auth-to-signup' : 'app-auth-to-login')?.click();
  });
}

/** Logos of every wired gym, from the catalogue. >3 gyms scroll as a marquee (duplicated track). */
function gymLogoStripHtml(gyms) {
  if (!gyms.length) return '';
  const items = gyms.map((g) => `<li class="app-onb-gym-logo">${gymChip(g.id)}</li>`).join('');
  const animate = shouldAnimateGymLogos(gyms.length);
  return `<div class="app-onb-gym-logos${animate ? ' is-marquee' : ''}" role="group" tabindex="0" aria-label="${escapeHtml(COPY.onboarding.supportedGyms)}">
    <div class="app-onb-gym-logos-track">
      <ul class="app-onb-gym-logos-set" role="list">${items}</ul>
      ${animate ? `<ul class="app-onb-gym-logos-set is-clone" aria-hidden="true">${items}</ul>` : ''}
    </div>
  </div>`;
}

// ---- STEP: gym linking (sequential multi-gym setup) ----
function stepGyms() {
  return new Promise(async (resolve) => {
    let allGyms = [];
    let myGyms = [];
    let addingAnother = false;

    const loadData = async () => {
      try {
        const [gymsRes, mineRes] = await Promise.all([
          api.getGyms(),
          api.getMyGyms(),
        ]);
        const rawGyms = gymsRes.gyms || gymsRes || [];
        allGyms = rawGyms.filter((g) => g.enabled !== false);
        setGymCatalogue(allGyms);
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
        ? `<div class="app-onb-connected-gyms onb-gyms-margin">
            <div class="onb-gyms-title">${COPY.onboarding.connectedGyms}</div>
            <div class="onb-gyms-stack">
              ${myGyms.map(g => {
                const targetId = g.gym_id || g.gymId || g.id;
                const matchedGym = allGyms.find(ag => ag.id === targetId);
                const gName = g.gym_name || g.name || matchedGym?.name || targetId;
                const gEmail = g.gym_email || g.gymEmail || '';
                return `
                <div class="onb-gym-card">
                  <div class="onb-gym-info">
                    <span class="onb-gym-check">✓</span>
                    <div>
                      <div class="onb-gym-name">${gName}</div>
                      ${gEmail ? `<div class="onb-gym-email">${gEmail}</div>` : ''}
                    </div>
                  </div>
                  <span class="app-badge onb-gym-badge">${COPY.gyms.connected}</span>
                </div>
              `;}).join('')}
            </div>
          </div>`
        : '';

      const submitLabel = (id) => {
        const g = unlinkedGyms.find(x => String(x.id) === String(id));
        const name = g && (g.shortName || g.name);
        if (name) return formatCopyText(COPY.onboarding.connectNamedGym, { gym: name });
        return hasLinked ? COPY.onboarding.connectAnotherGym : COPY.auth.connectGymButton;
      };
      let formHtml = '';
      if (unlinkedGyms.length > 0 && (!hasLinked || addingAnother)) {
        formHtml = `
          <div class="app-onb-link-form onb-form-container">
            <div class="onb-form-label">
              ${hasLinked ? COPY.onboarding.connectAnotherGym : COPY.onboarding.connectGymAccount}
            </div>
            <div>
              <label class="onb-select-label">${COPY.onboarding.selectGym}</label>
              <select id="app-onb-gym-select" class="app-select onb-gym-select">
                ${unlinkedGyms.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="onb-select-label">${COPY.onboarding.gymLoginEmail}</label>
              <input class="onb-email-input" type="email" id="app-onb-gym-email" placeholder="${COPY.onboarding.gymEmailPlaceholder}" autocomplete="off">
            </div>
            <div>
              <label class="onb-select-label">${COPY.onboarding.gymPassword}</label>
              <input class="onb-email-input" type="password" id="app-onb-gym-password" placeholder="${COPY.onboarding.gymPasswordPlaceholder}" autocomplete="off">
            </div>
            <div id="app-onb-gym-error" class="app-login-error" style="display:none;margin-top:4px;"></div>
            <button type="button" id="app-onb-gym-submit" class="app-btn-primary onb-submit-button"><span>${escapeHtml(submitLabel(unlinkedGyms[0]?.id))}</span></button>

          </div>
        `;
      } else if (unlinkedGyms.length > 0 && hasLinked) {
        formHtml = `<button type="button" id="app-onb-add-another" class="app-btn-secondary onb-gym-select">${COPY.onboarding.connectAnotherLower}</button>`;
      } else {
        formHtml = `
          <div class="onb-success-banner">
            <strong class="onb-success-title">${COPY.onboarding.allGymsConnected}</strong><br>
            <span class="onb-success-subtitle">${COPY.onboarding.allSetToBook}</span>
          </div>
        `;
      }

      const continueBtnHtml = hasLinked
        ? `<button class="app-btn-primary app-onb-continue" type="button" data-quiet="${unlinkedGyms.length > 0 ? '1' : '0'}"><span>${COPY.onboarding.continue}</span></button>`
        : `<button class="app-btn-mini app-onb-skip-inline" type="button">${COPY.onboarding.setupLater}</button>`;

      const sheet = renderSheet({
        eyebrow: COPY.onboarding.yourGyms,
        title: COPY.onboarding.connectGymAccounts,
        hero: ICON.link,
        body: `
          <p class="app-onb-lead onb-gyms-margin">${appCopy(COPY.onboarding.connectDescription)}</p>
          ${gymLogoStripHtml(allGyms)}
          ${connectedListHtml}
          ${formHtml}
        `,
        footer: continueBtnHtml,
        onBack: addingAnother && hasLinked ? () => { addingAnother = false; render(); } : () => resolve('welcome'),
      });

      const addAnotherBtn = sheet.querySelector('#app-onb-add-another');
      if (addAnotherBtn) addAnotherBtn.addEventListener('click', () => { addingAnother = true; render(); });


      const continueBtn = sheet.querySelector('.app-onb-continue');
      if (continueBtn) {
        continueBtn.addEventListener('click', resolve);
      }
      const skipBtn = sheet.querySelector('.app-onb-skip-inline');
      if (skipBtn) {
        skipBtn.addEventListener('click', resolve);
      }

      const submitBtn = sheet.querySelector('#app-onb-gym-submit');
      const gymSel = sheet.querySelector('#app-onb-gym-select');
      if (gymSel && submitBtn) gymSel.addEventListener('change', () => { submitBtn.querySelector('span').textContent = submitLabel(gymSel.value); });
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          const gymSelect = sheet.querySelector('#app-onb-gym-select');
          const emailInput = sheet.querySelector('#app-onb-gym-email');
          const passInput = sheet.querySelector('#app-onb-gym-password');
          const errorEl = sheet.querySelector('#app-onb-gym-error');

          const gymId = gymSelect?.value;
          const email = emailInput?.value?.trim();
          const password = passInput?.value;

          if (!gymId || !email || !password) {
          errorEl.textContent = COPY.onboarding.gymCredentialsRequired;
            errorEl.style.display = 'block';
            return;
          }

          errorEl.style.display = 'none';
          submitBtn.disabled = true;
          submitBtn.querySelector('span').textContent = COPY.onboarding.connecting;

          try {
            await api.linkGym(gymId, email, password);
            showToast(COPY.notifications.gymConnectedToast, 'success');
            await loadData();
            addingAnother = false;
            render();
          } catch (err) {
            errorEl.textContent = err.message || COPY.onboarding.connectionFailed;
            errorEl.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.querySelector('span').textContent = submitLabel(gymId);
          }
        });
      }
    };

    render();
  });
}

// ---- STEP: account name (H-2) ---------------------------------------------
// This deliberately runs after, rather than inside, each connection attempt:
// a member may link several gyms and should see one suggestion only after we
// can compare all of the linked profile names.
function stepName() {
  return new Promise(async (resolve) => {
    let linkedGyms = [];
    let settings = {};
    try {
      const [mine, saved] = await Promise.all([api.getMyGyms(), api.getSettings()]);
      linkedGyms = mine.gyms || mine || [];
      settings = saved || {};
    } catch (_) {
      // A transient read failure must not trap the member in onboarding.
      resolve();
      return;
    }

    if (!linkedGyms.length || cleanFirstName(settings.firstName)) {
      resolve();
      return;
    }

    const suggestion = inferFirstName(linkedGyms);
    const save = async (value, sheet) => {
      const firstName = cleanFirstName(value);
      const errorEl = sheet.querySelector('.app-onb-name-error');
      if (!firstName) {
        errorEl.textContent = COPY.onboarding.nameRequired;
        errorEl.style.display = 'block';
        return;
      }
      errorEl.style.display = 'none';
      try {
        await api.updateSettings({ firstName });
        resolve();
      } catch (err) {
        errorEl.textContent = err.message || COPY.onboarding.connectionFailed;
        errorEl.style.display = 'block';
      }
    };

    const renderEntry = (prefill = '') => {
      const sheet = renderSheet({
        eyebrow: COPY.onboarding.nameEyebrow,
        title: COPY.onboarding.namePrompt,
        hero: ICON.user,
        body: `<p class="app-onb-lead"></p>
          <label class="onb-select-label" for="app-onb-first-name"></label>
          <input class="onb-email-input" id="app-onb-first-name" autocomplete="given-name" value="${escapeHtml(cleanFirstName(prefill))}">
          <div class="app-login-error app-onb-name-error" style="display:none;margin-top:8px;"></div>`,
        footer: `<button class="app-btn-primary app-onb-name-save" type="button"><span>${COPY.onboarding.saveAndContinue}</span></button>`,
        onBack: suggestion ? renderSuggestion : () => resolve('back'),
      });
      sheet.querySelector('.app-onb-lead').textContent = suggestion ? COPY.onboarding.nameExplanation : '';
      sheet.querySelector('label').textContent = COPY.onboarding.nameInputLabel;
      sheet.querySelector('.app-onb-name-save').addEventListener('click', () => save(sheet.querySelector('#app-onb-first-name').value, sheet));
      sheet.querySelector('#app-onb-first-name').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save(event.currentTarget.value, sheet);
      });
    };

    const renderSuggestion = () => {
      const sheet = renderSheet({
        eyebrow: COPY.onboarding.nameEyebrow,
        // renderSheet interpolates titles as HTML, so a provider profile can
        // never turn an untrusted display name into markup here.
        title: escapeHtml(formatCopyText(COPY.onboarding.nameQuestion, { name: suggestion })),
        hero: ICON.user,
        body: `<p class="app-onb-lead"></p><div class="app-login-error app-onb-name-error" style="display:none;margin-top:8px;"></div>`,
        footer: `<button class="app-btn-primary app-onb-name-yes" type="button"><span>${COPY.onboarding.yes}</span></button>
          <button class="app-btn-mini app-onb-name-edit" type="button">${COPY.onboarding.edit}</button>`,
        onBack: () => resolve('back'),
      });
      sheet.querySelector('.app-onb-lead').textContent = COPY.onboarding.nameExplanation;
      sheet.querySelector('.app-onb-name-yes').addEventListener('click', () => save(suggestion, sheet));
      sheet.querySelector('.app-onb-name-edit').addEventListener('click', () => renderEntry(suggestion));
    };

    if (suggestion) renderSuggestion();
    else renderEntry();
  });
}

// ---- STEP: notifications ----
function stepNotifications() {
  return new Promise((resolve) => {
    if (!pushSupported() || Notification.permission === 'granted') return resolve();

    // iOS can only push when installed to the Home Screen.
    if (isIOS() && !isStandalone()) {
      const sheet = renderSheet({
        eyebrow: COPY.onboarding.notificationsEyebrow,
        title: COPY.onboarding.iosNotificationTitle,
        hero: ICON.push,
        body: `<p class="app-onb-lead">${appCopy(COPY.onboarding.iosNotificationHelp)}</p>`,
        footer: `<button class="app-btn-primary app-onb-continue" type="button"><span>${COPY.onboarding.continue}</span></button>`,
      });
      sheet.querySelector('.app-onb-continue').addEventListener('click', resolve);
      return;
    }

    const sheet = renderSheet({
      eyebrow: COPY.onboarding.notificationsTitle,
      title: COPY.onboarding.enablePushTitle,
      hero: ICON.push,
      body: `<p class="app-onb-lead">${COPY.onboarding.notificationsDescription}</p>`,
      footer: `<button class="app-btn-primary app-onb-notif-enable" type="button"><span>${COPY.onboarding.enableNotifications}</span></button>
        <button class="app-btn-mini app-onb-skip-inline" type="button">${COPY.onboarding.maybeLater}</button>`,
    });

    sheet.querySelector('.app-onb-skip-inline').addEventListener('click', resolve);
    sheet.querySelector('.app-onb-notif-enable').addEventListener('click', async () => {
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
      // webcal:// is the scheme iOS/macOS register for calendar subscriptions; webcals:// is not
      // (Safari reports "invalid address").
      const webcalUrl = links?.webcal || '';
      const gcalUrl = links?.google || '';
      const icsUrl = links?.https || links?.ics || '';

      const sheet = renderSheet({
        eyebrow: COPY.onboarding.calendarEnabled,
        title: COPY.onboarding.subscribeCalendarTitle,
        hero: ICON.calendar,
        body: `
          <p class="app-onb-lead">${COPY.onboarding.addLiveFeed}</p>
          <div class="app-onb-cal-links">
            ${webcalUrl ? `<a href="${webcalUrl}" class="app-btn-primary onb-webcal-button"><span>${ios ? COPY.onboarding.appleCalendarButton : COPY.onboarding.webcalButton}</span></a>` : ''}
            ${gcalUrl && !ios ? `<a href="${gcalUrl}" target="_blank" rel="noopener noreferrer" class="app-btn-secondary onb-webcal-button"><span>${COPY.onboarding.googleCalendarButton}</span></a>` : ''}
            ${icsUrl ? `<button class="app-btn-mini app-onb-copy-ics onb-gym-select" type="button">${COPY.onboarding.copyFeedUrl}</button>` : ''}
          </div>`,
        footer: `<button class="app-btn-primary app-onb-continue" type="button"><span>${COPY.onboarding.done}</span></button>`,
      });

      const copyBtn = sheet.querySelector('.app-onb-copy-ics');
      if (copyBtn && icsUrl) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(icsUrl);
            copyBtn.textContent = COPY.onboarding.copied;
            setTimeout(() => { copyBtn.textContent = COPY.onboarding.copyFeedUrl; }, 2000);
          } catch (_) {}
        });
      }

      sheet.querySelector('.app-onb-continue').addEventListener('click', resolve);
    };

    const sheet = renderSheet({
      eyebrow: COPY.onboarding.calendarTitle,
      title: COPY.onboarding.calendarDescription,
      hero: ICON.calendar,
      body: `<p class="app-onb-lead">${COPY.onboarding.calendarEnableDescription.replace('{calendar}', ios ? 'Apple' : 'your')}</p>`,
      footer: `<button class="app-btn-primary app-onb-cal-enable" type="button"><span>${COPY.onboarding.enableCalendar}</span></button>
        <button class="app-btn-mini app-onb-skip-inline" type="button">${COPY.onboarding.setupLater}</button>`,
    });

    const enableBtn = sheet.querySelector('.app-onb-cal-enable');
    enableBtn.addEventListener('click', async () => {
      enableBtn.disabled = true;
      try {
        const res = await api.enableCalendar({});
        showSubscribe(res.links || null);
      } catch (_) {
        resolve();
      }
    });
    sheet.querySelector('.app-onb-skip-inline').addEventListener('click', resolve);
  });
}

// ---- STEP: spot-map setup ----
async function stepSpotMaps() {
  let prefs = {};
  try { prefs = await api.getStudioPreferences(); } catch (_) { prefs = {}; }
  if (prefs && Object.keys(prefs).length > 0) return; // already has maps — skip

  return new Promise((resolve) => {
    const sheet = renderSheet({
      eyebrow: COPY.onboarding.spotMapEyebrow,
      title: COPY.onboarding.spotMapTitle,
      hero: ICON.quickbook,
      body: `<p class="app-onb-lead">${COPY.onboarding.spotMapDescription}</p>`,
      footer: `<button class="app-btn-primary app-onb-setup" type="button"><span>${COPY.onboarding.setUpNow}</span></button>
        <button class="app-btn-mini app-onb-skip-inline" type="button">${COPY.onboarding.maybeLater}</button>`,
    });

    sheet.querySelector('.app-onb-skip-inline').addEventListener('click', resolve);
    sheet.querySelector('.app-onb-setup').addEventListener('click', () => {
      openManageSpotMapsModal({ zIndex: 1000000, onDone: resolve });
    });
  });
}

function stepFeatures() {
  return new Promise(async (resolve) => {
  const c = show();
  c.innerHTML = `
    ${topBarHtml(backButtonHtml())}
    <div class="app-onb-sheet app-onb-features" role="dialog" aria-modal="true" aria-labelledby="app-onb-features-title">
      ${heroHtml(ICON.check, 'is-seal')}
      <div class="app-onb-eyebrow">${COPY.onboarding.optionalSetup}</div>
      <h2 class="app-onb-title" id="app-onb-features-title">${COPY.onboarding.makeItYours}</h2>
      <p class="app-onb-lead">${appCopy(COPY.onboarding.optionalSetupDescription)}</p>
      <div class="app-onb-feature-list">
        <section class="app-onb-feature-card" data-feature="notifications">
          <div class="app-onb-feature-heading"><span class="app-onb-icon">${ICON.push}</span><div><h3>${COPY.static.notifications} <span class="app-onb-recommended">${COPY.onboarding.recommended}</span></h3><p>${COPY.onboarding.notificationUpdates}</p></div></div>
          <div class="app-onb-feature-action"></div>
        </section>
        <section class="app-onb-feature-card" data-feature="calendar">
          <div class="app-onb-feature-heading"><span class="app-onb-icon">${ICON.calendarSync}</span><div><h3>${COPY.onboarding.calendarFeatureTitle}</h3><p>${COPY.onboarding.calendarFeedDescription}</p></div></div>
          <div class="app-onb-feature-action"></div>
        </section>
        <section class="app-onb-feature-card" data-feature="spotmaps">
          <div class="app-onb-feature-heading"><span class="app-onb-icon">${ICON.quickbook}</span><div><h3>${COPY.onboarding.preferredSpotFeatureTitle}</h3><p>${COPY.onboarding.preferredSpotFeatureDescription}</p></div></div>
          <div class="app-onb-feature-action"></div>
        </section>
      <section class="app-onb-feature-card" data-feature="autoupgrade">
        <div class="app-onb-feature-heading"><span class="app-onb-icon">${ICON.autoupgrade}</span><div><h3>${COPY.onboarding.autoUpgradeFeatureTitle}</h3><p>${COPY.onboarding.autoUpgradeFeatureDescription}</p>
          <label class="app-onb-auto-upgrade-option"><input type="checkbox" id="app-onb-auto-upgrade-all"><span>${COPY.onboarding.autoUpgradeAllGyms}</span></label></div></div>
        <div class="app-onb-feature-action"></div>
      </section>
      </div>
      <div class="app-onb-footer">
        <button class="app-btn-primary app-onb-finish" type="button">${COPY.onboarding.setupLater}</button>
      </div>
    </div>`;

  const notificationCard = c.querySelector('[data-feature="notifications"]');
  const calendarCard = c.querySelector('[data-feature="calendar"]');
  const spotCard = c.querySelector('[data-feature="spotmaps"]');
  const cards = { notifications: notificationCard, calendar: calendarCard, spotmaps: spotCard };
  const completion = { notifications: false, calendar: false, spotmaps: false };

  const renderAction = (name, done, text, disabled = false) => {
    completion[name] = done;
    const target = cards[name].querySelector('.app-onb-feature-action');
    const buttonText = name === 'calendar' && done ? COPY.onboarding.calendarSettings : text;
    target.innerHTML = `${done ? `<span class="app-onb-complete" role="status">✓ ${COPY.onboarding.setUp}</span>` : ''}${name === 'calendar' && done || !done ? `<button class="app-btn-mini" type="button" data-feature-action="${name}" ${disabled ? 'disabled' : ''}>${buttonText}</button>` : ''}`;
    cards[name].classList.toggle('is-complete', done);
  };

  const refreshStatus = async () => {
    const supported = pushSupported();
    let notificationsEnabled = false;
    if (supported && Notification.permission === 'granted') {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        notificationsEnabled = !!(await registration?.pushManager.getSubscription());
      } catch (_) {}
    }
    renderAction('notifications', notificationsEnabled, supported ? (Notification.permission === 'denied' ? COPY.onboarding.blockedBrowserSettings : COPY.onboarding.tapToEnable) : COPY.onboarding.pushUnavailable, !supported || Notification.permission === 'denied');
    const [calendar, prefs, linkedRes] = await Promise.all([
      api.getCalendarStatus().catch(() => ({ enabled: false })),
      api.getStudioPreferences().catch(() => ({})),
      api.getMyGyms().catch(() => ({ gyms: [] })),
    ]);
    renderAction('calendar', !!calendar.enabled, COPY.onboarding.calendarSetupButton);
    const hasSpotMap = Object.values(prefs || {}).some((p) => p?.preferredSlots?.length || p?.preferredRows?.length);
    const linkedGyms = linkedRes.gyms || linkedRes || [];
    renderAction('spotmaps', hasSpotMap, linkedGyms.length ? COPY.onboarding.spotMapSetupButton : COPY.onboarding.connectGymForSpotMaps, linkedGyms.length === 0);
    const complete = Object.values(completion).every(Boolean);
    // Success flourish: the seal's ring pulses once when everything becomes set up.
    c.querySelector('.app-onb-hero')?.classList.toggle('is-done', complete);
    c.querySelector('.app-onb-finish').textContent = complete ? COPY.onboarding.continueToTimetable : COPY.onboarding.setupLater;
  };

  const upgradeCard = c.querySelector('[data-feature="autoupgrade"]');
  const upgradeBox = c.querySelector('#app-onb-auto-upgrade-all');
  upgradeBox.addEventListener('change', () => {
    upgradeCard.classList.toggle('is-complete', upgradeBox.checked);
    upgradeCard.querySelector('.app-onb-feature-action').innerHTML = upgradeBox.checked ? `<span class="app-onb-complete" role="status">✓ ${COPY.onboarding.setUp}</span>` : '';
  });

  await refreshStatus();
  c.querySelector('.app-onb-back-top').addEventListener('click', () => { resolve('back'); });
  c.querySelector('.app-onb-finish').addEventListener('click', async (event) => {
    const checkbox = c.querySelector('#app-onb-auto-upgrade-all');
    const finishButton = event.currentTarget;
    if (checkbox.checked) {
      finishButton.disabled = true;
      try {
        const [mine, catalogue] = await Promise.all([api.getMyGyms(), api.getGyms()]);
        const linkedGyms = mine.gyms || [];
        if (linkedGyms.length) {
          const result = await enableAutoUpgradeForGyms(linkedGyms, catalogue, api.updateSettings.bind(api));
          if (result.failedGymIds.length) {
            const names = result.failedGymIds.map((gymId) => catalogue.find((gym) => gym.id === gymId)?.name || gymId).join(', ');
            showToast(formatCopyText(COPY.onboarding.autoUpgradeEnableFailed, { gyms: names }), 'error');
          }
        }
      } catch (_) {
        showToast(formatCopyText(COPY.onboarding.autoUpgradeEnableFailed, { gyms: COPY.onboarding.connectedGyms }), 'error');
      }
    }
    resolve();
  });

  notificationCard.addEventListener('click', async (event) => {
    if (event.target.closest('[data-feature-action="notifications"]')) {
      try { await togglePushSubscription(); } catch (_) { /* denial and unsupported states stay optional */ }
      await refreshStatus();
    }
  });
  calendarCard.addEventListener('click', (event) => {
    if (!event.target.closest('[data-feature-action="calendar"]')) return;
    openCalendarSettingsModal({ zIndex: 1000000, onChange: refreshStatus, onClose: refreshStatus });
  });
  spotCard.addEventListener('click', (event) => {
    if (!event.target.closest('[data-feature-action="spotmaps"]')) return;
    openManageSpotMapsModal({ zIndex: 1000000, onDone: refreshStatus });
  });
  });
}

const STEP_HANDLERS = {
  intro: stepIntro,
  install: stepInstall,
  authchoice: stepAuthChoice,
  login: stepLogin,
  gyms: stepGyms,
  name: stepName,
  features: stepFeatures,
};
