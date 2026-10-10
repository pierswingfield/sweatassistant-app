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

// ── Guests are the places beyond the member's own limit ──────────────────────
// [Claude 2026-10-11] On a gym whose self limit is one per class (capabilities, never a gym name),
// every place above that limit is a named guest. The server contract (auto-book-preferences.js) is
// "requiredCount = guests + 1 with one self place", so guest places are only offered when the
// self limit is exactly 1 and at most ONE guest is supported per class today.
export const SCHEDULED_GUEST_LIMIT = 1;

export function scheduledGuestLimit({ selfLimit, guestSupported } = {}) {
  return guestSupported === true && Number(selfLimit) === 1 ? SCHEDULED_GUEST_LIMIT : 0;
}

/** Count options: the self limit plus the supported guest places. */
export function placeOptions({ selfLimit, guestLimit = 0 } = {}) {
  return bookingQuantityOptions(Math.max(1, Number(selfLimit) || 1) + Math.max(0, Number(guestLimit) || 0));
}

/** How many of `qty` places are guests (0 when the gym has no guest places). */
export function guestSlotCount({ qty, selfLimit, guestLimit = 0 } = {}) {
  const extra = Math.floor(Number(qty) || 1) - Math.max(1, Number(selfLimit) || 1);
  return Math.max(0, Math.min(extra, Math.max(0, Number(guestLimit) || 0)));
}

/** Count label. Plain number when the gym has no guest places; otherwise says who the places are for. */
export function placesLabel(qty, { selfLimit, guestLimit = 0 } = {}) {
  if (!(Number(guestLimit) > 0)) return String(qty);
  const guests = guestSlotCount({ qty, selfLimit, guestLimit });
  const noun = qty === 1 ? 'place' : 'places';
  return guests > 0
    ? `${qty} ${noun} (you + ${guests} guest${guests === 1 ? '' : 's'})`
    : `${qty} ${noun} (you)`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Drafts for `count` guest places (also resizes), seeded from an existing queue's guests (email and any booked name). */
export function seedGuestDrafts(existing = [], count = 0) {
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({
    email: String(existing[i]?.email || ''),
    name: existing[i]?.name || null,
  }));
}

/** Validate exactly `count` guest emails (required, well-formed, distinct). */
export function validateGuestDrafts(drafts = [], count = 0) {
  if (count <= 0) return { ok: true, message: '' };
  const emails = Array.from({ length: count }, (_, i) => String(drafts[i]?.email || '').trim().toLowerCase());
  if (emails.some((e) => !e)) return { ok: false, message: count === 1 ? 'Enter your guest’s email address to continue.' : 'Enter an email address for each guest to continue.' };
  if (emails.some((e) => !EMAIL_RE.test(e))) return { ok: false, message: 'Enter a valid guest email address to continue.' };
  if (new Set(emails).size !== emails.length) return { ok: false, message: 'Each guest needs a different email address.' };
  return { ok: true, message: '' };
}

/** The guests payload: trimmed emails; a seeded name is kept only while that email is unchanged. */
export function buildGuests(drafts = [], count = 0, seeded = []) {
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const email = String(drafts[i]?.email || '').trim();
    const prior = seeded.find((g) => String(g.email || '').toLowerCase() === email.toLowerCase());
    return { email, name: prior?.name || null };
  });
}
