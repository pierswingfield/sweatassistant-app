/**
 * Pure rule for what entering the Timetable tab does to its state.
 *  - 'resume': the tab was built earlier this session and the URL carries no timetable params of its own,
 *    so day, filters, search overlay and scroll stay as the user left them.
 *  - 'fresh': first entry, or a deep link / shared URL that names day or filters (the URL wins).
 * Re-tapping Timetable while it is already open is NOT an entry: main.js routes that to
 * resetToDefaultFilters() (back to today, saved filters, top).
 */
export function timetableEntryPlan({ initialised, routeTimetable }) {
  const t = routeTimetable || {};
  const hasParams = Object.keys(t).some((k) => t[k] != null && t[k] !== false && t[k] !== '' && !(Array.isArray(t[k]) && !t[k].length));
  return initialised && !hasParams ? 'resume' : 'fresh';
}

/** Render reasons that swap the result set (search/filter changes): these scroll the results to the top. Tab returns and background re-renders (gym data loading, team chips) do not. */
export const isResultSetChangeReason = (reason) => reason === 'search' || reason === 'filter';
