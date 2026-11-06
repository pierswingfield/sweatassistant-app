// T9 Team card (PLAN-teams.md §5.2): ONE card used by the Teams list and the Home widget.
//
// The whole card is a single link (stretched-link pattern): the anchor holds only
// non-interactive content and its ::after covers the card, so no interactive element is
// nested inside another. Extra controls (pin, Unhide) are SIBLINGS of the anchor, lifted
// above the overlay with z-index.
//
// Hierarchy: name -> member count and role -> today's activity -> next class.
// The next-class line names the class, when and where, and never who is in it (§2
// principle 1: the server already decided what the viewer may see; this only words it).
// Everything interpolated goes through the injected escapeHtml.

import { todayLineSegments, segmentsText } from './teams-today.js';
import { teamAvatarHtml } from './team-avatar.js';

const glyph = (paths) => `<svg class="tcard-glyph" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const CARD_GLYPHS = {
  // a heartbeat trace: today's activity
  activity: glyph('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'),
  // a calendar with a clock hand: the next class
  next: glyph('<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/><path d="M12 12.5v3l2 1.2"/>'),
  // two heads: members
  people: glyph('<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c1-2.9 3.2-4.4 6-4.4s5 1.5 6 4.4"/><path d="M16 5.6a3 3 0 0 1 0 5.8M18.2 15.4c1.5.7 2.5 2 3 4"/>'),
  // a small crown: Captain
  captain: glyph('<path d="m4 8 4.2 4L12 5l3.8 7L20 8l-1.6 10H5.6Z"/><path d="M6 21h12"/>'),
  // an eye with a slash: hidden from this Team
  hidden: glyph('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><path d="M4 4l16 16"/>'),
};

/**
 * Pure: a Team from GET /api/teams -> everything the card shows.
 * `when(startAt, timeZone)` -> { time, day, isToday }; `gymName(gymId)` -> short gym name.
 * @returns {object}
 */
export function teamCardModel(team, { when, copy, gymName = () => '', memberCountLabel }) {
  const t = team || {};
  const paused = !!t.paused;
  const today = t.today || {};
  const activity = paused
    ? [{ text: copy.hiddenFromTeam, muted: true }]
    : todayLineSegments(today, when, copy, { withWho: false });
  let next = null;
  const u = paused ? null : today.upNext;
  if (u && u.startAt && u.className) {
    const w = when(u.startAt, u.timeZone);
    const whenText = w.isToday ? `${copy.weekToday} ${w.time}` : `${w.day} ${w.time}`;
    const gym = (u.gymId && gymName(u.gymId)) || u.locationName || '';
    next = { className: String(u.className), whenText, gym, text: [String(u.className), whenText, gym].filter(Boolean).join(' · ') };
  }
  const avatars = (t.activeToday && t.activeToday.length) ? t.activeToday : (t.members || []);
  const count = Number(t.memberCount) || 0;
  return {
    id: t.id,
    name: String(t.name ?? ''),
    emoji: t.emoji || null,
    paused,
    mascot: t.mascot || null,
    isCaptain: t.myRole === 'captain',
    memberCount: count,
    countLabel: memberCountLabel ? memberCountLabel(count) : String(count),
    avatars,
    activity,
    activityText: segmentsText(activity),
    next,
  };
}

/** The plain-text summary read by assistive tech for the whole card link. */
export function teamCardAria(m, copy, fmt) {
  const parts = [fmt(copy.cardOpenAria, { name: m.name }), m.countLabel];
  if (m.isCaptain) parts.push(copy.captain);
  if (m.activityText) parts.push(m.activityText);
  if (m.next) parts.push(`${copy.cardNextClass}: ${m.next.text}`);
  return parts.join('. ');
}

/**
 * Markup. `ui` = { escapeHtml, mascotHtml, avatarStackHtml, segmentsHtml, copy, fmt }. The Team's
 * identity is the shared Team avatar (T10): name alone, emoji on the avatar's badge.
 * `extras` is raw HTML for sibling controls (already escaped by the caller).
 */
export function teamCardHtml(m, ui, { compact = false, extras = '', attr = 'data-open-team' } = {}) {
  const { escapeHtml, mascotHtml, avatarStackHtml, segmentsHtml, copy, fmt } = ui;
  const meta = `${avatarStackHtml(m.avatars, { max: 4 })}<span class="tcard-count">${escapeHtml(m.countLabel)}</span>${m.isCaptain
    ? `<span class="tcard-role">${CARD_GLYPHS.captain}<span>${escapeHtml(copy.captain)}</span></span>` : ''}`;
  const activityGlyph = m.paused ? CARD_GLYPHS.hidden : CARD_GLYPHS.activity;
  const lines = `<span class="tcard-line tcard-activity">${activityGlyph}<span class="tcard-line-text"><span class="tcard-act">${segmentsHtml(m.activity)}</span></span></span>${m.next
    ? `<span class="tcard-line tcard-next">${CARD_GLYPHS.next}<span class="tcard-line-text"><span class="tcard-next-label">${escapeHtml(copy.cardNextClass)}</span><span class="tcard-next-text"><b>${escapeHtml(m.next.className)}</b> · ${escapeHtml(m.next.whenText)}${m.next.gym ? ` · ${escapeHtml(m.next.gym)}` : ''}</span></span></span>` : ''}`;
  return `<article class="tcard${m.paused ? ' is-paused' : ''}${compact ? ' is-compact' : ''}" data-team="${escapeHtml(m.id)}">
    <a class="tcard-link" href="/teams/${encodeURIComponent(m.id)}" ${attr}="${escapeHtml(m.id)}" aria-label="${escapeHtml(teamCardAria(m, copy, fmt))}">
      <span class="tcard-head">
        ${teamAvatarHtml({ emoji: m.emoji, size: 'sm', dim: m.paused, mascot: m.mascot }, { mascotHtml })}
        <span class="tcard-id">
          <span class="tcard-name">${escapeHtml(m.name)}</span>
          <span class="tcard-meta">${meta}</span>
        </span>
      </span>
      <span class="tcard-lines">${lines}</span>
    </a>
    ${extras}
  </article>`;
}
