// Account-level calendar feed settings.
//
// This used to live inside gym-settings-section.js, rendered once per gym. That
// made the feed per-gym: a member of two gyms got two .ics URLs, each showing
// part of their week, and had to subscribe twice to see all of it. A person has
// one calendar. The token moved to the account (users.calendar_token), the
// server fans the feed out across every linked gym, and this section is the one
// place it is configured.
//
// There is deliberately NO gymId anywhere in this file. If one appears, the
// split has crept back.

import { noSept } from '../lib';
import { api } from '../api';
import { showToast, getIsOffline } from '../main';
import { escapeHtml, icon } from './cards';
import { COPY, formatCopyText } from '../copy.js';
import { openPage as openNavPage, closePage as closeNavPage } from './modal-nav.js';

// Simplified inline marks (no hotlinking). They approximate the Apple and Google
// Calendar app icons; they are not pixel-faithful reproductions.
const APPLE_CAL_LOGO = `<svg class="psycle-cal-logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#d1d1d6"/><text x="16" y="10.5" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="6.5" font-weight="600" fill="#ff3b30">WED</text><text x="16" y="25" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="15" font-weight="300" fill="#1c1c1e">17</text></svg>`;
const GOOGLE_CAL_LOGO = `<svg class="psycle-cal-logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="2.5" fill="#fff"/><path d="M5 27V7.5A2.5 2.5 0 0 1 7.5 5H12v4H9v14h0v4H5z" fill="#4285f4"/><path d="M9 23h14v4H9z" fill="#34a853"/><path d="M23 9h4v14h-4z" fill="#fbbc04"/><path d="M23 23h4v2.5a1.5 1.5 0 0 1-1.5 1.5H23z" fill="#ea4335"/><path d="M23 5h2.5A1.5 1.5 0 0 1 27 6.5V9h-4z" fill="#1967d2"/><path d="M12 5h11v4H12z" fill="#4285f4"/><text x="16" y="21" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#4285f4">31</text></svg>`;

function gymCoverageLine(status) {
  const gyms = status.gyms || [];
  if (gyms.length === 0) return COPY.calendar.connectGym;
  if (gyms.length === 1) return COPY.calendar.onboardingIncludesGym.replace('{gymName}', gyms[0].name);
  const names = gyms.map((g) => g.name);
  const last = names.pop();
  return COPY.calendar.onboardingIncludesGyms.replace('{names}', names.join(', ')).replace('{last}', last);
}

function checkRow({ key, title, help, checked, disabled = false }) {
  const attrs = key ? `data-calendar-setting="${key}"` : '';
  return `
    <label class="psycle-setting-row psycle-cal-check${disabled ? ' is-disabled' : ''}">
      <input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="psycle-cal-box" aria-hidden="true"></span>
      <span class="psycle-setting-label"><span>${escapeHtml(title)}</span><small>${escapeHtml(help)}</small></span>
    </label>`;
}

function feedCardHtml(status) {
  const enabled = !!status.enabled;
  const generated = status.generatedAt
    ? COPY.calendar.lastUpdated.replace('{date}', noSept(new Date(status.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })))
    : COPY.calendar.notPublished;
  return `
    <div class="psycle-settings-card">
      <h4>${COPY.calendar.feedTitle}</h4>
      <div class="psycle-setting-row">
        <div class="psycle-setting-label">
          <span>${enabled ? COPY.calendar.feedOn : COPY.calendar.feedOff}</span>
          <small>${enabled ? escapeHtml(`${gymCoverageLine(status)} ${generated}`) : COPY.calendar.feedOffDescription}</small>
        </div>
      </div>
      <div class="psycle-cal-feed-actions">
        ${enabled ? `<button class="psycle-btn psycle-cal-feed-btn" data-calendar-action="refresh">${icon('refresh', 16)}<span>${COPY.calendar.refreshNow}</span></button>
        <button class="psycle-btn psycle-cal-feed-btn variant-danger" data-calendar-action="disable">${icon('power', 16)}<span>${COPY.calendar.turnOffFeed}</span></button>`
        : `<button class="psycle-btn psycle-cal-feed-btn" data-calendar-action="enable">${icon('power', 16)}<span>${COPY.calendar.turnOnFeed}</span></button>`}
      </div>
    </div>`;
}

function includeCardHtml(status) {
  const weekly = status.weeklyGyms || [];
  const names = weekly.map((g) => g.name).join(' and ');
  return `
    <div class="psycle-settings-card">
      <h4>${COPY.calendar.includeTitle}</h4>
      <p class="psycle-card-desc">${COPY.calendar.includeDescription}</p>
      ${checkRow({ title: COPY.calendar.bookedClasses, help: COPY.calendar.alwaysIncluded, checked: true, disabled: true })}
      ${checkRow({ key: 'includeWaitlists', title: COPY.calendar.waitlists, help: COPY.calendar.tentativeWaitlists, checked: status.includeWaitlists })}
      ${checkRow({ key: 'includeAutoBook', title: COPY.calendar.autoBook, help: COPY.calendar.tentativeAutoBook, checked: status.includeAutoBook })}
      ${weekly.length ? checkRow({ key: 'remindBookingWindow', title: COPY.calendar.weeklyReminder, help: formatCopyText(COPY.calendar.weeklyReminderHelp, { gyms: names }), checked: status.remindBookingWindow }) : ''}
    </div>`;
}

function remindersCardHtml(status) {
  const r = status.reminders || {};
  return `
    <div class="psycle-settings-card">
      <h4>${COPY.calendar.reminders}</h4>
      <p class="psycle-card-desc">${COPY.calendar.reminderDescription}</p>
      ${checkRow({ key: 'reminders.twoHour', title: COPY.calendar.twoHoursBefore, help: COPY.calendar.leaveReminder, checked: r.twoHour })}
      ${checkRow({ key: 'reminders.cancelWindow', title: COPY.calendar.beforeCancellationEnds, help: COPY.calendar.cancellationReminder, checked: r.cancelWindow })}
    </div>`;
}

function addCardHtml(status) {
  return `
    <div class="psycle-settings-card">
      <h4>${COPY.calendar.addToCalendar}</h4>
      <p class="psycle-card-desc">${COPY.calendar.feedUpdatesDescription}</p>
      <div class="psycle-cal-add-list">
        <button class="psycle-btn psycle-cal-add-btn" data-calendar-action="apple">${APPLE_CAL_LOGO}<span>${COPY.calendar.appleCalendar}</span></button>
        <button class="psycle-btn psycle-cal-add-btn" data-calendar-action="google">${GOOGLE_CAL_LOGO}<span>${COPY.calendar.googleCalendar}</span></button>
        <button class="psycle-btn psycle-cal-add-btn" data-calendar-action="copy"><span class="psycle-cal-logo psycle-cal-logo-generic">${icon('link', 18)}</span><span>${COPY.calendar.copyLink}</span></button>
      </div>
    </div>`;
}

export async function renderCalendarSection(targetContainer = null) {
  const container = targetContainer || document.getElementById('psycle-calendar-section');
  if (!container) return;

  let status;
  try {
    status = await api.getCalendarStatus();
  } catch (err) {
    const msg = `<div class="psycle-settings-card"><p class="${getIsOffline() ? 'psycle-card-desc' : 'psycle-card-error'}">${getIsOffline() ? COPY.calendar.noSavedStatus : formatCopyText(COPY.calendar.loadingFailed, { error: escapeHtml(err.message) })}</p></div>`;
    container.innerHTML = msg;
    return;
  }

  // A server that predates U4-16 still answers with the legacy shape; read it the
  // same way the new server does so the panel is right during a staggered deploy.
  const legacyOn = !!status.includeTentative;
  const legacyAlarm = status.alarm || 'none';
  status = {
    ...status,
    includeWaitlists: status.includeWaitlists ?? legacyOn,
    includeAutoBook: status.includeAutoBook ?? legacyOn,
    reminders: status.reminders || { twoHour: legacyAlarm === '2h' || legacyAlarm === 'both', cancelWindow: legacyAlarm === 'penalty' || legacyAlarm === 'both' },
  };

  // Card order: feed on/off, Include, Reminders, Add to calendar.
  container.innerHTML = feedCardHtml(status) + (status.enabled ? includeCardHtml(status) + remindersCardHtml(status) + addCardHtml(status) : '');

  const val = (key) => container.querySelector(`[data-calendar-setting="${key}"]`);
  const notifyActionComplete = () => container.dispatchEvent(new CustomEvent('sweat:calendar-action-complete'));
  const prefs = () => {
    // Feed off: the option controls are not on screen, so send nothing and keep saved prefs.
    if (!val('includeWaitlists')) return {};
    const out = {
      includeWaitlists: !!val('includeWaitlists')?.checked,
      includeAutoBook: !!val('includeAutoBook')?.checked,
      reminders: { twoHour: !!val('reminders.twoHour')?.checked, cancelWindow: !!val('reminders.cancelWindow')?.checked },
    };
    // Only sent when the option is on screen: a hidden option must not be
    // silently switched off by an unrelated change.
    if (val('remindBookingWindow')) out.remindBookingWindow = !!val('remindBookingWindow').checked;
    return out;
  };
  const rerender = () => renderCalendarSection(container).catch(() => {});

  // Changing a preference re-publishes the feed, so the change reaches the
  // subscribed device rather than waiting for the 3-hourly cycle.
  container.querySelectorAll('[data-calendar-setting]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api.enableCalendar(prefs());
        await rerender();
        showToast(COPY.calendar.updated, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        notifyActionComplete();
      }
    });
  });

  container.querySelectorAll('[data-calendar-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.calendarAction;
      const links = status.links || {};

      // webcal:// is the only subscribe scheme iOS/macOS register. webcals:// is not, so Safari on iOS
      // answers it with "the address is invalid".
      if (action === 'apple') { if (links.webcal) window.location.href = links.webcal; return; }
      if (action === 'google') { if (links.google) window.open(links.google, '_blank', 'noopener'); return; }
      if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(links.https || '');
          showToast(COPY.calendar.linkCopied, 'success');
        } catch (_) {
          showToast(COPY.calendar.copyFailed, 'error');
        }
        return;
      }

      button.disabled = true;
      try {
        if (action === 'enable') await api.enableCalendar(prefs());
        if (action === 'disable') await api.disableCalendar();
        if (action === 'refresh') await api.refreshCalendar();
        showToast(
          action === 'disable' ? COPY.calendar.turnedOff
            : action === 'enable' ? COPY.calendar.turnedOn
            : COPY.calendar.refreshing,
          'success'
        );
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        button.disabled = false;
        await rerender();
        notifyActionComplete();
      }
    });
  });
}

/**
 * Calendar settings in a modal (onboarding), built like the Preferred Spot Maps manager: a centred card
 * on desktop and a full-screen page on mobile (modal-nav), with a Done button at the bottom.
 * Renders the same account-level section as Settings; `onClose` fires once however it is dismissed.
 */
export function openCalendarSettingsModal({ zIndex = 2000, onChange = null, onClose = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'sa-ovl';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText = `position:fixed;inset:0;background:color-mix(in srgb, var(--bg) 60%, transparent);z-index:${zIndex};display:flex;align-items:center;justify-content:center;padding:16px;`;
  overlay.innerHTML = `
    <div class="sa-ovl-card" style="background:var(--bg);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);border-radius:16px;width:100%;max-width:500px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;">
      <div class="sa-ovl-header" style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;">
        <h3 data-nav-title style="margin:0;font-size:16px;font-weight:700;color:var(--text);"></h3>
        <button type="button" data-nav-close data-calendar-modal-close aria-label="${COPY.credits.closeModal}" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:0;line-height:1;">×</button>
      </div>
      <div class="sa-ovl-body" style="flex:1;overflow-y:auto;padding:16px;"><div data-calendar-modal-section></div></div>
      <div style="padding:12px 16px;border-top:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;">
        <button type="button" class="psycle-btn-primary" data-calendar-modal-close style="width:100%;"></button>
      </div>
    </div>`;
  overlay.querySelector('h3').textContent = COPY.onboarding.calendarFeatureTitle;
  overlay.querySelector('.psycle-btn-primary').textContent = COPY.onboarding.done;

  const section = overlay.querySelector('[data-calendar-modal-section]');
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const close = () => {
    if (closeNavPage(overlay)) return; // mobile: pops the page; onClose below runs cleanup
    cleanup();
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.querySelectorAll('[data-calendar-modal-close]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  if (onChange) section.addEventListener('sweat:calendar-action-complete', onChange);

  document.body.appendChild(overlay);
  openNavPage(overlay, { id: 'calendar-settings', remove: true, onClose: cleanup });
  renderCalendarSection(section);
  return { close };
}
