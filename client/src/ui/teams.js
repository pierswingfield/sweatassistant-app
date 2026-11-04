// T-1 Teams tab (PLAN-teams.md §5.2 list, §5.3 Team page shell, §5.6 create).
// Routes: /teams (list), /teams/<id> (Team page), /t/<token> (invite page, teams-join.js).
// T-1 has no class data (T-2): cards and widgets show Teams and members only, and the class
// widgets are clearly-labelled empty placeholders, never sample data.

import { currentRoute } from '../router.js';
import { teamsApi } from '../teams-api.js';
import { escapeHtml } from './cards.js';
import { showToast } from '../main.js';
import {
  orderTeams, canOfferPin, canTogglePin, pinsUsed, sortMembers, paginate, readSortChoice, writeSortChoice,
  SORT_MODES, MEMBERS_PER_PAGE, validateTeamName, validateEmoji, defaultShare, clearPendingInvite,
} from './teams-model.js';
import {
  T, fmt, avatarHtml, avatarStackHtml, mascotHtml, teamTitleHtml, teamTitleText, memberCountLabel, ICONS,
  captainBadgeHtml, errorText, pauseWhen, joinedLabel, openTeamsPage, setFooter, shareInvite, renderSharingSheet,
} from './teams-ui.js';

let renderSeq = 0;
const membersCache = new Map(); // teamId -> members (for list avatar stacks); refreshed on every list render

function root() { return document.getElementById('app-teams-root'); }

/** Navigate within the Teams tab (pushes history, re-renders via switchTab). */
export function goTeams(route, { replace = false } = {}) {
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
  if (route.view === 'invite') {
    clearPendingInvite(storage()); // consumed: the member is signed in and on the page
    const { renderInvite } = await import('./teams-join.js');
    if (!stale()) await renderInvite(el, route.token, { stale });
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
  const card = (t) => {
    const members = membersCache.get(t.id) || [];
    const pinControl = offerPin
      ? `<button type="button" class="tm-icon-btn tm-pin${t.pinned ? ' is-on' : ''}" data-pin="${escapeHtml(t.id)}" aria-pressed="${t.pinned ? 'true' : 'false'}" aria-label="${escapeHtml(t.pinned ? T.unpin : fmt(T.pinTeam, { name: t.name }))}" ${canTogglePin(t, teams) ? '' : 'disabled'}>${ICONS.pin}</button>`
      : '';
    const hidden = t.paused ? `<div class="tm-hidden-banner">${ICONS.hidden}<span class="tm-grow"><b>${escapeHtml(T.hiddenFromTeam)}</b></span><button type="button" class="tm-btn tm-btn-sm" data-unhide="${escapeHtml(t.id)}">${escapeHtml(T.unhide)}</button></div>` : '';
    return `<article class="tm-card tm-team-card${t.paused ? ' is-paused' : ''}" data-team="${escapeHtml(t.id)}">
      <a class="tm-team-link" href="/teams/${encodeURIComponent(t.id)}" data-open-team="${escapeHtml(t.id)}">
        ${mascotHtml({ size: 60, dim: t.paused, alt: T.mascotAlt })}
        <span class="tm-grow tm-min0">
          <span class="tm-team-name tm-ellip">${teamTitleHtml(t)}</span>
          <span class="tm-today">${escapeHtml(T.classActivitySoon)}</span>
        </span>
      </a>
      ${pinControl}
      ${hidden}
      <div class="tm-team-foot">${avatarStackHtml(members)}<span class="tm-muted tm-xs tm-grow">${escapeHtml(memberCountLabel(t.memberCount))}</span>${t.myRole === 'captain' ? `<span class="tm-pill tm-pill-accent">${escapeHtml(T.captain)}</span>` : ''}</div>
    </article>`;
  };
  const pinned = ordered.filter((t) => t.pinned);
  const rest = ordered.filter((t) => !t.pinned);
  el.innerHTML = `<div class="tm-list-page">
    <div class="tm-page-head">
      <h3 class="t-page-title tm-page-title">${escapeHtml(T.title)}</h3>
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

  // Avatar stacks: GET /api/teams carries no member list (T-2 adds today's summaries), so
  // fetch each Team's members in the background and fill the stacks in place.
  Promise.all(teams.map(async (t) => {
    try {
      const detail = await teamsApi.get(t.id);
      membersCache.set(t.id, detail.members || []);
      if (stale()) return;
      const foot = el.querySelector(`[data-team="${CSS.escape(t.id)}"] .tm-team-foot`);
      if (!foot) return;
      foot.querySelector('.tm-stack')?.remove();
      foot.insertAdjacentHTML('afterbegin', avatarStackHtml(detail.members || []));
    } catch (_) { /* the card still works without its stack */ }
  }));
}

function renderEmpty(el) {
  el.innerHTML = `<div class="tm-list-page">
    <div class="tm-page-head"><h3 class="t-page-title tm-page-title">${escapeHtml(T.title)}</h3></div>
    <section class="tm-card tm-empty">
      ${mascotHtml({ size: 140, pose: 'warming' })}
      <p class="tm-empty-body">${escapeHtml(T.emptyBody)}</p>
      <button type="button" class="tm-btn tm-btn-primary tm-btn-pill tm-btn-block" data-create>${escapeHtml(T.createATeam)}</button>
    </section>
  </div>`;
  el.querySelector('[data-create]').addEventListener('click', () => openCreateFlow());
}

// ---- Create (§5.6 step 1) ----------------------------------------------------------------------

function nameError(code) {
  return code === 'tooLong' ? T.nameTooLong : code === 'angle' ? T.nameAngle : T.nameRequired;
}

export function openCreateFlow() {
  const page = openTeamsPage({ id: 'teams-create', title: T.createTitle });
  let draft = { name: '', emoji: '', share: defaultShare() };

  const stepName = () => {
    page.setTitle(T.createTitle);
    page.body.innerHTML = `
      <div class="tm-form">
        <label class="tm-field"><span class="tm-field-label">${escapeHtml(T.nameLabel)}</span>
          <input type="text" class="tm-input" name="teamName" maxlength="40" autocomplete="off" placeholder="${escapeHtml(T.namePlaceholder)}">
          <span class="tm-field-help">${escapeHtml(T.nameHelp)}</span></label>
        <label class="tm-field"><span class="tm-field-label">${escapeHtml(T.emojiLabel)}</span>
          <input type="text" class="tm-input tm-input-emoji" name="teamEmoji" maxlength="16" autocomplete="off" placeholder="${escapeHtml(T.emojiPlaceholder)}">
          <span class="tm-field-help">${escapeHtml(T.emojiHelp)}</span></label>
        <p class="tm-field-error" role="alert" hidden></p>
      </div>`;
    const nameInput = page.body.querySelector('[name="teamName"]');
    const emojiInput = page.body.querySelector('[name="teamEmoji"]');
    const errEl = page.body.querySelector('.tm-field-error');
    nameInput.value = draft.name;
    emojiInput.value = draft.emoji;
    const next = () => {
      const n = validateTeamName(nameInput.value);
      const em = validateEmoji(emojiInput.value);
      if (!n.ok || !em.ok) {
        errEl.textContent = !n.ok ? nameError(n.error) : T.emojiInvalid;
        errEl.hidden = false;
        (!n.ok ? nameInput : emojiInput).focus();
        return;
      }
      draft = { ...draft, name: n.value, emoji: em.value || '' };
      stepShare();
    };
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    emojiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    setFooter(page, [{ label: T.continue, kind: 'primary', onClick: next }]);
    setTimeout(() => nameInput.focus({ preventScroll: true }), 60);
  };

  const stepShare = () => {
    const teamLike = { name: draft.name, emoji: draft.emoji };
    page.setTitle(T.yourSharing);
    page.body.innerHTML = `<h2 class="tm-group-title">${escapeHtml(fmt(T.sharingWith, { name: teamTitleText(teamLike) }))}</h2><p class="tm-group-help">${escapeHtml(T.sharingHelpCreate)}</p><div class="tm-sheet"></div>`;
    const sheet = renderSharingSheet(page.body.querySelector('.tm-sheet'), { share: draft.share, onChange: (s) => { draft.share = s; } });
    const [backBtn, createBtn] = setFooter(page, [
      { label: T.backStep, kind: 'ghost', onClick: () => stepName() },
      {
        label: T.createAction,
        kind: 'primary',
        onClick: async (btn) => {
          btn.disabled = true;
          backBtn.disabled = true;
          btn.textContent = T.creating;
          try {
            const res = await teamsApi.create({ name: draft.name, emoji: draft.emoji || null, share: sheet.getShare() });
            stepDone(res);
          } catch (err) {
            btn.disabled = false;
            backBtn.disabled = false;
            btn.textContent = T.createAction;
            showToast(errorText(err), 'error');
          }
        },
      },
    ]);
    void createBtn;
  };

  const stepDone = ({ team, inviteToken }) => {
    page.setTitle(teamTitleText(team));
    page.body.innerHTML = `<div class="tm-center-hero">
      ${mascotHtml({ size: 132, pose: 'warming', alt: T.mascotAlt })}
      <h2 class="tm-hero-title">${escapeHtml(fmt(T.createdTitle, { name: teamTitleText(team) }))}</h2>
      <p class="tm-muted">${escapeHtml(T.createdBody)}</p>
    </div>`;
    setFooter(page, [
      { label: T.share, kind: 'ghost', onClick: () => shareInvite(team, { url: inviteToken }) },
      { label: T.openTeam, kind: 'primary', onClick: () => page.closeThen(() => goTeams({ view: 'team', teamId: team.id })) },
    ]);
    if (currentRoute().teams?.view === 'list') initTeams();
  };

  stepName();
}

// ---- Team page shell (§5.3) -------------------------------------------------------------------

async function renderTeamPage(el, teamId, { stale }) {
  if (!el.querySelector(`.tm-team-page[data-team-id="${CSS.escape(teamId)}"]`)) el.innerHTML = loadingHtml();
  let data;
  try {
    data = await teamsApi.get(teamId);
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
  const { team } = data;
  const isCaptain = data.myRole === 'captain';
  const placeholder = (title, body) => `<section class="tm-card tm-placeholder" aria-label="${escapeHtml(title)}">
      <div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(title)}</h3><span class="tm-pill tm-pill-off">${escapeHtml(T.widgetSoon)}</span></div>
      <p class="tm-muted tm-sm">${escapeHtml(body)}</p></section>`;
  const until = data.paused ? (pauseWhen(data.pausedUntil) ? fmt(T.hiddenUntil, { when: pauseWhen(data.pausedUntil) }) : T.hiddenIndefinite) : '';

  el.innerHTML = `<div class="tm-team-page" data-team-id="${escapeHtml(team.id)}">
    <div class="tm-dash-top">
      <a class="tm-back" href="/teams" data-back aria-label="${escapeHtml(T.backAria)}"><span aria-hidden="true">‹</span> ${escapeHtml(T.back)}</a>
      <span class="tm-grow"></span>
      ${isCaptain ? `<button type="button" class="tm-icon-btn tm-head-btn" data-share aria-label="${escapeHtml(T.shareAria)}">${ICONS.share}<span class="tm-head-txt">${escapeHtml(T.share)}</span></button>` : ''}
      <button type="button" class="tm-icon-btn tm-head-btn" data-manage aria-label="${escapeHtml(T.manageAria)}">${ICONS.manage}<span class="tm-head-txt">${escapeHtml(T.manage)}</span></button>
    </div>
    <div class="tm-dash">
      <div class="tm-dash-col">
        <section class="tm-card tm-hero">
          ${mascotHtml({ size: 108, dim: data.paused, alt: T.mascotAlt })}
          <div class="tm-grow tm-min0">
            <h1 class="tm-hero-title">${teamTitleHtml(team)}</h1>
            <p class="tm-hero-state">${escapeHtml(fmt(T.heroMembers, { count: memberCountLabel(team.memberCount) }))}</p>
            ${isCaptain ? `<p class="tm-muted tm-sm">${escapeHtml(T.heroCaptain)}</p>` : ''}
          </div>
        </section>
        ${data.paused ? `<div class="tm-hidden-banner">${ICONS.hidden}<span class="tm-grow"><b>${escapeHtml(T.hiddenFromTeam)}</b><br><span class="tm-muted tm-xs">${escapeHtml(until)}</span></span><button type="button" class="tm-btn tm-btn-sm" data-unhide>${escapeHtml(T.unhide)}</button></div>` : ''}
        ${placeholder(T.todaysWorkouts, T.todaysWorkoutsSoon)}
        ${placeholder(T.thisWeek, T.thisWeekSoon)}
        ${placeholder(T.classesTogether, T.classesTogetherSoon)}
      </div>
      <div class="tm-dash-col">
        <section class="tm-card tm-members" data-members></section>
      </div>
    </div>
    <div class="tm-dash-full">${placeholder(T.teamStats, T.teamStatsSoon)}</div>
  </div>`;

  el.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); goTeams({ view: 'list' }); });
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
  renderMembersWidget(el.querySelector('[data-members]'), team, data.members || []);
}

// ---- Members widget (§5.3 item 5) --------------------------------------------------------------

const SORT_LABEL = { name: 'sortName', activity: 'sortActivity', shuffle: 'sortShuffle' };

function renderMembersWidget(section, team, members) {
  let mode = readSortChoice(storage(), team.id);
  const shuffleSeed = `${team.id}:${new Date().toISOString().slice(0, 10)}`;

  const memberCard = (m) => `<div class="tm-mem-card">
      ${avatarHtml(m, { size: 'lg' })}
      <div class="tm-grow tm-min0">
        <div class="tm-mem-name"><span class="tm-ellip">${escapeHtml(m.isMe ? `${m.name} (${T.you})` : m.name)}</span>${m.isCaptain ? captainBadgeHtml() : ''}</div>
        <div class="tm-muted tm-xs">${escapeHtml(joinedLabel(m.joinedAt))}</div>
      </div>
    </div>`;

  const paint = () => {
    const sorted = sortMembers(members, mode, { seed: shuffleSeed });
    const pages = paginate(sorted, MEMBERS_PER_PAGE);
    section.innerHTML = `
      <div class="tm-card-head">
        <h3 class="tm-card-title">${escapeHtml(T.members)}</h3><span class="tm-card-meta">${members.length}</span>
        <span class="tm-grow"></span>
        <div class="tm-sort">
          <button type="button" class="tm-icon-btn" data-sort-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(T.sortMembers)}">${ICONS.sort}</button>
          <div class="tm-menu" role="menu" hidden>
            <div class="tm-menu-cap">${escapeHtml(T.sortBy)}</div>
            ${SORT_MODES.map((s) => `<button type="button" role="menuitemradio" aria-checked="${s === mode}" class="tm-menu-item${s === mode ? ' is-on' : ''}" data-sort="${s}">${s === mode ? ICONS.check : '<span class="tm-menu-gap"></span>'}<span>${escapeHtml(T[SORT_LABEL[s]])}</span></button>`).join('')}
          </div>
        </div>
      </div>
      <div class="tm-pager" tabindex="0" aria-label="${escapeHtml(T.members)}">${pages.map((p, i) => `<div class="tm-page" aria-label="${escapeHtml(fmt(T.membersPage, { n: i + 1, total: pages.length }))}">${p.map(memberCard).join('')}</div>`).join('')}</div>
      ${pages.length > 1 ? `<div class="tm-dots" aria-hidden="true">${pages.map((_, i) => `<i class="${i === 0 ? 'is-on' : ''}"></i>`).join('')}</div>` : ''}`;

    const toggle = section.querySelector('[data-sort-toggle]');
    const menu = section.querySelector('.tm-menu');
    const closeMenu = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside, true); };
    const outside = (e) => { if (!e.target.closest('.tm-sort')) closeMenu(); };
    toggle.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) { document.addEventListener('click', outside, true); menu.querySelector('.is-on')?.focus(); }
    });
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); toggle.focus(); } });
    menu.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      mode = b.getAttribute('data-sort');
      writeSortChoice(storage(), team.id, mode);
      closeMenu();
      paint();
    }));

    const pager = section.querySelector('.tm-pager');
    const dots = section.querySelectorAll('.tm-dots i');
    if (dots.length) {
      pager.addEventListener('scroll', () => {
        const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
        dots.forEach((d, j) => d.classList.toggle('is-on', j === i));
      }, { passive: true });
    }
  };
  paint();
}

