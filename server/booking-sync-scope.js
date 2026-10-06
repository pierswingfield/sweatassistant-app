'use strict';
// Which gyms a client booking sync is authoritative for.
// The client sends `gymIds` = the gyms whose fetch actually succeeded; a gym that failed
// must keep its cached reminders. Absent `gymIds` (older client builds) = every linked gym.
// Returns { scope, skip }: skip=true means "nothing loaded, touch nothing".
function resolveSyncScope(gymIds, linkedGymIds) {
  const linked = Array.isArray(linkedGymIds) ? linkedGymIds : [];
  if (!Array.isArray(gymIds)) return { scope: linked, skip: false };
  const scope = [...new Set(gymIds.map(String).filter((id) => linked.includes(id)))];
  return { scope, skip: scope.length === 0 };
}
module.exports = { resolveSyncScope };
