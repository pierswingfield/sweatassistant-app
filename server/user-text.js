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
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/;
const ZERO_WIDTH_RE = /[​-‍⁠﻿]/;

/**
 * Validate one person-name field. Empty is allowed (it clears the name).
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function checkPersonName(input, { label = 'Name', max = PERSON_NAME_MAX } = {}) {
  if (input === undefined || input === null) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: `${label} must be text.` };
  // Test BEFORE collapsing whitespace: \s matches some of these (U+FEFF) and would hide them.
  if (CONTROL_RE.test(input.replace(/[\t\n\r]/g, ' '))) return { ok: false, error: `${label} contains a character that is not allowed.` };
  if (BIDI_RE.test(input) || ZERO_WIDTH_RE.test(input)) return { ok: false, error: `${label} contains a character that is not allowed.` };
  const value = input.replace(/\s+/g, ' ').trim();
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

module.exports = { PERSON_NAME_MAX, checkPersonName, normaliseNameSettings, dropInvalidNameSettings };
