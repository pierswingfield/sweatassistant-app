// T10 Create-a-Team guided flow: the pure model (steps, validation, suggestions, the emoji
// grid and the invite share text). The DOM lives in teams-create.js. No imports from the app
// shell, so every rule here is unit-tested directly.

import { validateTeamName, validateEmoji } from './teams-model.js';

/** Flow order. 'ready' is shown only once the server has created the Team. */
export const CREATE_STEPS = Object.freeze(['name', 'emoji', 'sharing', 'ready']);
/** The steps that count towards the progress indicator (ready is the destination, not a step). */
export const INPUT_STEPS = Object.freeze(['name', 'emoji', 'sharing']);

/** Progress for a step: { index (1-based), total, fraction, showProgress }. */
export function stepProgress(step) {
  const i = INPUT_STEPS.indexOf(step);
  if (i === -1) return { index: INPUT_STEPS.length, total: INPUT_STEPS.length, fraction: 1, showProgress: false };
  return { index: i + 1, total: INPUT_STEPS.length, fraction: (i + 1) / INPUT_STEPS.length, showProgress: true };
}

/** The step Back goes to (null on the first step and on ready: there is nothing to go back to). */
export function previousStep(step) {
  if (step === 'ready') return null;
  const i = INPUT_STEPS.indexOf(step);
  return i > 0 ? INPUT_STEPS[i - 1] : null;
}

export function nextStep(step) {
  const i = CREATE_STEPS.indexOf(step);
  return i >= 0 && i < CREATE_STEPS.length - 1 ? CREATE_STEPS[i + 1] : null;
}

/**
 * Live (as-you-type) name check. Silent while the name is fine or simply empty: a gentle
 * inline error appears only once the limit is exceeded or a forbidden character is typed.
 * @returns {null | 'tooLong' | 'angle'}
 */
export function liveNameError(value) {
  const v = String(value ?? '');
  if (!v.trim()) return null;
  const r = validateTeamName(v);
  return r.ok ? null : (r.error === 'required' ? null : r.error);
}

/**
 * May the flow leave `step` with this draft? Returns { ok, error, value }.
 * name: required, at most 40 characters, no < or >. emoji: optional, one emoji.
 */
export function checkStep(step, draft = {}) {
  if (step === 'name') {
    const r = validateTeamName(draft.name);
    return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
  }
  if (step === 'emoji') {
    const r = validateEmoji(draft.emoji);
    return r.ok ? { ok: true, value: r.value } : { ok: false, error: 'emoji' };
  }
  return { ok: true };
}

/** Fun, varied Team names offered on the name step (tapping one fills the input). */
export const NAME_SUGGESTIONS = Object.freeze([
  'Tuesday Riders', 'Burpee Brunch Club', 'Cardio Crew', 'The Early Birds', 'Spin Doctors',
  'Rise & Grind', 'Sunday Reset', 'Box Clever', 'Lunch Break Legends', 'Ride or Die',
  'Squat Goals', 'Pedal Pushers', 'The Stretch Goals', 'Office Escapees', 'Gym Buddies',
  'Sore Today, Strong Tomorrow',
]);

/**
 * A rotating handful of suggestions. `seed` picks the window (so "More ideas" shows a
 * different set); deterministic for tests. Never repeats within one set.
 */
export function suggestionSet(seed = 0, count = 5, list = NAME_SUGGESTIONS) {
  const n = list.length;
  if (!n) return [];
  const k = Math.min(count, n);
  const start = (((Math.trunc(Number(seed)) || 0) * k) % n + n) % n;
  return Array.from({ length: k }, (_, i) => list[(start + i) % n]);
}

/** Curated Team emoji grid (each one grapheme, so validateEmoji accepts every one). */
export const EMOJI_CHOICES = Object.freeze([
  '🚴', '🏃', '🥊', '🧘', '🏋️', '💪', '🤸', '🏊',
  '🔥', '⚡', '🚀', '🏆', '🌅', '🌙', '🌈', '✨',
  '🦄', '🐝', '🦊', '🐙', '🥞', '🥑', '☕', '🎧',
]);

/**
 * The invite message for the native share sheet:
 *   "You're invited to <appName>! Join my Team 🏃 Run Club."
 * Plain text (the share sheet is not HTML): nothing is escaped here. `template` is
 * COPY.teams.shareText, `{appName}` comes from config (never hardcoded), `{team}` is the
 * emoji and name. Returns { title, text, url }.
 */
export function inviteSharePayload(team, { url, appName, textTemplate, titleTemplate, format }) {
  const name = String(team?.name ?? '').trim();
  const emoji = typeof team?.emoji === 'string' ? team.emoji.trim() : '';
  const label = emoji ? `${emoji} ${name}` : name;
  return {
    title: format(titleTemplate, { appName, name }),
    text: format(textTemplate, { appName, team: label }),
    url,
  };
}

/** What the clipboard fallback copies: the message, then the link on its own line. */
export function inviteClipboardText(payload) {
  return [payload.text, payload.url].filter(Boolean).join('\n');
}
