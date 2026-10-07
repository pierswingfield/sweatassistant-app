import { api } from '../api';
import { canForGym, getGymShortName, getDefaultGymId, formatSpotLabel } from '../gym-context.js';
import { getAvailableCreditsForEvent, getTotalCredits, getIneligibleReason } from './credit-allowance.js';
import { showToast, cache, refreshUserData, updateCreditBadge, userSettings, gymSetting } from '../main';
import { renderStudioFloorPlan } from './spotmap';
import { instructorInlineHtml, icon, disciplineTag, trimLocation, seatNoun, stripClassNamePrefix, trendingUpIcon, pulseIcon, renderGymRail, equalizeDiscTagWidths, observeLocationWrap, wireRailToggle, shortSlotLabels, escapeHtml} from './cards';
import { isInGracePeriod, GRACE_PERIOD_MS, startGraceCountdown, noSept, zoneFor, formatInZone } from '../lib';
import { invalidateApiCache } from '../cache';
import { renderCardSkeletons } from './loading-skeleton.js';
import { instructorAvatar } from './tooltips.js';
import { metadata, loadMetadata, getStudioMapInfo, pickStudioPrefs, rowGroupsForStudio, openGuestBookingModal } from './timetable';
import { findActiveUpgradeForBooking, findUpgradeForSeat } from './gym-isolation.js';
import { haptic } from './haptics.js';
import { COPY, formatCopyText } from '../copy.js';
import { openPage as openNavPage, closePage as closeNavPage } from './modal-nav.js';
import { applyBookingChrome, bookingContextEl, mountBookingContext } from './booking-chrome.js';
import {
  applyGroupedCancellationResult,
  createGroupedCancellationState,
  GUEST_ACTION_LABEL,
  hasMultipleBookedSpots,
  isIndividualCancellationBlocked,
  requestGroupedCancellation,
} from './grouped-cancellation.js';
import { isExplainerDismissed, dismissExplainer, isKeepOriginalEnabled, keepOriginalForAutoCreate, keepOriginalInitial, summarizeSpotPrefs, currentSpotLabel } from './autoupgrade-setup.js';
import { canSelectSelfSpot, countSelfBookingSlots, isCurrentModalRun } from './booking-entitlement.js';
import { groupBookingsByEvent } from './upcoming.js';

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


// True once real data exists. cache.bookings starts as [] in main.js, so
// "defined" is meaningless: an untouched [] must not read as "loaded empty".
let bookingsFetched = false;
let editModalRunId = 0;
function bookingsDataReady() {
  return bookingsFetched || (Array.isArray(cache.bookings) && cache.bookings.length > 0);
}

export async function renderBookings() {
  const bookingsList = document.getElementById('psycle-bookings-list');
  const waitlistsList = document.getElementById('psycle-waitlists-list');

  // Show refreshing indicators
  const bookingsRefreshing = document.getElementById('psycle-bookings-refreshing');
  const waitlistsRefreshing = document.getElementById('psycle-waitlists-refreshing');
  if (bookingsRefreshing) bookingsRefreshing.style.display = '';
  if (waitlistsRefreshing) waitlistsRefreshing.style.display = '';

  // Show cached data immediately if available (cache.upgrades is set after first load)
  const hasLoadedBefore = bookingsDataReady();
  if (hasLoadedBefore) {
    renderBookingsCards(cache.bookings || [], cache.upgrades || []);
    renderWaitlistsCards(cache.waitlists || []);
  } else {
    // First visit — no cached data yet
    if (bookingsList) bookingsList.innerHTML = renderCardSkeletons(2, COPY.bookings.loadingBookings);
    if (waitlistsList) waitlistsList.innerHTML = renderCardSkeletons(1, COPY.bookings.loadingWaitlists);
  }

  // instructorAvatar() reads metadata.instructors, which is otherwise only
  // populated by the Timetable tab's prefetch — landing straight on My
  // Bookings (a reload, or the app's initial tab) left it empty for the whole
  // session until the user visited Timetable and back, so every photo was
  // missing until then. Fetch it here too and repaint once it lands.
  if (!metadata.instructors.length) {
    loadMetadata().then(() => {
      // Only repaint once real data exists: repainting from `|| []` before the
      // first fetch resolves flashed "No active bookings found" over the skeleton.
      if (!bookingsDataReady()) return;
      renderBookingsCards(cache.bookings, cache.upgrades || []);
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
    bookingsFetched = true;

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
    if (bookingsList && !bookingsDataReady()) {
      bookingsList.innerHTML = `<div class="psycle-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">${COPY.bookings.noCachedData}</p><p style="font-size:13px;color:var(--text-tertiary)">${COPY.bookings.connectInternetBookings}</p></div>`;
    } else if (bookingsList) {
      bookingsList.innerHTML = `<div class="psycle-card-error">${formatCopyText(COPY.bookings.noCachedError, { error: escapeHtml(err.message) })}</div>`;
    }
    if (waitlistsList && !bookingsDataReady()) {
      waitlistsList.innerHTML = `<div class="psycle-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">${COPY.bookings.noCachedData}</p><p style="font-size:13px;color:var(--text-tertiary)">${COPY.bookings.connectInternetWaitlists}</p></div>`;
    } else if (waitlistsList) {
      waitlistsList.innerHTML = `<div class="psycle-card-error">${formatCopyText(COPY.bookings.noCachedError, { error: escapeHtml(err.message) })}</div>`;
    }

    if (bookingsRefreshing) bookingsRefreshing.style.display = 'none';
    if (waitlistsRefreshing) waitlistsRefreshing.style.display = 'none';
  }
}

// Push the user's upcoming bookings to the server so cancellation reminders can
// fire locally without the server re-polling CodexFit.
export function syncBookingCache(bookings) {
  try {
    const now = Date.now();
    const normalized = (bookings || []).map(b => {
      const event = b.event || {};
      const startAt = event.startAt || event.start_at || b.start_at;
      if (!startAt || new Date(startAt).getTime() < now) return null;
      const rawClassName = event.name || event.event_type?.name || COPY.autoBook.class;
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
        slotLabel: formatSpotLabel(event.gymId || b.gymId, {
          label: b.slotLabel ?? b.raw?.spot?.name ?? b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? b.slotId ?? '',
          section: b.spotSection,
        }),
      };
    }).filter(Boolean);
    api.syncBookings(normalized).catch(() => {});
  } catch (_) { /* best-effort */ }
}

// ── My Bookings cards ────────────────────────────────────────────────
// One card per class: a class booked with multiple spots stores one booking
// record per spot, so we group those records into a single card.
// ── Waitlist discoverability ─────────────────────────────────────────
// Header counts ("Active Bookings (12)") + a sticky "Waitlists (N) ↓" bar
// shown only while the waitlist section is off-screen.
let bookedCount = 0;
let waitlistCount = 0;
let waitlistObserver = null;
// Animated show/hide: the bar stays in the DOM; CSS animates transform/opacity
// off `.is-visible`. `inert` + aria-hidden keep it unfocusable while hidden.
function setJumpVisible(jump, visible) {
  jump.classList.toggle('is-visible', visible);
  jump.toggleAttribute('inert', !visible);
  jump.setAttribute('aria-hidden', String(!visible));
}
function updateWaitlistAffordances() {
  const jump = document.getElementById('psycle-waitlist-jump');
  const target = document.getElementById('psycle-waitlists-header');
  if (waitlistObserver) { waitlistObserver.disconnect(); waitlistObserver = null; }
  [['psycle-bookings-count', bookedCount], ['psycle-waitlists-count', waitlistCount]].forEach(([id, n]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = n === 0;
    el.textContent = `(${n})`;
  });
  if (!jump) return;
  setJumpVisible(jump, false);
  if (waitlistCount === 0 || !target) return;
  jump.textContent = formatCopyText(COPY.bookings.waitlistJump, { count: waitlistCount });
  jump.onclick = () => {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Scroll ONLY the nearest real scroll container. scrollIntoView() also
    // scrolls every overflow:hidden ancestor (the app shell), which strands the
    // page offset with no scrollbar to undo it, so the top became unreachable.
    let sc = target.parentElement;
    while (sc && sc !== document.body) {
      const oy = getComputedStyle(sc).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && sc.scrollHeight > sc.clientHeight) break;
      sc = sc.parentElement;
    }
    const behavior = reduce ? 'auto' : 'smooth';
    if (!sc || sc === document.body) {
      const y = target.getBoundingClientRect().top + window.scrollY - 12;
      window.scrollTo({ top: Math.max(0, y), behavior });
    } else {
      const y = target.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12;
      sc.scrollTo({ top: Math.max(0, y), behavior });
    }
  };
  if (typeof IntersectionObserver === 'undefined') return;
  waitlistObserver = new IntersectionObserver(entries => {
    const e = entries[entries.length - 1];
    // The bar is fixed on mobile, so also hide it when this tab isn't rendered.
    const panelShown = target.getClientRects().length > 0;
    setJumpVisible(jump, !e.isIntersecting && panelShown);
  });
  waitlistObserver.observe(target);
}

function renderBookingsCards(bookings, upgrades) {
  const container = document.getElementById('psycle-bookings-list');
  if (!container) return;

  const groups = groupBookingsByEvent(bookings);

  bookedCount = groups.length;
  if (groups.length === 0) {
    container.innerHTML = `<div class="fav-empty-state" style="padding:30px 0;">${COPY.bookings.noBookings}</div>`;
    updateWaitlistAffordances();
    return;
  }

  container.innerHTML = '';
  groups.forEach(group => container.appendChild(buildBookingCard(group, upgrades)));
  equalizeDiscTagWidths(container);
  observeLocationWrap(container);
  wireRailToggle(container);
  updateWaitlistAffordances();
}

/**
 * H-4: the Home widget reuses the Bookings card. Mounts one group's card into
 * `container` and runs the same post-render wiring renderBookingsCards does.
 */
export function mountBookingCard(container, group, upgrades = []) {
  container.appendChild(buildBookingCard(group, upgrades));
  equalizeDiscTagWidths(container);
  observeLocationWrap(container);
  wireRailToggle(container);
}

function buildBookingCard(group, upgrades) {
  const event = group.event;
  const startAt = event.startAt || event.start_at;
  const fmt = formatInZone(startAt, zoneFor(event, group.gymId || group.gym_id));
  const dateStr = noSept(fmt.date);
  const timeOnly = fmt.timeLabel;

  const rawClassName = event.name || event.event_type?.name || COPY.autoBook.class;
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
      return `<span class="ab-spot-open-floor${b.isGuest ? ' is-guest' : ''}" title="${COPY.bookings.openFloorTitle}">${b.isGuest ? `<small>${COPY.bookings.guestSpotChip}</small> ` : ''}${COPY.bookings.openFloor}</span>`;
    }

    const slotId = slotIdOf(b);
    const slotLabel = formatSpotLabel(event.gymId || b.gymId, {
      label: b.slotLabel ?? b.raw?.spot?.name ?? b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? slotId ?? '?',
      section: b.spotSection,
    });

    // Find active upgrade for this specific booking
    const activeUpgrade = findUpgradeForSeat(upgrades, {
      bookingId: bookingIdOf(b), gymId: event.gymId || b.gymId, eventId: group.eventId, slotId,
    });

    let chipClass = 'ab-spot-upgrade-chip';
    let iconHtml = '';

    if (activeUpgrade && activeUpgrade.status === 'stopped') {
      // Ended (e.g. already in the best spot / window closed): visible, muted, tappable.
      chipClass += ' state-stopped';
      iconHtml = '<span style="margin-right:4px;" aria-hidden="true">&#9208;</span>';
    } else if (activeUpgrade) {
      if (activeUpgrade.status === 'paused_no_credits' || activeUpgrade.status === 'paused_disabled' || totalAvailableCredits(event.gymId) < 1) {
        chipClass += ' state-warning';
        iconHtml = '<span style="margin-right:4px;">⚠</span>';
      } else {
        chipClass += ' state-active';
        iconHtml = pulseIcon(12) + '&nbsp;';
      }
    }

    const noun = seatNoun(groupName);
    const nounCap = noun.charAt(0).toUpperCase() + noun.slice(1);

    // Guest reservations must not open Auto-Upgrade: they are a separate
    // attendee/pass lifecycle. Keep the same compact chip language, but make
    // the ownership explicit and secondary to the readable spot label.
    if (b.isGuest) {
      return `<span class="ab-spot-upgrade-chip is-guest" data-booking-id="${bookingIdOf(b)}" data-slot-id="${slotId}" title="${COPY.bookings.guestMapGuest}">
                <small class="ab-spot-owner">${COPY.bookings.guestSpotChip}</small><span>${nounCap} ${escapeHtml(slotLabel)}</span>
              </span>`;
    }

    return `<button class="${chipClass}"
                    data-booking-id="${bookingIdOf(b)}"
                    data-slot-id="${slotId}"
                    data-slot-label="${escapeHtml(slotLabel)}"
                    data-upgrade-id="${activeUpgrade?.id || ''}"
                    title="${activeUpgrade ? COPY.bookings.autoUpgradeDisabledTitle : COPY.bookings.autoUpgradeEnabledTitle}">
              ${iconHtml}${nounCap} ${slotLabel}
            </button>`;
  }).join('');

  const editBtnHtml = (within12h || !hasMap) ? '' :
    `<button class="ab-rail-btn bk-edit-btn" aria-label="${COPY.bookings.editSpots}">${icon('edit', 17)}<span>${COPY.accessibility.editCard}</span></button>`;

  const card = document.createElement('div');
  card.className = 'psycle-autobook-card ab-card';
  card.setAttribute('data-event-id', group.eventId);
  card.setAttribute('data-gym', event.gymId || getDefaultGymId());
  card.innerHTML = `
    ${renderGymRail(event.gymId || getDefaultGymId())}
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
          </div>
          <div class="ab-card-line2">
            <span class="ab-card-titlegroup">${disciplineTag(groupName)}
            <span class="ab-card-class">${className}</span></span>
            ${instructorInlineHtml(instructorName)}
            ${locationLine ? `<span class="ab-meta-dot">·</span><span class="ab-card-location">${locationLine}</span>` : ''}
          </div>
        </div>
        ${(instructorAvatar(instructorName, event.gymId, instructorPhotoUrl) || instructorName)
          ? `<div class="ab-card-figure">${instructorAvatar(instructorName, event.gymId, instructorPhotoUrl) || ''}${instructorName ? `<span class="ab-card-instructor">${instructorName}</span>` : ''}</div>` : ''}
      </div>
      <div class="ab-card-footer" style="justify-content:flex-start;">
        <div class="ab-chip-group">${chipsHtml}</div>
      </div>
    </div>
    <div class="ab-card-rail">
      ${editBtnHtml}
      ${canForGym('guestBooking', event.gymId) ? `<button class="ab-rail-btn bk-guest-btn" aria-label="${GUEST_ACTION_LABEL}">${icon('plus', 17)}<span>${GUEST_ACTION_LABEL}</span></button>` : ''}
      <button class="ab-rail-btn danger bk-cancel-btn" aria-label="${COPY.bookings.cancelBookingLabel}">${icon('close', 17)}<span>${COPY.bookings.cancel}</span></button>
    </div>
  `;

  // Edit spots
  const editBtn = card.querySelector('.bk-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => openEditBookingModal(group));
  const guestBtn = card.querySelector('.bk-guest-btn');
  if (guestBtn) guestBtn.addEventListener('click', () => openGuestBookingModal({
    ...event,
    id: group.eventId,
    gymId: event.gymId || group.bookings[0]?.gymId,
  }));

  // Auto-upgrade click listeners for each spot chip
  card.querySelectorAll('button.ab-spot-upgrade-chip').forEach(btn => {
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
        currentSlotLabel: slotLabel,
        studioId: event.studioId || event.studio_id || event.studio?.id || null,
        className,
        groupName,
        instructorName,
        studioName: event.studioName || event.studio?.name || COPY.static.studioFallback,
        locationName: event.locationName || event.studio?.location?.name || COPY.static.locationFallback,
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
      showToast(COPY.bookings.cancelling, 'info');
      // One server command is authoritative for the whole booking group. It
      // cancels guests before the member reservation; looping here could send a
      // second cancel for an already-cascaded guest and falsely report failure.
      const primary = group.bookings.find((booking) => !booking.isGuest) || group.bookings[0];
      await api.cancel(bookingIdOf(primary), primary.gymId || group.event?.gymId);
      for (const b of group.bookings.filter((booking) => !booking.isGuest)) {
        const up = findUpgradeForSeat(cache.upgrades, { bookingId: bookingIdOf(b), gymId: b.gymId || group.event?.gymId, eventId: group.eventId, slotId: slotIdOf(b) });
        if (up) { try { await api.deleteAutoUpgrade(up.id); } catch (_) {} }
      }
      await invalidateApiCache('/api/bookings');
      await invalidateApiCache('/api/waitlists');
      haptic('warning');
      showToast(COPY.bookings.bookingCancelled, 'success');
      await refreshUserData(true);
      renderBookings();
    } catch (err) {
      haptic('error');
      showToast(formatCopyText(COPY.bookings.cancellationFailed, { error: err.message }), 'error');
      card.style.opacity = '1';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      labelSpan.textContent = COPY.bookings.cancel;
    }
  };

  btn.addEventListener('click', async () => {
    // Classes with multiple reservations need a chooser rather than the old
    // whole-class two-tap: a guest can be released without touching the member
    // spot, while the primary can never orphan a live guest.
    if (hasMultipleBookedSpots(group.bookings)) {
      openGroupedCancellationModal(group);
      return;
    }
    // 60s grace period: cancel immediately, no confirmation
    if (btn.hasAttribute('data-grace-deadline')) {
      btn.removeAttribute('data-grace-deadline');
      await performCancel();
      return;
    }
    if (!confirmState) {
      haptic('medium');
      confirmState = true;
      labelSpan.textContent = within12h ? COPY.bookings.penaltyQuestion : COPY.bookings.confirm;
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
    await performCancel();
  });
}

// A class can have a member reservation plus guest reservations.  The old
// cancellation control treated those as one opaque action, which made it
// impossible to release a guest quickly and made the primary/guest dependency
// unclear.  This chooser keeps every provider command explicit while relying
// on the server-side guest-first guard as the final safety net.
export function openGroupedCancellationModal(group, onChange = renderBookings) {
  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title || !hasMultipleBookedSpots(group?.bookings)) return;

  const event = group.event || {};
  const gymId = event.gymId || group.bookings[0]?.gymId || null;
  const rawClassName = event.name || event.event_type?.name || COPY.autoBook.class;
  const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
  const noun = seatNoun(groupName);
  let state = createGroupedCancellationState(group.bookings);
  let busy = false;
  let needsSync = false;
  let synced = false;

  title.textContent = `Cancel ${noun}s`;
  applyBookingChrome(modal, {
    titleText: `Cancel ${noun}s`, gymId,
    locationName: event.locationName || event.studio?.location?.name,
    studioName: event.studioName || event.studio?.name,
  });

  const syncAfterClose = async () => {
    if (!needsSync || synced) return;
    synced = true;
    await invalidateApiCache('/api/bookings');
    await invalidateApiCache('/api/waitlists');
    await refreshUserData(true);
    onChange();
  };

  openNavPage(modal, { id: 'cancel-booked-spots', onClose: syncAfterClose });
  const close = () => {
    if (closeNavPage(modal)) return;
    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    void syncAfterClose();
  };
  document.getElementById('psycle-booking-modal-close').onclick = close;
  modal.querySelector('.psycle-modal-overlay').onclick = close;

  const labelFor = (booking) => formatSpotLabel(gymId, {
    label: booking.slotLabel ?? booking.raw?.spot?.name ?? booking.studio_slot?.label
      ?? booking.slot ?? booking.studio_slot_id ?? booking.slot_id ?? slotIdOf(booking) ?? '?',
    section: booking.spotSection,
  });

  const render = () => {
    const confirmAll = state.confirmation?.all;
    const error = state.error
      ? `<div role="alert" style="font-size:13px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 25%,transparent);border-radius:10px;padding:10px 12px;">${escapeHtml(state.error)}</div>`
      : '';
    const rows = state.bookings.map((booking) => {
      const bookingId = bookingIdOf(booking);
      const isGuest = !!booking.isGuest;
      const blocked = isIndividualCancellationBlocked(state, bookingId);
      const confirming = !state.confirmation?.all && state.confirmation?.ids.length === 1
        && state.confirmation.ids[0] === String(bookingId);
      const role = isGuest ? COPY.bookings.guestSpotChip : COPY.bookings.selfSpotChip;
      const action = confirming ? COPY.bookings.confirm : COPY.bookings.cancel;
      const disabled = busy || blocked;
      return `<div class="psycle-cancel-spot-row" style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border);">
        <div style="min-width:0;flex:1;display:flex;flex-direction:column;gap:2px;">
          <span style="display:flex;align-items:center;gap:8px;"><small style="font-size:12px;font-weight:600;color:var(--text-secondary);">${escapeHtml(role)}</small><span class="ab-spot-upgrade-chip${isGuest ? ' is-guest' : ''}" style="cursor:default;">${escapeHtml(labelFor(booking))}</span></span>
          ${blocked ? '<span style="font-size:12px;color:var(--text-secondary);">Cancel guest spots first</span>' : ''}
        </div>
        <button class="psycle-btn cancel-confirm grouped-cancel-one" data-booking-id="${escapeHtml(bookingId)}" ${disabled ? 'disabled' : ''} style="width:auto;flex:0 0 auto;min-width:88px;padding:10px 16px;">${action}</button>
      </div>`;
    }).join('');
    body.innerHTML = `
      <div class="psycle-grouped-cancellation" style="display:flex;flex-direction:column;gap:12px;">
        <p style="margin:0;font-size:13px;line-height:1.45;color:var(--text-secondary);">Choose a ${escapeHtml(noun)} to cancel, or cancel every booked ${escapeHtml(noun)}. Guest spots are released before your own booking.</p>
        <div>${rows}</div>
        ${error}
        <button class="psycle-btn cancel-confirm grouped-cancel-all" ${busy ? 'disabled' : ''} style="width:100%;">${confirmAll ? COPY.bookings.confirm : `Cancel all ${noun}s`}</button>
      </div>`;

    body.querySelectorAll('.grouped-cancel-one').forEach((button) => {
      button.onclick = () => {
        const bookingId = button.dataset.bookingId;
        if (state.confirmation?.ids.length === 1 && !state.confirmation.all && state.confirmation.ids[0] === bookingId) {
          void performCancellation([bookingId]);
        } else {
          state = requestGroupedCancellation(state, bookingId);
          haptic('medium');
          render();
        }
      };
    });
    body.querySelector('.grouped-cancel-all').onclick = () => {
      if (state.confirmation?.all) {
        void performCancellation(state.confirmation.ids);
      } else {
        state = requestGroupedCancellation(state);
        haptic('medium');
        render();
      }
    };
  };

  const performCancellation = async (ids) => {
    busy = true;
    render();
    const cancelledIds = [];
    try {
      for (const bookingId of ids) {
        // A prior successful provider cancellation may already have removed a
        // later id from local state (for example, a stale guest edge repaired
        // by the server), so do not issue a duplicate command.
        const booking = state.bookings.find((candidate) => String(bookingIdOf(candidate)) === String(bookingId));
        if (!booking) continue;
        const result = await api.cancel(bookingId, booking.gymId || gymId);
        const actualIds = result?.cancelledIds?.length ? result.cancelledIds.map(String) : [String(bookingId)];
        cancelledIds.push(...actualIds);
      }
      needsSync = needsSync || cancelledIds.length > 0;
      state = applyGroupedCancellationResult(state, { cancelledIds });
      haptic('success');
      showToast(COPY.bookings.bookingCancelled, 'success');
      if (state.shouldClose) {
        close();
        return;
      }
    } catch (err) {
      needsSync = needsSync || cancelledIds.length > 0;
      state = applyGroupedCancellationResult(state, { cancelledIds, error: err.message });
      haptic('error');
      showToast(formatCopyText(COPY.bookings.cancellationFailed, { error: err.message }), 'error');
    } finally {
      busy = false;
      if (!state.shouldClose) render();
    }
  };

  render();
}

// Edit-spots modal: a live seat picker pre-seeded with the user's current spots.
// CodexFit has no "move seat" call, so saving releases removed spots (refunding
// their credits and freeing the seats) and then books the added spots.
export async function openEditBookingModal(group, onChange = renderBookings) {
  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title) return;
  const modalRunId = ++editModalRunId;
  const isCurrentRun = () => isCurrentModalRun(modalRunId, editModalRunId, modal.classList.contains('show'));

  const event = group.event;
  const rawClassName = event.name || event.event_type?.name || COPY.autoBook.class;
  const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
  const className = stripClassNamePrefix(rawClassName, groupName);
  const noun = seatNoun(groupName);
  const nounCap = noun[0].toUpperCase() + noun.slice(1);

  title.textContent = formatCopyText(COPY.bookings.editSpotsTitle, { noun: nounCap, className });
  applyBookingChrome(modal, { titleText: COPY.bookingFlow.titleEditSpots, gymId: event.gymId, locationName: event.locationName, studioName: event.studioName });
  body.innerHTML = `<div class="psycle-loading-spinner-container" style="padding:40px 0;"><div class="psycle-spinner"></div><span>${COPY.bookings.loadingFloorMap}</span></div>`;
  let editDirty = () => false; // set once the selection exists
  openNavPage(modal, { id: 'edit-spots', canClose: () => !editDirty() || confirm(COPY.bookingEditor.discardChanges) });

  const closeBtn = document.getElementById('psycle-booking-modal-close');
  const overlay = modal.querySelector('.psycle-modal-overlay');
  const closeModal = () => {
    if (closeNavPage(modal)) return;
    if (modalRunId === editModalRunId) editModalRunId++;
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
    if (!isCurrentRun()) return;
    let bookingEntitlement = null;
    let entitlementUnavailable = false;
    if (canForGym('bookingEntitlement', group.event?.gymId)) {
      try { bookingEntitlement = await api.getBookingEntitlement(group.eventId, group.event?.gymId); }
      catch (_) { entitlementUnavailable = true; }
      if (!isCurrentRun()) return;
    }
    const availableSlots = layoutSlots.filter(s => s.isAvailable).map(s => String(s.id));

    // Current booked slots → booking IDs (so removals can target the right record).
    // Guest reservations are visible on this live map but deliberately excluded
    // from self-seat swap/rebook arithmetic. They can be released explicitly;
    // releasing the primary is always server-cascaded guest-first.
    const slotToBooking = new Map();
    const guestSlotToBooking = new Map();
    group.bookings.forEach(b => {
      const sid = slotIdOf(b);
      if (sid == null || sid === '') return;
      (b.isGuest ? guestSlotToBooking : slotToBooking).set(String(sid), bookingIdOf(b));
    });
    const currentSlots = [...slotToBooking.keys()];
    const guestSlots = [...guestSlotToBooking.keys()];
    const rawSelfBookingLimit = bookingEntitlement?.selfBookingLimit ?? normalizedEvent.maxBookableSlots;
    const selfBookingLimit = entitlementUnavailable
      ? countSelfBookingSlots(group.bookings)
      : (Number.isFinite(Number(rawSelfBookingLimit)) && Number(rawSelfBookingLimit) >= 0
        ? Math.floor(Number(rawSelfBookingLimit))
        : Infinity);

    // WP-C5: first-come-first-serve is now an explicit `layoutFormat` check
    // rather than being inferred from an empty slot list. Both cases end up
    // hiding the picker, but only FCFS means "this class genuinely has no
    // assigned spots" — an empty list on a pick-a-spot class means the studio's
    // floor map is missing, which is a different thing to tell the user.
    const isFcfs = normalizedEvent.layoutFormat === 'first-come-first-serve';
    if (isFcfs || layoutSlots.length === 0) {
      const why = isFcfs
        ? formatCopyText(COPY.bookingEditor.noAssignedSpots, { noun: escapeHtml(noun) })
        : formatCopyText(COPY.bookingEditor.noFloorMap, { noun: escapeHtml(noun) });
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary);">${formatCopyText(COPY.bookings.noSpotsBookingHelp, { reason: why })}</div>`;
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
    const guestsToCancel = new Set();
    editDirty = () => guestsToCancel.size > 0 || selected.size !== currentSlots.length || currentSlots.some((x) => !selected.has(x));
    const labelFor = id => { const s = layoutSlots.find(ls => String(ls.id) === String(id)); return s?.label || String(id); };

    body.innerHTML = `
      <div style="font-size:12px;color:var(--text-secondary);background:var(--surface-inset);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        ${formatCopyText(COPY.bookings.editSpotsInstructionHtml, { noun: escapeHtml(noun) })}
      </div>
      <div style="font-size:12px;color:var(--text-secondary);background:var(--surface-inset);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
        ${entitlementUnavailable
          ? COPY.bookingEditor.bookingLimitUnavailable
          : Number.isFinite(selfBookingLimit)
            ? formatCopyText(COPY.bookingEditor.selfBookingLimit, { count: selfBookingLimit, plural: selfBookingLimit === 1 ? '' : 's' })
            : ''}
      </div>
      <div class="guest-map-legend" aria-label="Spot map key">
        <span class="is-self">${COPY.bookings.guestMapSelf}</span><span class="is-guest">${COPY.bookings.guestMapGuest}</span><span class="is-available">${COPY.bookings.guestMapAvailable}</span><span class="is-unavailable">${COPY.bookings.guestMapUnavailable}</span>
      </div>
      <div class="psycle-floor-plan-container" style="position:relative;height:${minMapHeight}px;background:var(--surface-inset);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;overflow:hidden;">
        <div id="psycle-edit-floor-grid" style="width:100%;height:100%;"></div>
      </div>
      <div id="psycle-edit-summary" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;min-height:16px;"></div>
      <div id="psycle-edit-controls"></div>
    `;

    const floorGrid = body.querySelector('#psycle-edit-floor-grid');
    mountBookingContext(body, body.querySelector('.psycle-floor-plan-container'), {
      className, instructorName: event.instructors?.[0]?.name || '', instructorPhoto: event.instructors?.[0]?.thumbUrl || event.instructors?.[0]?.imageUrl,
      startAt: event.startAt, gymId: event.gymId, timeZone: event.timeZone,
      spotsLeft: layoutSlots.filter(s => s.isAvailable).length,
    }, { helperId: 'spotmap-live', helperText: COPY.bookingFlow.helperLive });
    const summaryEl = body.querySelector('#psycle-edit-summary');
    const controls = body.querySelector('#psycle-edit-controls');

    // Stage marker(s) — NormalizedLayoutObject[]; empty for providers with none.
    layoutObjects.forEach(obj => {
      const left = widthRange === 0 ? 50 : ((obj.x - minX) / widthRange) * 80 + 10;
      const top = heightRange === 0 ? 10 : ((obj.y - minY) / heightRange) * 75 + 10;
      const stage = document.createElement('div');
      stage.style.cssText = `position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);background:color-mix(in srgb,var(--text) 15%,transparent);border:1px solid color-mix(in srgb,var(--text) 30%,transparent);padding:4px 16px;border-radius:6px;font-size:12px;font-weight:bold;color:#fff;letter-spacing:0.5px;`;
      stage.textContent = COPY.timetable.stage;
      floorGrid.appendChild(stage);
    });

    const renderControls = () => {
      const desired = [...selected];
      const toRemove = currentSlots.filter(s => !selected.has(s));
      const toAdd = desired.filter(s => !currentSlots.includes(s));
      const changed = toRemove.length > 0 || toAdd.length > 0 || guestsToCancel.size > 0;
      // Removals refund credits before the additions are booked.
      const creditsAfterRefund = totalAvailableCredits(group.event?.gymId) + toRemove.length;
      const shortfall = Math.max(0, toAdd.length - creditsAfterRefund);

      let msg = '';
      if (!changed) {
        msg = `<div style="font-size:12px;color:var(--text-tertiary);">${COPY.bookings.noChanges}</div>`;
      } else if (desired.length === 0) {
        msg = `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;">${formatCopyText(COPY.bookingEditor.cancelBookingReleaseSpots, { noun: escapeHtml(noun) })}</div>`;
      } else if (desired.length > selfBookingLimit) {
        msg = `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;">${formatCopyText(COPY.bookingEditor.selfBookingLimitExceeded, { count: selfBookingLimit, plural: selfBookingLimit === 1 ? '' : 's' })}</div>`;
      } else if (shortfall > 0) {
        msg = `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;">${formatCopyText(COPY.bookingEditor.creditShortfall, { shortfall, creditPlural: shortfall !== 1 ? 's' : '', count: toAdd.length, noun: escapeHtml(noun), nounPlural: toAdd.length !== 1 ? 's' : '' })}</div>`;
      }

      const parts = [];
      if (toAdd.length) parts.push(`<span style="color:var(--success);font-weight:700;">+${toAdd.map(labelFor).join(', ')}</span>`);
      if (toRemove.length) parts.push(`<span style="color:var(--danger);font-weight:700;">−${toRemove.map(labelFor).join(', ')}</span>`);
      if (guestsToCancel.size) parts.push(`<span style="color:var(--info);font-weight:700;">− ${COPY.bookings.guestSpotChip} ${[...guestsToCancel].map(labelFor).join(', ')}</span>`);
      summaryEl.innerHTML = parts.length
        ? `<span style="color:var(--text-tertiary);text-transform:uppercase;font-size:var(--text-xs);letter-spacing:0.05em;margin-right:6px;">${COPY.bookings.changes}</span>${parts.join('&nbsp;&nbsp;')}`
        : `<span style="color:var(--text-tertiary);">${formatCopyText(COPY.bookings.selectedSpots, { count: desired.length, noun: escapeHtml(noun), plural: desired.length !== 1 ? 's' : '' })}</span>`;

      controls.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
          ${msg}
          <div style="display:flex;gap:8px;">
            <button class="psycle-btn" id="bk-edit-close" style="flex:1;background:color-mix(in srgb,var(--text) 6%,transparent);border:1px solid color-mix(in srgb,var(--text) 12%,transparent);color:var(--text);">${COPY.bookings.close}</button>
            <button class="psycle-btn" id="bk-edit-save" style="flex:2;background:var(--feat-autoupgrade);color:var(--on-accent);" ${(!changed || shortfall > 0) ? 'disabled' : ''}>${COPY.bookings.saveChanges}</button>
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
        const isGuest = guestSlots.includes(slotId);
        const guestPendingCancel = guestsToCancel.has(slotId);
        const isSelected = selected.has(slotId);
        const left = widthRange === 0 ? 50 : ((slot.x - minX) / widthRange) * 78 + 8;
        const top = heightRange === 0 ? 50 : ((slot.y - minY) / heightRange) * 72 + 14;

        const el = document.createElement('div');
        el.className = 'bk-edit-slot';
        el.style.cssText = `position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;line-height:1;white-space:nowrap;user-select:none;transition:all 0.1s;box-sizing:border-box;z-index:1;`;
        // "27", not "Bike 27" — the full label wrapped to two lines and spilled
        // out of a 28px square. Full label stays in the tooltip below.
        el.textContent = shortLabelsForPlan.get(String(slot.id)) || slot.label || slotId;
        const canAddSelf = canSelectSelfSpot({ selectedCount: selected.size, selfBookingLimit, isSelected });
        const clickable = isGuest || isSelected || isCurrent || (isAvailable && canAddSelf);
        el.style.cursor = clickable ? 'pointer' : 'default';
        el.title = `${nounCap} ${slot.label || slotId}`;

        if (isGuest) {
          el.style.background = guestPendingCancel ? 'color-mix(in srgb,var(--danger) 15%,transparent)' : 'color-mix(in srgb,var(--info) 16%,transparent)';
          el.style.border = guestPendingCancel ? '2px dashed var(--danger)' : '2px dashed var(--info)';
          el.style.color = guestPendingCancel ? 'var(--danger)' : 'var(--info)';
          el.title = `${COPY.bookings.guestMapGuest}: ${slot.label || slotId}${guestPendingCancel ? ' (will be removed)' : ''}`;
        } else if (isSelected) {
          el.style.background = 'var(--feat-autoupgrade)';
          el.style.border = '2px solid color-mix(in srgb,var(--feat-autoupgrade) 70%,#000)';
          el.style.color = '#fff';
        } else if (isCurrent) {
          // Your seat, deselected → pending release
          el.style.background = 'color-mix(in srgb,var(--danger) 15%,transparent)';
          el.style.border = '1px dashed var(--danger)';
          el.style.color = 'var(--danger)';
        } else if (isAvailable && !canAddSelf) {
          el.style.background = 'var(--surface-inset)';
          el.style.border = '1px solid var(--border)';
          el.style.color = 'var(--text-tertiary)';
          el.style.opacity = '0.55';
          el.title = formatCopyText(COPY.bookingEditor.selfBookingLimitExceeded, { count: selfBookingLimit, plural: selfBookingLimit === 1 ? '' : 's' });
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
          if (isGuest) {
            if (guestsToCancel.has(slotId)) guestsToCancel.delete(slotId);
            else guestsToCancel.add(slotId);
          } else if (selected.has(slotId)) selected.delete(slotId);
          else if (isCurrent || isAvailable) {
            if (!canSelectSelfSpot({ selectedCount: selected.size, selfBookingLimit })) {
              showToast(formatCopyText(COPY.bookingEditor.selfBookingLimitExceeded, { count: selfBookingLimit, plural: selfBookingLimit === 1 ? '' : 's' }), 'warning');
              return;
            }
            selected.add(slotId);
          }
          else { showToast(formatCopyText(COPY.bookings.occupiedSpotFor, { noun }), 'warning'); return; }
          renderGrid();
          renderControls();
        });

        floorGrid.appendChild(el);
      });
    };

    const saveChanges = async (toAdd, toRemove) => {
      if (selected.size > selfBookingLimit) {
        showToast(formatCopyText(COPY.bookingEditor.selfBookingLimitExceeded, { count: selfBookingLimit, plural: selfBookingLimit === 1 ? '' : 's' }), 'warning');
        renderControls();
        return;
      }
      const saveBtn = body.querySelector('#bk-edit-save');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = COPY.static.saving; }
      try {
        const gymId = group.event?.gymId || null;
        // Explicit guest removal is a direct guest cancellation. If the member
        // seat is removed below, /api/cancel also finds/cancels every remaining
        // guest before it ever releases the member reservation.
        for (const slotId of guestsToCancel) {
          const guestBookingId = guestSlotToBooking.get(slotId);
          if (guestBookingId) await api.cancel(guestBookingId, gymId);
        }
        // THIS booking's gym, not the ambient one. Judged against the wrong
        // gym's flag this either skips a native swap (falling back to
        // cancel-then-rebook, which can lose the spot to someone else in the
        // gap) or calls a swap endpoint the provider doesn't have.
        if (canForGym('atomicSwap', gymId) && toRemove.length === 1 && toAdd.length === 1) {
          const bookingId = slotToBooking.get(toRemove[0]);
          const r = await api.swapSpot(bookingId, toRemove[0], toAdd[0], gymId);
          if (!r.ok) throw new Error(r.error || COPY.bookings.spotSwapDeclined);
        } else {
          // 1. Release removed spots.
          for (const slotId of toRemove) {
            const bookingId = slotToBooking.get(slotId);
            if (bookingId) await api.cancel(bookingId, gymId);
            const up = findUpgradeForSeat(cache.upgrades, { bookingId, gymId, eventId: group.eventId, slotId });
            if (up) { try { await api.deleteAutoUpgrade(up.id); } catch (_) {} }
          }
          // 2. Book added spots.
          if (toAdd.length) {
            const added = [];
            for (const slotId of toAdd) {
              const r = await api.book(group.eventId, [slotId], gymId, {
                selfBookingLimit,
                currentSelfBookings: currentSlots.length - toRemove.length + added.length,
              });
              if (!r.ok) {
                throw new Error(added.length
                  ? formatCopyText(COPY.bookings.rebookedPartial, { booked: added.length, total: toAdd.length, declined: r.error || COPY.bookings.remainingDeclined })
                  : (r.error || COPY.bookings.rebookingDeclined));
              }
              added.push(r);
            }
          }
        }
        if (toAdd.length) {
          api.notifyBookingSuccess({
            source: 'manual', eventId: group.eventId, className, gymId: group.event?.gymId || null,
            groupName,
            instructorName: event.instructors?.[0]?.name || event.instructor?.full_name || '',
            startAt: event.startAt || event.start_at, slots: toAdd.map(labelFor),
          }).catch(() => {});
        }
        await invalidateApiCache('/api/bookings');
        await invalidateApiCache('/api/waitlists');
        haptic('success');
        showToast(formatCopyText(COPY.bookings.spotsUpdated, { noun: nounCap }), 'success');
        closeModal();
        await refreshUserData(true);
        onChange();
      } catch (err) {
        haptic('error');
        showToast(formatCopyText(COPY.bookings.updateFailed, { noun, error: err.message }), 'error');
        closeModal();
        await refreshUserData(true);
        onChange();
      }
    };

    renderGrid();
    renderControls();
  } catch (err) {
    if (!isCurrentRun()) return;
    console.error('[Bookings] Edit modal failed:', err);
    body.innerHTML = `<div class="psycle-card-error" style="color:var(--danger);padding:20px 0;text-align:center;">${formatCopyText(COPY.bookings.loadingFloorMapError, { error: escapeHtml(err.message) })}</div>`;
  }
}

// ── Waitlist cards ───────────────────────────────────────────────────
// Same card design as bookings; a waitlist entry has no spot and no upgrade,
// so the only rail action is Leave (two-tap confirm).
function renderWaitlistsCards(waitlists) {
  const container = document.getElementById('psycle-waitlists-list');
  if (!container) return;

  const valid = (waitlists || []).filter(w => w.event && (w.event.startAt || w.event.start_at));
  waitlistCount = valid.length;
  if (valid.length === 0) {
    container.innerHTML = `<div class="fav-empty-state" style="padding:30px 0;">${COPY.bookings.noWaitlists}</div>`;
    updateWaitlistAffordances();
    return;
  }

  valid.sort((a, b) => new Date(a.event.startAt || a.event.start_at) - new Date(b.event.startAt || b.event.start_at));
  container.innerHTML = '';
  valid.forEach(w => container.appendChild(buildWaitlistCard(w)));
  equalizeDiscTagWidths(container);
  observeLocationWrap(container);
  wireRailToggle(container);
  updateWaitlistAffordances();
}

function buildWaitlistCard(w) {
  const event = w.event;
  const startAt = event.startAt || event.start_at;
  const fmt = formatInZone(startAt, zoneFor(event, w.gymId || w.gym_id));
  const dateStr = noSept(fmt.date);
  const timeOnly = fmt.timeLabel;
  const rawClassName = event.name || event.event_type?.name || COPY.autoBook.class;
  const groupName = event.discipline || event.event_type?.group?.name || rawClassName;
  const className = stripClassNamePrefix(rawClassName, groupName);
  const instructorName = event.instructors?.[0]?.name || event.instructor?.full_name || '';
  const instructorPhotoUrl = event.instructors?.[0]?.thumbUrl || event.instructors?.[0]?.imageUrl || null;
  const locationLine = [event.studioName || event.studio?.name, trimLocation(event.locationName || event.studio?.location?.name, getGymShortName(event.gymId))].filter(Boolean).join(', ');

  const card = document.createElement('div');
  card.className = 'psycle-autobook-card ab-card is-waitlist';
  card.setAttribute('data-event-id', event.id);
  card.setAttribute('data-gym', event.gymId || getDefaultGymId());
  card.innerHTML = `
    ${renderGymRail(event.gymId || getDefaultGymId())}
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
          </div>
          <div class="ab-card-line2">
            <span class="ab-card-titlegroup">${disciplineTag(groupName)}
            <span class="ab-card-class">${className}</span></span>
            ${instructorInlineHtml(instructorName)}
            ${locationLine ? `<span class="ab-meta-dot">·</span><span class="ab-card-location">${locationLine}</span>` : ''}
          </div>
        </div>
        ${(instructorAvatar(instructorName, event.gymId, instructorPhotoUrl) || instructorName)
          ? `<div class="ab-card-figure">${instructorAvatar(instructorName, event.gymId, instructorPhotoUrl) || ''}${instructorName ? `<span class="ab-card-instructor">${instructorName}</span>` : ''}</div>` : ''}
      </div>
      <div class="ab-card-footer">
        <span class="ab-spots-pill" style="gap:5px;color:var(--warning);background:color-mix(in srgb,var(--warning) 12%,transparent);">${icon('clock', 12)} ${COPY.bookings.waitlisted}</span>
      </div>
    </div>
    <div class="ab-card-rail">
      <button class="ab-rail-btn danger leave-wl-btn" aria-label="${COPY.bookings.leaveWaitlistAria}">${icon('close', 17)}<span>${COPY.bookings.leaveWaitlist}</span></button>
    </div>
  `;

  const leaveBtn = card.querySelector('.leave-wl-btn');
  const labelSpan = leaveBtn.querySelector('span');
  let confirmState = false;
  leaveBtn.addEventListener('click', async () => {
    if (!confirmState) {
      haptic('medium');
      confirmState = true;
      labelSpan.textContent = COPY.bookings.confirm;
      leaveBtn.classList.add('confirming');
      setTimeout(() => {
        confirmState = false;
        labelSpan.textContent = COPY.bookings.leaveWaitlist;
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
      showToast(COPY.bookings.leavingWaitlist, 'info');
      await api.leaveWaitlist(event.id, event.gymId);
      haptic('warning');
      showToast(COPY.bookings.leftWaitlist, 'success');
      await refreshUserData(true);
      renderBookings();
    } catch (err) {
      haptic('error');
      showToast(err.message, 'error');
      card.style.opacity = '1';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      labelSpan.textContent = COPY.bookings.leaveWaitlist;
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
async function handleUpgradeClick({ currentSlotLabel, eventId, gymId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs }) {
  if (!eventId || !bookingId || currentSlotId === '' || currentSlotId == null || isNaN(Number(currentSlotId))) {
    showToast(COPY.bookings.currentSpotUnknown, 'error');
    return;
  }

  // If editing an existing monitor, always open the config modal
  if (existingUpgradeId !== null) {
    openUpgradeConfigModal({ eventId, gymId, bookingId, currentSlotId, currentSlotLabel, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs });
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
      showToast(COPY.bookings.startingUpgrade, 'info');
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
          keepOriginalOnCutoff: keepOriginalForAutoCreate(gymSetting(gymId, 'autoUpgradeKeepOriginalByDefault'))
        }
      });
      showToast(COPY.bookings.upgradeStartedWithMap, 'success');
      renderBookings();
    } else {
      // No prefs — open modal to configure
      openUpgradeConfigModal({ eventId, gymId, bookingId, currentSlotId, currentSlotLabel, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId: null, existingPrefs: null });
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Auto-Upgrade configuration modal (floor plan + options)
export async function openUpgradeConfigModal({ currentSlotLabel = '', eventId, gymId, bookingId, currentSlotId, studioId, className, groupName, instructorName, studioName, locationName, startAt, existingUpgradeId, existingPrefs }) {
  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title) return;

  title.textContent = COPY.autoUpgrade.configureTitle;
  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span>${COPY.bookings.fetchingFloorMap}</span>
    </div>
  `;

  const spotMapDirty = () => !!body.querySelector('[data-spotmap-root]')?.__isDirty?.();
  const discardOk = () => !spotMapDirty() || confirm(COPY.bookingEditor.discardChanges);
  openNavPage(modal, { id: 'upgrade-config', canClose: discardOk });

  const closeBtn = document.getElementById('psycle-booking-modal-close');
  const overlay = modal.querySelector('.psycle-modal-overlay');
  
  const closeModal = () => {
    if (closeNavPage(modal)) return;
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
  };
  
  closeBtn.onclick = closeModal;
  overlay.onclick = closeModal;

  const isEditing = existingUpgradeId !== null;
  title.textContent = isEditing ? COPY.autoUpgrade.editTitle : formatCopyText(COPY.autoUpgrade.configureClassTitle, { className });
  applyBookingChrome(modal, { titleText: COPY.bookingFlow.titleUpgrade, gymId, locationName, studioName });

  try {
    // WP-C5: the floor plan below is driven entirely by NormalizedSlot[] /
    // NormalizedLayoutObject[] from the adapter — no raw `studio.layout` access
    // — so a MarianaTek layout renders here unchanged.
    const [{ event, slots: layoutSlots, objects: layoutObjects }, allPrefs] = await Promise.all([
      api.getEventDetails(eventId, gymId),
      api.getStudioPreferences()
    ]);
    const groupName = event.discipline || event.name || COPY.autoBook.class;
    const noun = seatNoun(groupName);
    const nounCap = noun[0].toUpperCase() + noun.slice(1);
    const resolvedStudioId = studioId || event.studioId;
    const studioPrefs = pickStudioPrefs(allPrefs, resolvedStudioId, gymId);

    // Explicit FCFS check rather than inferring it from an empty slot list —
    // the two mean different things (see openEditBookingModal's equivalent).
    const isFcfs = event.layoutFormat === 'first-come-first-serve';
    if (isFcfs || layoutSlots.length === 0) {
      const why = isFcfs
        ? formatCopyText(COPY.bookingEditor.noAssignedUpgradeSpots, { noun })
        : COPY.bookingEditor.noMapForUpgrade;
      body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-secondary);">${why}</div>`;
      return;
    }

    // Auto-upgrade reads the LIVE shared studio map. The map is hidden by default
    // and edited in its own view (below); the form state survives the round trip.
    const state = {
      slots: (studioPrefs?.preferredSlots || existingPrefs?.preferredSlots || []).map(Number),
      rows: [...(studioPrefs?.preferredRows || [])],
      keepOriginal: keepOriginalInitial(existingPrefs, gymSetting(gymId, 'autoUpgradeKeepOriginalByDefault')),
    };
    const showKeepOriginal = isKeepOriginalEnabled(gymSetting(gymId, 'autoUpgradeKeepOriginalByDefault'));

    const spotLabel = currentSpotLabel(layoutSlots, currentSlotId, currentSlotLabel);

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
      ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;line-height:1.5;">${ineligibleReason || formatCopyText(COPY.bookingEditor.upgradeNeedsCredits, { needed: upgradeCreditsNeeded - availableCredits, gym: escapeHtml(gym.name || gym.shortName || COPY.static.yourGymFallback) })}</div>`
      : '';

    const contextInfo = { className, instructorName: instructorName || '', startAt, gymId, timeZone: event.timeZone };

    const showForm = () => {
      body.innerHTML = `
        <div id="psycle-upgrade-editor" class="psycle-upgrade-setup">
          ${isExplainerDismissed() ? '' : `
          <div class="psycle-upgrade-explainer" id="upgrade-explainer">
            <button type="button" class="psycle-upgrade-explainer-close" id="upgrade-explainer-close" aria-label="Dismiss explanation">&times;</button>
            <strong>How Auto-Upgrade works</strong>
            <p>We watch this class for you. When a better ${noun} frees up, we move you into it automatically, and keep checking until the cutoff.</p>
            <p>Your <strong>preferred ${noun} map</strong> ranks which ${noun}s you would like, in priority order. It is shared for ${escapeHtml(studioName)}, so Quick-Book and Auto-Book use the same map.</p>
          </div>`}
          ${creditWarningHtml}
          <div id="upgrade-context"></div>
          <div class="psycle-upgrade-current">Your current ${noun}: <strong>${escapeHtml(spotLabel || '—')}</strong></div>
          <div class="psycle-upgrade-map-summary">
            <span id="upgrade-map-summary">${escapeHtml(summarizeSpotPrefs(state.slots, state.rows, noun))}</span>
            <button type="button" class="psycle-btn psycle-upgrade-edit-map" id="upgrade-edit-map">Edit preferred ${noun} map for ${escapeHtml(studioName)}</button>
          </div>
          ${showKeepOriginal ? `
          <label class="psycle-upgrade-keep">
            <input type="checkbox" class="psycle-ms-checkbox" id="upgrade-keep-original" ${state.keepOriginal ? 'checked' : ''}>
            <span><strong>${COPY.bookings.continuePastCutoff}</strong><br>
              <span class="psycle-upgrade-keep-help">${formatCopyText(COPY.bookingEditor.finalUpgradeAttemptHelp, { noun: escapeHtml(noun) })}</span></span>
          </label>` : ''}
          <div class="psycle-spotmap-actions psycle-upgrade-actions" style="display:flex;gap:8px;">
            <button type="button" class="psycle-btn" id="upgrade-save" style="flex:2;background:var(--feat-autoupgrade);color:#fff;">${isEditing ? COPY.bookings.saveChanges : COPY.bookings.startMonitoring}</button>
            ${isEditing ? `<button type="button" class="psycle-btn" id="upgrade-disable" style="flex:1;background:color-mix(in srgb, var(--danger) 10%, transparent);border:1px solid color-mix(in srgb, var(--danger) 20%, transparent);color:var(--danger);">${COPY.bookings.disableUpgrade}</button>` : ''}
          </div>
        </div>`;

      const ctxHost = body.querySelector('#upgrade-context');
      try { ctxHost.appendChild(bookingContextEl(contextInfo)); } catch (_) { /* context card is cosmetic */ }

      body.querySelector('#upgrade-explainer-close')?.addEventListener('click', () => {
        dismissExplainer();
        body.querySelector('#upgrade-explainer')?.remove();
      });
      body.querySelector('#upgrade-keep-original')?.addEventListener('change', (e) => { state.keepOriginal = e.target.checked; });
      body.querySelector('#upgrade-edit-map').onclick = () => showMap();

      const disableBtn = body.querySelector('#upgrade-disable');
      if (disableBtn) disableBtn.onclick = async () => {
        try {
          showToast(COPY.bookings.disablingUpgrade, 'info');
          await api.deleteAutoUpgrade(existingUpgradeId);
          showToast(COPY.bookings.upgradeDisabled, 'success');
          closeModal();
          renderBookings();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      body.querySelector('#upgrade-save').onclick = async () => {
        if (state.slots.length === 0 && state.rows.length === 0) {
          showToast(formatCopyText(COPY.bookings.preferredSpotRequiredFor, { noun }), 'warning');
          return;
        }
        // Hidden option => never sent as true.
        const keepOriginalOnCutoff = showKeepOriginal && state.keepOriginal;
        try {
          if (isEditing) {
            await api.updateAutoUpgrade(existingUpgradeId, { keepOriginalOnCutoff }, bookingId);
            showToast(COPY.bookings.upgradeUpdated, 'success');
          } else {
            await api.addAutoUpgrade({
              eventId, gymId: gymId || null, studioId: resolvedStudioId || null, bookingId, currentSlotId,
              className, groupName, instructorName, studioName, locationName, startAt,
              creditShortfall: upgradeCreditShortfall(gymId),
              preferences: { keepOriginalOnCutoff }
            });
            showToast(COPY.bookings.monitorStarted, 'success');
          }
          closeModal();
          renderBookings();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    };

    const showMap = () => {
      body.innerHTML = `<div id="psycle-upgrade-editor"></div>`;
      const editorContainer = body.querySelector('#psycle-upgrade-editor');
      const bannerHtml = `
        <div style="font-size:12px;color:var(--text-secondary);background:var(--surface-inset);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5;">
          ${formatCopyText(COPY.bookingEditor.sharedSpotMapHtml, { studioName: escapeHtml(studioName) })} Your current ${noun} is <strong>${escapeHtml(spotLabel || '—')}</strong>.
        </div>`;
      renderStudioFloorPlan(editorContainer, layoutSlots, state.slots, state.rows, async (slots, rows) => {
        try {
          // Save the shared studio map (what every feature reads live). Studio ids
          // are PROVIDER ids, so the gym must travel with them.
          if (resolvedStudioId) {
            await api.updateStudioPreferences(resolvedStudioId, { preferredSlots: slots, preferredRows: rows }, gymId);
          }
          state.slots = slots.map(Number);
          state.rows = [...rows];
          showForm();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }, {
        saveLabel: COPY.spotMapEditor.saveDefaults,
        layoutObjects,
        rowGroups: rowGroupsForStudio(resolvedStudioId, gymId),
        bannerHtml,
        hideClear: true,
        // Deliberately no availability filter: this edits the studio-wide shared map, so occupied
        // spots in this class must stay selectable.
        currentSlotId,
        aboveMap: () => bookingContextEl(contextInfo, { helperId: 'spotmap-setup', helperText: COPY.bookingFlow.helperSetup })
      });
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'psycle-btn psycle-upgrade-back';
      back.textContent = COPY.autoUpgrade.backToUpgrade;
      back.onclick = () => { if (discardOk()) showForm(); };
      editorContainer.appendChild(back);
    };

    showForm();

  } catch (err) {
    console.error('[Bookings] Modal load layout failed:', err);
    body.innerHTML = `<div class="psycle-card-error">${formatCopyText(COPY.bookings.loadingSpotLayoutError, { error: escapeHtml(err.message) })}</div>`;
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
