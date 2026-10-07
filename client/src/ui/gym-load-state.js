// U4-2: which gyms currently have a request in flight for the visible page.
// The header gym chips are rebuilt often (credit refreshes), so the loading
// flag lives here rather than on the DOM and is re-applied after every render.
// Counted per gym so overlapping loads (timetable + bookings) do not clear each
// other's indicator.

const counts = new Map(); // gymId -> in-flight count
const subs = new Set();

const notify = () => subs.forEach((fn) => { try { fn(); } catch (_) {} });

export function beginGymLoad(gymId) {
  const id = String(gymId);
  counts.set(id, (counts.get(id) || 0) + 1);
  notify();
}

export function endGymLoad(gymId) {
  const id = String(gymId);
  const n = (counts.get(id) || 0) - 1;
  if (n > 0) counts.set(id, n); else counts.delete(id);
  notify();
}

export function isGymLoading(gymId) {
  return (counts.get(String(gymId)) || 0) > 0;
}

export function onGymLoadChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function resetGymLoadState() {
  counts.clear();
  notify();
}

/** Mark/unmark every `[data-gym]` chip under `root` to match the store. */
export function applyGymLoadState(root = document) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('.app-header-gym-badge[data-gym]').forEach((el) => {
    const on = isGymLoading(el.getAttribute('data-gym'));
    el.classList.toggle('is-loading', on);
    if (on) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
  });
}
