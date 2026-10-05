// Timetable search state — the ONE place the committed search text lives, so the
// URL layer (U4-19, query param `q`) can read/write it without touching UI code.
// Not persisted, never written to saved filter defaults.

let query = '';
const listeners = new Set();

export function getSearchQuery() { return query; }

export function setSearchQuery(q) {
  const next = String(q == null ? '' : q).trim().replace(/\s+/g, ' ').slice(0, 80);
  if (next === query) return;
  query = next;
  listeners.forEach(fn => { try { fn(query); } catch { /* a listener must not break search */ } });
}

export function clearSearch() { setSearchQuery(''); }

export function onSearchChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Search SCOPE ────────────────────────────────────────────────────────────
// Search has its own filter scope. Entering it snapshots the timetable's normal
// filters (so the caller can blank them: search starts unfiltered); leaving it
// hands the snapshot back to be restored exactly. The snapshot lives here, not
// in the DOM, so a re-render or background refresh mid-search cannot lose it,
// and it is never written to localStorage / saved defaults.
// URL schema (U4-19): search scope = `q` + the timetable filter params.
let snapshot = null;

const cloneFilters = (f) => ({
  gyms: [...(f.gyms || [])], locations: [...(f.locations || [])],
  instructors: [...(f.instructors || [])], eventTypes: [...(f.eventTypes || [])],
  bookmarks: !!f.bookmarks,
});

export const inSearchScope = () => snapshot !== null;

/** Snapshot `filters` on entry. Returns false (and keeps the ORIGINAL snapshot) if already in scope. */
export function enterSearchScope(filters) {
  if (snapshot) return false;
  snapshot = cloneFilters(filters);
  return true;
}

/** Leave scope: returns the snapshot to restore, or null if not in scope. */
export function leaveSearchScope() {
  const s = snapshot;
  snapshot = null;
  return s;
}

export const emptyFilters = () => cloneFilters({});
export const filtersAreEmpty = (f) => !f.gyms.length && !f.locations.length && !f.instructors.length && !f.eventTypes.length && !f.bookmarks;
