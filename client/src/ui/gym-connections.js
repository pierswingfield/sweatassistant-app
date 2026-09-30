import { noSept } from '../lib';
import { COPY, formatCopyText } from '../copy.js';
// Settings → Your Gyms: the pieces of the render that are pure enough to test.
//
// U1-7. renderGymsCard() used to `remove()` every per-gym sidebar entry and pane,
// then re-create them in a loop with an `await` (each gym's settings fetch)
// between iterations. Two overlapping renders (boot + the needs-relogin event,
// a re-link, an unlink...) therefore interleaved: B cleared A's half-built menu,
// then A resumed and appended the gyms it had not reached yet, then B appended
// its own — a gym listed twice, with two panes sharing one id.
//
// Two structural fixes, neither a delay:
//   1. reconcileKeyed(): rows/entries are keyed by gym id and UPDATED IN PLACE,
//      so "render" is idempotent — running it twice, or concurrently, cannot
//      produce a second copy of anything, and an existing element (with its focus,
//      its `.active` class, its already-loaded pane content) is never rebuilt.
//   2. createRenderGuard(): each render takes a generation token; a render that
//      has been superseded stops at its next await instead of writing stale data
//      over a newer one.

/**
 * A monotonically increasing generation counter.
 * `begin()` starts a render and returns its token; `isCurrent(token)` is false
 * once any later render has begun.
 */
export function createRenderGuard() {
  let generation = 0;
  return {
    begin() { return ++generation; },
    isCurrent(token) { return token === generation; },
  };
}

/**
 * Make `container`'s keyed children match `items`, in order, reusing existing
 * elements.
 *
 * - A new key gets `create(item)` (the shell), then `update(el, item)` fills it in.
 * - An item whose key already has an element in `container` is only passed to
 *   `update(el, item)`; the element itself is kept.
 * - A keyed element with no matching item is removed.
 * - Children WITHOUT the key attribute are never touched (the static Settings
 *   entries live in the same <nav>).
 * - Order is enforced by inserting before `anchor` (default: append), moving a
 *   node only when it is not already where it belongs.
 *
 * Returns { created, removed } so a caller can react (e.g. re-select a section).
 *
 * @param {Element} container
 * @param {Array<any>} items
 * @param {{keyAttr:string, keyOf:(item:any)=>string, create:(item:any)=>Element,
 *          update?:(el:Element,item:any)=>void, anchor?:Element|null}} opts
 */
export function reconcileKeyed(container, items, { keyAttr, keyOf, create, update, anchor = null }) {
  const existing = new Map();
  for (const el of Array.from(container.children)) {
    if (!el.hasAttribute(keyAttr)) continue;
    const k = el.getAttribute(keyAttr);
    // A duplicate key already in the DOM (from an older build, or a race) is
    // dropped here rather than adopted: exactly one element may own a key.
    if (existing.has(k)) el.remove(); else existing.set(k, el);
  }

  const wanted = [];
  const seen = new Set();
  const created = [];
  for (const item of items) {
    const k = String(keyOf(item));
    if (seen.has(k)) continue;
    seen.add(k);
    let el = existing.get(k);
    if (!el) {
      el = create(item);
      el.setAttribute(keyAttr, k);
      created.push(k);
    }
    // Also after create, so `create` only has to build the shell and there is
    // exactly one place that knows how to fill it in.
    if (update) update(el, item);
    wanted.push(el);
  }

  const removed = [];
  for (const [k, el] of existing) {
    if (!seen.has(k)) { el.remove(); removed.push({ key: k, el }); }
  }

  // Walk backwards so each node is placed relative to the one after it.
  let ref = anchor && anchor.parentNode === container ? anchor : null;
  for (let i = wanted.length - 1; i >= 0; i--) {
    const el = wanted[i];
    if (el.nextSibling !== ref || el.parentNode !== container) container.insertBefore(el, ref);
    ref = el;
  }
  return { created, removed };
}

/** Relative "3 days ago" / absolute date for a connection's last authentication. */
export function lastAuthLabel(iso, now = Date.now()) {
  if (!iso) return COPY.gyms.notRecorded;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return COPY.gyms.notRecorded;
  const days = Math.floor((now - then.getTime()) / 86400000);
  const date = noSept(then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  if (days <= 0) return formatCopyText(COPY.gyms.lastAuthToday, { date });
  if (days === 1) return formatCopyText(COPY.gyms.lastAuthYesterday, { date });
  if (days < 30) return formatCopyText(COPY.gyms.lastAuthDaysAgo, { days, date });
  return date;
}

/**
 * The connection's health as a symbol AND a word: a colour-and-glyph-only status
 * fails in forced-colours mode and for colour-blind users, and "is my gym
 * connected" is exactly the question you cannot afford to misread.
 */
export function connectionHealth(g) {
  if (!g.gym_enabled) return { cls: 'is-off', icon: '—', label: COPY.gyms.notAvailable };
  if (g.status === 'needs_relogin') return { cls: 'is-warn', icon: '!', label: COPY.gyms.reconnect };
  return { cls: 'is-ok', icon: '✓', label: COPY.gyms.connected };
}
