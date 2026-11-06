// T-1 Teams: shared DOM pieces (avatars, mascot, pages, confirm, share, sharing sheet).
// Every user- or Team-supplied string goes through escapeHtml (AGENTS.md); copy lives in
// copy.js (COPY.teams). Pages are modal-nav full-screen pages on mobile (DESIGN.md §6.2.1).

import { COPY, formatCopyText, appCopy } from '../copy.js';
import { escapeHtml, gymSquareChip } from './cards.js';
import { openPage, closePage } from './modal-nav.js';
import { getAllLinkedGyms, getGymShortName } from '../gym-context.js';
import { showToast } from '../main.js';
import { teamsApi } from '../teams-api.js';
import { formatInZone, dayKeyInZone, deviceZone } from '../lib.js';
import {
  avatarColourIndex, initials, SHARE_ROWS, normaliseShare, applyShareChange, inviteUrlOn, isIndefinitePause,
} from './teams-model.js';

export const T = COPY.teams;
export const fmt = (template, values = {}) => formatCopyText(template, values);

// ---- small markup helpers -----------------------------------------------------------------

/** Initials circle in the member's server-assigned colour (§5.5). */
export function avatarHtml(member, { size = 'md', letters = 2, label = true } = {}) {
  const name = String(member?.name ?? '');
  const c = avatarColourIndex(member?.colourIndex);
  const aria = label ? ` role="img" aria-label="${escapeHtml(name)}"` : ' aria-hidden="true"';
  return `<span class="tm-av tm-av-${size} tm-av-c${c}"${aria}>${escapeHtml(initials(name, letters))}</span>`;
}

export function avatarStackHtml(members, { max = 5 } = {}) {
  const list = (members || []).slice(0, max);
  if (!list.length) return '';
  return `<span class="tm-stack" aria-hidden="true">${list.map((m) => avatarHtml(m, { size: 'xs', letters: 1, label: false })).join('')}</span>`;
}

const MASCOT = {
  resting: '/characters/team-stretch.webp',
  sleeping: '/characters/team-bed.webp',
  warming: '/characters/team-running.webp',
};

/**
 * The Team mascot. T-1 has no class data (T-2 brings the state machine, §5.4), so callers
 * use the neutral resting pose; `dim` marks a hidden/not-a-member state.
 */
export function mascotHtml({ size = 60, pose = 'resting', dim = false, alt = '', mascot = null } = {}) {
  // T-2: the server's mascot ({ state, pose, asset, ring, fit }, server/team-mascot.js) is
  // the one source of truth; `pose` only names the neutral T-1 art for screens without it.
  const assetOk = mascot && typeof mascot.asset === 'string' && /^\/characters\/team-[a-z]+\.webp$/.test(mascot.asset);
  const src = assetOk ? mascot.asset : (MASCOT[pose] || MASCOT.resting);
  const altAttr = alt ? `alt="${escapeHtml(alt)}"` : 'alt="" aria-hidden="true"';
  const s = Number(size) || 60;
  let ring = '';
  if (mascot) {
    const r = 28;
    const c = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, Number(mascot.ring) || 0));
    ring = `<svg class="tm-ring" viewBox="0 0 60 60" aria-hidden="true"><circle class="tm-ring-track" cx="30" cy="30" r="${r}"/>${frac > 0 ? `<circle class="tm-ring-prog" cx="30" cy="30" r="${r}" stroke-dasharray="${(frac * c).toFixed(1)} ${c.toFixed(1)}"/>` : ''}</svg>`;
  }
  const cls = `tm-mascot${dim ? ' is-dim' : ''}${mascot && mascot.fit ? ' is-fit' : ''}${mascot ? ' has-ring' : ''}`;
  return `<span class="${cls}" style="--s:${s}px"><span class="tm-mascot-disc"></span>${ring}<img src="${escapeHtml(src)}" ${altAttr} width="${s}" height="${s}" decoding="async"></span>`;
}

/** Class times in the CLASS's zone (AGENTS.md: never a bare Date), with a suffix when it differs from the device's. */
export function whenOf(startAt, timeZone) {
  const zone = timeZone || deviceZone();
  const f = formatInZone(startAt, zone);
  let isToday = false;
  try { isToday = dayKeyInZone(startAt, zone) === dayKeyInZone(new Date().toISOString(), zone); } catch (_) { isToday = false; }
  return { time: f.timeLabel, day: (f.date || '').split(' ')[0], isToday };
}

/** teams-today.js segments as escaped markup. */
export function segmentsHtml(segs) {
  return (segs || []).map((seg, i) => {
    const body = seg.strong ? `<b>${escapeHtml(seg.text.trimStart())}</b>` : escapeHtml(seg.text.trimStart());
    const wrapped = seg.muted ? `<span class="tm-muted">${body}</span>` : body;
    if (i === 0) return wrapped;
    return seg.text.startsWith(' ') ? ` ${wrapped}` : ` · ${wrapped}`;
  }).join('');
}

/** "🚲 Tuesday Riders" with both parts escaped. */
export function teamTitleText(team) {
  const name = String(team?.name ?? '');
  return team?.emoji ? `${team.emoji} ${name}` : name;
}
export const teamTitleHtml = (team) => escapeHtml(teamTitleText(team));

export function memberCountLabel(n) {
  const count = Number(n) || 0;
  return count === 1 ? T.memberOne : fmt(T.memberMany, { count });
}

const svg = (paths, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const ICONS = {
  share: svg('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  manage: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  sort: svg('<path d="M7 4v16M3 16l4 4 4-4"/><path d="M17 20V4M13 8l4-4 4 4"/>', 20),
  pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4Z"/></svg>',
  flame: svg('<path d="M12 22c4 0 7-2.8 7-6.8 0-3.2-2-5.5-3.6-7.2-.3 1.7-1.2 3-2.4 3.7.3-3.6-1.5-6.6-4-8.7-.2 3.3-2.1 5.4-3.7 7.2C4.1 11.6 5 13.1 5 15.2 5 19.2 8 22 12 22Z"/>', 16),
  hidden: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7 1.7 0 3.3-.5 4.6-1.3"/>', 20),
  crown: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5Z"/></svg>',
  shield: svg('<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6Z"/><path d="m9 12 2 2 4-4"/>', 20),
  chevron: svg('<path d="m9 6 6 6-6 6"/>', 18),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 16),
  check: svg('<path d="m5 12.5 5 5 9-10"/>', 16),
};

export function captainBadgeHtml() {
  return `<span class="tm-captain">${ICONS.crown}<span>${escapeHtml(T.captain)}</span></span>`;
}

/** Friendly copy for a TeamsApiError (codes from server/teams.js). */
export function errorText(err, fallback = T.actionFailed) {
  const code = err && err.code;
  if (code === 'LAST_CAPTAIN') return T.lastCaptain;
  if (code === 'TEAM_FULL') return T.teamFull;
  if (code === 'PIN_LIMIT') return err.message && /more than 3/.test(err.message) ? T.pinNotYet : T.pinLimit;
  if (code === 'CAPTAIN_REQUIRED') return T.captainRequired;
  if (code === 'NOT_FOUND') return T.notFound;
  if (code === 'RATE_LIMITED') return T.rateLimited;
  if (code === 'TEAM_LIMIT') return err.message || T.teamLimit;
  if (code === 'PENDING_LIMIT') return T.pendingLimit;
  if (code === 'INVALID' && err.message) return err.message;
  return fallback;
}

/** Pause end as a short local date-time ("Fri 6 Nov, 09:00"). */
export function pauseWhen(pausedUntil) {
  if (isIndefinitePause(pausedUntil)) return null;
  const d = new Date(pausedUntil);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Short pause end for pills ("Thu 09:00" within a day, else "Wed 11 Nov"), as in mock 06. */
export function pauseWhenShort(pausedUntil) {
  if (isIndefinitePause(pausedUntil)) return null;
  const d = new Date(pausedUntil);
  if (Number.isNaN(d.getTime())) return null;
  // Within a day the time matters; further out the date does (a week ahead shares today's weekday).
  return d.getTime() - Date.now() <= 24 * 3600 * 1000
    ? d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function joinedLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return fmt(T.joined, { when: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) });
}

/**
 * "upcoming classes, activity counts and recent classes": what this member currently shares,
 * for the Leave confirmation (§5.7: it names what stops being shared). '' when nothing.
 */
export function sharedThingsText(share) {
  const s = normaliseShare(share);
  const gymsOn = s.gyms === 'all' || (Array.isArray(s.gyms) && s.gyms.length > 0);
  if (!gymsOn) return '';
  const items = SHARE_ROWS.filter((r) => s[r.key]).map((r) => {
    const label = T[ROW_COPY[r.key][0]];
    return label.charAt(0).toLowerCase() + label.slice(1);
  });
  if (!items.length) return '';
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')}${T.listAnd}${items[items.length - 1]}`;
}

/** Leave confirmation body naming what stops being shared. */
export function leaveBodyText(name, share) {
  const what = sharedThingsText(share);
  return what ? fmt(T.leaveConfirmBody, { name, what }) : fmt(T.leaveConfirmNothing, { name });
}

// ---- pages (modal-nav) --------------------------------------------------------------------

let pageSeq = 0;

/**
 * A Teams page: full-screen on mobile (modal-nav), centred card on desktop.
 * Returns { overlay, body, footer, close, setTitle }.
 */
export function openTeamsPage({ id, title, back = true, wide = false, onClose = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = `app-ovl tm-ovl${wide ? ' tm-ovl-wide' : ''}`;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="app-ovl-card tm-ovl-card">
      <div class="app-ovl-header tm-ovl-header">
        <h3 data-nav-title class="tm-ovl-title"></h3>
        <button type="button" class="tm-ovl-close" data-nav-close aria-label="${escapeHtml(COPY.credits.closeModal)}">×</button>
      </div>
      <div class="app-ovl-body tm-ovl-body"></div>
      <div class="tm-ovl-footer" hidden></div>
    </div>`;
  const titleEl = overlay.querySelector('[data-nav-title]');
  titleEl.textContent = title || '';
  const body = overlay.querySelector('.tm-ovl-body');
  const footer = overlay.querySelector('.tm-ovl-footer');
  let closed = false;
  let after = null;
  const onKey = (e) => { if (e.key === 'Escape' && overlay === topOverlay()) close(); };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    try { onClose?.(); } catch (e) { console.error('[Teams] page onClose failed', e); }
    // Navigation after a close must wait for modal-nav's history pop, or the pop lands on it.
    if (after) setTimeout(after, 0);
  };
  function close() {
    if (closed) return;
    if (closePage(overlay)) return; // mobile: pops history; onClose (cleanup) runs from modal-nav
    cleanup();
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  }
  overlay.querySelector('[data-nav-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  openPage(overlay, { id: id || `teams-page-${++pageSeq}`, remove: true, back, onClose: cleanup });
  return {
    overlay, body, footer, close,
    /** Close, then run `fn` once the page's history entry is gone (mobile) or at once (desktop). */
    closeThen: (fn) => { after = fn; close(); },
    setTitle: (t) => { titleEl.textContent = t; },
    isClosed: () => closed,
  };
}

function topOverlay() {
  const all = document.querySelectorAll('.tm-ovl');
  return all[all.length - 1] || null;
}

/** Footer with buttons: [{ label, kind: 'primary'|'ghost'|'danger', onClick }]. */
export function setFooter(page, buttons) {
  page.footer.innerHTML = '';
  page.footer.hidden = !buttons.length;
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tm-btn ${b.kind ? `tm-btn-${b.kind}` : ''} tm-btn-block`;
    btn.textContent = b.label;
    if (b.disabled) btn.disabled = true;
    btn.addEventListener('click', () => b.onClick?.(btn));
    page.footer.appendChild(btn);
  }
  return [...page.footer.querySelectorAll('button')];
}

/**
 * Confirmation page. Resolves true on confirm. `typeToConfirm` requires the exact text
 * (Delete Team). `checkbox` adds an option whose state is returned as { ok, checked }.
 */
export function confirmPage({ title, body, confirmLabel, danger = false, typeToConfirm = null, typeLabel = '', checkbox = null }) {
  return new Promise((resolve) => {
    let result = { ok: false, checked: false };
    const page = openTeamsPage({ title, onClose: () => resolve(checkbox ? result : result.ok) });
    page.body.innerHTML = `<p class="tm-confirm-body"></p>
      ${typeToConfirm != null ? `<label class="tm-field"><span class="tm-field-label"></span><input type="text" class="tm-input" autocomplete="off" autocapitalize="off" spellcheck="false"></label>` : ''}
      ${checkbox ? '<label class="tm-check"><input type="checkbox"><span></span></label>' : ''}`;
    page.body.querySelector('.tm-confirm-body').textContent = body;
    const input = page.body.querySelector('input.tm-input');
    if (input) page.body.querySelector('.tm-field-label').textContent = typeLabel;
    if (checkbox) page.body.querySelector('.tm-check span').textContent = checkbox;
    const [cancelBtn, okBtn] = setFooter(page, [
      { label: T.cancel, kind: 'ghost', onClick: () => page.close() },
      {
        label: confirmLabel,
        kind: danger ? 'danger' : 'primary',
        disabled: typeToConfirm != null,
        onClick: () => {
          result = { ok: true, checked: !!page.body.querySelector('.tm-check input')?.checked };
          page.close();
        },
      },
    ]);
    void cancelBtn;
    if (input) {
      input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== String(typeToConfirm).trim(); });
    }
  });
}

// ---- share the invite link (§5.6) -----------------------------------------------------------

/**
 * Captains: native share sheet where available, else copy to the clipboard, else show the
 * link in a page to copy by hand. The URL is never logged.
 */
export async function shareInvite(team, { url: knownUrl = null } = {}) {
  let url = knownUrl;
  if (!url) {
    let info;
    try { info = await teamsApi.getInvite(team.id); } catch (err) { showToast(errorText(err, T.shareFailed), 'error'); return; }
    if (!info.enabled) { showToast(T.linkOff, 'warning'); return; }
    url = info.url;
  }
  const link = inviteUrlOn(window.location.origin, url);
  if (!link) { showToast(T.shareFailed, 'error'); return; }
  const name = teamTitleText(team);
  const payload = { title: appCopy(T.shareTitle, { name }), text: appCopy(T.shareText, { name }), url: link };
  if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
    try { await navigator.share(payload); return; } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(link);
    showToast(T.linkCopied, 'success');
    return;
  } catch (_) { /* clipboard blocked: show it */ }
  const page = openTeamsPage({ title: T.linkLabel });
  page.body.innerHTML = '<label class="tm-field"><span class="tm-field-label"></span><input type="text" class="tm-input" readonly></label>';
  page.body.querySelector('.tm-field-label').textContent = T.linkLabel;
  const input = page.body.querySelector('input');
  input.value = link;
  setFooter(page, [{ label: T.done, kind: 'primary', onClick: () => page.close() }]);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

// ---- sharing sheet (§3) ----------------------------------------------------------------------

const ROW_COPY = {
  upcoming: ['rowUpcoming', 'rowUpcomingDesc'],
  waitlists: ['rowWaitlists', 'rowWaitlistsDesc'],
  activity: ['rowActivity', 'rowActivityDesc'],
  recent: ['rowRecent', 'rowRecentDesc'],
  spots: ['rowSpots', 'rowSpotsDesc'],
  autoBookQueue: ['rowAutoBookQueue', 'rowAutoBookQueueDesc'],
};

function linkedGymIds() {
  return (getAllLinkedGyms() || []).map((g) => String(g.gym_id || g.id)).filter(Boolean);
}

export function switchHtml(key, on, label, extra = '') {
  return `<label class="tm-switch"><input type="checkbox" role="switch" data-share-key="${escapeHtml(key)}" ${on ? 'checked' : ''} aria-label="${escapeHtml(label)}" ${extra}><span class="tm-switch-track" aria-hidden="true"></span></label>`;
}

/**
 * Render the §3 sheet into `container`. `onChange(share, change)` fires after every edit;
 * it may return a Promise (Manage saves immediately); on rejection the control reverts.
 * Options: competition (show the opt-in row, with the Team name for its copy).
 * Returns { getShare() }.
 */
export function renderSharingSheet(container, { share, onChange = null, competitionTeamName = null } = {}) {
  let state = normaliseShare(share);
  const linked = linkedGymIds();

  const gymChips = () => {
    if (!linked.length) return `<span class="tm-muted tm-xs">${escapeHtml(T.noGymsLinked)}</span>`;
    const all = state.gyms === 'all';
    return linked.map((g) => {
      const on = all || (Array.isArray(state.gyms) && state.gyms.includes(g));
      const name = getGymShortName(g) || g;
      return `<button type="button" class="tm-chip${on ? ' is-on' : ''}" data-gym="${escapeHtml(g)}" aria-pressed="${on}" ${all ? 'disabled' : ''}>${gymSquareChip(g)}<span>${escapeHtml(name)}</span></button>`;
    }).join('') + (all ? `<span class="tm-muted tm-xs tm-chip-note">${escapeHtml(T.gymsLater)}</span>` : '');
  };

  const paint = () => {
    const all = state.gyms === 'all';
    container.innerHTML = `
      <div class="tm-list">
        <div class="tm-sw-row tm-sw-wrap">
          <div class="tm-grow"><div class="tm-t">${escapeHtml(T.gyms)}</div><div class="tm-d">${escapeHtml(T.gymsDesc)}</div></div>
          <span class="tm-seg" role="group" aria-label="${escapeHtml(T.gyms)}">
            <button type="button" data-gyms-mode="all" aria-pressed="${all}" class="${all ? 'is-on' : ''}">${escapeHtml(T.allMyGyms)}</button>
            <button type="button" data-gyms-mode="choose" aria-pressed="${!all}" class="${!all ? 'is-on' : ''}">${escapeHtml(T.choose)}</button>
          </span>
          <div class="tm-chips">${gymChips()}</div>
        </div>
        ${SHARE_ROWS.map((r) => {
          const [t, d] = ROW_COPY[r.key];
          return `<div class="tm-sw-row"><div class="tm-grow"><div class="tm-t">${escapeHtml(T[t])}${r.optIn ? ` <span class="tm-pill tm-pill-off">${escapeHtml(T.optIn)}</span>` : ''}</div><div class="tm-d">${escapeHtml(T[d])}</div></div>${switchHtml(r.key, state[r.key], T[t])}</div>`;
        }).join('')}
      </div>
      <p class="tm-never">${ICONS.shield}<span>${escapeHtml(T.neverShared)}</span></p>
      ${competitionTeamName != null ? `<div class="tm-list tm-mt">
        <div class="tm-sw-row"><div class="tm-grow"><div class="tm-t">${escapeHtml(T.competition)}</div><div class="tm-d">${escapeHtml(fmt(T.competitionMemberDesc, { name: competitionTeamName }))}</div></div>${switchHtml('competition', state.competition, T.competition)}</div>
      </div>` : ''}`;
  };

  const commit = async (change) => {
    const prev = state;
    state = applyShareChange(state, { ...change, linked });
    paint();
    if (!onChange) return;
    try {
      await onChange(state, change);
    } catch (err) {
      state = prev;
      paint();
      showToast(errorText(err, T.shareSaveFailed), 'error');
    }
  };

  container.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-gyms-mode]');
    if (mode) {
      const m = mode.getAttribute('data-gyms-mode');
      if ((m === 'all') !== (state.gyms === 'all')) commit({ type: 'gymsMode', mode: m });
      return;
    }
    const chip = e.target.closest('[data-gym]');
    if (chip && !chip.disabled) commit({ type: 'gym', gymId: chip.getAttribute('data-gym'), on: chip.getAttribute('aria-pressed') !== 'true' });
  });
  container.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-share-key]');
    if (input) commit({ type: 'toggle', key: input.getAttribute('data-share-key'), on: input.checked });
  });
  paint();
  return { getShare: () => normaliseShare(state) };
}
