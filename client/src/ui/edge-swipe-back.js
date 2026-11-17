// The ONE left-edge swipe-back gesture (iOS standalone PWA only, i.e. nav mode 'flat').
//
// In flat mode history never grows, so the system edge swipe has nothing to go back to and cannot
// compete; this gesture is the only back. It drags the current level (the top modal-nav page, the
// Settings pane, the Auto-Book page or the Team page) with the finger, commits past a third of the
// width or on a flick, and then calls nav.back() so every level uses the same path as the header
// Back button. A level with an unsaved-changes guard springs back first and asks via the guard.
//
// Elsewhere (Safari tab, Android, desktop) the browser/OS owns edge swipes and history is kept in
// step with the stack (nav-controller 'sync' mode), so nothing here runs.
import { nav, isMobileViewport } from '../nav-controller.js';
import { shouldCommit, classifyMove } from '../nav-stack.js';
import { isScrollBusy } from './scroll-state.js';
import { haptic } from './haptics.js';
import { topPageEl, belowTopPageEl } from './modal-nav.js';

/** Width of the left zone that starts a back swipe. Shared with the timetable day-swipe. */
export const EDGE_PX = 24;
const COMMIT_FRACTION = 0.35;

let active = false;
/** True while a touch that began in the edge zone is being tracked. Other horizontal gestures must ignore it. */
export function isEdgeSwipeActive() { return active; }

function reduceMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

/** The element that follows the finger for the current top level, or null (layers, timetable...). */
export function surfaceFor(top) {
  if (!top) return null;
  if (top.kind === 'page') return topPageEl();
  if (top.kind === 'layer') return null;
  const key = top.key || '';
  if (key.startsWith('settings:')) return document.querySelector('.app-settings-content');
  if (key === 'tab:auto-book') return document.getElementById('app-panel-auto-book');
  if (key.startsWith('team:')) return document.querySelector('#app-teams-root .tm-team-page');
  return null;
}

function eligible() {
  if (nav.mode !== 'flat' || !isMobileViewport() || !nav.canGoBack()) return false;
  const onb = document.getElementById('app-onboarding-container');
  if (onb && onb.style.display !== 'none') return false;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && window.visualViewport && window.visualViewport.height < window.innerHeight * 0.85) return false; // keyboard open
  return true;
}

export function initEdgeSwipeBack() {
  if (initEdgeSwipeBack.done || typeof document === 'undefined') return;
  initEdgeSwipeBack.done = true;
  if (nav.mode === 'flat') document.documentElement.classList.add('nav-flat');

  let s = null; // { sx, sy, st, dx, locked, el, under, w, raf, crossed, top }

  const reset = (el, under) => {
    for (const n of [el, under]) {
      if (!n) continue;
      n.style.removeProperty('transition'); n.style.transform = ''; n.style.willChange = ''; n.style.boxShadow = '';
    }
    document.documentElement.classList.remove('nav-swiping');
  };

  const paint = () => {
    if (!s) return;
    s.raf = 0;
    const { el, under, dx, w } = s;
    const p = Math.min(1, Math.max(0, dx / w));
    if (el) el.style.transform = `translate3d(${dx}px,0,0)`;
    if (under) under.style.transform = `translate3d(${-30 + 30 * p}%,0,0)`;
  };

  const detach = () => {
    document.removeEventListener('touchmove', onMove, true);
    document.removeEventListener('touchend', onEnd, true);
    document.removeEventListener('touchcancel', onCancel, true);
    active = false;
  };

  function onStart(e) {
    if (s || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX > EDGE_PX || !eligible() || isScrollBusy()) return;
    if (e.target.closest?.('[data-no-swipe-back]')) return;
    e.__edgeBack = true;
    active = true;
    s = { sx: t.clientX, sy: t.clientY, st: performance.now(), dx: 0, locked: false, el: null, under: null, w: window.innerWidth || 1, raf: 0, crossed: false, top: nav.top() };
    document.addEventListener('touchmove', onMove, { capture: true, passive: false });
    document.addEventListener('touchend', onEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', onCancel, { capture: true, passive: true });
  }

  function onMove(e) {
    if (!s) return;
    const t = e.touches[0];
    const mx = t.clientX - s.sx, my = t.clientY - s.sy;
    if (!s.locked) {
      const c = classifyMove(mx, my);
      if (c === 'abort') { const x = s; s = null; detach(); reset(x.el, x.under); return; }
      if (c !== 'back') return;
      s.locked = true;
      s.el = surfaceFor(s.top);
      s.under = s.top?.kind === 'page' ? belowTopPageEl() : null;
      if (s.el) {
        s.el.style.setProperty('transition', 'none', 'important'); // overlay pages carry an !important transition
        s.el.style.willChange = 'transform';
        s.el.style.boxShadow = '-10px 0 28px rgba(0,0,0,.18)';
        document.documentElement.classList.add('nav-swiping');
      }
      if (s.under) { s.under.style.setProperty('transition', 'none', 'important'); s.under.style.willChange = 'transform'; }
    }
    e.preventDefault();
    s.dx = Math.max(0, mx);
    if (!s.crossed && s.dx / s.w > COMMIT_FRACTION) { s.crossed = true; haptic('light'); }
    else if (s.crossed && s.dx / s.w <= COMMIT_FRACTION) s.crossed = false;
    if (!s.raf) s.raf = requestAnimationFrame(paint);
  }

  const settle = (x, toX, ms, done) => {
    const { el, under } = x;
    if (!el || reduceMotion()) { done(); return; }
    const tr = `transform ${ms}ms var(--ease-out, cubic-bezier(.25,1,.5,1))`;
    el.style.setProperty('transition', tr, 'important');
    el.style.transform = `translate3d(${toX}px,0,0)`;
    if (under) { under.style.setProperty('transition', tr, 'important'); under.style.transform = `translate3d(${toX ? 0 : -30}%,0,0)`; }
    let fired = false;
    const fin = () => { if (fired) return; fired = true; done(); };
    el.addEventListener('transitionend', fin, { once: true });
    setTimeout(fin, ms + 60);
  };

  function onEnd() {
    if (!s) return;
    const x = s; s = null;
    detach();
    if (x.raf) cancelAnimationFrame(x.raf);
    if (!x.locked) { reset(x.el, x.under); return; }
    const v = x.dx / Math.max(1, performance.now() - x.st);
    const commit = shouldCommit(x.dx, v, x.w);
    // A guarded level (unsaved edits) never completes the slide: spring back, then let the guard ask.
    const guarded = !!x.top?.guarded;
    if (!commit || guarded) {
      settle(x, 0, 200, () => { reset(x.el, x.under); if (commit && guarded) nav.back({ source: 'gesture' }); });
      return;
    }
    const remaining = Math.max(0, x.w - x.dx);
    const ms = Math.round(120 + 180 * (remaining / x.w));
    settle(x, x.w, ms, () => {
      nav.back({ source: 'gesture', instant: true });
      // Let the pop run (it is deferred a task), then drop the inline drag styles.
      setTimeout(() => reset(x.el, x.under), 80);
    });
  }

  function onCancel() {
    if (!s) return;
    const x = s; s = null;
    detach();
    if (x.raf) cancelAnimationFrame(x.raf);
    settle(x, 0, 200, () => reset(x.el, x.under));
  }

  document.addEventListener('touchstart', onStart, { capture: true, passive: true });
}
