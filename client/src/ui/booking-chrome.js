// Mobile booking-shell chrome (spotmap-booking-flow-spec, Batch 1).
//
// Three additions to `#psycle-booking-modal` on mobile only, shared by every flow that reuses the
// shell (timetable book / Quick-Book / Auto-Book, Auto-Book edit, My Bookings edit-spots,
// Auto-Upgrade configure):
//   1. an identity strip under the header (gym logo, gym, location, studio);
//   2. a static task title (the class details move out of the title);
//   3. a "this class" card plus a dismissible helper directly above the map.
// Every function is a no-op above 768px, so desktop keeps its current title and layout.

import { COPY, formatCopyText } from '../copy.js';
import { isMobile } from './modal-nav.js';
import { gymSquareChip, gymBrand, trimLocation, displayStudioName } from './cards.js';
import { instructorAvatar } from './tooltips.js';
import { formatInZone, zoneFor } from '../lib.js';
import { getLinkedGyms } from '../gym-context.js';

const HELPER_KEY = (id) => `sweatHelperDismissed:${id}`;

export function helperDismissed(id) {
  try { return localStorage.getItem(HELPER_KEY(id)) === '1'; } catch (_) { return false; }
}
function dismissHelper(id) {
  try { localStorage.setItem(HELPER_KEY(id), '1'); } catch (_) { /* storage unavailable: dismissal lasts for this view only */ }
}
/** Static task title + identity strip. Call after the flow's own title assignments. */
export function applyBookingChrome(modal, { titleText, gymId, locationName, studioName, stepper = null }) {
  if (!isMobile() || !modal) return;
  const title = modal.querySelector('.psycle-modal-header h4');
  if (title && titleText) title.textContent = titleText;
  const card = modal.querySelector('.psycle-modal-card');
  const header = card?.querySelector('.psycle-modal-header');
  if (!card || !header) return;
  let strip = card.querySelector(':scope > .psycle-bk-identity');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'psycle-bk-identity';
    header.insertAdjacentElement('afterend', strip);
  }
  const brand = gymBrand(gymId);
  const loc = trimLocation(locationName || '', brand.name);
  const studio = studioName ? displayStudioName(gymId, studioName) : '';
  const where = [loc, studio].filter(Boolean).join(' · ');
  strip.innerHTML = `${gymSquareChip(gymId)}<div class="psycle-bk-identity-text"><strong></strong><span></span></div>`;
  const txt = strip.querySelector('.psycle-bk-identity-text');
  txt.querySelector('strong').textContent = brand.name;
  txt.querySelector('span').textContent = where;
  upsertStepper(card, strip, stepper);
  watchBookingGuards(modal, gymId);
}

/** Two-step progress cue (spec section 8): only while a flow includes Step A. 'A' | 'A2' | 'B' | null (remove). */
function upsertStepper(card, strip, which) {
  let st = card.querySelector(':scope > .psycle-stepper');
  if (!which) { st?.remove(); return; }
  if (!st) {
    st = document.createElement('ol');
    st.className = 'psycle-stepper';
    strip.insertAdjacentElement('afterend', st);
  }
  const s1 = which === 'A' ? 'current' : 'complete';
  const s2 = which === 'B' ? 'current' : 'upcoming';
  st.setAttribute('aria-label', which === 'B' ? COPY.spotSetup.stepLabelB : COPY.spotSetup.stepLabelA);
  st.innerHTML = `<li class="is-${s1}"${s1 === 'current' ? ' aria-current="step"' : ''}><span class="n">${s1 === 'complete' ? '✓' : '1'}</span> ${COPY.spotSetup.stepYourSpots}</li>`
    + `<li class="is-${s2}"${s2 === 'current' ? ' aria-current="step"' : ''}><span class="n">2</span> ${COPY.spotSetup.stepBook}</li>`;
}

function classCardEl({ className, instructorName, instructorPhoto, startAt, zone, spotsLeft, gymId, releaseAt }) {
  const when = startAt ? formatInZone(startAt, zone) : null;
  const el = document.createElement('div');
  el.className = 'psycle-bk-classcard';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', COPY.bookingFlow.thisClass);
  const avatar = instructorName ? instructorAvatar(instructorName, gymId, instructorPhoto || null) : '';
  el.innerHTML = `
    <div class="psycle-bk-classcard-label"></div>
    <div class="psycle-bk-classcard-main">
      ${avatar}
      <div class="psycle-bk-classcard-text">
        <strong class="psycle-bk-class-name"></strong>
        <span class="psycle-bk-class-instructor"></span>
        <span class="psycle-bk-class-when"></span>
        <span class="psycle-bk-class-release" hidden></span>
      </div>
    </div>`;
  el.querySelector('.psycle-bk-classcard-label').textContent = COPY.bookingFlow.thisClass;
  el.querySelector('.psycle-bk-class-name').textContent = className || '';
  const ins = el.querySelector('.psycle-bk-class-instructor');
  if (instructorName) ins.textContent = formatCopyText(COPY.bookingFlow.withInstructor, { instructor: instructorName }); else ins.remove();
  const w = el.querySelector('.psycle-bk-class-when');
  if (when && when.time) {
    const left = Number.isFinite(spotsLeft) ? ` · ${formatCopyText(spotsLeft === 1 ? COPY.bookingFlow.spotLeft : COPY.bookingFlow.spotsLeft, { count: spotsLeft })}` : '';
    w.textContent = `${when.date}, ${when.timeLabel}${left}`;
  } else w.remove();
  const rel = el.querySelector('.psycle-bk-class-release');
  if (releaseAt) { rel.dataset.releaseAt = releaseAt; rel.hidden = false; paintRelease(rel); startTicker(); } else rel.remove();
  return el;
}

// Auto-Book release countdown (updates while a card is on screen; one shared timer).
let ticker = null;
function fmtCountdown(ms) {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : (h > 0 ? `${h}h ${mm}m` : `${Math.max(mm, 1)}m`);
}
function paintRelease(n) {
  const ms = new Date(n.dataset.releaseAt).getTime() - Date.now();
  n.textContent = ms > 0 ? formatCopyText(COPY.bookingFlow.opensIn, { countdown: fmtCountdown(ms) }) : COPY.bookingFlow.bookingOpen;
}
function tickReleases() {
  const nodes = document.querySelectorAll('.psycle-bk-class-release[data-release-at]');
  nodes.forEach(paintRelease);
  if (!nodes.length && ticker) { clearInterval(ticker); ticker = null; }
}
function startTicker() { if (!ticker) ticker = setInterval(tickReleases, 30000); }

/** "Set up spots" style banner (dismissible, persisted like the helper). */
export function bannerEl(id, text, actionText, onAction) {
  if (!isMobile() || helperDismissed(id)) return null;
  const el = document.createElement('div');
  el.className = 'psycle-bk-helper psycle-bk-banner';
  el.innerHTML = '<p></p><button type="button" class="psycle-btn psycle-bk-banner-action"></button><button type="button" class="psycle-bk-helper-x"></button>';
  el.querySelector('p').textContent = text;
  const act = el.querySelector('.psycle-bk-banner-action');
  act.textContent = actionText;
  act.onclick = onAction;
  const x = el.querySelector('.psycle-bk-helper-x');
  x.textContent = '×';
  x.setAttribute('aria-label', COPY.bookingFlow.dismissTip);
  x.onclick = () => { dismissHelper(id); el.remove(); };
  return el;
}

// ── offline / reconnect guards (spec section 5) ─────────────────────────────
const PRIMARY = '#btn-book-simple, #btn-save-autobook, #btn-submit-quickbook, #btn-book-any, #btn-save-simple-autobook, #btn-save-autobook-edit, #bk-edit-save';
function guardState(gymId) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'offline' };
  const link = (getLinkedGyms() || []).find((g) => String(g.gym_id ?? g.id) === String(gymId));
  if (link && link.status === 'needs_relogin') return { kind: 'relogin', gymName: gymBrand(gymId).name };
  return null;
}
function applyGuards(modal, gymId) {
  if (!modal.classList.contains('psycle-page')) return;
  const card = modal.querySelector('.psycle-modal-card');
  if (!card) return;
  const g = guardState(gymId);
  let n = card.querySelector(':scope > .psycle-bk-notice');
  if (!g) {
    n?.remove();
    modal.querySelectorAll('[data-bk-guard]').forEach((b) => { b.disabled = false; b.removeAttribute('data-bk-guard'); });
    return;
  }
  const key = g.kind + (g.gymName || '');
  if (!n || n.dataset.key !== key) {
    n?.remove();
    n = document.createElement('div');
    n.className = 'psycle-bk-notice';
    n.dataset.key = key;
    n.setAttribute('role', 'status');
    const t = document.createElement('span');
    t.textContent = g.kind === 'offline' ? COPY.bookingFlow.offline : formatCopyText(COPY.bookingFlow.reconnectGym, { gym: g.gymName });
    n.appendChild(t);
    if (g.kind === 'relogin') {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'psycle-btn psycle-bk-notice-action'; b.textContent = COPY.bookingFlow.reconnectAction;
      b.onclick = async () => {
        history.back();
        const s = await import('./settings.js');
        window.switchTab?.('settings');
        s.openGymSettings?.(gymId);
      };
      n.appendChild(b);
    }
    const anchor = card.querySelector(':scope > .psycle-stepper') || card.querySelector(':scope > .psycle-bk-identity') || card.querySelector(':scope > .psycle-modal-header');
    anchor.insertAdjacentElement('afterend', n);
  }
  modal.querySelectorAll(PRIMARY).forEach((b) => { if (!b.disabled) { b.disabled = true; b.setAttribute('data-bk-guard', '1'); } });
}

/** Keep the primary actions honest: disabled with a visible reason while offline or while the gym needs re-login. */
export function watchBookingGuards(modal, gymId) {
  if (!isMobile() || !modal) return;
  const run = () => applyGuards(modal, gymId);
  modal.__bkGuardRun = run;
  if (!modal.__bkGuardWired) {
    modal.__bkGuardWired = true;
    new MutationObserver(() => modal.__bkGuardRun?.()).observe(modal, { childList: true, subtree: true });
    window.addEventListener('online', () => modal.__bkGuardRun?.());
    window.addEventListener('offline', () => modal.__bkGuardRun?.());
    window.addEventListener('sweat:gyms-changed', () => modal.__bkGuardRun?.());
    window.addEventListener('sweat-gym-needs-relogin', () => modal.__bkGuardRun?.());
  }
  run();
}

function helperEl(id, text) {
  if (!text || helperDismissed(id)) return null;
  const el = document.createElement('div');
  el.className = 'psycle-bk-helper';
  el.innerHTML = '<p></p><button type="button" class="psycle-bk-helper-x"></button>';
  el.querySelector('p').textContent = text;
  const x = el.querySelector('button');
  x.textContent = '×';
  x.setAttribute('aria-label', COPY.bookingFlow.dismissTip);
  x.onclick = () => { dismissHelper(id); el.remove(); };
  return el;
}

/**
 * Helper (dismissible) + class card as one fragment, in the order helper -> class card -> map so the
 * card always sits directly on top of the map whether or not the helper is still showing.
 * Returns null above 768px.
 */
export function bookingContextEl(info, { helperId, helperText, helperOnly = false } = {}) {
  if (!isMobile()) return null;
  const frag = document.createDocumentFragment();
  const h = helperEl(helperId, helperText);
  if (h) frag.appendChild(h);
  if (helperOnly || !info) return h ? frag : null;
  frag.appendChild(classCardEl({ zone: zoneFor(info), ...info }));
  return frag;
}

/** Insert the context before an anchor element (or at the top of `body` with no anchor). */
export function mountBookingContext(body, anchor, info, opts) {
  const frag = bookingContextEl(info, opts);
  if (!frag || !body) return;
  body.querySelectorAll(':scope .psycle-bk-helper, :scope .psycle-bk-classcard').forEach((n) => n.remove());
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(frag, anchor);
  else body.prepend(frag);
}
