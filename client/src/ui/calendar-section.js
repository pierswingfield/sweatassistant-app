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
import { showToast } from '../main';
import { escapeHtml, icon } from './cards';

// Simplified inline marks (no hotlinking). They approximate the Apple and Google
// Calendar app icons; they are not pixel-faithful reproductions.
const APPLE_CAL_LOGO = `<svg class="psycle-cal-logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#d1d1d6"/><text x="16" y="10.5" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="6.5" font-weight="600" fill="#ff3b30">WED</text><text x="16" y="25" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="15" font-weight="300" fill="#1c1c1e">17</text></svg>`;
const GOOGLE_CAL_LOGO = `<svg class="psycle-cal-logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="2.5" fill="#fff"/><path d="M5 27V7.5A2.5 2.5 0 0 1 7.5 5H12v4H9v14h0v4H5z" fill="#4285f4"/><path d="M9 23h14v4H9z" fill="#34a853"/><path d="M23 9h4v14h-4z" fill="#fbbc04"/><path d="M23 23h4v2.5a1.5 1.5 0 0 1-1.5 1.5H23z" fill="#ea4335"/><path d="M23 5h2.5A1.5 1.5 0 0 1 27 6.5V9h-4z" fill="#1967d2"/><path d="M12 5h11v4H12z" fill="#4285f4"/><text x="16" y="21" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#4285f4">31</text></svg>`;

function gymCoverageLine(status) {
  const gyms = status.gyms || [];
  if (gyms.length === 0) return 'Connect a gym to start filling your calendar.';
  if (gyms.length === 1) return `Includes your ${gyms[0].name} classes.`;
  const names = gyms.map((g) => g.name);
  const last = names.pop();
  return `Includes classes from ${names.join(', ')} and ${last} in one feed.`;
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
    ? `Last updated ${noSept(new Date(status.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}`
    : 'Not published yet.';
  return `
    <div class="psycle-settings-card">
      <h4>Calendar feed</h4>
      <div class="psycle-setting-row">
        <div class="psycle-setting-label">
          <span>${enabled ? 'Feed is on' : 'Feed is off'}</span>
          <small>${enabled ? escapeHtml(`${gymCoverageLine(status)} ${generated}`) : 'Turn on to get a personal calendar link.'}</small>
        </div>
      </div>
      <div class="psycle-cal-feed-actions">
        ${enabled ? `<button class="psycle-btn psycle-cal-feed-btn" data-calendar-action="refresh">${icon('refresh', 16)}<span>Refresh now</span></button>
        <button class="psycle-btn psycle-cal-feed-btn variant-danger" data-calendar-action="disable">${icon('power', 16)}<span>Turn off calendar feed</span></button>`
        : `<button class="psycle-btn psycle-cal-feed-btn" data-calendar-action="enable">${icon('power', 16)}<span>Turn on calendar feed</span></button>`}
      </div>
    </div>`;
}

function includeCardHtml(status) {
  const weekly = status.weeklyGyms || [];
  const names = weekly.map((g) => g.name).join(' and ');
  return `
    <div class="psycle-settings-card">
      <h4>Include</h4>
      <p class="psycle-card-desc">Choose what appears in your calendar.</p>
      ${checkRow({ title: 'Booked classes', help: 'Always included.', checked: true, disabled: true })}
      ${checkRow({ key: 'includeWaitlists', title: 'Waitlists', help: 'Classes you are waitlisted for, shown as tentative.', checked: status.includeWaitlists })}
      ${checkRow({ key: 'includeAutoBook', title: 'Auto-Book', help: 'Scheduled Auto-Book classes, shown as tentative.', checked: status.includeAutoBook })}
      ${weekly.length ? checkRow({ key: 'remindBookingWindow', title: 'Remind me when weekly booking opens', help: `Adds an event when booking opens at ${names}, with a 15-minute alert.`, checked: status.remindBookingWindow }) : ''}
    </div>`;
}

function remindersCardHtml(status) {
  const r = status.reminders || {};
  return `
    <div class="psycle-settings-card">
      <h4>Reminders</h4>
      <p class="psycle-card-desc">Event reminders from your calendar app. Applied to booked classes only.</p>
      ${checkRow({ key: 'reminders.twoHour', title: '2 hours before class', help: 'A reminder shortly before you need to leave.', checked: r.twoHour })}
      ${checkRow({ key: 'reminders.cancelWindow', title: 'Before free cancellation ends', help: '12 hours before class, when free cancellation closes.', checked: r.cancelWindow })}
    </div>`;
}

function addCardHtml(status) {
  return `
    <div class="psycle-settings-card">
      <h4>Add to calendar</h4>
      <p class="psycle-card-desc">Your feed updates itself: bookings, upgrades and cancellations follow automatically.</p>
      <div class="psycle-cal-add-list">
        <button class="psycle-btn psycle-cal-add-btn" data-calendar-action="apple">${APPLE_CAL_LOGO}<span>Apple Calendar</span></button>
        <button class="psycle-btn psycle-cal-add-btn" data-calendar-action="google">${GOOGLE_CAL_LOGO}<span>Google Calendar</span></button>
        <button class="psycle-btn psycle-cal-add-btn" data-calendar-action="copy"><span class="psycle-cal-logo psycle-cal-logo-generic">${icon('link', 18)}</span><span>Copy link</span></button>
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
    const msg = `<div class="psycle-settings-card"><p class="psycle-card-error">Couldn't load calendar settings (${escapeHtml(err.message)})</p></div>`;
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
        showToast('Calendar feed updated.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('[data-calendar-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.calendarAction;
      const links = status.links || {};

      // webcals:// (the https form): plain webcal:// makes Apple Calendar warn "connection is not secure".
      if (action === 'apple') { const u = links.webcals || links.webcal; if (u) window.location.href = u; return; }
      if (action === 'google') { if (links.google) window.open(links.google, '_blank', 'noopener'); return; }
      if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(links.https || '');
          showToast('Calendar link copied.', 'success');
        } catch (_) {
          showToast('Could not copy the link — long-press it to copy manually.', 'error');
        }
        return;
      }

      button.disabled = true;
      try {
        if (action === 'enable') await api.enableCalendar(prefs());
        if (action === 'disable') await api.disableCalendar();
        if (action === 'refresh') await api.refreshCalendar();
        showToast(
          action === 'disable' ? 'Calendar feed turned off.'
            : action === 'enable' ? 'Calendar feed turned on.'
            : 'Calendar feed refreshing.',
          'success'
        );
        if (action !== 'refresh') rerender();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}
