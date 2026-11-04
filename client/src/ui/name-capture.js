import { COPY } from '../copy.js';
// Account-name helpers shared by the post-link onboarding step and Home W1.
// Gym profile names are suggestions only; the saved account setting is the
// single source of truth once a member has confirmed or edited it.

export function cleanFirstName(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

/** Return one unambiguous first-name suggestion, otherwise an empty string. */
export function inferFirstName(linkedGyms) {
  return inferNames(linkedGyms).firstName;
}

/** Collapse whitespace and trim one name field (the server applies the same normalisation). */
export function cleanNameField(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Client mirror of server/user-text.js checkPersonName (keep the two in step): NFKC, no
 * control / bidi / zero-width characters, no < or >, 40 code points max. Returns the
 * normalised value, or '' when the server would reject it (so a gym-supplied prefill that
 * would fail on Save is left empty instead).
 */
export function validPrefill(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).normalize('NFKC');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return '';
  if (/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/.test(text)) return '';
  const v = text.replace(/\s+/g, ' ').trim();
  if (/[<>]/.test(v) || [...v].length > 40) return '';
  return v;
}

/**
 * One gym profile's name as { first, last }. The profile's own first_name/last_name
 * win (the server lifts them from the stored profile), because a multi-word
 * display_name ("Mary Ann Smith") cannot be split reliably. Without them the
 * display_name splits at its first and last words.
 */
export function gymProfileName(gym) {
  const first = validPrefill(gym?.first_name ?? gym?.firstName);
  const last = validPrefill(gym?.last_name ?? gym?.lastName);
  if (first || last) return { first, last };
  const words = validPrefill(gym?.display_name ?? gym?.displayName).split(' ').filter(Boolean);
  if (!words.length) return { first: '', last: '' };
  return { first: words[0], last: words.length > 1 ? words[words.length - 1] : '' };
}

/**
 * T-1 (PLAN-teams.md §5.8): one unambiguous { firstName, lastName } suggestion from
 * the linked gym profiles, plus the gyms it came from. Names compare
 * case-insensitively. Profiles that disagree on the first name give no suggestion at
 * all; profiles that agree on the first name but disagree on the last suggest the
 * first name only. A profile without a last name never contradicts one that has it.
 */
export function inferNames(linkedGyms) {
  const named = (linkedGyms || [])
    .map((gym) => ({ gym, ...gymProfileName(gym) }))
    .filter((p) => p.first);
  const firsts = new Map();
  for (const p of named) if (!firsts.has(p.first.toLocaleLowerCase())) firsts.set(p.first.toLocaleLowerCase(), p.first);
  if (firsts.size !== 1) return { firstName: '', lastName: '', sources: [] };
  const lasts = new Map();
  for (const p of named) if (p.last && !lasts.has(p.last.toLocaleLowerCase())) lasts.set(p.last.toLocaleLowerCase(), p.last);
  const sources = named.map((p) => p.gym?.gym_name || p.gym?.gymName || '').filter(Boolean);
  return {
    firstName: [...firsts.values()][0],
    lastName: lasts.size === 1 ? [...lasts.values()][0] : '',
    sources: [...new Set(sources)],
  };
}

/**
 * Time-of-day greeting for the Home header. Device-local hour on purpose: it is about
 * the person's day, not the class zone. Morning 05:00-11:59, afternoon 12:00-17:59,
 * evening 18:00-04:59.
 */
export function greetingPhrase(hour) {
  const h = Number(hour);
  if (h >= 5 && h < 12) return COPY.home.goodMorning;
  if (h >= 12 && h < 18) return COPY.home.goodAfternoon;
  return COPY.home.goodEvening;
}

/** One line: "Good morning, Piers!" or "Good morning!" with no name. */
export function greetingText(firstName, date = new Date()) {
  const name = cleanFirstName(firstName);
  const phrase = greetingPhrase(date.getHours());
  return name ? `${phrase}, ${name}!` : `${phrase}!`;
}

export function welcomeText(firstName) {
  const name = cleanFirstName(firstName);
  return name ? `Welcome, ${name}!` : 'Welcome!';
}
