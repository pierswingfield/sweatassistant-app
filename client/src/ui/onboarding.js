// Sweat Assistant — first-run onboarding flow.
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
import { renderCalendarSection } from './calendar-section.js';
import { appConfig } from '../config';
import { setGymCatalogue } from '../gym-context.js';
import { COPY, formatCopyText, appCopy } from '../copy.js';
import { escapeHtml, gymChip } from './cards';
import { enableAutoUpgradeForGyms, shouldAnimateGymLogos, getPostLoginDestination as choosePostLoginDestination } from './onboarding-routing.js';

const COMPLETE_KEY = 'psycleOnboardingComplete';
const STEP_KEY = 'psycleOnboardingStep';
// Bump to re-trigger onboarding for all users after a significant change.
// v4: focused, resumable flow with one optional setup roll-up.
const ONBOARDING_VERSION = '4';

const STEPS = ['intro', 'login', 'gyms', 'features'];

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

export function isOnboardingActive() {
  return active;
}

export function shouldShowOnboarding() {
  // Completion belongs to an account, not this browser. In the pre-login state
  // there is no account to complete, so always keep onboarding available.
  return localStorage.getItem(onboardingKey(COMPLETE_KEY)) !== ONBOARDING_VERSION;
}

function onboardingKey(base) {
  const accountId = localStorage.getItem('psycleUserId');
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

export function resumeOnboarding({ optionalOnly = false } = {}) {
  if (optionalOnly) return runFrom(STEPS.indexOf('features'));
  const saved = localStorage.getItem(onboardingKey(STEP_KEY));
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
    let i = startIndex;
    while (i < STEPS.length) {
      const step = STEPS[i];
      localStorage.setItem(onboardingKey(STEP_KEY), step);
      const action = await STEP_HANDLERS[step]();
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
      if (action === 'back') i = Math.max(0, i - 1);
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
  const accountId = localStorage.getItem('psycleUserId');
  if (accountId) {
    localStorage.setItem(onboardingKey(COMPLETE_KEY), ONBOARDING_VERSION);
    localStorage.removeItem(onboardingKey(STEP_KEY));
  }
  container().style.display = 'none';
  container().innerHTML = '';
  location.hash = '#class-timetable';
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
    { welcome: true, title: appCopy(COPY.onboarding.welcomeTitle) },
  ];
}

// ---- STEP: intro carousel ----
function stepIntro() {
  return new Promise((resolve) => {
    const slides = getSlides();
    const c = show();
    const O = COPY.onboarding;
    const perks = [
      { icon: 'autobook', token: '--feat-autobook', title: O.perkAutoBookTitle, text: O.perkAutoBookText },
      { icon: 'autoupgrade', token: '--feat-autoupgrade', title: O.perkAutoUpgradeTitle, text: O.perkAutoUpgradeText },
      { icon: 'calendarSync', token: '--info', title: O.perkCalendarTitle, text: O.perkCalendarText },
      { icon: 'push', token: '--success', title: O.perkNotifyTitle, text: O.perkNotifyText },
    ].map((p) => ({ ...p, text: appCopy(p.text) }));
    c.innerHTML = `
      <div class="psycle-onb-sheet psycle-onb-intro" role="dialog" aria-modal="true" aria-labelledby="psycle-onb-welcome-title">
        <div class="psycle-onb-carousel">
          <div class="psycle-onb-track">
            ${slides.map((s) => s.welcome ? `
              <div class="psycle-onb-slide psycle-onb-slide-welcome">
                <div class="psycle-onb-wordmark">${escapeHtml(appConfig.appName)}</div>
                <h2 class="psycle-onb-title psycle-onb-welcome-title" id="psycle-onb-welcome-title">${s.title}</h2>
                <ul class="psycle-onb-perks" role="list">
                  ${perks.map((p, i) => `
                  <li class="psycle-onb-perk" style="--perk: var(${p.token}); --i: ${i};">
                    <span class="psycle-onb-perk-icon" aria-hidden="true">${ICON[p.icon]}</span>
                    <div class="psycle-onb-perk-body">
                      <strong>${p.title}</strong>
                      <span>${p.text}</span>
                    </div>
                  </li>`).join('')}
                </ul>
                <p class="psycle-onb-gyms-line">${COPY.onboarding.welcomeGyms}</p>
              </div>` : `
              <div class="psycle-onb-slide">
                <div class="psycle-onb-icon" style="color: var(--feat-${s.feat}, var(--accent));">${s.icon}</div>
                <h2 class="psycle-onb-title">${s.title}</h2>
                <p class="psycle-onb-slide-text">${s.text}</p>
              </div>`).join('')}
          </div>
        </div>
          ${slides.length > 1 ? `<div class="psycle-onb-dots">${slides.map((_, i) => `<button class="psycle-onb-dot${i === 0 ? ' is-active' : ''}" type="button" aria-label="${COPY.onboarding.slideLabel.replace('{number}', i + 1)}"></button>`).join('')}</div>` : ''}
        <div class="psycle-onb-footer">
          ${isLoggedIn() ? `<button class="psycle-btn-primary psycle-onb-auth" type="button" data-auth-mode="continue">${COPY.onboarding.continueSetup}</button>` : `<button class="psycle-btn-primary psycle-onb-auth" type="button" data-auth-mode="login">${COPY.onboarding.logInButton}</button><button class="psycle-btn-secondary psycle-onb-auth" type="button" data-auth-mode="signup">${COPY.onboarding.createAccountButton}</button>`}
        </div>
      </div>`;

    const track = c.querySelector('.psycle-onb-track');
    const dots = [...c.querySelectorAll('.psycle-onb-dot')];
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
    c.querySelector('.psycle-onb-skip')?.addEventListener('click', resolve);

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
        <li><span class="psycle-onb-reason-icon">${ICON.push}</span><div><strong>${COPY.onboarding.pushReasonTitle}</strong><br>${COPY.onboarding.pushReason}</div></li>
        <li><span class="psycle-onb-reason-icon">${ICON.offline}</span><div><strong>${COPY.onboarding.offlineReasonTitle}</strong><br>${COPY.onboarding.offlineReason}</div></li>
      </ul>`;

    let body;
    let primary;
    if (promptEvent) {
      // Android / desktop Chromium — native one-tap install
      body = `<p class="psycle-onb-lead">${appCopy(COPY.onboarding.installForExperience)}</p>${reasoning}`;
      primary = `<button class="psycle-btn-primary psycle-onb-install" type="button"><span>${COPY.onboarding.installButton}</span></button>`;
    } else if (ios) {
      body = `<p class="psycle-onb-lead">${appCopy(COPY.onboarding.installForHomeScreen)}</p>${reasoning}
        <ol class="psycle-onb-steps">
          <li>${COPY.onboarding.iosShareStepHtml.replace('{shareIcon}', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.1em; height: 1.1em; display: inline-block; vertical-align: middle; margin: 0 2px;"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>')}</li>
          <li>${COPY.onboarding.iosAddStep}</li>
          <li>${appCopy(COPY.onboarding.iosOpenAppStep)}</li>
        </ol>`;
      primary = '';
    } else {
      // Android browser without beforeinstallprompt, or other
      body = `<p class="psycle-onb-lead">${appCopy(COPY.onboarding.installForExperience)}</p>${reasoning}
        <ol class="psycle-onb-steps">
          <li>${COPY.onboarding.browserMenuStep}</li>
          <li>${COPY.onboarding.browserInstallStep}</li>
        </ol>`;
      primary = '';
    }

    const sheet = renderSheet({
      eyebrow: COPY.onboarding.installEyebrow,
      title: appCopy(COPY.onboarding.installTitle),
      body,
      footer: `${primary}<button class="psycle-btn-mini psycle-onb-skip-inline" type="button">${COPY.onboarding.continueInBrowser}</button>`,
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

    const login = document.getElementById('psycle-login-container');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'psycle-btn-mini psycle-onb-auth-back';
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
    if (requestedAuthMode === 'signup') document.getElementById('psycle-auth-to-signup')?.click();
  });
}

/** Logos of every wired gym, from the catalogue. >3 gyms scroll as a marquee (duplicated track). */
function gymLogoStripHtml(gyms) {
  if (!gyms.length) return '';
  const items = gyms.map((g) => `<li class="psycle-onb-gym-logo">${gymChip(g.id)}</li>`).join('');
  const animate = shouldAnimateGymLogos(gyms.length);
  return `<div class="psycle-onb-gym-logos${animate ? ' is-marquee' : ''}" role="group" tabindex="0" aria-label="${escapeHtml(COPY.onboarding.supportedGyms)}">
    <div class="psycle-onb-gym-logos-track">
      <ul class="psycle-onb-gym-logos-set" role="list">${items}</ul>
      ${animate ? `<ul class="psycle-onb-gym-logos-set is-clone" aria-hidden="true">${items}</ul>` : ''}
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
        ? `<div class="psycle-onb-connected-gyms" style="margin-bottom:16px;">
            <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-tertiary);margin-bottom:8px;">${COPY.onboarding.connectedGyms}</div>
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
                  <span class="psycle-badge" style="font-size:11px;background:color-mix(in srgb,var(--success) 15%,transparent);color:var(--success);">${COPY.gyms.connected}</span>
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
          <div class="psycle-onb-link-form" style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);border:1px solid var(--border);border-radius:12px;padding:16px;">
            <div style="font-size:13px;font-weight:600;color:var(--text-secondary);">
              ${hasLinked ? COPY.onboarding.connectAnotherGym : COPY.onboarding.connectGymAccount}
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-tertiary);display:block;margin-bottom:4px;">${COPY.onboarding.selectGym}</label>
              <select id="psycle-onb-gym-select" class="psycle-select" style="width:100%;">
                ${unlinkedGyms.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-tertiary);display:block;margin-bottom:4px;">${COPY.onboarding.gymLoginEmail}</label>
              <input type="email" id="psycle-onb-gym-email" placeholder="${COPY.onboarding.gymEmailPlaceholder}" autocomplete="off" style="width:100%;box-sizing:border-box;">
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-tertiary);display:block;margin-bottom:4px;">${COPY.onboarding.gymPassword}</label>
              <input type="password" id="psycle-onb-gym-password" placeholder="${COPY.onboarding.gymPasswordPlaceholder}" autocomplete="off" style="width:100%;box-sizing:border-box;">
            </div>
            <div id="psycle-onb-gym-error" class="psycle-login-error" style="display:none;margin-top:4px;"></div>
            <button type="button" id="psycle-onb-gym-submit" class="psycle-btn-primary" style="margin-top:4px;"><span>${escapeHtml(submitLabel(unlinkedGyms[0]?.id))}</span></button>
            ${hasLinked ? `<button type="button" id="psycle-onb-add-another-back" class="psycle-btn-mini">${COPY.onboarding.backToSetup}</button>` : ''}
          </div>
        `;
      } else if (unlinkedGyms.length > 0 && hasLinked) {
        formHtml = `<button type="button" id="psycle-onb-add-another" class="psycle-btn-secondary" style="width:100%;">${COPY.onboarding.connectAnotherLower}</button>`;
      } else {
        formHtml = `
          <div style="padding:16px;text-align:center;background:color-mix(in srgb,var(--success) 10%,transparent);border:1px solid color-mix(in srgb,var(--success) 20%,transparent);border-radius:12px;color:var(--text-primary);margin-bottom:12px;">
            <strong style="color:var(--success);">${COPY.onboarding.allGymsConnected}</strong><br>
            <span style="font-size:12px;color:var(--text-secondary);">${COPY.onboarding.allSetToBook}</span>
          </div>
        `;
      }

      const continueBtnHtml = hasLinked
        ? `<button class="psycle-btn-primary psycle-onb-continue" type="button" style="${unlinkedGyms.length > 0 ? 'background:var(--surface-inset);border:1px solid var(--border);color:var(--text-primary);' : ''}"><span>${COPY.onboarding.continue}</span></button>`
        : `<button class="psycle-btn-mini psycle-onb-skip-inline" type="button">${COPY.onboarding.setupLater}</button>`;

      const sheet = renderSheet({
        eyebrow: COPY.onboarding.yourGyms,
        title: COPY.onboarding.connectGymAccounts,
        body: `
          <p class="psycle-onb-lead" style="margin-bottom:16px;">${appCopy(COPY.onboarding.connectDescription)}</p>
          ${gymLogoStripHtml(allGyms)}
          ${connectedListHtml}
          ${formHtml}
        `,
        footer: `<button class="psycle-btn-mini psycle-onb-back" type="button">${COPY.onboarding.back}</button>${continueBtnHtml}`,
      });

      sheet.querySelector('.psycle-onb-back').addEventListener('click', () => resolve('welcome'));

      const addAnotherBtn = sheet.querySelector('#psycle-onb-add-another');
      if (addAnotherBtn) addAnotherBtn.addEventListener('click', () => { addingAnother = true; render(); });

      const addAnotherBack = sheet.querySelector('#psycle-onb-add-another-back');
      if (addAnotherBack) addAnotherBack.addEventListener('click', () => { addingAnother = false; render(); });

      const continueBtn = sheet.querySelector('.psycle-onb-continue');
      if (continueBtn) {
        continueBtn.addEventListener('click', resolve);
      }
      const skipBtn = sheet.querySelector('.psycle-onb-skip-inline');
      if (skipBtn) {
        skipBtn.addEventListener('click', resolve);
      }

      const submitBtn = sheet.querySelector('#psycle-onb-gym-submit');
      const gymSel = sheet.querySelector('#psycle-onb-gym-select');
      if (gymSel && submitBtn) gymSel.addEventListener('change', () => { submitBtn.querySelector('span').textContent = submitLabel(gymSel.value); });
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

// ---- STEP: notifications ----
function stepNotifications() {
  return new Promise((resolve) => {
    if (!pushSupported() || Notification.permission === 'granted') return resolve();

    // iOS can only push when installed to the Home Screen.
    if (isIOS() && !isStandalone()) {
      const sheet = renderSheet({
        eyebrow: COPY.onboarding.notificationsEyebrow,
        title: COPY.onboarding.iosNotificationTitle,
        body: `<p class="psycle-onb-lead">${appCopy(COPY.onboarding.iosNotificationHelp)}</p>`,
        footer: `<button class="psycle-btn-primary psycle-onb-continue" type="button"><span>${COPY.onboarding.continue}</span></button>`,
      });
      sheet.querySelector('.psycle-onb-continue').addEventListener('click', resolve);
      return;
    }

    const sheet = renderSheet({
      eyebrow: COPY.onboarding.notificationsTitle,
      title: COPY.onboarding.enablePushTitle,
      body: `<div class="psycle-onb-icon" style="color: var(--feat-push, var(--accent));">${ICON.push}</div>
        <p class="psycle-onb-lead">${COPY.onboarding.notificationsDescription}</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-notif-enable" type="button"><span>${COPY.onboarding.enableNotifications}</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">${COPY.onboarding.maybeLater}</button>`,
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
      // iOS/Apple hands plain webcal:// to Calendar as http and warns; use the https form there.
      const webcalUrl = (ios ? links?.webcals : '') || links?.webcal || '';
      const gcalUrl = links?.google || '';
      const icsUrl = links?.https || links?.ics || '';

      const sheet = renderSheet({
        eyebrow: COPY.onboarding.calendarEnabled,
        title: COPY.onboarding.subscribeCalendarTitle,
        body: `
          <div class="psycle-onb-icon" style="color: var(--accent);">${ICON.calendar}</div>
          <p class="psycle-onb-lead">${COPY.onboarding.addLiveFeed}</p>
          <div class="psycle-onb-cal-links">
            ${webcalUrl ? `<a href="${webcalUrl}" class="psycle-btn-primary" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;"><span>${ios ? COPY.onboarding.appleCalendarButton : COPY.onboarding.webcalButton}</span></a>` : ''}
            ${gcalUrl && !ios ? `<a href="${gcalUrl}" target="_blank" rel="noopener noreferrer" class="psycle-btn-secondary" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;"><span>${COPY.onboarding.googleCalendarButton}</span></a>` : ''}
            ${icsUrl ? `<button class="psycle-btn-mini psycle-onb-copy-ics" type="button" style="width:100%;">${COPY.onboarding.copyFeedUrl}</button>` : ''}
          </div>`,
        footer: `<button class="psycle-btn-primary psycle-onb-continue" type="button"><span>${COPY.onboarding.done}</span></button>`,
      });

      const copyBtn = sheet.querySelector('.psycle-onb-copy-ics');
      if (copyBtn && icsUrl) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(icsUrl);
            copyBtn.textContent = COPY.onboarding.copied;
            setTimeout(() => { copyBtn.textContent = COPY.onboarding.copyFeedUrl; }, 2000);
          } catch (_) {}
        });
      }

      sheet.querySelector('.psycle-onb-continue').addEventListener('click', resolve);
    };

    const sheet = renderSheet({
      eyebrow: COPY.onboarding.calendarTitle,
      title: COPY.onboarding.calendarDescription,
      body: `<div class="psycle-onb-icon" style="color: var(--accent);">${ICON.calendar}</div>
        <p class="psycle-onb-lead">${COPY.onboarding.calendarEnableDescription.replace('{calendar}', ios ? 'Apple' : 'your')}</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-cal-enable" type="button"><span>${COPY.onboarding.enableCalendar}</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">${COPY.onboarding.setupLater}</button>`,
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
      eyebrow: COPY.onboarding.spotMapEyebrow,
      title: COPY.onboarding.spotMapTitle,
      body: `<div class="psycle-onb-icon" style="color: var(--feat-quickbook, var(--accent));">${ICON.quickbook}</div>
        <p class="psycle-onb-lead">${COPY.onboarding.spotMapDescription}</p>`,
      footer: `<button class="psycle-btn-primary psycle-onb-setup" type="button"><span>${COPY.onboarding.setUpNow}</span></button>
        <button class="psycle-btn-mini psycle-onb-skip-inline" type="button">${COPY.onboarding.maybeLater}</button>`,
    });

    sheet.querySelector('.psycle-onb-skip-inline').addEventListener('click', resolve);
    sheet.querySelector('.psycle-onb-setup').addEventListener('click', () => {
      openManageSpotMapsModal({ zIndex: 1000000, onDone: resolve });
    });
  });
}

function stepFeatures() {
  return new Promise(async (resolve) => {
  const c = show();
  c.innerHTML = `
    <div class="psycle-onb-sheet psycle-onb-features" role="dialog" aria-modal="true" aria-labelledby="psycle-onb-features-title">
      <div class="psycle-onb-eyebrow">${COPY.onboarding.optionalSetup}</div>
      <h2 class="psycle-onb-title" id="psycle-onb-features-title">${COPY.onboarding.makeItYours}</h2>
      <p class="psycle-onb-lead">${appCopy(COPY.onboarding.optionalSetupDescription)}</p>
      <div class="psycle-onb-feature-list">
        <section class="psycle-onb-feature-card" data-feature="notifications">
          <div class="psycle-onb-feature-heading"><span class="psycle-onb-icon">${ICON.push}</span><div><h3>${COPY.static.notifications} <span class="psycle-onb-recommended">${COPY.onboarding.recommended}</span></h3><p>${COPY.onboarding.notificationUpdates}</p></div></div>
          <div class="psycle-onb-feature-action"></div>
        </section>
        <section class="psycle-onb-feature-card" data-feature="calendar">
          <div class="psycle-onb-feature-heading"><span class="psycle-onb-icon">${ICON.calendarSync}</span><div><h3>${COPY.onboarding.calendarFeatureTitle}</h3><p>${COPY.onboarding.calendarFeedDescription}</p></div></div>
          <div class="psycle-onb-feature-action"></div>
          <div class="psycle-onb-calendar-settings" hidden></div>
        </section>
        <section class="psycle-onb-feature-card" data-feature="spotmaps">
          <div class="psycle-onb-feature-heading"><span class="psycle-onb-icon">${ICON.quickbook}</span><div><h3>${COPY.onboarding.preferredSpotFeatureTitle}</h3><p>${COPY.onboarding.preferredSpotFeatureDescription}</p></div></div>
          <div class="psycle-onb-feature-action"></div>
        </section>
      <section class="psycle-onb-feature-card" data-feature="autoupgrade">
        <div class="psycle-onb-feature-heading"><span class="psycle-onb-icon">${ICON.autoupgrade}</span><div><h3>${COPY.onboarding.autoUpgradeFeatureTitle}</h3><p>${COPY.onboarding.autoUpgradeFeatureDescription}</p>
          <label class="psycle-onb-auto-upgrade-option"><input type="checkbox" id="psycle-onb-auto-upgrade-all"><span>${COPY.onboarding.autoUpgradeAllGyms}</span></label></div></div>
        <div class="psycle-onb-feature-action"></div>
      </section>
      </div>
      <div class="psycle-onb-footer">
        <button class="psycle-btn-mini psycle-onb-back" type="button">${COPY.onboarding.back}</button>
        <button class="psycle-btn-primary psycle-onb-finish" type="button">${COPY.onboarding.setupLater}</button>
      </div>
    </div>`;

  const notificationCard = c.querySelector('[data-feature="notifications"]');
  const calendarCard = c.querySelector('[data-feature="calendar"]');
  const spotCard = c.querySelector('[data-feature="spotmaps"]');
  const cards = { notifications: notificationCard, calendar: calendarCard, spotmaps: spotCard };
  const completion = { notifications: false, calendar: false, spotmaps: false };

  const renderAction = (name, done, text, disabled = false) => {
    completion[name] = done;
    const target = cards[name].querySelector('.psycle-onb-feature-action');
    const buttonText = name === 'calendar' && done ? COPY.onboarding.calendarSettings : text;
    target.innerHTML = `${done ? `<span class="psycle-onb-complete" role="status">✓ ${COPY.onboarding.setUp}</span>` : ''}${name === 'calendar' && done || !done ? `<button class="psycle-btn-mini" type="button" data-feature-action="${name}" ${disabled ? 'disabled' : ''}>${buttonText}</button>` : ''}`;
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
    c.querySelector('.psycle-onb-finish').textContent = complete ? COPY.onboarding.continueToTimetable : COPY.onboarding.setupLater;
  };

  const upgradeCard = c.querySelector('[data-feature="autoupgrade"]');
  const upgradeBox = c.querySelector('#psycle-onb-auto-upgrade-all');
  upgradeBox.addEventListener('change', () => {
    upgradeCard.classList.toggle('is-complete', upgradeBox.checked);
    upgradeCard.querySelector('.psycle-onb-feature-action').innerHTML = upgradeBox.checked ? `<span class="psycle-onb-complete" role="status">✓ ${COPY.onboarding.setUp}</span>` : '';
  });

  await refreshStatus();
  c.querySelector('.psycle-onb-back').addEventListener('click', () => { resolve('back'); });
  c.querySelector('.psycle-onb-finish').addEventListener('click', async (event) => {
    const checkbox = c.querySelector('#psycle-onb-auto-upgrade-all');
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
  calendarCard.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-feature-action="calendar"]')) return;
    const settings = calendarCard.querySelector('.psycle-onb-calendar-settings');
    settings.hidden = !settings.hidden;
    if (!settings.hidden) await renderCalendarSection(settings);
  });
  spotCard.addEventListener('click', (event) => {
    if (!event.target.closest('[data-feature-action="spotmaps"]')) return;
    openManageSpotMapsModal({ zIndex: 1000000, onDone: refreshStatus });
  });
  calendarCard.querySelector('.psycle-onb-calendar-settings').addEventListener('psycle:calendar-action-complete', async () => {
    await refreshStatus();
  });
  });
}

const STEP_HANDLERS = {
  intro: stepIntro,
  login: stepLogin,
  gyms: stepGyms,
  features: stepFeatures,
};
