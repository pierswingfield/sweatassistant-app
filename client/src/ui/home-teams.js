// T-5 Home widget "Your Teams today" (PLAN-teams.md §5.3): the top two Teams' today lines,
// as on the Teams list (§5.2): "3 classes today · 1 done", "Rest day · Tomorrow: John doing
// 08:30 Train", and so on. It reads GET /api/teams, the list projection the Teams tab
// already uses, so it adds no new field and no new privacy surface: the server decided
// every line, and teams-today.js only words it. Text is escaped by segmentsHtml.

import { orderTeams } from './teams-model.js';
import { todayLineSegments, segmentsText } from './teams-today.js';

export const HOME_TEAMS_MAX = 2;

/**
 * Pure: the list payload -> the rows the widget shows (pinned first, then the server's
 * order: soonest shared class). `when` is teams-ui.whenOf, injected for tests.
 */
export function homeTeamsModel(list, { when, copy, max = HOME_TEAMS_MAX } = {}) {
  const teams = orderTeams(Array.isArray(list) ? list : []).filter((t) => t && typeof t.id === 'string');
  return teams.slice(0, max).map((t) => {
    const segments = t.paused ? [{ text: copy.hiddenFromTeam, muted: true }] : todayLineSegments(t.today, when, copy);
    return {
      id: t.id,
      name: t.name,
      emoji: t.emoji || null,
      paused: !!t.paused,
      mascot: t.mascot || null,
      segments,
      text: segmentsText(segments),
    };
  });
}

/** DOM: rows (or nothing). `ui` carries the teams-ui helpers so this module stays light. */
export function renderHomeTeams(el, rows, { ui, onOpen }) {
  const { T, fmt, mascotHtml, teamTitleText, segmentsHtml, escapeHtml } = ui;
  const list = document.createElement('div');
  list.className = 'home-teams-list';
  list.innerHTML = rows.map((r) => `<a class="home-team-row" href="/teams/${encodeURIComponent(r.id)}" data-home-team="${escapeHtml(r.id)}"
      aria-label="${escapeHtml(`${fmt(T.homeOpenAria, { name: teamTitleText(r) })}. ${r.text}`)}">
      ${mascotHtml({ size: 44, dim: r.paused, mascot: r.mascot })}
      <span class="home-team-text">
        <span class="home-team-name">${escapeHtml(teamTitleText(r))}</span>
        <span class="home-team-line">${segmentsHtml(r.segments)}</span>
      </span>
    </a>`).join('');
  list.querySelectorAll('[data-home-team]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    onOpen(a.getAttribute('data-home-team'));
  }));
  el.appendChild(list);
}

export function renderHomeTeamsEmpty(el, { ui, onCreate }) {
  const { T, escapeHtml } = ui;
  const box = document.createElement('div');
  box.className = 'home-teams-empty';
  box.innerHTML = `<p>${escapeHtml(T.homeEmpty)}</p><button type="button" class="tm-btn tm-btn-pill" data-home-team-create>${escapeHtml(T.homeCreate)}</button>`;
  box.querySelector('[data-home-team-create]').addEventListener('click', onCreate);
  el.appendChild(box);
}
