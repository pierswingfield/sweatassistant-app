// Tab re-entry refresh policy. The timetable is slow-moving, so a young cache
// is trusted; bookings/waitlists must track the official site, so their TTL is
// short. Revalidating data that is already painted is SILENT (no chip spinner);
// only a blocking cold load or an explicit refresh shows it.
export const TIMETABLE_TTL_MS = 5 * 60 * 1000;
export const CONTEXT_TTL_MS = 25 * 1000;

export function decideRefresh({ force = false, hasCached = false, timetableAgeMs = Infinity, contextAgeMs = Infinity } = {}) {
  if (force || !hasCached) return { timetable: true, context: true, silent: false, skip: false };
  const timetable = !(timetableAgeMs < TIMETABLE_TTL_MS);
  const context = !(contextAgeMs < CONTEXT_TTL_MS);
  return { timetable, context, silent: true, skip: !timetable && !context };
}
