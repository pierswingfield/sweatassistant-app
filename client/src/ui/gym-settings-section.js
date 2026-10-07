import { noSept } from '../lib';
import { COPY, formatCopyText } from '../copy.js';
import { gymLogoBanner } from './cards.js';
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
  return noSept(date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
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
    if (renews) dates.push(formatCopyText(COPY.credits.renews, { date: renews }));
    if (expires) dates.push(formatCopyText(COPY.credits.expires, { date: expires }));
    if (membership.bookingWindowLabel) dates.push(escapeHtml(membership.bookingWindowLabel));
    const passes = Number.isFinite(Number(membership.guestPassesRemaining))
      ? formatCopyText(Number(membership.guestPassesRemaining) === 1 ? COPY.gymSettings.guestPassesOne : COPY.gymSettings.guestPassesMany, { count: Number(membership.guestPassesRemaining) })
      : null;
    if (passes) dates.push(passes);
    const manageUrl = membership.manageUrl || gym.websiteUrl;
    return `
      <div class="app-gym-setting-summary">
        <div>
          <strong>${escapeHtml(membership.name || COPY.gymSettings.membershipName)}</strong>
          <div class="app-card-desc">${escapeHtml(membership.status || (membership.isActive ? COPY.gymSettings.membershipActive : COPY.credits.notActive))}${dates.length ? ` · ${dates.join(' · ')}` : ''}</div>
        </div>
        ${manageUrl ? `<a class="app-btn app-btn-mini" href="${escapeHtml(manageUrl)}" target="_blank" rel="noopener noreferrer">${COPY.gymSettings.openGymSite} ↗</a>` : ''}
      </div>`;
  }

  if (gym?.capabilities?.metered !== false) {
    const total = creditTotal(credits);
    return `
      <div class="app-gym-setting-summary">
        <div><strong>${total} ${total === 1 ? COPY.credits.creditAvailableOne : COPY.credits.creditAvailableMany}</strong><div class="app-card-desc">${COPY.gymSettings.activeCreditBundles}</div></div>
        ${gym?.capabilities?.creditPurchase !== false ? `<button class="app-btn app-btn-mini" data-gym-action="buy-credits">${COPY.credits.buyCredits}</button>` : ''}
      </div>`;
  }

  return `<p class="app-card-desc">${COPY.gymSettings.membershipManagedByGym}</p>`;
}

function autoUpgradeHtml(settings) {
  return `
    <div class="app-setting-row">
      <div class="app-setting-label"><span>${COPY.gymSettings.enablePolling}</span><small>${COPY.gymSettings.pollingHelp}</small></div>
      <label class="app-switch"><input type="checkbox" data-gym-setting="autoUpgradeEnabled" ${settings.autoUpgradeEnabled !== false ? 'checked' : ''}><span class="app-slider"></span></label>
    </div>
    <p class="app-card-desc" data-autoupgrade-off-note ${settings.autoUpgradeEnabled === false ? '' : 'hidden'}>${COPY.gymSettings.pollingOffNote}</p>
    <div class="app-setting-row" data-autoupgrade-dependent ${settings.autoUpgradeEnabled === false ? 'aria-disabled="true" style="opacity:.5"' : ''}>
      <div class="app-setting-label"><span>${COPY.gymSettings.autoUpgradeByDefault}</span><small>${COPY.gymSettings.autoUpgradeByDefaultHelp}</small></div>
      <label class="app-switch"><input type="checkbox" data-gym-setting="autoUpgradeByDefault" ${settings.autoUpgradeEnabled === false ? 'disabled' : ''} ${settings.autoUpgradeByDefault ? 'checked' : ''}><span class="app-slider"></span></label>
    </div>
    <div class="app-setting-row" data-autoupgrade-dependent ${settings.autoUpgradeEnabled === false ? 'aria-disabled="true" style="opacity:.5"' : ''}>
      <div class="app-setting-label"><span>${COPY.gymSettings.continueCutoffByDefault}</span><small>${COPY.gymSettings.continueCutoffHelp}</small></div>
      <label class="app-switch"><input type="checkbox" data-gym-setting="autoUpgradeKeepOriginalByDefault" ${settings.autoUpgradeEnabled === false ? 'disabled' : ''} ${settings.autoUpgradeKeepOriginalByDefault ? 'checked' : ''}><span class="app-slider"></span></label>
    </div>
    <div class="app-setting-row" data-autoupgrade-dependent ${settings.autoUpgradeEnabled === false ? 'aria-disabled="true" style="opacity:.5"' : ''}>
      <div class="app-setting-label"><span>${COPY.gymSettings.pollingInterval}</span><small>${COPY.gymSettings.pollingIntervalHelp}</small></div>
      <select class="app-select" data-gym-setting="autoUpgradeInterval" ${settings.autoUpgradeEnabled === false ? 'disabled' : ''}>
        <option value="1min" ${settings.autoUpgradeInterval === '1min' ? 'selected' : ''}>${COPY.gymSettings.pollingOneMinute}</option>
        <option value="15min" ${!settings.autoUpgradeInterval || settings.autoUpgradeInterval === '15min' ? 'selected' : ''}>${COPY.gymSettings.pollingFifteenMinutes}</option>
        <option value="1hr" ${settings.autoUpgradeInterval === '1hr' ? 'selected' : ''}>${COPY.gymSettings.pollingOneHour}</option>
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
  const gymName = gym.gym_name || gym.name || gym.gym_id || gym.id || COPY.gymSettings.genericGym;
  const gymEmail = gym.gym_email || gym.email || COPY.gymSettings.gymAccountEmailNotCaptured;
  const status = gym.status || 'active';
  const needsRelogin = status === 'needs_relogin';
  const statusLabel = needsRelogin ? COPY.auth.reauthenticationNeeded : (status === 'active' ? COPY.gyms.connected : status);
  const bookingKind = gym.capabilities?.bookingWindow;
  const windowDescription = gym.bookingWindowSummary
    ? gym.bookingWindowSummary
    : bookingKind === 'per-class'
    ? COPY.gymSettings.publishedBookingWindow
    : model.bookingWindowText || COPY.gymSettings.detectingMembership;

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
  const logoBannerHtml = model.logoHtml || (gymIdForTheme ? gymLogoBanner(gymIdForTheme) : '');
  container.innerHTML = `
    <div class="app-gym-settings-heading"><div class="app-gym-settings-brand">${logoBannerHtml}</div><div class="app-settings-btn-row"><span class="app-badge ${status === 'active' ? 'success' : 'warning'}">${escapeHtml(statusLabel)}</span>${model.canAddGym ? `<button class="app-btn app-btn-mini" data-gym-action="add-gym">${COPY.gymSettings.addAnotherGym}</button>` : ''}</div></div>
    ${needsRelogin ? `<div class="app-gym-settings-warning"><strong>${COPY.gymSettings.reconnect}</strong><span>${COPY.gymSettings.reconnectHelp}</span></div>` : ''}
    <div class="app-settings-grid app-gym-settings-grid">
      <div class="app-settings-card">
        <h4>${COPY.gymSettings.connection}</h4>
        <div class="app-gym-conn-inline-row">
          <p class="app-card-desc">${escapeHtml(gymEmail)}</p>
          <div class="app-settings-btn-row">
            <button class="app-btn app-btn-mini ${needsRelogin ? 'primary' : ''}" data-gym-action="reauth">${COPY.gymSettings.reauthenticate}</button>
            <button class="app-btn app-btn-mini variant-danger" data-gym-action="unlink">${COPY.gymSettings.unlink}</button>
          </div>
        </div>
      </div>
      ${capability(gym, 'spotMaps') ? `<div class="app-settings-card"><h4>${COPY.spotMaps.preferredSpotMaps}</h4><p class="app-card-desc">${COPY.gymSettings.spotMapHelp}</p><button class="app-btn" data-gym-action="spot-maps">${COPY.gymSettings.manageMaps}</button></div>` : ''}
      <div class="app-settings-card"><h4>${COPY.gymSettings.membershipCredits}</h4>${membershipHtml(gym, membership, credits)}</div>
      <div class="app-settings-card">
        <h4>${COPY.gymSettings.bookingWindow}</h4><p class="app-card-desc">${escapeHtml(windowDescription)}</p>
        ${model.debugMode && bookingKind !== 'per-class' ? `<div class="app-setting-row"><div class="app-setting-label"><span>${COPY.gymSettings.manualOverride}</span><small>${COPY.gymSettings.debugOverrideHelp}</small></div><select class="app-select" data-gym-setting="manualBookingWindowWeeks"><option value="" ${!settings.manualBookingWindowWeeks ? 'selected' : ''}>${COPY.gymSettings.autoDetected}</option>${[1,2,3,4].map(n => `<option value="${n}" ${Number(settings.manualBookingWindowWeeks) === n ? 'selected' : ''}>${formatCopyText(n === 1 ? COPY.gymSettings.weekOptionOne : COPY.gymSettings.weekOptionMany, { count: n })}</option>`).join('')}</select></div>` : ''}
      </div>
      ${capability(gym, 'autoUpgrade') ? `<div class="app-settings-card"><h4>${COPY.gymSettings.autoUpgradeEngine}</h4>${autoUpgradeHtml(settings)}</div>` : ''}
      ${capability(gym, 'profile') ? `<div class="app-settings-card"><h4>${COPY.gymSettings.profileExplorer}</h4><p class="app-card-desc">${COPY.gymSettings.profileExplorerHelp}</p><button class="app-btn" data-gym-action="profile">${COPY.gymSettings.openProfileExplorer}</button></div>` : ''}
    </div>`;

  const brandEl = container.querySelector('.app-gym-settings-brand');
  if (brandEl && gymName) {
    brandEl.setAttribute('title', gymName);
    brandEl.setAttribute('aria-label', gymName);
    const img = brandEl.querySelector('img');
    if (img) img.setAttribute('alt', gymName);
    const svg = brandEl.querySelector('svg');
    if (svg) svg.setAttribute('aria-label', gymName);
  }

  container.querySelectorAll('[data-gym-action]').forEach((button) => {
    button.addEventListener('click', () => handlers.onAction?.(button.dataset.gymAction, button));
  });
  // Polling off => the controls that only matter while polling is on go inert.
  const syncAutoUpgradeDependents = (pollingOn) => {
    container.querySelectorAll('[data-autoupgrade-dependent]').forEach((row) => {
      row.style.opacity = pollingOn ? '' : '.5';
      if (pollingOn) row.removeAttribute('aria-disabled'); else row.setAttribute('aria-disabled', 'true');
      row.querySelectorAll('[data-gym-setting]').forEach((c) => { c.disabled = !pollingOn; });
    });
    const note = container.querySelector('[data-autoupgrade-off-note]');
    if (note) note.hidden = pollingOn;
  };
  container.querySelectorAll('[data-gym-setting]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.dataset.gymSetting === 'autoUpgradeEnabled') syncAutoUpgradeDependents(input.checked);
      const value = input.type === 'checkbox' ? input.checked : (input.value === '' ? null : input.value);
      handlers.onSettingChange?.(input.dataset.gymSetting, value, input);
    });
  });
  return container;
}
