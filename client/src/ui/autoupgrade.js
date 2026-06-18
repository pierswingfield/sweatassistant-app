import { api } from '../api';
import { showToast, cache, refreshUserData } from '../main';
import { openUpgradeConfigModal } from './bookings';

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

  container.innerHTML = `<div class="psycle-spinner" style="margin: 30px auto;"></div>`;

  try {
    // Refresh credits when viewing auto-upgrades
    await refreshUserData();

    const [res, studioPrefs] = await Promise.all([
      api.getAutoUpgrades(),
      api.getStudioPreferences().catch(() => ({}))
    ]);
    cache.upgrades = res || [];

    renderUpgradeList(res, studioPrefs || {});
  } catch (err) {
    console.error('[AutoUpgrade] Failed to load:', err);
    container.innerHTML = `<div class="psycle-card-error">Error: ${err.message}</div>`;
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
    card.className = 'psycle-autobook-card'; // re-use glassmorphic card styling
    card.style.background = 'rgba(255,255,255,0.03)';
    card.style.border = '1px solid rgba(255,255,255,0.08)';
    card.style.borderRadius = '16px';
    card.style.padding = '16px';
    card.style.marginBottom = '12px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '10px';

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
    let statusColor = '#34d399';
    let statusBgColor = '#34d39915';
    if (job.status === 'paused_no_credits' || hasInsufficientCredits) {
      statusText = '⚠ Insufficient Credits';
      statusColor = '#f59e0b';
      statusBgColor = '#f59e0b15';
    } else if (job.status === 'cutoff_booked') {
      statusText = 'Upgraded (12h window)';
      statusColor = '#a78bfa';
      statusBgColor = '#a78bfa15';
    } else if (job.status === 'stopped') {
      statusText = 'Stopped';
      statusColor = '#64748b';
      statusBgColor = '#64748b15';
    }

    // Format class name without group prefix
    const groupName = job.class_name?.split(':')?.[0]?.trim() || 'Class';
    const classLabel = job.class_name?.includes(':') ? job.class_name.split(':')[1]?.trim() : job.class_name;

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="flex: 1; min-width: 0; font-size: 13px; color: #e2e8f0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          <span style="font-weight: 600;">${timeStr}</span>
          <span style="color: #94a3b8;">•</span>
          <span style="text-transform: uppercase; font-size: 11px; font-weight: 600; color: #a78bfa;">${groupName}</span>
          <span style="color: #94a3b8;">•</span>
          <span style="overflow: hidden; text-overflow: ellipsis;">${classLabel}</span>
          <span style="color: #94a3b8;">•</span>
          <span>${job.instructor_name}</span>
          <span style="color: #94a3b8;">•</span>
          <span style="font-weight: 600; color: #10b981;">Spot ${currentSpotLabel}</span>
        </div>
        <div style="font-size: 11px; font-weight: 700; color: ${statusColor}; white-space: nowrap; padding: 3px 8px; border-radius: 6px; border: 1px solid ${statusColor}30; background: ${statusBgColor}; flex-shrink: 0;">${statusText}</div>
      </div>
      <div style="display: flex; gap: 6px; margin-top: 10px;">
        <button class="psycle-action-btn-mini edit-upgrade-modal-btn" data-id="${job.id}" style="flex: 1; background: rgba(167, 139, 250, 0.15); border: 1px solid rgba(167, 139, 250, 0.3); color: #c4b5fd;">Configure</button>
        <button class="psycle-action-btn-mini delete-upgrade-btn" data-id="${job.id}" style="flex: 1; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #f87171;">Stop</button>
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
