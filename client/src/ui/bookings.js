import { api } from '../api';
import { showToast, cache, refreshUserData, updateCreditBadge } from '../main';
import { renderStudioFloorPlan } from './spotmap';
import { setupPullToRefresh } from './pulltorefresh';

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

export async function renderBookings() {
  const bookingsBody = document.getElementById('psycle-bookings-table-body');
  const waitlistsBody = document.getElementById('psycle-waitlists-table-body');

  // Show refreshing indicators
  const bookingsRefreshing = document.getElementById('psycle-bookings-refreshing');
  const waitlistsRefreshing = document.getElementById('psycle-waitlists-refreshing');
  if (bookingsRefreshing) bookingsRefreshing.style.display = '';
  if (waitlistsRefreshing) waitlistsRefreshing.style.display = '';

  // Show cached data immediately if available (cache.upgrades is set after first load)
  const hasLoadedBefore = cache.upgrades !== undefined;
  if (hasLoadedBefore) {
    renderBookingsTable(cache.bookings || [], cache.upgrades || []);
    renderWaitlistsTable(cache.waitlists || []);
  } else {
    // First visit — no cached data yet
    if (bookingsBody) {
      bookingsBody.innerHTML = `
        <tr>
          <td colspan="6" class="psycle-table-empty">
            <div class="psycle-spinner" style="margin: 10px auto;"></div>
            Loading bookings...
          </td>
        </tr>
      `;
    }
    if (waitlistsBody) {
      waitlistsBody.innerHTML = `
        <tr>
          <td colspan="5" class="psycle-table-empty">
            <div class="psycle-spinner" style="margin: 10px auto;"></div>
            Loading waitlists...
          </td>
        </tr>
      `;
    }
  }

  try {
    const [bookingsRes, waitlistsRes, upgradesRes] = await Promise.all([
      api.proxyGet('/bookings?limit=100&page=1'),
      api.proxyGet('/waitlists?page=1'),
      api.getAutoUpgrades()
    ]);

    let bookings = bookingsRes.data || bookingsRes || [];
    let waitlists = waitlistsRes.data || waitlistsRes || [];
    const upgrades = upgradesRes || [];

    // Enrich bookings with event data if API returns flat objects (no nested `event`)
    // CodexFit returns relations separately; we merge them into the event object
    bookings = await Promise.all(bookings.map(async (b) => {
      if (b.event && b.event.start_at) return b;
      try {
        const res = await api.proxyGet(`/events/${b.event_id}`);
        const eventData = res.data || res;
        const relations = res.relations || {};
        // Merge related entities into the event object for template access
        if (relations.instructors?.length) {
          eventData.instructor = relations.instructors.find(i => i.id === eventData.instructor_id) || relations.instructors[0];
        }
        if (relations.event_types?.length) {
          eventData.event_type = relations.event_types.find(t => t.id === eventData.event_type_id) || relations.event_types[0];
        }
        if (relations.studios?.length) {
          eventData.studio = relations.studios.find(s => s.id === eventData.studio_id) || relations.studios[0];
        }
        if (relations.locations?.length && eventData.studio) {
          eventData.studio.location = relations.locations.find(l => l.id === eventData.studio.location_id) || relations.locations[0];
        }
        b.event = eventData;
      } catch (e) {
        console.warn(`[Bookings] Could not fetch event ${b.event_id}:`, e.message);
      }
      return b;
    }));

    // Enrich waitlists with event data if API returns flat objects
    waitlists = await Promise.all(waitlists.map(async (w) => {
      if (w.event && w.event.start_at) return w;
      try {
        const res = await api.proxyGet(`/events/${w.event_id}`);
        const eventData = res.data || res;
        const relations = res.relations || {};
        if (relations.instructors?.length) {
          eventData.instructor = relations.instructors.find(i => i.id === eventData.instructor_id) || relations.instructors[0];
        }
        if (relations.event_types?.length) {
          eventData.event_type = relations.event_types.find(t => t.id === eventData.event_type_id) || relations.event_types[0];
        }
        if (relations.studios?.length) {
          eventData.studio = relations.studios.find(s => s.id === eventData.studio_id) || relations.studios[0];
        }
        if (relations.locations?.length && eventData.studio) {
          eventData.studio.location = relations.locations.find(l => l.id === eventData.studio.location_id) || relations.locations[0];
        }
        w.event = eventData;
      } catch (e) {
        console.warn(`[Bookings] Could not fetch event ${w.event_id}:`, e.message);
      }
      return w;
    }));

    cache.bookings = bookings;
    cache.waitlists = waitlists;
    cache.upgrades = upgrades;

    renderBookingsTable(bookings, upgrades);
    renderWaitlistsTable(waitlists);

    // Hide refreshing indicators
    if (bookingsRefreshing) bookingsRefreshing.style.display = 'none';
    if (waitlistsRefreshing) waitlistsRefreshing.style.display = 'none';

    // Keep the server's reminder cache warm using data we already fetched (no extra CodexFit calls).
    syncBookingCache(bookings);
  } catch (err) {
    console.error('[Bookings] Loading failed:', err);
    if (bookingsBody) bookingsBody.innerHTML = `<tr><td colspan="6" class="psycle-table-error">Error: ${err.message}</td></tr>`;
    if (waitlistsBody) waitlistsBody.innerHTML = `<tr><td colspan="5" class="psycle-table-error">Error: ${err.message}</td></tr>`;
    if (bookingsRefreshing) bookingsRefreshing.style.display = 'none';
    if (waitlistsRefreshing) waitlistsRefreshing.style.display = 'none';
  }

  // Setup pull-to-refresh on the bookings panel (only once)
  const panel = document.getElementById('psycle-panel-my-bookings');
  if (panel && !panel._pullToRefresh) {
    panel._pullToRefresh = setupPullToRefresh(panel, () => renderBookings());
  }
}

// Push the user's upcoming bookings to the server so cancellation reminders can
// fire locally without the server re-polling CodexFit.
function syncBookingCache(bookings) {
  try {
    const now = Date.now();
    const normalized = (bookings || []).map(b => {
      const event = b.event || {};
      const startAt = event.start_at || b.start_at;
      if (!startAt || new Date(startAt).getTime() < now) return null;
      return {
        bookingId: b.id,
        eventId: event.id || b.event_id || null,
        startAt,
        className: event.event_type?.name || event.name || 'Class',
        groupName: event.event_type?.group?.name || '',
        instructorName: event.instructor?.full_name || event.instructor?.name || '',
        studioName: event.studio?.name || '',
        locationName: event.studio?.location?.name || '',
        slotLabel: b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? '',
      };
    }).filter(Boolean);
    api.syncBookings(normalized).catch(() => {});
  } catch (_) { /* best-effort */ }
}

function renderBookingsTable(bookings, upgrades) {
  const tbody = document.getElementById('psycle-bookings-table-body');
  if (!tbody) return;

  if (bookings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="psycle-table-empty">No active bookings found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  bookings.forEach(b => {
    // Defensive: skip if event data is missing
    const event = b.event || null;
    if (!event || !event.start_at) return;

    // Check if an upgrade monitor is active for this booking
    const activeUpgrade = upgrades.find(u => 
      (u.booking_id === b.id || u.event_id === b.event_id) && 
      ['active', 'paused_no_credits'].includes(u.status)
    );

    const startDt = new Date(event.start_at);
    const timeStr = startDt.toLocaleString('en-GB', { 
      weekday: 'short', 
      day: 'numeric', 
      month: 'short', 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    // Check 12-hour penalty cutoff window
    const now = new Date();
    const hoursUntilClass = (startDt - now) / (1000 * 60 * 60);
    const isUnderPenalty = hoursUntilClass > 0 && hoursUntilClass <= 12;

    const row = document.createElement('tr');
    
    // Resolve slot ID from whichever field the API returns it in
    const resolvedSlotId = b.studio_slot?.id ?? b.studio_slot_id ?? b.slot_id ?? b.slot ?? '';

    // Check if insufficient credits (client-side backup check)
    let totalAvailableCredits = 0;
    if (cache.profile?.available_credits) {
      totalAvailableCredits = cache.profile.available_credits.reduce((sum, c) => sum + (c.count || 0), 0);
    }
    const hasInsufficientCredits = totalAvailableCredits < 1;

    let actionButtonsHtml = '';
    if (activeUpgrade) {
      if (activeUpgrade.status === 'paused_no_credits' || hasInsufficientCredits) {
        actionButtonsHtml = `
          <button class="psycle-action-btn-mini variant-warning upgrade-status-btn" data-upgrade-id="${activeUpgrade.id}" data-event-id="${event.id}" data-booking-id="${b.id}" data-slot-id="${resolvedSlotId}" data-studio-id="${event.studio_id || ''}" style="width: auto; min-width: 110px;">⚠ Auto-Upgrade: Insufficient Credits</button>
        `;
      } else {
        actionButtonsHtml = `
          <button class="psycle-action-btn-mini variant-success-muted upgrade-status-btn" data-upgrade-id="${activeUpgrade.id}" data-event-id="${event.id}" data-booking-id="${b.id}" data-slot-id="${resolvedSlotId}" data-studio-id="${event.studio_id || ''}" style="width: auto; min-width: 110px;">Auto-Upgrade On ↗</button>
        `;
      }
    } else {
      actionButtonsHtml = `
        <button class="psycle-action-btn-mini variant-neutral upgrade-status-btn" data-event-id="${event.id}" data-booking-id="${b.id}" data-slot-id="${resolvedSlotId}" data-studio-id="${event.studio_id || ''}">Auto-Upgrade Off</button>
      `;
    }

    const cancelClass = isUnderPenalty ? 'cancel-btn penalty variant-danger-strong' : 'cancel-btn variant-danger';
    const cancelLabel = isUnderPenalty ? 'Cancel (Penalty)' : 'Cancel';

    row.innerHTML = `
      <td><strong>${event.event_type?.name || 'Ride'}</strong></td>
      <td>${event.instructor?.full_name || 'Instructor'}</td>
      <td>${event.studio?.name || 'Studio'} (${event.studio?.location?.name || 'Location'})</td>
      <td>${timeStr}</td>
      <td>Spot ${b.studio_slot?.label || b.slot || b.studio_slot_id || b.slot_id || '?'}</td>
      <td>
        <div style="display: flex; gap: 6px; align-items: center;">
          ${actionButtonsHtml}
          <button class="psycle-action-btn-mini ${cancelClass}" data-id="${b.id}" style="margin-left: 6px;">${cancelLabel}</button>
        </div>
      </td>
    `;

    // Event listener: Auto-upgrade status button (opens modal)
    const statusBtn = row.querySelector('.upgrade-status-btn');
    if (statusBtn) {
      statusBtn.addEventListener('click', () => {
        handleUpgradeClick({
          eventId: parseInt(statusBtn.dataset.eventId),
          bookingId: parseInt(statusBtn.dataset.bookingId),
          currentSlotId: parseInt(statusBtn.dataset.slotId),
          studioId: parseInt(statusBtn.dataset.studioId) || null,
          className: event.event_type?.name || 'Ride',
          groupName: event.event_type?.group?.name || '',
          instructorName: event.instructor?.full_name || 'Instructor',
          studioName: event.studio?.name || 'Studio',
          locationName: event.studio?.location?.name || 'Location',
          startAt: event.start_at,
          existingUpgradeId: activeUpgrade?.id || null,
          existingPrefs: activeUpgrade?.preferences || null
        });
      });
    }

    // Event listener: Cancel Upgrade Monitor
    const cancelUpgradeBtn = row.querySelector('.cancel-upgrade-btn');
    if (cancelUpgradeBtn) {
      cancelUpgradeBtn.addEventListener('click', async () => {
        try {
          showToast('Stopping upgrade monitor...', 'info');
          await api.deleteAutoUpgrade(parseInt(cancelUpgradeBtn.dataset.upgradeId));
          showToast('Upgrade monitor stopped.', 'success');
          renderBookings();
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    }

    // Event listener: Cancel Booking (Double Click Confirm pattern)
    const cancelBtn = row.querySelector('.cancel-btn');
    if (cancelBtn) {
      let confirmState = false;
      cancelBtn.addEventListener('click', async () => {
        if (!confirmState) {
          confirmState = true;
          cancelBtn.textContent = isUnderPenalty ? 'Confirm penalty cancel?' : 'Confirm cancel?';
          cancelBtn.style.background = 'var(--danger)';
          cancelBtn.style.color = 'var(--on-accent)';
          setTimeout(() => {
            confirmState = false;
            cancelBtn.textContent = cancelLabel;
            cancelBtn.style.background = '';
            cancelBtn.style.color = '';
          }, 3000);
        } else {
          try {
            // Show cancelling state on row
            row.style.opacity = '0.6';
            row.querySelectorAll('button').forEach(btn => btn.disabled = true);
            cancelBtn.textContent = 'Cancelling...';

            showToast('Cancelling booking...', 'info');
            await api.proxyDelete(`/bookings/${b.id}`);
            showToast('Booking cancelled successfully.', 'success');
            if (activeUpgrade) {
              try { await api.deleteAutoUpgrade(activeUpgrade.id); } catch (_) {}
            }
            await refreshUserData();
            renderBookings();
          } catch (err) {
            showToast(`Cancellation failed: ${err.message}`, 'error');
            row.style.opacity = '1';
            row.querySelectorAll('button').forEach(btn => btn.disabled = false);
            cancelBtn.textContent = cancelLabel;
            confirmState = false;
          }
        }
      });
    }

    tbody.appendChild(row);
  });
}

function renderWaitlistsTable(waitlists) {
  const tbody = document.getElementById('psycle-waitlists-table-body');
  if (!tbody) return;

  if (waitlists.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="psycle-table-empty">No active waitlists found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  waitlists.forEach(w => {
    // Defensive: skip if event data is missing
    const event = w.event || null;
    if (!event || !event.start_at) return;

    const startDt = new Date(event.start_at);
    const timeStr = startDt.toLocaleString('en-GB', { 
      weekday: 'short', 
      day: 'numeric', 
      month: 'short', 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${event.event_type?.name || 'Ride'}</strong></td>
      <td>${event.instructor?.full_name || 'Instructor'}</td>
      <td>${event.studio?.name || 'Studio'} (${event.studio?.location?.name || 'Location'})</td>
      <td>${timeStr}</td>
      <td>
        <button class="psycle-action-btn-mini cancel-wl-btn" data-event-id="${event.id}">Leave Waitlist</button>
      </td>
    `;

    // Leave waitlist button double click confirm
    const leaveBtn = row.querySelector('.cancel-wl-btn');
    if (leaveBtn) {
      let confirmState = false;
      leaveBtn.addEventListener('click', async () => {
        if (!confirmState) {
          confirmState = true;
          leaveBtn.textContent = 'Confirm Leave?';
          leaveBtn.style.background = 'var(--danger)';
          leaveBtn.style.color = 'var(--on-accent)';
          setTimeout(() => {
            confirmState = false;
            leaveBtn.textContent = 'Leave Waitlist';
            leaveBtn.style.background = '';
            leaveBtn.style.color = '';
          }, 3000);
        } else {
          try {
            // Show leaving state on row
            row.style.opacity = '0.6';
            row.querySelectorAll('button').forEach(btn => btn.disabled = true);
            leaveBtn.textContent = 'Leaving...';

            showToast('Leaving waitlist...', 'info');
            await api.proxyDelete(`/waitlists/${event.id}`);
            showToast('Successfully left waitlist.', 'success');
            await refreshUserData();
            renderBookings();
          } catch (err) {
            showToast(`Error: ${err.message}`, 'error');
            row.style.opacity = '1';
            row.querySelectorAll('button').forEach(btn => btn.disabled = false);
            leaveBtn.textContent = 'Leave Waitlist';
            confirmState = false;
          }
        }
      });
    }

    tbody.appendChild(row);
  });
}

// Auto-upgrade needs at least one spare credit to book the upgraded seat before
// releasing the old one. Returns 1 if the user has none spare, else 0.
function upgradeCreditShortfall() {
  let total = 0;
  if (cache.profile?.available_credits) {
    total = cache.profile.available_credits.reduce((sum, c) => sum + (c.count || 0), 0);
  }
  return total < 1 ? 1 : 0;
}

// Quick-register or open modal, like the auto-book flow
async function handleUpgradeClick({ eventId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs }) {
  if (!eventId || !bookingId || currentSlotId === '' || currentSlotId == null || isNaN(Number(currentSlotId))) {
    showToast('Could not determine your current spot. Open the booking details to find your slot.', 'error');
    return;
  }

  // If editing an existing monitor, always open the config modal
  if (existingUpgradeId !== null) {
    openUpgradeConfigModal({ eventId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs });
    return;
  }

  // Check if studio preferences are already configured
  try {
    const allPrefs = await api.getStudioPreferences();
    const studioPrefs = studioId ? allPrefs[studioId] : null;
    const hasPrefs = studioPrefs?.preferredSlots?.length > 0;

    if (hasPrefs) {
      // Quick-register: the monitor reads the live shared studio map, so we only
      // store the per-monitor option here.
      showToast('Starting upgrade monitor...', 'info');
      await api.addAutoUpgrade({
        eventId,
        studioId: studioId || null,
        bookingId,
        currentSlotId,
        className,
        groupName,
        instructorName,
        studioName,
        locationName,
        startAt,
        creditShortfall: upgradeCreditShortfall(),
        preferences: {
          keepOriginalOnCutoff: true
        }
      });
      showToast('Auto-upgrade monitor started using your saved spot map for this studio.', 'success');
      renderBookings();
    } else {
      // No prefs — open modal to configure
      openUpgradeConfigModal({ eventId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId: null, existingPrefs: null });
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Auto-Upgrade configuration modal (floor plan + options)
export async function openUpgradeConfigModal({ eventId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs }) {
  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title) return;

  title.textContent = 'Configure Auto-Upgrade';
  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span>Fetching studio floor map...</span>
    </div>
  `;

  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('show'), 10);

  const closeBtn = document.getElementById('psycle-booking-modal-close');
  const overlay = modal.querySelector('.psycle-modal-overlay');
  
  const closeModal = () => {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
  };
  
  closeBtn.onclick = closeModal;
  overlay.onclick = closeModal;

  const isEditing = existingUpgradeId !== null;
  title.textContent = isEditing ? `Edit Auto-Upgrade` : `Auto-Upgrade: ${className}`;

  try {
    // Fetch event + studio layout, and the live shared studio map in parallel
    const [res, allPrefs] = await Promise.all([
      api.proxyGet(`/events/${eventId}`),
      api.getStudioPreferences()
    ]);

    const eventDetails = res.data || res;
    const studio = res.relations?.studios?.[0] || eventDetails.relations?.studios?.[0] || eventDetails.studio || {};
    const layoutSlots = studio?.layout?.slots || [];
    const resolvedStudioId = studioId || studio.id;
    const studioPrefs = resolvedStudioId ? allPrefs[resolvedStudioId] : null;

    if (layoutSlots.length === 0) {
      body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-secondary);">No floor map available for this studio. Auto-upgrade requires a spot map.</div>`;
      return;
    }

    // Auto-upgrade reads the LIVE shared studio map, so the editor edits that map
    // directly. Seed from the shared map (or the existing monitor as a fallback).
    const seedSlots = (studioPrefs?.preferredSlots || existingPrefs?.preferredSlots || []).map(Number);
    const seedRows = studioPrefs?.preferredRows || [];
    const seedKeepOriginal = existingPrefs?.keepOriginalOnCutoff ?? true;

    const currentSlotLabel = layoutSlots.find(s => Number(s.id) === currentSlotId)?.label || String(currentSlotId);

    // Credit checking for auto-upgrade (needs +1 credit for the upgrade spot)
    const availableCredits = getAvailableCreditsForEvent(eventDetails);
    const upgradeCreditsNeeded = 1; // Auto-upgrade needs 1 credit for the additional spot
    const hasEnoughCredits = availableCredits >= upgradeCreditsNeeded;
    const creditWarningHtml = !hasEnoughCredits
      ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;line-height:1.5;">In order for Auto-Upgrade to work, you need to purchase ${upgradeCreditsNeeded - availableCredits} more credit${upgradeCreditsNeeded - availableCredits !== 1 ? 's' : ''}. Auto-Upgrade books an additional spot before cancelling your current one.</div>`
      : '';

    body.innerHTML = `<div id="psycle-upgrade-editor"></div>`;
    const editorContainer = body.querySelector('#psycle-upgrade-editor');

    const bannerHtml = `
      <div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        This is the one shared preferred spot map for <strong>${studioName}</strong>. Auto-Upgrade aims for these spots in priority order — and Quick-Book &amp; Auto-Book here use the same map. Your current seat is <strong>${currentSlotLabel}</strong>.
      </div>${creditWarningHtml}`;

    const extraControlsHtml = `
      <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;cursor:pointer;line-height:1.4;background:var(--surface-inset);border:1px solid var(--border);border-radius:10px;padding:12px;">
        <input type="checkbox" id="upgrade-keep-original" ${seedKeepOriginal ? 'checked' : ''} style="margin-top:2px;accent-color:var(--feat-autoupgrade);">
        <span>
          <strong>Continue past 12h cutoff</strong><br>
          <span style="font-size:12px;color:var(--text-tertiary);">Within 12h of class, make one final upgrade attempt without cancelling your original seat — you'll need to ask Psycle to release it. Without this, monitoring stops at 12h.</span>
        </span>
      </label>`;

    const onDisable = isEditing ? async () => {
      try {
        showToast('Disabling auto-upgrade...', 'info');
        await api.deleteAutoUpgrade(existingUpgradeId);
        showToast('Auto-upgrade disabled.', 'success');
        closeModal();
        renderBookings();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    } : null;

    renderStudioFloorPlan(editorContainer, layoutSlots, seedSlots, seedRows, async (slots, rows, container) => {
      if (slots.length === 0 && rows.length === 0) {
        showToast('Select at least one preferred spot for the upgrade to aim at.', 'warning');
        return;
      }

      const keepOriginalOnCutoff = container.querySelector('#upgrade-keep-original')?.checked ?? true;

      try {
        // 1. Save the shared studio map (this is what every feature reads live)
        if (resolvedStudioId) {
          await api.updateStudioPreferences(resolvedStudioId, { preferredSlots: slots, preferredRows: rows });
        }

        // 2. Create or update the monitor (per-monitor option only; slots are live)
        if (isEditing) {
          await api.updateAutoUpgrade(existingUpgradeId, { keepOriginalOnCutoff });
          showToast('Auto-upgrade updated — shared spot map saved.', 'success');
        } else {
          await api.addAutoUpgrade({
            eventId, studioId: resolvedStudioId || null, bookingId, currentSlotId,
            className, groupName, instructorName, studioName, locationName, startAt,
            creditShortfall: upgradeCreditShortfall(),
            preferences: { keepOriginalOnCutoff }
          });
          showToast('Auto-upgrade monitor started! Monitoring for a better spot.', 'success');
        }

        closeModal();
        renderBookings();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    }, {
      saveLabel: isEditing ? 'Save Changes' : 'Start Monitoring',
      bannerHtml,
      extraControlsHtml,
      onDisable,
      disableLabel: 'Disable Auto-Upgrade'
    });

  } catch (err) {
    console.error('[Bookings] Modal load layout failed:', err);
    body.innerHTML = `<div class="psycle-card-error">Error loading seat layout: ${err.message}</div>`;
  }
}
