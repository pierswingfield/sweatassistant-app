// T-1 Settings -> Privacy, "Who can see my classes" (PLAN-teams.md §3, mock 06): every Team
// the member is in, what it can see, and quick Edit sharing / Pause / Leave. Pending join
// requests are deliberately NOT listed here (§5.6: only the link page shows them).

import { teamsApi } from '../teams-api.js';
import { escapeHtml } from './cards.js';
import { showToast } from '../main.js';
import { getGymShortName } from '../gym-context.js';
import { shareChips } from './teams-model.js';
import {
  T, fmt, teamAvatar, teamTitleText, memberCountLabel, ICONS, errorText, pauseWhenShort, sharingSummaryText, openTeamsPage, setFooter, confirmPage, renderSharingSheet, leaveBodyText,
} from './teams-ui.js';

const CHIP_LABEL = { upcoming: 'chipUpcoming', waitlists: 'chipWaitlists', activity: 'chipActivity', recent: 'chipRecent', spots: 'chipSpots', autoBookQueue: 'chipAutoBookQueue' };

function gymChipLabel(chip) {
  if (chip.scope === 'all') return T.chipAllGyms;
  if (chip.scope === 'none') return T.chipNoGyms;
  return fmt(T.chipSomeGyms, { gyms: chip.gymIds.map((g) => getGymShortName(g) || g).join(', ') });
}

function hiddenSummary(share) {
  const on = shareChips(share).filter((c) => c.on).map((c) => (c.key === 'gyms' ? gymChipLabel(c) : T[CHIP_LABEL[c.key]]).toLowerCase());
  return fmt(T.privacyHiddenNote, { list: on.length ? on.join(', ') : T.nothingShared });
}

export async function renderPrivacyPane() {
  const host = document.getElementById('app-privacy-section');
  if (!host) return;
  if (!host.firstChild) host.innerHTML = `<div class="tm-loading" role="status"><span class="tm-spinner" aria-hidden="true"></span><span>${escapeHtml(T.loading)}</span></div>`;
  let data;
  let teams = [];
  try {
    [data, teams] = await Promise.all([teamsApi.privacy(), teamsApi.list().then((r) => r.teams || []).catch(() => [])]);
  } catch (err) {
    host.innerHTML = `<section class="tm-card tm-error" role="alert"><p>${escapeHtml(errorText(err, T.loadFailed))}</p><button type="button" class="tm-btn">${escapeHtml(T.retry)}</button></section>`;
    host.querySelector('button').addEventListener('click', renderPrivacyPane);
    return;
  }
  const roleOf = new Map(teams.map((t) => [t.id, t.myRole]));
  const list = data.teams || [];
  host.innerHTML = `
    ${list.length ? `<div class="tm-stack-cards">${list.map((t) => {
      const when = t.paused ? pauseWhenShort(t.pausedUntil) : null;
      const members = memberCountLabel(t.memberCount);
      return `<section class="tm-card tm-priv-team" data-team="${escapeHtml(t.id)}">
        <div class="tm-row">${teamAvatar({ emoji: t.emoji, size: 'sm', dim: t.paused })}
          <div class="tm-grow tm-min0"><div class="tm-card-sub tm-ellip">${escapeHtml(teamTitleText(t))}</div><div class="tm-muted tm-sm">${escapeHtml(roleOf.get(t.id) === 'captain' ? fmt(T.privacyMembersCaptain, { members }) : members)}</div></div>
          ${t.paused ? `<span class="tm-pill tm-pill-warn">${escapeHtml(when ? fmt(T.hiddenPill, { when }) : T.hiddenPillIndefinite)}</span>` : `<span class="tm-pill tm-pill-success">${escapeHtml(T.visible)}</span>`}
        </div>
        <div class="tm-shares"><span class="tm-muted tm-sm">${escapeHtml(t.paused ? hiddenSummary(t.share) : sharingSummaryText(t.share))}</span></div>
        <div class="tm-btn-row">
          <button type="button" class="tm-btn tm-btn-sm tm-grow" data-edit>${escapeHtml(T.editSharing)}</button>
          ${t.paused
            ? `<button type="button" class="tm-btn tm-btn-sm tm-btn-primary tm-grow" data-unhide>${escapeHtml(T.unhideNow)}</button>`
            : `<button type="button" class="tm-btn tm-btn-sm tm-grow" data-pause>${escapeHtml(T.pause)}</button>`}
          <button type="button" class="tm-btn tm-btn-sm tm-btn-danger-ghost" data-leave>${escapeHtml(T.leave)}</button>
        </div>
      </section>`;
    }).join('')}</div>` : `<section class="tm-card"><p class="tm-muted">${escapeHtml(T.privacyNone)}</p></section>`}
    <p class="tm-never">${ICONS.shield}<span>${escapeHtml(T.privacyNever)}</span></p>`;

  host.querySelectorAll('[data-team]').forEach((card) => {
    const t = list.find((x) => x.id === card.getAttribute('data-team'));
    const name = teamTitleText(t);
    card.querySelector('[data-edit]').addEventListener('click', () => {
      const page = openTeamsPage({ title: fmt(T.whatTeamSees, { name }), onClose: () => renderPrivacyPane() });
      page.body.innerHTML = '<div class="tm-sheet"></div>';
      renderSharingSheet(page.body.querySelector('.tm-sheet'), {
        share: t.share,
        onChange: async (share) => { await teamsApi.updateMe(t.id, { share }); showToast(T.shareSaved, 'success'); },
      });
      setFooter(page, [{ label: T.save, kind: 'primary', onClick: () => page.close() }]);
    });
    card.querySelector('[data-pause]')?.addEventListener('click', () => openPausePage(t, name));
    card.querySelector('[data-unhide]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await teamsApi.updateMe(t.id, { pause: null }); } catch (err) { showToast(errorText(err), 'error'); }
      renderPrivacyPane();
    });
    card.querySelector('[data-leave]').addEventListener('click', async () => {
      const ok = await confirmPage({
        title: fmt(T.leaveConfirmTitle, { name }),
        body: t.paused ? fmt(T.leaveConfirmNothing, { name }) : leaveBodyText(name, t.share),
        confirmLabel: fmt(T.leaveTeam, { name }),
        danger: true,
      });
      if (!ok) return;
      try {
        await teamsApi.leave(t.id);
        showToast(fmt(T.left, { name }), 'success');
      } catch (err) {
        showToast(errorText(err, T.leaveFailed), 'error');
      }
      renderPrivacyPane();
    });
  });
}

function openPausePage(t, name) {
  const page = openTeamsPage({ title: T.hideMe, onClose: () => renderPrivacyPane() });
  page.body.innerHTML = `<h2 class="tm-group-title">${escapeHtml(name)}</h2><p class="tm-group-help">${escapeHtml(T.pauseHelp)}</p>`;
  const choose = (pause) => async () => {
    try { await teamsApi.updateMe(t.id, { pause }); } catch (err) { showToast(errorText(err), 'error'); return; }
    page.close();
  };
  setFooter(page, [
    { label: T.pause24h, kind: 'ghost', onClick: choose('24h') },
    { label: T.pause7d, kind: 'ghost', onClick: choose('7d') },
    { label: T.pauseIndefinite, kind: 'primary', onClick: choose('indefinite') },
  ]);
}
