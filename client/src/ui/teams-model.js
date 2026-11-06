// T-1 Teams (PLAN-teams.md §5.2, §5.5, §5.6, §5.7): pure helpers for the Teams UI.
// No DOM, no network: everything here is unit tested in teams-model.test.js.
//
// Privacy note: the server projects, the client displays (§2 principle 1). Nothing in
// this module filters data the viewer has already received; it only orders, groups and
// labels what the server chose to send.

// ---- avatars (§5.5) -------------------------------------------------------------------

/**
 * The server assigns each member a colour index (0..15, unique within a Team). This is
 * the fixed palette it indexes: every colour carries white initials at >= 4.5:1 (WCAG AA
 * for small text) and stays visible on the dark surface, so one palette serves both
 * themes. Pinned by teams-model.test.js; styles.css mirrors it as .tm-av-c0..c15.
 */
export const AVATAR_PALETTE = Object.freeze([
  '#a8553a', '#2e7d6b', '#6b4fa3', '#8a5c00', '#3b6aa0', '#a3425f', '#4a7329', '#5a5f6b',
  '#9c4a8a', '#00758f', '#b03a48', '#4c5fb0', '#7a6420', '#2f7a4b', '#55707f', '#6a5acd',
]);

export function avatarColourIndex(index) {
  const n = Number.isInteger(index) ? index : Number.parseInt(index, 10);
  if (!Number.isFinite(n)) return 0;
  const size = AVATAR_PALETTE.length;
  return ((n % size) + size) % size;
}

/** "Sam" -> "S", "Sam B." -> "SB", "Sam Bland Smith" -> "SS" (first + last). Unicode-safe; never empty. */
export function initials(name, max = 2) {
  const words = String(name ?? '').trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  // First and last name (a middle name never wins a slot); one word falls back to one letter.
  const picked = max >= 2 && words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  const letters = picked.map((w) => Array.from(w)[0].toLocaleUpperCase());
  return letters.join('') || '?';
}

// ---- Teams list ordering (§5.2) ---------------------------------------------------------

/** Pinned first; otherwise keep the server's order (stable). */
export function orderTeams(teams) {
  const list = Array.isArray(teams) ? teams : [];
  return [...list.filter((t) => t && t.pinned), ...list.filter((t) => t && !t.pinned)];
}

export const PIN_MIN_TEAMS = 4; // "more than 3 Teams"
export const PIN_MAX = 2;

/** Pinning is offered only to members of more than 3 Teams (§5.2). */
export function canOfferPin(teamCount) {
  return Number(teamCount) >= PIN_MIN_TEAMS;
}

export function pinsUsed(teams) {
  return (Array.isArray(teams) ? teams : []).filter((t) => t && t.pinned).length;
}

/** Whether the pin control for `team` should be enabled (unpin always is). */
export function canTogglePin(team, teams) {
  if (!team) return false;
  if (team.pinned) return true;
  return canOfferPin((teams || []).length) && pinsUsed(teams) < PIN_MAX;
}

// ---- Members widget (§5.3 item 5) ---------------------------------------------------------

export const SORT_MODES = Object.freeze(['name', 'activity', 'shuffle']);
export const DEFAULT_SORT = 'name';
export const MEMBERS_PER_PAGE = 4;

function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let a = hashString(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  || String(a.memberRef || '').localeCompare(String(b.memberRef || ''));

/**
 * Order members for the widget. `activity` sorts by `activityOf(member)` descending
 * (T-2 supplies real counts; until then every member counts 0 and the name order
 * decides). `shuffle` is deterministic for a given seed so a re-render does not jump.
 */
export function sortMembers(members, mode = DEFAULT_SORT, { seed = '', activityOf = () => 0 } = {}) {
  const list = (Array.isArray(members) ? members : []).filter(Boolean);
  if (mode === 'activity') {
    return [...list].sort((a, b) => (Number(activityOf(b)) || 0) - (Number(activityOf(a)) || 0) || byName(a, b));
  }
  if (mode === 'shuffle') {
    const out = [...list].sort(byName);
    const rnd = seededRandom(seed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  return [...list].sort(byName);
}

export function paginate(list, size = MEMBERS_PER_PAGE) {
  const items = Array.isArray(list) ? list : [];
  const n = Math.max(1, Math.floor(size) || 1);
  const pages = [];
  for (let i = 0; i < items.length; i += n) pages.push(items.slice(i, i + n));
  return pages;
}

const sortKey = (teamId) => `appTeamMemberSort:${teamId}`;

/** The member's remembered sort for this Team (client-side, §5.3). Storage may be blocked. */
export function readSortChoice(storage, teamId) {
  try {
    const v = storage?.getItem(sortKey(teamId));
    return SORT_MODES.includes(v) ? v : DEFAULT_SORT;
  } catch (_) {
    return DEFAULT_SORT;
  }
}

export function writeSortChoice(storage, teamId, mode) {
  if (!SORT_MODES.includes(mode)) return false;
  try {
    storage?.setItem(sortKey(teamId), mode);
    return true;
  } catch (_) {
    return false;
  }
}

// ---- Sharing sheet (§3) -------------------------------------------------------------------

/** The D3 defaults the consent sheet starts from (mirrors server/team-sharing.js). */
export function defaultShare() {
  return { gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true, spots: false, autoBookQueue: false, competition: false };
}

/** The toggle rows, in sheet order. `optIn` rows are off by default (§3). */
export const SHARE_ROWS = Object.freeze([
  Object.freeze({ key: 'upcoming', optIn: false }),
  Object.freeze({ key: 'waitlists', optIn: false }),
  Object.freeze({ key: 'activity', optIn: false }),
  Object.freeze({ key: 'recent', optIn: false }),
  Object.freeze({ key: 'spots', optIn: true }),
  Object.freeze({ key: 'autoBookQueue', optIn: true }),
]);

/**
 * Normalise a share for the sheet. Missing or bad values are PRIVATE, the same fail-safe
 * direction as the server (sharing fails safe by hiding, unlike capability flags).
 */
export function normaliseShare(share) {
  const s = share && typeof share === 'object' ? share : {};
  const out = { gyms: [], upcoming: false, waitlists: false, activity: false, recent: false, spots: false, autoBookQueue: false, competition: false };
  if (s.gyms === 'all') out.gyms = 'all';
  else if (Array.isArray(s.gyms)) out.gyms = [...new Set(s.gyms.filter((g) => typeof g === 'string'))];
  for (const k of ['upcoming', 'waitlists', 'activity', 'recent', 'spots', 'autoBookQueue', 'competition']) out[k] = s[k] === true;
  return out;
}

/** Apply one sheet change and return a new share. */
export function applyShareChange(share, change) {
  const s = normaliseShare(share);
  if (!change || typeof change !== 'object') return s;
  if (change.type === 'gymsMode') {
    if (change.mode === 'all') s.gyms = 'all';
    else if (change.mode === 'choose') s.gyms = Array.isArray(change.linked) ? [...change.linked] : [];
    return s;
  }
  if (change.type === 'gym') {
    const cur = s.gyms === 'all' ? [...(change.linked || [])] : [...s.gyms];
    const has = cur.includes(change.gymId);
    s.gyms = change.on && !has ? [...cur, change.gymId] : (!change.on && has ? cur.filter((g) => g !== change.gymId) : cur);
    return s;
  }
  if (change.type === 'toggle' && Object.prototype.hasOwnProperty.call(s, change.key) && change.key !== 'gyms') {
    s[change.key] = !!change.on;
  }
  return s;
}

/**
 * Chips for the "Who can see my classes" overview: { key, on, label? }. `gymLabel` is
 * the caller's label for the gym scope ("All my gyms", "JAB only", "No gyms").
 */
export function shareChips(share) {
  const s = normaliseShare(share);
  const gymScope = s.gyms === 'all' ? 'all' : (s.gyms.length ? 'some' : 'none');
  return [
    { key: 'gyms', on: gymScope !== 'none', scope: gymScope, gymIds: s.gyms === 'all' ? [] : s.gyms },
    ...SHARE_ROWS.map((r) => ({ key: r.key, on: s[r.key] })),
  ];
}

/**
 * How much a member shares, in three bands each (T12 summary line). `gyms`: 'all' | 'some' |
 * 'none' (+ `gymCount`); `info`: 'all' when every toggle row is on, 'none' when none is,
 * else 'some'. Missing or bad values count as private (normaliseShare).
 */
export function sharingLevel(share, linkedCount = 0) {
  const s = normaliseShare(share);
  const gyms = s.gyms === 'all' ? 'all' : (s.gyms.length ? 'some' : 'none');
  const gymCount = s.gyms === 'all' ? Math.max(0, Number(linkedCount) || 0) : s.gyms.length;
  const on = SHARE_ROWS.filter((r) => s[r.key]).length;
  const info = on === 0 ? 'none' : (on === SHARE_ROWS.length ? 'all' : 'some');
  return { gyms, gymCount, info, nothing: gyms === 'none' || info === 'none' };
}

/**
 * Why the Team notifications switch is disabled, or null when it is usable. Hidden wins over
 * device: a hidden member gets nothing whatever the device state.
 * @returns {null | 'hidden' | 'device'}
 */
export function notificationsDisabledReason({ hidden = false, pushReady = true } = {}) {
  if (hidden) return 'hidden';
  if (!pushReady) return 'device';
  return null;
}

// ---- Pause (§3, §5.7) ----------------------------------------------------------------------

export const PAUSE_OPTIONS = Object.freeze(['24h', '7d', 'indefinite']);

/** The server stores "until undone" as the year 9999. */
export function isIndefinitePause(pausedUntil) {
  return typeof pausedUntil === 'string' && pausedUntil.startsWith('9999');
}

/**
 * Which pause option a current pause corresponds to. The server stores only the end time,
 * so this reads the remaining time: up to 24 h -> '24h', up to 7 days -> '7d'.
 */
export function pauseOptionFor(pausedUntil, now = Date.now()) {
  if (!pausedUntil) return null;
  if (isIndefinitePause(pausedUntil)) return 'indefinite';
  const left = Date.parse(pausedUntil) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const slack = 5 * 60 * 1000;
  if (left <= 24 * 3600 * 1000 + slack) return '24h';
  if (left <= 7 * 24 * 3600 * 1000 + slack) return '7d';
  return null;
}

// ---- Routes (§5.6) -----------------------------------------------------------------------

// Server ids and tokens are base64url (server/teams.js randomId): case matters, so these
// are matched BEFORE url-state.js lower-cases the path.
const TEAM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function isTeamId(v) { return typeof v === 'string' && TEAM_ID_RE.test(v); }
export function isInviteToken(v) { return typeof v === 'string' && TOKEN_RE.test(v); }

/**
 * '/teams' -> { view: 'list' }, '/teams/<id>' -> { view: 'team', teamId },
 * '/t/<token>' -> { view: 'invite', token }. Anything else -> null.
 */
export function parseTeamsPath(pathname) {
  let p = String(pathname || '');
  p = p.split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (/^\/teams$/i.test(p)) return { view: 'list' };
  let m = /^\/teams\/([^/]+)$/i.exec(p);
  if (m) return isTeamId(m[1]) ? { view: 'team', teamId: m[1] } : { view: 'list' };
  m = /^\/t\/([^/]+)$/i.exec(p);
  if (m && isInviteToken(m[1])) return { view: 'invite', token: m[1] };
  return null;
}

export function teamsPathFor(route) {
  if (route && route.view === 'team' && isTeamId(route.teamId)) return `/teams/${route.teamId}`;
  if (route && route.view === 'invite' && isInviteToken(route.token)) return `/t/${route.token}`;
  return '/teams';
}

/** Rebuild an invite URL on the current origin from whatever the server returned. */
export function inviteUrlOn(origin, urlOrToken) {
  let token = null;
  if (isInviteToken(urlOrToken)) token = urlOrToken;
  else {
    try {
      const parsed = parseTeamsPath(new URL(String(urlOrToken)).pathname);
      if (parsed && parsed.view === 'invite') token = parsed.token;
    } catch (_) { /* not a URL */ }
  }
  return token ? `${String(origin || '').replace(/\/+$/, '')}/t/${token}` : null;
}

// ---- Pending invite across the auth flow (§5.6 step 2) -------------------------------------

export const TEAMS_HOME_PATH = '/teams';
const PENDING_KEY = 'appPendingTeamInvite';
export const PENDING_TTL_MS = 60 * 60 * 1000;

/**
 * Remember an invite token while the visitor logs in or signs up (onboarding can span an
 * iOS install relaunch, which loses sessionStorage, hence localStorage with a short TTL).
 * Only a well-formed token is stored; it is never logged.
 */
export function stashPendingInvite(storage, token, now = Date.now()) {
  if (!isInviteToken(token)) return false;
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify({ t: token, at: now }));
    return true;
  } catch (_) {
    return false;
  }
}

/** Read without clearing. Expired or malformed entries are removed and read as null. */
export function peekPendingInvite(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && isInviteToken(v.t) && Number.isFinite(v.at) && now - v.at >= 0 && now - v.at < PENDING_TTL_MS) return v.t;
    storage.removeItem(PENDING_KEY);
  } catch (_) {
    try { storage?.removeItem(PENDING_KEY); } catch (_e) { /* blocked */ }
  }
  return null;
}

/** Read AND remove: the stored token is single-use once it has been acted on. */
export function consumePendingInvite(storage, now = Date.now()) {
  const t = peekPendingInvite(storage, now);
  clearPendingInvite(storage);
  return t;
}

export function clearPendingInvite(storage) {
  try { storage?.removeItem(PENDING_KEY); } catch (_) { /* blocked */ }
}

// ---- Input validation (mirrors server/teams.js cleanName / cleanEmoji) ----------------------

export const TEAM_NAME_MAX = 40;

export function validateTeamName(name) {
  const v = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, error: 'required' };
  if (Array.from(v).length > TEAM_NAME_MAX || v.length > TEAM_NAME_MAX) return { ok: false, error: 'tooLong' };
  if (/[<>]/.test(v)) return { ok: false, error: 'angle' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'required' };
  return { ok: true, value: v };
}

export function validateEmoji(emoji) {
  const v = String(emoji ?? '').trim();
  if (!v) return { ok: true, value: null };
  const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v)].length
    : Array.from(v).length;
  if (v.length > 16 || graphemes !== 1 || !/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u.test(v)) {
    return { ok: false, error: 'emoji' };
  }
  return { ok: true, value: v };
}

// ---- Invite page state (§5.6) ----------------------------------------------------------------

/** Server myRequestStatus -> the page to show. Unknown values read as a fresh invite. */
export function invitePageState(preview) {
  const s = preview && preview.myRequestStatus;
  if (s === 'member') return 'member';
  if (s === 'pending') return 'pending';
  if (s === 'notMember') return 'notMember';
  return 'invite'; // 'none' and 'expired' both offer Request to join again
}

/**
 * For an existing member the preview carries `teamId` (server/teams.js previewInvite), which is
 * exact. FALLBACK for an older server that omits it: match the member's own Team list by
 * name + emoji, accepted only when that is unambiguous (two Teams can share both).
 */
export function resolveMemberTeamId(preview, teams) {
  if (preview && isTeamId(preview.teamId)) return preview.teamId;
  const list = Array.isArray(teams) ? teams : [];
  const m = list.filter((t) => preview && t.name === preview.name && (t.emoji || null) === (preview.emoji || null));
  return m.length === 1 ? m[0].id : null;
}

// ---- Time labels --------------------------------------------------------------------------

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago". `labels` supplies the words. */
export function relativeTime(iso, now = Date.now(), labels = {}) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  const L = { now: 'just now', min: '{n} min ago', hour: '{n} h ago', yesterday: 'yesterday', days: '{n} days ago', ...labels };
  const fill = (s, n) => s.replace('{n}', String(n));
  if (mins < 1) return L.now;
  if (mins < 60) return fill(L.min, mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return fill(L.hour, hours);
  const days = Math.round(hours / 24);
  if (days <= 1) return L.yesterday;
  return fill(L.days, days);
}
