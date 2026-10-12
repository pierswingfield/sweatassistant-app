// What a tap on a timetable row's Auto-Book button does. Pure so the decision is testable.
//   'queue-now'   the studio has no seat map, or the member already has a saved preferred map for it:
//                 one tap queues the class (count 1, their book-any setting, together off), like Quick-Book.
//   'open-setup'  a seat map but no saved preferences: open the shared setup flow.
export function autoBookTapAction({ hasMap, hasPrefs }) {
  if (!hasMap) return 'queue-now';
  return hasPrefs ? 'queue-now' : 'open-setup';
}

// The queued Auto-Book entry for a timetable event (the list may be wrapped in `data`).
export function findScheduledEntry(list, event) {
  const rows = Array.isArray(list) ? list : (list && Array.isArray(list.data) ? list.data : []);
  return rows.find((x) => String(x.event_id ?? x.eventId) === String(event.id)
    && (!event.gymId || !x.gym_id || String(x.gym_id) === String(event.gymId))) || null;
}
