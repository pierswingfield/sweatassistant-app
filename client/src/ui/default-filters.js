// Saved default timetable filters: server (account-scoped `defaultFilters`
// setting) is the source of truth; localStorage is the fast/offline cache.
// Pure logic only, so it is unit-testable without a DOM.

/** Accept only a plain object; arrays of ids are kept, anything else is dropped. */
export function normalizeFilters(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    gyms: arr(raw.gyms),
    locations: arr(raw.locations),
    instructors: arr(raw.instructors),
    eventTypes: arr(raw.eventTypes),
    showBookmarksOnly: !!raw.showBookmarksOnly,
  };
}

/**
 * Decide which filters to use. Server wins; if the server has none but the
 * device does, use the local copy and flag it for upload (migration).
 * @returns {{ filters: object|null, pushUp: boolean, writeLocal: boolean }}
 */
export function resolveDefaultFilters(serverValue, localValue) {
  const server = normalizeFilters(serverValue);
  const local = normalizeFilters(localValue);
  if (server) return { filters: server, pushUp: false, writeLocal: true };
  if (local) return { filters: local, pushUp: true, writeLocal: false };
  return { filters: null, pushUp: false, writeLocal: false };
}
