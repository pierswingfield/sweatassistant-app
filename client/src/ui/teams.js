// T-1 Teams tab (PLAN-teams.md §5.2 list, §5.3 Team page shell, §5.6 create).
// Routes: /teams (list), /teams/<id> (Team page), /t/<token> (invite page, teams-join.js).
// T-2 brings the list's class summaries; T-3 the dashboard widgets (teams-dashboard.js).
// T-4 adds Team stats (renderTeamStats in teams-dashboard.js, models in teams-stats-model.js).

import { currentRoute } from '../router.js';
import { teamsApi } from '../teams-api.js';
import { escapeHtml } from './cards.js';
import { showToast } from '../main.js';
import { teamCardModel, teamCardHtml } from './teams-card.js';
import { pitchHtml } from './teams-pitch.js';
import { getGymShortName } from '../gym-context.js';
import {
  orderTeams, canOfferPin, canTogglePin, pinsUsed,
  consumePendingInvite, TEAMS_HOME_PATH,
} from './teams-model.js';
import {
  T, fmt, avatarStackHtml, mascotHtml, teamAvatar, teamTitleHtml, memberCountLabel, ICONS,
  errorText, pauseWhen, shareInvite, whenOf, segmentsHtml,
} from './teams-ui.js';

let renderSeq = 0;
const membersCache = new Map(); // teamId -> members (for list avatar stacks); refreshed on every list render
// The invite token lives only in memory once read: the address bar is scrubbed to /teams so the
// secret does not linger in the URL, history entry or a copied link. Cleared on any navigation away.
let activeInvite = null;

/** Drop every piece of Teams state that belongs to the signed-in account (logout). */
export function resetTeamsState() {
  membersCache.clear();
  activeInvite = null;
  renderSeq++; // invalidate in-flight renders
}
if (typeof window !== 'undefined') window.addEventListener('app-logout-triggered', resetTeamsState);

function root() { return document.getElementById('app-teams-root'); }

/** Navigate within the Teams tab (pushes history, re-renders via switchTab). */
export function goTeams(route, { replace = false } = {}) {
  activeInvite = null;
  window.switchTab?.('teams', { teams: route, history: replace ? 'replace' : 'push' });
}

function storage() {
  try { return window.localStorage; } catch (_) { return null; }
}

export async function initTeams() {
  const el = root();
  if (!el) return;
  const route = currentRoute().teams || { view: 'list' };
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  if (route.view === 'invite' || (route.view === 'list' && activeInvite)) {
    consumePendingInvite(storage()); // consumed: the member is signed in and on the page
    const token = route.view === 'invite' ? route.token : activeInvite;
    activeInvite = token;
    if (route.view === 'invite') {
      try { history.replaceState(history.state, '', TEAMS_HOME_PATH); } catch (_) { /* keep the URL */ }
    }
    const { renderInvite } = await import('./teams-join.js');
    if (!stale()) await renderInvite(el, token, { stale });
    return;
  }
  if (route.view === 'team') {
    await renderTeamPage(el, route.teamId, { stale });
    return;
  }
  await renderList(el, { stale });
}

// ---- shared states ---------------------------------------------------------------------------

function loadingHtml() {
  return `<div class="tm-loading" role="status" aria-live="polite"><span class="tm-spinner" aria-hidden="true"></span><span>${escapeHtml(T.loading)}</span></div>`;
}

function errorState(el, message, retry) {
  el.innerHTML = `<section class="tm-card tm-error" role="alert"><p>${escapeHtml(message)}</p><button type="button" class="tm-btn">${escapeHtml(T.retry)}</button></section>`;
  el.querySelector('button').addEventListener('click', retry);
}

// ---- Teams list (§5.2) ------------------------------------------------------------------------

async function renderList(el, { stale }) {
  if (!el.querySelector('.tm-list-page')) el.innerHTML = loadingHtml();
  let teams;
  try {
    teams = (await teamsApi.list()).teams || [];
  } catch (err) {
    if (stale()) return;
    errorState(el, errorText(err, T.loadFailed), () => initTeams());
    return;
  }
  if (stale()) return;
  if (!teams.length) { renderEmpty(el); return; }

  const ordered = orderTeams(teams);
  const offerPin = canOfferPin(teams.length);
  const hasPinned = ordered.some((t) => t.pinned);
  const cardUi = { escapeHtml, mascotHtml, avatarStackHtml, segmentsHtml, copy: T, fmt };
  const card = (t) => {
    // T-2: the list payload carries today's summary and the active-today avatars.
    if (t.members) membersCache.set(t.id, t.members);
    const m = teamCardModel({ ...t, members: t.members || membersCache.get(t.id) || [] }, { when: whenOf, copy: T, gymName: getGymShortName, memberCountLabel });
    const pinControl = offerPin
      ? `<button type="button" class="tm-icon-btn tm-pin${t.pinned ? ' is-on' : ''}" data-pin="${escapeHtml(t.id)}" aria-pressed="${t.pinned ? 'true' : 'false'}" aria-label="${escapeHtml(t.pinned ? T.unpin : fmt(T.pinTeam, { name: t.name }))}" ${canTogglePin(t, teams) ? '' : 'disabled'}>${ICONS.pin}</button>`
      : '';
    const until = t.pausedUntil ? pauseWhen(t.pausedUntil) : null;
    const untilHtml = t.paused ? `<br><span class="tm-muted tm-xs">${escapeHtml(until ? fmt(T.hiddenUntil, { when: until }) : T.hiddenIndefinite)}</span>` : '';
    const hidden = t.paused ? `<div class="tm-hidden-banner">${ICONS.hidden}<span class="tm-grow"><b>${escapeHtml(T.hiddenFromTeam)}</b>${untilHtml}</span><button type="button" class="tm-btn tm-btn-sm" data-unhide="${escapeHtml(t.id)}">${escapeHtml(T.unhide)}</button></div>` : '';
    return teamCardHtml(m, cardUi, { extras: `${pinControl}${hidden}` });
  };
  const pinned = ordered.filter((t) => t.pinned);
  const rest = ordered.filter((t) => !t.pinned);
  el.innerHTML = `<div class="tm-list-page">
    <div class="tm-page-head">
      <h3 class="t-page-title tm-page-title">${escapeHtml(T.myTeamsTitle)}</h3>
      <button type="button" class="tm-btn tm-btn-primary tm-btn-pill" data-create>${escapeHtml(T.createTeam)}</button>
    </div>
    <div class="tm-teams-grid">
      ${hasPinned ? `<p class="tm-list-section">${escapeHtml(T.pinnedSection)}</p>${pinned.map(card).join('')}<p class="tm-list-section">${escapeHtml(T.allSection)}</p>` : ''}
      ${rest.map(card).join('')}
    </div>
    ${offerPin ? `<p class="tm-muted tm-xs tm-pin-help">${escapeHtml(fmt(T.pinHelpUsed, { used: pinsUsed(teams) }))}</p>` : ''}
  </div>`;

  el.querySelector('[data-create]').addEventListener('click', () => openCreateFlow());
  el.querySelectorAll('[data-open-team]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    goTeams({ view: 'team', teamId: a.getAttribute('data-open-team') });
  }));
  el.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', async () => {
    const team = teams.find((t) => t.id === b.getAttribute('data-pin'));
    if (!team) return;
    b.disabled = true;
    try {
      await teamsApi.setPinned(team.id, !team.pinned);
    } catch (err) {
      showToast(errorText(err), 'error');
    }
    initTeams();
  }));
  el.querySelectorAll('[data-unhide]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await teamsApi.updateMe(b.getAttribute('data-unhide'), { pause: null }); } catch (err) { showToast(errorText(err), 'error'); }
    initTeams();
  }));
}

function renderEmpty(el) {
  el.innerHTML = `<div class="tm-list-page">
    <div class="tm-page-head"><h3 class="t-page-title tm-page-title">${escapeHtml(T.title)}</h3></div>
    ${pitchHtml(T, { escapeHtml, mascotHtml })}
  </div>`;
  el.querySelector('[data-create]').addEventListener('click', () => openCreateFlow());
}

// ---- Create (§5.6 step 1; T10 guided flow in teams-create.js) --------------------------------

export async function openCreateFlow() {
  const { openCreateTeamFlow } = await import('./teams-create.js');
  return openCreateTeamFlow({
    onCreated: () => { if (currentRoute().teams?.view === 'list') initTeams(); },
    onGoToTeam: (team) => goTeams({ view: 'team', teamId: team.id }),
  });
}

// ---- Team dashboard (§5.3; T-3 widgets in teams-dashboard.js) ----------------------------------

let dashTimer = null;
let dashListener = null;
function stopDashboardTimers() {
  if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
  if (dashListener) { window.removeEventListener('app-timetable-rendered', dashListener); dashListener = null; }
}

async function renderTeamPage(el, teamId, { stale }) {
  stopDashboardTimers();
  if (!el.querySelector(`.tm-team-page[data-team-id="${CSS.escape(teamId)}"]`)) el.innerHTML = loadingHtml();
  let data;
  let dash;
  try {
    // One projection call (GET /api/teams/:id/today): members, classes, today, mascot.
    [data, dash] = await Promise.all([teamsApi.today(teamId), import('./teams-dashboard.js')]);
  } catch (err) {
    if (stale()) return;
    if (err.status === 404) {
      el.innerHTML = `<section class="tm-card tm-error" role="alert"><p>${escapeHtml(T.teamGone)}</p><button type="button" class="tm-btn">${escapeHtml(T.backToTeams)}</button></section>`;
      el.querySelector('button').addEventListener('click', () => goTeams({ view: 'list' }, { replace: true }));
      return;
    }
    errorState(el, errorText(err, T.loadFailed), () => initTeams());
    return;
  }
  if (stale()) return;
  data.members = data.members || [];
  data.classes = data.classes || [];
  data.recent = data.recent || [];
  const { team } = data;
  const isCaptain = data.myRole === 'captain';
  const pending = isCaptain ? Number(data.pendingRequestCount) || 0 : 0;
  const until = data.paused ? (pauseWhen(data.pausedUntil) ? fmt(T.hiddenUntil, { when: pauseWhen(data.pausedUntil) }) : T.hiddenIndefinite) : '';
  const now = Date.now();
  const hero = dash.heroLines(data, now);
  const mascotAlt = data.mascot
    ? fmt(T.mascotStateAlt, { state: T.mascotStates[data.mascot.state] || data.mascot.state, percent: Math.round((Number(data.mascot.ring) || 0) * 100) })
    : T.mascotAlt;
  const manageAria = pending ? `${T.manageAria}. ${fmt(T.requestsWaiting, { count: pending })}` : T.manageAria;

  el.innerHTML = `<div class="tm-team-page" data-team-id="${escapeHtml(team.id)}">
    <div class="tm-dash-top">
      <a class="tm-back" href="/teams" data-back aria-label="${escapeHtml(T.backAria)}"><span aria-hidden="true">‹</span> ${escapeHtml(T.back)}</a>
      <span class="tm-grow"></span>
      ${isCaptain ? `<button type="button" class="tm-icon-btn tm-head-btn" data-share aria-label="${escapeHtml(T.shareAria)}">${ICONS.share}<span class="tm-head-txt">${escapeHtml(T.share)}</span></button>` : ''}
      <button type="button" class="tm-icon-btn tm-head-btn" data-manage aria-label="${escapeHtml(manageAria)}">${ICONS.manage}<span class="tm-head-txt">${escapeHtml(T.manage)}</span>${pending ? `<span class="tm-count tm-head-count" aria-hidden="true">${pending}</span>` : ''}</button>
    </div>
    <div class="tm-dash">
      <div class="tm-dash-col">
        <section class="tm-card tm-hero">
          ${teamAvatar({ emoji: team.emoji, size: 'lg', dim: data.paused, alt: mascotAlt, mascot: data.mascot || null })}
          <div class="tm-grow tm-min0">
            <h1 class="tm-hero-title">${teamTitleHtml(team)}</h1>
            ${hero.state ? `<p class="tm-hero-state">${escapeHtml(hero.state)}</p>` : ''}
            <p class="tm-muted tm-sm tm-hero-sub">${escapeHtml(hero.sub)}</p>
          </div>
        </section>
        ${data.paused ? `<div class="tm-hidden-banner">${ICONS.hidden}<span class="tm-grow"><b>${escapeHtml(T.hiddenFromTeam)}</b><br><span class="tm-muted tm-xs">${escapeHtml(until)}</span></span><button type="button" class="tm-btn tm-btn-sm" data-unhide>${escapeHtml(T.unhide)}</button></div>` : ''}
        <section class="tm-card tm-today-w" data-w-today hidden></section>
        <section class="tm-card tm-week-w" data-w-week></section>
        <section class="tm-card tm-together-w" data-w-together></section>
      </div>
      <div class="tm-dash-col">
        <section class="tm-card tm-members" data-members></section>
      </div>
    </div>
    <div class="tm-dash-full"><section class="tm-card tm-stats-w" data-w-stats aria-label="${escapeHtml(T.teamStats)}"></section></div>
  </div>`;

  el.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); stopDashboardTimers(); goTeams({ view: 'list' }); });
  el.querySelector('[data-share]')?.addEventListener('click', () => shareInvite(team));
  el.querySelector('[data-manage]').addEventListener('click', async () => {
    const { openManage } = await import('./teams-manage.js');
    openManage(team.id, { onChange: () => initTeams() });
  });
  el.querySelector('[data-unhide]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await teamsApi.updateMe(team.id, { pause: null }); } catch (err) { showToast(errorText(err), 'error'); }
    initTeams();
  });

  // Each widget is isolated: one throwing never blanks another.
  const guard = (section, fn) => {
    try { const r = fn(); if (r && typeof r.catch === 'function') r.catch((err) => failWidget(section, err)); } catch (err) { failWidget(section, err); }
  };
  const failWidget = (section, err) => {
    console.error('[Teams] widget failed:', err && err.message);
    section.hidden = false;
    section.innerHTML = `<p class="tm-muted tm-sm" role="alert">${escapeHtml(T.widgetError)}</p>`;
  };
  const todayEl = el.querySelector('[data-w-today]');
  const togetherEl = el.querySelector('[data-w-together]');
  guard(todayEl, () => dash.renderTodaysWorkouts(todayEl, data, now));
  guard(el.querySelector('[data-w-week]'), () => dash.renderThisWeek(el.querySelector('[data-w-week]'), data, now));
  guard(togetherEl, () => dash.renderClassesTogether(togetherEl, data, now, { stale }));
  guard(el.querySelector('[data-members]'), () => dash.renderMembers(el.querySelector('[data-members]'), data, now));
  // D13 Team goal: Captains set or edit it from the stats card (also from Manage).
  const onEditGoal = isCaptain ? async () => {
    const { openGoalPage } = await import('./teams-manage.js');
    openGoalPage(team, { onSaved: () => initTeams() });
  } : null;
  guard(el.querySelector('[data-w-stats]'), () => dash.renderTeamStats(el.querySelector('[data-w-stats]'), data, now, { onEditGoal }));

  // Keep "in class" rings honest on a page left open, and repaint the CTAs once the
  // timetable (the booking flow's own state) loads or changes after a booking.
  dashListener = () => {
    if (stale() || !togetherEl.isConnected) { stopDashboardTimers(); return; }
    guard(togetherEl, () => dash.renderClassesTogether(togetherEl, data, Date.now(), { stale }));
  };
  window.addEventListener('app-timetable-rendered', dashListener);
  dashTimer = setInterval(() => {
    if (stale() || !todayEl.isConnected) { stopDashboardTimers(); return; }
    guard(todayEl, () => dash.renderTodaysWorkouts(todayEl, data, Date.now()));
  }, 60000);
}
