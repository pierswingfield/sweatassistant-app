// Pure helpers for the Auto-Upgrade setup modal (bookings.js openUpgradeConfigModal).
// Kept free of DOM/network imports so they are unit-testable.

const EXPLAINER_KEY = 'sweatUpgradeExplainerDismissed';

export function isExplainerDismissed() {
  try { return localStorage.getItem(EXPLAINER_KEY) === '1'; } catch (_) { return false; }
}

export function dismissExplainer() {
  try { localStorage.setItem(EXPLAINER_KEY, '1'); } catch (_) { /* storage unavailable */ }
}

// "Continue past 12h cutoff" is offered only when the gym's settings enable it.
export function isKeepOriginalEnabled(settingValue) {
  return settingValue === true;
}

// Value stored on a monitor created WITHOUT the modal (quick-register, post-booking,
// server auto-register): follows the gym's default exactly, never a hardcoded true.
export function keepOriginalForAutoCreate(settingValue) {
  return isKeepOriginalEnabled(settingValue);
}

// Initial tick state in the modal: unticked unless editing a monitor that already has it
// AND the option is still enabled for the gym.
export function keepOriginalInitial(existingPrefs, settingValue) {
  return isKeepOriginalEnabled(settingValue) && existingPrefs?.keepOriginalOnCutoff === true;
}

// "3 preferred spots, 1 row" / "No preferred spots set"
export function summarizeSpotPrefs(slots = [], rows = [], noun = 'spot') {
  const s = slots.length;
  const r = rows.length;
  if (!s && !r) return `No preferred ${noun}s set`;
  const parts = [];
  if (s) parts.push(`${s} preferred ${noun}${s === 1 ? '' : 's'}`);
  if (r) parts.push(`${r} preferred row${r === 1 ? '' : 's'}`);
  return parts.join(', ');
}

// Label for the user's current spot. `currentSlotId` may be a string (it comes from a
// data-attribute), so compare numerically. Never fall back to the raw provider slot id:
// it is not what the member sees on the map (the source of the "36272" bug).
export function currentSpotLabel(layoutSlots, currentSlotId, fallbackLabel = '') {
  const match = layoutSlots.find(s => Number(s.id) === Number(currentSlotId));
  return match?.label || fallbackLabel || '';
}
