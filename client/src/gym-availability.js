// Last known connection state survives an offline open. No credentials or session data.
let epoch = 0;
const key = () => `dibs:gym-connections:${localStorage.getItem('appUserId') || ''}`;
export function connectionEpoch() { return epoch; }
export function connectionStates() {
  try { return JSON.parse(localStorage.getItem(key()) || '{}'); } catch (_) { return {}; }
}
export function isGymAvailable(gymId) {
  return !['needs_relogin', 'syncing'].includes(connectionStates()[gymId]?.status);
}
export function isAvailableLink(g) {
  return g.account_enabled !== 0 && g.account_enabled !== false && !['needs_relogin', 'syncing'].includes(g.status) && isGymAvailable(g.gym_id || g.gymId || g.id);
}
export function updateConnectionStates(gyms) {
  const previous = connectionStates();
  const next = Object.fromEntries((gyms || []).map(g => [g.gym_id, { status: g.status, revision: g.connection_revision || 0, name: g.gym_name }]));
  const changed = Object.keys(previous).length > 0 && Object.keys({ ...previous, ...next }).some(id => previous[id]?.status !== next[id]?.status);
  localStorage.setItem(key(), JSON.stringify(next));
  if (changed) epoch++;
  return changed;
}
export function noteUnavailable(gymId) {
  if (!gymId || !isGymAvailable(gymId)) return false;
  const states = connectionStates();
  states[gymId] = { ...states[gymId], status: 'needs_relogin' };
  localStorage.setItem(key(), JSON.stringify(states));
  epoch++;
  return true;
}
