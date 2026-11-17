// Shared button interaction system (DESIGN.md §6.5.1).
//
// Two pieces, both app-wide:
//
// 1. installPressFeedback(): one passive, document-level pointer listener that adds
//    `.is-pressed` to the pressed control the instant the finger lands and holds it for a
//    short minimum, so even a fast tap shows a press (iOS's :active is unreliable and too
//    brief). The look (scale + dim, spring release) is pure CSS on `.is-pressed` / `:active`.
//
// 2. runButton(btn, fn, opts): wraps an async action on a button WITHOUT changing the
//    action. Single-flight (a second tap while pending returns the same promise),
//    aria-busy, an inline spinner that keeps the button's width (label hidden, not
//    removed), a minimum visible pending time so instant answers don't flicker (it only
//    holds the visual, never the work), then a check-mark morph on success or a gentle
//    shake on error before the label returns.
//
// The action may rewrite the button's label (existing flows set "Booking…" etc.):
// the indicator lives in its own child, re-attached if the label rewrite removes it.

const BUSY = 'abtn-busy';
const SUCCESS = 'abtn-success';
const ERROR = 'abtn-error';
const SETTLE = 'abtn-settle';
const IND = 'abtn-ind';

const inflight = new WeakMap();

const INDICATOR_SVG = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">'
  + '<circle class="abtn-ring" cx="12" cy="12" r="9"></circle>'
  + '<path class="abtn-check" d="M6.5 12.5l3.6 3.6L17.6 8.4"></path>'
  + '</svg>';

const delay = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function reducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

// ---- aria-live: one polite region shared by every button ----
let liveEl = null;
export function announce(text) {
  if (!text || typeof document === 'undefined') return;
  if (!liveEl || !liveEl.isConnected) {
    liveEl = document.createElement('div');
    liveEl.className = 'abtn-live';
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(liveEl);
  }
  liveEl.textContent = '';
  // A fresh text node after a tick so repeated identical messages are still read.
  setTimeout(() => { if (liveEl) liveEl.textContent = text; }, 30);
}

function ensureIndicator(btn) {
  let ind = btn.querySelector(`:scope > .${IND}`);
  if (!ind) {
    ind = document.createElement('span');
    ind.className = IND;
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = INDICATOR_SVG;
    btn.appendChild(ind);
  }
  return ind;
}

// Visual state on/off. Captures the button's own text colour for the indicator, locks its
// width (labels such as "Book" -> "Booking…" must not resize the row), and hides the label
// with an inline !important colour, which beats the stylesheet's own !important variants.
// `snap` is the button as it was when tapped: flows often disable it and swap its label in the
// same tick, and a delayed spinner must still use the original colour and width. Width is the
// layout width (offsetWidth), never the bounding box, which shrinks while the press scale runs.
function snapshot(btn) {
  const cs = getComputedStyle(btn);
  const w = btn.offsetWidth || btn.getBoundingClientRect().width;
  return { color: cs.color, width: w, styleWidth: btn.style.width, styleMinWidth: btn.style.minWidth };
}
// Hold the tapped width from the first frame, before the flow swaps the label.
function holdWidth(btn, snap) {
  if (snap && snap.width > 0) { btn.style.width = `${snap.width}px`; btn.style.minWidth = `${snap.width}px`; }
}
function releaseWidth(btn, snap) {
  if (!snap || btn._abtn) return;
  btn.style.width = snap.styleWidth; btn.style.minWidth = snap.styleMinWidth;
}
function lockVisual(btn, snap = snapshot(btn)) {
  if (btn._abtn) return btn._abtn;
  const cs = getComputedStyle(btn);
  const rect = { width: snap.width };
  const saved = {
    color: btn.style.getPropertyValue('color'),
    colorPriority: btn.style.getPropertyPriority('color'),
    width: snap.styleWidth ?? btn.style.width,
    minWidth: snap.styleMinWidth ?? btn.style.minWidth,
    position: btn.style.position,
    observer: null,
  };
  btn.style.setProperty('--abtn-fg', snap.color);
  if (rect.width > 0) {
    btn.style.width = `${rect.width}px`;
    btn.style.minWidth = `${rect.width}px`;
  }
  if (cs.position === 'static') btn.style.position = 'relative';
  btn.style.setProperty('color', 'transparent', 'important');
  ensureIndicator(btn);
  if (typeof MutationObserver !== 'undefined') {
    saved.observer = new MutationObserver(() => {
      if (btn.isConnected && btn._abtn) ensureIndicator(btn);
    });
    saved.observer.observe(btn, { childList: true });
  }
  btn._abtn = saved;
  return saved;
}

function unlockVisual(btn) {
  const saved = btn._abtn;
  if (!saved) return;
  saved.observer?.disconnect();
  btn.classList.remove(BUSY, SUCCESS);
  btn.querySelector(`:scope > .${IND}`)?.remove();
  if (saved.color) btn.style.setProperty('color', saved.color, saved.colorPriority);
  else btn.style.removeProperty('color');
  btn.style.width = saved.width;
  btn.style.minWidth = saved.minWidth;
  btn.style.position = saved.position;
  btn.style.removeProperty('--abtn-fg');
  delete btn._abtn;
}

function playError(btn, ms) {
  if (!btn.isConnected) return Promise.resolve();
  btn.classList.remove(ERROR);
  void btn.offsetWidth; // restart the animation on a repeat failure
  btn.classList.add(ERROR);
  return delay(reducedMotion() ? 0 : ms).then(() => btn.classList.remove(ERROR));
}

/**
 * Show the success check on a button (or its re-rendered replacement), then let the label
 * return. Used by runButton, and directly when an action re-renders its own button.
 */
export async function flashSuccess(btn, { ms = 650 } = {}) {
  if (!btn || !btn.isConnected || btn._abtn) return;
  lockVisual(btn);
  btn.classList.add(SUCCESS);
  await delay(ms);
  unlockVisual(btn);
  btn.classList.add(SETTLE);
  setTimeout(() => btn.classList.remove(SETTLE), 420);
}

/**
 * Resolve once `el` has left the screen (the next step replaced it, or its container was
 * hidden), or after timeoutMs.
 */
export function waitUntilDetached(el, timeoutMs = 5000) {
  const gone = () => !el || !el.isConnected || (typeof el.getClientRects === 'function' && el.getClientRects().length === 0 && el.offsetWidth === 0 && !isJsdom());
  return new Promise((resolve) => {
    if (gone()) { resolve(true); return; }
    let done = false;
    const finish = (v) => { if (done) return; done = true; obs?.disconnect(); clearTimeout(t); resolve(v); };
    const obs = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { if (gone()) finish(true); }) : null;
    obs?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    const t = setTimeout(() => finish(gone()), timeoutMs);
  });
}
// jsdom has no layout (every element reports zero size), so only connection counts there.
function isJsdom() { return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || ''); }

/**
 * Resolve once `btn` is no longer a disabled, attached button: it was replaced by a re-render
 * or re-enabled (a failed flow restores it). For flows that keep the old button disabled until
 * a later background refresh re-renders it.
 */
export function waitUntilSettled(btn, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const settled = () => !btn || !btn.isConnected || !btn.disabled;
    if (settled()) { resolve(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; obs?.disconnect(); clearTimeout(t); resolve(); };
    const obs = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => { if (settled()) finish(); }) : null;
    obs?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    const t = setTimeout(finish, timeoutMs);
  });
}

/**
 * Run `fn` as the button's action.
 *
 * opts:
 *   minPendingMs  (350) once the spinner is visible it stays at least this long
 *   showDelayMs   (0)   wait this long before showing the spinner; an action that
 *                       settles sooner (e.g. arming a two-tap confirm) shows none
 *   success       (true) play the check-mark morph on success (false: just settle)
 *   successMs     (550)
 *   errorMs       (420)
 *   successLabel / errorLabel  announced via aria-live when given
 *   isError(result) -> bool   treat a resolved result as a failure (default: result === false)
 *   isSuccess(result) -> bool play the check only when true (else settle quietly)
 *   settle()      -> Element|Element[]|null  the button(s) that replaced `btn` when the
 *                       action re-rendered it; they get the success morph instead
 *   rethrow       (true) rethrow a thrown error after the error state plays
 *   indicator     (true) false: aria-busy + single-flight only (icon buttons with their own look)
 *   hapticOutcome (false) for flows that report their own outcome through haptics.js and
 *                       swallow errors into a toast: an 'error' haptic during the run is a
 *                       failure; a check plays only after a 'success'/'warning' haptic or a
 *                       re-render (settle), otherwise the button just settles (e.g. it opened
 *                       a modal or armed a confirm)
 */
export function runButton(btn, fn, opts = {}) {
  if (!btn) return Promise.resolve(fn ? fn() : undefined);
  const existing = inflight.get(btn);
  if (existing) return existing;
  const {
    minPendingMs = 350, showDelayMs = 0, success = true, successMs = 550, errorMs = 420,
    successLabel, errorLabel, isError = (r) => r === false, settle, rethrow = true, indicator = true,
    hapticOutcome = false, isSuccess,
  } = opts;

  const snap = indicator ? snapshot(btn) : null;
  holdWidth(btn, snap);
  btn.setAttribute('aria-busy', 'true');
  let shownAt = null;
  const show = () => {
    if (shownAt != null || !indicator || !btn.isConnected) return;
    lockVisual(btn, snap);
    btn.classList.add(BUSY);
    shownAt = now();
  };
  let showTimer = null;
  if (showDelayMs > 0) showTimer = setTimeout(show, showDelayMs); else show();

  const seen = new Set();
  const onHaptic = (e) => { if (e?.detail?.type) seen.add(e.detail.type); };
  const listen = hapticOutcome && typeof window !== 'undefined';
  if (listen) window.addEventListener('app-haptic', onHaptic);

  // Call synchronously: a handler that does its work in the same tick (arming a two-tap
  // confirm, a validation message, closing a page) needs no async state and must not lock
  // the button against an immediate next tap.
  let ret; let syncThrown = null;
  try { ret = fn(); } catch (err) { syncThrown = err || new Error('failed'); }
  if (!(ret && typeof ret.then === 'function')) {
    if (listen) window.removeEventListener('app-haptic', onHaptic);
    clearTimeout(showTimer);
    unlockVisual(btn);
    releaseWidth(btn, snap);
    btn.removeAttribute('aria-busy');
    const failed = syncThrown != null || isError(ret) || (hapticOutcome && seen.has('error'));
    if (failed) { if (errorLabel) announce(errorLabel); if (indicator) playError(btn, errorMs); }
    if (syncThrown && rethrow) return Promise.reject(syncThrown);
    return Promise.resolve(syncThrown ? undefined : ret);
  }

  const p = (async () => {
    let result; let thrown = null;
    try { result = await ret; } catch (err) { thrown = err || new Error('failed'); }
    finally { if (listen) window.removeEventListener('app-haptic', onHaptic); }
    clearTimeout(showTimer);

    if (shownAt != null) await delay(minPendingMs - (now() - shownAt));
    const failed = thrown != null || isError(result) || (hapticOutcome && seen.has('error'));
    const confirmed = (!hapticOutcome || seen.has('success') || seen.has('warning'))
      && (typeof isSuccess !== 'function' || !!isSuccess(result));

    try {
      if (failed) {
        unlockVisual(btn);
        if (errorLabel) announce(errorLabel);
        if (indicator && (shownAt != null || btn.isConnected)) await playError(btn, errorMs);
      } else {
        if (successLabel) announce(successLabel);
        const replaced = confirmed && typeof settle === 'function' ? [].concat(settle() || []).filter((el) => el && el !== btn) : [];
        if (replaced.length) {
          unlockVisual(btn);
          if (success && indicator) await Promise.all(replaced.map((el) => flashSuccess(el, { ms: Math.min(successMs, 520) })));
        } else if (success && confirmed && indicator && btn.isConnected && shownAt != null) {
          btn.classList.remove(BUSY);
          btn.classList.add(SUCCESS);
          await delay(successMs);
          unlockVisual(btn);
          btn.classList.add(SETTLE);
          setTimeout(() => btn.classList.remove(SETTLE), 420);
        } else {
          unlockVisual(btn);
        }
      }
    } finally {
      unlockVisual(btn);
      releaseWidth(btn, snap);
      btn.removeAttribute('aria-busy');
      inflight.delete(btn);
    }
    if (thrown && rethrow) throw thrown;
    return thrown ? undefined : result;
  })();
  inflight.set(btn, p);
  return p;
}

/**
 * An onclick handler that runs `fn(event)` through runButton on the clicked button. For flows
 * that report their own outcome (toasts/haptics) the defaults suit: spinner only past 120 ms,
 * a check only after a success signal, never a rethrow into the event loop.
 */
export function asyncHandler(fn, opts = {}) {
  return (e) => {
    const btn = e?.currentTarget;
    return runButton(btn, () => fn(e), { showDelayMs: 120, hapticOutcome: true, rethrow: false, ...opts });
  };
}

/** True while runButton owns this button. */
export function isButtonBusy(btn) { return !!(btn && inflight.has(btn)); }

/**
 * Onboarding-style "press, then wait for the next screen": runs `advance` (which resolves the
 * step) and keeps the button pressed-and-pending until the button leaves the page, so the
 * member sees their tap land while the next step loads (some steps fetch before rendering).
 */
export function pressAndAdvance(btn, advance, { timeoutMs = 6000, ...opts } = {}) {
  return runButton(btn, async () => {
    await advance();
    await waitUntilDetached(btn, timeoutMs);
  }, { success: false, showDelayMs: 140, ...opts });
}

// ---- Press feedback ----------------------------------------------------------------
export const PRESSABLE = 'button, [role="button"], a.app-btn-primary, a.app-btn-secondary, a.app-btn, input[type="button"], input[type="submit"]';
const PRESS_MIN_MS = 110;
const MOVE_CANCEL_PX = 10;
let installed = false;

export function installPressFeedback(root = typeof document !== 'undefined' ? document : null) {
  if (!root || installed) return () => {};
  installed = true;
  let active = null; let startX = 0; let startY = 0; let startT = 0; let releaseTimer = null;

  const release = (immediate = false) => {
    const el = active; active = null;
    if (!el) return;
    const wait = immediate ? 0 : Math.max(0, PRESS_MIN_MS - (now() - startT));
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      el.classList.remove('is-pressed');
      // One-shot spring back to rest (CSS animation, so no component transition is overridden).
      el.classList.remove('is-released');
      void el.offsetWidth;
      el.classList.add('is-released');
      clearTimeout(el._abtnRel);
      el._abtnRel = setTimeout(() => el.classList.remove('is-released'), 460);
    }, wait);
  };
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    const el = e.target?.closest?.(PRESSABLE);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true') return;
    if (active && active !== el) active.classList.remove('is-pressed');
    clearTimeout(releaseTimer);
    active = el; startX = e.clientX; startY = e.clientY; startT = now();
    el.classList.add('is-pressed');
  };
  const onMove = (e) => {
    if (!active) return;
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL_PX || Math.abs(e.clientY - startY) > MOVE_CANCEL_PX) release(true);
  };
  const onUp = () => release(false);
  const onCancel = () => release(true);
  const opt = { passive: true, capture: true };
  root.addEventListener('pointerdown', onDown, opt);
  root.addEventListener('pointermove', onMove, opt);
  root.addEventListener('pointerup', onUp, opt);
  root.addEventListener('pointercancel', onCancel, opt);
  root.addEventListener('scroll', onCancel, opt);
  // An empty touchstart listener is what makes WebKit honour :active at all.
  root.addEventListener('touchstart', () => {}, { passive: true });
  return () => {
    installed = false;
    root.removeEventListener('pointerdown', onDown, opt);
    root.removeEventListener('pointermove', onMove, opt);
    root.removeEventListener('pointerup', onUp, opt);
    root.removeEventListener('pointercancel', onCancel, opt);
    root.removeEventListener('scroll', onCancel, opt);
  };
}
