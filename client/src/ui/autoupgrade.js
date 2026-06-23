import { api } from '../api';
import { showToast, cache, refreshUserData } from '../main';
import { openUpgradeConfigModal } from './bookings';
import { seatNoun } from './cards';

function getAvailableCreditsForEvent(event) {
  if (!cache.profile || !cache.profile.available_credits) return 0;

  // Map event credit_types to numeric IDs
  const acceptedIds = (event.credit_types || []).map(c => {
    const raw = c.credit_type ?? c.id ?? c;
    return Number(typeof raw === 'object' ? raw.id : raw);
  }).filter(id => !isNaN(id));

  if (acceptedIds.length === 0) return Infinity; // no credit types required, assume unlimited

  return cache.profile.available_credits.reduce((total, credit) => {
    const creditTypeId = Number(credit.credit_type?.id ?? credit.credit_type);
    if (acceptedIds.includes(creditTypeId)) {
      return total + (credit.count || 0);
    }
    return total;
  }, 0);
}

export async function renderAutoUpgrades() {
  const container = document.getElementById('psycle-autoupgrade-list-container');
  if (!container) return;

  // Show cached data immediately if available (from prefetch)
  const hasCache = cache.upgrades !== undefined && cache.studioPrefs !== null;
  if (hasCache) {
    renderUpgradeList(cache.upgrades, cache.studioPrefs);
  } else {
    container.innerHTML = `<div class="psycle-spinner" style="margin: 30px auto;"></div>`;
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
      container.innerHTML = `<div class="psycle-card-error">Error: ${err.message}</div>`;
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
        No active auto-upgrade monitors running. You can set them up from the <strong>My Bookings</strong> tab.
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  activeJobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'psycle-autobook-card';

    const startDt = new Date(job.start_at);
    const timeStr = startDt.toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    const prefs = job.preferences || {};

    // Resolve current spot label from layout slots if available
    const layoutSlots = job.layout_slots || [];
    let currentSpotLabel;
    if (job.current_slot_id == null || isNaN(Number(job.current_slot_id))) {
      currentSpotLabel = 'N/A';
    } else {
      const matched = layoutSlots.find(s => Number(s.id) === Number(job.current_slot_id));
      currentSpotLabel = matched?.label || String(job.current_slot_id);
    }

    // Check if insufficient credits (client-side backup check)
    let totalAvailableCredits = 0;
    if (cache.profile?.available_credits) {
      totalAvailableCredits = cache.profile.available_credits.reduce((sum, c) => sum + (c.count || 0), 0);
    }
    const hasInsufficientCredits = totalAvailableCredits < 1; // Auto-upgrade needs at least 1 credit

    let statusText = 'Monitoring Active';
    let statusChipClass = 'state-active';
    if (job.status === 'paused_no_credits' || hasInsufficientCredits) {
      statusText = '⚠ Insufficient Credits';
      statusChipClass = 'state-warning';
    } else if (job.status === 'cutoff_booked') {
      statusText = 'Upgraded (12h window)';
      statusChipClass = 'state-upgrade';
    } else if (job.status === 'stopped') {
      statusText = 'Stopped';
      statusChipClass = 'state-stopped';
    }

    // Format class name without group prefix
    const groupName = job.class_name?.split(':')?.[0]?.trim() || 'Class';
    const classLabel = job.class_name?.includes(':') ? job.class_name.split(':')[1]?.trim() : job.class_name;

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="flex: 1; min-width: 0; font-size: 13px; color: var(--text); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          <span style="font-weight: 600;">${timeStr}</span>
          <span style="color: var(--text-tertiary);">•</span>
          <span class="psycle-class-type-chip">${groupName}</span>
          <span style="color: var(--text-tertiary);">•</span>
          <span style="overflow: hidden; text-overflow: ellipsis;">${classLabel}</span>
          <span style="color: var(--text-tertiary);">•</span>
          <span>${job.instructor_name}</span>
          <span style="color: var(--text-tertiary);">•</span>
          <span style="font-weight: 600; color: var(--success);">${seatNoun(groupName)[0].toUpperCase() + seatNoun(groupName).slice(1)} ${currentSpotLabel}</span>
        </div>
        <div class="psycle-upgrade-status-chip ${statusChipClass}">${statusText}</div>
      </div>
      <div style="display: flex; gap: 6px; margin-top: 10px;">
        <button class="psycle-action-btn-mini variant-autoupgrade edit-upgrade-modal-btn" data-id="${job.id}" style="flex: 1;">Configure</button>
        <button class="psycle-action-btn-mini variant-danger delete-upgrade-btn" data-id="${job.id}" style="flex: 1;">Stop</button>
      </div>
    `;

    // Configure button: open upgrade modal
    card.querySelector('.edit-upgrade-modal-btn').addEventListener('click', async () => {
      await openUpgradeConfigModal({
        eventId: job.event_id,
        bookingId: job.booking_id,
        currentSlotId: job.current_slot_id,
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
        showToast('Stopping upgrade monitor...', 'info');
        await api.deleteAutoUpgrade(job.id);
        showToast('Upgrade monitor stopped.', 'success');
        renderAutoUpgrades();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });

    container.appendChild(card);
  });
}
