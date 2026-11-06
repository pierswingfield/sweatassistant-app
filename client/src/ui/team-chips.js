// T-5 timetable Team chips (PLAN-teams.md §5.3, mock-up 08-timetable-teammates).
//
// A row for a class teammates are booked into carries one chip: the first Team's
// teammates as an overlapping avatar stack (the filter rail's gym-logo stack: 26 px
// circles at an 8 px pitch, leftmost on top, no masking ring) then the Team name, and
// "+1" when more Teams have someone there. Tapping the chip expands the row's detail:
// one line per Team with the teammates' names, and a teammate's spot ("Ana · Bike 14") only
// when the server attached it: D13 (ii), the viewer is in that same class (team-projection.js).
//
// The server decides everything (GET /api/teams/timetable runs the Team projection once
// for all the viewer's Teams); nothing here filters what it sent. The index is keyed
// gym-qualified (`gymId:eventId`, WP-G) and fetched ONCE per timetable load, never per row.
// Every Team or member string is escaped before it reaches innerHTML.

import { COPY, formatCopyText } from '../copy.js';
import { escapeHtml } from './cards.js';
import { avatarColourIndex, initials } from './teams-model.js';

const T = COPY.teams;
const fmt = (template, values) => formatCopyText(template, values);
export const CHIP_STACK_MAX = 3;
export const CHIP_TTL_MS = 2 * 60 * 1000;

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:.{1,128}$/;
const isStr = (v) => typeof v === 'string' && v.length > 0;

/** Pure: the server payload -> Map(`gymId:eventId` -> teams[]). Malformed entries are dropped. */
export function buildChipIndex(payload) {
  const out = new Map();
  const classes = payload && Array.isArray(payload.classes) ? payload.classes : [];
  for (const c of classes) {
    if (!c || !isStr(c.key) || !KEY_RE.test(c.key) || !Array.isArray(c.teams)) continue;
    const teams = c.teams
      .filter((t) => t && isStr(t.teamId) && isStr(t.name) && Array.isArray(t.members) && t.members.length)
      .map((t) => ({
        teamId: t.teamId,
        name: t.name,
        emoji: isStr(t.emoji) ? t.emoji : null,
        pinned: t.pinned === true,
        members: t.members.filter((m) => m && isStr(m.name)).map((m) => ({
          name: m.name, colourIndex: m.colourIndex, ...(isStr(m.spot) ? { spot: m.spot } : {}),
        })),
      }))
      .filter((t) => t.members.length);
    if (teams.length) out.set(c.key, teams);
  }
  return out;
}

export const chipKey = (event) => (event && event.gymId && event.id != null ? `${event.gymId}:${event.id}` : '');

/** "Ana", "Ana and Sam", "Ana, Sam and Tom", "Ana, Sam and 2 more". */
export function namesText(names, max = 3) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} ${T.ttAnd} ${list[list.length - 1]}`;
  return `${list.slice(0, max - 1).join(', ')} ${T.ttAnd} ${fmt(T.ttMore, { count: list.length - (max - 1) })}`;
}

const teamLabel = (t) => (t.emoji ? `${t.emoji} ${t.name}` : t.name);

/**
 * Pure: what one row's chip shows. Teams arrive ordered by pin, then name (server).
 * @returns {null | { label, more, avatars: {initials, colour}[], aria, detail: {team, names}[] }}
 */
export function chipModel(teams) {
  if (!Array.isArray(teams) || !teams.length) return null;
  const first = teams[0];
  const more = teams.length - 1;
  const avatars = first.members.slice(0, CHIP_STACK_MAX).map((m) => ({ initials: initials(m.name, 2, m.lastInitial), colour: avatarColourIndex(m.colourIndex) }));
  const detail = teams.map((t) => ({ team: teamLabel(t), names: namesText(t.members.map((m) => (m.spot ? `${m.name}${T.spotSep}${m.spot}` : m.name)), 8) }));
  const firstNames = namesText(first.members.map((m) => m.name));
  const aria = more > 0
    ? fmt(T.ttChipAriaMore, { team: teamLabel(first), names: firstNames, count: more })
    : fmt(T.ttChipAria, { team: teamLabel(first), names: firstNames });
  return { label: teamLabel(first), more, avatars, aria, detail };
}

/** Escaped markup for a row's chip line (empty string when no teammates). */
export function teamChipHtml(teams) {
  const m = chipModel(teams);
  if (!m) return '';
  const stack = m.avatars.map((a, i) => `<span class="tt-av tm-av-c${a.colour}" style="z-index:${m.avatars.length - i}">${escapeHtml(a.initials)}</span>`).join('');
  const more = m.more > 0 ? `<b class="tt-team-more">${escapeHtml(fmt(T.ttChipMore, { count: m.more }))}</b>` : '';
  const detail = m.detail.map((d) => `<div><strong>${escapeHtml(d.team)}</strong>: ${escapeHtml(d.names)}</div>`).join('');
  return `<div class="tt-team-line">
    <button type="button" class="tt-team-badge" data-tt-team-chip aria-expanded="false" aria-label="${escapeHtml(m.aria)}" title="${escapeHtml(T.ttChipShow)}">
      <span class="tt-stack" aria-hidden="true">${stack}</span><span class="tt-team-name">${escapeHtml(m.label)}</span>${more}
    </button>
    <div class="tt-team-detail" hidden>${detail}</div>
  </div>`;
}

/** Wire the chip's expand/collapse inside `root` (a row or card). Null-safe. */
export function wireTeamChip(root) {
  const btn = root && root.querySelector('[data-tt-team-chip]');
  if (!btn) return;
  const panel = btn.parentElement && btn.parentElement.querySelector('.tt-team-detail');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (panel) panel.hidden = !open;
  });
}

// ---- the per-load index (one request, cached briefly) ---------------------------------------

let index = new Map();
let loadedAt = 0;
let inflight = null;
let signature = '';
// T-5 review: a reset (gym-set change, sign-out) bumps the generation, so a request
// started before it can never land afterwards and repaint the old account's or old gym
// set's teammates.
let generation = 0;

export function chipsFor(event) { return index.get(chipKey(event)) || null; }
export function resetTeamChips() { generation++; index = new Map(); loadedAt = 0; signature = ''; inflight = null; }

// A 401 sign-out shows the login screen without a reload; the next account on this page
// must not see the previous account's teammates for the rest of the TTL.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('app-logout-triggered', () => resetTeamChips());
}

/**
 * Fetch the index unless it is fresh. Resolves true when its content changed (the caller
 * repaints). Failure keeps the last index: chips are a hint, never a blocker.
 */
export function loadTeamChips(fetchChips, { force = false, now = Date.now() } = {}) {
  if (!force && loadedAt && now - loadedAt < CHIP_TTL_MS) return Promise.resolve(false);
  if (inflight) return inflight;
  const gen = generation;
  const p = Promise.resolve()
    .then(() => fetchChips())
    .then((payload) => {
      if (gen !== generation) return false; // reset while in flight: drop the stale answer
      const next = buildChipIndex(payload);
      const sig = JSON.stringify([...next.entries()]);
      const changed = sig !== signature;
      index = next;
      signature = sig;
      loadedAt = Date.now();
      return changed;
    })
    .catch(() => false)
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}
