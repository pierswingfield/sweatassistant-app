// Step A of the spot-map booking flow (spotmap-booking-flow-spec, Batch 2): one-time, per-studio
// "preferred spots" setup, as its own mobile page, separate from booking a class (Step B).
//
//   A0 intro  ->  A1 editor (in-page, history layer)  ->  A2 saved  ->  Step B (replaces this page)
//
// History: A0 is entry 1; A1 is a pushed layer (Back returns to A0); A1 save pops that layer and shows
// A2 on the same page; Continue / Choose a spot for now hand the page's history slot to Step B
// (replacePage semantics),
// so the finished steps never remain in the stack and Back from Step B leaves the whole flow.

import { COPY, formatCopyText } from '../copy.js';
import { api } from '../api.js';
import { openPage, pushLayer, closePage } from './modal-nav.js';
import { applyBookingChrome } from './booking-chrome.js';
import { gymLogoBanner, trimLocation, displayStudioName, gymBrand } from './cards.js';
import { renderStudioFloorPlan } from './spotmap.js';
import { bookingContextEl } from './booking-chrome.js';

// Deferring setup is remembered for this session only; it is not a saved studio preference.
const deferred = new Set();
export const setupKey = (gymId, studioId) => `${gymId || ''}:${studioId || ''}`;
export const setupDeferred = (gymId, studioId) => deferred.has(setupKey(gymId, studioId));
export function markSetupDeferred(gymId, studioId) { deferred.add(setupKey(gymId, studioId)); }

const previewSvg = `
<svg class="app-setup-preview" viewBox="0 0 200 84" aria-hidden="true" focusable="false">
  ${[0, 1, 2].map((r) => [0, 1, 2, 3, 4].map((c) => `<rect x="${14 + c * 36}" y="${10 + r * 24}" width="24" height="18" rx="5" class="pv-spot"/>`).join('')).join('')}
  ${[[1, 0, 1], [2, 1, 2], [0, 2, 3]].map(([c, r, n]) => `<g><rect x="${14 + c * 36}" y="${10 + r * 24}" width="24" height="18" rx="5" class="pv-pick"/><text x="${26 + c * 36}" y="${23 + r * 24}" text-anchor="middle" class="pv-n">${n}</text></g>`).join('')}
</svg>`;

/**
 * @param {object} args
 * @param {object} args.event        normalized event (gymId, studioId, studioName, locationName, name, ...)
 * @param {string} args.className    display class name, for the Continue button
 * @param {Function} args.onSaved    (slots, rows) => void, keep caller caches in step with the save
 * @param {Function} args.onContinue (pageEl, {slots, rows}) => void, open Step B in this page's slot
 * @param {Function} args.onChooseForNow (pageEl) => void; defer map setup and choose spots for this class only
 */
export function spotSetupHelperText(rowGroups, slots = []) {
  const hasSeveralRows = new Set(slots.map((slot) => slot.y)).size > 1;
  return rowGroups && hasSeveralRows
    ? `${COPY.bookingFlow.helperSetup} ${COPY.bookingFlow.helperSetupRows}`
    : COPY.bookingFlow.helperSetup;
}

// Step B takes over Step A's history slot. A completed Quick-Book then closes
// the booking page instead of revealing the saved confirmation page underneath.
export function spotSetupBookingOptions(options, pageEl, saved) {
  const baseOptions = { ...options };
  delete baseOptions.backToSetup;
  return {
    ...baseOptions,
    overlapChecked: true,
    setupDone: true,
    savedPrefs: saved || null,
    setupFlow: true,
    replaceEl: pageEl,
  };
}

export function openSpotSetup({ event, className, onSaved, onContinue, onChooseForNow, initialStep = 'intro', initialPrefs = null, rowGroups = false }) {
  const gymId = event.gymId;
  const brand = gymBrand(gymId);
  const studioName = displayStudioName(gymId, event.studioName || '') || event.studioName || COPY.spotSelection.thisStudio;
  const where = [trimLocation(event.locationName || '', brand.name), studioName].filter(Boolean).join(' · ');

  const el = document.createElement('div');
  el.id = 'app-spot-setup';
  el.className = 'app-modal app-setup-page';
  el.style.display = 'flex';
  el.innerHTML = `
    <div class="app-modal-overlay"></div>
    <div class="app-modal-card">
      <div class="app-modal-header">
        <h4 data-nav-title></h4>
        <button type="button" class="app-modal-close-btn" data-nav-close aria-label="${COPY.credits.closeModal}">&times;</button>
      </div>
      <div class="app-modal-body app-setup-body"></div>
      <div class="app-modal-footer app-setup-footer"></div>
    </div>`;
  document.body.appendChild(el);
  const body = el.querySelector('.app-setup-body');
  const footer = el.querySelector('.app-setup-footer');
  const closeBtn = el.querySelector('.app-modal-close-btn');
  let layer = null;
  let after = null;       // what to do once the A1 layer has finished popping
  let saved = null;       // { slots, rows } once saved

  // The "1 Your spots / 2 Book class" cue only makes sense when a class follows (className set).
  // Onboarding and Settings open this with no class, so there is no booking step to show.
  const chrome = (stepper) => applyBookingChrome(el, {
    titleText: COPY.spotSetup.title, gymId, locationName: event.locationName, studioName: event.studioName,
    stepper: className ? stepper : null,
  });
  const btn = (cls, text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = onClick;
    return b;
  };
  const setFooter = (...nodes) => { footer.replaceChildren(...nodes); };
  const setHeaderMode = (back) => { if (back) closeBtn.dataset.nav = 'back'; else delete closeBtn.dataset.nav; };

  // ── A0: intro ─────────────────────────────────────────────────────────────
  const showA0 = () => {
    setHeaderMode(true);
    chrome('A');
    body.innerHTML = `
      <div class="app-setup-inner">
        <div class="app-setup-logo">${gymLogoBanner(gymId)}</div>
        <div class="app-setup-where"></div>
        ${previewSvg}
        <p class="app-setup-eyebrow">${COPY.spotSetup.eyebrow}</p>
        <h2 class="app-setup-headline">${COPY.spotSetup.headline}</h2>
        <ul class="app-setup-points">
          <li class="p1"></li><li>${COPY.spotSetup.point2}</li><li>${COPY.spotSetup.point3}</li>
        </ul>
        <p class="app-setup-reassure">${COPY.spotSetup.reassure}</p>
      </div>`;
    body.querySelector('.app-setup-where').textContent = where;
    body.querySelector('.p1').textContent = formatCopyText(COPY.spotSetup.point1, { studio: studioName });
    setFooter(
      btn('app-btn primary app-setup-primary', COPY.spotSetup.choose, () => showA1()),
      ...(className ? [btn('app-setup-link', COPY.spotSetup.chooseForNow, () => {
        markSetupDeferred(gymId, event.studioId);
        onChooseForNow?.(el);
      })] : []),
    );
  };

  // ── A1: editor (an in-page step with its own history entry) ───────────────
  const showA1 = async () => {
    chrome('A');
    setHeaderMode(true);
    layer = pushLayer({
      id: 'spot-setup-a1', captureHeader: true,
      canClose: () => !body.querySelector('[data-spotmap-root]')?.__isDirty?.() || confirm(COPY.spotSetup.discardConfirm),
      onBack: () => {
        layer = null;
        const next = after; after = null;
        if (next) next();
        else if (initialStep === 'editor') closePage(el);
        else showA0();
      },
    });
    body.innerHTML = `<div class="app-setup-loading"><div class="app-spinner"></div></div>`;
    setFooter();
    let slots, objects;
    try {
      ({ slots, objects } = await api.getStudioLayout(event.studioId, gymId));
    } catch (err) {
      body.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'app-setup-error';
      msg.textContent = COPY.spotSetup.loadFailed;
      body.appendChild(msg);
      setFooter(btn('app-btn primary app-setup-primary', COPY.spotSetup.retry, () => { after = () => showA1(); layer?.release(); }));
      return;
    }
    if (!slots?.length) { // no map after all: nothing to set up; carry on without prefs
      body.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'app-setup-error';
      msg.textContent = COPY.spotSetup.loadFailed;
      body.appendChild(msg);
      setFooter(btn('app-btn primary app-setup-primary', COPY.spotSetup.retry, () => {
        after = () => showA1();
        layer?.release();
      }));
      return;
    }
    body.innerHTML = '<div id="app-setup-editor"></div>';
    const editor = body.querySelector('#app-setup-editor');
    const count = document.createElement('div');
    count.className = 'app-setup-count';
    const reason = document.createElement('div');
    reason.className = 'app-setup-reason';
    const errBox = document.createElement('div');
    errBox.className = 'app-setup-error';
    errBox.hidden = true;
    const saveBtn = btn('app-btn primary app-setup-primary', COPY.spotSetup.save, () => save());
    setFooter(errBox, count, reason, saveBtn);

    const refreshFooter = (n) => {
      count.textContent = n === 0 ? COPY.spotSetup.none : (n === 1 ? COPY.spotSetup.one : formatCopyText(COPY.spotSetup.many, { count: n }));
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      saveBtn.disabled = n === 0 || offline;
      reason.textContent = offline ? COPY.spotSetup.offline : (n === 0 ? COPY.spotSetup.needOne : '');
    };
    const selection = () => editor.__getSelection?.() || { slots: [], rows: [] };

    const persist = async (slotsOut, rowsOut) => {
      await api.updateStudioPreferences(event.studioId, { preferredSlots: slotsOut, preferredRows: rowsOut }, gymId);
    };
    const save = async () => {
      const { slots: s, rows: r } = selection();
      if (!s.length && !r.length) return;
      errBox.hidden = true;
      saveBtn.disabled = true; saveBtn.textContent = COPY.spotSetup.saving;
      try {
        await persist(s, r);
      } catch (_) {
        errBox.textContent = COPY.spotSetup.saveFailed; errBox.hidden = false;
        saveBtn.disabled = false; saveBtn.textContent = COPY.spotSetup.retry;   // stay here, selection kept
        return;
      }
      saved = { slots: s, rows: r };
      onSaved?.(s, r);
      after = () => showA2();
      layer?.release();
    };
    const seedSlots = initialPrefs?.preferredSlots || [];
    const seedRows = rowGroups ? (initialPrefs?.preferredRows || []) : [];
    renderStudioFloorPlan(editor, slots, seedSlots, seedRows, () => {}, {
      rowGroups, layoutObjects: objects || [], hideActions: true, hideEditHint: true,
      onSelectionChange: (s, r) => refreshFooter(s.length + r.length),
      aboveMap: () => bookingContextEl(null, { helperId: 'spotmap-setup', helperText: spotSetupHelperText(rowGroups, slots), helperOnly: true }),
    });
  };

  // ── A2: saved confirmation (terminal: X closes the flow) ──────────────────
  const showA2 = () => {
    setHeaderMode(false);
    chrome('A2');
    body.innerHTML = `
      <div class="app-setup-inner app-setup-done">
        <div class="app-setup-check" aria-hidden="true">✓</div>
        <h2 class="app-setup-headline">${COPY.spotSetup.savedTitle}</h2>
        <p class="app-setup-reassure"></p>
      </div>`;
    body.querySelector('.app-setup-reassure').textContent = formatCopyText(COPY.spotSetup.savedBody, { studio: studioName });
    setFooter(
      btn('app-btn primary app-setup-primary', className ? formatCopyText(COPY.spotSetup.continueTo, { className }).trim() : COPY.settings.done, () => onContinue?.(el, saved)),
      btn('app-setup-link', COPY.spotSetup.editSpots, () => showA1()),
    );
    const h = body.querySelector('.app-setup-headline'); h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true });
  };

  openPage(el, { id: 'spot-setup', remove: true });
  if (initialStep === 'editor') showA1(); else showA0();
  return el;
}
