'use strict';
// T-1: the one validator for short, user-visible person names (account firstName and
// lastName). Other members see these in Teams, so they must not carry markup or
// characters that change how surrounding text renders.
//
// Rejected: < and >, C0/C1 control characters, bidi embedding/override/isolate marks
// (U+061C, U+200E/F, U+202A-202E, U+2066-2069) and zero-width characters
// (U+200B-200D, U+2060, U+FEFF). Whitespace runs collapse to one space and the ends
// are trimmed. Defence in depth only: every client still escapes names on render.

const PERSON_NAME_MAX = 40;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;

/**
 * Validate one person-name field. Empty is allowed (it clears the name).
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function checkPersonName(input, { label = 'Name', max = PERSON_NAME_MAX } = {}) {
  if (input === undefined || input === null) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: `${label} must be text.` };
  // NFKC first (fullwidth, compatibility forms and decomposed accents become one canonical
  // string), so every check below sees what will be stored and shown.
  const text = input.normalize('NFKC');
  // Test BEFORE collapsing whitespace: \s matches some of these (U+FEFF) and would hide them.
  if (CONTROL_RE.test(text.replace(/[\t\n\r]/g, ' '))) return { ok: false, error: `${label} contains a character that is not allowed.` };
  if (BIDI_RE.test(text) || ZERO_WIDTH_RE.test(text)) return { ok: false, error: `${label} contains a character that is not allowed.` };
  const value = text.replace(/\s+/g, ' ').trim();
  if (/[<>]/.test(value)) return { ok: false, error: `${label} cannot contain < or >.` };
  if ([...value].length > max) return { ok: false, error: `${label} must be ${max} characters or fewer.` };
  return { ok: true, value };
}

const NAME_SETTING_LABELS = Object.freeze({ firstName: 'First name', lastName: 'Last name' });

/**
 * Normalise the name keys of a settings patch in place. Throws an Error with
 * `status = 400` on the first invalid one; keys that are absent are left absent.
 */
function normaliseNameSettings(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  for (const [key, label] of Object.entries(NAME_SETTING_LABELS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const r = checkPersonName(patch[key], { label });
    if (!r.ok) {
      const err = new Error(r.error);
      err.status = 400;
      err.code = 'INVALID_NAME';
      throw err;
    }
    patch[key] = r.value;
  }
  return patch;
}

/** Same rule for an untrusted import: invalid name keys are dropped, not fatal. */
function dropInvalidNameSettings(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  for (const [key, label] of Object.entries(NAME_SETTING_LABELS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const r = checkPersonName(patch[key], { label });
    if (r.ok) patch[key] = r.value; else delete patch[key];
  }
  return patch;
}

// Single-character confusables folded by skeleton(): Cyrillic and Greek lookalikes of Latin
// letters (applied after lower-casing), plus the digit/letter pairs 0/o and 1/l/i.
const CONFUSABLES = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0456': 'l', '\u0458': 'j', '\u0455': 's', '\u043A': 'k', '\u043C': 'm', '\u043D': 'h', '\u0442': 't', '\u0432': 'b',
  '\u03B1': 'a', '\u03B2': 'b', '\u03B5': 'e', '\u03B6': 'z', '\u03B7': 'n', '\u03B9': 'l', '\u03BA': 'k', '\u03BC': 'm',
  '\u03BD': 'n', '\u03BF': 'o', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'y', '\u03C7': 'x', '\u0131': 'l',
  '0': 'o', '1': 'l', 'i': 'l',
};

/**
 * Comparison key for "do these two names look the same?": NFKC, case-fold, strip combining
 * marks, then fold Cyrillic/Greek Latin lookalikes and 0/o, 1/l/i onto one letter. Used ONLY
 * to detect clashes (Teams display names); never stored or shown. It over-merges on purpose
 * (a false clash only adds an initial; a missed one lets a lookalike pass as a teammate).
 */
function skeleton(input) {
  const base = String(input ?? '').normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let out = '';
  for (const ch of base.normalize('NFKC')) out += CONFUSABLES[ch] || ch;
  return out;
}

module.exports = { PERSON_NAME_MAX, skeleton, checkPersonName, normaliseNameSettings, dropInvalidNameSettings };
