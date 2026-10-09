// Mobile gym quick-selector (5-10 enhancement 2). Pure selection logic; the rail
// renders it and timetable.js owns the filter state. `selected` is the gym filter
// array where EMPTY means "no gym filter" = every gym is shown.

const norm = (ids) => (ids || []).map(String);

/** The gym ids whose classes are currently shown. */
export function shownGyms(selected, allGymIds) {
  const all = norm(allGymIds);
  const sel = norm(selected).filter(id => all.includes(id));
  return sel.length ? sel : all;
}

/** Tap a gym: it becomes the only shown gym; tapping the sole shown gym shows all.
 *  Returns the new gym filter array ([] = all gyms). */
export function nextGymSelection(selected, allGymIds, tappedId) {
  const all = norm(allGymIds);
  const id = String(tappedId);
  if (!all.includes(id)) return norm(selected);
  const sel = norm(selected).filter(g => all.includes(g));
  // Only this gym is shown and the user taps it again: back to everything. With a single
  // linked gym there is nothing to narrow, so it stays "all".
  if (all.length <= 1 || (sel.length === 1 && sel[0] === id)) return [];
  return [id];
}

/** Per-gym view model for every CONFIGURED gym, in order. `linkedIds` (default: all) are the gyms
 *  with data; an unlinked gym is never shown.
 *  U6-14: active (shown) gym logos sit leftmost and stacked on top (higher z-index),
 *  with blurred/excluded logos positioned behind and to the right. */
export function quickSelectItems(selected, configuredIds, linkedIds = configuredIds) {
  const linked = new Set(norm(linkedIds));
  const shown = new Set(shownGyms(selected, [...linked]));
  const items = norm(configuredIds).map(gymId => ({ gymId, linked: linked.has(gymId), shown: shown.has(gymId) }));
  return [
    ...items.filter(i => i.shown),
    ...items.filter(i => !i.shown),
  ];
}
