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
