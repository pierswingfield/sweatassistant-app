import { api } from '../api';
import { showToast, cache, userSettings, refreshUserData } from '../main';
import { getClassReleaseTime, getNextMondayNoonLondon } from '../lib';
import { renderStudioFloorPlan } from './spotmap';
import { setupPullToRefresh } from './pulltorefresh';

let countdownInterval = null;
let sseEventSource = null;
const statusCache = new Map(); // eventId → current status

// ── Inline SVG icon set (themeable via currentColor) ─────────────────
const SVG_PATHS = {
  clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/>',
  edit: '<path d="M11 2.5 13.5 5 6 12.5 3 13l.5-3L11 2.5Z"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  checkCircle: '<circle cx="8" cy="8" r="6.25"/><path d="M5.3 8.2 7 9.9l3.7-3.9"/>',
  error: '<circle cx="8" cy="8" r="6.25"/><path d="M8 5v3.5M8 11h.01"/>',
  bang: '<path d="M8 4v5M8 11.5h.01"/>',
  history: '<path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.2h2.2M8 5.5V8l2 1.2"/>',
  chevron: '<path d="M4 6l4 4 4-4"/>',
  pause: '<path d="M6 4v8M10 4v8"/>',
  play: '<path d="M5.5 4l6 4-6 4z"/>',
  heart: '<path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z"/>',
  bolt: '<path d="M8.5 1.5 3.5 9h3.5l-1 5.5L13 6.5H9z"/>',
  warning: '<path d="M8 2 14.5 13.5h-13L8 2Z"/><path d="M8 6.5v3M8 11.8h.01"/>',
  // discipline glyphs
  ride: '<circle cx="4.3" cy="11" r="2.5"/><circle cx="11.7" cy="11" r="2.5"/><path d="M4.3 11 7 5.5h2.5l2.2 5.5M7 5.5 6.2 4H4.5"/>',
  barre: '<path d="M2 8h12M3.5 6v4M12.5 6v4"/>',
  strength: '<path d="M2.5 6v4M4.2 5v6M11.8 5v6M13.5 6v4M4.2 8h7.6"/>',
  infrared: '<path d="M8 2c1.8 2.2 3 3.7 3 6a3 3 0 1 1-6 0c0-1 .4-1.8 1-2.5.2 1 .8 1.5 1.3 1.5-.5-1.7.7-4 .7-5Z"/>',
  reformer: '<path d="M2 5h12M2 11h12M5 5v6M11 5v6"/>',
  yoga: '<circle cx="8" cy="3.7" r="1.8"/><path d="M8 6.5v3M3.5 13c1.2-2.5 7.8-2.5 9 0"/>',
  other: '<circle cx="8" cy="8" r="2.6"/>',
};
const FILLED_ICONS = new Set(['play', 'heart', 'bolt']);

function icon(name, size = 14) {
  const inner = SVG_PATHS[name] || SVG_PATHS.other;
  const filled = FILLED_ICONS.has(name);
  return `<svg class="ab-ico" width="${size}" height="${size}" viewBox="0 0 16 16" `
    + `fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" `
    + `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Derive a class discipline (token + label + glyph) from the group/class name.
function getDiscipline(name = '') {
  const s = String(name).toLowerCase();
  const D = (key, label) => ({ key, label, icon: SVG_PATHS[key] ? key : 'other' });
  if (/ride|cycle|spin/.test(s)) return D('ride', 'Ride');
  if (/barre/.test(s)) return D('barre', 'Barre');
  if (/reformer|pilates/.test(s)) return D('reformer', 'Reformer');
  if (/infrared|hot|sweat/.test(s)) return D('infrared', 'Infrared');
  if (/yoga|flow|mind|meditat/.test(s)) return D('yoga', 'Yoga');
  if (/strength|tone|sculpt|hiit|abs|arms|signature/.test(s)) return D('strength', 'Strength');
  const label = name ? String(name).replace(/\b\w/g, c => c.toUpperCase()) : 'Class';
  return { key: 'other', label, icon: 'other' };
}

// Render a discipline tag chip (coloured pastel pill with glyph).
function disciplineTag(name) {
  const d = getDiscipline(name);
  return `<span class="ab-disc-tag" data-disc="${d.key}">${icon(d.icon, 11)}${d.label}</span>`;
}

// Strip the "Psycle " prefix from a location name (matches the timetable filters).
function trimLocation(name = '') {
  return String(name).replace(/^Psycle\s*/i, '');
}

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

  // Setup pull-to-refresh on the auto-book scroll container
  const scrollEl = document.querySelector('#psycle-panel-auto-book .ab-body');
  if (scrollEl && !scrollEl._pullToRefresh) {
    scrollEl._pullToRefresh = setupPullToRefresh(scrollEl, async () => {
      await Promise.all([renderAutoBookTab(), refreshUserData()]);
    });
  }
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

  // Favourites button
  const favsBtn = document.createElement('button');
  favsBtn.className = 'ab-footer-btn';
  favsBtn.innerHTML = `${icon('heart', 14)}<span>Favourites</span>`;
  favsBtn.addEventListener('click', () => openFavouritesModal());

  bar.appendChild(pauseBtn);
  bar.appendChild(favsBtn);

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
    setupHistoryToggle();
  } else {
    // First visit — no cached data yet
    if (queueContainer) {
      queueContainer.innerHTML = `<div class="psycle-spinner" style="margin: 30px auto;"></div>`;
    }
    if (historyList) {
      historyList.innerHTML = `<div class="psycle-table-empty">Loading history...</div>`;
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
    setupHistoryToggle();
  } catch (err) {
    console.error('[AutoBook] Failed to load:', err);
    if (queueContainer && !cache.autoBookings) {
      queueContainer.innerHTML = `<div class="psycle-card-error">Error: ${err.message}</div>`;
    }
  }
}

function setupHistoryToggle() {
  const historyToggle = document.getElementById('psycle-autobook-history-toggle');
  const historyContent = document.getElementById('psycle-autobook-history-content');

  if (historyToggle && !historyToggle.dataset.listener) {
    historyToggle.dataset.listener = 'true';
    historyToggle.addEventListener('click', () => {
      const isOpen = historyContent.style.display !== 'none';
      historyContent.style.display = isOpen ? 'none' : 'block';
      historyToggle.classList.toggle('is-open', !isOpen);
    });
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
    card.className = 'psycle-autobook-card ab-card';
    card.setAttribute('data-event-id', q.event_id);

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
    const locationLine = [q.studio_name, trimLocation(q.location_name)].filter(Boolean).join(', ');

    // Calculate total available credits from profile
    let totalAvailableCredits = 0;
    if (cache.profile?.available_credits) {
      totalAvailableCredits = cache.profile.available_credits.reduce((sum, c) => sum + (c.count || 0), 0);
    }
    const hasInsufficientCredits = totalAvailableCredits < creditsNeeded;

    const creditWarning = hasInsufficientCredits
      ? `<div class="ab-credit-warning">${icon('warning', 13)}<span>Insufficient Credits</span></div>`
      : '';

    card.innerHTML = `
      <div class="ab-card-main">
        <div class="ab-card-toprow">
          <div class="ab-card-when">
            <span class="ab-card-date">${dateStr.toUpperCase()}</span>
            <span class="ab-card-time">${timeOnly}</span>
          </div>
          ${disciplineTag(q.group_name || q.class_name)}
        </div>
        <div class="ab-card-meta">
          <span class="ab-card-class">${className}</span>
          <span class="ab-meta-dot">·</span>
          <span class="ab-card-instructor">${q.instructor_name || 'TBA'}</span>
          ${locationLine ? `<span class="ab-card-location">${locationLine}</span>` : ''}
        </div>
        <div class="ab-card-footer">
          <span class="ab-countdown state-pending" data-start-at="${q.start_at}">
            ${icon('clock', 13)}<span class="ab-countdown-val">…</span>
          </span>
          <span class="ab-spots-pill">${creditsNeeded} Spot${creditsNeeded !== 1 ? 's' : ''} Required</span>
        </div>
        ${creditWarning}
      </div>
      <div class="ab-card-rail">
        <button class="ab-rail-btn edit-autobook-btn" data-id="${q.id}" aria-label="Edit">${icon('edit', 17)}<span>Edit</span></button>
        <button class="ab-rail-btn danger delete-autobook-btn" data-id="${q.id}" aria-label="Cancel">${icon('close', 17)}<span>Cancel</span></button>
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

    // Edit click listener
    card.querySelector('.edit-autobook-btn').addEventListener('click', () => {
      openAutoBookEditModal(q);
    });

    container.appendChild(card);
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
    // Fetch event + studio layout, and the live shared studio map in parallel
    const [res, allPrefs] = await Promise.all([
      api.proxyGet(`/events/${q.event_id}`),
      api.getStudioPreferences()
    ]);

    const eventDetails = res.data || res;
    const studio = res.relations?.studios?.[0] || eventDetails.relations?.studios?.[0] || eventDetails.studio || {};
    const layoutSlots = studio?.layout?.slots || [];
    const resolvedStudioId = q.studio_id || studio.id;
    const studioPrefs = resolvedStudioId ? allPrefs[resolvedStudioId] : null;

    // Seed from the shared studio map (live source of truth), fall back to entry prefs
    const seedSlots = (studioPrefs?.preferredSlots || prefs.preferredSlots || []).map(Number);
    const seedRows = studioPrefs?.preferredRows || prefs.preferredRows || [];
    const studioName = q.studio_name || studio?.name || 'this studio';

    if (layoutSlots.length === 0) {
      body.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-secondary);">
          <p style="margin-bottom: 16px;">No floor map layout available for this studio.</p>
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
        This is the one shared preferred spot map for <strong>${studioName}</strong>. Changes here apply to Quick-Book and Auto-Upgrade too.
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
      bannerHtml,
      extraControlsHtml
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

function renderHistory(history) {
  // Set the collapsible header glyphs (cheap; runs once per render)
  const histIcon = document.querySelector('.ab-history-icon');
  if (histIcon) histIcon.innerHTML = icon('history', 20);
  const chevron = document.getElementById('psycle-autobook-history-chevron');
  if (chevron) chevron.innerHTML = icon('chevron', 18);

  const list = document.getElementById('psycle-autobook-history-list');
  if (!list) return;

  if (history.length === 0) {
    list.innerHTML = '<div class="psycle-table-empty">No execution history recorded in the last 24h.</div>';
    return;
  }

  // Sort: most recent first
  history.sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));

  list.innerHTML = '';
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

    // status → { state class, pill text, glyph }
    let state, statusText, glyph;
    if (h.status === 'success') {
      state = 'success'; statusText = 'Successfully booked'; glyph = 'check';
    } else if (h.status === 'waitlist') {
      state = 'waitlist'; statusText = 'Joined waitlist'; glyph = 'clock';
    } else {
      state = 'failed'; statusText = h.execution_message || 'Failed'; glyph = 'bang';
    }

    const locationLine = [h.studio_name, trimLocation(h.location_name)].filter(Boolean).join(' · ');

    const row = document.createElement('div');
    row.className = `ab-history-row state-${state}`;
    row.innerHTML = `
      <div class="ab-history-row-main">
        <div class="ab-history-row-head">
          ${disciplineTag(h.group_name || h.class_name)}
          <span class="ab-history-class">${h.class_name || 'Class'}</span>
        </div>
        <div class="ab-history-row-sub">
          ${h.instructor_name ? `<strong>${h.instructor_name}</strong>` : ''}${locationLine ? ` — ${locationLine}` : ''}
        </div>
        <span class="ab-history-status state-${state}">${statusText}</span>
      </div>
      <div class="ab-history-row-end">
        <span class="ab-history-time">${timeStr}</span>
        <span class="ab-history-glyph state-${state}">${icon(glyph, 18)}</span>
      </div>
    `;
    list.appendChild(row);
  });
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

// Tick loop updates countdown texts on the screen
function updateCountdowns() {
  const banner = document.querySelector('.ab-banner');
  const mainCountdown = document.getElementById('psycle-autobook-countdown');
  const statusIcon = document.querySelector('.ab-status-icon');
  const statusText = document.querySelector('.ab-status-text');

  // 1. Update global Monday 12PM countdown (colour handled by banner state classes)
  if (mainCountdown) {
    let paused = false, urgent = false, active = false;
    let statusGlyph = 'checkCircle', statusLabel = 'Ready to book';
    if (userSettings.autoBookPaused) {
      mainCountdown.textContent = 'Paused';
      paused = true;
      statusGlyph = 'pause'; statusLabel = 'Auto-book paused';
    } else {
      const diffMs = getNextMondayNoonLondon().toMillis() - Date.now();
      if (diffMs <= 0) {
        mainCountdown.textContent = 'Open now';
        active = true;
        statusGlyph = 'bolt'; statusLabel = 'Booking window open';
      } else {
        mainCountdown.textContent = formatBannerCountdown(diffMs);
        urgent = diffMs <= 30000;
      }
    }
    if (statusIcon) statusIcon.innerHTML = icon(statusGlyph, 13);
    if (statusText) statusText.textContent = statusLabel;
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

    // Use default settings (or we can inject active user settings)
    const settings = {
      advancedBooking: document.getElementById('psycle-setting-advanced-booking')?.checked || false,
      advancedBookingCredit: document.getElementById('psycle-setting-advanced-booking-credit')?.checked || false
    };

    const classRelease = getClassReleaseTime(startAt, settings);
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
