// T-1: the ONE schema for a member's per-Team sharing record (`team_members.share_json`,
// PLAN-teams.md §3 and §7.1). Pure: no db, no I/O.
//
// FAIL-SAFE DIRECTION. A key that is missing, unknown-typed or unparseable resolves to
// the PRIVATE value. This is deliberately the opposite of the capability-flag rule in
// client/src/gym-context.js (unknown = ON). A capability fails safe by SHOWING a feature
// (a wrongly shown button self-corrects when the catalogue loads), but sharing must fail
// safe by HIDING: a wrongly shared class location cannot be un-seen. So a partial or
// corrupt record never shares more than the member explicitly chose.
//
// Defaults (D3) are what the consent sheet STARTS from, and are applied only when a
// member supplies no share at all; they are never used to fill gaps in a stored record.

const { listGyms } = require('./gyms.config');

const BOOL_KEYS = ['upcoming', 'waitlists', 'activity', 'recent', 'spots', 'autoBookQueue', 'competition'];
const SHARE_KEYS = ['gyms', ...BOOL_KEYS];

// D3: everything on except spot numbers and the auto-book queue; competition is a
// member opt-in on top of a Team setting, so it starts off too.
const DEFAULT_SHARE = Object.freeze({
  gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true,
  spots: false, autoBookQueue: false, competition: false,
});
const PRIVATE_SHARE = Object.freeze({
  gyms: [], upcoming: false, waitlists: false, activity: false, recent: false,
  spots: false, autoBookQueue: false, competition: false,
});

// D5: recent classes are limited to the last 30 days (consumed by the T-2 projection).
const RECENT_DAYS = 30;

const defaultShare = () => ({ ...DEFAULT_SHARE });
const privateShare = () => ({ ...PRIVATE_SHARE, gyms: [] });

function knownGymIds() {
  return new Set(listGyms().map((g) => g.id));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate member input. Unknown keys are dropped silently; a KNOWN key with a bad
 * value is an error (the client sent something it meant, and got it wrong).
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function validateShare(input) {
  if (!isPlainObject(input)) return { ok: false, error: 'share must be an object' };
  const value = {};
  for (const key of SHARE_KEYS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (key === 'gyms') {
      if (v === 'all') { value.gyms = 'all'; continue; }
      if (!Array.isArray(v) || !v.every((g) => typeof g === 'string')) {
        return { ok: false, error: 'share.gyms must be "all" or a list of gym ids' };
      }
      const known = knownGymIds();
      value.gyms = [...new Set(v)].filter((g) => known.has(g));
      continue;
    }
    if (typeof v !== 'boolean') return { ok: false, error: `share.${key} must be true or false` };
    value[key] = v;
  }
  return { ok: true, value };
}

/** Stored (object or JSON string) -> a complete share; anything missing or bad is private. */
function resolveShare(stored) {
  let obj = stored;
  if (typeof stored === 'string') {
    try { obj = JSON.parse(stored); } catch (_) { obj = null; }
  }
  const out = privateShare();
  if (!isPlainObject(obj)) return out;
  if (obj.gyms === 'all') out.gyms = 'all';
  else if (Array.isArray(obj.gyms)) out.gyms = obj.gyms.filter((g) => typeof g === 'string');
  for (const key of BOOL_KEYS) if (obj[key] === true) out[key] = true;
  return out;
}

/** Apply an already-validated patch to a stored share. */
function mergeShare(current, patch) {
  return resolveShare({ ...resolveShare(current), ...(isPlainObject(patch) ? patch : {}) });
}

const serializeShare = (share) => JSON.stringify(resolveShare(share));

module.exports = {
  SHARE_KEYS, RECENT_DAYS,
  defaultShare, privateShare, validateShare, resolveShare, mergeShare, serializeShare,
};
