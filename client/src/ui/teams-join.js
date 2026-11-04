// T-1 invite link page /t/<token> (PLAN-teams.md §5.6, mocks 05a-05d). Rendered inside the
// Teams tab once the member is signed in (main.js resumes a link opened while signed out).
//
// Privacy: the preview carries the Team's name and emoji only (principle 3), and this page is
// the ONLY place a pending request is shown. Declined, blocked and removed all read as the
// neutral "You aren't a member of this Team." The token is never logged.

import { teamsApi } from '../teams-api.js';
import { escapeHtml } from './cards.js';
import { showToast } from '../main.js';
import { invitePageState, defaultShare } from './teams-model.js';
import { T, fmt, mascotHtml, teamTitleText, ICONS, errorText, renderSharingSheet } from './teams-ui.js';
import { goTeams } from './teams.js';

function shell(el, { title = T.inviteTitle, hero = '', below = '', actions = [] }) {
  el.innerHTML = `<div class="tm-invite">
    <div class="tm-dash-top"><a class="tm-back" href="/teams" data-back aria-label="${escapeHtml(T.backAria)}"><span aria-hidden="true">‹</span> ${escapeHtml(T.back)}</a><span class="tm-grow"></span></div>
    <section class="tm-card tm-invite-card">
      <h2 class="tm-invite-heading">${escapeHtml(title)}</h2>
      ${hero}
      ${below}
      <div class="tm-invite-actions">${actions.map((a, i) => `<button type="button" class="tm-btn tm-btn-block ${a.kind ? `tm-btn-${a.kind}` : ''}" data-action="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>
    </section>
  </div>`;
  el.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); goTeams({ view: 'list' }); });
  el.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => actions[Number(b.getAttribute('data-action'))].onClick(b)));
}

function heroHtml(preview, { kicker = '', heading, body = '', dim = false, extra = '' }) {
  return `<div class="tm-center-hero">
    ${mascotHtml({ size: 132, pose: dim ? 'resting' : 'warming', dim, alt: T.mascotAlt })}
    ${kicker ? `<p class="tm-kicker">${escapeHtml(kicker)}</p>` : ''}
    ${heading ? `<h1 class="tm-hero-title">${escapeHtml(heading)}</h1>` : ''}
    ${extra}
    ${body ? `<p class="tm-hero-body">${escapeHtml(body)}</p>` : ''}
  </div>`;
}

export async function renderInvite(el, token, { stale = () => false } = {}) {
  el.innerHTML = `<div class="tm-loading" role="status" aria-live="polite"><span class="tm-spinner" aria-hidden="true"></span><span>${escapeHtml(T.loading)}</span></div>`;
  let preview;
  try {
    preview = await teamsApi.previewInvite(token);
  } catch (err) {
    if (stale()) return;
    shell(el, {
      hero: heroHtml(null, { heading: '', body: err.status === 404 ? T.inviteInvalid : errorText(err, T.loadFailed), dim: true }),
      actions: err.status === 404
        ? [{ label: T.backToTeams, kind: 'primary', onClick: () => goTeams({ view: 'list' }, { replace: true }) }]
        : [{ label: T.retry, kind: 'primary', onClick: () => renderInvite(el, token, { stale }) }],
    });
    return;
  }
  if (stale()) return;
  const name = teamTitleText(preview);
  const state = invitePageState(preview);

  if (state === 'member') {
    // Already in: open the Team. The preview carries no id (principle 3), so find it in the list.
    try {
      const list = (await teamsApi.list()).teams || [];
      const matches = list.filter((t) => t.name === preview.name && (t.emoji || null) === (preview.emoji || null));
      if (matches.length === 1) { goTeams({ view: 'team', teamId: matches[0].id }, { replace: true }); return; }
    } catch (_) { /* fall through to the list */ }
    goTeams({ view: 'list' }, { replace: true });
    return;
  }

  if (state === 'notMember') {
    shell(el, {
      hero: heroHtml(preview, { heading: name, dim: true, extra: `<p class="tm-hero-strong">${escapeHtml(T.notMember)}</p>` }),
      actions: [{ label: T.backToTeams, kind: 'primary', onClick: () => goTeams({ view: 'list' }) }],
    });
    return;
  }

  if (state === 'pending') {
    shell(el, {
      hero: heroHtml(preview, {
        heading: name,
        extra: `<span class="tm-status-chip">${ICONS.clock}<span>${escapeHtml(T.requestPending)}</span></span>`,
        body: T.pendingBody,
      }),
      below: `<div class="tm-card tm-card-flat tm-row tm-mt">
        <div class="tm-grow"><div class="tm-t">${escapeHtml(T.changedMind)}</div><div class="tm-muted tm-sm">${escapeHtml(T.withdrawHelp)}</div></div>
        <button type="button" class="tm-btn tm-btn-danger-ghost" data-withdraw>${escapeHtml(T.withdraw)}</button></div>`,
      actions: [{ label: T.backToTeams, kind: 'ghost', onClick: () => goTeams({ view: 'list' }) }],
    });
    el.querySelector('[data-withdraw]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await teamsApi.withdrawRequest(token);
        showToast(T.withdrawn, 'success');
      } catch (err) {
        showToast(errorText(err), 'error');
      }
      if (!stale()) renderInvite(el, token, { stale });
    });
    return;
  }

  // Fresh invite: "Request to join X?" -> sharing sheet -> Send request (§5.6 step 2).
  shell(el, {
    hero: heroHtml(preview, { kicker: T.invited, heading: fmt(T.requestToJoin, { name }), body: T.inviteBody }),
    actions: [
      { label: T.continue, kind: 'primary', onClick: () => renderSharingStep(el, token, preview, { stale }) },
      { label: T.notNow, kind: 'ghost', onClick: () => goTeams({ view: 'list' }) },
    ],
  });
}

function renderSharingStep(el, token, preview, { stale }) {
  const name = teamTitleText(preview);
  shell(el, {
    title: fmt(T.sharingWith, { name }),
    below: `<p class="tm-group-help">${escapeHtml(T.sharingHelpJoin)}</p><div class="tm-sheet"></div>`,
    actions: [
      {
        label: T.sendRequest,
        kind: 'primary',
        onClick: async (btn) => {
          btn.disabled = true;
          btn.textContent = T.sending;
          try {
            await teamsApi.requestJoin(token, sheet.getShare());
          } catch (err) {
            btn.disabled = false;
            btn.textContent = T.sendRequest;
            // A declined/blocked/removed member gets the neutral copy, never "declined" (§5.6).
            if (err.code === 'REQUEST_DECLINED') { renderInvite(el, token, { stale }); return; }
            showToast(errorText(err), 'error');
            return;
          }
          if (!stale()) renderInvite(el, token, { stale });
        },
      },
      { label: T.cancel, kind: 'ghost', onClick: () => renderInvite(el, token, { stale }) },
    ],
  });
  const sheet = renderSharingSheet(el.querySelector('.tm-sheet'), { share: defaultShare() });
  el.querySelector('.tm-invite-card')?.scrollIntoView?.({ block: 'start' });
}
