import { api } from '../api';
import { canForGym, getGymShortName } from '../gym-context.js';
import { getAvailableCreditsForEvent, getTotalCredits, getIneligibleReason } from './credit-allowance.js';
import { showToast, cache, refreshUserData, updateCreditBadge, userSettings, gymSetting } from '../main';
import { renderStudioFloorPlan } from './spotmap';
import { icon, disciplineTag, trimLocation, seatNoun, stripClassNamePrefix, trendingUpIcon, pulseIcon, renderGymRail, equalizeDiscTagWidths , shortSlotLabels} from './cards';
import { isInGracePeriod, GRACE_PERIOD_MS, startGraceCountdown } from '../lib';
import { invalidateApiCache } from '../cache';
import { renderCardSkeletons } from './loading-skeleton.js';
import { instructorAvatar } from './tooltips.js';
import { metadata, loadMetadata, getStudioMapInfo, pickStudioPrefs } from './timetable';

// Class starts within the free-cancel cutoff (12h). Edit is hidden inside this
// window; Cancel stays available but warns about the penalty.
function isWithin12Hours(startAt) {
  if (!startAt) return false;
  const diff = new Date(startAt) - new Date();
  return diff > 0 && diff <= 12 * 60 * 60 * 1000;
}

// Delegates so the unmetered case is decided in one place (Infinity on a
// membership gym) rather than summing an empty balance to a misleading 0.
// ALWAYS pass the row's own gym — in a merged list you always have one. Without
// it this answers for whichever gym the app defaults to, which put a warning
// icon on a JAB spot pill because the Psycle balance happened to be empty.
const totalAvailableCredits = (gymId) => getTotalCredits(gymId);


export async function renderBookings() {
  const bookingsList = document.getElementById('psycle-bookings-list');
  const waitlistsList = document.getElementById('psycle-waitlists-list');

  // Show refreshing indicators
  const bookingsRefreshing = document.getElementById('psycle-bookings-refreshing');
  const waitlistsRefreshing = document.getElementById('psycle-waitlists-refreshing');
  if (bookingsRefreshing) bookingsRefreshing.style.display = '';
  if (waitlistsRefreshing) waitlistsRefreshing.style.display = '';

  // Show cached data immediately if available (cache.upgrades is set after first load)
  const hasLoadedBefore = cache.upgrades !== undefined;
  if (hasLoadedBefore) {
    renderBookingsCards(cache.bookings || [], cache.upgrades || []);
    renderWaitlistsCards(cache.waitlists || []);
  } else {
    // First visit — no cached data yet
    if (bookingsList) bookingsList.innerHTML = renderCardSkeletons(2, 'Loading bookings');
    if (waitlistsList) waitlistsList.innerHTML = renderCardSkeletons(1, 'Loading waitlists');
  }

  // instructorAvatar() reads metadata.instructors, which is otherwise only
  // populated by the Timetable tab's prefetch — landing straight on My
  // Bookings (a reload, or the app's initial tab) left it empty for the whole
  // session until the user visited Timetable and back, so every photo was
  // missing until then. Fetch it here too and repaint once it lands.
  if (!metadata.instructors.length) {
    loadMetadata().then(() => {
      renderBookingsCards(cache.bookings || [], cache.upgrades || []);
      renderWaitlistsCards(cache.waitlists || []);
    }).catch(() => {});
  }

  try {
    // WP-C1: bookings/waitlists + their event enrichment now come from the
    // normalized endpoints (api.getBookings/getWaitlists) instead of a raw
    // list fetch plus a hand-rolled per-item `/events/{id}` + relations-join
    // loop. `codexfit.listBookings()`/`listWaitlists()` (server side) already
    // do that exact join — inline `b.event`/`w.event` when present (mock
    // convention), else resolve via the response's `relations` block (real
    // API convention) — so this is a straight simplification, not a behavior
    // change, and it also removes what used to be up to 2×N extra HTTP calls
    // (one per unenriched booking/waitlist) on every bookings-tab load.
    // Each NormalizedBooking is unwrapped back to a legacy-compatible shape
    // (`{...raw booking row, event: <raw resolved event>}`) so every existing
    // field read below (many layers deep in renderBookingsCards/
    // renderWaitlistsCards) keeps working unmodified.
    const [normalizedBookings, normalizedWaitlists, upgradesRes] = await Promise.all([
      api.getBookings(),
      api.getWaitlists(),
      api.getAutoUpgrades()
    ]);

    const bookings = normalizedBookings || [];
    const waitlists = normalizedWaitlists || [];
    const upgrades = upgradesRes || [];

    cache.bookings = bookings;
    cache.waitlists = waitlists;
    cache.upgrades = upgrades;

    renderBookingsCards(bookings, upgrades);
    renderWaitlistsCards(waitlists);

    // Hide refreshing indicators
    if (bookingsRefreshing) bookingsRefreshing.style.display = 'none';
    if (waitlistsRefreshing) waitlistsRefreshing.style.display = 'none';

    // Keep the server's reminder cache warm using data we already fetched (no extra CodexFit calls).
    syncBookingCache(bookings);

  } catch (err) {
    console.error('[Bookings] Loading failed:', err);

    // Show a friendly empty state when offline and no cached data is available
    if (bookingsList && !cache.bookings) {
      bookingsList.innerHTML = '<div class="psycle-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">No cached data available</p><p style="font-size:13px;color:var(--text-tertiary)">Connect to the internet to load your bookings.</p></div>';
    } else if (bookingsList) {
      bookingsList.innerHTML = `<div class="psycle-card-error">Error: ${err.message}</div>`;
    }
    if (waitlistsList && !cache.waitlists) {
      waitlistsList.innerHTML = '<div class="psycle-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">No cached data available</p><p style="font-size:13px;color:var(--text-tertiary)">Connect to the internet to load your waitlists.</p></div>';
    } else if (waitlistsList) {
      waitlistsList.innerHTML = `<div class="psycle-card-error">Error: ${err.message}</div>`;
    }

    if (bookingsRefreshing) bookingsRefreshing.style.display = 'none';
    if (waitlistsRefreshing) waitlistsRefreshing.style.display = 'none';
  }
}

// Push the user's upcoming bookings to the server so cancellation reminders can
// fire locally without the server re-polling CodexFit.
function syncBookingCache(bookings) {
  try {
    const now = Date.now();
    const normalized = (bookings || []).map(b => {
      const event = b.event || {};
      const startAt = event.startAt || event.start_at || b.start_at;
      if (!startAt || new Date(startAt).getTime() < now) return null;
      const rawClassName = event.name || event.event_type?.name || 'Class';
      const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
      const className = stripClassNamePrefix(rawClassName, groupName);
      const instructorName = event.instructors?.[0]?.name || event.instructor?.full_name || event.instructor?.name || '';
      const studioName = event.studioName || event.studio?.name || '';
      const locationName = event.locationName || event.studio?.location?.name || '';
      return {
        bookingId: bookingIdOf(b),
        // This list is MERGED across every linked gym, so each row has to carry
        // its own — the server files the reminder cache by it.
        gymId: event.gymId || b.gymId || null,
        eventId: event.id || b.eventId || b.event_id || null,
        startAt,
        className,
        groupName,
        instructorName,
        studioName,
        locationName,
        slotLabel: b.raw?.spot?.name ?? b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? b.slotId ?? '',
      };
    }).filter(Boolean);
    api.syncBookings(normalized).catch(() => {});
  } catch (_) { /* best-effort */ }
}

// ── My Bookings cards ────────────────────────────────────────────────
// One card per class: a class booked with multiple spots stores one booking
// record per spot, so we group those records into a single card.
function renderBookingsCards(bookings, upgrades) {
  const container = document.getElementById('psycle-bookings-list');
  if (!container) return;

  const groups = new Map();
  bookings.forEach(b => {
    const event = b.event || null;
    const startAt = event?.startAt || event?.start_at;
    if (!event || !startAt) return;
    const key = String(event.id || b.eventId || b.event_id);
    if (!groups.has(key)) groups.set(key, { eventId: key, event, bookings: [] });
    groups.get(key).bookings.push(b);
  });

  if (groups.size === 0) {
    container.innerHTML = '<div class="fav-empty-state" style="padding:30px 0;">No active bookings found.</div>';
    return;
  }

  const sorted = [...groups.values()].sort((a, b) => new Date(a.event.startAt || a.event.start_at) - new Date(b.event.startAt || b.event.start_at));
  container.innerHTML = '';
  sorted.forEach(group => container.appendChild(buildBookingCard(group, upgrades)));
  equalizeDiscTagWidths(container);
}

function buildBookingCard(group, upgrades) {
  const event = group.event;
  const startAt = event.startAt || event.start_at;
  const startDt = new Date(startAt);
  const dateStr = startDt.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const timeOnly = startDt.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' });

  const rawClassName = event.name || event.event_type?.name || 'Class';
  const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
  const className = stripClassNamePrefix(rawClassName, groupName);
  // No fallback to a placeholder string — a recovery class genuinely has no
  // instructor, and the empty-string branch below omits the label entirely
  // rather than rendering a meaningless "TBA" (same fix as timetable's B6).
  const instructorName = event.instructors?.[0]?.name || event.instructor?.full_name || '';
  const instructorPhotoUrl = event.instructors?.[0]?.thumbUrl || event.instructors?.[0]?.imageUrl || null;
  const locationLine = [event.studioName || event.studio?.name, trimLocation(event.locationName || event.studio?.location?.name, getGymShortName(event.gymId))].filter(Boolean).join(', ');

  const within12h = isWithin12Hours(startAt);

  // No seat map for this studio (FCFS/recovery) means there is no spot to
  // reassign — same reasoning as the timetable's own Edit gating. Resolved
  // once, up front, because the chip loop below needs it too (U1-1): a
  // slot-less booking's `slotId` normalizes to `""`, not null/undefined, so
  // the old `?? '?'` fallback chain never ran — `""` is not nullish — and
  // the chip silently rendered a blank "Spot" button that still opened the
  // auto-upgrade modal for a class with no seats to upgrade to.
  const { hasMap } = getStudioMapInfo(event);

  const chipsHtml = group.bookings.map(b => {
    if (!hasMap) {
      // Static badge, not a button: there is no spot to configure auto-upgrade
      // for on an FCFS/recovery class, so it must not be clickable (it isn't
      // wired below — the click-listener loop only selects `.ab-spot-upgrade-chip`).
      return `<span class="ab-spot-open-floor" title="First come, first served — no assigned spot">Open floor</span>`;
    }

    const slotId = slotIdOf(b);
    const slotLabel = b.raw?.spot?.name ?? b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? slotId ?? '?';

    // Find active upgrade for this specific booking
    const activeUpgrade = upgrades.find(u =>
      Number(u.booking_id) === Number(bookingIdOf(b)) &&
      ['active', 'paused_no_credits'].includes(u.status)
    );

    let chipClass = 'ab-spot-upgrade-chip';
    let iconHtml = '';

    if (activeUpgrade) {
      if (activeUpgrade.status === 'paused_no_credits' || totalAvailableCredits(event.gymId) < 1) {
        chipClass += ' state-warning';
        iconHtml = '<span style="margin-right:4px;">⚠</span>';
      } else {
        chipClass += ' state-active';
        iconHtml = pulseIcon(12) + '&nbsp;';
      }
    }

    const noun = seatNoun(groupName);
    const nounCap = noun.charAt(0).toUpperCase() + noun.slice(1);

    return `<button class="${chipClass}"
                    data-booking-id="${bookingIdOf(b)}"
                    data-slot-id="${slotId}"
                    data-slot-label="${slotLabel}"
                    data-upgrade-id="${activeUpgrade?.id || ''}"
                    title="${activeUpgrade ? 'Configure/disable auto-upgrade' : 'Configure/enable auto-upgrade'}">
              ${iconHtml}${nounCap} ${slotLabel}
            </button>`;
  }).join('');

  const editBtnHtml = (within12h || !hasMap) ? '' :
    `<button class="ab-rail-btn bk-edit-btn" aria-label="Edit spots">${icon('edit', 17)}<span>Edit</span></button>`;

  const card = document.createElement('div');
  card.className = 'psycle-autobook-card ab-card';
  card.setAttribute('data-event-id', group.eventId);
  card.setAttribute('data-gym', event.gymId || 'psycle-london');
  card.innerHTML = `
    ${renderGymRail(event.gymId || 'psycle-london')}
    <div class="ab-card-main">
      ${/* TWO lines of class information, not four.
           Line 1 — WHEN, plus who's teaching: the two facts you scan a booking
                    list for.
           Line 2 — WHAT: discipline, class name, where.
           The photo is a figure on the right of both lines, so it never sits
           inside a text line box (which is what made a 52px avatar hang below
           the row it belonged to). */ ''}
      <div class="ab-card-body">
        <div class="ab-card-lines">
          <div class="ab-card-line1">
            <span class="ab-card-date">${dateStr.toUpperCase()}</span>
            <span class="ab-card-time">${timeOnly}</span>
            ${instructorName ? `<span class="ab-card-instructor">${instructorName}</span>` : ''}
          </div>
          <div class="ab-card-line2">
            ${disciplineTag(groupName)}
            <span class="ab-card-class">${className}</span>
            ${locationLine ? `<span class="ab-meta-dot">·</span><span class="ab-card-location">${locationLine}</span>` : ''}
          </div>
        </div>
        ${instructorAvatar(instructorName, event.gymId, instructorPhotoUrl)
          ? `<div class="ab-card-figure">${instructorAvatar(instructorName, event.gymId, instructorPhotoUrl)}</div>` : ''}
      </div>
      <div class="ab-card-footer" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-start;">
        ${chipsHtml}
      </div>
    </div>
    <div class="ab-card-rail">
      ${editBtnHtml}
      <button class="ab-rail-btn danger bk-cancel-btn" aria-label="Cancel booking">${icon('close', 17)}<span>Cancel</span></button>
    </div>
  `;

  // Edit spots
  const editBtn = card.querySelector('.bk-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => openEditBookingModal(group));

  // Auto-upgrade click listeners for each spot chip
  card.querySelectorAll('.ab-spot-upgrade-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const bid = Number(btn.getAttribute('data-booking-id'));
      const slotId = btn.getAttribute('data-slot-id');
      const slotLabel = btn.getAttribute('data-slot-label');
      const upgradeId = btn.getAttribute('data-upgrade-id') ? Number(btn.getAttribute('data-upgrade-id')) : null;
      
      const matchingUpgrade = upgrades.find(u => Number(u.id) === upgradeId);
      const existingPrefs = matchingUpgrade?.preferences || null;

      handleUpgradeClick({
        eventId: group.eventId,
        gymId: event.gymId,
        bookingId: bid,
        currentSlotId: slotId,
        studioId: event.studioId || event.studio_id || event.studio?.id || null,
        className,
        groupName,
        instructorName,
        studioName: event.studioName || event.studio?.name || 'Studio',
        locationName: event.locationName || event.studio?.location?.name || 'Location',
        startAt,
        existingUpgradeId: upgradeId,
        existingPrefs
      });
    });
  });

  // Cancel (two-tap confirm) — cancels every spot booked for the class.
  const cancelBtn = card.querySelector('.bk-cancel-btn');
  const bookedAt = group.bookings[0]?.bookedAt || group.bookings[0]?.booked_at;
  if (bookedAt && isInGracePeriod(bookedAt)) {
    cancelBtn.setAttribute('data-grace-deadline', new Date(bookedAt).getTime() + GRACE_PERIOD_MS);
    cancelBtn.classList.add('grace-cancel');
    startGraceCountdown();
  }
  wireCancelBooking(cancelBtn, card, group, within12h);

  return card;
}

// Two-tap confirm cancel for a whole class (all its booking records).
// During the 60s grace period (data-grace-deadline attribute present), the
// cancel fires immediately without confirmation.
// A NormalizedBooking exposes `bookingId` and `slotId`; the pre-D9 raw CodexFit
// shape used `id` and a family of slot fields. Both are read here so a stale
// client cache degrades rather than cancelling `undefined` — which is exactly
// what happened when only the read path was migrated (WP-D9).
const bookingIdOf = (b) => b?.bookingId ?? b?.id;
const slotIdOf = (b) => b?.slotId ?? b?.studio_slot?.id ?? b?.studio_slot_id ?? b?.slot_id ?? b?.slot;

function wireCancelBooking(btn, card, group, within12h) {
  if (!btn) return;
  const labelSpan = btn.querySelector('span');
  let confirmState = false;

  const performCancel = async () => {
    card.style.opacity = '0.6';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    labelSpan.textContent = '…';
    try {
      showToast('Cancelling booking...', 'info');
      for (const b of group.bookings) {
        await api.cancel(bookingIdOf(b), b.gymId || group.event?.gymId);
        const up = (cache.upgrades || []).find(u => String(u.booking_id) === String(bookingIdOf(b)) && ['active', 'paused_no_credits'].includes(u.status));
        if (up) { try { await api.deleteAutoUpgrade(up.id); } catch (_) {} }
      }
      await invalidateApiCache('/api/bookings');
      await invalidateApiCache('/api/waitlists');
      showToast('Booking cancelled.', 'success');
      await refreshUserData(true);
      renderBookings();
    } catch (err) {
      showToast(`Cancellation failed: ${err.message}`, 'error');
      card.style.opacity = '1';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      labelSpan.textContent = 'Cancel';
    }
  };

  btn.addEventListener('click', async () => {
    // 60s grace period: cancel immediately, no confirmation
    if (btn.hasAttribute('data-grace-deadline')) {
      btn.removeAttribute('data-grace-deadline');
      await performCancel();
      return;
    }
    if (!confirmState) {
      confirmState = true;
      labelSpan.textContent = within12h ? 'Penalty?' : 'Confirm?';
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
    await performCancel();
  });
}

// Edit-spots modal: a live seat picker pre-seeded with the user's current spots.
// CodexFit has no "move seat" call, so saving releases removed spots (refunding
// their credits and freeing the seats) and then books the added spots.
export async function openEditBookingModal(group, onChange = renderBookings) {
  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title) return;

  const event = group.event;
  const rawClassName = event.name || event.event_type?.name || 'Class';
  const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
  const className = stripClassNamePrefix(rawClassName, groupName);
  const noun = seatNoun(groupName);
  const nounCap = noun[0].toUpperCase() + noun.slice(1);

  title.textContent = `Edit ${nounCap}s: ${className}`;
  body.innerHTML = `<div class="psycle-loading-spinner-container" style="padding:40px 0;"><div class="psycle-spinner"></div><span>Loading studio floor map…</span></div>`;
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

  await refreshUserData(true);
  try {
    // WP-C5: this renderer now consumes NormalizedSlot[] / NormalizedLayoutObject[]
    // straight from the adapter — no raw `studio.layout` access anywhere below,
    // so a MarianaTek layout (a completely different raw shape) renders here
    // unchanged. `.id` arrives as a string and is coerced to Number for the
    // slot-id comparisons, matching how bookings/preferences store slot ids.
    const { event: normalizedEvent, slots: layoutSlots, objects: layoutObjects } =
      await api.getEventDetails(group.eventId, group.event?.gymId);
    const availableSlots = layoutSlots.filter(s => s.isAvailable).map(s => String(s.id));

    // Current booked slots → booking IDs (so removals can target the right record)
    const slotToBooking = new Map();
    group.bookings.forEach(b => {
      const sid = slotIdOf(b);
      if (sid != null && sid !== '') slotToBooking.set(String(sid), bookingIdOf(b));
    });
    const currentSlots = [...slotToBooking.keys()];

    // WP-C5: first-come-first-serve is now an explicit `layoutFormat` check
    // rather than being inferred from an empty slot list. Both cases end up
    // hiding the picker, but only FCFS means "this class genuinely has no
    // assigned spots" — an empty list on a pick-a-spot class means the studio's
    // floor map is missing, which is a different thing to tell the user.
    const isFcfs = normalizedEvent.layoutFormat === 'first-come-first-serve';
    if (isFcfs || layoutSlots.length === 0) {
      const why = isFcfs
        ? `This class doesn't use assigned ${noun}s, so there's nothing to change here.`
        : `No floor map is available for this studio, so ${noun}s can't be changed here.`;
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary);">${why} Use Cancel to release the booking.</div>`;
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    layoutSlots.forEach(s => { if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x; if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y; });
    const widthRange = maxX - minX || 1;
    const heightRange = maxY - minY || 1;
    const rowCount = new Set(layoutSlots.map(s => s.y)).size;
    const shortLabelsForPlan = shortSlotLabels(layoutSlots);
    const minMapHeight = Math.max(340, rowCount * 56);

    const selected = new Set(currentSlots);
    const labelFor = id => { const s = layoutSlots.find(ls => String(ls.id) === String(id)); return s?.label || String(id); };

    body.innerHTML = `
      <div style="font-size:12px;color:var(--text-secondary);background:var(--surface-inset);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        Tap to change your ${noun}s. <strong style="color:var(--feat-autoupgrade);">Highlighted</strong> ${noun}s are yours — deselect to release them, tap a free ${noun} to add it. Saving releases removed ${noun}s first, then books the added ones.
      </div>
      <div class="psycle-floor-plan-container" style="position:relative;height:${minMapHeight}px;background:var(--surface-inset);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;overflow:hidden;">
        <div id="psycle-edit-floor-grid" style="width:100%;height:100%;"></div>
      </div>
      <div id="psycle-edit-summary" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;min-height:16px;"></div>
      <div id="psycle-edit-controls"></div>
    `;

    const floorGrid = body.querySelector('#psycle-edit-floor-grid');
    const summaryEl = body.querySelector('#psycle-edit-summary');
    const controls = body.querySelector('#psycle-edit-controls');

    // Stage marker(s) — NormalizedLayoutObject[]; empty for providers with none.
    layoutObjects.forEach(obj => {
      const left = widthRange === 0 ? 50 : ((obj.x - minX) / widthRange) * 80 + 10;
      const top = heightRange === 0 ? 10 : ((obj.y - minY) / heightRange) * 75 + 10;
      const stage = document.createElement('div');
      stage.style.cssText = `position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);background:color-mix(in srgb,var(--text) 15%,transparent);border:1px solid color-mix(in srgb,var(--text) 30%,transparent);padding:4px 16px;border-radius:6px;font-size:12px;font-weight:bold;color:#fff;letter-spacing:0.5px;`;
      stage.textContent = 'STAGE';
      floorGrid.appendChild(stage);
    });

    const renderControls = () => {
      const desired = [...selected];
      const toRemove = currentSlots.filter(s => !selected.has(s));
      const toAdd = desired.filter(s => !currentSlots.includes(s));
      const changed = toRemove.length > 0 || toAdd.length > 0;
      // Removals refund credits before the additions are booked.
      const creditsAfterRefund = totalAvailableCredits(group.event?.gymId) + toRemove.length;
      const shortfall = Math.max(0, toAdd.length - creditsAfterRefund);

      let msg = '';
      if (!changed) {
        msg = `<div style="font-size:12px;color:var(--text-tertiary);">No changes yet.</div>`;
      } else if (desired.length === 0) {
        msg = `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;">This releases all your ${noun}s and cancels the booking.</div>`;
      } else if (shortfall > 0) {
        msg = `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;">You need ${shortfall} more credit${shortfall !== 1 ? 's' : ''} to add ${toAdd.length} ${noun}${toAdd.length !== 1 ? 's' : ''}.</div>`;
      }

      const parts = [];
      if (toAdd.length) parts.push(`<span style="color:var(--success);font-weight:700;">+${toAdd.map(labelFor).join(', ')}</span>`);
      if (toRemove.length) parts.push(`<span style="color:var(--danger);font-weight:700;">−${toRemove.map(labelFor).join(', ')}</span>`);
      summaryEl.innerHTML = parts.length
        ? `<span style="color:var(--text-tertiary);text-transform:uppercase;font-size:var(--text-xs);letter-spacing:0.05em;margin-right:6px;">Changes</span>${parts.join('&nbsp;&nbsp;')}`
        : `<span style="color:var(--text-tertiary);">${desired.length} ${noun}${desired.length !== 1 ? 's' : ''} selected</span>`;

      controls.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
          ${msg}
          <div style="display:flex;gap:8px;">
            <button class="psycle-btn" id="bk-edit-close" style="flex:1;background:color-mix(in srgb,var(--text) 6%,transparent);border:1px solid color-mix(in srgb,var(--text) 12%,transparent);color:var(--text);">Close</button>
            <button class="psycle-btn" id="bk-edit-save" style="flex:2;background:var(--feat-autoupgrade);color:var(--on-accent);" ${(!changed || shortfall > 0) ? 'disabled' : ''}>Save Changes</button>
          </div>
        </div>`;

      controls.querySelector('#bk-edit-close').onclick = closeModal;
      controls.querySelector('#bk-edit-save').onclick = () => saveChanges(toAdd, toRemove);
    };

    const renderGrid = () => {
      floorGrid.querySelectorAll('.bk-edit-slot').forEach(e => e.remove());
      layoutSlots.forEach(slot => {
        const slotId = String(slot.id);
        const isAvailable = availableSlots.includes(slotId);
        const isCurrent = currentSlots.includes(slotId);
        const isSelected = selected.has(slotId);
        const left = widthRange === 0 ? 50 : ((slot.x - minX) / widthRange) * 78 + 8;
        const top = heightRange === 0 ? 50 : ((slot.y - minY) / heightRange) * 72 + 14;

        const el = document.createElement('div');
        el.className = 'bk-edit-slot';
        el.style.cssText = `position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;line-height:1;white-space:nowrap;user-select:none;transition:all 0.1s;box-sizing:border-box;z-index:1;`;
        // "27", not "Bike 27" — the full label wrapped to two lines and spilled
        // out of a 28px square. Full label stays in the tooltip below.
        el.textContent = shortLabelsForPlan.get(String(slot.id)) || slot.label || slotId;
        const clickable = isSelected || isCurrent || isAvailable;
        el.style.cursor = clickable ? 'pointer' : 'default';
        el.title = `${nounCap} ${slot.label || slotId}`;

        if (isSelected) {
          el.style.background = 'var(--feat-autoupgrade)';
          el.style.border = '2px solid color-mix(in srgb,var(--feat-autoupgrade) 70%,#000)';
          el.style.color = '#fff';
        } else if (isCurrent) {
          // Your seat, deselected → pending release
          el.style.background = 'color-mix(in srgb,var(--danger) 15%,transparent)';
          el.style.border = '1px dashed var(--danger)';
          el.style.color = 'var(--danger)';
        } else if (isAvailable) {
          el.style.background = 'color-mix(in srgb,var(--success) 15%,transparent)';
          el.style.border = '1px solid color-mix(in srgb,var(--success) 35%,transparent)';
          el.style.color = 'var(--success)';
        } else {
          el.style.background = 'var(--surface-inset)';
          el.style.border = '1px solid var(--border)';
          el.style.color = 'var(--text-tertiary)';
        }

        if (clickable) el.addEventListener('click', () => {
          if (selected.has(slotId)) selected.delete(slotId);
          else if (isCurrent || isAvailable) selected.add(slotId);
          else { showToast(`That ${noun} is occupied.`, 'warning'); return; }
          renderGrid();
          renderControls();
        });

        floorGrid.appendChild(el);
      });
    };

    const saveChanges = async (toAdd, toRemove) => {
      const saveBtn = body.querySelector('#bk-edit-save');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
      try {
        const gymId = group.event?.gymId || null;
        // THIS booking's gym, not the ambient one. Judged against the wrong
        // gym's flag this either skips a native swap (falling back to
        // cancel-then-rebook, which can lose the spot to someone else in the
        // gap) or calls a swap endpoint the provider doesn't have.
        if (canForGym('atomicSwap', gymId) && toRemove.length === 1 && toAdd.length === 1) {
          const bookingId = slotToBooking.get(toRemove[0]);
          const r = await api.swapSpot(bookingId, toRemove[0], toAdd[0], gymId);
          if (!r.ok) throw new Error(r.error || 'Spot swap was declined');
        } else {
          // 1. Release removed spots.
          for (const slotId of toRemove) {
            const bookingId = slotToBooking.get(slotId);
            if (bookingId) await api.cancel(bookingId, gymId);
            const up = (cache.upgrades || []).find(u => String(u.booking_id) === String(bookingId) && ['active', 'paused_no_credits'].includes(u.status));
            if (up) { try { await api.deleteAutoUpgrade(up.id); } catch (_) {} }
          }
          // 2. Book added spots.
          if (toAdd.length) {
            const added = [];
            for (const slotId of toAdd) {
              const r = await api.book(group.eventId, [slotId], gymId);
              if (!r.ok) {
                throw new Error(added.length
                  ? `Re-booked ${added.length} of ${toAdd.length} spots — ${r.error || 'the rest were declined'}`
                  : (r.error || 'Re-booking was declined'));
              }
              added.push(r);
            }
          }
        }
        if (toAdd.length) {
          api.notifyBookingSuccess({
            source: 'manual', eventId: group.eventId, className,
            groupName,
            instructorName: event.instructors?.[0]?.name || event.instructor?.full_name || '',
            startAt: event.startAt || event.start_at, slots: toAdd.map(labelFor),
          }).catch(() => {});
        }
        await invalidateApiCache('/api/bookings');
        await invalidateApiCache('/api/waitlists');
        showToast(`${nounCap}s updated.`, 'success');
        closeModal();
        await refreshUserData(true);
        onChange();
      } catch (err) {
        showToast(`Couldn't update ${noun}s: ${err.message}`, 'error');
        closeModal();
        await refreshUserData(true);
        onChange();
      }
    };

    renderGrid();
    renderControls();
  } catch (err) {
    console.error('[Bookings] Edit modal failed:', err);
    body.innerHTML = `<div class="psycle-card-error" style="color:var(--danger);padding:20px 0;text-align:center;">Error loading layout: ${err.message}</div>`;
  }
}

// ── Waitlist cards ───────────────────────────────────────────────────
// Same card design as bookings; a waitlist entry has no spot and no upgrade,
// so the only rail action is Leave (two-tap confirm).
function renderWaitlistsCards(waitlists) {
  const container = document.getElementById('psycle-waitlists-list');
  if (!container) return;

  const valid = (waitlists || []).filter(w => w.event && (w.event.startAt || w.event.start_at));
  if (valid.length === 0) {
    container.innerHTML = '<div class="fav-empty-state" style="padding:30px 0;">No active waitlists found.</div>';
    return;
  }

  valid.sort((a, b) => new Date(a.event.startAt || a.event.start_at) - new Date(b.event.startAt || b.event.start_at));
  container.innerHTML = '';
  valid.forEach(w => container.appendChild(buildWaitlistCard(w)));
  equalizeDiscTagWidths(container);
}

function buildWaitlistCard(w) {
  const event = w.event;
  const startAt = event.startAt || event.start_at;
  const startDt = new Date(startAt);
  const dateStr = startDt.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const timeOnly = startDt.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' });
  const rawClassName = event.name || event.event_type?.name || 'Class';
  const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
  const className = stripClassNamePrefix(rawClassName, groupName);
  const instructorName = event.instructors?.[0]?.name || event.instructor?.full_name || '';
  const instructorPhotoUrl = event.instructors?.[0]?.thumbUrl || event.instructors?.[0]?.imageUrl || null;
  const locationLine = [event.studioName || event.studio?.name, trimLocation(event.locationName || event.studio?.location?.name, getGymShortName(event.gymId))].filter(Boolean).join(', ');

  const card = document.createElement('div');
  card.className = 'psycle-autobook-card ab-card';
  card.setAttribute('data-event-id', event.id);
  card.setAttribute('data-gym', event.gymId || 'psycle-london');
  card.innerHTML = `
    ${renderGymRail(event.gymId || 'psycle-london')}
    <div class="ab-card-main">
      ${/* TWO lines of class information, not four.
           Line 1 — WHEN, plus who's teaching: the two facts you scan a booking
                    list for.
           Line 2 — WHAT: discipline, class name, where.
           The photo is a figure on the right of both lines, so it never sits
           inside a text line box (which is what made a 52px avatar hang below
           the row it belonged to). */ ''}
      <div class="ab-card-body">
        <div class="ab-card-lines">
          <div class="ab-card-line1">
            <span class="ab-card-date">${dateStr.toUpperCase()}</span>
            <span class="ab-card-time">${timeOnly}</span>
            ${instructorName ? `<span class="ab-card-instructor">${instructorName}</span>` : ''}
          </div>
          <div class="ab-card-line2">
            ${disciplineTag(groupName)}
            <span class="ab-card-class">${className}</span>
            ${locationLine ? `<span class="ab-meta-dot">·</span><span class="ab-card-location">${locationLine}</span>` : ''}
          </div>
        </div>
        ${instructorAvatar(instructorName, event.gymId, instructorPhotoUrl)
          ? `<div class="ab-card-figure">${instructorAvatar(instructorName, event.gymId, instructorPhotoUrl)}</div>` : ''}
      </div>
      <div class="ab-card-footer">
        <span class="ab-spots-pill" style="gap:5px;color:var(--warning);background:color-mix(in srgb,var(--warning) 12%,transparent);">${icon('clock', 12)} Waitlisted</span>
      </div>
    </div>
    <div class="ab-card-rail">
      <button class="ab-rail-btn danger leave-wl-btn" aria-label="Leave waitlist">${icon('close', 17)}<span>Leave</span></button>
    </div>
  `;

  const leaveBtn = card.querySelector('.leave-wl-btn');
  const labelSpan = leaveBtn.querySelector('span');
  let confirmState = false;
  leaveBtn.addEventListener('click', async () => {
    if (!confirmState) {
      confirmState = true;
      labelSpan.textContent = 'Confirm?';
      leaveBtn.classList.add('confirming');
      setTimeout(() => {
        confirmState = false;
        labelSpan.textContent = 'Leave';
        leaveBtn.classList.remove('confirming');
      }, 3000);
      return;
    }
    confirmState = false;
    leaveBtn.classList.remove('confirming');
    card.style.opacity = '0.6';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    labelSpan.textContent = '…';
    try {
      showToast('Leaving waitlist...', 'info');
      await api.leaveWaitlist(event.id, event.gymId);
      showToast('Left waitlist.', 'success');
      await refreshUserData(true);
      renderBookings();
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      card.style.opacity = '1';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      labelSpan.textContent = 'Leave';
    }
  });

  return card;
}

// Auto-upgrade needs at least one spare credit to book the upgraded seat before
// releasing the old one. Returns 1 if the user has none spare, else 0.
function upgradeCreditShortfall(gymId) {
  return getTotalCredits(gymId) < 1 ? 1 : 0;
}

// Quick-register or open modal, like the auto-book flow
async function handleUpgradeClick({ eventId, gymId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs }) {
  if (!eventId || !bookingId || currentSlotId === '' || currentSlotId == null || isNaN(Number(currentSlotId))) {
    showToast('Could not determine your current spot. Open the booking details to find your slot.', 'error');
    return;
  }

  // If editing an existing monitor, always open the config modal
  if (existingUpgradeId !== null) {
    openUpgradeConfigModal({ eventId, gymId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs });
    return;
  }

  // Check if studio preferences are already configured
  try {
    const allPrefs = await api.getStudioPreferences();
    // Gym-qualified: studio ids are PROVIDER ids, so prefs are stored under
    // `${gymId}:${studioId}`. A bare lookup misses the saved map entirely,
    // which is why auto-upgrade opened the config modal for a studio that
    // demonstrably had one configured.
    const studioPrefs = pickStudioPrefs(allPrefs, studioId, gymId);
    const hasPrefs = studioPrefs?.preferredSlots?.length > 0;

    if (hasPrefs) {
      // Quick-register: the monitor reads the live shared studio map, so we only
      // store the per-monitor option here.
      showToast('Starting upgrade monitor...', 'info');
      await api.addAutoUpgrade({
        eventId,
        // Without this the server falls back to the account's ACTIVE gym, so a
        // JAB monitor is stored against Psycle and the poller then works the
        // wrong provider's session — the monitor silently never fires.
        gymId: gymId || null,
        studioId: studioId || null,
        bookingId,
        currentSlotId,
        className,
        groupName,
        instructorName,
        studioName,
        locationName,
        startAt,
        creditShortfall: upgradeCreditShortfall(gymId),
        preferences: {
          keepOriginalOnCutoff: true
        }
      });
      showToast('Auto-upgrade monitor started using your saved spot map for this studio.', 'success');
      renderBookings();
    } else {
      // No prefs — open modal to configure
      openUpgradeConfigModal({ eventId, gymId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId: null, existingPrefs: null });
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Auto-Upgrade configuration modal (floor plan + options)
export async function openUpgradeConfigModal({ eventId, gymId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs }) {
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
    // WP-C5: the floor plan below is driven entirely by NormalizedSlot[] /
    // NormalizedLayoutObject[] from the adapter — no raw `studio.layout` access
    // — so a MarianaTek layout renders here unchanged.
    const [{ event, slots: layoutSlots, objects: layoutObjects }, allPrefs] = await Promise.all([
      api.getEventDetails(eventId, gymId),
      api.getStudioPreferences()
    ]);
    const groupName = event.discipline || event.name || 'Class';
    const noun = seatNoun(groupName);
    const nounCap = noun[0].toUpperCase() + noun.slice(1);
    const resolvedStudioId = studioId || event.studioId;
    const studioPrefs = pickStudioPrefs(allPrefs, resolvedStudioId, gymId);

    // Explicit FCFS check rather than inferring it from an empty slot list —
    // the two mean different things (see openEditBookingModal's equivalent).
    const isFcfs = event.layoutFormat === 'first-come-first-serve';
    if (isFcfs || layoutSlots.length === 0) {
      const why = isFcfs
        ? `This class doesn't use assigned ${noun}s, so there's nothing to upgrade to.`
        : 'No floor map available for this studio. Auto-upgrade requires a spot map.';
      body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-secondary);">${why}</div>`;
      return;
    }

    // Auto-upgrade reads the LIVE shared studio map, so the editor edits that map
    // directly. Seed from the shared map (or the existing monitor as a fallback).
    const seedSlots = (studioPrefs?.preferredSlots || existingPrefs?.preferredSlots || []).map(Number);
    const seedRows = studioPrefs?.preferredRows || [];
    const seedKeepOriginal = existingPrefs?.keepOriginalOnCutoff ?? (gymSetting(gymId, 'autoUpgradeKeepOriginalByDefault') ?? false);

    const currentSlotLabel = layoutSlots.find(s => Number(s.id) === currentSlotId)?.label || String(currentSlotId);

    // Credit checking for auto-upgrade (needs +1 credit for the upgrade spot).
    // A membership gym's credit math is Infinity (correctly — nothing to
    // charge), so it needs its own eligibility gate (WP-J) rather than relying
    // on this arithmetic, which can't see membership status.
    const ineligibleReason = getIneligibleReason(gymId);
    // The NORMALIZED event, never `.raw`: the raw provider object carries no
    // `gymId` (so the credit inventory silently resolved to the active gym) and
    // no normalized `credits`, which is where per-class cost now lives.
    const availableCredits = getAvailableCreditsForEvent(event);
    const upgradeCreditsNeeded = 1; // Auto-upgrade needs 1 credit for the additional spot
    const hasEnoughCredits = !ineligibleReason && availableCredits >= upgradeCreditsNeeded;
    const creditWarningHtml = !hasEnoughCredits
      ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;line-height:1.5;">${ineligibleReason || `In order for Auto-Upgrade to work, you need to purchase ${upgradeCreditsNeeded - availableCredits} more credit${upgradeCreditsNeeded - availableCredits !== 1 ? 's' : ''}. Auto-Upgrade books an additional ${noun} before cancelling your current one.`}</div>`
      : '';

    body.innerHTML = `<div id="psycle-upgrade-editor"></div>`;
    const editorContainer = body.querySelector('#psycle-upgrade-editor');

    const bannerHtml = `
      <div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        This is the one shared preferred spot map for <strong>${studioName}</strong>. Auto-Upgrade aims for these ${noun}s in priority order — and Quick-Book &amp; Auto-Book here use the same map. Your current ${noun} is <strong>${currentSlotLabel}</strong>.
      </div>${creditWarningHtml}`;

    const extraControlsHtml = `
      <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;cursor:pointer;line-height:1.4;background:var(--surface-inset);border:1px solid var(--border);border-radius:10px;padding:12px;">
        <input type="checkbox" class="psycle-ms-checkbox" id="upgrade-keep-original" ${seedKeepOriginal ? 'checked' : ''} style="margin-top:2px;">
        <span>
          <strong>Continue past 12h cutoff</strong><br>
          <span style="font-size:12px;color:var(--text-tertiary);">Within 12h of class, make one final upgrade attempt without cancelling your original ${noun} — you'll need to ask the gym to release it. Without this, monitoring stops at 12h.</span>
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
        showToast(`Select at least one preferred ${noun} for the upgrade to aim at.`, 'warning');
        return;
      }

      const keepOriginalOnCutoff = container.querySelector('#upgrade-keep-original')?.checked ?? true;

      try {
        // 1. Save the shared studio map (this is what every feature reads live)
        if (resolvedStudioId) {
          // Studio ids are PROVIDER ids — unique only within a gym — so a map
          // saved without one lands on whichever gym the server resolves.
          await api.updateStudioPreferences(resolvedStudioId, { preferredSlots: slots, preferredRows: rows }, gymId);
        }

        // 2. Create or update the monitor (per-monitor option only; slots are live)
        if (isEditing) {
          await api.updateAutoUpgrade(existingUpgradeId, { keepOriginalOnCutoff });
          showToast('Auto-upgrade updated — shared spot map saved.', 'success');
        } else {
          await api.addAutoUpgrade({
            eventId, gymId: gymId || null, studioId: resolvedStudioId || null, bookingId, currentSlotId,
            className, groupName, instructorName, studioName, locationName, startAt,
            creditShortfall: upgradeCreditShortfall(gymId),
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
      layoutObjects,
      bannerHtml,
      extraControlsHtml,
      onDisable,
      disableLabel: 'Disable Auto-Upgrade',
      availableSlots: layoutSlots.filter(s => s.isAvailable).map(s => Number(s.id)),
      currentSlotId
    });

  } catch (err) {
    console.error('[Bookings] Modal load layout failed:', err);
    body.innerHTML = `<div class="psycle-card-error">Error loading spot layout: ${err.message}</div>`;
  }
}

// Re-render bookings when background SWR fetch updates IndexedDB cache.
window.addEventListener('psycle-data-refreshed', (e) => {
  const { endpoint } = e.detail;
  if (
    endpoint.startsWith('/api/bookings') || 
    endpoint.startsWith('/api/waitlists') || 
    endpoint.startsWith('/api/auto-upgrade')
  ) {
    const bookingsPanel = document.getElementById('psycle-panel-my-bookings');
    if (bookingsPanel && bookingsPanel.style.display !== 'none') {
      renderBookings().catch(() => {});
    }
  }
});
