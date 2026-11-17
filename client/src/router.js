// U4-19: thin impure layer over url-state.js (history + location). Phase 3 scope:
// tab/section paths. Filter/day sync (commitFilterChange) arrives in phase 4.
import { parseLocation, serializeState, legacyHashToPath } from './url-state.js';
import { nav, isMobileViewport } from './nav-controller.js';

export function currentRoute() {
  return parseLocation(location.pathname, location.search);
}

function currentUrl() { return location.pathname + location.search; }

/**
 * Show a URL without a reload. The nav controller (nav-controller.js) is the only module that
 * writes history: it settles the back stack to the URL's route (a drill-down pushes a level, a
 * different tab re-bases, the same route just rewrites its URL). `replace` swaps the top level.
 * Same-origin relative paths only.
 */
export function navigate(url, { replace = false, state = undefined } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return false;
  if (!history.pushState) return false;
  const extra = state !== undefined ? state : null;
  if (nav.routeToUrl(url, { replace, extra })) return true;
  nav.replaceUrl(url, extra); // not an app route (unknown path): still correct the address, never add a level
  return true;
}

export function pathFor(state) { return serializeState(state); }

/** Legacy #hash links (old bookmarks, old push payloads) -> clean path. Kept permanently. */
export function migrateLegacyHash() {
  if (!location.hash) return false;
  const p = legacyHashToPath(location.hash);
  if (!p) return false;
  if (location.pathname !== '/') return false; // the old scheme only ever lived at the root
  nav.replaceUrl(p + location.search);
  return true;
}

/**
 * Register the route applier. `handler(parsedRoute)` shows the tab/section a back/forward/system
 * pop landed on. The nav controller is the only popstate consumer and calls this after it has
 * popped any pages or layers, so there is no double handling.
 */
export function initRouter(handler) {
  nav.setRouteHandler(handler);
}

// ---- Phase 4: timetable filter/day history -------------------------------------------------
// Mobile (decision 3, 2026-11-16): day/filter changes NEVER add a back entry, so Back and the edge
// swipe leave the screen instead of silently undoing a filter; the URL still updates (replace).
// Desktop: a burst of chip toggles leaves ONE history entry (the first change pushes, later ones
// inside the quiet window replace); a day tap (commitNow) always ends the burst and pushes.
// Set-from-URL (popstate/deep link) uses replaceCurrent and never pushes.
export const BURST_MS = 1000;
let burstTimer = null;
function endBurst() { if (burstTimer) { clearTimeout(burstTimer); burstTimer = null; } }

function pushStep(url, state) {
  if (isMobileViewport()) { nav.replaceUrl(url, state); return true; }
  nav.pushRoute({ key: `step:${nav.nextSeq()}`, url, extra: state });
  return true;
}

export function commitFilterChange(url, { state = {} } = {}) {
  if (url === currentUrl()) return false;
  const inBurst = !!burstTimer;
  endBurst();
  burstTimer = setTimeout(() => { burstTimer = null; }, BURST_MS);
  const nextState = { ...(history.state || {}), manualFilter: true, ...state };
  if (inBurst) { nav.replaceUrl(url, nextState); return true; }
  return pushStep(url, nextState);
}

/** Discrete change (day tap): a new level on desktop (and closes any open burst); a URL rewrite on mobile. */
export function commitNow(url, { state = {} } = {}) {
  endBurst();
  const nextState = { ...(history.state || {}), manualFilter: true, ...state };
  if (url === currentUrl()) return true;
  return pushStep(url, nextState);
}

/** Correct the current entry without adding one (set-from-URL, load-time settling). */
export function replaceCurrent(url, { state = {} } = {}) {
  endBurst();
  const nextState = { ...(history.state || {}), ...state };
  nav.replaceUrl(url, nextState);
  return true;
}

export function _resetRouterForTest() { endBurst(); nav._reset(); }

// ---- Phase 7: validated return-to ----------------------------------------------------------
/**
 * Only same-origin relative app paths survive. Rejects scheme-ful, protocol-relative (`//`),
 * backslash, control-character and non-path values. Returns the safe path or null.
 */
export function safeReturnTo(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  let d = v;
  try { d = decodeURIComponent(v); } catch { return null; }
  if (d.startsWith('//') || d.includes('\\') || /^\/+[a-z][a-z0-9+.-]*:/i.test(d)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(d)) return null;
  if (/^\/(api|admin)(\/|$)/i.test(v)) return null; // server routes, not app routes
  try {
    const u = new URL(v, 'http://sweat.invalid');
    if (u.origin !== 'http://sweat.invalid') return null;
  } catch { return null; }
  return v;
}

const RETURN_KEY = 'appReturnTo';
export function stashReturnTo(path) {
  const safe = safeReturnTo(path);
  try { if (safe && safe !== '/') sessionStorage.setItem(RETURN_KEY, safe); } catch { /* storage blocked */ }
  return safe;
}
/** Read and clear. Returns a validated path or null. */
export function takeReturnTo() {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return safeReturnTo(v);
  } catch { return null; }
}
