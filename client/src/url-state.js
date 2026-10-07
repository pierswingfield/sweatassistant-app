// U4-19: pure URL <-> app-state mapping (no DOM, no history). Clean paths:
//   /  /timetable  /bookings  /auto-book  /credits  /settings[/:section]
// Lenient on input (never throws, drops malformed tokens), stable on output.

export const TAB_TO_PATH = {
  'home': '/',
  'class-timetable': '/timetable',
  'my-bookings': '/bookings',
  'auto-book': '/auto-book',
  'buy-credits': '/credits',
  'settings': '/settings',
};
const PATH_TO_TAB = Object.fromEntries(Object.entries(TAB_TO_PATH).map(([t, p]) => [p, t]));

export const MAX_LIST = 50;
export const MAX_Q = 100;
const GYM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECTION_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function emptyTimetable() {
  return { day: null, gyms: [], locations: [], types: [], instructors: [], fav: false, q: '', explicit: false };
}

export function isValidIsoDay(s) {
  const m = DAY_RE.exec(String(s || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function splitList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function dedupeCap(arr) {
  return [...new Set(arr)].slice(0, MAX_LIST);
}
function gymList(raw) {
  return dedupeCap(splitList(raw).filter((t) => GYM_RE.test(t)));
}
/** `gymId:id` tokens. Split on the FIRST colon, so ids may themselves contain colons. Bare ids rejected. */
export function splitScoped(token) {
  const s = String(token);
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const gym = s.slice(0, i);
  const id = s.slice(i + 1);
  return GYM_RE.test(gym) && ID_RE.test(id) ? { gymId: gym, id } : null;
}
function scopedList(raw) {
  return dedupeCap(splitList(raw).filter((t) => splitScoped(t)));
}
function cleanQ(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
}

function safeParams(search) {
  try { return new URLSearchParams(String(search || '')); } catch { return new URLSearchParams(); }
}

/**
 * -> { tab, section, valid, timetable }. `valid` is false for an unknown path
 * (callers fall back to Home). Timetable params apply to /timetable only.
 */
export function parseLocation(pathname, search = '') {
  const out = { tab: 'home', section: null, valid: true, timetable: emptyTimetable() };
  let p = String(pathname || '/');
  try { p = decodeURI(p); } catch { /* keep raw */ }
  p = p.split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  p = p.toLowerCase();

  const sm = /^\/settings(?:\/([^/]+))?$/.exec(p);
  if (sm) {
    out.tab = 'settings';
    out.section = sm[1] && SECTION_RE.test(sm[1]) ? sm[1] : null;
    return out;
  }
  const tab = Object.prototype.hasOwnProperty.call(PATH_TO_TAB, p) ? PATH_TO_TAB[p] : null;
  if (!tab) { out.valid = false; return out; }
  out.tab = tab;
  if (tab !== 'class-timetable') return out;

  const sp = safeParams(search);
  const t = out.timetable;
  const day = sp.get('day');
  t.day = isValidIsoDay(day) ? day : null;
  t.gyms = gymList(sp.get('gym'));
  t.locations = scopedList(sp.get('loc'));
  t.types = scopedList(sp.get('type'));
  t.instructors = scopedList(sp.get('instructor'));
  t.fav = sp.get('fav') === '1';
  t.q = cleanQ(sp.get('q'));
  const anyFilter = t.gyms.length || t.locations.length || t.types.length || t.instructors.length || t.fav || t.q;
  t.explicit = sp.get('f') === 'all' && !anyFilter;
  return out;
}

/** State -> '/path?query'. Stable param order, defaults omitted. */
export function serializeState(rawState) {
  const state = rawState || {};
  const tab = state.tab && Object.prototype.hasOwnProperty.call(TAB_TO_PATH, state.tab) ? state.tab : 'home';
  if (tab === 'settings') {
    const s = state.section && SECTION_RE.test(state.section) ? state.section : null;
    return s ? `/settings/${s}` : '/settings';
  }
  const base = TAB_TO_PATH[tab];
  if (tab !== 'class-timetable') return base;
  const t = { ...emptyTimetable(), ...(state.timetable || {}) };
  const parts = [];
  const enc = encodeURIComponent;
  let n = 0;
  const list = (key, arr, ok) => {
    const v = dedupeCap((arr || []).map(String).filter(ok));
    if (v.length) parts.push(`${key}=${v.map(enc).join(',')}`);
    n += v.length;
  };
  if (isValidIsoDay(t.day)) parts.push(`day=${t.day}`);
  list('gym', t.gyms, (x) => GYM_RE.test(x));
  list('loc', t.locations, (x) => !!splitScoped(x));
  list('type', t.types, (x) => !!splitScoped(x));
  list('instructor', t.instructors, (x) => !!splitScoped(x));
  if (t.fav) { parts.push('fav=1'); n += 1; }
  const q = cleanQ(t.q);
  if (q) { parts.push(`q=${enc(q)}`); n += 1; }
  if (!n && t.explicit) parts.push('f=all');
  return parts.length ? `${base}?${parts.join('&')}` : base;
}

export function isDeepLink(parsed) {
  if (!parsed) return false;
  const t = parsed.timetable || emptyTimetable();
  return !!(parsed.section || t.day || t.gyms.length || t.locations.length || t.types.length
    || t.instructors.length || t.fav || t.q || t.explicit);
}

export function sameState(a, b) {
  return serializeState(a) === serializeState(b);
}

const LEGACY_SECTIONS = { booking: 'gyms', experience: 'account', advanced: 'account' };
const SETTINGS_SECTIONS = ['general', 'about', 'calendar', 'notifications', 'favourites', 'gyms', 'account'];

/** '#my-bookings' -> '/bookings'. Returns null for anything unrecognised (never invents a route). */
export function legacyHashToPath(hash) {
  const h = String(hash || '').replace(/^#/, '').trim().toLowerCase();
  if (!h) return null;
  if (Object.prototype.hasOwnProperty.call(TAB_TO_PATH, h)) return TAB_TO_PATH[h];
  if (SETTINGS_SECTIONS.includes(h)) return `/settings/${h}`;
  if (Object.prototype.hasOwnProperty.call(LEGACY_SECTIONS, h)) return `/settings/${LEGACY_SECTIONS[h]}`;
  return null;
}

/**
 * Homepage/widget link contract (U4-19, H): `buildTimetableUrl({ gym:['gym-a'],
 * instructor:['gym-a:123'], day:'2026-10-07' })` -> '/timetable?...'. Never hand-concatenate.
 * `type` tokens are `gymId:slug` (slug = lower-case label, e.g. 'gym-a:ride').
 */
export function buildTimetableUrl({ day = null, gym = [], loc = [], type = [], instructor = [], fav = false, q = '', explicit = false } = {}) {
  return serializeState({
    tab: 'class-timetable',
    timetable: { day, gyms: gym, locations: loc, types: type, instructors: instructor, fav, q, explicit },
  });
}
