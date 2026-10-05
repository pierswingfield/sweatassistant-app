// Synchronous client-side view of saved studio maps. The API response cache is
// invalidated separately; this keeps timetable actions correct immediately
// after a map is saved or removed elsewhere in the app.
export function hasStudioPreferences(preferences) {
  return !!(preferences?.preferredSlots?.length || preferences?.preferredRows?.length);
}

export function shouldShowPreferredMapEditToggle(mode, mapEditing) {
  return mode === 'autobook' && !mapEditing;
}

export function applyStudioPreferenceMutation(target, { gymId, studioId, preferences }) {
  if (!target || studioId == null) return target;
  const key = gymId ? `${gymId}:${studioId}` : String(studioId);
  const previous = target[key];
  const value = {
    preferredSlots: [...(preferences?.preferredSlots || [])],
    preferredRows: [...(preferences?.preferredRows || [])],
  };
  target[key] = value;

  // Preserve the unqualified compatibility alias only when it represented
  // this same gym's entry (or when the response had only the legacy key).
  const bareKey = String(studioId);
  if (bareKey !== key && (target[bareKey] === previous || (!(key in target) && bareKey in target))) {
    target[bareKey] = value;
  }
  return target;
}
