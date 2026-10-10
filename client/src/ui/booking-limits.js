// A quantity control represents a real provider/user allowance. Do not invent
// a familiar-looking 1–4 range when neither the class nor the gym has supplied
// one: offering an unsupported count produces a misleading "saved" flow.
export function maxAttendeesPerClass({ providerLimit, gymLimit, fallback = 1 } = {}) {
  const configured = [providerLimit, gymLimit]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, Math.floor(configured.length ? Math.min(...configured) : fallback));
}

export function bookingQuantityOptions(limit = 1) {
  const count = Math.max(1, Math.floor(Number(limit) || 1));
  return Array.from({ length: count }, (_, index) => index + 1);
}

// Togetherness only means something for a group. It forces book-any (a group
// cannot stay together if the fallback is off), and a count of one must never
// leave an invisible forcing flag behind.
export function normalizeGroupOptions({ qty = 1, bookAny = true, prioritizeTogether = false } = {}) {
  const together = Number(qty) > 1 && prioritizeTogether === true;
  return { prioritizeTogether: together, bookAny: together ? true : bookAny !== false };
}

// Group-option transitions. Togetherness forces book-any on; remember whether the member had it on
// themselves so releasing togetherness (untick, or count back to 1) restores their own choice
// instead of leaving a forced flag behind.
function releaseTogether(s) {
  return { ...s, prioritizeTogether: false, bookAny: s.bookAnyRestore === false ? false : s.bookAny, bookAnyRestore: null };
}
export function applyTogetherChange(s, on) {
  if (on && !s.prioritizeTogether) return { ...s, prioritizeTogether: true, bookAnyRestore: s.bookAny ? null : false, bookAny: true };
  if (!on && s.prioritizeTogether) return releaseTogether(s);
  return s;
}
export function applyCountChange(s, qty) {
  const next = { ...s, qty };
  return qty > 1 || !s.prioritizeTogether ? next : releaseTogether(next);
}
export function applyFallbackChange(s, on) {
  return on
    ? { ...s, bookAny: true, bookAnyRestore: null }
    : { ...s, bookAny: false, prioritizeTogether: false, bookAnyRestore: null };
}
