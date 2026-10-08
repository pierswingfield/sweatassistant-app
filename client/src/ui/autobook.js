import { api } from '../api';
import { COPY, formatCopyText } from '../copy.js';
import { getGymShortName, getLinkedGyms, getDefaultGymId } from '../gym-context.js';
import { getAvailableCreditsForEvent, getTotalCredits, getIneligibleReason } from './credit-allowance.js';
import { showToast, cache, userSettings, refreshUserData, debugConsole } from '../main';
import { getClassReleaseTime, noSept, zoneFor, formatInZone } from '../lib';
import { DateTime } from 'luxon';
import { renderStudioFloorPlan } from './spotmap';
import { instructorInlineHtml, cleanClassName, icon, disciplineTag, trimLocation, seatNoun, pulseIcon, renderGymRail, equalizeDiscTagWidths, observeLocationWrap, wireRailToggle, escapeHtml, gymBrand, gymChip } from './cards';
import { renderCardSkeletons } from './loading-skeleton.js';
import { ensureLiveStatusLine, setLiveStatusText } from './status-line.js';
import { instructorAvatar } from './tooltips.js';
import { pickStudioPrefs, metadata, loadMetadata, rowGroupsForStudio } from './timetable';
import { openPage as openNavPage, closePage as closeNavPage } from './modal-nav.js';
import { applyBookingChrome, bookingContextEl } from './booking-chrome.js';

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

// U1-13: re-render the queue/history from the data already loaded, when the
// per-gym credit or eligibility answer arrives after the first paint. No fetch.
export function repaintAutoBookFromCache() {
  const cached = cache.autoBookings;
  if (!Array.isArray(cached)) return;
  renderQueue(cached.filter(x => !x.executed_at));
  renderHistory(cached.filter(x => x.executed_at));
}

// Pull-to-refresh action for the Auto-Book tab — dispatched by the shared
// pull-to-refresh handler in main.js (attached to <main class="app-body">).
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
  const token = localStorage.getItem('appLocalToken');
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
  const queueContainer = document.getElementById('app-autobook-queue-container');
  if (!queueContainer) return;

  // Find the card for this event
  const card = queueContainer.querySelector(`[data-event-id="${eventId}"]`);
  if (!card) return;

  // Update or create a status line. It is a polite live region (U2-3): screen
  // readers announce status CHANGES only (see status-line.js) — the countdown
  // that ticks every second lives elsewhere and is not announced.
  const { el: statusEl, created } = ensureLiveStatusLine(card.querySelector('.ab-card-main') || card);

  // Colour and a fallback text per status; a server-supplied `message` wins.
  let statusColor = 'var(--text-secondary)';
  let fallbackText = null;

  if (update.status === 'prefetching') {
    statusColor = 'var(--text-tertiary)';
  } else if (update.status === 'planning') {
    statusColor = 'var(--feat-autoupgrade)';
    if (update.plannedSlots) fallbackText = COPY.autoBook.planningSlots.replace('{slots}', update.plannedSlots.join(', '));
  } else if (update.status === 'attempting') {
    statusColor = 'var(--warning)';
    fallbackText = COPY.autoBook.attemptingSlot.replace('{slot}', update.attemptingSlot).replace('{kind}', update.isPreferred ? 'preferred' : 'fallback');
  } else if (update.status === 'success') {
    statusColor = 'var(--success)';
    fallbackText = COPY.autoBook.bookedSlotsStatus.replace('{slots}', (update.bookedSlots || []).join(', '));
  } else if (update.status === 'waitlist-fallback') {
    statusColor = 'var(--warning)';
  } else if (update.status === 'waitlist-success') {
    statusColor = 'var(--warning)';
    fallbackText = COPY.autoBook.joinedWaitlistStatus;
  } else if (update.status === 'failed') {
    statusColor = 'var(--danger)';
    fallbackText = `❌ Failed: ${update.message || ''}`.trim();
  }

  statusEl.style.color = statusColor;
  // textContent only (never innerHTML): the message comes from the server.
  setLiveStatusText(statusEl, update.message || fallbackText || statusEl.textContent, { created });
}

function renderAutoBookControls() {
  // Populate the segmented footer baked into the countdown banner
  const bar = document.getElementById('app-autobook-controls-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const isPaused = !!userSettings.autoBookPaused;

  // Pause / Resume button
  const pauseBtn = document.createElement('button');
  pauseBtn.className = `ab-footer-btn ${isPaused ? 'state-paused' : ''}`;
  pauseBtn.innerHTML = isPaused
    ? `${icon('play', 14)}<span>${COPY.autoBook.resume}</span>`
    : `${icon('pause', 14)}<span>${COPY.autoBook.pause}</span>`;
  pauseBtn.addEventListener('click', async () => {
    pauseBtn.disabled = true;
    try {
      const newPaused = !userSettings.autoBookPaused;
      // Account-scoped: one Pause button over a MERGED queue means "stop
      // auto-booking for me", not "for one gym" — there isn't one to name here.
      await api.updateSettings({ autoBookPaused: newPaused });
      userSettings.autoBookPaused = newPaused;
      showToast(newPaused ? COPY.autoBook.paused : COPY.autoBook.resumed, newPaused ? 'info' : 'success');
      renderAutoBookControls();
    } catch (err) {
      showToast(formatCopyText(COPY.autoBook.failed, { error: err.message }), 'error');
    } finally {
      pauseBtn.disabled = false;
    }
  });

  bar.appendChild(pauseBtn);

  // Simulate button (debug mode only)
  if (userSettings.debugMode) {
    const simBtn = document.createElement('button');
    simBtn.className = 'ab-footer-btn';
    simBtn.innerHTML = `${icon('bolt', 14)}<span>${COPY.autoBook.simulateRelease}</span>`;
    simBtn.addEventListener('click', async () => {
      simBtn.disabled = true;
      simBtn.innerHTML = `${icon('bolt', 14)}<span>${COPY.autoBook.firing}</span>`;
      try {
        await api.simulateRelease();
        showToast(COPY.autoBook.simulatedRelease, 'success');
        // Refresh queue/history after a short delay to let bookings complete
        setTimeout(() => renderAutoBookTab(), 4000);
      } catch (err) {
        showToast(formatCopyText(COPY.autoBook.failed, { error: err.message }), 'error');
      } finally {
        simBtn.disabled = false;
        simBtn.innerHTML = `${icon('bolt', 14)}<span>${COPY.autoBook.simulateRelease}</span>`;
      }
    });
    bar.appendChild(simBtn);
  }
}

async function renderAutoBookTab() {
  const queueContainer = document.getElementById('app-autobook-queue-container');
  const historyList = document.getElementById('app-autobook-history-list');

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
      queueContainer.innerHTML = renderCardSkeletons(3, COPY.autoBook.loadingQueueLabel);
    }
    if (historyList) {
      historyList.innerHTML = renderCardSkeletons(2, COPY.autoBook.loadingHistoryLabel);
    }
  }

  // instructorAvatar() reads metadata.instructors, otherwise only filled by the
  // Timetable prefetch. Landing here first left every avatar missing until the
  // user visited Timetable and back. Load it and repaint when it arrives.
  if (!metadata.instructors.length) {
    loadMetadata().then(repaintAutoBookFromCache).catch(() => {});
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
      queueContainer.innerHTML = `<div class="app-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">${COPY.autoBook.noCachedData}</p><p style="font-size:13px;color:var(--text-tertiary)">${COPY.autoBook.noCachedDataHelp}</p></div>`;
    }
  }

}


function renderQueue(queue) {
  const container = document.getElementById('app-autobook-queue-container');
  if (!container) return;

  if (queue.length === 0) {
    container.__abSig = null;
    container.innerHTML = `
      <div class="fav-empty-state" style="padding: 30px 0;">
        ${COPY.autoBook.noScheduledClasses}
      </div>
    `;
    return;
  }

  // Sort chronologically by class start time
  const sorted = [...queue].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  // Skip a re-render that would produce identical cards: entering the tab fires cache paint,
  // metadata repaint and fresh-fetch render back to back, and each one re-created every logo
  // <img> (visible flicker). Anything the card markup depends on is in the signature.
  let sig = null;
  try {
    sig = JSON.stringify([sorted, metadata.instructors.length, cache.credits, cache.creditsByGym, cache.eligibility, cache.eligibilityByGym, userSettings, (getLinkedGyms() || []).map(g => g.gym_id || g.id)]);
  } catch (e) { sig = null; }
  if (sig && container.__abSig === sig && container.childElementCount > 0) return;
  container.__abSig = sig;
  container.innerHTML = '';
  sorted.forEach(q => {
    const card = document.createElement('div');
    card.className = 'app-autobook-card ab-card';
    card.setAttribute('data-event-id', q.event_id);
    card.setAttribute('data-gym', q.gym_id || getDefaultGymId());

    const fmt = formatInZone(q.start_at, zoneFor(q));
    const dateStr = noSept(fmt.date);
    const timeOnly = fmt.timeLabel;

    const prefs = q.preferences || {};
    const creditsNeeded = prefs.requiredCount || 1;
    const className = cleanClassName(q.class_name || '', q.group_name || '') || q.group_name || COPY.autoBook.class;
    // No fallback to a placeholder string — a recovery class genuinely has no
    // instructor, and the empty-string branch below omits the label entirely
    // rather than rendering a meaningless "TBA" (same fix as timetable's B6).
    const instructorName = q.instructor_name || '';
    // Stored at queue time — the by-name lookup inside instructorAvatar can't
    // be relied on here, since a queue row is read back long after the
    // timetable metadata that would resolve it.
    const instructorPhotoUrl = q.instructor_image_url || null;
    const locationLine = [q.studio_name, trimLocation(q.location_name, getGymShortName(q.gym_id))].filter(Boolean).join(', ');

    // Via the shared module so the unmetered case is handled once: it returns
    // Infinity for a membership gym, where "insufficient credits" is meaningless.
    // A membership gym still needs its OWN gate though — getIneligibleReason()
    // (WP-J) — since Infinity credits says nothing about membership status.
    const ineligibleReason = getIneligibleReason(q.gym_id);
    const hasInsufficientCredits = getTotalCredits(q.gym_id) < creditsNeeded;

    const creditWarning = ineligibleReason
      ? `<div class="ab-credit-warning">${icon('warning', 13)}<span>${ineligibleReason}</span></div>`
      : hasInsufficientCredits
        ? `<div class="ab-credit-warning">${icon('warning', 13)}<span>${COPY.autoBook.insufficientCredits}</span></div>`
        : '';

    // C5-3: server-computed clashes with the member's other queued classes or
    // bookings. Messages are server text, so escape them.
    const clashWarnings = (q.warnings || [])
      .map(w => `<div class="ab-credit-warning ab-clash-warning" data-code="${escapeHtml(w.code)}">${icon('warning', 13)}<span>${escapeHtml(w.message)}</span></div>`)
      .join('');

    card.innerHTML = `
      ${renderGymRail(q.gym_id || getDefaultGymId())}
      <div class="ab-card-main">
        <div class="ab-card-body">
          <div class="ab-card-lines">
            <div class="ab-card-line1">
              <span class="ab-card-date">${dateStr.toUpperCase()}</span>
              <span class="ab-card-time">${timeOnly}</span>
            </div>
            <div class="ab-card-line2">
              <span class="ab-card-titlegroup">${disciplineTag(q.group_name || q.class_name)}
              <span class="ab-card-class">${className}</span></span>
              ${instructorInlineHtml(instructorName)}
              ${locationLine ? `<span class="ab-meta-dot">·</span><span class="ab-card-location">${locationLine}</span>` : ''}
            </div>
          </div>
          ${(instructorAvatar(instructorName, q.gym_id, instructorPhotoUrl) || instructorName)
          ? `<div class="ab-card-figure">${instructorAvatar(instructorName, q.gym_id, instructorPhotoUrl) || ''}${instructorName ? `<span class="ab-card-instructor">${instructorName}</span>` : ''}</div>` : ''}
        </div>
        <div class="ab-card-footer">
          <span class="ab-countdown state-pending" data-start-at="${q.start_at}" data-gym-id="${q.gym_id || ''}" ${(() => { const r = getClassReleaseTime(q, userSettings); return r ? `data-release-at="${r.toISO()}"` : ''; })()}>
            ${icon('clock', 13)}<span class="ab-countdown-val">…</span>
          </span>
          <div class="ab-chip-group"><span class="ab-spots-pill">${creditsNeeded} ${seatNoun(q.group_name)[0].toUpperCase() + seatNoun(q.group_name).slice(1)}${creditsNeeded !== 1 ? 's' : ''}</span></div>
        </div>
        ${creditWarning}
        ${clashWarnings}
      </div>
      <div class="ab-card-rail">
        <button class="ab-rail-btn edit-autobook-btn" data-id="${q.id}" aria-label="${COPY.autoBook.edit}">${icon('edit', 17)}<span>${COPY.autoBook.edit}</span></button>
        <button class="ab-rail-btn danger delete-autobook-btn" data-id="${q.id}" aria-label="${COPY.bookings.cancel}">${icon('close', 17)}<span>${COPY.bookings.cancel}</span></button>
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
  observeLocationWrap(container);
  wireRailToggle(container);
  // Fill the countdowns now from each row's own release time; waiting for the
  // interval (which starts only after the first network fetch) left "…" for 1-2s.
  updateCountdowns();
}

// Two-tap confirm cancel for an auto-book queue entry (mirrors booking cancellation).
function wireCancelAutoBook(btn, card, q) {
  if (!btn) return;
  const labelSpan = btn.querySelector('span');
  let confirmState = false;

  btn.addEventListener('click', async () => {
    if (!confirmState) {
      confirmState = true;
      labelSpan.textContent = COPY.autoBook.confirm;
      btn.classList.add('confirming');
      setTimeout(() => {
        confirmState = false;
        labelSpan.textContent = COPY.bookings.cancel;
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
      showToast(COPY.autoBook.removing, 'info');
      await api.deleteAutoBooking(q.id);
      showToast(COPY.autoBook.removed, 'success');
      renderAutoBookTab();
    } catch (err) {
      showToast(formatCopyText(COPY.autoBook.failed, { error: err.message }), 'error');
      card.style.opacity = '1';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      labelSpan.textContent = COPY.bookings.cancel;
    }
  });
}

// Edit modal for updating an existing auto-book queue entry's configuration
// (spot preferences, quantity, fallback toggle). Reuses the shared booking modal.
export async function openAutoBookEditModal(q) {
  const modal = document.getElementById('app-booking-modal');
  const body = document.getElementById('app-booking-modal-body');
  const title = document.getElementById('app-booking-modal-title');
  if (!modal || !body || !title) return;

  const prefs = q.preferences || {};
  const currentQty = prefs.requiredCount || 1;
  const abClassName = cleanClassName(q.class_name || '', q.group_name || '') || q.group_name || q.class_name || COPY.autoBook.class;
  const currentBookAny = prefs.bookAny ?? false;

  title.textContent = formatCopyText(COPY.autoBook.editTitle, { className: cleanClassName(q.class_name || '', q.group_name || '') || q.group_name || q.class_name || COPY.autoBook.class });
  // Mobile: static title + identity strip; class details live in the class card above the map.
  applyBookingChrome(modal, { titleText: COPY.bookingFlow.titleEditAutoBook, gymId: q.gym_id, locationName: q.location_name, studioName: q.studio_name });
  body.innerHTML = `
    <div class="app-loading-spinner-container" style="padding: 40px 0;">
      <div class="app-spinner"></div>
      <span>${COPY.autoBook.loadingFloorMap}</span>
    </div>
  `;

  const spotMapDirty = () => !!body.querySelector('[data-spotmap-root]')?.__isDirty?.();
  const discardOk = () => !spotMapDirty() || confirm(COPY.bookingEditor.discardChanges);
  openNavPage(modal, { id: 'autobook-edit', canClose: discardOk });

  const closeBtn = document.getElementById('app-booking-modal-close');
  const overlay = modal.querySelector('.app-modal-overlay');

  const closeModal = () => {
    if (closeNavPage(modal)) return; // mobile page: pop its history entry
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
    const studioPrefs = pickStudioPrefs(allPrefs, resolvedStudioId, q.gym_id);

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
          <p style="margin-bottom: 16px;">${isFcfs ? COPY.autoBook.unassignedSpots : COPY.autoBook.noFloorMap}</p>
          <p style="font-size: 12px; color: var(--text-tertiary);">${COPY.autoBook.noFloorMapHelp}</p>
        </div>
      `;
      // Render minimal controls without floor plan
      const controlsDiv = document.createElement('div');
      controlsDiv.style.cssText = 'display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);';
      controlsDiv.innerHTML = `
        <div style="display:flex;gap:14px;align-items:center;border-top:1px solid var(--separator);padding-top:12px;">
          <div style="width:110px;">
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">${COPY.autoBook.slotsToBook}</label>
            <select id="autobook-edit-qty" class="app-select" style="width:100%;padding:6px 8px;font-size:13px;">
              ${[1,2,3,4].map(n => `<option value="${n}" ${currentQty===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1;padding-top:14px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
              <input type="checkbox" id="autobook-edit-fallback" ${currentBookAny ? 'checked' : ''}>
              <span>${COPY.autoBook.fallbackAnySlot}</span>
            </label>
          </div>
        </div>
        <button class="app-btn" id="btn-save-autobook-edit" style="background:var(--feat-autoupgrade);color:var(--on-accent);">${COPY.autoBook.saveChanges}</button>
      `;
      body.appendChild(controlsDiv);

      controlsDiv.querySelector('#btn-save-autobook-edit').onclick = async () => {
        const qty = parseInt(controlsDiv.querySelector('#autobook-edit-qty').value) || 1;
        const fallbackAny = controlsDiv.querySelector('#autobook-edit-fallback').checked;
        await saveAutoBookEdit(q.id, resolvedStudioId, [], [], qty, fallbackAny, closeModal, q.gym_id);
      };
      return;
    }

    body.innerHTML = `<div id="app-autobook-edit-editor"></div>`;
    const editorContainer = body.querySelector('#app-autobook-edit-editor');

    const bannerHtml = `
      <div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        ${COPY.autoBook.preferredMapHelp}
      </div>`;

    const bannerHtmlEdit = `
      <div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        ${formatCopyText(COPY.autoBook.editingMapHtml, { studioName: escapeHtml(studioName) })}
      </div>`;

    const extraControlsHtml = `
      <div style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
        <div style="display:flex;gap:14px;align-items:center;border-top:1px solid var(--separator);padding-top:12px;">
          <div style="width:110px;">
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">${COPY.autoBook.slotsToBook}</label>
            <select id="autobook-edit-qty" class="app-select" style="width:100%;padding:6px 8px;font-size:13px;">
              ${[1,2,3,4].map(n => `<option value="${n}" ${currentQty===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1;padding-top:14px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
              <input type="checkbox" id="autobook-edit-fallback" ${currentBookAny ? 'checked' : ''}>
              <span>${COPY.autoBook.fallbackAnySlot}</span>
            </label>
          </div>
        </div>
      </div>`;

    renderStudioFloorPlan(editorContainer, layoutSlots, seedSlots, seedRows, async (slots, rows, container) => {
      const qty = parseInt(container.querySelector('#autobook-edit-qty')?.value || currentQty) || 1;
      const fallbackAny = container.querySelector('#autobook-edit-fallback')?.checked ?? currentBookAny;
      await saveAutoBookEdit(q.id, resolvedStudioId, slots, rows, qty, fallbackAny, closeModal, q.gym_id);
    }, {
      saveLabel: COPY.autoBook.saveChanges,
      layoutObjects,
      rowGroups: rowGroupsForStudio(resolvedStudioId, q.gym_id),
      bannerHtml,
      bannerHtmlEdit,
      extraControlsHtml,
      readOnly: true,
      editLabel: formatCopyText(COPY.timetable.editPreferredSpots, { studio: studioName }),
      hideClear: true,
      aboveMap: () => bookingContextEl({
        className: abClassName, instructorName: q.instructor_name || '', startAt: q.start_at, gymId: q.gym_id, timeZone: q.time_zone || q.timeZone,
      }, { helperId: 'spotmap-setup', helperText: COPY.bookingFlow.helperSetup })
    });
  } catch (err) {
    console.error('[AutoBook] Edit modal failed:', err);
    body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--danger);">${formatCopyText(COPY.autoBook.failedStudioLayout, { error: escapeHtml(err.message) })}</div>`;
  }
}

// Save updated auto-book preferences (updates both the queue entry and the shared studio map)
async function saveAutoBookEdit(entryId, studioId, slots, rows, qty, bookAny, closeModal, gymId = null) {
  try {
    showToast(COPY.autoBook.savingChanges, 'info');

    // 1. Update the shared studio map (live source of truth for all features)
    if (studioId && (slots.length > 0 || rows.length > 0)) {
      try {
        // Named explicitly: a studio id is unique only within its own gym.
        await api.updateStudioPreferences(studioId, { preferredSlots: slots, preferredRows: rows }, gymId);
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

    showToast(COPY.autoBook.updated, 'success');
    closeModal();
    renderAutoBookTab();
  } catch (err) {
    showToast(formatCopyText(COPY.autoBook.failed, { error: err.message }), 'error');
  }
}

const HISTORY_PAGE_SIZE = 10;
let _historyAll = [];
let _historyPage = 0;

function renderHistory(history) {
  // Wire the collapsible toggle once
  const toggle = document.getElementById('app-autobook-history-toggle');
  const content = document.getElementById('app-autobook-history-content');
  const chevron = document.getElementById('app-autobook-history-chevron');
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
  // Same identical-render skip as the queue (rows carry gym logos that flicker when rebuilt).
  const histList = document.getElementById('app-autobook-history-list');
  let histSig = null;
  try { histSig = JSON.stringify([history, metadata.instructors.length]); } catch (e) { histSig = null; }
  if (histSig && histList && histList.__histSig === histSig && histList.childElementCount > 0) return;
  if (histList) histList.__histSig = histSig;
  _historyAll = history;
  _historyPage = 0;
  renderHistoryPage();
}

function renderHistoryPage() {
  const list = document.getElementById('app-autobook-history-list');
  const paginationEl = document.getElementById('app-autobook-history-pagination');
  if (!list) return;

  if (_historyAll.length === 0) {
    list.innerHTML = `<div class="app-table-empty">${COPY.autoBook.noHistory}</div>`;
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  const start = _historyPage * HISTORY_PAGE_SIZE;
  const page = _historyAll.slice(start, start + HISTORY_PAGE_SIZE);
  const totalPages = Math.ceil(_historyAll.length / HISTORY_PAGE_SIZE);

  list.innerHTML = '';
  page.forEach(h => {
    const fmt = formatInZone(h.executed_at, zoneFor(h));
    const dateStr = noSept(fmt.date);
    const timeStr = fmt.timeLabel;

    let state, statusText, statusGlyph;
    if (h.status === 'success')      { state = 'success';  statusText = COPY.autoBook.bookedStatus;     statusGlyph = 'checkCircle'; }
    else if (h.status === 'waitlist') { state = 'waitlist'; statusText = COPY.autoBook.waitlistedStatus; statusGlyph = 'clock'; }
    else                              { state = 'failed';   statusText = COPY.autoBook.failedStatus;     statusGlyph = 'error'; }

    const className = cleanClassName(h.class_name || '', h.group_name || '') || h.group_name || COPY.autoBook.class;
    const details = [
      `${dateStr} · ${timeStr}`,
      h.instructor_name,
      [h.studio_name, trimLocation(h.location_name, getGymShortName(h.gym_id))].filter(Boolean).join(', ')
    ].filter(Boolean).join(' · ');

    const card = document.createElement('div');
    card.className = `ab-hist-card state-${state}`;
    card.setAttribute('data-gym', h.gym_id || getDefaultGymId());
    card.innerHTML = `
      <div class="ab-hist-row1">
        <div class="ab-hist-name">
          ${disciplineTag(h.group_name || h.class_name)}
          ${gymChip(h.gym_id || getDefaultGymId())}
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
        <button class="ab-hist-page-btn" id="ab-hist-prev" ${_historyPage === 0 ? 'disabled' : ''}>${icon('chevron', 14)} ${COPY.autoBook.previousPage}</button>
        <span class="ab-hist-page-info">${_historyPage + 1} / ${totalPages}</span>
        <button class="ab-hist-page-btn" id="ab-hist-next" ${_historyPage >= totalPages - 1 ? 'disabled' : ''}>${COPY.autoBook.nextPage} ${icon('chevron', 14)}</button>
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
  // The "Opens in " prefix is its own span so CSS can drop it while the card's
  // action rail is open (.is-rail-open .ab-cd-prefix) without a re-render.
  const prefix = COPY.timetable.opensInPrefixHtml;
  if (days >= 1) return formatCopyText(days === 1 ? COPY.timetable.opensInDaysOne : COPY.timetable.opensInDaysMany, { prefix, count: days });
  if (hours >= 1) return formatCopyText(hours === 1 ? COPY.timetable.opensInHoursOne : COPY.timetable.opensInHoursMany, { prefix, count: hours });
  return formatCopyText(mins === 1 ? COPY.timetable.opensInMinutesOne : COPY.timetable.opensInMinutesMany, { prefix, count: mins });
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
  const mainCountdown = document.getElementById('app-autobook-countdown');
  const statusIcon = document.querySelector('.ab-status-icon');
  const statusText = document.querySelector('.ab-status-text');

  // 1. Update global Monday 12PM countdown (colour handled by banner state classes)
  if (mainCountdown) {
    let paused = false, urgent = false, active = false;
    let statusGlyph = 'checkCircle', statusLabel = 'Standing by to book';
    if (userSettings.autoBookPaused) {
      // The whole headline becomes the pause status (icon + label); the
      // separate status line and "Next booking in" label are hidden by CSS.
      mainCountdown.innerHTML = `${icon('pause', 18)}<span>${COPY.autoBook.pausedHeadline}</span>`;
      paused = true;
      statusGlyph = 'pause'; statusLabel = 'Auto-book paused';
    } else {
      // The next release among the QUEUED classes — not a fixed weekly instant.
      // A rolling-continuous gym has no weekly release at all, and even on Psycle
      // different membership tiers open the same class at different times, so a
      // single hardcoded Monday was only ever right by coincidence.
      const next = nextQueuedRelease();
      if (!next) {
        mainCountdown.textContent = COPY.autoBook.nothingQueued;
        statusGlyph = 'clock'; statusLabel = 'No classes waiting to book';
      } else {
        const diffMs = next.at - Date.now();
        if (diffMs <= 0) {
          mainCountdown.textContent = COPY.autoBook.openNow;
          active = true;
          statusGlyph = 'bolt'; statusLabel = 'Booking window open';
        } else {
          mainCountdown.textContent = formatBannerCountdown(diffMs);
          urgent = diffMs <= 30000;
          statusLabel = next.label ? COPY.autoBook.nextLabel.replace('{label}', next.label) : COPY.autoBook.standingBy;
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
      const qc = document.getElementById('app-autobook-queue-container');
      if (qc) qc.classList.toggle('is-paused', paused);
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
      : getClassReleaseTime({ start_at: startAt, gym_id: el.getAttribute('data-gym-id') }, userSettings);
    if (!classRelease) { valEl.textContent = COPY.autoBook.releaseUnknown; return; }
    const diff = classRelease.toMillis() - Date.now();

    if (diff <= 0) {
      valEl.textContent = COPY.autoBook.bookingNow;
      el.classList.remove('state-pending');
      el.classList.add('state-active');
    } else {
      valEl.innerHTML = formatOpensIn(diff);
      el.classList.remove('state-active');
      el.classList.add('state-pending');
    }
  });
}

// initAutoBook is exported as async function on line 8
