// U4-19: thin impure layer over url-state.js (history + location). Phase 3 scope:
// tab/section paths. Filter/day sync (commitFilterChange) arrives in phase 4.
import { parseLocation, serializeState, legacyHashToPath } from './url-state.js';

export function currentRoute() {
  return parseLocation(location.pathname, location.search);
}

function currentUrl() { return location.pathname + location.search; }

/**
 * Change the URL without a reload. Push by default; replace when asked or when
 * the target equals the current URL (no duplicate entries). Same-origin
 * relative paths only.
 */
export function navigate(url, { replace = false } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return false;
  if (!history.pushState) return false;
  if (replace || url === currentUrl()) history.replaceState(history.state, '', url);
  else history.pushState(null, '', url);
  return true;
}

export function pathFor(state) { return serializeState(state); }

/** Legacy #hash links (old bookmarks, old push payloads) -> clean path. Kept permanently. */
export function migrateLegacyHash() {
  if (!location.hash) return false;
  const p = legacyHashToPath(location.hash);
  if (!p) return false;
  if (location.pathname !== '/') return false; // the old scheme only ever lived at the root
  history.replaceState(history.state, '', p + location.search);
  return true;
}

/**
 * Register the single popstate consumer. `handler(parsedRoute)` applies
 * tab/section. Events consumed by a modal page (modal-nav sets
 * sweatNavHandled in its capture-phase listener) are ignored.
 */
export function initRouter(handler) {
  window.addEventListener('popstate', (e) => {
    if (e.sweatNavHandled) return;
    handler(currentRoute());
  });
}

// ---- Phase 4: timetable filter/day history -------------------------------------------------
// A burst of chip toggles must leave ONE history entry: the first change of a burst pushes,
// later changes inside the quiet window replace. A day tap (commitNow) always ends the burst
// and pushes. Set-from-URL (popstate/deep link) uses replaceCurrent and never pushes.
export const BURST_MS = 1000;
let burstTimer = null;
function endBurst() { if (burstTimer) { clearTimeout(burstTimer); burstTimer = null; } }

export function commitFilterChange(url) {
  if (url === currentUrl()) return false;
  const inBurst = !!burstTimer;
  endBurst();
  burstTimer = setTimeout(() => { burstTimer = null; }, BURST_MS);
  return navigate(url, { replace: inBurst });
}

/** Discrete change (day tap): push immediately and close any open burst. */
export function commitNow(url) {
  endBurst();
  return navigate(url);
}

/** Correct the current entry without adding one (set-from-URL, load-time settling). */
export function replaceCurrent(url) {
  endBurst();
  return navigate(url, { replace: true });
}

export function _resetRouterForTest() { endBurst(); }

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

const RETURN_KEY = 'sweatReturnTo';
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
