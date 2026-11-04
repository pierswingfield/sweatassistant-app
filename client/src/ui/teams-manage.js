// T-1 Manage page (PLAN-teams.md §5.7): one modal-nav page, sections by role.
//   Everyone: My sharing (§3 sheet + competition opt-in when the Team has it on), Pause,
//             Pin to top (only in more than 3 Teams), Leave.
//   Captains: Join requests, Members (Make/Remove Captain, Remove [+ block]), Team settings
//             (name, emoji, competition, Reset link, Joining by link, Delete with typed name).
// Members see the sharing sections inline (mock 04); Captains reach them through rows that
// open a stacked page (mock 04b). Every change saves immediately and re-renders from the server.

import { teamsApi } from '../teams-api.js';
import { escapeHtml } from './cards.js';
import { showToast } from '../main.js';
import {
  canOfferPin, canTogglePin, pinsUsed, PAUSE_OPTIONS, pauseOptionFor, validateTeamName, validateEmoji, relativeTime, shareChips,
} from './teams-model.js';
import {
  T, fmt, avatarHtml, teamTitleText, ICONS, captainBadgeHtml, errorText, pauseWhen, joinedLabel,
  openTeamsPage, setFooter, confirmPage, renderSharingSheet, switchHtml, shareInvite, leaveBodyText,
} from './teams-ui.js';
import { goTeams } from './teams.js';
import { getGymShortName } from '../gym-context.js';

const PAUSE_LABEL = { '24h': 'pause24h', '7d': 'pause7d', indefinite: 'pauseIndefinite' };

function timeLabels() {
  return { now: T.timeNow, min: T.timeMin, hour: T.timeHour, yesterday: T.timeYesterday, days: T.timeDays };
}

/** Load everything the page needs for this viewer. Requests only for Captains. */
async function load(teamId) {
  const [detail, list] = await Promise.all([teamsApi.get(teamId), teamsApi.list().catch(() => ({ teams: [] }))]);
  const teams = list.teams || [];
  const mine = teams.find((t) => t.id === teamId) || { id: teamId, pinned: false };
  let requests = [];
  let invite = null;
  if (detail.myRole === 'captain') {
    [requests, invite] = await Promise.all([
      teamsApi.listRequests(teamId).then((r) => r.requests || []).catch(() => []),
      teamsApi.getInvite(teamId).catch(() => null),
    ]);
  }
  return { detail, teams, mine, requests, invite };
}

/** Share summary line for the Captain's "My sharing" row. */
function shareSummary(share) {
  const labels = { upcoming: T.chipUpcoming, waitlists: T.chipWaitlists, activity: T.chipActivity, recent: T.chipRecent, spots: T.chipSpots, autoBookQueue: T.chipAutoBookQueue };
  const chips = shareChips(share);
  const gym = chips[0];
  const gymText = gym.scope === 'all' ? T.chipAllGyms : gym.scope === 'none' ? T.chipNoGyms : fmt(T.chipSomeGyms, { gyms: gym.gymIds.map((g) => getGymShortName(g) || g).join(', ') });
  const on = chips.slice(1).filter((c) => c.on).map((c) => labels[c.key].toLowerCase());
  return [gymText, ...(on.length ? on : [T.nothingShared])].join(' · ');
}

function pauseStatus(detail) {
  if (!detail.paused) return T.visibleToTeam;
  const when = pauseWhen(detail.pausedUntil);
  return when ? fmt(T.hiddenUntilLong, { when }) : T.hiddenUntilUndone;
}

// ---- sections shared by both roles ---------------------------------------------------------

/** My sharing + Pause + Pin, rendered into `host`. `refresh()` reloads the whole Manage view. */
function renderMemberSections(host, ctx, refresh) {
  const { detail, teams, mine } = ctx;
  const team = detail.team;
  const name = teamTitleText(team);
  const offerPin = canOfferPin(teams.length);
  const pauseMode = detail.paused ? pauseOptionFor(detail.pausedUntil) : null;
  host.innerHTML = `
    <h2 class="tm-group-title">${escapeHtml(T.mySharing)}</h2>
    <p class="tm-group-help">${escapeHtml(fmt(T.sharingHelpManage, { name }))}</p>
    <div class="tm-sheet"></div>

    <h2 class="tm-group-title">${escapeHtml(T.pause)}</h2>
    <div class="tm-list">
      <div class="tm-sw-row tm-sw-wrap">
        <div class="tm-grow"><div class="tm-t">${escapeHtml(T.hideMe)}</div><div class="tm-d${detail.paused ? ' tm-warn' : ''}">${escapeHtml(pauseStatus(detail))}</div></div>
        ${switchHtml('pause', detail.paused, T.hideMe, 'data-pause-switch')}
        <span class="tm-seg tm-seg-full" role="group" aria-label="${escapeHtml(T.pause)}">
          ${PAUSE_OPTIONS.map((p) => `<button type="button" data-pause="${p}" aria-pressed="${pauseMode === p}" class="${pauseMode === p ? 'is-on' : ''}">${escapeHtml(T[PAUSE_LABEL[p]])}</button>`).join('')}
        </span>
      </div>
    </div>
    <p class="tm-group-help tm-mt-s">${escapeHtml(T.pauseHelp)}</p>

    ${offerPin ? `<h2 class="tm-group-title">${escapeHtml(T.pin)}</h2>
    <div class="tm-list">
      <div class="tm-sw-row"><div class="tm-grow"><div class="tm-t">${escapeHtml(fmt(T.pinTeam, { name }))}</div><div class="tm-d">${escapeHtml(fmt(T.pinHelpUsed, { used: pinsUsed(teams) }))}</div></div>
      ${switchHtml('pin', !!mine.pinned, fmt(T.pinTeam, { name }), `data-pin-switch ${canTogglePin(mine, teams) ? '' : 'disabled'}`)}</div>
    </div>
    <p class="tm-group-help tm-mt-s">${escapeHtml(T.pinHelpWhy)}</p>` : ''}`;

  renderSharingSheet(host.querySelector('.tm-sheet'), {
    share: detail.myShare,
    competitionTeamName: team.competitionEnabled ? name : null,
    onChange: async (share) => {
      await teamsApi.updateMe(team.id, { share });
      showToast(T.shareSaved, 'success');
    },
  });

  const setPause = async (pause) => {
    try {
      await teamsApi.updateMe(team.id, { pause });
    } catch (err) {
      showToast(errorText(err), 'error');
    }
    refresh();
  };
  host.querySelector('[data-pause-switch]').addEventListener('change', (e) => setPause(e.target.checked ? '24h' : null));
  host.querySelectorAll('[data-pause]').forEach((b) => b.addEventListener('click', () => setPause(b.getAttribute('data-pause'))));
  host.querySelector('[data-pin-switch]')?.addEventListener('change', async (e) => {
    try {
      await teamsApi.setPinned(team.id, e.target.checked);
    } catch (err) {
      showToast(errorText(err), 'error');
    }
    refresh();
  });
}

async function leaveFlow(ctx, page, onChange) {
  const { detail } = ctx;
  const name = teamTitleText(detail.team);
  const captains = (detail.members || []).filter((m) => m.isCaptain).length;
  const lastCaptain = detail.myRole === 'captain' && captains <= 1 && (detail.members || []).length > 1;
  const ok = await confirmPage({
    title: fmt(T.leaveConfirmTitle, { name }),
    body: leaveBodyText(name, detail.myShare) + (lastCaptain ? `\n\n${T.leaveLastCaptainNote}` : ''),
    confirmLabel: fmt(T.leaveTeam, { name }),
    danger: true,
  });
  if (!ok) return;
  try {
    await teamsApi.leave(detail.team.id);
    showToast(fmt(T.left, { name }), 'success');
    page.closeThen(() => { onChange?.('left'); goTeams({ view: 'list' }, { replace: true }); });
  } catch (err) {
    showToast(errorText(err, T.leaveFailed), 'error');
  }
}

// ---- Captain sections -----------------------------------------------------------------------

function renderRequests(host, ctx, refresh) {
  const { detail, requests } = ctx;
  const teamId = detail.team.id;
  host.innerHTML = `
    <h2 class="tm-group-title">${escapeHtml(T.joinRequests)}${requests.length ? ` <span class="tm-count">${requests.length}</span>` : ''}</h2>
    <div class="tm-list">
      ${requests.length ? requests.map((r) => `<div class="tm-mrow" data-request="${escapeHtml(r.id)}">
          ${avatarHtml(r, { size: 'lg' })}
          <div class="tm-grow tm-min0"><div class="tm-li-title tm-ellip">${escapeHtml(r.name)}</div><div class="tm-li-sub">${escapeHtml(fmt(T.requestedVia, { when: relativeTime(r.requestedAt, Date.now(), timeLabels()) }))}</div></div>
          <div class="tm-acts">
            <button type="button" class="tm-btn tm-btn-sm tm-btn-primary" data-decide="approve">${escapeHtml(T.approve)}</button>
            <button type="button" class="tm-btn tm-btn-sm" data-decide="decline">${escapeHtml(T.decline)}</button>
            <button type="button" class="tm-btn tm-btn-sm tm-btn-danger-ghost" data-decide="block">${escapeHtml(T.declineBlock)}</button>
          </div></div>`).join('') : `<div class="tm-li"><span class="tm-muted">${escapeHtml(T.noRequests)}</span></div>`}
    </div>
    <p class="tm-group-help tm-mt-s">${escapeHtml(T.requestsHelp)}</p>`;
  host.querySelectorAll('[data-request]').forEach((row) => {
    const rid = row.getAttribute('data-request');
    const req = requests.find((r) => r.id === rid);
    row.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => {
      const decision = b.getAttribute('data-decide');
      row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try {
        await teamsApi.decideRequest(teamId, rid, decision);
        showToast(decision === 'approve' ? fmt(T.approved, { name: req?.name || '' }) : decision === 'block' ? T.blocked : T.declined, 'success');
      } catch (err) {
        showToast(errorText(err), 'error');
      }
      refresh();
    }));
  });
}

function renderMembers(host, ctx, refresh) {
  const { detail } = ctx;
  const teamId = detail.team.id;
  const members = detail.members || [];
  const row = (m) => `<div class="tm-mrow" data-member="${escapeHtml(m.memberRef)}">
      ${avatarHtml(m, { size: 'lg' })}
      <div class="tm-grow tm-min0"><div class="tm-li-title"><span class="tm-ellip">${escapeHtml(m.isMe ? T.you : m.name)}</span>${m.isCaptain ? captainBadgeHtml() : ''}</div><div class="tm-li-sub">${escapeHtml(joinedLabel(m.joinedAt))}</div></div>
      <div class="tm-acts">
        <button type="button" class="tm-btn tm-btn-sm" data-captain="${m.isCaptain ? 'off' : 'on'}">${escapeHtml(m.isCaptain ? T.removeCaptain : T.makeCaptain)}</button>
        ${m.isMe ? '' : `<button type="button" class="tm-btn tm-btn-sm tm-btn-danger-ghost" data-remove>${escapeHtml(T.removeFromTeam)}</button>`}
      </div></div>`;
  host.innerHTML = `
    <h2 class="tm-group-title">${escapeHtml(T.members)} <span class="tm-muted tm-sm tm-sans">${escapeHtml(fmt(T.membersCount, { count: members.length }))}</span></h2>
    <div class="tm-list">${members.map(row).join('')}</div>
    <p class="tm-group-help tm-mt-s">${escapeHtml(T.captainsHelp)}</p>`;
  host.querySelectorAll('[data-member]').forEach((el) => {
    const m = members.find((x) => x.memberRef === el.getAttribute('data-member'));
    el.querySelector('[data-captain]').addEventListener('click', async (e) => {
      const on = e.currentTarget.getAttribute('data-captain') === 'on';
      e.currentTarget.disabled = true;
      try {
        await teamsApi.setCaptain(teamId, m.memberRef, on);
        showToast(fmt(on ? T.madeCaptain : T.unmadeCaptain, { name: m.isMe ? T.you : m.name }), 'success');
      } catch (err) {
        showToast(errorText(err), 'error');
      }
      refresh();
    });
    el.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const res = await confirmPage({
        title: fmt(T.removeConfirmTitle, { name: m.name }),
        body: fmt(T.removeConfirmBody, { name: m.name }),
        confirmLabel: T.removeAction,
        danger: true,
        checkbox: T.blockToo,
      });
      if (!res.ok) return;
      try {
        await teamsApi.removeMember(teamId, m.memberRef, res.checked);
        showToast(fmt(T.removed, { name: m.name }), 'success');
      } catch (err) {
        showToast(errorText(err), 'error');
      }
      refresh();
    });
  });
}

function editTextPage({ title, label, value, help, maxlength, validate, save }) {
  const page = openTeamsPage({ title });
  page.body.innerHTML = `<label class="tm-field"><span class="tm-field-label"></span><input type="text" class="tm-input" autocomplete="off" maxlength="${maxlength}"><span class="tm-field-help"></span></label><p class="tm-field-error" role="alert" hidden></p>`;
  page.body.querySelector('.tm-field-label').textContent = label;
  page.body.querySelector('.tm-field-help').textContent = help || '';
  const input = page.body.querySelector('input');
  const errEl = page.body.querySelector('.tm-field-error');
  input.value = value || '';
  const submit = async (btn) => {
    const v = validate(input.value);
    if (!v.ok) { errEl.textContent = v.message; errEl.hidden = false; return; }
    if (btn) btn.disabled = true;
    try {
      await save(v.value);
      showToast(T.saved, 'success');
      page.close();
    } catch (err) {
      if (btn) btn.disabled = false;
      errEl.textContent = errorText(err);
      errEl.hidden = false;
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(null); } });
  setFooter(page, [{ label: T.save, kind: 'primary', onClick: submit }]);
  setTimeout(() => input.focus({ preventScroll: true }), 60);
  return page;
}

function renderTeamSettings(host, ctx, refresh, onChange, managePage) {
  const { detail, invite } = ctx;
  const team = detail.team;
  const inviteEnabled = invite ? !!invite.enabled : !!team.inviteEnabled;
  host.innerHTML = `
    <h2 class="tm-group-title">${escapeHtml(T.teamSettings)}</h2>
    <div class="tm-list">
      <button type="button" class="tm-li tm-li-link" data-edit="name"><span class="tm-grow tm-min0"><span class="tm-li-sub">${escapeHtml(T.name)}</span><span class="tm-li-title tm-ellip">${escapeHtml(team.name)}</span></span>${ICONS.chevron}</button>
      <button type="button" class="tm-li tm-li-link" data-edit="emoji"><span class="tm-grow"><span class="tm-li-sub">${escapeHtml(T.emoji)}</span><span class="tm-li-title">${escapeHtml(team.emoji || T.emojiNone)}</span></span>${ICONS.chevron}</button>
      <div class="tm-sw-row"><div class="tm-grow"><div class="tm-t">${escapeHtml(T.competition)}</div><div class="tm-d">${escapeHtml(T.competitionTeamDesc)}</div></div>${switchHtml('competitionEnabled', team.competitionEnabled, T.competition, 'data-competition')}</div>
      <button type="button" class="tm-li tm-li-link" data-reset><span class="tm-grow"><span class="tm-li-title">${escapeHtml(T.resetLink)}</span><span class="tm-li-sub">${escapeHtml(T.resetLinkDesc)}</span></span>${ICONS.chevron}</button>
      <div class="tm-sw-row"><div class="tm-grow"><div class="tm-t">${escapeHtml(T.joiningByLink)}</div><div class="tm-d">${escapeHtml(T.joiningByLinkDesc)}</div></div>${switchHtml('inviteEnabled', inviteEnabled, T.joiningByLink, 'data-joining')}</div>
    </div>`;

  host.querySelector('[data-edit="name"]').addEventListener('click', () => editTextPage({
    title: T.renameTitle, label: T.nameLabel, value: team.name, help: T.nameHelp, maxlength: 40,
    validate: (v) => { const r = validateTeamName(v); return r.ok ? r : { ok: false, message: r.error === 'tooLong' ? T.nameTooLong : r.error === 'angle' ? T.nameAngle : T.nameRequired }; },
    save: async (name) => { await teamsApi.update(team.id, { name }); refresh(); onChange?.(); },
  }));
  host.querySelector('[data-edit="emoji"]').addEventListener('click', () => editTextPage({
    title: T.emojiTitle, label: T.emojiLabel, value: team.emoji || '', help: T.emojiHelp, maxlength: 16,
    validate: (v) => { const r = validateEmoji(v); return r.ok ? r : { ok: false, message: T.emojiInvalid }; },
    save: async (emoji) => { await teamsApi.update(team.id, { emoji }); refresh(); onChange?.(); },
  }));
  host.querySelector('[data-competition]').addEventListener('change', async (e) => {
    try { await teamsApi.update(team.id, { competitionEnabled: e.target.checked }); } catch (err) { showToast(errorText(err), 'error'); }
    refresh();
  });
  host.querySelector('[data-joining]').addEventListener('change', async (e) => {
    try { await teamsApi.setInviteEnabled(team.id, e.target.checked); } catch (err) { showToast(errorText(err), 'error'); }
    refresh();
  });
  host.querySelector('[data-reset]').addEventListener('click', async () => {
    const ok = await confirmPage({ title: T.resetConfirmTitle, body: T.resetConfirmBody, confirmLabel: T.resetAction });
    if (!ok) return;
    try {
      const { inviteToken } = await teamsApi.rotateInvite(team.id);
      showToast(T.linkReset, 'success');
      refresh();
      if (inviteEnabled) shareInvite(team, { url: inviteToken });
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  });
  void managePage;
}

async function deleteFlow(ctx, page, onChange) {
  const team = ctx.detail.team;
  const ok = await confirmPage({
    title: fmt(T.deleteTitle, { name: team.name }),
    body: T.deleteBody,
    confirmLabel: T.deleteAction,
    danger: true,
    typeToConfirm: team.name,
    typeLabel: T.deleteTypeLabel,
  });
  if (!ok) return;
  try {
    await teamsApi.remove(team.id);
    showToast(fmt(T.deleted, { name: team.name }), 'success');
    page.closeThen(() => { onChange?.('deleted'); goTeams({ view: 'list' }, { replace: true }); });
  } catch (err) {
    showToast(errorText(err), 'error');
  }
}

// ---- the page ---------------------------------------------------------------------------------

export function openManage(teamId, { onChange = null } = {}) {
  const page = openTeamsPage({ id: 'teams-manage', title: '', wide: true, onClose: () => onChange?.('closed') });
  page.body.innerHTML = `<div class="tm-loading" role="status"><span class="tm-spinner" aria-hidden="true"></span></div>`;
  setFooter(page, [{ label: T.done, kind: 'primary', onClick: () => page.close() }]);
  let seq = 0;

  const refresh = async () => {
    const mySeq = ++seq;
    let ctx;
    try {
      ctx = await load(teamId);
    } catch (err) {
      if (mySeq !== seq || page.isClosed()) return;
      if (err.status === 404) { showToast(T.notFound, 'warning'); page.closeThen(() => goTeams({ view: 'list' }, { replace: true })); return; }
      page.body.innerHTML = `<p class="tm-muted" role="alert">${escapeHtml(errorText(err, T.loadFailed))}</p>`;
      return;
    }
    if (mySeq !== seq || page.isClosed()) return;
    const { detail } = ctx;
    const name = teamTitleText(detail.team);
    page.setTitle(name);
    const scroll = page.body.scrollTop;
    const captain = detail.myRole === 'captain';
    if (!captain) {
      page.body.innerHTML = `<div data-sec="me"></div>
        <h2 class="tm-group-title">${escapeHtml(T.leave)}</h2>
        <section class="tm-card tm-card-flat"><p class="tm-sm">${escapeHtml(fmt(T.leaveBody, { name }))}</p>
          <button type="button" class="tm-btn tm-btn-danger-ghost tm-btn-block tm-mt" data-leave>${escapeHtml(fmt(T.leaveTeam, { name }))}</button></section>`;
      renderMemberSections(page.body.querySelector('[data-sec="me"]'), ctx, refresh);
    } else {
      page.body.innerHTML = `<div data-sec="requests"></div><div data-sec="members"></div><div data-sec="settings"></div>
        <h2 class="tm-group-title">${escapeHtml(T.mySharing)}</h2>
        <div class="tm-list">
          <button type="button" class="tm-li tm-li-link" data-my-sharing><span class="tm-grow tm-min0"><span class="tm-li-title">${escapeHtml(fmt(T.whatTeamSees, { name }))}</span><span class="tm-li-sub">${escapeHtml(shareSummary(detail.myShare))}</span></span>${ICONS.chevron}</button>
          <button type="button" class="tm-li tm-li-link" data-my-sharing><span class="tm-grow"><span class="tm-li-title">${escapeHtml(T.pause)}</span><span class="tm-li-sub${detail.paused ? ' tm-warn' : ''}">${escapeHtml(pauseStatus(detail))}</span></span>${ICONS.chevron}</button>
          ${canOfferPin(ctx.teams.length) ? `<button type="button" class="tm-li tm-li-link" data-my-sharing><span class="tm-grow"><span class="tm-li-title">${escapeHtml(T.pin)}</span><span class="tm-li-sub">${escapeHtml(ctx.mine.pinned ? T.pinned : T.notPinned)}</span></span>${ICONS.chevron}</button>` : ''}
        </div>
        <h2 class="tm-group-title">${escapeHtml(T.leaveOrDelete)}</h2>
        <section class="tm-card tm-card-flat">
          <button type="button" class="tm-btn tm-btn-danger-ghost tm-btn-block" data-leave>${escapeHtml(fmt(T.leaveTeam, { name }))}</button>
          <button type="button" class="tm-btn tm-btn-danger tm-btn-block tm-mt-s" data-delete>${escapeHtml(T.deleteTeam)}</button>
          <p class="tm-muted tm-xs tm-mt-s">${escapeHtml(fmt(T.deleteTeamHelp, { count: detail.team.memberCount }))}</p>
        </section>`;
      renderRequests(page.body.querySelector('[data-sec="requests"]'), ctx, refresh);
      renderMembers(page.body.querySelector('[data-sec="members"]'), ctx, refresh);
      renderTeamSettings(page.body.querySelector('[data-sec="settings"]'), ctx, refresh, () => onChange?.('updated'), page);
      page.body.querySelectorAll('[data-my-sharing]').forEach((b) => b.addEventListener('click', () => openMySharingPage(ctx, refresh)));
      page.body.querySelector('[data-delete]').addEventListener('click', () => deleteFlow(ctx, page, onChange));
    }
    page.body.querySelector('[data-leave]').addEventListener('click', () => leaveFlow(ctx, page, onChange));
    page.body.scrollTop = scroll;
  };
  refresh();
  return page;
}

/** Captains: My sharing / Pause / Pin on a stacked page (mock 04b rows). */
function openMySharingPage(ctx, refreshManage) {
  const page = openTeamsPage({ id: 'teams-my-sharing', title: T.mySharing, onClose: () => refreshManage() });
  setFooter(page, [{ label: T.done, kind: 'primary', onClick: () => page.close() }]);
  const host = document.createElement('div');
  page.body.appendChild(host);
  const refresh = async () => {
    try {
      const fresh = await load(ctx.detail.team.id);
      if (!page.isClosed()) renderMemberSections(host, fresh, refresh);
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };
  renderMemberSections(host, ctx, refresh);
}
