// Timetable keyword search — PURE (no DOM, no module state).
//
// Works on NormalizedEvent[] only (name, discipline, instructors[], studioName,
// locationName, gymId). NEVER `.raw`. Provider ids collide across gyms, so every
// key is qualified by gymId. Ids are STRINGS (AGENTS.md); compare with String().
//
// Matching: case/diacritic/punctuation-insensitive, tokenised. EVERY typed word
// must be a substring of SOME field of the event (AND across words, any field),
// so "george boxing" = instructor George + discipline/name Boxing.

export const SUGGESTION_GROUPS = ['instructor', 'class', 'location', 'gym', 'workout'];
const PER_GROUP = 4;

/** lower-case, strip diacritics, punctuation -> single spaces. */
export function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(q) {
  const n = normalizeText(q);
  return n ? n.split(' ') : [];
}

const allTokensIn = (tokens, hays) => tokens.every(t => hays.some(h => h.includes(t)));

/**
 * opts (all optional hooks so the module stays provider- and gym-agnostic):
 *   gymNames(gymId) -> string[]   names to match/display for a gym (full + short)
 *   gymLabel(gymId) -> string     the short label shown beside an instructor
 *   workoutLabel(discipline) -> string
 *   displayName(event) -> string  cleaned class name for suggestions
 *   locationIdOf(event) / locationNameOf(event) -> fallbacks when the event lacks them
 */
export function buildSearchIndex(events, opts = {}) {
  const gymNames = opts.gymNames || ((id) => [id || '']);
  const gymLabel = opts.gymLabel || ((id) => gymNames(id)[0] || id || '');
  const workoutLabel = opts.workoutLabel || ((d) => d || '');
  const displayName = opts.displayName || ((e) => e.name || '');
  const entries = [];
  const facets = { instructor: new Map(), class: new Map(), location: new Map(), gym: new Map(), workout: new Map() };
  const bump = (map, key, make) => {
    const cur = map.get(key);
    if (cur) cur.count += 1; else map.set(key, { ...make(), count: 1 });
  };

  for (const e of events || []) {
    if (!e) continue;
    const gymId = e.gymId == null ? '' : String(e.gymId);
    const locId = String(e.locationId ?? opts.locationIdOf?.(e) ?? '');
    const locName = e.locationName || opts.locationNameOf?.(e) || '';
    const workout = workoutLabel(e.discipline);
    const instructors = (e.instructors || []).filter(i => i && i.name);
    const fields = {
      name: normalizeText(`${e.name || ''} ${displayName(e)}`),
      workout: normalizeText(`${e.discipline || ''} ${workout || ''}`),
      instructor: instructors.map(i => normalizeText(i.name)),
      location: normalizeText(`${locName} ${e.studioName || ''}`),
      gym: gymNames(gymId).map(normalizeText),
    };
    entries.push({ key: `${gymId}:${e.id}`, event: e, fields, hays: [fields.name, fields.workout, ...fields.instructor, fields.location, ...fields.gym] });

    for (const i of instructors) {
      bump(facets.instructor, `${gymId}:${i.id}`, () => ({ type: 'instructor', id: String(i.id), gymId, label: i.name, sub: gymLabel(gymId), hay: [normalizeText(i.name)], ctx: fields.gym }));
    }
    const cn = displayName(e) || e.name;
    if (cn) {
      // Same class name at two gyms is one suggestion: the search text is gym-free.
      bump(facets.class, normalizeText(cn), () => ({ type: 'class', id: normalizeText(cn), label: cn, hay: [normalizeText(cn)] }));
    }
    if (locId && locName) {
      bump(facets.location, `${gymId}:${locId}`, () => ({ type: 'location', id: locId, gymId, label: locName, sub: gymLabel(gymId), hay: [normalizeText(locName)], ctx: fields.gym }));
    }
    if (gymId) {
      bump(facets.gym, gymId, () => ({ type: 'gym', id: gymId, gymId, label: gymLabel(gymId), hay: fields.gym }));
    }
    if (workout) {
      bump(facets.workout, normalizeText(workout), () => ({ type: 'workout', id: workout, label: workout, hay: [normalizeText(workout)] }));
    }
  }
  return { entries, facets };
}

/** Event predicate: every token matches some field. No tokens = matches all. */
export function entryMatches(entry, tokens) {
  return tokens.length === 0 || allTokensIn(tokens, entry.hays);
}

/** Chronological (by startAt instant) list of matching events. */
export function searchEvents(index, q) {
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  return index.entries.filter(en => entryMatches(en, tokens)).map(en => en.event)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

/**
 * Grouped suggestions for the typed text. Each: { type, id, gymId?, label, sub?, count }.
 * Groups come back in SUGGESTION_GROUPS order, empty groups omitted, capped per group.
 * `count` = upcoming classes in the index carrying that value.
 */
export function suggest(index, q, { perGroup = PER_GROUP } = {}) {
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  const first = tokens[0];
  const groups = [];
  for (const type of SUGGESTION_GROUPS) {
    const hits = [];
    for (const f of index.facets[type].values()) {
      // A gym name may help a word match ("george <gym name>") but never carries a
      // suggestion alone: "boxing" must not surface every instructor at JAB Boxing.
      const ctx = f.ctx || [];
      if (!allTokensIn(tokens, [...f.hay, ...ctx])) continue;
      if (ctx.length && !tokens.some(t => f.hay.some(h => h.includes(t)))) continue;
      hits.push({ ...f, _rank: f.hay[0]?.startsWith(first) || f.hay[0]?.split(' ').some(w => w.startsWith(first)) ? 0 : 1 });
    }
    hits.sort((a, b) => a._rank - b._rank || b.count - a.count || a.label.localeCompare(b.label));
    if (hits.length) groups.push({ type, items: hits.slice(0, perGroup).map(({ hay, ctx, _rank, ...rest }) => rest) });
  }
  return groups;
}

/** Group a chronological event list by its day key (caller supplies zone-aware dayKey). */
export function groupByDay(events, dayKeyOf) {
  const out = [];
  for (const e of events) {
    const k = dayKeyOf(e);
    const last = out[out.length - 1];
    if (last && last.day === k) last.events.push(e); else out.push({ day: k, events: [e] });
  }
  return out;
}
