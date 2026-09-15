// Reusable per-gym Settings section (Settings restructure Phase 2).
//
// This module owns markup and DOM binding only. The settings coordinator supplies
// data and actions, which keeps the component usable inline today and inside the
// Phase 3 multi-gym drawer without teaching it about global app state.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function capability(gym, name) {
  // An omitted capability stays on. This is the same forward-compatible rule
  // as gym-context.js: a new adapter should not lose generic settings merely
  // because its registry entry predates a UI flag.
  return gym?.capabilities?.[name] !== false;
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function creditTotal(credits) {
  return (credits || []).reduce((sum, credit) => sum + (Number(credit.count) || 0), 0);
}

// NOTE: `getGymSettingsPresentation()` used to live here and is gone. It chose
// between an "inline" presentation at one gym and a "list + drawer" one at two
// or more. Both the drawer and that branch are removed: every linked gym now
// renders as its own inline sub-section at every gym count, so there is no
// presentation mode to pick and no n=1 special case to keep in step.

function membershipHtml(gym, membership, credits) {
  if (membership) {
    const dates = [];
    const renews = formatDate(membership.renewsAt);
    const expires = formatDate(membership.expiresAt);
    if (renews) dates.push(`Renews ${renews}`);
    if (expires) dates.push(`Expires ${expires}`);
    if (membership.bookingWindowLabel) dates.push(escapeHtml(membership.bookingWindowLabel));
    const passes = Number.isFinite(Number(membership.guestPassesRemaining))
      ? `${Number(membership.guestPassesRemaining)} guest pass${Number(membership.guestPassesRemaining) === 1 ? '' : 'es'} left`
      : null;
    if (passes) dates.push(passes);
    const manageUrl = membership.manageUrl || gym.websiteUrl;
    return `
      <div class="psycle-gym-setting-summary">
        <div>
          <strong>${escapeHtml(membership.name || 'Gym membership')}</strong>
          <div class="psycle-card-desc">${escapeHtml(membership.status || (membership.isActive ? 'Active' : 'Not active'))}${dates.length ? ` · ${dates.join(' · ')}` : ''}</div>
        </div>
        ${manageUrl ? `<a class="psycle-btn psycle-btn-mini" href="${escapeHtml(manageUrl)}" target="_blank" rel="noopener noreferrer">Open gym site ↗</a>` : ''}
      </div>`;
  }

  if (gym?.capabilities?.metered !== false) {
    const total = creditTotal(credits);
    return `
      <div class="psycle-gym-setting-summary">
        <div><strong>${total} credit${total === 1 ? '' : 's'} available</strong><div class="psycle-card-desc">Across your active credit bundles.</div></div>
        ${gym?.capabilities?.creditPurchase !== false ? '<button class="psycle-btn psycle-btn-mini" data-gym-action="buy-credits">Buy credits →</button>' : ''}
      </div>`;
  }

  return '<p class="psycle-card-desc">Membership details are managed by the gym and are not available yet.</p>';
}

function autoUpgradeHtml(settings) {
  return `
    <div class="psycle-setting-row">
      <div class="psycle-setting-label"><span>Enable Auto-Upgrade Polling</span><small>Toggle background checks for improved spots at this gym.</small></div>
      <label class="psycle-switch"><input type="checkbox" data-gym-setting="autoUpgradeEnabled" ${settings.autoUpgradeEnabled !== false ? 'checked' : ''}><span class="psycle-slider"></span></label>
    </div>
    <div class="psycle-setting-row">
      <div class="psycle-setting-label"><span>Auto-upgrade spots by default</span><small>Start monitoring after each new booking at this gym.</small></div>
      <label class="psycle-switch"><input type="checkbox" data-gym-setting="autoUpgradeByDefault" ${settings.autoUpgradeByDefault ? 'checked' : ''}><span class="psycle-slider"></span></label>
    </div>
    <div class="psycle-setting-row">
      <div class="psycle-setting-label"><span>Continue past 12h cutoff by default</span><small>Keep monitoring without cancelling the original spot.</small></div>
      <label class="psycle-switch"><input type="checkbox" data-gym-setting="autoUpgradeKeepOriginalByDefault" ${settings.autoUpgradeKeepOriginalByDefault ? 'checked' : ''}><span class="psycle-slider"></span></label>
    </div>
    <div class="psycle-setting-row">
      <div class="psycle-setting-label"><span>Polling check interval</span><small>One-minute checks are faster but use more API calls.</small></div>
      <select class="psycle-select" data-gym-setting="autoUpgradeInterval">
        <option value="1min" ${settings.autoUpgradeInterval === '1min' ? 'selected' : ''}>1 minute</option>
        <option value="15min" ${!settings.autoUpgradeInterval || settings.autoUpgradeInterval === '15min' ? 'selected' : ''}>15 minutes</option>
        <option value="1hr" ${settings.autoUpgradeInterval === '1hr' ? 'selected' : ''}>1 hour</option>
      </select>
    </div>`;
}

// NOTE: the calendar card that used to live here moved to an ACCOUNT-level
// section (client/src/ui/calendar-section.js) on 2026-09-14. Rendering it per
// gym gave a two-gym member two .ics URLs, each covering part of their week.
// Do not add a per-gym calendar card back — the feed is one per person.

/**
 * Render every gym-owned setting into one reusable section.
 * @returns {HTMLElement|null} the rendered root.
 */
export function renderGymSettingsSection(container, model, handlers = {}) {
  if (!container) return null;
  const { gym = {}, settings = {}, membership = null, credits = [] } = model;
  const gymName = gym.gym_name || gym.name || gym.gym_id || gym.id || 'Gym';
  const gymEmail = gym.gym_email || gym.email || 'Gym account email not captured';
  const status = gym.status || 'active';
  const needsRelogin = status === 'needs_relogin';
  const statusLabel = needsRelogin ? 'Re-authentication needed' : (status === 'active' ? 'Connected' : status);
  const bookingKind = gym.capabilities?.bookingWindow;
  const windowDescription = bookingKind === 'per-class'
    ? 'Published per class by the gym — there is nothing to configure.'
    : model.bookingWindowText || 'Detecting from your membership…';

  container.dataset.gymId = gym.gym_id || gym.id || '';
  // Prefer the gym's theme-aware CSS token over the raw config hex. The config
  // `theme.primary` is one fixed colour; several brand colours (JAB's navy
  // #18214D especially) are effectively invisible against a dark surface, so
  // using it directly made the accent disappear in dark mode. The token resolves
  // to a legible rendering per theme, and falls back to the raw hex for a gym
  // that has no token block yet.
  const gymIdForTheme = gym.gym_id || gym.id || '';
  container.style.setProperty(
    '--gym-settings-accent',
    gymIdForTheme
      ? `var(--gym-${gymIdForTheme}-ink, ${gym.theme?.primary || 'var(--accent)'})`
      : (gym.theme?.primary || 'var(--accent)')
  );
  container.innerHTML = `
    <div class="psycle-gym-settings-heading"><div><span class="psycle-eyebrow">Gym settings</span><h3>${escapeHtml(gymName)}</h3></div><div class="psycle-settings-btn-row"><span class="psycle-badge ${status === 'active' ? 'success' : 'warning'}">${escapeHtml(statusLabel)}</span>${model.canAddGym ? '<button class="psycle-btn psycle-btn-mini" data-gym-action="add-gym">＋ Connect another gym</button>' : ''}</div></div>
    ${needsRelogin ? '<div class="psycle-gym-settings-warning"><strong>Reconnect this gym</strong><span>The saved gym session could not be renewed. Re-authenticate to resume background bookings and calendar updates.</span></div>' : ''}
    <div class="psycle-settings-grid psycle-gym-settings-grid">
      <div class="psycle-settings-card">
        <h4>Connection</h4><p class="psycle-card-desc">${escapeHtml(gymEmail)}</p>
        <div class="psycle-settings-btn-row"><button class="psycle-btn ${needsRelogin ? 'primary' : ''}" data-gym-action="reauth">Re-authenticate</button><button class="psycle-btn variant-danger" data-gym-action="unlink">Unlink gym</button></div>
      </div>
      <div class="psycle-settings-card"><h4>Membership & Credits</h4>${membershipHtml(gym, membership, credits)}</div>
      <div class="psycle-settings-card">
        <h4>Booking Window</h4><p class="psycle-card-desc">${escapeHtml(windowDescription)}</p>
        ${model.debugMode && bookingKind !== 'per-class' ? `<div class="psycle-setting-row"><div class="psycle-setting-label"><span>Manual override</span><small>Debug only; overrides auto-detection.</small></div><select class="psycle-select" data-gym-setting="manualBookingWindowWeeks"><option value="" ${!settings.manualBookingWindowWeeks ? 'selected' : ''}>Auto (detected)</option>${[1,2,3,4].map(n => `<option value="${n}" ${Number(settings.manualBookingWindowWeeks) === n ? 'selected' : ''}>${n} week${n === 1 ? '' : 's'}</option>`).join('')}</select></div>` : ''}
      </div>
      ${capability(gym, 'autoUpgrade') ? `<div class="psycle-settings-card"><h4>Auto-Upgrade Engine</h4>${autoUpgradeHtml(settings)}</div>` : ''}
      ${capability(gym, 'spotMaps') ? '<div class="psycle-settings-card"><h4>Preferred Spot Maps</h4><p class="psycle-card-desc">Manage the seat preferences used by booking and Auto-Upgrade at this gym.</p><button class="psycle-btn" data-gym-action="spot-maps">Manage maps</button></div>' : ''}
      ${capability(gym, 'profile') ? '<div class="psycle-settings-card"><h4>Profile Explorer</h4><p class="psycle-card-desc">View the profile, membership and booking metadata returned by this gym.</p><button class="psycle-btn" data-gym-action="profile">Open Profile Explorer</button></div>' : ''}
    </div>`;

  container.querySelectorAll('[data-gym-action]').forEach((button) => {
    button.addEventListener('click', () => handlers.onAction?.(button.dataset.gymAction, button));
  });
  container.querySelectorAll('[data-gym-setting]').forEach((input) => {
    input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked : (input.value === '' ? null : input.value);
      handlers.onSettingChange?.(input.dataset.gymSetting, value, input);
    });
  });
  return container;
}
