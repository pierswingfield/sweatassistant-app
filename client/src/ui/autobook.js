import { api } from '../api';
import { showToast, cache, userSettings, refreshUserData } from '../main';
import { getClassReleaseTime, getNextMondayNoonLondon, formatFullCountdown, formatCountdown } from '../lib';
import { DateTime } from 'luxon';

let countdownInterval = null;
let sseEventSource = null;
const statusCache = new Map(); // eventId → current status

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

export async function initAutoBook() {
  await refreshUserData(); // Refresh credits when opening Auto-Book tab
  await renderAutoBookTab();
  renderAutoBookControls();
  connectToAutoBookStream();

  // Setup countdown interval
  if (countdownInterval) clearInterval(countdownInterval);
  updateCountdowns();
  countdownInterval = setInterval(updateCountdowns, 1000);
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
    console.log('[AutoBook] SSE stream connected');
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
    console.error('[AutoBook] SSE stream error:', err);
    sseEventSource.close();
    // Optionally reconnect after a delay
    setTimeout(() => connectToAutoBookStream(), 5000);
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
    statusEl.style.cssText = 'font-size:11px;color:#64748b;margin-top:8px;padding:6px;background:rgba(99,102,241,0.05);border-left:2px solid rgba(99,102,241,0.3);border-radius:4px;';
    card.appendChild(statusEl);
  }

  // Update status text and color based on status type
  let statusColor = '#94a3b8';
  let statusIcon = '⏳';

  if (update.status === 'prefetching') {
    statusIcon = '📊';
    statusColor = '#64748b';
  } else if (update.status === 'planning') {
    statusIcon = '📋';
    statusColor = '#a5b4fc';
    if (update.plannedSlots) {
      statusEl.innerHTML = `${statusIcon} Planning: attempting slots <strong>[${update.plannedSlots.join(', ')}]</strong>`;
    }
  } else if (update.status === 'attempting') {
    statusIcon = '🎯';
    statusColor = '#fbbf24';
    statusEl.innerHTML = `${statusIcon} Attempting slot <strong>${update.attemptingSlot}</strong> (${update.isPreferred ? 'preferred' : 'fallback'})...`;
  } else if (update.status === 'success') {
    statusIcon = '✅';
    statusColor = '#34d399';
    statusEl.innerHTML = `${statusIcon} Success! Booked slots <strong>[${update.bookedSlots.join(', ')}]</strong>`;
  } else if (update.status === 'waitlist-fallback') {
    statusIcon = '📋';
    statusColor = '#f59e0b';
  } else if (update.status === 'waitlist-success') {
    statusIcon = '✅';
    statusColor = '#fbbf24';
    statusEl.innerHTML = `${statusIcon} Joined waitlist`;
  } else if (update.status === 'failed') {
    statusIcon = '❌';
    statusColor = '#f87171';
    statusEl.innerHTML = `${statusIcon} <span style="color:#f87171;"><strong>Failed:</strong> ${update.message}</span>`;
  }

  statusEl.style.color = statusColor;
  statusEl.textContent = update.message || statusEl.textContent;
}

function renderAutoBookControls() {
  // Insert Pause/Resume + Favourites + Simulate buttons near the countdown banner
  const banner = document.querySelector('.psycle-countdown-banner');
  if (!banner) return;

  // Remove existing controls bar if re-rendered
  const existing = document.getElementById('psycle-autobook-controls-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'psycle-autobook-controls-bar';
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;';

  const isPaused = !!userSettings.autoBookPaused;

  // Pause / Resume button
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'psycle-btn-mini';
  pauseBtn.style.cssText = isPaused
    ? 'background:rgba(52,211,153,0.15);border-color:rgba(52,211,153,0.3);color:#34d399;'
    : 'background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.25);color:#f87171;';
  pauseBtn.textContent = isPaused ? '▶ Resume Auto-Book' : '⏸ Pause Auto-Book';
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

  // Favourites button
  const favsBtn = document.createElement('button');
  favsBtn.className = 'psycle-btn-mini';
  favsBtn.style.cssText = 'background:rgba(251,191,36,0.1);border-color:rgba(251,191,36,0.25);color:#fbbf24;';
  favsBtn.textContent = '♥ Auto-Book Favourites';
  favsBtn.addEventListener('click', () => openFavouritesModal());

  bar.appendChild(pauseBtn);
  bar.appendChild(favsBtn);

  // Simulate button (debug mode only)
  if (userSettings.debugMode) {
    const simBtn = document.createElement('button');
    simBtn.className = 'psycle-btn-mini';
    simBtn.style.cssText = 'background:rgba(139,92,246,0.12);border-color:rgba(139,92,246,0.3);color:#a78bfa;';
    simBtn.textContent = '⚡ Simulate Release';
    simBtn.addEventListener('click', async () => {
      simBtn.disabled = true;
      simBtn.textContent = 'Firing...';
      try {
        await api.simulateRelease();
        showToast('Simulated release fired — all pending bookings executing now. Check history shortly.', 'success');
        // Refresh queue/history after a short delay to let bookings complete
        setTimeout(() => renderAutoBookTab(), 4000);
      } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
      } finally {
        simBtn.disabled = false;
        simBtn.textContent = '⚡ Simulate Release';
      }
    });
    bar.appendChild(simBtn);
  }

  banner.insertAdjacentElement('afterend', bar);
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
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#0f172a;border:1px solid rgba(255,255,255,0.12);border-radius:16px;width:100%;max-width:480px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;';
  header.innerHTML = `<h3 style="margin:0;font-size:15px;font-weight:700;color:#f1f5f9;">♥ Auto-Book Favourites</h3><button style="background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;padding:0;" id="favs-modal-close">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';

  if (bookmarks.length === 0) {
    body.innerHTML = '<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">No bookmarked classes found.<br>Bookmark classes from the timetable to set up recurring auto-book.</div>';
  } else {
    const parsed = bookmarks.map(parseBookmark);
    const enabled = new Set(userSettings.autoBookFavourites || []);

    body.innerHTML = '<p style="font-size:12px;color:#94a3b8;margin:0 0 12px;">Select which favourites to auto-book each week:</p>';

    parsed.forEach(bm => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:6px;';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = enabled.has(bm.raw);
      cb.style.cssText = 'width:16px;height:16px;accent-color:#a78bfa;cursor:pointer;flex-shrink:0;';
      cb.addEventListener('change', () => {
        if (cb.checked) enabled.add(bm.raw);
        else enabled.delete(bm.raw);
      });

      const label = document.createElement('div');
      label.style.cssText = 'flex:1;font-size:12px;color:#e2e8f0;';
      label.innerHTML = bm.studioId
        ? `<strong>Studio ${bm.studioId}</strong> · ${bm.dayOfWeek} ${bm.time}`
        : `<span style="color:#94a3b8;">${bm.raw}</span>`;

      row.appendChild(cb);
      row.appendChild(label);
      body.appendChild(row);
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'psycle-btn';
    saveBtn.style.cssText = 'width:100%;margin-top:12px;background:#a78bfa;color:#fff;';
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
  const historyBody = document.getElementById('psycle-autobook-history-table-body');

  if (queueContainer) {
    queueContainer.innerHTML = `<div class="psycle-spinner" style="margin: 30px auto;"></div>`;
  }
  if (historyBody) {
    historyBody.innerHTML = `<tr><td colspan="5" class="psycle-table-empty">Loading history...</td></tr>`;
  }

  try {
    const res = await api.getAutoBookings();
    
    // Separate active vs executed (history)
    const active = res.filter(x => !x.executed_at);
    const history = res.filter(x => x.executed_at);

    renderQueue(active);
    renderHistory(history);

    // History section toggle
    const historyToggle = document.getElementById('psycle-autobook-history-toggle');
    const historyContent = document.getElementById('psycle-autobook-history-content');
    const historyChevron = document.getElementById('psycle-autobook-history-chevron');

    if (historyToggle && !historyToggle.dataset.listener) {
      historyToggle.dataset.listener = 'true';
      historyToggle.addEventListener('click', () => {
        const isOpen = historyContent.style.display !== 'none';
        historyContent.style.display = isOpen ? 'none' : 'block';
        if (historyChevron) {
          historyChevron.textContent = isOpen ? '▶' : '▼';
          historyChevron.style.transform = isOpen ? '' : 'rotate(180deg)';
        }
      });
    }
  } catch (err) {
    console.error('[AutoBook] Failed to load:', err);
    if (queueContainer) queueContainer.innerHTML = `<div class="psycle-card-error">Error: ${err.message}</div>`;
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

  container.innerHTML = '';
  queue.forEach(q => {
    const card = document.createElement('div');
    card.className = 'psycle-autobook-card';
    card.setAttribute('data-event-id', q.event_id);
    card.style.background = 'rgba(255,255,255,0.03)';
    card.style.border = '1px solid rgba(255,255,255,0.08)';
    card.style.borderRadius = '16px';
    card.style.padding = '16px';
    card.style.marginBottom = '12px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '10px';

    const startDt = new Date(q.start_at);
    const timeStr = startDt.toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    const prefs = q.preferences || {};
    const preferredSlots = prefs.preferredSlots || [];
    const preferredRows = prefs.preferredRows || [];
    const creditsNeeded = prefs.requiredCount || 1;

    let preferencesLabel = 'Any Available Spot';
    if (preferredSlots.length > 0) {
      preferencesLabel = `Spots: ${preferredSlots.join(', ')}`;
    } else if (preferredRows.length > 0) {
      preferencesLabel = `Rows: ${preferredRows.map(r => `Row ${Math.round(r)}`).join(', ')}`;
    }

    // Calculate total available credits from profile
    let totalAvailableCredits = 0;
    if (cache.profile?.available_credits) {
      totalAvailableCredits = cache.profile.available_credits.reduce((sum, c) => sum + (c.count || 0), 0);
    }
    const hasInsufficientCredits = totalAvailableCredits < creditsNeeded;

    const creditWarning = hasInsufficientCredits
      ? `<div style="font-size: 11px; font-weight: 700; color: #f59e0b; padding: 4px 8px; border-radius: 6px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); text-align: center;">⚠ Insufficient Credits</div>`
      : '';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin: 0; font-family: 'Outfit'; font-size: 16px; font-weight: 700;">${q.class_name}</h4>
          <span style="font-size: 12px; color: #94a3b8;">with ${q.instructor_name}</span>
        </div>
        <span class="psycle-autobook-card-countdown" data-start-at="${q.start_at}" style="font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 8px; border: 1px solid; text-transform: uppercase;">
          00:00:00
        </span>
      </div>
      <div style="font-size: 13px; color: #cbd5e1; display: flex; flex-direction: column; gap: 4px;">
        <div><strong>Time:</strong> ${timeStr}</div>
        <div><strong>Studio:</strong> ${q.studio_name} (${q.location_name})</div>
        <div><strong>Spot Preference:</strong> ${preferencesLabel} ${prefs.bookAny ? '(or fallback)' : '(strict)'}</div>
        <div><strong>Credits Needed:</strong> ${creditsNeeded}</div>
      </div>
      ${creditWarning}
      <div style="display: flex; gap: 10px; margin-top: 6px;">
        <button class="psycle-action-btn-mini delete-autobook-btn" data-id="${q.id}" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #f87171;">Delete</button>
      </div>
    `;

    // Delete click listener
    card.querySelector('.delete-autobook-btn').addEventListener('click', async () => {
      try {
        showToast('Removing scheduled booking...', 'info');
        await api.deleteAutoBooking(q.id);
        showToast('Class removed from queue.', 'success');
        renderAutoBookTab();
      } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
      }
    });

    container.appendChild(card);
  });
}

function renderHistory(history) {
  const tbody = document.getElementById('psycle-autobook-history-table-body');
  if (!tbody) return;

  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="psycle-table-empty">No execution history recorded in the last 24h.</td></tr>';
    return;
  }

  // Sort: most recent first
  history.sort((a,b) => new Date(b.executed_at) - new Date(a.executed_at));

  tbody.innerHTML = '';
  history.forEach(h => {
    const executedDt = new Date(h.executed_at);
    const timeStr = executedDt.toLocaleString('en-GB', { 
      day: 'numeric', 
      month: 'short', 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    let statusBadge = '';
    if (h.status === 'success') {
      statusBadge = '<span class="status-cell yes">Booked</span>';
    } else if (h.status === 'waitlist') {
      statusBadge = '<span class="status-cell warning" style="color:#fbbf24; border-color:rgba(245,158,11,0.2);">Waitlist</span>';
    } else {
      statusBadge = '<span class="status-cell no">Failed</span>';
    }

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${h.class_name}</strong><br><small style="color:#94a3b8;">with ${h.instructor_name}</small></td>
      <td>${h.studio_name}<br><small style="color:#94a3b8;">${h.location_name}</small></td>
      <td>${timeStr}</td>
      <td>${statusBadge}</td>
      <td style="font-size:12px; color:#cbd5e1; max-width:250px; overflow:hidden; text-overflow:ellipsis;" title="${h.execution_message || ''}">
        ${h.execution_message || 'No details recorded.'}
      </td>
    `;
    tbody.appendChild(row);
  });
}

// Tick loop updates countdown texts on the screen
function updateCountdowns() {
  const mainCountdown = document.getElementById('psycle-autobook-countdown');
  const mainTarget = document.getElementById('psycle-autobook-target-time');

  // 1. Update global Monday 12PM Countdown
  if (mainCountdown && mainTarget) {
    if (userSettings.autoBookPaused) {
      mainCountdown.textContent = "PAUSED";
      mainCountdown.style.color = "#f87171";
      mainTarget.textContent = "Auto-book is paused";
    } else {
      const targetRelease = getNextMondayNoonLondon();
      const diffMs = targetRelease.toMillis() - Date.now();
      mainTarget.textContent = `Target Release: ${targetRelease.toLocaleString(DateTime.DATETIME_FULL_WITH_ZONE)}`;
      if (diffMs <= 0) {
        mainCountdown.textContent = "RELEASE ACTIVE!";
        mainCountdown.style.color = "#34d399";
      } else {
        mainCountdown.textContent = formatFullCountdown(diffMs);
        mainCountdown.style.color = diffMs <= 30000 ? "#f87171" : "#fff";
      }
    }
  }

  // 2. Update individual card countdowns
  document.querySelectorAll('.psycle-autobook-card-countdown').forEach(el => {
    const startAt = el.getAttribute('data-start-at');
    if (!startAt) return;

    // Use default settings (or we can inject active user settings)
    const settings = {
      advancedBooking: document.getElementById('psycle-setting-advanced-booking')?.checked || false,
      advancedBookingCredit: document.getElementById('psycle-setting-advanced-booking-credit')?.checked || false
    };

    const classRelease = getClassReleaseTime(startAt, settings);
    const diff = classRelease.toMillis() - Date.now();

    if (diff <= 0) {
      el.textContent = "Active";
      el.style.color = '#34d399';
      el.style.background = 'rgba(16, 185, 129, 0.1)';
      el.style.borderColor = 'rgba(16, 185, 129, 0.2)';
    } else {
      el.textContent = formatCountdown(diff);
      el.style.color = '#c084fc';
      el.style.background = 'rgba(139, 92, 246, 0.1)';
      el.style.borderColor = 'rgba(139, 92, 246, 0.2)';
    }
  });
}

// initAutoBook is exported as async function on line 8
