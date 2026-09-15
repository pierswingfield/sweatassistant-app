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

import { api } from '../api';
import { showToast } from '../main';
import { escapeHtml } from './cards';

function gymCoverageLine(status) {
  const gyms = status.gyms || [];
  if (gyms.length === 0) return 'Connect a gym to start filling your calendar.';
  if (gyms.length === 1) return `Includes your ${escapeHtml(gyms[0].name)} classes.`;
  const names = gyms.map((g) => escapeHtml(g.name));
  const last = names.pop();
  return `Includes classes from ${names.join(', ')} and ${last} in one feed.`;
}

function calendarHtml(status = {}) {
  const enabled = !!status.enabled;
  const generated = status.generatedAt
    ? `Last updated ${new Date(status.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'Not published yet.';
  return `
    <div class="psycle-setting-row">
      <div class="psycle-setting-label">
        <span>Calendar feed</span>
        <small data-calendar-description>${enabled ? `${escapeHtml(gymCoverageLine(status))} ${escapeHtml(generated)}` : 'Turn on to get a personal calendar link.'}</small>
      </div>
      <button class="psycle-btn psycle-btn-mini" data-calendar-action="enable" ${enabled ? 'hidden' : ''}>Turn on</button>
    </div>
    <div data-calendar-options ${enabled ? '' : 'hidden'}>
      <div class="psycle-setting-row">
        <div class="psycle-setting-label"><span>Include unconfirmed classes</span><small>Show pending Auto-Book and waitlist entries.</small></div>
        <label class="psycle-switch"><input type="checkbox" data-calendar-setting="includeTentative" ${status.includeTentative ? 'checked' : ''}><span class="psycle-slider"></span></label>
      </div>
      <div class="psycle-setting-row">
        <div class="psycle-setting-label"><span>Reminders</span><small>Add alerts before confirmed classes.</small></div>
        <select class="psycle-select" data-calendar-setting="alarm">
          <option value="none" ${!status.alarm || status.alarm === 'none' ? 'selected' : ''}>Off</option>
          <option value="2h" ${status.alarm === '2h' ? 'selected' : ''}>2 hours before</option>
          <option value="penalty" ${status.alarm === 'penalty' ? 'selected' : ''}>Before penalty cancellation</option>
          <option value="both" ${status.alarm === 'both' ? 'selected' : ''}>Both</option>
        </select>
      </div>
      <div class="psycle-settings-btn-row">
        <button class="psycle-btn" data-calendar-action="apple">Apple Calendar</button>
        <button class="psycle-btn" data-calendar-action="google">Google Calendar</button>
        <button class="psycle-btn" data-calendar-action="copy">Copy link</button>
        <button class="psycle-btn" data-calendar-action="refresh">Refresh</button>
      </div>
      <button class="psycle-btn variant-danger" data-calendar-action="disable">Turn off calendar feed</button>
    </div>`;
}

export async function renderCalendarSection(targetContainer = null) {
  const container = targetContainer || document.getElementById('psycle-calendar-section');
  if (!container) return;

  let status;
  try {
    status = await api.getCalendarStatus();
  } catch (err) {
    container.innerHTML = `<p class="psycle-card-error">Couldn't load calendar settings (${escapeHtml(err.message)})</p>`;
    return;
  }

  container.innerHTML = calendarHtml(status);

  const prefs = () => ({
    includeTentative: !!container.querySelector('[data-calendar-setting="includeTentative"]')?.checked,
    alarm: container.querySelector('[data-calendar-setting="alarm"]')?.value || 'none',
  });
  const rerender = () => renderCalendarSection(container).catch(() => {});

  // Changing a preference while the feed is on re-publishes it, so the change
  // reaches the subscribed device rather than waiting for the 3-hourly cycle.
  container.querySelectorAll('[data-calendar-setting]').forEach((input) => {
    input.addEventListener('change', async () => {
      if (!status.enabled) return;
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

      if (action === 'apple') { if (links.webcal) window.location.href = links.webcal; return; }
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
