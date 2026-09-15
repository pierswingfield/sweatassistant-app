import { api } from '../api';
import { getGymContext, getGymShortName } from '../gym-context.js';
import { getAvailableCreditsForEvent, getTotalCredits, getIneligibleReason } from './credit-allowance.js';
import { showToast, cache, userSettings, refreshUserData, debugConsole } from '../main';
import { getClassReleaseTime } from '../lib';
import { DateTime } from 'luxon';
import { renderStudioFloorPlan } from './spotmap';
import { icon, disciplineTag, trimLocation, seatNoun, pulseIcon, renderGymRail, equalizeDiscTagWidths } from './cards';
import { renderCardSkeletons } from './loading-skeleton.js';
import { instructorAvatar } from './tooltips.js';

let countdownInterval = null;
let sseEventSource = null;
const statusCache = new Map(); // eventId → current status


// Prefetch all data needed for the Auto-Book tab so it loads instantly on navigation.
// Called fire-and-forget from initApp() right after login.
export async function prefetchAutoBookData() {
  try {
    const [autoBookings, upgrades, studioPrefs] = await Promise.all([
      api.getAutoBookings(),
      api.getAutoUpgrades(),
      api.getStudioPreferences().catch(() => ({}))
    ]);
    cache.autoBookings = autoBookings;
    cache.upgrades = upgrades || [];
    cache.studioPrefs = studioPrefs || {};
  } catch (err) {
    console.warn('[AutoBook] Prefetch failed:', err.message);
  }
}

export async function initAutoBook() {
  refreshUserData(); // Fire-and-forget — don't block tab render (already prefetched in initApp)
  await renderAutoBookTab();
  renderAutoBookControls();
  connectToAutoBookStream();

  // Setup countdown interval
  if (countdownInterval) clearInterval(countdownInterval);
  updateCountdowns();
  countdownInterval = setInterval(updateCountdowns, 1000);
}

// Pull-to-refresh action for the Auto-Book tab — dispatched by the shared
// pull-to-refresh handler in main.js (attached to <main class="psycle-body">).
export async function refreshAutoBookTab() {
  await Promise.all([renderAutoBookTab(), refreshUserData()]);
}

function connectToAutoBookStream() {
  // Disconnect old stream if exists
  if (sseEventSource) {
    sseEventSource.close();
  }

  // Connect to SSE stream for real-time auto-book status updates
  // EventSource doesn't support custom headers, so pass token in URL query param
  const token = localStorage.getItem('psycleLocalToken');
  const url = token ? `/api/auto-book/stream?token=${encodeURIComponent(token)}` : '/api/auto-book/stream';
  sseEventSource = new EventSource(url);

  sseEventSource.onopen = () => {
    debugConsole('[AutoBook] SSE stream connected');
    // Sync any missed state by fetching the latest auto-book data.
    // This fires on initial connection AND on reconnect after a network interruption.
    api.getAutoBookings().then(data => {
      if (Array.isArray(data)) {
        cache.autoBookings = data;
        const active = data.filter(x => !x.executed_at);
        const history = data.filter(x => x.executed_at);
        renderQueue(active);
        renderHistory(history);
      }
    }).catch(() => { /* offline — silently ignore, native reconnect will retry */ });
  };

  sseEventSource.onmessage = (event) => {
    try {
      const update = JSON.parse(event.data);
      if (!update.eventId) return;

      // Cache the status for this event
      statusCache.set(update.eventId, update);

      // Update the queue display
      updateQueueDisplayForEvent(update.eventId, update);
    } catch (err) {
      console.error('[AutoBook] Failed to parse SSE message:', err);
    }
  };

  sseEventSource.onerror = (err) => {
    console.warn('[AutoBook] SSE stream error — browser will auto-reconnect:', err);
    // Do NOT close — EventSource reconnects automatically with native exponential backoff.
    // Closing and manually reconnecting loses the retry timer and adds downtime.
  };
}

function updateQueueDisplayForEvent(eventId, update) {
  const queueContainer = document.getElementById('psycle-autobook-queue-container');
  if (!queueContainer) return;

  // Find the card for this event
  const card = queueContainer.querySelector(`[data-event-id="${eventId}"]`);
  if (!card) return;

  // Update or create a status line
  let statusEl = card.querySelector('.autobook-status-line');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'autobook-status-line';
    (card.querySelector('.ab-card-main') || card).appendChild(statusEl);
  }

  // Update status text and color based on status type
  let statusColor = 'var(--text-secondary)';
  let statusIcon = '⏳';

  if (update.status === 'prefetching') {
    statusIcon = '📊';
    statusColor = 'var(--text-tertiary)';
  } else if (update.status === 'planning') {
    statusIcon = '📋';
    statusColor = 'var(--feat-autoupgrade)';
    if (update.plannedSlots) {
      statusEl.innerHTML = `${statusIcon} Planning: attempting slots <strong>[${update.plannedSlots.join(', ')}]</strong>`;
    }
  } else if (update.status === 'attempting') {
    statusIcon = '🎯';
    statusColor = 'var(--warning)';
    statusEl.innerHTML = `${statusIcon} Attempting slot <strong>${update.attemptingSlot}</strong> (${update.isPreferred ? 'preferred' : 'fallback'})...`;
  } else if (update.status === 'success') {
    statusIcon = '✅';
    statusColor = 'var(--success)';
    statusEl.innerHTML = `${statusIcon} Success! Booked slots <strong>[${update.bookedSlots.join(', ')}]</strong>`;
  } else if (update.status === 'waitlist-fallback') {
    statusIcon = '📋';
    statusColor = 'var(--warning)';
  } else if (update.status === 'waitlist-success') {
    statusIcon = '✅';
    statusColor = 'var(--warning)';
    statusEl.innerHTML = `${statusIcon} Joined waitlist`;
  } else if (update.status === 'failed') {
    statusIcon = '❌';
    statusColor = 'var(--danger)';
    statusEl.innerHTML = `${statusIcon} <span style="color:var(--danger);"><strong>Failed:</strong> ${update.message}</span>`;
  }

  statusEl.style.color = statusColor;
  statusEl.textContent = update.message || statusEl.textContent;
}

function renderAutoBookControls() {
  // Populate the segmented footer baked into the countdown banner
  const bar = document.getElementById('psycle-autobook-controls-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const isPaused = !!userSettings.autoBookPaused;

  // Pause / Resume button
  const pauseBtn = document.createElement('button');
  pauseBtn.className = `ab-footer-btn ${isPaused ? 'state-paused' : ''}`;
  pauseBtn.innerHTML = isPaused
    ? `${icon('play', 14)}<span>Resume Auto-Book</span>`
    : `${icon('pause', 14)}<span>Pause Auto-Book</span>`;
  pauseBtn.addEventListener('click', async () => {
    pauseBtn.disabled = true;
    try {
      const newPaused = !userSettings.autoBookPaused;
      await api.updateSettings({ ...userSettings, autoBookPaused: newPaused });
      userSettings.autoBookPaused = newPaused;
      showToast(newPaused ? 'Auto-book paused' : 'Auto-book resumed', newPaused ? 'info' : 'success');
      renderAutoBookControls();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      pauseBtn.disabled = false;
    }
  });

  bar.appendChild(pauseBtn);

  // Simulate button (debug mode only)
  if (userSettings.debugMode) {
    const simBtn = document.createElement('button');
    simBtn.className = 'ab-footer-btn';
    simBtn.innerHTML = `${icon('bolt', 14)}<span>Simulate Release</span>`;
    simBtn.addEventListener('click', async () => {
      simBtn.disabled = true;
      simBtn.innerHTML = `${icon('bolt', 14)}<span>Firing…</span>`;
      try {
        await api.simulateRelease();
        showToast('Simulated release fired — all pending bookings executing now. Check history shortly.', 'success');
        // Refresh queue/history after a short delay to let bookings complete
        setTimeout(() => renderAutoBookTab(), 4000);
      } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
      } finally {
        simBtn.disabled = false;
        simBtn.innerHTML = `${icon('bolt', 14)}<span>Simulate Release</span>`;
      }
    });
    bar.appendChild(simBtn);
  }
}

function parseBookmark(bm) {
  // Format: {studioId}0000{dayOfWeek}0000{HHMM}
  const match = String(bm).match(/^(.+?)0000(\d)0000(\d{4})$/);
  if (!match) return { raw: bm, studioId: null, dayOfWeek: null, time: null };
  const [, studioId, dayStr, timeStr] = match;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = days[parseInt(dayStr)] || dayStr;
  const hours = timeStr.slice(0, 2);
  const mins = timeStr.slice(2);
  return { raw: bm, studioId, dayOfWeek: day, time: `${hours}:${mins}` };
}

function openFavouritesModal() {
  // Get bookmarks from cache or loaded profile
  const bookmarks = cache.profile?.metafields?.public?.bookmarks?.events || [];

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:color-mix(in srgb, var(--bg) 60%, transparent);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--surface);border:1px solid var(--border-strong);border-radius:16px;width:100%;max-width:480px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border);flex-shrink:0;';
  header.innerHTML = `<h3 style="margin:0;font-size:15px;font-weight:700;color:var(--text);">♥ Auto-Book Favourites</h3><button style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:0;" id="favs-modal-close">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';

  if (bookmarks.length === 0) {
    body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary);font-size:13px;">No bookmarked classes found.<br>Bookmark classes from the timetable to set up recurring auto-book.</div>';
  } else {
    const parsed = bookmarks.map(parseBookmark);
    const enabled = new Set(userSettings.autoBookFavourites || []);

    body.innerHTML = '<p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px;">Select which favourites to auto-book each week:</p>';

    parsed.forEach(bm => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = enabled.has(bm.raw);
      cb.style.cssText = 'width:16px;height:16px;accent-color:var(--feat-autoupgrade);cursor:pointer;flex-shrink:0;';
      cb.addEventListener('change', () => {
        if (cb.checked) enabled.add(bm.raw);
        else enabled.delete(bm.raw);
      });

      const label = document.createElement('div');
      label.style.cssText = 'flex:1;font-size:12px;color:var(--text);';
      label.innerHTML = bm.studioId
        ? `<strong>Studio ${bm.studioId}</strong> · ${bm.dayOfWeek} ${bm.time}`
        : `<span style="color:var(--text-secondary);">${bm.raw}</span>`;

      row.appendChild(cb);
      row.appendChild(label);
      body.appendChild(row);
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'psycle-btn';
    saveBtn.style.cssText = 'width:100%;margin-top:12px;background:var(--feat-autoupgrade);color:#fff;';
    saveBtn.textContent = 'Save Favourites';
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const list = Array.from(enabled);
        await api.updateSettings({ ...userSettings, autoBookFavourites: list });
        userSettings.autoBookFavourites = list;
        showToast('Favourites saved!', 'success');
        overlay.remove();
      } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Favourites';
      }
    });
    body.appendChild(saveBtn);
  }

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  header.querySelector('#favs-modal-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function renderAutoBookTab() {
  const queueContainer = document.getElementById('psycle-autobook-queue-container');
  const historyList = document.getElementById('psycle-autobook-history-list');

  // Show cached data immediately if available (from prefetch)
  if (cache.autoBookings) {
    const cached = cache.autoBookings;
    const active = cached.filter(x => !x.executed_at);
    const history = cached.filter(x => x.executed_at);
    renderQueue(active);
    renderHistory(history);
  } else {
    // First visit — no cached data yet
    if (queueContainer) {
      queueContainer.innerHTML = renderCardSkeletons(3, 'Loading auto-book queue');
    }
    if (historyList) {
      historyList.innerHTML = renderCardSkeletons(2, 'Loading auto-book history');
    }
  }

  // Fetch fresh data in the background
  try {
    const res = await api.getAutoBookings();
    cache.autoBookings = res;

    // Separate active vs executed (history)
    const active = res.filter(x => !x.executed_at);
    const history = res.filter(x => x.executed_at);

    renderQueue(active);
    renderHistory(history);
  } catch (err) {
    console.error('[AutoBook] Failed to load:', err);
    if (queueContainer && !cache.autoBookings) {
      queueContainer.innerHTML = '<div class="psycle-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">No cached data available</p><p style="font-size:13px;color:var(--text-tertiary)">Connect to the internet to load your auto-book queue.</p></div>';
    }
  }

}


function renderQueue(queue) {
  const container = document.getElementById('psycle-autobook-queue-container');
  if (!container) return;

  if (queue.length === 0) {
    container.innerHTML = `
      <div class="fav-empty-state" style="padding: 30px 0;">
        No classes scheduled in the release queue. Visit the Timetable tab to add classes.
      </div>
    `;
    return;
  }

  // Sort chronologically by class start time
  const sorted = [...queue].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  container.innerHTML = '';
  sorted.forEach(q => {
    const card = document.createElement('div');
    card.className = 'psycle-autobook-card ab-card';
    card.setAttribute('data-event-id', q.event_id);
    card.setAttribute('data-gym', q.gym_id || 'psycle-london');

    const startDt = new Date(q.start_at);
    const dateStr = startDt.toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Europe/London'
    });
    const timeOnly = startDt.toLocaleString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    const prefs = q.preferences || {};
    const creditsNeeded = prefs.requiredCount || 1;
    const className = q.class_name || q.group_name || 'Class';
    const locationLine = [q.studio_name, trimLocation(q.location_name, getGymShortName(q.gym_id))].filter(Boolean).join(', ');

    // Via the shared module so the unmetered case is handled once: it returns
    // Infinity for a membership gym, where "insufficient credits" is meaningless.
    // A membership gym still needs its OWN gate though — getIneligibleReason()
    // (WP-J) — since Infinity credits says nothing about membership status.
    const ineligibleReason = getIneligibleReason();
    const hasInsufficientCredits = getTotalCredits() < creditsNeeded;

    const creditWarning = ineligibleReason
      ? `<div class="ab-credit-warning">${icon('warning', 13)}<span>${ineligibleReason}</span></div>`
      : hasInsufficientCredits
        ? `<div class="ab-credit-warning">${icon('warning', 13)}<span>Insufficient Credits</span></div>`
        : '';

    card.innerHTML = `
      ${renderGymRail(q.gym_id || 'psycle-london')}
      <div class="ab-card-main">
        <div class="ab-card-toprow">
          <div class="ab-card-when">
            <span class="ab-card-date">${dateStr.toUpperCase()}</span>
            <span class="ab-card-time">${timeOnly}</span>
          </div>
        </div>
        <div class="ab-card-meta">
          ${disciplineTag(q.group_name || q.class_name)}
          <span class="ab-card-class">${className}</span>
          <span class="ab-meta-dot">·</span>
          <span class="ab-card-instructor">${instructorAvatar(q.instructor_name, q.gym_id)}${q.instructor_name || 'TBA'}</span>
          ${locationLine ? `<span class="ab-card-location">${locationLine}</span>` : ''}
        </div>
        <div class="ab-card-footer">
          <span class="ab-countdown state-pending" data-start-at="${q.start_at}" data-release-at="${getClassReleaseTime(q, userSettings).toISO()}">
            ${icon('clock', 13)}<span class="ab-countdown-val">…</span>
          </span>
          <span class="ab-spots-pill">${creditsNeeded} ${seatNoun(q.group_name)[0].toUpperCase() + seatNoun(q.group_name).slice(1)}${creditsNeeded !== 1 ? 's' : ''}</span>
        </div>
        ${creditWarning}
      </div>
      <div class="ab-card-rail">
        <button class="ab-rail-btn edit-autobook-btn" data-id="${q.id}" aria-label="Edit">${icon('edit', 17)}<span>Edit</span></button>
        <button class="ab-rail-btn danger delete-autobook-btn" data-id="${q.id}" aria-label="Cancel">${icon('close', 17)}<span>Cancel</span></button>
      </div>
    `;

    // Delete click listener (two-tap confirm — mirrors booking cancellation)
    wireCancelAutoBook(card.querySelector('.delete-autobook-btn'), card, q);

    // Edit click listener
    card.querySelector('.edit-autobook-btn').addEventListener('click', () => {
      openAutoBookEditModal(q);
    });

    container.appendChild(card);
  });

  equalizeDiscTagWidths(container);
}

// Two-tap confirm cancel for an auto-book queue entry (mirrors booking cancellation).
function wireCancelAutoBook(btn, card, q) {
  if (!btn) return;
  const labelSpan = btn.querySelector('span');
  let confirmState = false;

  btn.addEventListener('click', async () => {
    if (!confirmState) {
      confirmState = true;
      labelSpan.textContent = 'Confirm?';
      btn.classList.add('confirming');
      setTimeout(() => {
        confirmState = false;
        labelSpan.textContent = 'Cancel';
        btn.classList.remove('confirming');
      }, 3000);
      return;
    }
    confirmState = false;
    btn.classList.remove('confirming');
    card.style.opacity = '0.6';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    labelSpan.textContent = '…';
    try {
      showToast('Removing scheduled booking...', 'info');
      await api.deleteAutoBooking(q.id);
      showToast('Class removed from queue.', 'success');
      renderAutoBookTab();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
      card.style.opacity = '1';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      labelSpan.textContent = 'Cancel';
    }
  });
}

// Edit modal for updating an existing auto-book queue entry's configuration
// (spot preferences, quantity, fallback toggle). Reuses the shared booking modal.
async function openAutoBookEditModal(q) {
  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title) return;

  const prefs = q.preferences || {};
  const currentQty = prefs.requiredCount || 1;
  const currentBookAny = prefs.bookAny ?? false;

  title.textContent = `Edit Auto-Book: ${q.group_name || q.class_name || 'Class'}`;
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

  try {
    // WP-C5: the floor plan is driven entirely by NormalizedSlot[] /
    // NormalizedLayoutObject[] from the adapter — no raw `studio.layout` access
    // — so a MarianaTek layout renders here unchanged. No live availability is
    // shown in this config modal (preference-only), so `isAvailable` is unused.
    const [{ event, slots: layoutSlots, objects: layoutObjects }, allPrefs] = await Promise.all([
      api.getEventDetails(q.event_id, q.gym_id),
      api.getStudioPreferences()
    ]);

    const resolvedStudioId = q.studio_id || event.studioId;
    const studioPrefs = resolvedStudioId ? allPrefs[resolvedStudioId] : null;

    // Seed from the shared studio map (live source of truth), fall back to entry prefs
    const seedSlots = (studioPrefs?.preferredSlots || prefs.preferredSlots || []).map(Number);
    const seedRows = studioPrefs?.preferredRows || prefs.preferredRows || [];
    const studioName = q.studio_name || event.studioName || 'this studio';

    // Explicit FCFS check rather than inferring it from an empty slot list —
    // an FCFS class has no assigned spots at all, which is a different thing
    // from a pick-a-spot studio whose floor map is missing. Both fall through
    // to the same spot-less controls below, but the copy differs.
    const isFcfs = event.layoutFormat === 'first-come-first-serve';
    if (isFcfs || layoutSlots.length === 0) {
      body.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-secondary);">
          <p style="margin-bottom: 16px;">${isFcfs ? "This class doesn't use assigned spots." : 'No floor map layout available for this studio.'}</p>
          <p style="font-size: 12px; color: var(--text-tertiary);">You can still update the number of spots and fallback option below.</p>
        </div>
      `;
      // Render minimal controls without floor plan
      const controlsDiv = document.createElement('div');
      controlsDiv.style.cssText = 'display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);';
      controlsDiv.innerHTML = `
        <div style="display:flex;gap:14px;align-items:center;border-top:1px solid var(--separator);padding-top:12px;">
          <div style="width:110px;">
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Slots to book:</label>
            <select id="autobook-edit-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
              ${[1,2,3,4].map(n => `<option value="${n}" ${currentQty===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1;padding-top:14px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
              <input type="checkbox" id="autobook-edit-fallback" ${currentBookAny ? 'checked' : ''}>
              <span>Book any slot if preferred is unavailable</span>
            </label>
          </div>
        </div>
        <button class="psycle-btn" id="btn-save-autobook-edit" style="background:var(--feat-autoupgrade);color:var(--on-accent);">Save Changes</button>
      `;
      body.appendChild(controlsDiv);

      controlsDiv.querySelector('#btn-save-autobook-edit').onclick = async () => {
        const qty = parseInt(controlsDiv.querySelector('#autobook-edit-qty').value) || 1;
        const fallbackAny = controlsDiv.querySelector('#autobook-edit-fallback').checked;
        await saveAutoBookEdit(q.id, resolvedStudioId, [], [], qty, fallbackAny, closeModal);
      };
      return;
    }

    body.innerHTML = `<div id="psycle-autobook-edit-editor"></div>`;
    const editorContainer = body.querySelector('#psycle-autobook-edit-editor');

    const bannerHtml = `
      <div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        Auto-Book uses your preferred spot map to book the best spot it can. You can edit your preferred spots any time in Settings.
      </div>`;

    const bannerHtmlEdit = `
      <div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        You are editing your preferred spot map for <strong>${studioName}</strong>. Changes here apply to Quick-Book and Auto-Upgrade too.
      </div>`;

    const extraControlsHtml = `
      <div style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
        <div style="display:flex;gap:14px;align-items:center;border-top:1px solid var(--separator);padding-top:12px;">
          <div style="width:110px;">
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Slots to book:</label>
            <select id="autobook-edit-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
              ${[1,2,3,4].map(n => `<option value="${n}" ${currentQty===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1;padding-top:14px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
              <input type="checkbox" id="autobook-edit-fallback" ${currentBookAny ? 'checked' : ''}>
              <span>Book any slot if preferred is unavailable</span>
            </label>
          </div>
        </div>
      </div>`;

    renderStudioFloorPlan(editorContainer, layoutSlots, seedSlots, seedRows, async (slots, rows, container) => {
      const qty = parseInt(container.querySelector('#autobook-edit-qty')?.value || currentQty) || 1;
      const fallbackAny = container.querySelector('#autobook-edit-fallback')?.checked ?? currentBookAny;
      await saveAutoBookEdit(q.id, resolvedStudioId, slots, rows, qty, fallbackAny, closeModal);
    }, {
      saveLabel: 'Save Changes',
      layoutObjects,
      bannerHtml,
      bannerHtmlEdit,
      extraControlsHtml,
      readOnly: true,
      editLabel: `Edit preferred spots for ${studioName}`,
      hideClear: true
    });
  } catch (err) {
    console.error('[AutoBook] Edit modal failed:', err);
    body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--danger);">Failed to load studio layout: ${err.message}</div>`;
  }
}

// Save updated auto-book preferences (updates both the queue entry and the shared studio map)
async function saveAutoBookEdit(entryId, studioId, slots, rows, qty, bookAny, closeModal) {
  try {
    showToast('Saving auto-book changes...', 'info');

    // 1. Update the shared studio map (live source of truth for all features)
    if (studioId && (slots.length > 0 || rows.length > 0)) {
      try {
        await api.updateStudioPreferences(studioId, { preferredSlots: slots, preferredRows: rows });
      } catch (e) {
        console.warn('[AutoBook] Could not persist studio map:', e.message);
      }
    }

    // 2. Update the auto-book queue entry preferences
    await api.updateAutoBooking(entryId, {
      preferredSlots: slots,
      preferredRows: rows,
      requiredCount: qty,
      bookAny
    });

    showToast('Auto-book configuration updated!', 'success');
    closeModal();
    renderAutoBookTab();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

const HISTORY_PAGE_SIZE = 10;
let _historyAll = [];
let _historyPage = 0;

function renderHistory(history) {
  // Wire the collapsible toggle once
  const toggle = document.getElementById('psycle-autobook-history-toggle');
  const content = document.getElementById('psycle-autobook-history-content');
  const chevron = document.getElementById('psycle-autobook-history-chevron');
  const histIcon = document.querySelector('.ab-history-icon');
  if (histIcon) histIcon.innerHTML = icon('history', 18);
  if (chevron) chevron.innerHTML = icon('chevron', 18);
  if (toggle && !toggle.dataset.listener) {
    toggle.dataset.listener = 'true';
    toggle.addEventListener('click', () => {
      const open = content.style.display !== 'none';
      content.style.display = open ? 'none' : 'block';
      toggle.classList.toggle('is-open', !open);
    });
  }

  history.sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
  _historyAll = history;
  _historyPage = 0;
  renderHistoryPage();
}

function renderHistoryPage() {
  const list = document.getElementById('psycle-autobook-history-list');
  const paginationEl = document.getElementById('psycle-autobook-history-pagination');
  if (!list) return;

  if (_historyAll.length === 0) {
    list.innerHTML = '<div class="psycle-table-empty">No execution history recorded in the last 24h.</div>';
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  const start = _historyPage * HISTORY_PAGE_SIZE;
  const page = _historyAll.slice(start, start + HISTORY_PAGE_SIZE);
  const totalPages = Math.ceil(_historyAll.length / HISTORY_PAGE_SIZE);

  list.innerHTML = '';
  page.forEach(h => {
    const executedDt = new Date(h.executed_at);
    const dateStr = executedDt.toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London'
    });
    const timeStr = executedDt.toLocaleString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London'
    });

    let state, statusText, statusGlyph;
    if (h.status === 'success')      { state = 'success';  statusText = 'Booked';     statusGlyph = 'checkCircle'; }
    else if (h.status === 'waitlist') { state = 'waitlist'; statusText = 'Waitlisted'; statusGlyph = 'clock'; }
    else                              { state = 'failed';   statusText = 'Failed';     statusGlyph = 'error'; }

    const className = h.class_name || h.group_name || 'Class';
    const details = [
      `${dateStr} · ${timeStr}`,
      h.instructor_name,
      [h.studio_name, trimLocation(h.location_name, getGymShortName(h.gym_id))].filter(Boolean).join(', ')
    ].filter(Boolean).join(' · ');

    const card = document.createElement('div');
    card.className = `ab-hist-card state-${state}`;
    card.setAttribute('data-gym', h.gym_id || 'psycle-london');
    card.innerHTML = `
      <div class="ab-hist-row1">
        <div class="ab-hist-name">
          ${disciplineTag(h.group_name || h.class_name)}
          <span class="psycle-gym-chip psycle-gym-chip-${h.gym_id || 'psycle-london'}">${getGymShortName(h.gym_id) || 'Psycle'}</span>
          <span class="ab-card-class">${className}</span>
        </div>
        <span class="ab-history-status state-${state}">${icon(statusGlyph, 12)} ${statusText}</span>
      </div>
      <div class="ab-hist-row2">${details}</div>
    `;
    list.appendChild(card);
  });

  equalizeDiscTagWidths(list);

  // Pagination controls
  if (paginationEl) {
    if (totalPages <= 1) {
      paginationEl.innerHTML = '';
    } else {
      paginationEl.innerHTML = `
        <button class="ab-hist-page-btn" id="ab-hist-prev" ${_historyPage === 0 ? 'disabled' : ''}>${icon('chevron', 14)} Prev</button>
        <span class="ab-hist-page-info">${_historyPage + 1} / ${totalPages}</span>
        <button class="ab-hist-page-btn" id="ab-hist-next" ${_historyPage >= totalPages - 1 ? 'disabled' : ''}>Next ${icon('chevron', 14)}</button>
      `;
      paginationEl.querySelector('#ab-hist-prev')?.addEventListener('click', () => { _historyPage--; renderHistoryPage(); });
      paginationEl.querySelector('#ab-hist-next')?.addEventListener('click', () => { _historyPage++; renderHistoryPage(); });
    }
  }
}

// Banner countdown: drop precision as the target nears.
//   > 24h  → "3d 22h"      (days + hours)
//   12–24h → "18h 40m"     (hours + minutes)
//   < 12h  → "8h 40m 12s"  (hours + minutes + seconds)
function formatBannerCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (ms > 24 * 3600e3) return `${days}d ${hours}h`;
  if (ms > 12 * 3600e3) return `${hours}h ${mins}m`;
  return `${hours}h ${mins}m ${secs}s`;
}

// Friendly relative phrasing for per-card release countdowns ("Opens in 3 days").
function formatOpensIn(ms) {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days >= 1) return `Opens in ${days} day${days !== 1 ? 's' : ''}`;
  if (hours >= 1) return `Opens in ${hours} hour${hours !== 1 ? 's' : ''}`;
  return `Opens in ${mins} min${mins !== 1 ? 's' : ''}`;
}


// The soonest release among the cards currently on screen, with the class it
// belongs to. Reads the DOM rather than the queue array so it always agrees with
// what the user can actually see.
function nextQueuedRelease() {
  let best = null;
  document.querySelectorAll('.ab-countdown[data-release-at]').forEach(el => {
    const at = DateTime.fromISO(el.getAttribute('data-release-at')).toMillis();
    if (!Number.isFinite(at)) return;
    if (!best || at < best.at) {
      const card = el.closest('.ab-card-main') || el.parentElement;
      const label = card ? ((card.querySelector('.ab-card-class') || {}).textContent || null) : null;
      best = { at, label: label ? label.trim().slice(0, 40) : null };
    }
  });
  return best;
}

// Tick loop updates countdown texts on the screen
function updateCountdowns() {
  const banner = document.querySelector('.ab-banner');
  const mainCountdown = document.getElementById('psycle-autobook-countdown');
  const statusIcon = document.querySelector('.ab-status-icon');
  const statusText = document.querySelector('.ab-status-text');

  // 1. Update global Monday 12PM countdown (colour handled by banner state classes)
  if (mainCountdown) {
    let paused = false, urgent = false, active = false;
    let statusGlyph = 'checkCircle', statusLabel = 'Standing by to book';
    if (userSettings.autoBookPaused) {
      mainCountdown.textContent = 'Paused';
      paused = true;
      statusGlyph = 'pause'; statusLabel = 'Auto-book paused';
    } else {
      // The next release among the QUEUED classes — not a fixed weekly instant.
      // A rolling-continuous gym has no weekly release at all, and even on Psycle
      // different membership tiers open the same class at different times, so a
      // single hardcoded Monday was only ever right by coincidence.
      const next = nextQueuedRelease();
      if (!next) {
        mainCountdown.textContent = 'Nothing queued';
        statusGlyph = 'clock'; statusLabel = 'No classes waiting to book';
      } else {
        const diffMs = next.at - Date.now();
        if (diffMs <= 0) {
          mainCountdown.textContent = 'Open now';
          active = true;
          statusGlyph = 'bolt'; statusLabel = 'Booking window open';
        } else {
          mainCountdown.textContent = formatBannerCountdown(diffMs);
          urgent = diffMs <= 30000;
          statusLabel = next.label ? `Next: ${next.label}` : 'Standing by to book';
        }
      }
    }
    if (statusText && statusText.textContent !== statusLabel) {
      statusText.textContent = statusLabel;
      if (statusIcon) {
        if (statusGlyph === 'checkCircle') {
          statusIcon.innerHTML = pulseIcon(13);
        } else {
          statusIcon.innerHTML = icon(statusGlyph, 13);
        }
      }
    }
    if (banner) {
      banner.classList.toggle('is-paused', paused);
      banner.classList.toggle('is-urgent', urgent);
      banner.classList.toggle('is-active', active);
    }
  }

  // 2. Update individual card countdowns
  document.querySelectorAll('.ab-countdown').forEach(el => {
    const startAt = el.getAttribute('data-start-at');
    if (!startAt) return;
    const valEl = el.querySelector('.ab-countdown-val') || el;

    // Each card carries its OWN release instant, resolved when it was rendered.
    // Not recomputed here from a shared rule: on a rolling-continuous gym two
    // classes on the same day open at different times, so there is no single
    // "next release" a card could be measured against.
    const stamped = el.getAttribute('data-release-at');
    const classRelease = stamped
      ? DateTime.fromISO(stamped)
      : getClassReleaseTime({ start_at: startAt }, userSettings);
    const diff = classRelease.toMillis() - Date.now();

    if (diff <= 0) {
      valEl.textContent = 'Booking now';
      el.classList.remove('state-pending');
      el.classList.add('state-active');
    } else {
      valEl.textContent = formatOpensIn(diff);
      el.classList.remove('state-active');
      el.classList.add('state-pending');
    }
  });
}

// initAutoBook is exported as async function on line 8
