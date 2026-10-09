// Per-gym instructor filter: pure, no DOM. Shared by the timetable, the filter
// rail and (later) the U4-19 URL work.
//
// An instructor selection is a list of TOKENS, `gymId:instructorId`. Provider
// ids collide across gyms, so a bare id is never a valid identity. Semantics:
// for an event, if its gym has >= 1 selected instructor the event must have one
// of them; if its gym has none, the filter does not restrict that gym.

const sid = (v) => (v == null ? '' : String(v));

export function instructorToken(gymId, id) {
  return `${sid(gymId)}:${sid(id)}`;
}

// A search suggestion identifies an instructor within one gym. Add that gym to
// the search scope as well as the instructor token: instructor filters are
// intentionally permissive for gyms without a selected instructor, whereas a
// search result must not leak unrelated classes from those gyms.
export function addInstructorSearchFilter(filters, gymId, instructorId) {
  const gym = sid(gymId);
  const add = (items, value) => items.includes(value) ? [...items] : [...items, value];
  const current = filters || {};
  const instructors = add(current.instructors || [], gym ? instructorToken(gym, instructorId) : sid(instructorId));
  return {
    ...current,
    gyms: gym ? add(current.gyms || [], gym) : [...(current.gyms || [])],
    instructors,
  };
}

// -> { gymId, id } | null. Bare ids (no gym) are rejected.
export function parseInstructorToken(token) {
  const t = sid(token);
  const i = t.indexOf(':');
  if (i <= 0 || i === t.length - 1) return null;
  return { gymId: t.slice(0, i), id: t.slice(i + 1) };
}

export const isInstructorToken = (t) => parseInstructorToken(t) !== null;

// Legacy saved defaults hold bare provider ids. Attribute each to the gym whose
// loaded metadata contains it; ambiguous or unknown ids go to the default gym.
// Tokens pass through; result is de-duped. Never drops a value, so a saved
// default cannot be wiped by migration (a bare id is kept bare only when there
// is no default gym to attribute it to).
export function migrateInstructorSelection(list, pool, defaultGymId) {
  const out = [];
  const seen = new Set();
  const add = (t) => { if (!seen.has(t)) { seen.add(t); out.push(t); } };
  for (const raw of Array.isArray(list) ? list : []) {
    const v = sid(raw);
    if (!v) continue;
    if (isInstructorToken(v)) { add(v); continue; }
    const gyms = [...new Set((pool || []).filter(x => sid(x.id) === v && x.gymId).map(x => sid(x.gymId)))];
    if (gyms.length === 1) add(instructorToken(gyms[0], v));
    else if (defaultGymId) add(instructorToken(defaultGymId, v));
    else add(v);
  }
  return out;
}

export const hasLegacyInstructors = (list) => (Array.isArray(list) ? list : []).some(t => !isInstructorToken(t));

// Does an event pass? `instructorIds` are the event's instructor ids (normalized strings).
export function passesInstructorFilter(selected, gymId, instructorIds) {
  if (!selected || !selected.length) return true;
  const mine = selected.map(parseInstructorToken).filter(p => p && p.gymId === sid(gymId));
  if (!mine.length) return true;
  const ids = (Array.isArray(instructorIds) ? instructorIds : [instructorIds]).map(sid).filter(Boolean);
  return ids.some(id => mine.some(p => p.id === id));
}

// Keep only picks whose gym passes gymOk (used when the gym switch narrows).
export const pruneInstructorSelection = (selected, gymOk) =>
  (selected || []).filter(t => { const p = parseInstructorToken(t); return !p || gymOk(p.gymId); });

// Summary for chips: { count, gymCount, firstToken }
export function summariseInstructorSelection(selected) {
  const toks = (selected || []).map(parseInstructorToken).filter(Boolean);
  return { count: selected ? selected.length : 0, gymCount: new Set(toks.map(p => p.gymId)).size, firstToken: selected && selected[0] };
}

// Chip content: one entry per linked gym, in order. count 0 = "All" (that gym is unrestricted).
export function summariseInstructorsByGym(selected, gymIds) {
  const toks = (selected || []).map(parseInstructorToken).filter(Boolean);
  return (gymIds || []).map(g => ({ gymId: sid(g), count: toks.filter(p => p.gymId === sid(g)).length }));
}

// Grand total count and unfiltered flag for mobile scroll-collapse (U6-15).
// e.g. { count: 8, hasUnfilteredGym: false, countLabel: '8' } -> "8 Instructors"
// e.g. { count: 8, hasUnfilteredGym: true, countLabel: '8+' } -> "8+ Instructors"
export function compactInstructorsCount(selected, gymIds) {
  const summary = summariseInstructorsByGym(selected, gymIds);
  const count = (selected || []).length;
  const hasUnfilteredGym = (gymIds || []).length > 1 && summary.some(s => s.count === 0);
  return {
    count,
    hasUnfilteredGym,
    countLabel: `${count}${hasUnfilteredGym ? '+' : ''}`,
  };
}

// Find the metadata instructor behind a token (gym AND id must match).
export const findInstructor = (pool, token) => {
  const p = parseInstructorToken(token);
  return p ? (pool || []).find(x => sid(x.id) === p.id && sid(x.gymId) === p.gymId) : undefined;
};

// Compact URL / storage shape: comma-separated tokens; lenient parse drops bare/malformed.
export const serializeInstructorParam = (tokens) => (tokens || []).filter(isInstructorToken).join(',');
export function parseInstructorParam(str, max = 50) {
  const out = [];
  for (const t of sid(str).split(',')) {
    const v = t.trim();
    if (isInstructorToken(v) && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
