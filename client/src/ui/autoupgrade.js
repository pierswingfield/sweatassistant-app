import { api } from '../api';
import { noSept, zoneFor, formatInZone } from '../lib';
import { getDefaultGymId } from '../gym-context.js';
import { getAvailableCreditsForEvent, getTotalCredits, getIneligibleReason } from './credit-allowance.js';
import { showToast, cache, refreshUserData } from '../main';
import { openUpgradeConfigModal } from './bookings';
import { seatNoun, disciplineTag, renderGymRail, icon, cleanClassName, wireRailToggle, escapeHtml } from './cards';
import { renderCardSkeletons } from './loading-skeleton.js';
import { instructorAvatar } from './tooltips.js';
import { COPY, formatCopyText } from '../copy.js';


export async function renderAutoUpgrades() {
  const container = document.getElementById('psycle-autoupgrade-list-container');
  if (!container) return;

  // Show cached data immediately if available (from prefetch)
  const hasCache = cache.upgrades !== undefined && cache.studioPrefs !== null;
  if (hasCache) {
    renderUpgradeList(cache.upgrades, cache.studioPrefs);
  } else {
    container.innerHTML = renderCardSkeletons(2, COPY.autoUpgrade.loading);
  }

  // Fetch fresh data in the background
  try {
    refreshUserData(); // Fire-and-forget — don't block render

    const [res, studioPrefs] = await Promise.all([
      api.getAutoUpgrades(),
      api.getStudioPreferences().catch(() => ({}))
    ]);
    cache.upgrades = res || [];
    cache.studioPrefs = studioPrefs || {};

    renderUpgradeList(res, studioPrefs || {});
  } catch (err) {
    console.error('[AutoUpgrade] Failed to load:', err);
    if (!hasCache) {
      container.innerHTML = `<div class="psycle-card-error">${escapeHtml(formatCopyText(COPY.autoUpgrade.loadFailed, { error: err.message }))}</div>`;
    }
  }
}

function renderUpgradeList(upgrades, studioPrefs = {}) {
  const container = document.getElementById('psycle-autoupgrade-list-container');
  if (!container) return;

  // Filter only active/paused/cutoff upgrade records
  const activeJobs = upgrades.filter(u => ['active', 'paused_no_credits', 'cutoff_booked'].includes(u.status));

  if (activeJobs.length === 0) {
    container.innerHTML = `
      <div class="fav-empty-state" style="padding: 30px 0;">
        ${COPY.autoUpgrade.noMonitors}
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  activeJobs.forEach(job => {
    const card = document.createElement('div');
    // `ab-card` is required, not decorative: every per-gym tint rule is
    // `.psycle-autobook-card.ab-card[data-gym=...]`, so without it these cards
    // carried a data-gym that nothing ever painted.
    card.className = 'psycle-autobook-card ab-card';
    card.setAttribute('data-gym', job.gym_id || getDefaultGymId());

    // Split date and time so the card can use the same `.ab-card-date` /
    // `.ab-card-time` pairing as Bookings, Waitlists and Auto-Book.
    const fmt = formatInZone(job.start_at, zoneFor(job));
    const dateStr = noSept(fmt.date);
    const timeOnly = fmt.timeLabel;

    const prefs = job.preferences || {};

    // The monitor stores a provider slot id, which is NOT what the member sees on
    // the map. Show the label from their booking; never print the raw id.
    let currentSpotLabel;
    if (job.current_slot_id == null || isNaN(Number(job.current_slot_id))) {
      currentSpotLabel = COPY.credits.notAvailable;
    } else {
      const booking = (cache.bookings || []).find(b => String(b.id ?? b.bookingId) === String(job.booking_id));
      const matched = (job.layout_slots || []).find(s => Number(s.id) === Number(job.current_slot_id));
      currentSpotLabel = booking?.slotLabel || matched?.label || COPY.credits.notAvailable;
    }

    // Client-side backup check. Shared module → Infinity on a membership gym,
    // so an unmetered gym never shows a credit warning from THIS check alone —
    // it still needs its own membership gate (WP-J), below.
    const ineligibleReason = getIneligibleReason(job.gym_id);
    const hasInsufficientCredits = getTotalCredits(job.gym_id) < 1; // needs at least 1 credit

    let statusText = COPY.autoUpgrade.monitoring;
    let statusChipClass = 'state-active';
    if (job.status === 'paused_disabled') {
      statusText = COPY.autoUpgrade.pausedDisabled;
      statusChipClass = 'state-warning';
    } else if (job.status === 'paused_no_credits' || hasInsufficientCredits || ineligibleReason) {
      statusText = ineligibleReason ? `⚠ ${ineligibleReason}` : COPY.autoUpgrade.insufficientCredits;
      statusChipClass = 'state-warning';
    } else if (job.status === 'cutoff_booked') {
      statusText = COPY.autoUpgrade.upgraded;
      statusChipClass = 'state-upgrade';
    } else if (job.status === 'stopped') {
      statusText = COPY.autoUpgrade.stopped;
      statusChipClass = 'state-stopped';
    }

    // Format class name without group prefix
    const groupName = job.class_name?.split(':')?.[0]?.trim() || COPY.autoBook.class;
    const classLabel = cleanClassName(job.class_name || '', job.group_name || groupName) || job.class_name;

    const seat = seatNoun(groupName);
    const seatCap = seat.charAt(0).toUpperCase() + seat.slice(1);

    card.innerHTML = `
      ${renderGymRail(job.gym_id || getDefaultGymId())}
      <div class="ab-card-main">
        <div class="ab-card-toprow">
          <div class="ab-card-when">
            <span class="ab-card-date">${dateStr.toUpperCase()}</span>
            <span class="ab-card-time">${timeOnly}</span>
          </div>
          <div class="psycle-upgrade-status-chip ${statusChipClass}">${escapeHtml(statusText)}</div>
        </div>
        <div class="ab-card-meta">
          ${disciplineTag(groupName)}
          <span class="ab-card-class">${classLabel}</span>
          <span class="ab-meta-dot">·</span>
          <span class="ab-card-instructor">${instructorAvatar(job.instructor_name, job.gym_id)}${job.instructor_name}</span>
        </div>
        <div class="ab-card-footer">
          <span class="ab-spots-pill">${seatCap} ${currentSpotLabel}</span>
        </div>
      </div>
      <div class="ab-card-rail">
        <button class="ab-rail-btn edit-upgrade-modal-btn" data-id="${job.id}" aria-label="${COPY.accessibility.configureAutoUpgrade}">${icon('edit', 17)}<span>${COPY.autoUpgrade.configure}</span></button>
        <button class="ab-rail-btn danger delete-upgrade-btn" data-id="${job.id}" aria-label="${COPY.accessibility.stopAutoUpgrade}">${icon('close', 17)}<span>${COPY.autoUpgrade.stop}</span></button>
      </div>
    `;

    // Configure button: open upgrade modal
    card.querySelector('.edit-upgrade-modal-btn').addEventListener('click', async () => {
      await openUpgradeConfigModal({
        eventId: job.event_id,
        gymId: job.gym_id || null,
        bookingId: job.booking_id,
        currentSlotId: job.current_slot_id,
        currentSlotLabel: currentSpotLabel,
        studioId: job.studio_id,
        className: job.class_name,
        groupName: job.group_name,
        instructorName: job.instructor_name,
        studioName: job.studio_name,
        locationName: job.location_name,
        startAt: job.start_at,
        existingUpgradeId: job.id,
        existingPrefs: job.preferences
      });
    });

    // Stop button event listener
    card.querySelector('.delete-upgrade-btn').addEventListener('click', async () => {
      try {
        showToast(COPY.autoUpgrade.stopping, 'info');
        await api.deleteAutoUpgrade(job.id);
        showToast(COPY.autoUpgrade.stoppedToast, 'success');
        renderAutoUpgrades();
      } catch (err) {
        showToast(formatCopyText(COPY.autoUpgrade.actionFailed, { error: err.message }), 'error');
      }
    });

    container.appendChild(card);
  });
  wireRailToggle(container);
}
