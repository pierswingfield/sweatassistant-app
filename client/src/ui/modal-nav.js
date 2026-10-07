// Shared mobile "modal -> full-screen page" helper (modal-to-fullscreen-spec, Batch 1).
//
// At <= 768px an opened modal becomes a page: it gets `.sa-page` (the CSS block in
// styles.css keys off that class, so un-wired modals are untouched), a history entry
// (hardware/iOS back closes it), a body scroll lock, dialog semantics, focus handling,
// Escape, and the visual-viewport height variable. On wider screens openPage/closePage
// reproduce the previous `display:flex` + `.show` contract exactly.

import { COPY } from '../copy.js';

const MQ = '(max-width: 768px)';
const HIDE_MS = 300;

const stack = []; // open pages, topmost last: { el, id, opts, opener, hideTimer }
const timers = new WeakMap();
let lockCount = 0;
let savedScrollY = 0;
let seq = 0;
let listening = false;
let pendingPops = 0; // history.back() calls we issued ourselves

export function isMobile() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MQ).matches;
}

export function openPageCount() { return stack.length; }

// ── scroll lock (counter based; iOS ignores overflow:hidden on body) ─────────
function lockScroll() {
  if (lockCount++ > 0) return;
  savedScrollY = window.scrollY || 0;
  const s = document.body.style;
  s.position = 'fixed';
  s.top = `-${savedScrollY}px`;
  s.width = '100%';
  document.body.classList.add('psycle-scroll-locked');
  document.documentElement.classList.add('psycle-scroll-locked'); // html must not scroll either
}
function unlockScroll() {
  if (lockCount === 0 || --lockCount > 0) return;
  const s = document.body.style;
  s.position = '';
  s.top = '';
  s.width = '';
  document.body.classList.remove('psycle-scroll-locked');
  document.documentElement.classList.remove('psycle-scroll-locked');
  window.scrollTo(0, savedScrollY);
}

// ── background inertness: only the topmost page is reachable ────────────────
function applyInert() {
  const pages = stack.filter((e) => !e.layer);
  const top = pages.length ? pages[pages.length - 1].el : null;
  for (const child of Array.from(document.body.children)) {
    if (/^(SCRIPT|STYLE|LINK)$/.test(child.tagName)) continue;
    if (child.querySelector?.('#psycle-toast-container') || child.id === 'psycle-toast-container') continue;
    if (child.classList?.contains('sa-overlap-modal') || child.classList?.contains('fr-sheet-overlay')) continue; // dialog layers sit above pages
    const inert = !!top && child !== top;
    if (inert) { child.setAttribute('inert', ''); child.dataset.saNavInert = '1'; }
    else if (child.dataset.saNavInert) { child.removeAttribute('inert'); delete child.dataset.saNavInert; }
  }
}

// ── visual viewport height (iOS keyboard) ───────────────────────────────────
function syncVvh() {
  // Track the VISUAL viewport (height and its offset from the layout viewport): with the iOS
  // keyboard up, the layout viewport does not shrink and the page is scrolled to reveal the
  // input, so a page pinned to the layout viewport leaves the app showing around the keyboard's
  // accessory bar. Pinning to the visual viewport keeps the page filling exactly what is visible.
  const vv = window.visualViewport;
  const h = vv ? `${Math.round(vv.height)}px` : '';
  const t = vv ? `${Math.round(vv.offsetTop)}px` : '';
  for (const e of stack) {
    if (!e.el) continue;
    if (h) { e.el.style.setProperty('--vvh', h); e.el.style.setProperty('--vvt', t); }
    else { e.el.style.removeProperty('--vvh'); e.el.style.removeProperty('--vvt'); }
  }
}

function onFocusIn(e) {
  const top = stack[stack.length - 1];
  if (!top || !top.el || !top.el.contains(e.target)) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    setTimeout(() => e.target.scrollIntoView?.({ block: 'center' }), 250);
  }
}

function onKeyDown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  // Layers (dialogs, sheets) own their keys unless they opt in to Escape.
  if (top.layer && !(e.key === 'Escape' && top.opts.escCloses)) return;
  if (e.key === 'Escape') { e.stopPropagation(); requestClose(top); return; }
  if (e.key !== 'Tab') return;
  const f = Array.from(top.el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
    .filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0]; const last = f[f.length - 1];
  const a = document.activeElement;
  if (e.shiftKey && (a === first || !top.el.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !top.el.contains(a))) { e.preventDefault(); first.focus(); }
}

function ensureListeners() {
  if (listening) return;
  listening = true;
  // Capture + registered at import: must run before main.js's tab-routing popstate handler.
  window.addEventListener('popstate', onPopState, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn);
  window.visualViewport?.addEventListener('resize', syncVvh);
  window.visualViewport?.addEventListener('scroll', syncVvh);
}

// ── teardown ────────────────────────────────────────────────────────────────
function hide(el, entry) {
  el.classList.remove('show');
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => {
    if (entry.remove) el.remove();
    else if (entry.hadInlineHidden) el.style.display = 'none';
    el.classList.remove('sa-page');
    el.style.removeProperty('--vvh');
    el.style.removeProperty('--vvt');
  }, HIDE_MS));
}

function teardown(entry) {
  const i = stack.indexOf(entry);
  if (i === -1) return;
  stack.splice(i, 1);
  if (entry.layer) {
    if (entry.opts.lock) unlockScroll();
    applyInert();
    try { entry.opts.onBack?.(); } catch (e) { console.error('[modal-nav] onBack failed', e); }
    return;
  }
  const { el } = entry;
  hide(el, entry);
  el.removeAttribute('aria-modal');
  el.removeAttribute('role');
  unlockScroll();
  applyInert();
  try { entry.opener?.focus?.({ preventScroll: true }); } catch (_) { /* opener gone */ }
  try { entry.opts.onClose?.(); } catch (e) { console.error('[modal-nav] onClose failed', e); }
}

// Retire a page that was replaced: same visual teardown as `teardown`, but no history or scroll-lock work.
function retire(entry) {
  const { el } = entry;
  hide(el, entry);
  el.removeAttribute('aria-modal');
  el.removeAttribute('role');
  try { entry.opts.onClose?.(); } catch (e) { console.error('[modal-nav] onClose failed', e); }
}

async function guardOk(entry) {
  if (!entry.opts.canClose) return true;
  try { return (await entry.opts.canClose()) !== false; } catch (_) { return true; }
}

// X / back button / Escape: guard, then pop our history entry (popstate tears down).
async function requestClose(entry, force = false) {
  if (!force && !(await guardOk(entry))) return;
  if (stack[stack.length - 1] === entry && history.state?.sweatNavId === entry.id) {
    pendingPops++;
    entry.skipGuard = true;
    history.back();
  } else {
    teardown(entry);
  }
}

async function onPopState(e) {
  if (pendingPops > 0) pendingPops--;
  const depth = history.state?.sweatNavDepth || 0;
  if (stack.length <= depth) return; // forward nav or unrelated pop: not ours
  e.sweatNavHandled = true;
  while (stack.length > depth) {
    const top = stack[stack.length - 1];
    if (!top.skipGuard && !(await guardOk(top))) {
      // Cancel the pop: put the entry back and leave the page open.
      history.pushState({ sweatNavId: top.id, sweatNavDepth: stack.length }, '');
      return;
    }
    teardown(top);
  }
}

if (typeof window !== 'undefined') ensureListeners();

// Single-step info pages get a fixed-bottom Close button (hidden by CSS above 768px, so desktop
// is unaffected even though the element persists on pre-built modals).
function ensureCloseFooter(el, entry) {
  const card = el.querySelector('.sa-modal-card, .sa-modal-content');
  if (!card) return;
  let foot = card.querySelector(':scope > .sa-modal-footer');
  if (!foot) {
    foot = document.createElement('div');
    foot.className = 'sa-modal-footer';
    foot.innerHTML = '<button type="button" class="psycle-btn sa-page-close"></button>';
    foot.firstChild.textContent = COPY.credits.closeModal;
    card.appendChild(foot);
  }
  foot.firstChild.onclick = () => requestClose(entry);
}

// ── public API ──────────────────────────────────────────────────────────────
// opts: { id, canClose(): bool|Promise<bool>, onClose(), back: bool, remove: bool }
export function openPage(el, opts = {}) {
  if (!el) return;
  clearTimeout(timers.get(el));
  // Remembered per element: a reopen during the 300 ms hide window sees display:flex, not 'none'.
  if (el.style.display === 'none') el.__navStartsHidden = true;
  const hadInlineHidden = !!el.__navStartsHidden;
  if (el.style.display === 'none') el.style.display = 'flex';

  if (!isMobile()) {
    setTimeout(() => el.classList.add('show'), 10);
    // Desktop: callers' own close handlers keep working, untouched.
    return;
  }

  const existing = stack.find((s) => s.el === el);
  if (existing) { existing.opts = opts; return; } // content swapped under an open page
  ensureListeners();
  const id = opts.id || `page-${++seq}`;
  const entry = { el, id, opts, opener: document.activeElement, hadInlineHidden, remove: !!opts.remove, skipGuard: false };
  // opts.replaceEl: take over the history slot of an open page (a finished step) instead of
  // stacking on it, so Back from the new page leaves the whole flow. The old page is retired
  // without touching history; scroll lock and the original opener carry over.
  const replacing = opts.replaceEl ? stack.find((s2) => s2.el === opts.replaceEl && !s2.layer) : null;
  if (replacing) {
    const idx = stack.indexOf(replacing);
    entry.opener = replacing.opener;
    stack[idx] = entry;
    retire(replacing);
  } else {
    stack.push(entry);
  }
  el.classList.add('sa-page');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  const title = el.querySelector('.sa-modal-header h3, .sa-modal-header h4, [data-nav-title]');
  if (title) {
    if (!title.id) title.id = `${id}-title`;
    el.setAttribute('aria-labelledby', title.id);
    title.setAttribute('tabindex', '-1');
  }
  if (opts.closeFooter) ensureCloseFooter(el, entry);
  if (replacing) {
    history.replaceState({ sweatNavId: id, sweatNavDepth: stack.indexOf(entry) + 1 }, '');
  } else {
    history.pushState({ sweatNavId: id, sweatNavDepth: stack.length }, '');
    lockScroll();
  }
  applyInert();
  syncVvh();
  setTimeout(() => {
    if (!stack.includes(entry)) return; // closed again within the first frame
    el.classList.add('show');
    const field = opts.focusField ? el.querySelector(opts.focusField) : null;
    (field || title)?.focus({ preventScroll: true });
  }, 10);

  const closeBtn = el.querySelector('.sa-modal-close-btn, [data-nav-close]');
  if (closeBtn) {
    if (opts.back) closeBtn.dataset.nav = 'back';
    else delete closeBtn.dataset.nav;
  }
  if (!el.__navWired) {
    el.__navWired = true;
    // Capture phase: runs before the call site's own (desktop-style) handlers.
    el.addEventListener('click', (ev) => {
      const e2 = stack.find((s) => s.el === el);
      if (!e2) return;
      if (ev.target.closest('.sa-modal-close-btn, [data-nav-close]') || ev.target.classList.contains('sa-modal-overlay')) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        // A sub-step layer above this page (e.g. an in-page editor) owns the header Back arrow.
        const top = stack[stack.length - 1];
        requestClose(top && top.layer && top.opts.captureHeader ? top : e2);
      }
    }, true);
  }
}

// A non-page layer (confirm dialog, bottom sheet): gets a history entry so hardware/iOS back
// dismisses it, and optionally locks body scroll. Mobile only; a no-op handle elsewhere.
// opts: { id, onBack(), lock, escCloses, canClose(), captureHeader }.  Returns { release() } for programmatic close.
export function pushLayer(opts = {}) {
  if (!isMobile()) return { release() {} };
  const id = opts.id || `layer-${++seq}`;
  const entry = { el: null, id, opts, layer: true, skipGuard: false };
  stack.push(entry);
  history.pushState({ sweatNavId: id, sweatNavDepth: stack.length }, '');
  if (opts.lock) lockScroll();
  return {
    // Programmatic dismissal (work finished): no guard.
    release() {
      if (!stack.includes(entry)) return;
      if (stack[stack.length - 1] === entry && history.state?.sweatNavId === id) {
        pendingPops++; entry.skipGuard = true; history.back();
      } else teardown(entry);
    },
    // User-initiated dismissal (header Back): runs opts.canClose first.
    close() { return stack.includes(entry) ? requestClose(entry) : undefined; },
  };
}

// Programmatic close (after a successful save). Returns true when a mobile page was
// closed (history entry popped, guard skipped); false means the caller should run its
// own desktop teardown, which is left exactly as it was.
export function closePage(el, { force = true } = {}) {
  const entry = el && stack.find((s) => s.el === el);
  if (!entry) return false;
  requestClose(entry, force);
  return true;
}

// Test hook.
export function _resetForTests() {
  stack.length = 0; lockCount = 0; pendingPops = 0; seq = 0;
}
