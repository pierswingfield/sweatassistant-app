// C2-4: decide whether an empty filtered timetable should show the loading
// skeleton instead of "No classes match". A gym that has not answered yet may be
// the very one the filters select, so "empty" is not yet a fact. A gym that
// fails is removed from `pendingGyms` by progressive-merge (fail = settle), so
// the skeleton can never outlive the requests.
//
// pendingGyms: ids still awaiting an answer, or null when no flush has happened
// yet (the pending set is unknown, so assume every gym is pending).
// selectedGyms: the gym filter; empty means all gyms.
export function shouldShowPendingSkeleton({ pendingGyms, selectedGyms = [], visibleCount = 0 }) {
  if (visibleCount > 0) return false;
  if (pendingGyms === null || pendingGyms === undefined) return true;
  if (!pendingGyms.length) return false;
  if (!selectedGyms.length) return true;
  const sel = new Set(selectedGyms.map(String));
  return pendingGyms.some((g) => sel.has(String(g)));
}
