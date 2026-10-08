// U4-19 phases 4-5: pure mapping between the timetable's in-memory filter state
// and the URL's timetable params (url-state.js), plus the overlay write-guard.
// No DOM, no history. timetable.js owns the state; this owns the translation.
//
// State shape (what timetable.js holds):
//   gyms: ['jab']                      gym config ids
//   locations: ['12']                  BARE location ids (the URL carries `gym:id`)
//   instructors: ['jab:7']             already `gymId:id` tokens
//   eventTypes: ['Ride']               discipline LABELS, gym-agnostic (the URL carries `gym:slug`)
//   bookmarks: false
//
// ctx (from metadata, only valid once metadata has loaded):
//   { linkedGymIds: string[], locations: [{id,gymId,name}], instructors: [{id,gymId,name}],
//     workouts: [{label, gymId}], gymName(id), locationName(loc) }

export function slug(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const asSet = (a) => new Set((a || []).map(String));
export function sameList(a, b) {
  const x = asSet(a), y = asSet(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

export function emptyFilterState() {
  return { gyms: [], locations: [], instructors: [], eventTypes: [], bookmarks: false };
}

export function sameFilters(a, b) {
  const x = { ...emptyFilterState(), ...(a || {}) };
  const y = { ...emptyFilterState(), ...(b || {}) };
  return sameList(x.gyms, y.gyms) && sameList(x.locations, y.locations)
    && sameList(x.instructors, y.instructors) && sameList(x.eventTypes, y.eventTypes)
    && !!x.bookmarks === !!y.bookmarks;
}

export function filtersEmpty(s) { return sameFilters(s, emptyFilterState()); }

/** Saved-defaults blob (localStorage shape) -> filter state. */
export function savedToState(saved) {
  const s = saved || {};
  return {
    gyms: [...(s.gyms || [])].map(String), locations: [...(s.locations || [])].map(String),
    instructors: [...(s.instructors || [])].map(String), eventTypes: [...(s.eventTypes || [])].map(String),
    bookmarks: !!(s.showBookmarksOnly ?? s.bookmarks),
  };
}

/**
 * Filter state -> the `timetable` object url-state.serializeState takes.
 * State equal to the saved defaults emits NO filter params ("use saved defaults");
 * an empty state under non-empty saved defaults emits `f=all`.
 */
export function stateToUrlTimetable(state, ctx, { day = null, defaultDay = null, saved = emptyFilterState(), q = '' } = {}) {
  const st = { ...emptyFilterState(), ...(state || {}) };
  const t = { day: day && day !== defaultDay ? day : null, gyms: [], locations: [], types: [], instructors: [], fav: false, q: String(q || ''), explicit: false };
  if (sameFilters(st, saved)) return t;
  t.gyms = st.gyms.map(String);
  const gymOfLoc = (id) => (ctx.locations || []).find((l) => String(l.id) === String(id))?.gymId;
  t.locations = st.locations.map((id) => { const g = gymOfLoc(id); return g ? `${g}:${id}` : null; }).filter(Boolean);
  t.instructors = st.instructors.map(String);
  t.types = st.eventTypes.map((label) => {
    const have = (ctx.workouts || []).filter((w) => w.label === label);
    if (!have.length) return null;
    const prefer = have.find((w) => st.gyms.includes(String(w.gymId))) || have[0];
    return `${prefer.gymId}:${slug(label)}`;
  }).filter(Boolean);
  t.fav = !!st.bookmarks;
  t.explicit = filtersEmpty(st) && !filtersEmpty(saved);
  return t;
}

/**
 * Parsed URL timetable params -> filter state to apply.
 * Returns { usesDefaults, state, day, dropped: string[], ignoredGyms: string[] }.
 * Unknown ids are dropped (never fatal); unlinked gyms are ignored and reported.
 */
export function urlToState(t, ctx) {
  const p = t || {};
  const none = !(p.gyms?.length || p.locations?.length || p.types?.length || p.instructors?.length || p.fav || p.q || p.explicit);
  const out = { usesDefaults: none, state: emptyFilterState(), day: p.day || null, q: String(p.q || ''), dropped: [], ignoredGyms: [] };
  if (none) return out;
  const linked = asSet(ctx.linkedGymIds);
  const ok = (g) => linked.has(String(g));

  for (const g of p.gyms || []) (ok(g) ? out.state.gyms.push(String(g)) : out.ignoredGyms.push(String(g)));
  for (const tok of p.locations || []) {
    const i = tok.indexOf(':'); const g = tok.slice(0, i); const id = tok.slice(i + 1);
    if (ok(g) && (ctx.locations || []).some((l) => String(l.gymId) === g && String(l.id) === id)) out.state.locations.push(id);
    else out.dropped.push(tok);
  }
  for (const tok of p.instructors || []) {
    const i = tok.indexOf(':'); const g = tok.slice(0, i); const id = tok.slice(i + 1);
    if (ok(g) && (ctx.instructors || []).some((x) => String(x.gymId) === g && String(x.id) === id)) out.state.instructors.push(`${g}:${id}`);
    else out.dropped.push(tok);
  }
  for (const tok of p.types || []) {
    const i = tok.indexOf(':'); const g = tok.slice(0, i); const sl = tok.slice(i + 1);
    const w = ok(g) ? (ctx.workouts || []).find((x) => String(x.gymId) === g && slug(x.label) === sl) : null;
    if (w) { if (!out.state.eventTypes.includes(w.label)) out.state.eventTypes.push(w.label); } else out.dropped.push(tok);
  }
  out.state.bookmarks = !!p.fav;
  // A link whose every gym is unlinked and that names nothing else would apply "no filter":
  // that is still the user's explicit reading of the link, so keep it (banner shows nothing to clear).
  return out;
}

/** Human labels for the banner, in the order gym, location, workout, instructor, favourites. */
export function overlayLabels(state, ctx, q = '') {
  const st = { ...emptyFilterState(), ...(state || {}) };
  const out = [];
  st.gyms.forEach((g) => out.push(ctx.gymName ? ctx.gymName(g) : g));
  st.locations.forEach((id) => { const l = (ctx.locations || []).find((x) => String(x.id) === String(id)); out.push(l ? (ctx.locationName ? ctx.locationName(l) : l.name) : id); });
  st.eventTypes.forEach((l) => out.push(l));
  st.instructors.forEach((tok) => {
    const i = tok.indexOf(':');
    const ins = (ctx.instructors || []).find((x) => String(x.gymId) === tok.slice(0, i) && String(x.id) === tok.slice(i + 1));
    out.push(ins?.name || tok.slice(i + 1));
  });
  if (st.bookmarks) out.push(ctx.favouritesLabel || 'Favourites');
  if (q) out.push(ctx.searchLabel ? ctx.searchLabel(q) : `Search: ${q}`);
  return out;
}

/**
 * The ONLY write path for saved defaults. An overlay (filters that arrived from a
 * URL) is never persisted. Returns true when written.
 */
export function guardedSaveDefaults(storage, key, filters, overlayActive) {
  if (overlayActive) return false;
  storage.setItem(key, JSON.stringify(filters));
  return true;
}
