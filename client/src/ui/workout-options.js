// Workouts filter options. Metadata classTypes can arrive empty, group-less or
// without a gymId (failed per-gym fetch, stale cache), which left the mobile
// Workouts section empty while the selected labels still showed in its header.
// The loaded events always carry `discipline`, so they back-fill the list.
export function buildWorkoutOptions({ eventTypes, events, gymOk, labelOf }) {
  const seen = new Set();
  const out = [];
  const add = (group, gymId) => {
    if (!group) return;
    const label = labelOf(group);
    const k = `${gymId}:${label}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ id: label, name: label, gymId });
  };
  (eventTypes || []).forEach(t => { if (t.group && gymOk(t.gymId)) add(t.group, t.gymId); });
  (events || []).forEach(e => { if (e.discipline && gymOk(e.gymId)) add(e.discipline, e.gymId); });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
