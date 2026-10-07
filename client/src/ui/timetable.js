import { api } from '../api';
import { buildWorkoutOptions, stripVariantSuffix } from './workout-options.js';
import { COPY, appCopy, formatCopyText } from '../copy.js';
import { getAvailableCreditsForEvent, hasUsableCredit, getIneligibleReason, isMetered } from './credit-allowance.js';
import { isCreditInventoryLoaded, pickStudioPrefs as pickGymStudioPrefs } from './gym-isolation.js';
import { isRollingWeeklyGym } from '../gym-context.js';
import { canForGym, canAny, capabilityForGym, getLinkedGyms, getGymShortName, getLocationAlias, getDefaultGymId, formatSpotLabel } from '../gym-context.js';
import { showToast, currentUser, userSettings, gymSetting, isAutoUpgradeDefaultEnabled, profileForGym, refreshUserData, updateCreditBadge, cache, debugConsole } from '../main';
import { passesLocationFilter, formatFullDate, getClassReleaseTime, isFullWithoutWaitlist, isInGracePeriod, GRACE_PERIOD_MS, startGraceCountdown, noSept, zoneFor, formatInZone, dayKeyInZone, nowInZone, deviceZone } from '../lib';
import { getGymTimeZone, getCatalogueGyms } from '../gym-context.js';
import { DateTime } from 'luxon';
// === WEEK-STRIP DATE SELECTOR (Task F) — set to false to restore the scrolling carousel + old row order ===
// When true: paginated Mon-Sun strip, full-date heading above the class list, and the date row ABOVE the filters.
// The old carousel code path below is untouched and used when this is false. CSS lives in one delimited block
// in styles.css ("WEEK-STRIP DATE SELECTOR").
const WEEK_STRIP_DATE_SELECTOR = true;

// EXPERIMENT (Batch N): small instructor photo left of rows 2-3 on mobile timetable rows. One switch.
const SHOW_TIMETABLE_INSTRUCTOR_PHOTO = true;

// === MOBILE TIMETABLE — import renderMinimap (added Jun 2026; delete this block to revert) ===
import { renderMinimap, instructorAvatar, instructorHoverAttrs } from './tooltips.js';
// === END MOBILE TIMETABLE BLOCK ===
import { openDB, accountScopedKey } from '../cache.js';
import { decideRefresh } from './refresh-policy.js';
import { bookingNotifyPayload } from './booking-notify.js';
import { spotSelectionRule, needsSetupIntro, setupIntroCopy } from './spot-selection.js';
import { disciplineTag, seatNoun, sparklesIcon, trendingUpIcon, icon, pulseIcon, trimLocation, displayStudioName, equalizeDiscTagWidths , gymChip , cleanClassName, getDiscipline, passesDisciplineFilter } from './cards';
import { openEditBookingModal, openGroupedCancellationModal, syncBookingCache } from './bookings';
import { openStudioFloorPlanEditor } from './settings';
import { studioHasRowGroups, rowSelectorVisible } from './spotmap.js';
import { renderFilterRail, removeFilterRail, syncFilterSheetState, isFilterSheetOpen } from './filter-rail.js';
import { nextGymSelection } from './gym-quick-select.js';
import { resolveDefaultFilters } from './default-filters.js';
import { buildSearchIndex, searchEvents, tokenize } from './timetable-search.js';
import { getSearchQuery, setSearchQuery, onSearchChange, inSearchScope, enterSearchScope, leaveSearchScope, emptyFilters, filtersAreEmpty } from './timetable-search-state.js';
import { ensureSearchUi, openSearch } from './timetable-search-ui.js';
import { renderTimetableSkeleton } from './loading-skeleton.js';
import { isDocScroll, docScroller, markScrollBusy } from './scroll-state.js';
import { sortEvents } from './progressive-merge.js';
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-anchor.js';
import { confirmOverlap } from './overlap-modal.js';
import { quickBookTap } from './quickbook-flow.js';
import { redactSensitivePayload } from '../redact.js';
import { haptic } from './haptics.js';
import { keepOriginalForAutoCreate } from './autoupgrade-setup.js';
import { openPage as openNavPage, closePage as closeNavPage, isMobile } from './modal-nav.js';
import { applyBookingChrome, mountBookingContext, bannerEl } from './booking-chrome.js';
import { openSpotSetup, setupDeferred, spotSetupBookingOptions } from './spot-setup.js';
import { applyStudioPreferenceMutation, hasStudioPreferences, shouldShowPreferredMapEditToggle } from './studio-preferences-state.js';
import { instructorToken, migrateInstructorSelection, hasLegacyInstructors, passesInstructorFilter, pruneInstructorSelection, findInstructor, parseInstructorToken } from './instructor-filter.js';
import { bookCandidateSpots } from './booking-attempts.js';
import { bookingQuantityOptions, maxAttendeesPerClass } from './booking-limits.js';
import { renderStudioFloorPlan } from './spotmap.js';
import { currentRoute, commitFilterChange, commitNow, replaceCurrent, pathFor } from '../router.js';
import { stateToUrlTimetable, urlToState, savedToState, sameFilters, overlayLabels, guardedSaveDefaults, emptyFilterState } from './timetable-url-sync.js';

async function cacheSet(key, value) {
  try {
    const db = await openDB();
    const tx = db.transaction('cache', 'readwrite');
    tx.objectStore('cache').put(value, key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) {
    // Fallback to localStorage for small values
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch (e2) {
      console.warn(`[Cache] Failed to cache ${key}:`, e2);
    }
  }
}

export async function cacheGet(key) {
  try {
    const db = await openDB();
    const tx = db.transaction('cache', 'readonly');
    const req = tx.objectStore('cache').get(key);
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    // Fallback to localStorage
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e2) {
      return null;
    }
  }
}

// Global Timetable State
export let metadata = {
  locations: [],
  instructors: [],
  eventTypes: [],
  studios: []
};

// O(1) lookup Maps — keyed by both int and string IDs (like the Chrome extension)
// Rebuilt after every metadata update
let locationMap = new Map();
let studioMap = new Map();
let studioObjMap = new Map(); // full studio object, for locationId + hasLayout lookups
let instructorMap = new Map();
// Session-level studio layout cache keyed by studio_id — layouts rarely change mid-session
// Floor plans live in api.js's layout cache (gym+studio keyed, IndexedDB-backed).
let eventTypeMap = new Map();
let eventTypeGroupMap = new Map(); // eventTypeId -> group name

// Bounded, browser-visible timing samples for the warm-cache path. These are
// intentionally data-only (no production console noise) so a browser smoke can
// distinguish IndexedDB, metadata, render prerequisites and DOM work. Keeping
// the last 30 samples is enough to compare a warm reload without growing state.
function timetablePerfNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function recordTimetableTiming(phase, startedAt, detail = {}) {
  if (typeof window === 'undefined') return;
  const sample = {
    phase,
    durationMs: Math.round((timetablePerfNow() - startedAt) * 10) / 10,
    ...detail,
  };
  const samples = window.__psycleTimetablePerformance || [];
  samples.push(sample);
  window.__psycleTimetablePerformance = samples.slice(-30);
  document.documentElement.dataset.timetablePerformance = JSON.stringify(window.__psycleTimetablePerformance);
  window.dispatchEvent(new CustomEvent('sweat-timetable-performance', { detail: sample }));
}

// Normalized metadata ids are STRINGS; raw event fields (studio_id, instructor_id,
// event_type_id) are numbers. Strict equality between them is silently false, so
// every metadata lookup goes through this (WP-D9).
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// A booking matches an event when their ids agree — across a normalized booking
// (`eventId`, a string) and a raw event (`id`, a number). The pre-D9 shape
// (`event_id`) is still accepted so a stale cache degrades rather than breaking.
const matchesEvent = (b, event) => sameId(b.eventId ?? b.event_id ?? b.event?.id, event.id);


/** Rebuild lookup Maps from current metadata arrays. Includes both int and string keys. */
function buildMetaMaps() {
  locationMap = new Map();
  studioMap = new Map();
  studioObjMap = new Map();
  instructorMap = new Map();
  eventTypeMap = new Map();
  eventTypeGroupMap = new Map();

  // Every entry also gets a `${gymId}:${id}` key, not just the bare id.
  // Provider ids are only unique WITHIN a gym (AGENTS.md trap #11/#1) — two
  // gyms can both have a studio/instructor/location "5", and the bare-id key
  // silently let the second gym processed here overwrite the first's entry
  // in the map. That's what broke the config gear and the secondary "Book"
  // button (both gated on `hasMap`, resolved via studioObjMap) and instructor
  // photos/bios for a real multi-gym account — found 2026-09-02. The bare-id
  // keys are kept too, as a single-gym-context fallback (call sites below try
  // the gym-qualified key first via resolve*() helpers, then fall back).
  metadata.locations.forEach(x => {
    locationMap.set(x.id, x.name);
    locationMap.set(String(x.id), x.name);
    if (x.gymId) locationMap.set(`${x.gymId}:${x.id}`, x.name);
  });
  metadata.studios.forEach(x => {
    studioMap.set(x.id, x.name);
    studioMap.set(String(x.id), x.name);
    studioObjMap.set(x.id, x);
    studioObjMap.set(String(x.id), x);
    if (x.gymId) {
      studioMap.set(`${x.gymId}:${x.id}`, x.name);
      studioObjMap.set(`${x.gymId}:${x.id}`, x);
    }
  });
  metadata.instructors.forEach(x => {
    const name = x.full_name || x.name;
    instructorMap.set(x.id, name);
    instructorMap.set(String(x.id), name);
    if (x.gymId) instructorMap.set(`${x.gymId}:${x.id}`, name);
  });
  metadata.eventTypes.forEach(x => {
    eventTypeMap.set(x.id, x.name);
    eventTypeMap.set(String(x.id), x.name);
    if (x.gymId) eventTypeMap.set(`${x.gymId}:${x.id}`, x.name);
    if (x.group) {
      eventTypeGroupMap.set(x.id, x.group);
      eventTypeGroupMap.set(String(x.id), x.group);
      if (x.gymId) eventTypeGroupMap.set(`${x.gymId}:${x.id}`, x.group);
    }
  });
}

// Gym-qualified lookups — prefer `${gymId}:${id}` when the event carries a
// gymId (always true once fetched via the merged multi-gym timetable), else
// fall back to the bare-id key (single-gym / no-gymId contexts).
function gymScopedGet(map, id, gymId) {
  if (id == null) return undefined;
  if (gymId) {
    const v = map.get(`${gymId}:${id}`);
    if (v !== undefined) return v;
  }
  return map.get(id);
}

/** Whether this gym's studio offers the whole-row preference (gym policy, default off). */
export function rowGroupsForStudio(studioId, gymId) {
  const studio = gymScopedGet(studioObjMap, studioId, gymId)
    || metadata.studios.find(s => sameId(s.id, studioId) && (!gymId || s.gymId === gymId));
  return studioHasRowGroups(studio);
}

export function mergeMetadataFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const knownInstructorIds = new Set(metadata.instructors.map(i => String(i.id)));
  const knownLocationIds = new Set(metadata.locations.map(l => String(l.id)));
  const knownStudioIds = new Set(metadata.studios.map(s => String(s.id)));
  const knownTypeIds = new Set(metadata.eventTypes.map(t => String(t.id)));

  let added = false;
  events.forEach(ev => {
    // Stamp gymId (matching what api.getMetadata() stamps onto the base
    // fetch) on everything harvested here — a NormalizedInstructor never
    // carries one itself (normalize.js makeInstructor), and without it these
    // entries can't be told apart from another gym's, which is what silently
    // left the filter dropdowns' gym-subheading grouping doing nothing for
    // any entry that only ever came from this harvesting path.
    (ev.instructors || []).forEach(inst => {
      if (inst && inst.id && !knownInstructorIds.has(String(inst.id))) {
        knownInstructorIds.add(String(inst.id));
        metadata.instructors.push({ ...inst, gymId: ev.gymId });
        added = true;
      }
    });
    if (ev.locationId && !knownLocationIds.has(String(ev.locationId))) {
      knownLocationIds.add(String(ev.locationId));
      metadata.locations.push({ id: String(ev.locationId), name: ev.locationName || 'Location', address: ev.locationAddress, gymId: ev.gymId });
      added = true;
    }
    if (ev.studioId && !knownStudioIds.has(String(ev.studioId))) {
      knownStudioIds.add(String(ev.studioId));
      metadata.studios.push({ id: String(ev.studioId), name: ev.studioName || 'Studio', locationId: ev.locationId ? String(ev.locationId) : null, gymId: ev.gymId });
      added = true;
    }
    if (ev.discipline && !knownTypeIds.has(String(ev.discipline))) {
      knownTypeIds.add(String(ev.discipline));
      metadata.eventTypes.push({ id: String(ev.discipline), name: ev.discipline, group: ev.discipline, gymId: ev.gymId });
      added = true;
    }
  });

  if (added) {
    buildMetaMaps();
  }
}

let selectedGyms = [];
let selectedLocations = [];
let selectedInstructors = [];
let selectedEventTypes = [];
let showBookmarksOnly = false;

let selectedTimetableDate = null;
let weekStripStart = null;          // ISO Monday of the week shown in the strip
let weekStripSeenSelected = null;   // follow the selection only when IT changes (not while paging)
// Live shared studio preference maps, refreshed each grid render so the action
// model can synchronously decide Quick-Book vs Book per studio.
let studioPrefsMap = {};
if (typeof window !== 'undefined') {
  window.addEventListener('sweat-studio-preferences-mutated', (event) => {
    const detail = event.detail || {};
    cache.studioPrefs = applyStudioPreferenceMutation(cache.studioPrefs || {}, detail);
    cache.studioPreferences = applyStudioPreferenceMutation(cache.studioPreferences || {}, detail);
    studioPrefsMap = applyStudioPreferenceMutation(studioPrefsMap || {}, detail);
    renderTimetableGrid('preferences-mutated').catch(() => {});
  });
}
let timetableEvents = [];
// U1-15: NOT a module-local copy. The timetable used to keep its own
// `userBookings`/`userWaitlists`, refreshed only by its own prefetch, so a booking
// cancelled in My Bookings (which updates cache.bookings) still painted as booked
// here until the next prefetch landed, several seconds on a live provider. One
// source of truth: cache.bookings / cache.waitlists, written by every tab and by
// booking-state.js when any mutation succeeds.
const userBookings = () => cache.bookings || [];
const userWaitlists = () => cache.waitlists || [];
let isPrefetching = false;
let prefetchError = null;
// C3-15: the linked-gym set changed (link, re-auth, unlink) while a fetch may be
// in flight. `prefetchGeneration` lets that fetch know its answer is for the OLD
// gym set (it is dropped rather than painted), and `prefetchQueued` remembers a
// request that arrived during it, so the isPrefetching guard cannot swallow it.
let prefetchGeneration = 0;
let prefetchQueued = false;

let openDropdownId = null;
// === MOBILE TIMETABLE — resize listener (added Jun 2026; delete this block to revert) ===
let lastMobileState = window.matchMedia('(max-width: 768px)').matches;
window.addEventListener('resize', () => {
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile !== lastMobileState) {
    lastMobileState = isMobile;
    renderTimetableGrid();
  }
});
// === END MOBILE TIMETABLE BLOCK ===

// User-initiated date change only (tap or swipe; background refreshes call renderTimetableGrid directly, unanimated).
// A QUICK plain slide: the new list arrives from the direction of travel (later date => from the right, earlier =>
// from the left): translateX 28px + a short fade, 150ms, transform/opacity only via the Web Animations API.
// A newer change cancels the running animation (cancel() drops fills, so the list can never stay offset or
// transparent), and a watchdog guarantees rest.
// === WEEK STRIP (Task F). Pure Luxon. Day keys are gym-local date strings, so the
// week arithmetic is zone-free (UTC); only "today" needs the gym's own zone. ===
const STRIP_ZONE = 'UTC';
const stripToday = () => nowInZone(getGymTimeZone(getDefaultGymId()) || deviceZone()).toISODate();
function mondayOfIso(iso) { const d = DateTime.fromISO(iso, { zone: STRIP_ZONE }); return d.minus({ days: d.weekday - 1 }).toISODate(); }
let weekStripPage = 0;              // page (week) the user is looking at; survives re-renders
function renderWeekStrip(carousel, daysWithEvents) {
  carousel.classList.remove('sa-date-selector');
  carousel.classList.add('sa-weekstrip');
  carousel.parentElement?.classList.add('sa-dates-first');
  if (!selectedTimetableDate) {
    carousel.innerHTML = `<div class="sa-wk-empty">${COPY.timetable.noDates}</div>`;
    return;
  }
  const todayIso = stripToday();
  const withEvents = new Set(daysWithEvents);
  const firstMonday = mondayOfIso(todayIso < selectedTimetableDate ? todayIso : selectedTimetableDate);
  const lastDay = daysWithEvents[daysWithEvents.length - 1] || selectedTimetableDate;
  const lastMonday = mondayOfIso(lastDay > selectedTimetableDate ? lastDay : selectedTimetableDate);
  const weeks = Math.min(26, Math.max(1, Math.round(DateTime.fromISO(lastMonday, { zone: STRIP_ZONE }).diff(DateTime.fromISO(firstMonday, { zone: STRIP_ZONE }), 'weeks').weeks) + 1));
  const selectionChanged = weekStripSeenSelected !== selectedTimetableDate;
  weekStripSeenSelected = selectedTimetableDate;
  const selWeek = Math.round(DateTime.fromISO(mondayOfIso(selectedTimetableDate), { zone: STRIP_ZONE }).diff(DateTime.fromISO(firstMonday, { zone: STRIP_ZONE }), 'weeks').weeks);
  if (selectionChanged) weekStripPage = selWeek;
  weekStripPage = Math.min(weeks - 1, Math.max(0, weekStripPage));

  const start = DateTime.fromISO(firstMonday, { zone: STRIP_ZONE });
  const pages = [];
  for (let w = 0; w < weeks; w++) {
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const d = start.plus({ days: w * 7 + i });
      const iso = d.toISODate();
      const past = iso < todayIso;
      const disabled = past || !withEvents.has(iso);
      const cls = ['sa-wk-day', iso === selectedTimetableDate ? 'active' : '', iso === todayIso ? 'is-today' : '', past ? 'is-past' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ');
      cells.push(`<button type="button" class="${cls}" data-day="${iso}" ${disabled ? 'disabled' : ''} aria-pressed="${iso === selectedTimetableDate}" aria-label="${d.setLocale('en-GB').toFormat('cccc d LLLL')}">`
        + `<span class="wk-num">${d.day}</span><span class="wk-name">${d.setLocale('en-GB').toFormat('ccc').toUpperCase()}</span></button>`);
    }
    pages.push(`<div class="sa-wk-page">${cells.join('')}</div>`);
  }
  const desktop = window.matchMedia('(min-width: 769px)').matches;
  const prevLeft = carousel.querySelector('.sa-wk-scroller')?.scrollLeft || 0;
  carousel.innerHTML = `<button type="button" class="sa-wk-nav" data-wk-nav="-1" aria-label="${COPY.timetable.prevWeek}">&#x2039;</button>`
    + `<div class="sa-wk-scroller"><div class="sa-wk-track">${pages.join('')}</div></div>`
    + `<button type="button" class="sa-wk-nav" data-wk-nav="1" aria-label="${COPY.timetable.nextWeek}">&#x203A;</button>`;
  const scroller = carousel.querySelector('.sa-wk-scroller');
  const track = scroller.firstElementChild;
  const goTo = (smooth) => {
    if (desktop) {
      // Desktop: native free scroll (mouse/trackpad); land on the selected week's first day.
      const left = selWeek * 7 * (scroller.scrollWidth / (weeks * 7));
      scroller.scrollTo({ left: selectionChanged ? left : prevLeft, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      // Mobile: a transform pager (below). No native scroller => no iOS momentum/snap phase to swallow taps.
      track.style.transition = smooth ? 'transform .22s ease-out' : 'none';
      track.style.transform = `translateX(${-weekStripPage * 100}%)`;
    }
  };
  goTo(false);
  if (selectionChanged && weeks > 1) requestAnimationFrame(() => goTo(false));
  // Desktop < > step the strip by one 2-week period.
  carousel.querySelectorAll('.sa-wk-nav').forEach((b) => {
    b.onclick = () => scroller.scrollBy({ left: Number(b.dataset.wkNav) * scroller.clientWidth, behavior: 'smooth' });
  });
  const selectDay = (b) => {
    const dayStr = b.dataset.day;
    const dir = dayStr > selectedTimetableDate ? 1 : (dayStr < selectedTimetableDate ? -1 : 0);
    selectedTimetableDate = dayStr;
    // Optimistic: the strip highlight and full-date heading change NOW, before the list re-renders.
    carousel.querySelectorAll('.sa-wk-day').forEach((c) => { const on = c === b; c.classList.toggle('active', on); c.setAttribute('aria-pressed', String(on)); });
    const head = document.querySelector('#sa-timetable-grid .sa-tt-fulldate');
    if (head) head.textContent = formatFullDate(dayStr);
    animateDateChange(dir, () => renderTimetableGrid());
  };
  carousel.querySelectorAll('.sa-wk-day:not(.is-disabled)').forEach((b) => { b.onclick = () => selectDay(b); });

  if (!desktop) {
    // Week pager on touch. The strip used to be a native overflow scroller with scroll-snap: after a flick iOS keeps
    // it in momentum/snap-settle for ~1s, and a tap during that phase only stops the scroll (no click). Here horizontal
    // drags are handled in JS (finger-follow + a short transition), so a tap is ALWAYS an ordinary click.
    let sx = null, sy = 0, st = 0, dx = 0, drag = false, decided = false, w = 0, lastDragEnd = 0;
    scroller.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { sx = null; return; }
      const p = e.touches[0];
      sx = p.clientX; sy = p.clientY; st = performance.now(); dx = 0; drag = false; decided = false; w = scroller.clientWidth || 1;
    }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
      if (sx == null) return;
      const p = e.touches[0];
      const mx = p.clientX - sx, my = p.clientY - sy;
      if (!decided) {
        if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
        decided = true; drag = Math.abs(mx) > Math.abs(my);
        if (drag) track.style.transition = 'none';
      }
      if (!drag) return;
      e.preventDefault();
      dx = mx;
      const atEdge = (weekStripPage === 0 && dx > 0) || (weekStripPage === weeks - 1 && dx < 0);
      track.style.transform = `translateX(${-weekStripPage * w + (atEdge ? dx * 0.3 : dx)}px)`;
    }, { passive: false });
    const finish = () => {
      if (sx == null) return;
      sx = null;
      if (!drag) return;
      const v = Math.abs(dx) / Math.max(1, performance.now() - st);
      if (dx < -w * 0.2 || (v > 0.4 && dx < -20)) weekStripPage = Math.min(weeks - 1, weekStripPage + 1);
      else if (dx > w * 0.2 || (v > 0.4 && dx > 20)) weekStripPage = Math.max(0, weekStripPage - 1);
      lastDragEnd = performance.now();
      goTo(true);
    };
    scroller.addEventListener('touchend', finish, { passive: true });
    scroller.addEventListener('touchcancel', finish, { passive: true });
    // A drag is not a tap: swallow the click some browsers still synthesize at the end of one.
    scroller.addEventListener('click', (e) => { if (performance.now() - lastDragEnd < 350) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
}

function pageChild(grid) { return grid.querySelector('.sa-table-container') || grid.firstElementChild; }
// === END WEEK STRIP ===

let dateNavToken = 0;
function centreActivePill() {
  const carousel = document.getElementById('sa-timetable-carousel');
  const pill = carousel?.querySelector('.sa-day-pill.active');
  if (!carousel || !pill) return;
  const scroller = carousel.classList.contains('sa-date-selector') ? carousel : carousel.querySelector('.sa-date-selector') || carousel;
  scroller.scrollTo?.({ left: pill.offsetLeft - (scroller.clientWidth - pill.offsetWidth) / 2, behavior: 'smooth' });
}
function animateDateChange(dir, render) {
  const grid = document.getElementById('sa-timetable-grid');
  const token = ++dateNavToken;
  // DESKTOP: instant. No slide/fade between days (mobile keeps its swipe-style transition).
  if (window.matchMedia('(min-width: 769px)').matches) {
    grid?.querySelectorAll('.sa-timetable-page-outgoing').forEach((el) => el.remove());
    render();
    return;
  }
  if (!grid || !dir || typeof grid.animate !== 'function') { render(); return; }

  // Clean up any in-flight transitions or clones from rapid clicks
  grid.querySelectorAll('.sa-timetable-page-outgoing').forEach((el) => el.remove());
  grid.getAnimations().forEach((a) => a.cancel());
  grid.style.transform = '';

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    render();
    centreActivePill();
    grid.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 120 });
    return;
  }

  const oldChild = pageChild(grid);
  if (!oldChild) {
    render();
    centreActivePill();
    return;
  }

  // Clone outgoing content into an absolute snapshot overlay so both old and new exist simultaneously
  const clone = oldChild.cloneNode(true);
  clone.classList.add('sa-timetable-page-outgoing');
  const topOffset = oldChild.offsetTop;
  clone.style.cssText = `position: absolute; top: ${topOffset}px; left: 0; width: 100%; pointer-events: none; z-index: 2; margin: 0; box-sizing: border-box; will-change: transform, opacity;`;

  grid.style.position = 'relative';
  grid.style.overflowX = 'hidden';

  render();
  centreActivePill();
  grid.appendChild(clone);

  const newChild = pageChild(grid);
  const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const duration = 280;

  // Outgoing page slides sideways off-screen in the direction opposite to entry
  const animOutgoing = clone.animate([
    { transform: 'translateX(0)', opacity: 1 },
    { transform: `translateX(${-dir * 100}%)`, opacity: 0.15 }
  ], { duration, easing });

  animOutgoing.onfinish = () => {
    if (clone.parentNode) clone.remove();
  };

  // Incoming page slides in from the edge to 0
  if (newChild && newChild !== clone) {
    newChild.style.willChange = 'transform, opacity';
    const animIncoming = newChild.animate([
      { transform: `translateX(${dir * 100}%)`, opacity: 0.3 },
      { transform: 'translateX(0)', opacity: 1 }
    ], { duration, easing });
    animIncoming.onfinish = () => {
      newChild.style.willChange = '';
    };
  }
}

// Swipe the list to change day: left => NEXT day, right => PREVIOUS day. Reuses the day pills' own click path (state,
// highlight, animation direction). Horizontal-dominant only; never starts on interactive/scrollable things or in the
// 20px left edge (iOS back / Settings swipe-back); passive listeners, so vertical scroll and pull-to-refresh are untouched.
let swipeWired = false;
function wireTimetableSwipe() {
  const grid = document.getElementById('sa-timetable-grid');
  if (!grid || swipeWired) return;
  swipeWired = true;
  const EDGE = 20, THRESHOLD = 48;
  const BLOCK = '.sa-mobile-seg, .sa-mobile-menu, .sa-mobile-ellipsis, button, a, input, select, textarea, [data-no-swipe]';
  let sx = 0, sy = 0, st = 0, dx = 0, tracking = false, locked = false;
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hScrollable = (el) => {
    for (let n = el; n && n !== grid; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  };
  grid.addEventListener('touchstart', (e) => {
    tracking = false; locked = false;
    if (!window.matchMedia('(max-width: 768px)').matches || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX <= EDGE) return;
    if (e.target.closest?.(BLOCK) || hScrollable(e.target)) return;
    sx = t.clientX; sy = t.clientY; st = performance.now(); dx = 0; tracking = true;
  }, { passive: true });
  grid.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (!locked) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { tracking = false; return; }   // vertical scroll wins
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.5) locked = true; else return;
    }
    dx = mx;
    if (!reduce()) grid.style.transform = `translateX(${Math.max(-14, Math.min(14, dx * 0.2))}px)`; // light finger-follow
  }, { passive: true });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    grid.style.transform = '';
    if (!locked) return;
    locked = false;
    const fast = Math.abs(dx) / Math.max(1, performance.now() - st) > 0.5;
    if (!(Math.abs(dx) >= THRESHOLD || (fast && Math.abs(dx) > 24))) return;
    const pills = [...document.querySelectorAll('#sa-timetable-carousel .sa-day-pill, #sa-timetable-carousel .sa-wk-day:not(.is-disabled)')];
    const i = pills.findIndex((p) => p.classList.contains('active'));
    const next = pills[i + (dx < 0 ? 1 : -1)];   // stops at the ends of the available range
    if (next) next.click();
  };
  grid.addEventListener('touchend', end, { passive: true });
  grid.addEventListener('touchcancel', () => { tracking = false; locked = false; grid.style.transform = ''; }, { passive: true });
}

// Row 2 shows "class name · instructor". ONLY when the class name would be truncated does the instructor move (the
// same node, so its tooltip handlers survive) to row 3 after the studio ("Studio · Instructor"), giving row 2 the
// full class name. One batched pass per render / width change: reset all -> read all -> move flagged.
let instrFitObserver = null;
let instrFitWidth = 0;
function fitInstructorRows() {
  const rows = [...document.querySelectorAll('#sa-timetable-grid .sa-mobile-main')];
  if (!rows.length) return;
  rows.forEach((main) => {
    const line2 = main.querySelector('.sa-mobile-line2');
    const bottom = main.querySelector('.sa-mobile-bottom-line');
    const moved = bottom.querySelectorAll('.sa-mobile-dot, .sa-mobile-instructor');
    moved.forEach((n) => line2.appendChild(n));   // back to row 2 (dot then instructor keeps DOM order)
  });
  const flagged = rows.filter((main) => {
    const cls = main.querySelector('.sa-mobile-class-name');
    return main.querySelector('.sa-mobile-instructor') && cls.scrollWidth > cls.clientWidth;
  });
  flagged.forEach((main) => {
    const bottom = main.querySelector('.sa-mobile-bottom-line');
    const dot = main.querySelector('.sa-mobile-line2 .sa-mobile-dot');
    const ins = main.querySelector('.sa-mobile-line2 .sa-mobile-instructor');
    if (dot) bottom.appendChild(dot);
    if (ins) bottom.appendChild(ins);
    main.classList.add('instr-below');
  });
  rows.filter((m) => !flagged.includes(m)).forEach((m) => m.classList.remove('instr-below'));
}
function scheduleInstructorFit() {
  if (!window.matchMedia('(max-width: 768px)').matches) return;
  requestAnimationFrame(fitInstructorRows);
  const grid = document.getElementById('sa-timetable-grid');
  if (grid && typeof ResizeObserver !== 'undefined' && !instrFitObserver) {
    instrFitObserver = new ResizeObserver(() => {
      const w = grid.clientWidth;
      if (w !== instrFitWidth) { instrFitWidth = w; requestAnimationFrame(fitInstructorRows); }
    });
    instrFitObserver.observe(grid);
    document.fonts?.ready?.then(() => requestAnimationFrame(fitInstructorRows));
  }
}


// ── U4-19 phases 4-5: URL <-> timetable state ─────────────────────────────────────────────
// The URL carries day + the filter set when it differs from the SAVED defaults. Filters that
// arrive from a link are an OVERLAY: in memory only, shown with a banner, never persisted.
let savedFilterState = emptyFilterState();   // what localStorage holds (set by loadStoredFilters / save)
let overlayActive = false;                   // current filters came from a URL and differ from saved
let overlayDropped = 0;                      // ids in the link that no longer resolve
let pendingUrlTimetable = null;              // parsed params waiting for metadata
let urlReplaceOnce = true;                   // next sync corrects the current entry instead of pushing
let lastSynced = null;                       // { day, filters } as last reflected in the URL
let lastDefaultDay = null;                   // the day a bare /timetable lands on (omitted from the URL)

const currentFilterState = () => ({ gyms: selectedGyms, locations: selectedLocations, instructors: selectedInstructors, eventTypes: selectedEventTypes, bookmarks: showBookmarksOnly });
function setFilterState(st) {
  selectedGyms = [...st.gyms]; selectedLocations = [...st.locations]; selectedInstructors = [...st.instructors];
  selectedEventTypes = [...st.eventTypes]; showBookmarksOnly = !!st.bookmarks;
}
const copyOf = (st) => ({ gyms: [...st.gyms], locations: [...st.locations], instructors: [...st.instructors], eventTypes: [...st.eventTypes], bookmarks: !!st.bookmarks });

function urlCtx() {
  const workouts = buildWorkoutOptions({
    eventTypes: metadata.eventTypes, events: timetableEvents, gymOk: () => true, labelOf: (g) => getDiscipline(g).label,
  }).map(w => ({ label: w.name, gymId: String(w.gymId) }));
  return {
    linkedGymIds: (getLinkedGyms() || []).map(g => String(g.gym_id || g.id)),
    locations: metadata.locations, instructors: metadata.instructors, workouts,
    gymName: (id) => getGymShortName(id), locationName: (l) => locationBaseLabel(l),
    favouritesLabel: COPY.timetable.overlayFavourites,
  };
}

function timetableTabVisible() {
  return currentRoute().tab === 'class-timetable' && !!document.getElementById('sa-timetable-grid');
}

/** Apply parsed URL params (load, deep link, back/forward). Never pushes history. */
function applyUrlTimetable(t) {
  const r = urlToState(t, urlCtx());
  if (r.ignoredGyms.length) {
    showToast(formatCopyText(COPY.timetable.overlayGymIgnored, { gyms: r.ignoredGyms.map(g => getGymShortName(g) || g).join(', ') }), 'warning');
  }
  if (r.usesDefaults) {
    setFilterState(copyOf(savedFilterState));
    overlayActive = false; overlayDropped = 0;
  } else {
    setFilterState(r.state);
    overlayActive = !sameFilters(r.state, savedFilterState);
    overlayDropped = r.dropped.length;
  }
  selectedTimetableDate = r.day || null;   // render validates it against days that have classes
  urlReplaceOnce = true;
}

/** Back/forward within the timetable: restore day + filters from the URL and repaint (no refetch). */
export function restoreTimetableFromUrl(t) {
  if (inSearchScope()) { restoreFromSearchScope(); if (getSearchQuery()) setSearchQuery(''); }
  if (!metadata.locations.length) { pendingUrlTimetable = t || {}; return; }
  applyUrlTimetable(t || {});
  renderTimetableGrid('filter');
}

/** Reflect day + filters in the URL. Called from render once the day is validated. */
function syncUrlFromState(defaultDay = lastDefaultDay) {
  if (!timetableTabVisible() || inSearchScope() || pendingUrlTimetable || !metadata.locations.length) return;
  const filters = currentFilterState();
  const day = selectedTimetableDate || null;
  const desired = pathFor({ tab: 'class-timetable', timetable: stateToUrlTimetable(filters, urlCtx(), { day, defaultDay, saved: savedFilterState }) });
  const here = location.pathname + location.search;
  const filtersChanged = !lastSynced || !sameFilters(filters, lastSynced.filters);
  const dayChanged = !lastSynced || lastSynced.day !== day;
  const replace = urlReplaceOnce;
  urlReplaceOnce = false;
  // A manual edit ends the overlay: the filters are now the user's own.
  if (lastSynced && filtersChanged && !replace) { overlayActive = false; overlayDropped = 0; }
  lastSynced = { day, filters: copyOf(filters) };
  if (desired === here) return;
  if (replace) replaceCurrent(desired);
  else if (dayChanged && !filtersChanged) commitNow(desired);
  else commitFilterChange(desired);
}

function renderOverlayBanner() {
  const grid = document.getElementById('sa-timetable-grid');
  if (!grid || !grid.parentElement) return;
  let el = document.getElementById('sa-url-overlay-banner');
  if (!overlayActive) { el?.remove(); return; }
  const labels = overlayLabels(currentFilterState(), urlCtx());
  const text = formatCopyText(COPY.timetable.overlayFiltered, { labels: labels.join(', ') || COPY.timetable.overlayNoFilters })
    + (overlayDropped ? ` · ${formatCopyText(COPY.timetable.overlayUnavailable, { count: overlayDropped })}` : '');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sa-url-overlay-banner';
    el.className = 'sa-url-overlay-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="sa-url-overlay-text"></span><button type="button" class="sa-url-overlay-clear"></button>';
    el.querySelector('button').onclick = clearUrlOverlay;
    grid.parentElement.insertBefore(el, grid);
  }
  el.querySelector('.sa-url-overlay-text').textContent = text;
  el.querySelector('button').textContent = COPY.timetable.overlayClear;
}

/** Clear = back to the SAVED set (not wiped), URL params stripped via replace. */
export function clearUrlOverlay() {
  setFilterState(copyOf(savedFilterState));
  overlayActive = false; overlayDropped = 0;
  urlReplaceOnce = true;
  document.getElementById('sa-url-overlay-banner')?.remove();
  renderTimetableGrid('filter').then(() => {
    const grid = document.getElementById('sa-timetable-grid');
    if (grid) { grid.setAttribute('tabindex', '-1'); grid.focus({ preventScroll: true }); }
  });
}

export function _overlayStateForTest() { return { overlayActive, savedFilterState }; }

// Initializer
export async function initTimetable() {
  const initStartedAt = timetablePerfNow();
  loadStoredFilters();
  // U4-19: entering the tab from a URL that carries timetable params applies them as an overlay
  // once metadata is available (render). Otherwise the saved defaults stand.
  overlayActive = false; overlayDropped = 0; lastSynced = null; urlReplaceOnce = true;
  const r = currentRoute();
  pendingUrlTimetable = r.tab === 'class-timetable' ? r.timetable : null;
  setupDropdownFilters();
  await prefetchTimetableData();
  recordTimetableTiming('initialise-total', initStartedAt);
  // Pull-to-refresh is handled centrally in main.js (attached to the shared
  // <main class="sa-body"> scroller, dispatched by active tab).
}

// Saved filters name PROVIDER ids (locations, instructors, class types), which are
// unique only within a gym — so the key carries the gym (WP-G). Without this, a
// a change in the linked-gym set silently applies the old gym's filter ids, which match
// nothing and render an empty timetable that looks like a data-loading bug.
// There is deliberately NO fallback to the unqualified key when a gym is set: it
// would hand a gym with no saved filters the previous gym's ids, which is the bug
// itself. A single-gym user with no `sweatActiveGymId` still reads the bare key,
// so the common case keeps its saved filters; anyone who has explicitly selected
// a gym re-saves once. Losing a device-local preference beats loading the wrong
// gym's filters.
const FILTERS_KEY_BASE = 'sweatUnifiedDefaultFilters';

function defaultFiltersKey() {
  return accountScopedKey(FILTERS_KEY_BASE);
}

// Load default filter selections from localStorage
function applyFilters(parsed) {
  selectedGyms = parsed.gyms || [];
  selectedLocations = parsed.locations || [];
  selectedInstructors = parsed.instructors || [];
  selectedEventTypes = parsed.eventTypes || [];
  showBookmarksOnly = parsed.showBookmarksOnly || false;
}

// Server (account-scoped `defaultFilters` setting, hydrated into userSettings)
// wins; localStorage is the fast/offline fallback. If only the device has
// filters, push them up once (migration).
function loadStoredFilters() {
  try {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(defaultFiltersKey()) || 'null'); } catch (_) {}
    const { filters, pushUp, writeLocal } = resolveDefaultFilters(userSettings && userSettings.defaultFilters, local);
    if (!filters) { savedFilterState = emptyFilterState(); return; }
    applyFilters(filters);
    savedFilterState = savedToState(filters);   // U4-19: the SAVED set a deep-link overlay is cleared back to
    if (writeLocal) {
      try { guardedSaveDefaults(localStorage, defaultFiltersKey(), filters, overlayActive); } catch (_) {}
    }
    if (pushUp) {
      api.updateSettings({ defaultFilters: filters }).catch(() => {});
      if (userSettings) userSettings.defaultFilters = filters;
    }
  } catch (e) {
    console.error('[Timetable] Failed to load default filters:', e);
  }
}

// Load metadata from API proxy. Exported so panels other than the Timetable
// tab (e.g. My Bookings, which needs metadata.instructors for avatar photos)
// can ensure it's populated without waiting for the user to visit Timetable
// first — the whole `metadata` object is otherwise only filled by that tab.
export async function loadMetadata(force = false) {
  try {
    if (force || !metadata.locations.length || !metadata.instructors.length
        || !metadata.eventTypes.length || !metadata.studios.length) {
      const m = await api.getMetadata({ ttlMs: 3600000 });
      metadata.locations = m.locations || [];
      metadata.instructors = m.instructors || [];
      metadata.studios = m.studios || [];
      metadata.eventTypes = m.eventTypes || m.classTypes || [];
    }
  } catch (err) {
    console.error('[Timetable] Metadata load failed:', err);
    showToast(COPY.timetable.metadataFailed, 'error');
  }
}

// Fetch all events for the prefetch window in parallel across all linked gyms
// Uses instant SWR: renders cached events in 0ms on startup, refreshes in background
const CACHE_KEY_EVENTS = 'sweatUnifiedCacheEvents';
const CACHE_KEY_META = 'sweatUnifiedCacheMeta';
const CACHE_KEY_TIME = 'sweatUnifiedCacheTime';
let lastContextAt = 0; // when bookings/waitlists were last confirmed by the network

async function cacheDel(key) {
  try {
    const db = await openDB();
    const tx = db.transaction('cache', 'readwrite');
    tx.objectStore('cache').delete(key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (_) {}
  try { localStorage.removeItem(key); } catch (_) {}
}

/**
 * C3-15: call after the linked-gym set changes (link, re-auth, unlink). The
 * timetable is a MERGE of every linked gym, held in memory and in the unified
 * IndexedDB cache under an account-scoped key, so neither notices a gym coming
 * or going. Drop both first — otherwise an unlink repaints the removed gym from
 * cache before the network answers — then refetch past the shared server cache.
 */
export async function resetTimetableForGymChange() {
  prefetchGeneration++;
  timetableEvents = [];
  await Promise.all([
    cacheDel(accountScopedKey(CACHE_KEY_EVENTS)),
    cacheDel(accountScopedKey(CACHE_KEY_META)),
    cacheDel(accountScopedKey(CACHE_KEY_TIME)),
  ]);
  return prefetchTimetableData(true);
}

// U4-7: 0 = paint as soon as the first gym answers, merge the rest as they land.
const PROGRESSIVE_GRACE_MS = 0;

// Re-render the grid but keep the reader where they were: a late gym's rows are
// merged into a list someone may already be scrolled down, so anchor on the
// first row in view (by event id) rather than a raw scrollTop that shifts.
function renderPreservingScroll(reason) {
  const grid = document.getElementById('sa-timetable-grid');
  const scroller = (isDocScroll() ? docScroller() : document.querySelector('main.sa-body')) || grid;
  const anchor = captureScrollAnchor(scroller, grid);
  // Restoring the anchor is a programmatic scroll: the collapse hysteresis must re-baseline, not toggle.
  markScrollBusy(400);
  const result = renderTimetableGrid(reason);
  const restore = () => { markScrollBusy(400); restoreScrollAnchor(scroller, anchor, grid); };
  restore();
  if (result && typeof result.then === 'function') result.then(restore).catch(() => {});
  return result;
}

export async function prefetchTimetableData(force = false) {
  if (isPrefetching) {
    // Never swallow an explicit refresh: run one more pass when this one lands.
    // A plain (non-force) call during a fetch is still redundant and stays dropped.
    if (force) prefetchQueued = true;
    return;
  }

  const ttContainer = document.getElementById('sa-timetable-grid');
  if (!ttContainer) return;

  // 1. Instant SWR: Read and display cached events & metadata from IndexedDB immediately (0ms delay!)
  let hasCached = false;
  try {
    const cacheReadStartedAt = timetablePerfNow();
    const [cachedEvents, cachedMeta] = await Promise.all([
      cacheGet(accountScopedKey(CACHE_KEY_EVENTS)),
      cacheGet(accountScopedKey(CACHE_KEY_META)),
    ]);
    recordTimetableTiming('cache-read', cacheReadStartedAt, {
      cacheHit: !!cachedEvents?.length,
      eventCount: cachedEvents?.length || 0,
    });
    if (cachedEvents && cachedEvents.length > 0) {
      timetableEvents = cachedEvents;
      if (cachedMeta) {
        if (cachedMeta.locations?.length) metadata.locations = cachedMeta.locations;
        if (cachedMeta.studios?.length) metadata.studios = cachedMeta.studios;
        if (cachedMeta.instructors?.length) metadata.instructors = cachedMeta.instructors;
        if (cachedMeta.eventTypes?.length) metadata.eventTypes = cachedMeta.eventTypes;
      }
      const indexStartedAt = timetablePerfNow();
      buildMetaMaps();
      mergeMetadataFromEvents(cachedEvents);
      recordTimetableTiming('cache-index', indexStartedAt, { eventCount: cachedEvents.length });
      hasCached = true;
      renderTimetableGrid('warm-cache');
    }
  } catch (e) {
    console.warn('[Timetable] Cache read failed:', e);
  }

  // Re-entry policy: trust a young timetable cache, keep bookings near-live,
  // and never spin the chips for data that is already painted.
  let cachedAt = 0;
  try { cachedAt = Number(localStorage.getItem(accountScopedKey(CACHE_KEY_TIME))) || 0; } catch (_) {}
  const plan = decideRefresh({
    force, hasCached,
    timetableAgeMs: cachedAt ? Date.now() - cachedAt : Infinity,
    contextAgeMs: lastContextAt ? Date.now() - lastContextAt : Infinity,
  });
  if (plan.skip) return;
  const silent = plan.silent;

  // 2. If cold start without any cached data, show spinner while initial fetch completes
  if (!hasCached) {
    ttContainer.innerHTML = renderTimetableSkeleton();
  }

  isPrefetching = true;
  prefetchError = null;
  const generation = prefetchGeneration;

  try {
    // U4-7: progressive load. The page context (metadata, bookings, ...) and the
    // per-gym timetable fetches all start TOGETHER; the grid renders as soon as
    // the first gym answers (or after a 4 s grace window with whatever has
    // landed) instead of waiting for the slowest gym. Late gyms merge in.
    const refreshStartedAt = timetablePerfNow();
    const metadataStartedAt = timetablePerfNow();
    const prefetchWeeks = userSettings.prefetchWeeks || 4;
    const startDate = new Date();
    const startStr = startDate.toISOString().split('T')[0];
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + (prefetchWeeks * 7));
    const endStr = endDate.toISOString().split('T')[0];

    const contextP = Promise.all([
      loadMetadata(true).finally(() => recordTimetableTiming('metadata-refresh', metadataStartedAt)),
      api.getBookings({ silent }),
      api.getWaitlists({ silent }),
      api.getAutoBookings().catch(() => cache.autoBookings || []),
      api.getStudioPreferences().catch(() => cache.studioPrefs || {}),
    ]).then(([, bookingsRes, waitlistsRes, autoBookingsRes, studioPrefsRes]) => {
      if (generation !== prefetchGeneration) return;
      lastContextAt = Date.now();
      cache.bookings = bookingsRes || [];
      cache.waitlists = waitlistsRes || [];
      // U1-12: the overlap check reads the server's booking_cache, so keep it as
      // fresh as this view of the bookings (it was only synced from My Bookings).
      syncBookingCache(cache.bookings);
      cache.autoBookings = autoBookingsRes || [];
      cache.studioPrefs = studioPrefsRes || {};
    });
    // Context (bookings etc.) may land after the first paint: repaint so buttons are right.
    contextP.then(() => { if (generation === prefetchGeneration && timetableEvents.length) renderPreservingScroll('context-ready'); }).catch(() => {});
    contextP.catch(() => {}); // a failure is surfaced below; the gate must not throw
    // The first paint waits for the page context only up to the grace window, so
    // a slow bookings call cannot hold the timetable back either.
    const contextGate = Promise.race([contextP.catch(() => {}), new Promise((r) => setTimeout(r, PROGRESSIVE_GRACE_MS))]);

    // Cached rows of a gym that has not answered yet stay on screen (stale while
    // revalidate) so a late gym replaces its own rows in place instead of vanishing.
    const staleEvents = timetableEvents.slice();
    let flushChain = Promise.resolve();
    const applyFlush = async ({ events, pending, final }) => {
      await contextGate;
      if (generation !== prefetchGeneration) return;
      if (final && !events.length) return; // every gym failed/empty: keep what we had
      const stillPending = new Set((pending || []).map(String));
      const carried = stillPending.size
        ? staleEvents.filter((e) => stillPending.has(String(e.gymId)))
        : [];
      timetableEvents = carried.length ? sortEvents([...events, ...carried]) : events;
      mergeMetadataFromEvents(timetableEvents);
      buildMetaMaps();
      if (final) {
        try {
          await cacheSet(accountScopedKey(CACHE_KEY_EVENTS), timetableEvents);
          await cacheSet(accountScopedKey(CACHE_KEY_META), {
            locations: metadata.locations,
            studios: metadata.studios,
            instructors: metadata.instructors,
            eventTypes: metadata.eventTypes
          });
          localStorage.setItem(accountScopedKey(CACHE_KEY_TIME), String(Date.now()));
        } catch (e) {
          console.warn('[Timetable] Failed to cache events:', e);
        }
      }
      // Rows are replaced wholesale on a late merge; keep the reader's place.
      renderPreservingScroll(final ? 'network-refresh' : 'progressive-merge');
    };

    // `force` here is the user pressing refresh (or pull-to-refresh), which is
    // the one case that should reach past the SHARED server cache to the
    // provider. Ordinary renders ride the cache — that is what makes the second
    // load fast.
    const freshEvents = !plan.timetable ? timetableEvents : await api.getTimetableProgressive(
      { startDate: startStr, endDate: endStr, refresh: force },
      { graceMs: PROGRESSIVE_GRACE_MS, silent, onFlush: (info) => { flushChain = flushChain.then(() => applyFlush(info)).catch((e) => console.warn('[Timetable] merge failed:', e)); } },
    );
    await flushChain;
    await contextP;
    recordTimetableTiming('network-refresh', refreshStartedAt, {
      eventCount: freshEvents?.length || 0,
    });
    if (generation !== prefetchGeneration) {
      // The gym set changed mid-flight: this answer belongs to the old set.
      isPrefetching = false;
      prefetchQueued = false;
      return prefetchTimetableData(true);
    }
    isPrefetching = false;
    renderPreservingScroll('network-refresh');
    if (prefetchQueued) { prefetchQueued = false; return prefetchTimetableData(true); }
  } catch (err) {
    isPrefetching = false;
    prefetchError = err.message;
    console.error('[Timetable] Prefetch failed:', err);
    if (!hasCached) {
      ttContainer.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: var(--text-secondary);">
          <p style="font-size:16px;margin-bottom:8px">${COPY.timetable.noCachedTimetable}</p>
          <p style="font-size:13px;color:var(--text-tertiary)">${COPY.timetable.connectInternet}</p>
          <button id="sa-timetable-retry-btn" class="psycle-btn variant-danger" style="margin-top: 12px; display: inline-block; width: auto; padding: 8px 16px; border-radius: 8px;">${COPY.timetable.retry}</button>
        </div>
      `;
      const retryBtn = document.getElementById('sa-timetable-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = () => prefetchTimetableData(true);
      }
    }
  }
}

// Generate the dropdown filter option checklists
// activeIds: { locationIds, instructorIds, classTypeIds } — each a Set of IDs from interdependently-filtered events
function setupDropdownFilters({ locationIds, instructorIds, classTypeIds } = {}) {
  const container = document.getElementById('sa-timetable-filters-container');
  if (!container) return;

  // Gym filter (rendered only when >1 gym linked)
  const linked = getLinkedGyms() || [];
  const gymDropdown = document.getElementById('sa-ms-gym');
  if (gymDropdown) {
    if (linked.length > 1) {
      gymDropdown.style.display = 'block';
      const gymItems = linked.map(g => ({
        id: g.gym_id || g.id,
        name: g.gym_name || g.name || g.gym_id || g.id,
      }));
      populateOptionsList('sa-ms-gym', gymItems, selectedGyms, 'gym');
      updateTriggerLabel('sa-ms-gym', selectedGyms, COPY.timetable.allGyms, 'Gym');
    } else {
      gymDropdown.style.display = 'none';
    }
  }

  // These id sets are built from a MIX of sources — raw event fields (numbers)
  // and normalized metadata (strings) — so every membership test compares as a
  // string. A `Number()` here silently matched nothing once studio.locationId
  // became normalized, and the filter rendered empty with no error at all.
  const hasId = (set, id) => set.has(String(id)) || set.has(Number(id));

  const locationsToRender = (!locationIds || locationIds.size === 0)
    ? metadata.locations
    : metadata.locations.filter(l => hasId(locationIds, l.id));

  // Instructors filtered to timetable data, sorted alphabetically
  const instructorPool = (!instructorIds || instructorIds.size === 0)
    ? metadata.instructors
    : metadata.instructors.filter(i => hasId(instructorIds, i.id));
  const instructorsToRender = instructorPool.map(i => ({ ...i, id: instructorToken(i.gymId, i.id) })).sort((a, b) => {
    const nameA = (a.full_name || a.name || '').toLowerCase();
    const nameB = (b.full_name || b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const eventTypesToRender = (!classTypeIds || classTypeIds.size === 0)
    ? metadata.eventTypes
    : metadata.eventTypes.filter(t => hasId(classTypeIds, t.id));

  populateOptionsList('sa-ms-location', locationsToRender, selectedLocations, 'location');
  // Normalized instructors expose `name`; the old raw CodexFit shape used
  // `full_name`, and the default labelField is already 'name'.
  populateOptionsList('sa-ms-instructor', instructorsToRender, selectedInstructors, 'instructor');

  // Event Type groups (Ride, Strength, etc.)
  // `group` is a plain string on the normalized shape — it is both the id the
  // filter selects by and the label it renders, and it is DELIBERATELY
  // shared across gyms: selecting "Boxing" means "Boxing at either gym",
  // unlike location/instructor where two gyms' entries are genuinely
  // different things that happen to share a name.
  //
  // Bucketed to the SAME coarse categories the discipline pill on each row
  // already renders (getDiscipline() in cards.js) rather than the raw
  // `class_type.name` — a specific MarianaTek class type ("BOXING Core &
  // Power", "BOXING Drills & Endurance", "Small Group PT"…) produced a much
  // longer, noisier filter list than the handful of categories (Boxing,
  // Train, Recovery, PT…) a person actually filters by, and the two were
  // liable to drift out of sync if classified separately. This IS a coarser
  // grouping than before — a saved filter selection from before this change
  // stored the specific class-type string and won't match a bucket label, so
  // an existing "class type" default will show no classes until re-saved.
  const seenGroupKeys = new Set();
  const eventTypeGroups = eventTypesToRender
    .filter(t => t.group)
    .map(t => ({ ...t, bucketLabel: discLabel(t.group, t.gymId) }))
    .filter(t => {
      const key = `${t.gymId || ''}:${t.bucketLabel}`;
      if (seenGroupKeys.has(key)) return false;
      seenGroupKeys.add(key);
      return true;
    })
    .map(t => ({ id: t.bucketLabel, name: t.bucketLabel, gymId: t.gymId }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.gymId || '').localeCompare(b.gymId || ''));

  populateOptionsList('sa-ms-class-type', eventTypeGroups, selectedEventTypes, 'class-type');
  
  // Set labels
  updateTriggerLabel('sa-ms-location', selectedLocations, COPY.timetable.allLocations, 'Location');
  updateTriggerLabel('sa-ms-instructor', selectedInstructors, COPY.timetable.allInstructors, 'Instructor');
  updateTriggerLabel('sa-ms-class-type', selectedEventTypes, COPY.timetable.allTypes, 'Type');

  // Bookmarked button class
  const bookmarksFilterBtn = document.getElementById('sa-filter-favorites-only');
  if (bookmarksFilterBtn) {
    if (showBookmarksOnly) {
      bookmarksFilterBtn.classList.add('active');
      bookmarksFilterBtn.textContent = COPY.static.bookmarked.replace('♡', '♥');
    } else {
      bookmarksFilterBtn.classList.remove('active');
      bookmarksFilterBtn.textContent = COPY.static.bookmarked;
    }
  }

  setupFilterEventListeners();
}

// Two gyms can publish a location or instructor under an identical display
// name (e.g. both call a studio "SW1"). The selection is already gym-qualified
// (each item keeps its own id), so this is a label-legibility fix only —
// suffix the gym's short name, but ONLY where the plain label actually
// collides with another item from a DIFFERENT gym; most labels stay as-is.
// `pool` should be the full metadata array (not whatever's currently
// rendered/filtered) so an item's label doesn't flip disambiguated/plain as
// the day or other filters narrow which ids are in view (UI-UX backlog
// T4/C2). Recomputes each pool item's base label rather than caching one onto
// the object — those objects are the same ones persisted to the IndexedDB
// metadata cache, and stamping a throwaway field onto them would serialize it.
function disambiguateGymLabel(item, baseLabel, pool, baseLabelFn) {
  if (!item.gymId || !pool) return baseLabel;
  const collides = pool.some(other =>
    other !== item && other.gymId && other.gymId !== item.gymId &&
    baseLabelFn(other).toLowerCase() === baseLabel.toLowerCase()
  );
  return collides ? `${baseLabel} (${getGymShortName(item.gymId)})` : baseLabel;
}

function locationBaseLabel(item) {
  return trimLocation((item.name || '').trim(), item.gymName || getGymShortName(item.gymId));
}
function instructorBaseLabel(item) {
  return (item.name || item.full_name || `${item.first_name || ''} ${item.last_name || ''}`).trim();
}

// Helper to populate individual dropdown list options
function populateOptionsList(dropdownId, items, selectedArray, type, labelField = 'name') {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  const menu = dropdown.querySelector('.sa-ms-menu');
  const list = dropdown.querySelector('.sa-ms-options-list');
  if (!list) return;

  // Instructor dropdown: inject instant-search input once, then wire it
  if (dropdownId === 'sa-ms-instructor' && menu) {
    let searchInput = menu.querySelector('.sa-ms-search');
    if (!searchInput) {
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'sa-ms-search';
      searchInput.placeholder = COPY.timetable.searchInstructors;
      menu.insertBefore(searchInput, list);
    }
    searchInput.oninput = () => {
      const q = searchInput.value.toLowerCase();
      // A gym subheading has no text of its own to match — hide it whenever
      // every option below it (up to the next heading) is filtered out,
      // otherwise a search with no matches in one gym leaves its heading
      // floating above an empty gap.
      let currentHeading = null;
      let currentHeadingHasMatch = false;
      const closeGroup = () => { if (currentHeading) currentHeading.style.display = currentHeadingHasMatch ? '' : 'none'; };
      Array.from(list.children).forEach(child => {
        if (child.classList.contains('sa-ms-group-heading')) {
          closeGroup();
          currentHeading = child;
          currentHeadingHasMatch = false;
          return;
        }
        const text = child.querySelector('span')?.textContent?.toLowerCase() || '';
        const matches = text.includes(q);
        child.style.display = matches ? '' : 'none';
        if (matches) currentHeadingHasMatch = true;
      });
      closeGroup();
    };
  }

  const isLocation = dropdownId === 'sa-ms-location';
  const isInstructor = dropdownId === 'sa-ms-instructor';
  const isClassType = dropdownId === 'sa-ms-class-type';
  // Location/instructor group AND disambiguate (two gyms' entries can share a
  // display name but are genuinely different things). Class-type groups only
  // — its id is deliberately the same across gyms (see setupDropdownFilters),
  // so suffixing a gym name onto it would imply a distinction that isn't real.
  const groupable = isLocation || isInstructor || isClassType;
  const pool = isLocation ? metadata.locations : isInstructor ? metadata.instructors : null;
  const baseLabelFn = isLocation ? locationBaseLabel : instructorBaseLabel;

  const labelOf = (item) => {
    if (isClassType) return item.name;
    if (!groupable) return (item[labelField] || item.name || `${item.first_name || ''} ${item.last_name || ''}`).trim();
    return disambiguateGymLabel(item, baseLabelFn(item), pool, baseLabelFn);
  };

  list.innerHTML = '';

  // Group under a gym subheading only when THIS list actually spans more than
  // one gym — a single-gym filtered view (or a single-gym account) renders
  // exactly as before, with no subheading at all.
  const distinctGymIds = groupable ? [...new Set(items.filter(i => i.gymId).map(i => i.gymId))] : [];
  if (groupable && distinctGymIds.length > 1) {
    const linkedOrder = (getLinkedGyms() || []).map(g => g.gym_id || g.id);
    const orderedGymIds = [...distinctGymIds].sort((a, b) => linkedOrder.indexOf(a) - linkedOrder.indexOf(b));
    orderedGymIds.forEach(gymId => {
      const heading = document.createElement('div');
      heading.className = 'sa-ms-group-heading';
      heading.textContent = getGymShortName(gymId);
      list.appendChild(heading);
      items.filter(i => i.gymId === gymId).forEach(item => list.appendChild(buildFilterOptionLabel(item, labelOf(item), selectedArray, type)));
    });
    // An item with no gymId at all shouldn't happen once every gym stamps
    // one, but this keeps a stray entry visible rather than silently dropped.
    items.filter(i => !i.gymId).forEach(item => list.appendChild(buildFilterOptionLabel(item, labelOf(item), selectedArray, type)));
    return;
  }

  items.forEach(item => list.appendChild(buildFilterOptionLabel(item, labelOf(item), selectedArray, type)));
}

function buildFilterOptionLabel(item, labelText, selectedArray, type) {
  const isChecked = selectedArray.includes(String(item.id));
  const label = document.createElement('label');
  label.className = 'sa-ms-option-label';
  label.innerHTML = `
    <input type="checkbox" class="sa-ms-checkbox" data-type="${type}" data-id="${item.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
    <span>${labelText}</span>
  `;
  return label;
}

// Update the select button trigger text description
function updateTriggerLabel(dropdownId, selectedArray, defaultText, labelSingular) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  const labelTextEl = dropdown.querySelector('.sa-ms-trigger-text');
  if (!labelTextEl) return;

  if (selectedArray.length === 0) {
    labelTextEl.textContent = defaultText;
  } else if (selectedArray.length === 1) {
    // Resolve single item name
    let name = formatCopyText(COPY.timetable.selectedOne, { count: 1 });
    if (dropdownId === 'sa-ms-gym') {
      const g = (getLinkedGyms() || []).find(x => String(x.gym_id || x.id) === selectedArray[0]);
      if (g) name = g.gym_name || g.name || g.gym_id || g.id;
    } else if (dropdownId === 'sa-ms-location') {
      const loc = metadata.locations.find(l => String(l.id) === selectedArray[0]);
      if (loc) name = disambiguateGymLabel(loc, locationBaseLabel(loc), metadata.locations, locationBaseLabel);
    } else if (dropdownId === 'sa-ms-instructor') {
      const instr = findInstructor(metadata.instructors, selectedArray[0]);
      if (instr) name = disambiguateGymLabel(instr, instructorBaseLabel(instr), metadata.instructors, instructorBaseLabel);
    } else if (dropdownId === 'sa-ms-class-type') {
      // The selection id IS the bucket label (see setupDropdownFilters) — no
      // lookup needed, unlike the other dropdowns where the id is a provider id.
      name = selectedArray[0];
    }
    labelTextEl.textContent = name;
  } else {
    labelTextEl.textContent = formatCopyText(COPY.timetable.selectedMany, {
      count: selectedArray.length, label: labelSingular, plural: selectedArray.length !== 1 ? 's' : '',
    });
  }
}

// Setup multiselect dropdown toggle event bindings
function setupFilterEventListeners() {
  const container = document.getElementById('sa-timetable-filters-container');
  if (!container) return;

  // 1. Toggle open dropdowns on trigger clicks
  container.querySelectorAll('.sa-ms-trigger').forEach(trigger => {
    trigger.onclick = (e) => {
      e.stopPropagation();
      const dropdown = trigger.parentElement;
      const menu = dropdown.querySelector('.sa-ms-menu');
      const arrow = trigger.querySelector('.sa-ms-arrow');
      const isVisible = menu.style.display === 'block';

      // Close all first
      container.querySelectorAll('.sa-ms-menu').forEach(m => m.style.display = 'none');
      container.querySelectorAll('.sa-ms-arrow').forEach(a => a.style.transform = 'rotate(0deg)');

      if (!isVisible) {
        menu.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
        openDropdownId = dropdown.id;
      } else {
        openDropdownId = null;
      }
    };
  });

  // Stop clicks inside dropdowns from propagating and closing the menu
  container.querySelectorAll('.sa-ms-dropdown').forEach(dropdown => {
    dropdown.onclick = (e) => e.stopPropagation();
  });

  // Document listener to close dropdowns when clicking outside
  document.onclick = () => {
    container.querySelectorAll('.sa-ms-menu').forEach(m => m.style.display = 'none');
    container.querySelectorAll('.sa-ms-arrow').forEach(a => a.style.transform = 'rotate(0deg)');
    openDropdownId = null;
  };

  // 2. Options checkbox change listeners
  container.querySelectorAll('.sa-ms-checkbox').forEach(checkbox => {
    checkbox.onchange = (e) => {
      const type = checkbox.getAttribute('data-type');
      const id = checkbox.getAttribute('data-id');
      const isChecked = checkbox.checked;

      if (type === 'gym') {
        if (isChecked) {
          if (!selectedGyms.includes(id)) selectedGyms.push(id);
        } else {
          selectedGyms = selectedGyms.filter(x => x !== id);
        }
        updateTriggerLabel('sa-ms-gym', selectedGyms, COPY.timetable.allGyms, 'Gym');
      } else if (type === 'location') {
        if (isChecked) {
          if (!selectedLocations.includes(id)) selectedLocations.push(id);
        } else {
          selectedLocations = selectedLocations.filter(x => x !== id);
        }
        updateTriggerLabel('sa-ms-location', selectedLocations, COPY.timetable.allLocations, 'Location');
      } else if (type === 'instructor') {
        if (isChecked) {
          if (!selectedInstructors.includes(id)) selectedInstructors.push(id);
        } else {
          selectedInstructors = selectedInstructors.filter(x => x !== id);
        }
        updateTriggerLabel('sa-ms-instructor', selectedInstructors, COPY.timetable.allInstructors, 'Instructor');
      } else if (type === 'class-type') {
        if (isChecked) {
          if (!selectedEventTypes.includes(id)) selectedEventTypes.push(id);
        } else {
          selectedEventTypes = selectedEventTypes.filter(x => x !== id);
        }
        updateTriggerLabel('sa-ms-class-type', selectedEventTypes, COPY.timetable.allTypes, 'Type');
      }

      renderTimetableGrid();
    };
  });

  // 3. Clear button inside individual menus
  container.querySelectorAll('.sa-ms-dropdown').forEach(dropdown => {
    const clearBtn = dropdown.querySelector('.sa-ms-clear-btn');
    if (clearBtn) {
      clearBtn.onclick = (e) => {
        e.stopPropagation();
        const idAttr = dropdown.id;
        dropdown.querySelectorAll('.sa-ms-checkbox').forEach(c => c.checked = false);

        if (idAttr === 'sa-ms-gym') {
          selectedGyms = [];
          updateTriggerLabel('sa-ms-gym', selectedGyms, COPY.timetable.allGyms, 'Gym');
        } else if (idAttr === 'sa-ms-location') {
          selectedLocations = [];
          updateTriggerLabel('sa-ms-location', selectedLocations, COPY.timetable.allLocations, 'Location');
        } else if (idAttr === 'sa-ms-instructor') {
          selectedInstructors = [];
          updateTriggerLabel('sa-ms-instructor', selectedInstructors, COPY.timetable.allInstructors, 'Instructor');
        } else if (idAttr === 'sa-ms-class-type') {
          selectedEventTypes = [];
          updateTriggerLabel('sa-ms-class-type', selectedEventTypes, COPY.timetable.allTypes, 'Type');
        }
        renderTimetableGrid();
      };
    }
  });

  // 4. Global Bookmarked toggle click handler
  const bookmarksFilterBtn = document.getElementById('sa-filter-favorites-only');
  if (bookmarksFilterBtn) {
    bookmarksFilterBtn.onclick = () => {
      showBookmarksOnly = !showBookmarksOnly;
      if (showBookmarksOnly) {
        bookmarksFilterBtn.classList.add('active');
        bookmarksFilterBtn.textContent = COPY.static.bookmarked.replace('♡', '♥');
      } else {
        bookmarksFilterBtn.classList.remove('active');
        bookmarksFilterBtn.textContent = COPY.static.bookmarked;
      }
      renderTimetableGrid();
    };
  }

  // 5. Global Clear All click handler
  const clearAllFiltersBtn = document.getElementById('psycle-btn-clear-all-filters');
  if (clearAllFiltersBtn) {
    clearAllFiltersBtn.onclick = () => {
      selectedGyms = [];
      selectedLocations = [];
      selectedInstructors = [];
      selectedEventTypes = [];
      showBookmarksOnly = false;
      
      container.querySelectorAll('.sa-ms-checkbox').forEach(c => c.checked = false);
      
      updateTriggerLabel('sa-ms-gym', selectedGyms, COPY.timetable.allGyms, 'Gym');
      updateTriggerLabel('sa-ms-location', selectedLocations, COPY.timetable.allLocations, 'Location');
      updateTriggerLabel('sa-ms-instructor', selectedInstructors, COPY.timetable.allInstructors, 'Instructor');
      updateTriggerLabel('sa-ms-class-type', selectedEventTypes, COPY.timetable.allTypes, 'Type');
      
      if (bookmarksFilterBtn) {
        bookmarksFilterBtn.classList.remove('active');
        bookmarksFilterBtn.textContent = COPY.static.bookmarked;
      }

      renderTimetableGrid();
      showToast(COPY.timetable.allFiltersCleared, 'success');
    };
  }

  // 6. Global Save Defaults click handler
  const saveDefaultFiltersBtn = document.getElementById('psycle-btn-save-default-filters');
  let isSavingDefaults = false;
  if (saveDefaultFiltersBtn) {
    saveDefaultFiltersBtn.onclick = async () => {
      if (isSavingDefaults) return;
      if (inSearchScope()) { showToast(COPY.search.saveBlocked, 'warning'); return; }   // search-scope filters are never saved
      isSavingDefaults = true;

      const defaultFilters = {
        gyms: selectedGyms,
        locations: selectedLocations,
        instructors: selectedInstructors,
        eventTypes: selectedEventTypes,
        showBookmarksOnly: showBookmarksOnly
      };

      const originalText = saveDefaultFiltersBtn.innerHTML;
      saveDefaultFiltersBtn.style.cursor = 'not-allowed';
      saveDefaultFiltersBtn.innerHTML = COPY.timetable.savingFilters;

      try {
        if (!guardedSaveDefaults(localStorage, defaultFiltersKey(), defaultFilters, overlayActive)) {
          // Filters that came from a link are never persisted (U4-19): Clear them first.
          showToast(COPY.timetable.overlaySaveBlocked, 'warning');
          isSavingDefaults = false;
          saveDefaultFiltersBtn.innerHTML = originalText;
          saveDefaultFiltersBtn.style.cursor = 'pointer';
          return;
        }
        // Persist to the account so it follows the user across devices. A failed
        // network save is non-fatal: the local copy is kept and re-pushed on next load.
        try {
          await api.updateSettings({ defaultFilters });
          userSettings.defaultFilters = defaultFilters;
        } catch (e) { console.warn('[Timetable] Server save of default filters failed:', e); }
        savedFilterState = savedToState(defaultFilters);
        urlReplaceOnce = true; syncUrlFromState();
        setTimeout(() => {
          saveDefaultFiltersBtn.innerHTML = COPY.timetable.savedFilters;
          saveDefaultFiltersBtn.style.background = 'var(--success)';
          saveDefaultFiltersBtn.style.color = 'var(--on-accent)';
          showToast(COPY.timetable.filtersSaved, 'success');
          
          setTimeout(() => {
            saveDefaultFiltersBtn.innerHTML = originalText;
            saveDefaultFiltersBtn.style.background = '';
            saveDefaultFiltersBtn.style.color = '';
            saveDefaultFiltersBtn.style.cursor = 'pointer';
            isSavingDefaults = false;
          }, 1200);
        }, 300);
      } catch (e) {
        showToast(COPY.timetable.filtersSaveFailed, 'error');
        saveDefaultFiltersBtn.innerHTML = originalText;
        saveDefaultFiltersBtn.style.cursor = 'pointer';
        isSavingDefaults = false;
      }
    };
  }
}

// ── Keyword search (pure logic: ui/timetable-search.js, UI: timetable-search-ui.js) ──
// The index is memoised on the events array + the minute, so typing never
// re-walks thousands of events and a class that has started drops out.
let searchIndexMemo = { events: null, minute: 0, index: null };
function getSearchIndex() {
  const minute = Math.floor(Date.now() / 60000);
  if (searchIndexMemo.events !== timetableEvents || searchIndexMemo.minute !== minute) {
    const nowMs = Date.now();
    const linked = getLinkedGyms() || [];
    searchIndexMemo = {
      events: timetableEvents, minute,
      index: buildSearchIndex(timetableEvents.filter(e => new Date(e.startAt).getTime() >= nowMs), {
        gymNames: (id) => {
          const g = linked.find(x => String(x.gym_id || x.id) === String(id));
          const names = [g?.name || g?.gym_name, g?.shortName].filter(Boolean);
          return names.length ? names : [getGymShortName(id)];
        },
        gymLabel: (id) => getGymShortName(id),
        workoutLabel: (d) => (d ? getDiscipline(String(d)).label : ''),
        displayName: (e) => cleanClassName(e.name || '', e.discipline || ''),
        locationIdOf: (e) => eventLocationId(e),
        locationNameOf: (e) => gymScopedGet(locationMap, eventLocationId(e), e.gymId) || '',
      }),
    };
  }
  return searchIndexMemo.index;
}

// Search has its OWN filter scope (see timetable-search-state.js). The filter
// variables below are simply the "current scope": entering search snapshots the
// normal set and blanks them, so results start unfiltered and any chip the user
// adds edits the search scope; leaving restores the snapshot. Nothing in search
// scope reaches saved defaults (the save handler refuses while in scope).
const currentFilters = () => ({ gyms: selectedGyms, locations: selectedLocations, instructors: selectedInstructors, eventTypes: selectedEventTypes, bookmarks: showBookmarksOnly });
function ensureSearchScope() {
  if (!enterSearchScope(currentFilters())) return;
  const e = emptyFilters();
  selectedGyms = e.gyms; selectedLocations = e.locations; selectedInstructors = e.instructors; selectedEventTypes = e.eventTypes; showBookmarksOnly = false;
}
function restoreFromSearchScope() {
  const snap = leaveSearchScope();
  if (!snap) return;
  selectedGyms = snap.gyms; selectedLocations = snap.locations; selectedInstructors = snap.instructors; selectedEventTypes = snap.eventTypes; showBookmarksOnly = snap.bookmarks;
}
// Leave search entirely: restore the normal filters exactly, drop the text.
export function exitSearch() {
  restoreFromSearchScope();
  if (getSearchQuery()) setSearchQuery('');   // its listener repaints
  else renderTimetableGrid('search');
}

// A suggestion becomes a filter on the EXISTING system, in the search scope.
function applySearchPick(item) {
  ensureSearchScope();
  const add = (arr, v) => (arr.includes(String(v)) ? arr : [...arr, String(v)]);
  if (item.type === 'instructor') selectedInstructors = add(selectedInstructors, item.gymId ? instructorToken(item.gymId, item.id) : item.id);
  else if (item.type === 'location') selectedLocations = add(selectedLocations, item.id);
  else if (item.type === 'gym') selectedGyms = add(selectedGyms, item.id);
  else if (item.type === 'workout') selectedEventTypes = add(selectedEventTypes, item.id);
  renderTimetableGrid('search');
}

let searchSubscribed = false;
function subscribeSearch() {
  if (searchSubscribed) return;
  searchSubscribed = true;
  // reason 'search' = paint from memory. The default 'interaction' render awaits
  // two API calls (auto-book queue, studio prefs) before drawing; on the dev twin
  // that was ~1s of dead UI after every search tap. Search changes no server state.
  onSearchChange((q) => {
    if (q) ensureSearchScope();
    else if (inSearchScope() && filtersAreEmpty(currentFilters())) restoreFromSearchScope();   // nothing left to search by
    renderTimetableGrid('search');
  });
}

export { passesDisciplineFilter } from './cards';

let deferredFilterTimer = null;

function scheduleDeferredFilterRender() {
  if (deferredFilterTimer) clearTimeout(deferredFilterTimer);
  deferredFilterTimer = setTimeout(() => {
    deferredFilterTimer = null;
    renderTimetableGrid('filter');
  }, 100);
}

export function flushDeferredFilterRender() {
  if (deferredFilterTimer) {
    clearTimeout(deferredFilterTimer);
    deferredFilterTimer = null;
    renderTimetableGrid('filter');
  }
}

// Workout bucket label for a class group. Gyms whose class types carry
// duration/audience variants ("Recovery 30m") fold them into one bucket;
// Psycle's (rolling-weekly) group is left exactly as the provider names it.
function discLabel(group, gymId) {
  const g = String(group);
  return getDiscipline(gymId && !isRollingWeeklyGym(gymId) ? stripVariantSuffix(g) : g).label;
}

function countMatchingEventsQuick() {
  const now = new Date();
  let count = 0;
  for (let i = 0; i < timetableEvents.length; i++) {
    const e = timetableEvents[i];
    if (new Date(e.startAt) < now) continue;
    if (selectedGyms.length > 0 && (!e.gymId || !selectedGyms.includes(String(e.gymId)))) continue;
    if (!passesLocationFilter(selectedLocations, eventLocationId(e))) continue;
    if (!passesInstructorFilter(selectedInstructors, e.gymId, (e.instructors || []).map(x => x.id))) continue;
    if (selectedEventTypes.length > 0) {
      const et = metadata.eventTypes.find(t => sameId(t.id, e.classTypeId) && (!e.gymId || t.gymId === e.gymId));
      const rawGroup = e.discipline ?? (et?.group != null ? String(et.group) : null);
      const etGroupId = rawGroup != null ? discLabel(String(rawGroup), e.gymId) : null;
      if (!passesDisciplineFilter(selectedEventTypes, etGroupId)) continue;
    }
    if (showBookmarksOnly) {
      const identifier = generateBookmarkIdentifier(e);
      if (!canForGym('bookmarks', e.gymId)) continue;
      const bookmarks = profileForGym(e.gymId)?.metafields?.public?.bookmarks?.events || [];
      if (!bookmarks.includes(identifier)) continue;
    }
    count++;
  }
  return count;
}

// U2-5: adapter between this module's filter state and ui/filter-rail.js.
// The rail owns no state; every mutation goes through here, then re-renders.
function buildFilterRailCtx(eventsExcluding, resultCount) {
  const arrays = {
    gyms: () => selectedGyms, locations: () => selectedLocations,
    instructors: () => selectedInstructors, eventTypes: () => selectedEventTypes,
  };
  const assign = (key, val) => {
    if (key === 'gyms') selectedGyms = val;
    else if (key === 'locations') selectedLocations = val;
    else if (key === 'instructors') selectedInstructors = val;
    else if (key === 'eventTypes') selectedEventTypes = val;
  };
  const linked = getLinkedGyms() || [];
  // The gym switch is the top of the hierarchy: with any gym on, every list
  // below offers only that gym's options (and stale picks are pruned on toggle).
  const gymOk = (gid) => selectedGyms.length === 0 || selectedGyms.includes(String(gid));
  const workouts = buildWorkoutOptions({
    eventTypes: metadata.eventTypes, events: timetableEvents, gymOk,
    labelOf: (g, gid) => discLabel(g, gid),
  });
  const gymOrder = linked.map(g => g.gym_id || g.id);
  const locations = metadata.locations.filter(l => gymOk(l.gymId)).sort((a, b) =>
    gymOrder.indexOf(a.gymId) - gymOrder.indexOf(b.gymId) || locationBaseLabel(a).localeCompare(locationBaseLabel(b)));
  const rerender = () => renderTimetableGrid('filter');

  const syncQuick = (c) => {
    c.state.gyms = selectedGyms;
    c.state.locations = selectedLocations;
    c.state.instructors = selectedInstructors;
    c.state.eventTypes = selectedEventTypes;
    c.state.bookmarks = showBookmarksOnly;
    const gOk = (gid) => selectedGyms.length === 0 || selectedGyms.includes(String(gid));
    const gOrder = linked.map(g => g.gym_id || g.id);
    c.locations = metadata.locations.filter(l => gOk(l.gymId)).sort((a, b) =>
      gOrder.indexOf(a.gymId) - gOrder.indexOf(b.gymId) || locationBaseLabel(a).localeCompare(locationBaseLabel(b)));
    c.workouts = buildWorkoutOptions({
      eventTypes: metadata.eventTypes, events: timetableEvents, gymOk: gOk,
      labelOf: (g, gid) => discLabel(g, gid),
    });
    c.instructors = metadata.instructors.filter(i => gOk(i.gymId)).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(i => ({ ...i, rawId: i.id, id: instructorToken(i.gymId, i.id) }));
    c.resultCount = countMatchingEventsQuick();
    syncFilterSheetState(c);
    scheduleDeferredFilterRender();
  };

  // Drop location/instructor/workout picks that belong to a gym that is now filtered out.
  const pruneToGyms = () => {
    const gymOf = (list, i) => list.find(x => String(x.id) === i)?.gymId;
    selectedLocations = selectedLocations.filter(i => gymOk(gymOf(metadata.locations, i)));
    selectedInstructors = pruneInstructorSelection(selectedInstructors, gymOk);
    selectedEventTypes = selectedEventTypes.filter(l => metadata.eventTypes.some(t => t.group && passesDisciplineFilter([discLabel(t.group, t.gymId)], l) && gymOk(t.gymId)));
  };

  const ctx = {
    state: {
      gyms: selectedGyms, locations: selectedLocations, instructors: selectedInstructors,
      eventTypes: selectedEventTypes, bookmarks: showBookmarksOnly,
    },
    gyms: linked.map(g => ({ id: g.gym_id || g.id, name: g.gym_name || g.name })),
    locations,
    resultCount,
    locationAlias: (l) => getLocationAlias(l.gymId, locationBaseLabel(l)),
    locationLabel: (l) => disambiguateGymLabel(l, locationBaseLabel(l), metadata.locations, locationBaseLabel),
    workouts,
    // Rail rows carry the gym-qualified token as `id`, so a pick never matches another gym's same provider id.
    instructors: metadata.instructors.filter(i => gymOk(i.gymId)).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(i => ({ ...i, rawId: i.id, id: instructorToken(i.gymId, i.id) })),
    openSearch,
    searchActive: inSearchScope(),
    canBookmark: false, // Temporarily hidden on front-end until universal cross-gym favourite class solution
    flush: flushDeferredFilterRender,
    // Nothing picked = no filter (every chip shows unselected); picking chips
    // narrows to just those. OR within a section, AND across sections.
    isOn: (key, id) => arrays[key]().includes(String(id)),
    toggle: (key, id) => {
      const cur = arrays[key]();
      const sid = String(id);   // instructors: the id IS a gymId:id token (see instructor-filter.js)
      assign(key, cur.includes(sid) ? cur.filter(x => x !== sid) : [...cur, sid]);
      if (key === 'gyms' && selectedGyms.length) pruneToGyms();
      if (isFilterSheetOpen()) {
        syncQuick(ctx);
      } else {
        rerender();
      }
    },
    // Mobile quick-selector: in-memory only (never touches saved defaults, which change on Save only).
    allGyms: getCatalogueGyms(),
    setGymQuick: (gymId) => {
      // Unlinked gym: nothing to filter to. Least invasive: leave filters alone and say how to connect it.
      if (!gymOrder.includes(String(gymId))) {
        showToast(formatCopyText(COPY.filters.gymQuickConnectHint, { name: getCatalogueGyms().find(g => g.id === String(gymId))?.name || String(gymId) }), 'info');
        return;
      }
      selectedGyms = nextGymSelection(selectedGyms, gymOrder, gymId);
      if (selectedGyms.length) pruneToGyms();
      if (isFilterSheetOpen()) {
        syncQuick(ctx);
      } else {
        rerender();
      }
    },
    clear: (key) => {
      if (key === 'gyms') { selectedGyms = []; selectedLocations = []; } else assign(key, []);
      if (isFilterSheetOpen()) {
        syncQuick(ctx);
      } else {
        rerender();
      }
    },
    clearAll: () => {
      selectedGyms = []; selectedLocations = []; selectedInstructors = []; selectedEventTypes = [];
      showBookmarksOnly = false;
      if (isFilterSheetOpen()) {
        syncQuick(ctx);
      } else {
        rerender();
      }
    },
    toggleBookmarks: () => {
      showBookmarksOnly = !showBookmarksOnly;
      if (isFilterSheetOpen()) {
        syncQuick(ctx);
      } else {
        rerender();
      }
    },
    save: () => document.getElementById('psycle-btn-save-default-filters')?.click(),
  };
  return ctx;
}

// Instructor picks belong to ONE gym (locations are strict: see passesLocationFilter in lib.js).
// A location or instructor pick belongs to ONE gym. It narrows that gym's
// classes only — picking OC (Psycle) must not hide every JAB class, none of
// which could ever match it. A gym with no picks of its own passes everything.
// (Workout picks stay global: the label is shared across gyms by design.)
function passesGymScoped(selected, pool, gymId, value) {
  if (!selected.length) return true;
  const mine = selected.filter(id => pool.some(x => String(x.id) === id && (!gymId || x.gymId === gymId)));
  if (!mine.length) return true;
  return value != null && value !== '' && mine.includes(String(value));
}

function eventLocationId(e) {
  const studioObj = e.studio || gymScopedGet(studioObjMap, e.studioId, e.gymId);
  return String(studioObj?.locationId || e.locationId || '');
}

// Saved defaults from the old "everything ticked" model list EVERY option, which
// now means a real filter that changes nothing. Fold those back to "no filter"
// once, at load. Never runs again, so a user who ticks every chip on purpose
// keeps their explicit picks.
let storedFiltersNormalized = false;
function normalizeStoredFilters() {
  if (storedFiltersNormalized || !metadata.locations.length) return;
  storedFiltersNormalized = true;
  // Legacy saved defaults hold BARE instructor ids; attribute them to a gym now that metadata is loaded.
  // Never drops a pick; rewrites the stored default only with the migrated values.
  if (hasLegacyInstructors(selectedInstructors)) {
    selectedInstructors = migrateInstructorSelection(selectedInstructors, metadata.instructors, getDefaultGymId());
    try {
      const k = defaultFiltersKey(); const raw = localStorage.getItem(k);
      if (raw) { const o = JSON.parse(raw); if (hasLegacyInstructors(o.instructors)) { o.instructors = migrateInstructorSelection(o.instructors, metadata.instructors, getDefaultGymId()); localStorage.setItem(k, JSON.stringify(o)); } }
    } catch { /* storage unavailable: in-memory migration still applies */ }
  }
  const coversAll = (picked, universe) => picked.length > 0 && universe.every(id => picked.includes(id));
  const gyms = (getLinkedGyms() || []).map(g => String(g.gym_id || g.id));
  if (coversAll(selectedGyms, gyms)) selectedGyms = [];
  if (coversAll(selectedLocations, metadata.locations.map(l => String(l.id)))) selectedLocations = [];
  if (coversAll(selectedInstructors, metadata.instructors.map(i => instructorToken(i.gymId, i.id)))) selectedInstructors = [];
  const labels = [...new Set(metadata.eventTypes.filter(t => t.group).map(t => discLabel(t.group, t.gymId)))];
  if (coversAll(selectedEventTypes, labels)) selectedEventTypes = [];
  savedFilterState = copyOf(currentFilterState());   // saved set, after the one-time fold
}

// Core timetable grid and date selector rendering
export async function renderTimetableGrid(reason = 'interaction') {
  const renderStartedAt = timetablePerfNow();
  const ttGrid = document.getElementById('sa-timetable-grid');
  if (!ttGrid) return;

  // A render that arrives while the first fetch is still running (a credits or
  // eligibility repaint, a resize, a tab switch) has no events to draw and used
  // to wipe the loading skeleton for an empty grid, leaving a blank page until
  // the network answered. Keep the skeleton up until there is something to show.
  if (isPrefetching && timetableEvents.length === 0) {
    if (!ttGrid.querySelector('.psycle-skeleton, [data-skeleton]')) ttGrid.innerHTML = renderTimetableSkeleton();
    return;
  }

  // Compute interdependent dropdown options: each filter shows only values present in events
  // that match ALL OTHER active filters (but not the filter for that dropdown itself).
  normalizeStoredFilters();
  if (pendingUrlTimetable && metadata.locations.length) {
    const t = pendingUrlTimetable; pendingUrlTimetable = null;
    applyUrlTimetable(t);
  }
  const now = new Date();
  const futureEvents = timetableEvents.filter(e => new Date(e.startAt) >= now);

  function eventsExcluding(excludeFilter) {
    return futureEvents.filter(e => {
      if (excludeFilter !== 'gym' && selectedGyms.length > 0) {
        if (!e.gymId || !selectedGyms.includes(String(e.gymId))) return false;
      }
      if (excludeFilter !== 'location' && !passesLocationFilter(selectedLocations, eventLocationId(e))) return false;
      if (excludeFilter !== 'instructor' && !passesInstructorFilter(selectedInstructors, e.gymId, (e.instructors || []).map(x => x.id))) return false;
      if (excludeFilter !== 'class-type' && selectedEventTypes.length > 0) {
        const et = metadata.eventTypes.find(t => sameId(t.id, e.classTypeId) && (!e.gymId || t.gymId === e.gymId));
        // Bucketed the same way the filter list itself is built (see
        // setupDropdownFilters) — a selected "Boxing" must match any event
        // whose specific class type buckets to Boxing, not just one literal
        // string.
        const etGroupId = (et?.group ?? e.discipline) != null ? discLabel(String(et?.group ?? e.discipline), e.gymId) : null;
        if (!passesDisciplineFilter(selectedEventTypes, etGroupId)) return false;
      }
      return true;
    });
  }

  const locationIds = new Set(eventsExcluding('location').map(e => {
    const studio = metadata.studios.find(s => sameId(s.id, e.studioId) && (!e.gymId || s.gymId === e.gymId));
    return studio ? studio.locationId : null;
  }).filter(Boolean));
  const instructorIds = new Set(eventsExcluding('instructor').map(e => e.instructors?.[0]?.id).filter(Boolean));
  const classTypeIds = new Set(eventsExcluding('class-type').map(e => e.classTypeId).filter(Boolean));

  setupDropdownFilters({ locationIds, instructorIds, classTypeIds });

  // Load auto bookings to check Scheduled indicator
  const prerequisitesStartedAt = timetablePerfNow();
  let autoBookedIds = new Set();
  const applyAutoBookings = (autoBookings = []) => {
    const list = autoBookings.data || autoBookings || [];
    list.forEach(x => {
      const id = x.event_id || x.eventId;
      if (id != null) {
        autoBookedIds.add(id);
        autoBookedIds.add(Number(id));
        autoBookedIds.add(String(id));
      }
    });
  };

  applyAutoBookings(cache.autoBookings || []);

  // Refresh the live shared studio preference maps so each row can synchronously
  // decide whether the primary action is Quick-Book (prefs exist) or Book.
  studioPrefsMap = cache.studioPrefs || studioPrefsMap || {};

  // Cache/network refresh renders already have current action state from
  // prefetchTimetableData(). Interaction renders still refresh it, but in
  // parallel rather than serially. This keeps a warm cached row paint free of
  // API/IndexedDB prerequisites while retaining mutation correctness.
  if (reason === 'interaction') {
    try {
      const [autoBookings, preferences] = await Promise.all([
        api.getAutoBookings(),
        api.getStudioPreferences(),
      ]);
      cache.autoBookings = autoBookings || [];
      cache.studioPrefs = preferences || {};
      autoBookedIds = new Set();
      applyAutoBookings(cache.autoBookings);
      studioPrefsMap = cache.studioPrefs;
    } catch (err) {
      console.warn('[Timetable] Failed to refresh row action state:', err.message);
    }
  }
  recordTimetableTiming('render-prerequisites', prerequisitesStartedAt, {
    reason,
    source: reason === 'interaction' ? 'refreshed' : 'memory',
  });

  const domStartedAt = timetablePerfNow();

  // 1. Filter events by selected dropdown metadata arrays
  const filteredEvents = timetableEvents.filter(e => {
    // Filter out past classes
    if (new Date(e.startAt) < new Date()) return false;

    // Filter by Gym
    if (selectedGyms.length > 0) {
      if (!e.gymId || !selectedGyms.includes(String(e.gymId))) return false;
    }
    // Filter by Location
    if (!passesLocationFilter(selectedLocations, eventLocationId(e))) return false;
    // Filter by Instructor
    if (!passesInstructorFilter(selectedInstructors, e.gymId, (e.instructors || []).map(x => x.id))) return false;
    // Filter by Class Type Group ID
    if (selectedEventTypes.length > 0) {
      // `discipline` IS the normalized group. Fall back to the metadata lookup
      // for events whose discipline the provider didn't populate. Bucketed
      // the same way the filter list is built (setupDropdownFilters) — a
      // selected "Boxing" must match any event whose specific class type
      // buckets to Boxing, not just one literal string.
      const et = metadata.eventTypes.find(t => sameId(t.id, e.classTypeId) && (!e.gymId || t.gymId === e.gymId));
      const rawGroup = e.discipline ?? (et?.group != null ? String(et.group) : null);
      const etGroupId = rawGroup != null ? discLabel(String(rawGroup), e.gymId) : null;
      if (!passesDisciplineFilter(selectedEventTypes, etGroupId)) return false;
    }
    // Filter by Bookmarked Only
    if (showBookmarksOnly) {
      const identifier = generateBookmarkIdentifier(e);
      if (!canForGym('bookmarks', e.gymId)) return false; // gym has no favourites concept → nothing can match "favourites only"
      const bookmarks = profileForGym(e.gymId)?.metafields?.public?.bookmarks?.events || [];
      if (!bookmarks.includes(identifier)) return false;
    }
    return true;
  });

  // 2. Sort remaining filtered events chronologically
  const sortedEvents = [...filteredEvents].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  // 2b. Keyword search (Enter on free text): a flat, chronological list across
  // every loaded week, narrowed by the same filters. It replaces the day view
  // only; nothing here touches saved filter defaults.
  subscribeSearch();
  const searchText = getSearchQuery();
  const searchTokens = tokenize(searchText);
  const searching = inSearchScope();
  let searchResults = null;
  if (searching) {
    const keep = new Set(filteredEvents.map(e => `${e.gymId}:${e.id}`));
    // No text (filter-only search) lists everything the scope's filters allow.
    searchResults = searchTokens.length
      ? searchEvents(getSearchIndex(), searchText).filter(e => keep.has(`${e.gymId}:${e.id}`))
      : sortedEvents;
  }

  // 3. Extract unique dates containing matching events
  const daysWithEvents = Array.from(new Set(sortedEvents.map(e => dayKeyInZone(e.startAt, zoneFor(e))))).sort();

  // 4. Validate/Update selected date state
  let defaultDay = null;
  if (daysWithEvents.length > 0) {
    // "Today" is the gym-local day: check each zone present in the list.
    const todays = [...new Set(sortedEvents.map(zoneFor))].map(z => nowInZone(z).toISODate());
    defaultDay = todays.find(t => daysWithEvents.includes(t)) || daysWithEvents[0];
    if (!selectedTimetableDate || !daysWithEvents.includes(selectedTimetableDate)) {
      selectedTimetableDate = defaultDay;
    }
  } else {
    selectedTimetableDate = null;
  }
  // U4-19: reflect day + filters in the URL, and show/hide the deep-link banner.
  lastDefaultDay = defaultDay;
  syncUrlFromState(defaultDay);
  renderOverlayBanner();

  // 5. Render Horizontal Date Carousel
  const carousel = document.getElementById('sa-timetable-carousel');
  if (carousel) carousel.hidden = searching;   // a day strip means nothing for a cross-day list
  if (carousel && searching) {
    // leave the strip as it was
  } else if (carousel && WEEK_STRIP_DATE_SELECTOR) {
    renderWeekStrip(carousel, daysWithEvents);
  } else if (carousel) {
    carousel.innerHTML = '';
    
    if (daysWithEvents.length === 0) {
      carousel.innerHTML = `<div style="color: var(--text-secondary); font-size: 12px; font-style: italic; padding: 8px;">${COPY.timetable.noDates}</div>`;
    } else {
      daysWithEvents.forEach(dayStr => {
        const d = new Date(dayStr);
        const isSelected = dayStr === selectedTimetableDate;
        const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' });
        const dayNum = d.getDate();
        const monthName = noSept(d.toLocaleDateString('en-GB', { month: 'short' }));

        const pill = document.createElement('div');
        pill.className = `sa-day-pill ${isSelected ? 'active' : ''}`;
        pill.innerHTML = `
          <span class="day-name">${dayName}</span>
          <div style="display: flex; align-items: baseline; gap: 4px; line-height: 1;">
            <span class="day-num">${dayNum}</span>
            <span class="day-month">${monthName}</span>
          </div>
        `;
        pill.onclick = () => {
          // Direction of travel: a LATER day slides the list out to the left and the new one in from the right.
          const dir = dayStr > selectedTimetableDate ? 1 : (dayStr < selectedTimetableDate ? -1 : 0);
          selectedTimetableDate = dayStr;
          carousel.querySelectorAll('.sa-day-pill').forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          animateDateChange(dir, () => renderTimetableGrid());
        };
        carousel.appendChild(pill);
      });
    }
  }

  // Remove any body-appended mobile menus from the previous render, then inject
  // the mobile filter ellipsis + its menu. Both run BEFORE the table render (and
  // before the no-results early return) so the filter menu survives the purge
  // and is available even when no classes match the current filters.
  document.querySelectorAll('body > .sa-mobile-menu').forEach(m => m.remove());
  if (window.matchMedia('(max-width: 768px)').matches) {
    document.getElementById('sa-mobile-filter-trigger')?.remove();
    renderFilterRail(buildFilterRailCtx(eventsExcluding, filteredEvents.length));
  } else {
    removeFilterRail();
    // Found 2026-09-02: the trigger was only ever REMOVED at the top of
    // injectMobileFilterHamburger(), which only runs on this branch — so a
    // resize from mobile to desktop left the mobile ellipsis stranded in the
    // desktop filter row: present, unstyled for the wider layout, and its
    // click handler pointing at a menu of mobile-only filter controls that
    // no longer make sense next to the real dropdowns now visible.
    document.getElementById('sa-mobile-filter-trigger')?.remove();
  }

  ensureSearchUi({
    getIndex: getSearchIndex,
    isLoading: () => isPrefetching && timetableEvents.length === 0,
    applyPick: applySearchPick,
  });

  // 6. Render the Class Timetable Grid Table
  if (!selectedTimetableDate && !searching) {
    ttGrid.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); padding: 40px; font-style: italic;">
        ${COPY.timetable.noClasses}
      </div>
    `;
    return;
  }

  const finalEvents = searching ? searchResults : sortedEvents.filter(e => dayKeyInZone(e.startAt, zoneFor(e)) === selectedTimetableDate);

  // The outer #sa-timetable-grid (.sa-timetable-list) is the single scroll
  // container — see initTimetableTab for the pull-to-refresh wiring. The inner
  // container must NOT scroll, otherwise iOS has two nested scrollers and the
  // outer grid's scrollTop stays 0 (breaking the at-top check for pull-to-refresh).
  const fullDateHtml = searching
    ? `<div class="sa-tt-searchhead" role="status"><span class="sth-main"><span class="sth-ico" aria-hidden="true">${icon('search', 16)}</span><span class="sth-title" title="${escapeHtml(searchText)}">${escapeHtml(searchTokens.length ? formatCopyText(COPY.search.resultsFor, { text: searchText }) : COPY.search.filteredResults)}</span></span>`
      + `<button type="button" class="sth-clear" id="sa-search-clear">${COPY.search.clear}</button>`
      + `<span class="sth-count">${finalEvents.length === 1 ? COPY.search.resultsOne : formatCopyText(COPY.search.results, { count: finalEvents.length })}</span></div>`
      + (finalEvents.length ? '' : `<div class="sa-tt-searchnone">${escapeHtml(formatCopyText(COPY.search.none, { text: searchText }))}</div>`)
    : WEEK_STRIP_DATE_SELECTOR
    ? `<div class="sa-tt-fulldate">${formatFullDate(selectedTimetableDate)}</div>`
    : '';
  ttGrid.innerHTML = `${fullDateHtml}
    <div class="sa-table-container">
      <table class="sa-table" style="width: 100%; border-collapse: collapse; text-align: left; table-layout: fixed;">
        <thead>
          <tr>
            <th style="width: 7%;">${COPY.timetable.timeColumn}</th>
            <th style="width: 8%;">${COPY.timetable.gymColumn}</th>
            <th style="width: 27%;">${COPY.timetable.classColumn}</th>
            <th style="width: 12%;">${COPY.timetable.instructorColumn}</th>
            <th style="width: 15%;">${COPY.timetable.locationStudioColumn}</th>
            <th style="width: 11%;">${COPY.timetable.statusColumn}</th>
            <th style="width: 20%; text-align: right;">${COPY.timetable.actionsColumn}</th>
          </tr>
        </thead>
        <tbody id="sa-timetable-rows"></tbody>
      </table>
    </div>
  `;

  const tbody = ttGrid.querySelector('#sa-timetable-rows');
  const clearBtn = ttGrid.querySelector('#sa-search-clear');
  if (clearBtn) clearBtn.onclick = () => exitSearch();
  if (searching && !finalEvents.length) ttGrid.querySelector('.sa-table-container')?.remove();
  let lastSearchDay = null;

  finalEvents.forEach(event => {
    if (searching) {
      const dayKey = dayKeyInZone(event.startAt, zoneFor(event));
      if (dayKey !== lastSearchDay) {
        lastSearchDay = dayKey;
        const h = document.createElement('tr');
        h.className = 'sa-search-day';
        h.innerHTML = `<td colspan="${window.matchMedia('(max-width: 768px)').matches ? 6 : 7}">${escapeHtml(formatFullDate(dayKey))}</td>`;
        tbody.appendChild(h);
      }
    }
    // Primary: use embedded objects from event payload (CodexFit includes these)
    // Fallback: use Maps built from merged metadata (Maps include both int and string keys)
    const studioObj = event.studio || gymScopedGet(studioObjMap, event.studioId, event.gymId);
    const studioName = studioObj?.name || gymScopedGet(studioMap, event.studioId, event.gymId) || '';
    const locName = studioObj?.location?.name
      || gymScopedGet(locationMap, studioObj?.locationId, event.gymId)
      || gymScopedGet(locationMap, event.locationId, event.gymId)
      || '';
    const instrName = event.instructors?.[0]?.name || event.instructor?.name
      || gymScopedGet(instructorMap, event.instructors?.[0]?.id, event.gymId) || '';
    const eventTypeName = event.name || gymScopedGet(eventTypeMap, event.classTypeId, event.gymId) || 'Class';
    const className = event.name || eventTypeName;
    // Group name is the short type label (e.g., "Ride", "Barre", "Yoga")
    const groupName = event.discipline
      || gymScopedGet(eventTypeGroupMap, event.classTypeId, event.gymId)
      || 'Class';
    // Drop the discipline prefix the provider repeats into every class name, and
    // normalise SHOUTING. This used to handle only "TYPE: " (colon + space),
    // which left JAB's "TRAIN - Upper (Focus)" and "BOXING Core & Power"
    // untouched — the discipline pill beside the name then said the same word
    // twice while the name itself was squeezed into what was left.
    const strippedClassName = cleanClassName(className, groupName);

    const startDate = new Date(event.startAt);
    const timeStr = formatInZone(event.startAt, zoneFor(event)).timeLabel;

    // Cutoff status calculation (instant comparison; zone-free)
    const classRelease = getClassReleaseTime(event, userSettings);
    const now = DateTime.now();
    const isLive = event.alwaysBookable ? true : (classRelease ? now >= classRelease : true);
    const isFullyBooked = !!event.isFull;
    const canWaitlist = !isFullWithoutWaitlist(event);

    const isBooked = userBookings().some(b => matchesEvent(b, event));
    const isOnWaitlist = userWaitlists().some(w => matchesEvent(w, event));

    const availableSpots = (typeof event.capacity === 'number' && typeof (event.capacity != null && event.availableCount != null ? event.capacity - event.availableCount : undefined) === 'number')
      ? Math.max(0, event.capacity - (event.capacity != null && event.availableCount != null ? event.capacity - event.availableCount : undefined))
      : null;
    const spotsText = availableSpots !== null ? `${availableSpots} / ${event.capacity}` : 'Open';

    const identifier = generateBookmarkIdentifier(event);
    // Bookmarks live in CodexFit profile metafields. A gym without the
    // capability has none — don't reach into a provider-shaped blob for them.
    const bookmarks = canForGym('bookmarks', event.gymId) ? (profileForGym(event.gymId)?.metafields?.public?.bookmarks?.events || []) : [];
    const isBookmarked = bookmarks.includes(identifier);
    const heartChar = isBookmarked ? '♥' : '♡';
    const heartClass = isBookmarked ? 'sa-timetable-heart bookmarked' : 'sa-timetable-heart unbookmarked';

    // ── Status badge (kept as a restyled column) + shared action model ──
    let statusBadge = '';
    let rowClass = 'sa-table-row';
    let bookingId = null, isPenalty = false, slotsBookedCount = 0, waitlistId = null, graceDeadline = null;
    const hasCredit = hasUsableCredit(event);

    const isScheduled = autoBookedIds.has(event.id) || autoBookedIds.has(Number(event.id)) || autoBookedIds.has(String(event.id));

    if (!isLive) {
      if (isScheduled) {
        rowClass = 'sa-table-row row-beyond-cutoff row-scheduled';
        statusBadge = `<span class="badge-pill scheduled sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}">${pulseIcon(12)}${COPY.timetable.autoBook.toUpperCase()}</span>`;
      } else {
        rowClass = 'sa-table-row row-beyond-cutoff';
        statusBadge = `<span class="badge-pill not-live sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}">${COPY.timetable.notLive}</span>`;
      }
    } else if (isBooked) {
      const eventBookings = userBookings().filter(b => matchesEvent(b, event));
      slotsBookedCount = eventBookings.length;
      statusBadge = `<span class="badge-pill yes sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">${COPY.timetable.booked}${slotsBookedCount > 1 ? ` (${slotsBookedCount})` : ''}</span>`;
      if (slotsBookedCount === 1) {
        bookingId = eventBookings[0].bookingId ?? eventBookings[0].id;
        const bookedAt = eventBookings[0].bookedAt ?? eventBookings[0].booked_at;
        const diffHours = (startDate - new Date()) / (1000 * 60 * 60);
        isPenalty = diffHours < 12 && diffHours > 0;
        if (bookedAt && isInGracePeriod(bookedAt)) {
          graceDeadline = new Date(bookedAt).getTime() + GRACE_PERIOD_MS;
        }
      }
    } else if (isOnWaitlist) {
      statusBadge = `<span class="badge-pill waitlisted sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">${COPY.timetable.waitlisted}</span>`;
      const waitlistEntry = userWaitlists().find(w => matchesEvent(w, event));
      // C2-2 fix (2026-09-26): this read `waitlistEntry.id`, a field that has
      // never existed on a NormalizedBooking (it's `bookingId` — see base.js's
      // doc comment) — so `waitlistId` was always undefined and the "Leave
      // WL" button never rendered (buildActionModel below falls through to a
      // disabled "On Waitlist" pill whenever `waitlistId` is falsy). The
      // provider's leaveWaitlist() takes the CLASS event id and resolves the
      // waitlist row internally (see codexfit.js/marianatek.js), so this
      // passes `event.id`, not any field off the waitlist entry itself.
      if (waitlistEntry) waitlistId = event.id;
    } else if (isFullyBooked) {
      statusBadge = canWaitlist
        ? `<span class="badge-pill waitlist-open sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">${COPY.timetable.waitlist}</span>`
        : `<span class="badge-pill no fully-booked sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}">${COPY.timetable.full}</span>`;
    } else if (!hasCredit) {
      // Short label in the pill, full reason in the tooltip — the column is
      // narrow and "NO CREDITS AVAILABLE" spends all of it restating "no".
      // NO badge here beyond the occupancy. The row's primary action already
      // says "Buy Credits", so a "No credits" pill beside it is the same fact
      // twice — and it was spending the narrowest column in the table to do it.
      // The reason still reaches the user: it's the button's tooltip.
      statusBadge = `<span class="badge-pill yes sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;" title="${escapeHtml(getIneligibleReason(event.gymId) || COPY.timetable.noCredits)}">${spotsText}</span>`;
    } else {
      statusBadge = `<span class="badge-pill yes sa-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">${spotsText}</span>`;
    }

    const actionModel = buildActionModel(event, {
      isLive, isBooked, isOnWaitlist, isFullyBooked, canWaitlist, hasCredit,
      isScheduled,
      bookingId, isPenalty, slotsBookedCount, waitlistId, graceDeadline,
    });

    // === MOBILE TIMETABLE — PWA MOBILE LAYOUT (added Jun 2026; delete this block to revert) ===
    if (window.matchMedia('(max-width: 768px)').matches) {
      tbody.appendChild(buildMobileClassRow(event, {
        timeStr, groupName, strippedClassName, instrName, locName,
        isBookmarked, heartChar, heartClass, rowClass
      }, actionModel));
      return; // skip desktop rendering for this row
    }
    // === END MOBILE TIMETABLE BLOCK ===

    const row = document.createElement('tr');
    row.className = rowClass;
    row.setAttribute('data-gym', event.gymId || getDefaultGymId());
    // Identity and layout kind on the row itself. Without these a rendered row
    // cannot be traced back to its event from the DOM, which made verifying
    // per-class behaviour ("is this FCFS?") impossible from outside the app —
    // and layoutFormat is per CLASS, not per studio: JAB's BOXING room runs
    // both first-come-first-serve and pick-a-spot classes, so inferring it from
    // the studio is wrong for half of them.
    row.setAttribute('data-event-id', event.id);
    if (event.layoutFormat) row.setAttribute('data-layout-format', event.layoutFormat);
    row.innerHTML = `
      <td class="col-time"><strong>${timeStr}</strong></td>
      <td class="col-gym">${gymChip(event.gymId)}</td>
      <td class="col-class">
        <div class="sa-tt-class-cell">
          ${canForGym('bookmarks', event.gymId) ? `<span class="${heartClass}" data-event-id="${event.id}" title="${isBookmarked ? COPY.timetable.removeBookmark : COPY.timetable.bookmarkClass}">${heartChar}</span>` : ''}
          ${disciplineTag(groupName)}
          <span class="sa-tt-class-name">${strippedClassName}</span>
        </div>
      </td>
      <td class="col-instructor">${instrName ? `<span class="sa-instructor-hover" ${instructorHoverAttrs(event.instructors?.[0], event.gymId, instrName)}>${instrName}</span>` : ''}</td>
      ${/* MID-WIDTH COLUMN: instructor + top-level location only ("SW1",
           "Oxford Circus"), with the specific studio dropped — at that width
           the studio is the least useful thing on the row and the most
           expensive, since it forces a second line.
           Always rendered; CSS shows exactly one of {instructor+location} or
           {this} at any width, so a resize needs no re-render. */ ''}
      <td class="col-who-where">
        ${instrName ? `<span class="sa-ww-who sa-instructor-hover" ${instructorHoverAttrs(event.instructors?.[0], event.gymId, instrName)}>${instrName}</span>` : ''}
        ${locName ? `<span class="sa-ww-loc">${trimLocation(locName, getGymShortName(event.gymId))}</span>` : ''}
      </td>
      <td class="col-location">
        <span style="font-weight:600; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${trimLocation(locName, getGymShortName(event.gymId))}</span>
        ${studioName ? `<span style="font-size:12px; color:var(--text-secondary); display:block; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${displayStudioName(event.gymId, studioName)}</span>` : ''}
      </td>
      <td class="col-status">${statusBadge}</td>
      <td class="col-actions"></td>
    `;

    row.querySelector('.col-actions').appendChild(buildDesktopActions(actionModel, event, userSettings.debugMode, isBookmarked));

    // Heart click listener — the element only exists when the gym HAS bookmarks
    // (the markup above is capability-gated), so this must be optional. An
    // unconditional querySelector here threw on every row for a gym without
    // them, which emptied the whole timetable.
    const heartEl = row.querySelector('.sa-timetable-heart');
    if (heartEl) {
      heartEl.onclick = (e) => {
        e.stopPropagation();
        toggleNativeBookmark(event, e.target);
      };
    }

    tbody.appendChild(row);
  });

  equalizeDiscTagWidths(ttGrid);
  equalizePrimaryCTAWidths(ttGrid);
  wireTimetableSwipe();
  scheduleInstructorFit();
  recordTimetableTiming('render-dom', domStartedAt, {
    reason,
    eventCount: sortedEvents.length,
  });
  recordTimetableTiming('render-total', renderStartedAt, {
    reason,
    eventCount: sortedEvents.length,
  });
}

export function equalizePrimaryCTAWidths(container = document) {
  const root = container.querySelector?.('#sa-timetable-rows') || container;
  const buttons = [...root.querySelectorAll?.('.sa-mobile-seg.primary') || []];
  if (!buttons.length) return;

  const grid = document.getElementById('sa-timetable-grid');
  if (!grid) return;

  // Base floor for the compact CTA (Batch N base)
  let maxW = 74;

  // Measure natural content width for each button on this page/date
  // Auto-Book buttons are excluded: their CSS width is derived FROM --timetable-cta-w (+14px), so measuring them
  // fed that width back into the variable and grew every button on each render.
  buttons.filter((b) => !b.classList.contains('variant-autoupgrade')).forEach((btn) => {
    btn.style.width = 'max-content';
    btn.style.minWidth = '0px';
    btn.style.maxWidth = 'none';
    const w = Math.ceil(btn.getBoundingClientRect().width);
    if (w > maxW) maxW = w;
    btn.style.width = '';
    btn.style.minWidth = '';
    btn.style.maxWidth = '';
  });

  // Apply the longest label's width to all primary buttons on this page/date
  grid.style.setProperty('--timetable-cta-w', `${maxW}px`);
}

// ═══════════════════════════════════════════════════════════════════════
//  Unified class-row action model — shared by the desktop table and the
//  mobile card so the primary/secondary/config logic lives in one place.
// ═══════════════════════════════════════════════════════════════════════

// Does this studio have a seat-map layout, and does the user have a saved
// preferred-spot map for it? Read synchronously from the live shared maps.
//
// `hasMap` resolution (found 2026-09-02): a studio not present in the initial
// `/api/metadata` fetch gets a bare fallback stub from mergeMetadataFromEvents()
// — `{id, name, locationId}` only, no `hasLayout` field at all — and that stub
// is permanent (nothing ever backfills it). Treating "no hasLayout key" the
// same as "hasLayout: false" silently and permanently hid Book/config for any
// studio only ever discovered this way (confirmed live: a real Reformer studio
// with a floor plan). Same principle as an unknown capability flag defaulting
// to ON: showing Book for a studio that turns out to have no floor plan
// self-corrects (the modal's own "No floor map available" state handles it);
// hiding one that DOES have a map is a silent dead end. Only an EXPLICIT
// `hasLayout: false` from real metadata should suppress it.
function resolveHasMap(studio) {
  if (!studio) return true;
  if (studio.hasLayout !== undefined) return !!studio.hasLayout;
  if (studio.layout?.slots?.length) return true;
  return true; // bare stub — unknown, not confirmed false
}

export function getStudioMapInfo(event) {
  // The EVENT's own layoutFormat is authoritative and beats any guess from
  // studio metadata. `first-come-first-serve` means the provider does not offer
  // spot selection for this class at all — confirmed on live JAB data, where
  // RECOVERY classes are FCFS.
  //
  // This matters because `resolveHasMap` answers TRUE for an unknown studio
  // (unknown-defaults-ON), and MarianaTek derives its studio list from the class
  // list — so an FCFS class could have no studio entry, fall through to "true",
  // and render "Book" opening a picker with nothing in it. The mocks hid this
  // because their studios always exist.
  if (event && event.layoutFormat === 'first-come-first-serve') {
    return { hasMap: false, hasPrefs: false };
  }
  const studio = event.studio || gymScopedGet(studioObjMap, event.studioId, event.gymId)
    || metadata.studios.find(s => sameId(s.id, event.studioId) && (!event.gymId || s.gymId === event.gymId));
  const hasMap = resolveHasMap(studio);
  const prefs = pickStudioPrefs(studioPrefsMap, event.studioId, event.gymId);
  const hasPrefs = hasStudioPreferences(prefs);
  return { hasMap, hasPrefs };
}

// Generic two-tap inline confirm: first tap swaps the label, second tap runs.
function twoTapConfirm(btn, confirmLabel, run) {
  if (btn.dataset.confirmState === 'confirm') {
    delete btn.dataset.confirmState;
    btn.classList.remove('confirming');
    if (btn.dataset.origLabel != null) { btn.textContent = btn.dataset.origLabel; delete btn.dataset.origLabel; }
    run();
    return;
  }
  haptic('light');
  btn.dataset.confirmState = 'confirm';
  btn.dataset.origLabel = btn.textContent;
  btn.textContent = confirmLabel;
  btn.classList.add('confirming');
  setTimeout(() => {
    if (btn.dataset.confirmState === 'confirm') {
      delete btn.dataset.confirmState;
      if (btn.dataset.origLabel != null) { btn.textContent = btn.dataset.origLabel; delete btn.dataset.origLabel; }
      btn.classList.remove('confirming');
    }
  }, 4000);
}

// Resolve the primary action, optional secondary action, and optional config
// (⚙ split / "Configure …" menu item) for a class given its current state.
function buildActionModel(event, ctx) {
  const {
    isLive, isBooked, isOnWaitlist, isFullyBooked, canWaitlist, hasCredit,
    isScheduled, bookingId, isPenalty, slotsBookedCount, waitlistId, graceDeadline,
  } = ctx;
  const { hasMap } = getStudioMapInfo(event);

  // Not yet live → Auto-Book (configurable via the spot map)
  if (!isLive) {
    return {
      primary: {
        label: isScheduled ? COPY.timetable.scheduled : COPY.timetable.autoBook,
        variant: 'autoupgrade', scheduled: isScheduled,
        run: (btn) => doAutoBookToggle(event, btn, isScheduled),
      },
      config: hasMap ? 'autobook' : null,
      // No ⚙ on the row itself, same as the Quick Book row below — it's still
      // reachable via "Configure Auto-Book" in the overflow menu.
      showConfigButton: false,
      secondary: null,
    };
  }

  // Already booked → Edit (+ Cancel as secondary). No seat map means there is
  // no spot to reassign, so Edit is dropped rather than opening on nothing.
  if (isBooked) {
    const primary = hasMap
      ? { label: COPY.timetable.edit, variant: 'autoupgrade', run: () => doEditBooking(event) }
      : { label: COPY.timetable.booked, variant: 'neutral', disabled: true };
    if (slotsBookedCount === 1 && bookingId) {
      const cancelLabel = graceDeadline
        ? formatCopyText(COPY.bookingWindow.graceCancel, { seconds: Math.ceil((graceDeadline - Date.now()) / 1000) })
        : COPY.bookings.cancel;
      if (!hasMap) {
        // Nothing to edit at all — Cancel is the one real action, so it's the
        // primary rather than a disabled "Booked" plus a secondary button.
        return {
          primary: {
            label: cancelLabel, variant: isPenalty ? 'danger-strong' : 'danger', isCancel: true,
            graceDeadline,
            run: (btn) => cancelBookingDirect(bookingId, isPenalty, btn, event.gymId),
          },
          config: null, secondary: null,
        };
      }
      return {
        primary, config: null,
        secondary: {
          label: cancelLabel, variant: isPenalty ? 'danger-strong' : 'danger', isCancel: true,
          graceDeadline,
          run: (btn) => cancelBookingDirect(bookingId, isPenalty, btn, event.gymId),
        },
      };
    }
    // Multiple spots booked (member + guest, or several records) → Cancel opens
    // the grouped chooser straight away; each spot confirms inside the modal.
    return {
      primary, config: null,
      secondary: {
        label: COPY.bookings.cancel, variant: 'danger', isCancel: true, opensModal: true,
        run: () => doGroupedCancel(event),
      },
    };
  }

  // On the waitlist → Leave (confirmed)
  if (isOnWaitlist) {
    if (waitlistId) {
      return {
        primary: {
          label: COPY.timetable.leaveWaitlist, variant: 'danger', isCancel: true,
          run: (btn) => twoTapConfirm(btn, COPY.timetable.confirmLeave, () => doLeaveWaitlist(waitlistId, btn, event.gymId)),
        },
        secondary: null, config: null,
      };
    }
    return { primary: { label: COPY.timetable.onWaitlist, variant: 'neutral', disabled: true }, secondary: null, config: null };
  }

  // Full → join waitlist if possible
  if (isFullyBooked) {
    if (canWaitlist) {
      return {
        primary: { label: COPY.timetable.joinWaitlist, variant: 'warning-solid', run: (btn) => doJoinWaitlist(event, btn) },
        secondary: null, config: null,
      };
    }
    // Full and no waitlist: the status pill already says so. Blank the action (kept invisible so
    // the column/rail stays aligned) rather than a dead "Full" button.
    return { primary: { label: '', variant: 'neutral', disabled: true, blank: true }, secondary: null, config: null };
  }

  // Not bookable — but WHY differs by gym shape (C3-2). `hasCredit` is
  // `hasUsableCredit()`, which is false either because a metered gym's balance
  // can't afford this class, OR because an unmetered (membership) gym has
  // confirmed this account has no active membership/credits at all
  // (`canBookAtAll()`). Those are different problems with different fixes: a
  // metered gym's fix is "buy more credits" (an in-app flow); an unmetered
  // gym has no credits to buy — `capabilities.creditPurchase` is false for
  // every unmetered gym in `gyms.config.js` — so "Buy Credits" pointed at a
  // purchase flow that gym doesn't have. Show a disabled state describing the
  // real problem instead; the reason is already in the tooltip via the same
  // `getIneligibleReason()` the status pill above uses.
  if (!hasCredit) {
    if (isMetered(event.gymId)) {
      return {
        primary: { label: COPY.timetable.buyCredits, variant: 'danger', run: () => window.switchTab('buy-credits') },
        secondary: null, config: null,
      };
    }
    return {
      primary: {
        label: COPY.timetable.noMembership, variant: 'neutral', disabled: true,
        title: getIneligibleReason(event.gymId) || COPY.shell.noMembership,
      },
      secondary: null, config: null,
    };
  }

  // Bookable now — ONE primary, always "Quick Book". `doQuickBook` routes all
  // three cases, so the label is the same everywhere and the row never asks the
  // user to understand which of them they are in:
  //
  //   • seat map + saved preferences → books your best spot straight away
  //   • no seat map published        → books any open spot straight away
  //   • seat map, no preferences yet → opens the picker, which saves the map
  //                                    for this studio AND books in one step
  //
  // The third case used to read "Book" and be styled as the odd one out. That
  // made the FIRST booking in a studio look like a different, lesser action
  // than every subsequent one, when it is the same action — it just collects
  // the spot map on its way through.
  //
  // `alternate` is the other way to do the same thing, offered in the overflow:
  // "Book (choose a spot)" is the escape hatch when you don't want your
  // preferred spot this time. It only exists where there are spots to choose.
  return {
    primary: { label: COPY.timetable.book, variant: 'success', title: COPY.timetable.quickBookTitle, run: (btn) => doQuickBook(event, btn) },
    // No ⚙ on the row: "Configure Quick-Book" is in the overflow menu, and two
    // affordances for one action spend 40px of every row to save one click on
    // a rare one. `config` is still set so the menu knows to offer it.
    config: hasMap ? 'quickbook' : null,
    showConfigButton: false,
    secondary: null,
    alternate: hasMap ? { label: COPY.timetable.chooseSpotBook, run: () => openBookingModal(event, 'book') } : null,
  };
}

/**
 * The preferred spot map for an event's studio — ONE resolution, shared.
 *
 * Quick-Book and the auto-upgrade registration each had their own copy, and
 * they disagreed: a JAB TRAIN booking would quick-book into a preferred spot
 * (so the map plainly existed) and then immediately toast "you don't have a
 * preferred spot map for this studio". Two lookups for one fact will always
 * drift; this is the fact.
 *
 * Keys are gym-qualified because studio ids are PROVIDER ids — unique only
 * within a gym. The bare `studioId` fallback is for single-gym data saved
 * before that was true.
 */
export function pickStudioPrefs(allPrefs, studioId, gymId) {
  const allowLegacyFallback = !gymId || getLinkedGyms().length === 1;
  return pickGymStudioPrefs(allPrefs, studioId, gymId, allowLegacyFallback);
}

async function resolveStudioPrefs(event) {
  const studioId = event.studioId;
  const prefKey = event.gymId ? `${event.gymId}:${studioId}` : studioId;
  let all = cache.studioPreferences;
  const allowLegacyFallback = !event.gymId || getLinkedGyms().length === 1;
  if (!all || !(prefKey in all || (allowLegacyFallback && studioId in all))) {
    all = await api.getStudioPreferences();
    cache.studioPreferences = all;
  }
  const prefs = pickStudioPrefs(all, studioId, event.gymId);
  const hasPrefs = hasStudioPreferences(prefs);
  return { prefs, hasPrefs };
}

/**
 * U1-12: before ANY manual book / quick-book (and before any other modal: the spot
 * picker, first-time setup), ask the server whether this class clashes with a
 * booking or a queued auto-book in any gym, and show the same confirmation as
 * auto-book (U1-6). Resolves true to carry on, false when the member backs out
 * (nothing happens). The rule is the server's; a failed check lets the booking
 * proceed, as the provider still enforces the real limits.
 */
async function overlapGate(event, mode) {
  let warnings;
  try {
    warnings = await api.checkOverlap({
      eventId: event.id, startAt: event.startAt, durationMin: event.durationMin, className: event.name,
    }, event.gymId);
  } catch (err) {
    console.warn('[Timetable] overlap check failed, continuing:', err.message);
    return true;
  }
  if (!warnings.length) return 'clear';
  const instr = event.instructors?.[0];
  const confirmed = await confirmOverlap({
    subject: {
      gymId: event.gymId || null,
      eventId: event.id,
      startAt: event.startAt,
      className: event.name,
      groupName: event.discipline,
      instructorName: instr?.name || gymScopedGet(instructorMap, instr?.id, event.gymId) || '',
      instructorImageUrl: instr?.thumbUrl || instr?.imageUrl || null,
      studioName: event.studioName || '',
      locationName: event.locationName || '',
    },
    warnings,
    mode,
  });
  return confirmed ? 'acknowledged' : false;
}

async function doQuickBook(event, btn) {
  if (btn.dataset.qbBusy) return; // flow already in progress (overlap modal open)
  const run = async ({ overlapAcknowledged = false } = {}) => {
    // Overlap already asked this attempt (modal acknowledged, or a clean check on
    // the first tap): never ask again, including after first-time setup.
    const opts = { overlapChecked: true, overlapAcknowledged };
    try {
      const { prefs, hasPrefs } = await resolveStudioPrefs(event);
      const { hasMap } = getStudioMapInfo(event);
      if (!hasPrefs && hasMap) { openBookingModal(event, 'quickbook', opts); return; }
      quickBookClass(event.id, {
        preferredSlots: prefs.preferredSlots || [],
        preferredRows: prefs.preferredRows || [],
        requiredCount: 1, bookAny: true,
        autoUpgrade: isAutoUpgradeDefaultEnabled(event.gymId),
      }, btn, event.gymId);
    } catch (err) {
      openBookingModal(event, 'quickbook', opts);
    }
  };
  // The row's two-tap confirm only guards the no-modal path. When the overlap
  // modal was shown and acknowledged, that IS the confirmation. `busy` stops a
  // second tap (or the 4s revert timer) interfering while a modal is open.
  const confirmMsg = isWithin12Hours(event.startAt) ? COPY.timetable.confirmSoon : COPY.timetable.confirm;
  btn.dataset.qbBusy = '1';
  let hasUnconfiguredMap = false;
  try {
    const { hasPrefs } = await resolveStudioPrefs(event);
    hasUnconfiguredMap = getStudioMapInfo(event).hasMap && !hasPrefs;
  } catch (_) { /* retain confirmation if preference state is unknown */ }
  const settle = () => { delete btn.dataset.qbBusy; };
  try {
    await quickBookTap({
      busy: false,
      immediate: hasUnconfiguredMap,
      armed: btn.dataset.confirmState === 'confirm',
      gate: async () => { try { return await overlapGate(event, 'quickbook'); } finally { settle(); } },
      arm: () => twoTapConfirm(btn, confirmMsg, run),
      run,
    });
  } finally { settle(); }
}

async function doAutoBookToggle(event, btn, isScheduled) {
  if (isScheduled) {
    try {
      showToast(COPY.timetable.removingScheduled, 'info');
      const autoBookings = await api.getAutoBookings();
      const existing = (autoBookings.data || autoBookings || []).find(x => String(x.event_id || x.eventId) === String(event.id));
      if (existing) {
        await api.deleteAutoBooking(existing.id);
        showToast(COPY.timetable.scheduledCancelled, 'info');
        renderTimetableGrid();
      }
    } catch (err) {
      showToast(formatCopyText(COPY.timetable.errorPrefix, { error: err.message }), 'error');
    }
    return;
  }
  // No seat map for this studio (FCFS/recovery) — nothing to configure, so
  // this is one tap, same as Quick Book's own no-map case.
  const { hasMap } = getStudioMapInfo(event);
  if (!hasMap) {
    saveAutoBookPreferences(event, [], [], 1, true, () => {});
    return;
  }
  try {
    const autoBookAllPrefs = await api.getStudioPreferences();
    const prefs = (event.gymId && autoBookAllPrefs[`${event.gymId}:${event.studioId}`]) || autoBookAllPrefs[event.studioId] || {};
    if (prefs.preferredSlots?.length > 0 || prefs.preferredRows?.length > 0) {
      saveAutoBookPreferences(event, prefs.preferredSlots || [], prefs.preferredRows || [], 1, true, () => {});
    } else {
      openBookingModal(event, 'autobook');
    }
  } catch (err) {
    openBookingModal(event, 'autobook');
  }
}

// Edit a booked class — reuses the My Bookings edit-spots modal. Builds the
// booking "group" it expects from the timetable's cached bookings + metadata.
// Multi-spot classes skip the single-booking confirmation: the grouped modal
// lists every spot and asks for one confirmation per cancellation.
async function doGroupedCancel(event) {
  const eventBookings = userBookings().filter(b => matchesEvent(b, event));
  if (!eventBookings.length) { showToast(COPY.timetable.bookingNotFound, 'error'); return; }
  openGroupedCancellationModal(
    { eventId: event.id, event, bookings: eventBookings },
    async () => { await refreshUserData(true); await refreshBookingState(); },
  );
}

async function doEditBooking(event) {
  const eventBookings = userBookings().filter(b => matchesEvent(b, event));
  if (!eventBookings.length) { showToast(COPY.timetable.bookingNotFound, 'error'); return; }

  const eventTypeName = event.name || gymScopedGet(eventTypeMap, event.classTypeId, event.gymId) || 'Class';
  const groupName = event.discipline || gymScopedGet(eventTypeGroupMap, event.classTypeId, event.gymId) || eventTypeName;
  const instrName = event.instructors?.[0]?.name || event.instructor?.name || gymScopedGet(instructorMap, event.instructors?.[0]?.id, event.gymId) || '';
  const studioObj = event.studio || gymScopedGet(studioObjMap, event.studioId, event.gymId);

  // Normalized shape, with the display values this modal needs resolved. It used
  // to rebuild a CodexFit-shaped object (`event_type.group.name`,
  // `instructor.full_name`), which no other platform emits.
  const enrichedEvent = {
    ...event,
    name: event.name || eventTypeName,
    discipline: event.discipline || groupName,
    instructors: event.instructors?.length ? event.instructors : (instrName ? [{ name: instrName }] : []),
    studioName: event.studioName || studioObj?.name,
  };

  openEditBookingModal(
    { eventId: event.id, event: enrichedEvent, bookings: eventBookings },
    () => prefetchTimetableData(true), // refresh the timetable after spots change
  );
}

// Lightweight refresh of booking/waitlist state + re-render the grid.
// Re-fetches only /bookings and /waitlists (the data behind action-button
// state) so buttons flip immediately (Book ↔ Edit/Cancel, Join ↔ Leave WL)
// after a mutation, without a full timetable re-fetch or loading spinner.
// Mutations (proxyPost/proxyDelete/proxyPut) already invalidate the proxy
// cache for these resources, so the GETs return fresh data.
async function refreshBookingState() {
  try {
    // NormalizedBooking[]: `eventId` (a STRING), not raw `event_id` (a number).
    // Use matchesEvent() below rather than comparing directly.
    const [bookingsRes, waitlistsRes] = await Promise.all([
      api.getBookings(),
      api.getWaitlists(),
    ]);
    cache.bookings = bookingsRes || [];
    cache.waitlists = waitlistsRes || [];
  } catch (e) {
    console.warn('[Timetable] refreshBookingState failed:', e);
  }
  renderTimetableGrid();
}

async function doJoinWaitlist(event, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = COPY.timetable.joining;
  try {
    await api.joinWaitlist(event.id, event.gymId);
    haptic('success');
    showToast(COPY.timetable.joinedWaitlist, 'success');
    prefetchTimetableData(true);
  } catch (err) {
    haptic('error');
    showToast(formatCopyText(COPY.timetable.waitlistFailed, { error: err.message }), 'error');
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function doLeaveWaitlist(waitlistId, btn, gymId = null) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = COPY.timetable.leaving;
  try {
    await api.leaveWaitlist(waitlistId, gymId);
    haptic('warning');
    showToast(COPY.timetable.leftWaitlist, 'success');
    await refreshUserData(true);
    await refreshBookingState();
  } catch (err) {
    haptic('error');
    showToast(formatCopyText(COPY.timetable.leftWaitlistError, { error: err.message }), 'error');
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// Unicode (non-emoji) glyph that prefixes certain action labels.
function actionGlyph(label) {
  if (label === 'Quick-Book' || label === 'Quick Book' || label === COPY.timetable.book) return '⚡︎';
  if (label === COPY.timetable.autoBook || label === COPY.timetable.autoBook.replace('-', ' ') || label === COPY.timetable.scheduled || label === COPY.timetable.scheduledShort) return sparklesIcon(16, 'currentColor');
  return '';
}

// Set a button's label with an optional leading glyph icon.
function setSegLabel(btn, label) {
  const glyph = actionGlyph(label);
  if (glyph) btn.innerHTML = `<span class="psycle-seg-ico" aria-hidden="true">${glyph}</span>${label}`;
  else btn.textContent = label;
}

// Build the desktop actions cell: full-height side-by-side segments
// (primary [+ ⚙ config split] | secondary | debug).
/** Pill-sized version of a server eligibility reason. */
function shortIneligibleLabel(reason) {
  const r = String(reason || '').trim();
  if (!r) return COPY.timetable.noCredits;
  if (/no credits/i.test(r)) return COPY.timetable.noCredits;
  if (/membership/i.test(r)) return COPY.timetable.noMembership;
  return r.length > 18 ? `${r.slice(0, 17)}…` : r;
}

/**
 * The overflow menu's contents — ONE definition, used by the desktop row and the
 * mobile card.
 *
 * Desktop had no overflow at all: its extra actions were a single ⚙ and
 * whatever fitted as a second button, so "Favourite", "Studio Occupancy" and —
 * once Quick Book became the default — "Book (choose a spot)" were simply
 * unreachable on a wide screen while being present on a narrow one. Two menus
 * would drift; this is the menu.
 */
function buildActionMenuItems(event, model, isBookmarked) {
  const items = [];

  if (model.secondary && !model.secondary.disabled && model.secondary.run) {
    const isBookish = /book/i.test(model.secondary.label || '');
    items.push({
      label: model.secondary.label,
      icon: model.secondary.isCancel ? 'close' : (isBookish ? 'bolt' : (/edit/i.test(model.secondary.label || '') ? 'edit' : 'chevron')),
      variant: model.secondary.isCancel ? 'danger' : (isBookish ? 'book' : ''),
      keepOpen: !!model.secondary.isCancel && !model.secondary.opensModal, // cancel runs its own two-tap confirm in place (the grouped chooser is a modal)
      graceDeadline: model.secondary.graceDeadline,
      action: (el) => model.secondary.run(el),
    });
  }

  // The other way to do what the primary does — e.g. pick your own spot when
  // the primary quick-books one for you.
  if (model.alternate && model.alternate.run) {
    items.push({ label: model.alternate.label, icon: 'spot', variant: 'book', action: () => model.alternate.run() });
  }

  if (model.config) {
    items.push({
      label: model.config === 'autobook' ? COPY.timetable.configureAutoBook : COPY.timetable.configureQuickBook,
      icon: 'sliders',
      variant: '',
      action: () => openBookingModal(event, model.config),
    });
  }

  // Guest reservations are a distinct, provider-gated attendee flow. They do
  // not appear in the primary, Quick-Book or Auto-Book paths because they need
  // a guest identity and must consume a guest pass, not another self spot.
  const hasSelfBooking = userBookings().some((booking) => matchesEvent(booking, event) && !booking.isGuest);
  if (canForGym('guestBooking', event.gymId) && hasSelfBooking) {
    items.push({ label: COPY.bookings.guestMenu, icon: 'userPlus', variant: 'book', action: () => openGuestBookingModal(event) });
  }

  if (canForGym('bookmarks', event.gymId)) {
    items.push({
      label: isBookmarked ? COPY.timetable.unfavourite : COPY.timetable.favourite,
      icon: 'heart',
      variant: 'favourite',
      action: () => toggleNativeBookmark(event, null),
    });
  }

  items.push({ label: COPY.timetable.studioOccupancy, icon: 'users', variant: '', action: () => openOccupancyModal(event) });

  if (userSettings.debugMode) {
    items.push({ label: 'Debug', icon: 'bug', variant: 'debug', action: () => openDebugModal(event) });
  }
  return items;
}

/** Build the floating menu element for a set of items (shared desktop/mobile). */
function buildActionMenuElement(menuItems) {
  const menu = document.createElement('div');
  menu.className = 'sa-mobile-menu';
  menu.style.display = 'none';
  menuItems.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'sa-mobile-menu-item';
    // Icon + label. The label goes in its own span with textContent — menu
    // labels can include a class name, and those come from the provider.
    if (item.icon) {
      const ic = document.createElement('span');
      ic.className = 'sa-menu-item-icon';
      ic.innerHTML = icon(item.icon, 15);
      ic.setAttribute('aria-hidden', 'true');
      div.appendChild(ic);
    }
    const label = document.createElement('span');
    label.className = 'sa-menu-item-label';
    label.textContent = item.label;
    div.appendChild(label);
    if (item.variant) div.setAttribute('data-variant', item.variant);
    if (item.graceDeadline) {
      div.setAttribute('data-grace-deadline', item.graceDeadline);
      div.classList.add('grace-cancel');
      startGraceCountdown();
    }
    div.onclick = (e) => {
      e.stopPropagation();
      if (item.keepOpen) { item.action(div); return; }
      menu.style.display = 'none';
      item.action(div);
    };
    menu.appendChild(div);
  });
  // Appended to body (not the row) so `position: fixed` escapes any
  // backdrop-filter containing block and renders above sibling rows.
  document.body.appendChild(menu);
  return menu;
}

function buildDesktopActions(model, event, debugMode, isBookmarked = false) {
  const wrap = document.createElement('div');
  wrap.className = 'sa-tt-actions';

  const group = document.createElement('div');
  group.className = 'sa-tt-seg-group' + (model.config && model.showConfigButton !== false ? ' has-caret' : '');

  const pbtn = document.createElement('button');
  pbtn.className = `sa-tt-seg primary variant-${model.primary.variant}` + (model.primary.scheduled ? ' scheduled' : '');
  setSegLabel(pbtn, model.primary.label);
  if (model.primary.title) { pbtn.title = model.primary.title; pbtn.setAttribute('aria-label', model.primary.title); }
  if (model.primary.disabled) pbtn.disabled = true;
  else if (model.primary.run) pbtn.onclick = (e) => { e.stopPropagation(); model.primary.run(pbtn); };
  if (model.primary.blank) { pbtn.classList.add('is-blank'); pbtn.setAttribute('aria-hidden', 'true'); pbtn.tabIndex = -1; }
  group.appendChild(pbtn);

  if (model.config && model.showConfigButton !== false) {
    const caret = document.createElement('button');
    caret.className = `sa-tt-seg sa-tt-seg-caret primary variant-${model.primary.variant}` + (model.primary.scheduled ? ' scheduled' : '');
    caret.innerHTML = '⚙';
    caret.title = model.config === 'autobook' ? COPY.timetable.configureAutoBookAria : COPY.timetable.configureQuickBookAria;
    caret.onclick = (e) => { e.stopPropagation(); openBookingModal(event, model.config); };
    group.appendChild(caret);
    // NOTE: this stays as a direct affordance AS WELL as appearing in the
    // overflow below — configuring the spot map is the single most common
    // follow-up to a quick-book, and burying it one click deeper for the sake
    // of tidiness costs more than the 40px it saves.
  }
  wrap.appendChild(group);

  if (model.secondary) {
    const sbtn = document.createElement('button');
    sbtn.className = `sa-tt-seg secondary variant-${model.secondary.variant}`;
    setSegLabel(sbtn, model.secondary.label);
    if (model.secondary.disabled) sbtn.disabled = true;
    else if (model.secondary.run) sbtn.onclick = (e) => { e.stopPropagation(); model.secondary.run(sbtn); };
    if (model.secondary.graceDeadline) {
      sbtn.setAttribute('data-grace-deadline', model.secondary.graceDeadline);
      sbtn.classList.add('grace-cancel');
      startGraceCountdown();
    }
    wrap.appendChild(sbtn);
  }

  // Overflow — the SAME menu the mobile card gets. Desktop previously had no
  // way to reach "Book (choose a spot)", "Favourite" or "Studio Occupancy": its
  // extras were a lone ⚙ plus whatever second button fitted, so a wide screen
  // offered FEWER actions than a narrow one.
  const menuItems = buildActionMenuItems(event, model, isBookmarked);
  if (menuItems.length > 0) {
    const more = document.createElement('button');
    more.className = 'sa-tt-seg sa-tt-seg-more';
    more.innerHTML = '⋯';
    more.setAttribute('aria-label', COPY.timetable.moreActions);
    more.setAttribute('aria-haspopup', 'menu');
    more.title = COPY.timetable.moreActions;
    const menu = buildActionMenuElement(menuItems);
    wireMobileMenuToggle(more, menu);
    wrap.appendChild(more);
  }
  return wrap;
}

// Toggle a body-appended fixed context menu anchored under a button.
function wireMobileMenuToggle(btn, menu, onOpen) {
  btn.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = menu.style.display === 'block';
    document.querySelectorAll('.sa-mobile-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
    if (wasOpen) { menu.style.display = 'none'; return; }
    if (onOpen) onOpen();
    const rect = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.left = 'auto';
    menu.style.top = '0px';
    menu.style.maxHeight = '';
    // Measure before placing: the menu has to be laid out to know its height,
    // and the height decides whether it opens downward or upward.
    menu.style.visibility = 'hidden';
    menu.style.display = 'block';

    const GAP = 6;
    const MARGIN = 8; // keep clear of the viewport edge
    const menuH = menu.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
    const spaceAbove = rect.top - GAP - MARGIN;

    if (menuH <= spaceBelow) {
      // Fits below — the normal case.
      menu.style.top = `${rect.bottom + GAP}px`;
    } else if (menuH <= spaceAbove) {
      // Doesn't fit below but does above: open UPWARD. A row near the bottom of
      // the viewport used to open a menu that ran off the screen and required
      // scrolling to reach its last item — which also dismissed it, since the
      // scroll listener closes the menu.
      menu.style.top = `${rect.top - GAP - menuH}px`;
    } else {
      // Fits in neither direction (a short viewport): pin to the larger side
      // and let the menu scroll INTERNALLY, so it is always fully reachable.
      if (spaceBelow >= spaceAbove) {
        menu.style.top = `${rect.bottom + GAP}px`;
        menu.style.maxHeight = `${Math.max(120, spaceBelow)}px`;
      } else {
        menu.style.top = `${MARGIN}px`;
        menu.style.maxHeight = `${Math.max(120, spaceAbove)}px`;
      }
      menu.style.overflowY = 'auto';
    }
    menu.style.visibility = '';
    const close = (ev) => {
      if (!menu.contains(ev.target) && !btn.contains(ev.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', close);
        window.removeEventListener('scroll', close, true);
        window.removeEventListener('resize', close);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
    }, 0);
  };
}

// === MOBILE TIMETABLE — injectMobileFilterHamburger (added Jun 2026; delete this block to revert) ===
function injectMobileFilterHamburger() {
  const filtersRow = document.querySelector('#sa-timetable-filters-container .sa-filters-row');
  if (!filtersRow) return;

  // Rebuild the trigger + menu every render. The grid clears all body-appended
  // .sa-mobile-menu nodes on each render (see renderTimetableGrid), which
  // would otherwise orphan a once-created menu and silently break opening.
  document.getElementById('sa-mobile-filter-trigger')?.remove();

  const trigger = document.createElement('button');
  trigger.id = 'sa-mobile-filter-trigger';
  trigger.className = 'sa-mobile-ellipsis sa-mobile-filter-ellipsis';
  trigger.innerHTML = '\u22ef';
  trigger.setAttribute('aria-label', COPY.timetable.filterOptions);

  const menu = document.createElement('div');
  menu.className = 'sa-mobile-menu';
  menu.style.display = 'none';

  const favBtn = document.getElementById('sa-filter-favorites-only');
  const clearBtn = document.getElementById('psycle-btn-clear-all-filters');
  const saveBtn = document.getElementById('psycle-btn-save-default-filters');

  const items = [];
  // Favourites filter temporarily hidden until universal cross-gym solution
  // if (favBtn) items.push({ label: showBookmarksOnly ? 'Bookmarked (on)' : 'Bookmarked', icon: 'heart', variant: 'favourite', action: () => favBtn.click() });
  if (clearBtn) items.push({ label: COPY.timetable.clearFilters, icon: 'close', variant: 'danger', action: () => clearBtn.click() });
  if (saveBtn) items.push({ label: COPY.timetable.saveDefaults, icon: 'check', variant: 'success', action: () => saveBtn.click() });

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'sa-mobile-menu-item';
    // Icon + label. The label goes in its own span with textContent — menu
    // labels can include a class name, and those come from the provider.
    if (item.icon) {
      const ic = document.createElement('span');
      ic.className = 'sa-menu-item-icon';
      ic.innerHTML = icon(item.icon, 15);
      ic.setAttribute('aria-hidden', 'true');
      div.appendChild(ic);
    }
    const label = document.createElement('span');
    label.className = 'sa-menu-item-label';
    label.textContent = item.label;
    div.appendChild(label);
    if (item.variant) div.setAttribute('data-variant', item.variant);
    div.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      item.action();
    };
    menu.appendChild(div);
  });

  filtersRow.appendChild(trigger);
  document.body.appendChild(menu);
  wireMobileMenuToggle(trigger, menu);
}
// === END MOBILE TIMETABLE BLOCK ===

// === MOBILE TIMETABLE — buildMobileClassRow (added Jun 2026; delete this block to revert) ===
function buildMobileClassRow(event, ctx, model) {
  const {
    timeStr, groupName, strippedClassName, instrName, locName,
    isBookmarked, heartChar, heartClass, rowClass
  } = ctx;

  const tr = document.createElement('tr');
  tr.className = `sa-mobile-row ${rowClass || ''}`;

  const td = document.createElement('td');
  td.colSpan = 6;

  const card = document.createElement('div');
  card.className = 'sa-mobile-class-card';
  card.setAttribute('data-gym', event.gymId || getDefaultGymId());

  // Row 3 shows the studio's FULL location name ("Oxford Circus"), not the gym's contracted alias ("OC").
  const displayLoc = trimLocation(locName, getGymShortName(event.gymId));

  // Favourite heart is a non-interactive indicator on mobile (only shown when
  // bookmarked), sitting between the time and the discipline chip. Toggling
  // happens through the context menu instead.
  const favIndicator = isBookmarked
    ? (canForGym('bookmarks', event.gymId) ? `<span class="sa-mobile-fav-indicator" aria-label="${COPY.timetable.favourited}">${heartChar}</span>` : '')
    : '';

  // Photo (or a soft initial placeholder, same box, so nothing shifts while it loads). The image comes from the
  // ONE shared lookup (instructorAvatar: the event's own thumb first, else metadata by name).
  const firstInstr = event.instructors?.[0];
  const instrId = firstInstr?.id || metadata.instructors?.find(i => (i.name === instrName || i.full_name === instrName) && (!event.gymId || i.gymId === event.gymId))?.id || '';
  const avatarHtml = SHOW_TIMETABLE_INSTRUCTOR_PHOTO && instrName
    ? `<span class="sa-mobile-avatar sa-instructor-hover" ${instructorHoverAttrs(firstInstr ? { ...firstInstr, id: instrId || firstInstr.id } : { id: instrId }, event.gymId, instrName)} data-initial="${escapeHtml(String(instrName).trim().charAt(0).toUpperCase())}" role="button" tabindex="0" aria-label="${formatCopyText(COPY.timetable.instructorProfileAria, { name: escapeHtml(instrName) })}">${instructorAvatar(instrName, event.gymId, firstInstr?.thumbUrl || firstInstr?.imageUrl || null, { size: 38, lazy: true, cls: 'sa-mobile-avatar-img' })}</span>`
    : '';

  card.innerHTML = `
    <div class="sa-mobile-content">
      <div class="sa-mobile-lead">
        <strong>${timeStr}</strong>
        ${avatarHtml}
      </div>
      <div class="sa-mobile-main">
        <div class="sa-mobile-top-line">
          ${/* Gym BEFORE the discipline pill (ownership is the first question a merged timetable answers). */ ''}
          ${gymChip(event.gymId)}
          ${disciplineTag(groupName)}
          ${favIndicator}
        </div>
        <div class="sa-mobile-line2">
          <span class="sa-mobile-class-name">${strippedClassName}</span>
          ${instrName ? `<span class="sa-mobile-dot">&middot;</span><span class="sa-mobile-instructor sa-instructor-hover" ${instructorHoverAttrs(event.instructors?.[0], event.gymId, instrName)}>${instrName}</span>` : ''}
        </div>
        <div class="sa-mobile-bottom-line">
          <span class="sa-mobile-location">${displayLoc}</span>
        </div>
      </div>
    </div>
    <div class="sa-mobile-rail"></div>
  `;

  const rail = card.querySelector('.sa-mobile-rail');

  // Mobile shows exactly ONE visible action button (the rest collapse into
  // the ellipsis). For an already-booked single-spot class, buildActionModel
  // sets primary="Edit" / secondary="Cancel" — a sensible pair when both show
  // (desktop), but the one people actually reach for on a booked class is
  // Cancel, not Edit. So mobile swaps them here: Cancel becomes the visible
  // button, Edit moves into the overflow menu. Desktop is unaffected — it
  // always renders both primary and secondary as direct buttons.
  const swapForCancel = !!(model.secondary && model.secondary.isCancel);
  const mobilePrimary = swapForCancel ? model.secondary : model.primary;

  // Primary action — a full-height segment flush to the card edge (mirrors the
  // desktop primary segment and the My Bookings rail, but laid out horizontally).
  const pbtn = document.createElement('button');
  pbtn.className = `sa-mobile-seg primary variant-${mobilePrimary.variant}` + (mobilePrimary.scheduled ? ' scheduled' : '');
  if (mobilePrimary.scheduled && mobilePrimary.variant === 'autoupgrade') {
    // "Scheduled" is too wide for 52px — abbreviate it.
    setSegLabel(pbtn, COPY.timetable.scheduledShort);
  } else {
    setSegLabel(pbtn, mobilePrimary.label);
    // "Auto-Book" stacks as Auto / Book (no hyphen) so the button stays narrow; the accessible name is unchanged.
    if (mobilePrimary.label === COPY.timetable.autoBook) {
      pbtn.innerHTML = `<span class="psycle-seg-ico" aria-hidden="true">${actionGlyph(COPY.timetable.autoBook)}</span><span class="psycle-cta-2l"><span>${COPY.timetable.auto}</span><span>${COPY.timetable.book}</span></span>`;
      pbtn.setAttribute('aria-label', mobilePrimary.title || COPY.timetable.autoBook);
    }
  }
  if (mobilePrimary.title) { pbtn.title = mobilePrimary.title; pbtn.setAttribute('aria-label', mobilePrimary.title); }
  if (mobilePrimary.blank) { pbtn.classList.add('is-blank'); pbtn.setAttribute('aria-hidden', 'true'); pbtn.tabIndex = -1; }
  if (mobilePrimary.disabled) pbtn.disabled = true;
  else if (mobilePrimary.run) pbtn.onclick = (e) => { e.stopPropagation(); mobilePrimary.run(pbtn); };
  if (mobilePrimary.graceDeadline) {
    pbtn.setAttribute('data-grace-deadline', mobilePrimary.graceDeadline);
    pbtn.classList.add('grace-cancel');
    startGraceCountdown();
  }
  rail.appendChild(pbtn);

  // Secondary action + extras collapse into the ellipsis context menu.
  const ellipsis = document.createElement('button');
  ellipsis.className = 'sa-mobile-seg ellipsis';
  ellipsis.innerHTML = '\u22EE'; // vertical ellipsis (kebab)
  ellipsis.setAttribute('aria-label', COPY.timetable.moreActions);
  rail.appendChild(ellipsis);

  // When Cancel took the visible slot, hide it from the shared overflow
  // builder (it's already reachable directly) and surface Edit there instead
  // — otherwise Edit would be lost entirely on mobile.
  const menuItems = buildActionMenuItems(event, swapForCancel ? { ...model, secondary: null } : model, isBookmarked);
  if (swapForCancel) {
    menuItems.unshift({ label: model.primary.label, icon: /edit/i.test(model.primary.label || '') ? 'edit' : 'chevron', variant: '', action: () => model.primary.run() });
  }
  const menu = buildActionMenuElement(menuItems);

  wireMobileMenuToggle(ellipsis, menu);

  td.appendChild(card);
  tr.appendChild(td);
  return tr;
}
// === END MOBILE TIMETABLE BLOCK ===

// === MOBILE TIMETABLE — openOccupancyModal (added Jun 2026; delete this block to revert) ===
async function openOccupancyModal(event) {
  const overlay = document.createElement('div');
  overlay.className = 'sa-modal';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '2000001';

  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'sa-modal-overlay';

  const card = document.createElement('div');
  card.className = 'sa-modal-card';
  card.style.width = '420px';
  card.style.maxWidth = '95vw';

  const header = document.createElement('div');
  header.className = 'sa-modal-header';
  header.innerHTML = `
    <h4>${COPY.timetable.studioOccupancy}</h4>
    <button class="sa-modal-close-btn">&times;</button>
  `;

  const body = document.createElement('div');
  body.className = 'sa-modal-body';
  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 20px 0;">
      <div class="psycle-spinner"></div>
      <span>${COPY.occupancy.loadingLayout}</span>
    </div>
  `;

  card.appendChild(header);
  card.appendChild(body);
  overlay.appendChild(modalOverlay);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  openNavPage(overlay, { id: 'occupancy', remove: true, closeFooter: true });

  const closeModal = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  };

  header.querySelector('.sa-modal-close-btn').onclick = closeModal;
  modalOverlay.onclick = closeModal;

  try {
    const res = await api.getEventDetails(event.id, event.gymId);
    body.innerHTML = '';
    renderMinimap(res, body);
  } catch (err) {
    body.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--danger); font-size: 13px;">
        ${COPY.timetable.failedOccupancy}
      </div>
    `;
  }
}
// === END MOBILE TIMETABLE BLOCK ===


// Resilient bookmark ID generator
function generateBookmarkIdentifier(event) {
  if (!event) return '';
  const studioId = event.studioId || (event.studio ? event.studioId : null);
  if (!studioId || !event.startAt) return '';
  
  const dateObj = new Date(event.startAt);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneFor(event),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });
  
  try {
    const parts = formatter.formatToParts(dateObj);
    const wdayStr = parts.find(p => p.type === 'weekday').value;
    const hourStr = parts.find(p => p.type === 'hour').value;
    const minStr = parts.find(p => p.type === 'minute').value;
    
    const wdayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const d = wdayMap[wdayStr];
    
    return `${studioId}0000${d}0000${hourStr}${minStr}`;
  } catch (e) {
    console.error('[Timetable] Error formatting date for bookmark identifier:', e);
    return '';
  }
}

// Toggle Heart Bookmark state on CodexFit metafields
async function toggleNativeBookmark(event, heartEl) {
  const identifier = generateBookmarkIdentifier(event);
  if (!identifier) {
    showToast(COPY.timetable.failedBookmarkId, 'error');
    return;
  }
  
  const bookmarks = profileForGym(event.gymId)?.metafields?.public?.bookmarks?.events || [];
  const isCurrentlyBookmarked = bookmarks.includes(identifier);
  
  if (heartEl) {
    heartEl.classList.add('loading');
  }
  
  try {
    // Bookmarks exist on CodexFit only — MarianaTek has no equivalent — so the
    // route is capability-gated server-side rather than universal. This client
    // guard is the fast path; the server rejects independently with 501.
    // The metafield path shape is the adapter's business, not this module's.
    if (!canForGym('bookmarks', event.gymId)) {
      showToast(COPY.timetable.noBookmarkSupport, 'info');
      return;
    }
    await api.setBookmark(identifier, !isCurrentlyBookmarked, event.gymId);
    
    // Refresh user profile cache
    await refreshUserData();
    showToast(isCurrentlyBookmarked ? COPY.timetable.bookmarkRemoved : COPY.timetable.bookmarkAdded, 'success');
    setupDropdownFilters();
    renderTimetableGrid();
  } catch (err) {
    console.error('[Timetable] Bookmark toggle failed:', err);
    showToast(COPY.timetable.bookmarkUpdateFailed, 'error');
  } finally {
    if (heartEl) {
      heartEl.classList.remove('loading');
    }
  }
}

// Perform instant booking using preferred seat priorities
async function quickBookClass(eventId, prefs, btn, gymId = null) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = COPY.timetable.booking;
  }

  const preferredSlots = prefs.preferredSlots || [];
  const preferredRows = prefs.preferredRows || [];
  const requiredCount = prefs.requiredCount || 1;
  const bookAny = prefs.bookAny !== false;
  const autoUpgrade = prefs.autoUpgrade !== undefined ? prefs.autoUpgrade : isAutoUpgradeDefaultEnabled(gymId);

  try {
    // WP-C1: reads the normalized event details endpoint instead of the raw
    // proxy. `event.raw` is the CodexFit event object with instructor/
    // event_type/studio already relation-resolved inline (see
    // providers/codexfit.js resolveEventRelations) — a superset of the old
    // bare `eventData`, so every existing raw-field read below still works.
    // `slots` is already the normalized (layout + live availability) merge
    // the old code used to derive by hand from `studio.layout.slots` +
    // `res.slots` — reused directly instead of re-deriving it.
    const { event, slots } = await api.getEventDetails(eventId, gymId);
    const eventData = event.raw;
    if (!eventData) {
      showToast(COPY.timetable.classDataFailed, 'error');
      return;
    }
    if (event.isUserBooked) {
      showToast(COPY.overlap.alreadyBooked, 'warning');
      return;
    }

    // An empty `slots` array means "no seat map to check" (FCFS studios, or a
    // studio missing layout data) — NOT "zero spots available". A real
    // pick-a-spot class that's genuinely full still has an entry per layout
    // slot, just none with isAvailable. Treating "no layout" as "full" made
    // every FCFS quick-book (e.g. a recovery class) auto-join a waitlist
    // regardless of real availability.
    if (slots.length === 0) {
      try {
        const bookRes = await api.book(eventId, [], gymId);
        if (!bookRes.ok) {
          const declinedAsFull = /full|no availab/i.test(bookRes.error || '');
          if (declinedAsFull) {
            showToast(COPY.timetable.fullyBookedJoining, 'warning');
            try {
              await api.joinWaitlist(eventId, gymId);
              haptic('success');
              showToast(COPY.timetable.waitlistJoined, 'success');
              prefetchTimetableData(true);
            } catch (wlErr) {
              haptic('error');
              showToast(formatCopyText(COPY.timetable.waitlistFailed, { error: wlErr.message }), 'error');
            }
          } else {
            haptic('error');
            showToast(formatCopyText(COPY.timetable.quickBookFailedMessage, { error: bookRes.error || COPY.timetable.bookingDeclined }), 'error');
          }
          return;
        }
        haptic('success');
        showToast(COPY.timetable.quickBooked, 'success');
        api.notifyBookingSuccess(bookingNotifyPayload(event, { source: 'quickbook', gymId, slots: [] })).catch(() => {});
        await refreshUserData(true);
        await refreshBookingState();
      } catch (err) {
        haptic('error');
        showToast(formatCopyText(COPY.timetable.quickBookFailedMessage, { error: err.message }), 'error');
      }
      return;
    }

    // C1-3: slot ids are strings (see AGENTS.md "Normalized ids are STRINGS,
    // raw event fields are numbers"). MarianaTek's mock spot ids look like
    // `mock-bag-1` — Number() on those is NaN, which collapses every non-
    // numeric spot to the same value and breaks membership checks below.
    const liveAvailable = slots.filter((s) => s.isAvailable).map((s) => String(s.id));

    if (liveAvailable.length === 0) {
      showToast(COPY.timetable.fullyBookedJoining, 'warning');
      try {
        await api.joinWaitlist(eventId, gymId);
        haptic('success');
        showToast(COPY.timetable.waitlistJoined, 'success');
        prefetchTimetableData(true);
      } catch (wlErr) {
        haptic('error');
        showToast(formatCopyText(COPY.timetable.waitlistFailed, { error: wlErr.message }), 'error');
      }
      return;
    }

    const primarySlots = preferredSlots.map(String).filter(id => liveAvailable.includes(id));

    let rowSlots = [];
    if (preferredRows && preferredRows.length > 0 && slots.length > 0) {
      preferredRows.forEach(ry => {
        const slotsInRow = slots.filter(s => s.row === ry);
        const rowSlotIds = slotsInRow.map(s => String(s.id));
        rowSlotIds.forEach(id => {
          if (liveAvailable.includes(id) && !primarySlots.includes(id) && !rowSlots.includes(id)) {
            rowSlots.push(id);
          }
        });
      });
    }

    const slotsToTry = [...primarySlots, ...rowSlots];
    const finalBookAny = slots.length === 0 || bookAny;

    if (finalBookAny) {
      const remainingAvailable = liveAvailable.filter(id => !slotsToTry.includes(id));
      slotsToTry.push(...remainingAvailable);
    }

    if (slotsToTry.length === 0) {
      haptic('error');
      showToast(COPY.timetable.noEligibleSlots, 'error');
      return;
    }

    const attemptResult = await bookCandidateSpots({
      candidates: slotsToTry,
      requiredCount,
      book: (targetSlot, requestOptions) => api.book(eventId, [targetSlot], gymId, requestOptions),
    });
    const bookedCount = attemptResult.booked.length;
    const lastBooked = attemptResult.booked.at(-1) || null;
    const lastBookedSlot = lastBooked?.slotId ?? null;
    const lastBookingRes = lastBooked?.result ?? null;
    const bookedSlotLabels = attemptResult.booked.map(({ slotId }) => {
      const slot = slots.find(s => sameId(s.id, slotId));
      return formatSpotLabel(gymId, slot || slotId);
    });
    const qbNoun = seatNoun(event.discipline || eventData.discipline);

    if (bookedCount > 0) {
      haptic('success');
      api.notifyBookingSuccess(bookingNotifyPayload(event, { source: 'quickbook', gymId, slots: bookedSlotLabels })).catch(() => {});
      let upgradeRegistered = false;
      if (lastBookedSlot !== null) {
        const upgradeRes = await tryAutoRegisterUpgrade(event, lastBookedSlot, lastBookingRes, autoUpgrade, { silent: true });
        upgradeRegistered = Boolean(upgradeRes?.registered);
      }
      const slotText = bookedSlotLabels.length > 0 ? ` ${qbNoun} ${bookedSlotLabels.join(', ')}` : '';
      const upgradeNote = upgradeRegistered ? COPY.timetable.upgradeEnabledNote : '';
      showToast(formatCopyText(COPY.timetable.quickBookedDetail, { slots: slotText, upgrade: upgradeNote }), 'success');

      await refreshUserData(true);
      await refreshBookingState();
      setTimeout(() => {
        if (!upgradeRegistered && !isAutoUpgradeDefaultEnabled(event.gymId) && gymSetting(event.gymId, 'autoUpgradeEnabled') !== false) {
          showToast(COPY.timetable.autoUpgradeTip, 'info');
        }
      }, 2500);
    } else {
      haptic('error');
      const failure = attemptResult.terminalError;
      showToast(formatCopyText(COPY.timetable.quickBookFailedMessage, {
        error: failure?.error || COPY.timetable.bookingDeclined,
      }), 'error');
    }
  } catch (err) {
    showToast(formatCopyText(COPY.timetable.quickBookError, { error: err.message }), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = COPY.timetable.book;
    }
  }
}

// Modal handler for spot selection layout and auto-book row preference checklist
/**
 * A guest is never an extra self-attendee: MarianaTek requires a guest email
 * and consumes a guest allowance. This small, explicit flow is intentionally
 * reachable only from an existing booking card and the timetable overflow.
 */
export async function openGuestBookingModal(c) {
  if (!canForGym('guestBooking', c.gymId)) {
    showToast(COPY.bookings.guestBookingUnavailable, 'warning');
    return;
  }
  const modal = document.getElementById('sa-booking-modal');
  const body = document.getElementById('sa-booking-modal-body');
  const title = document.getElementById('sa-booking-modal-title');
  if (!modal || !body || !title) return;

  title.textContent = COPY.bookings.bookGuest;
  applyBookingChrome(modal, { titleText: COPY.bookings.bookGuest, gymId: c.gymId, locationName: c.locationName, studioName: c.studioName });
  body.innerHTML = '<div class="psycle-loading-spinner-container" style="padding:40px 0;"><div class="psycle-spinner"></div><span>Checking guest eligibility…</span></div>';
  openNavPage(modal, { id: 'book-guest' });
  const close = () => {
    if (closeNavPage(modal)) return;
    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
  };
  document.getElementById('sa-booking-modal-close').onclick = close;
  modal.querySelector('.sa-modal-overlay').onclick = close;

  try {
    const [entitlement, details] = await Promise.all([
      api.getBookingEntitlement(c.id, c.gymId),
      api.getEventDetails(c.id, c.gymId),
    ]);
    if (!entitlement.guestEligible) {
      body.innerHTML = `<div class="sa-card-error" style="padding:24px;text-align:center;">${escapeHtml(COPY.bookings.guestBookingUnavailable)}</div>`;
      return;
    }
    const slots = details.slots || [];
    const available = slots.filter((slot) => slot.isAvailable);
    // A pick-a-spot class requires a selection; FCFS has no slots and omits it.
    let selectedSlotId = available[0] ? String(available[0].id) : null;
    if ((details.slots || []).length && !selectedSlotId) {
      body.innerHTML = `<div class="sa-card-error" style="padding:24px;text-align:center;">${escapeHtml(COPY.bookings.guestNoSpot)}</div>`;
      return;
    }
    const passCount = Number(entitlement.guestPassesRemaining);
    const passNote = Number.isFinite(passCount)
      ? `<p style="margin:0 0 12px;color:var(--text-secondary);font-size:13px;">${formatCopyText(COPY.bookings.guestPassesRemaining, { count: passCount, plural: passCount === 1 ? '' : 'es' })}</p>`
      : '';
    body.innerHTML = `
      <div class="sa-guest-booking" style="display:flex;flex-direction:column;gap:14px;">
        ${passNote}
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text-secondary);">${COPY.bookings.guestEmail}
          <input id="guest-booking-email" class="psycle-input" type="email" autocomplete="email" inputmode="email" required>
        </label>
        ${slots.length ? `<div class="guest-live-map"><div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">${COPY.bookings.selectGuestSpot}</div>
          <div class="guest-map-legend" aria-label="Spot map key">
            <span class="is-self">${COPY.bookings.guestMapSelf}</span><span class="is-guest">${COPY.bookings.guestMapGuest}</span><span class="is-available">${COPY.bookings.guestMapAvailable}</span><span class="is-unavailable">${COPY.bookings.guestMapUnavailable}</span>
          </div>
          <div id="guest-booking-map"></div>
        </div>` : ''}
        <button class="psycle-btn" id="guest-booking-submit" style="background:var(--accent-fill);color:var(--on-accent-fill);">${COPY.bookings.guestBookingSubmit}</button>
      </div>`;
    const submit = body.querySelector('#guest-booking-submit');
    if (slots.length) {
      const reservationStates = new Map();
      userBookings().filter((booking) => matchesEvent(booking, c)).forEach((booking) => {
        const slot = booking.slotId ?? booking.slot_id ?? booking.raw?.spot?.id;
        if (slot != null && slot !== '') reservationStates.set(String(slot), booking.isGuest ? 'guest' : 'self');
      });
      renderStudioFloorPlan(body.querySelector('#guest-booking-map'), slots, [], [], () => {}, {
        layoutObjects: details.objects || [],
        availableSlots: available.map((slot) => String(slot.id)),
        slotStates: reservationStates,
        selectionLimit: 1,
        hideSummary: true,
        hideActions: true,
        hideEditHint: true,
        onSelectionChange: (selected) => {
          selectedSlotId = selected.length ? String(selected[0]) : null;
          submit.disabled = !selectedSlotId;
        },
      });
    }
    submit.onclick = async () => {
      const email = body.querySelector('#guest-booking-email').value.trim();
      submit.disabled = true;
      submit.textContent = COPY.timetable.booking;
      try {
        const result = await api.bookGuest(c.id, selectedSlotId, email, c.gymId);
        if (!result.ok) throw new Error(result.error || COPY.bookings.guestBookingUnavailable);
        showToast(COPY.bookings.guestBooked, 'success');
        close();
        await refreshUserData(true);
        await refreshBookingState();
      } catch (err) {
        showToast(formatCopyText(COPY.bookings.guestBookingError, { error: err.message }), 'error');
        submit.disabled = false;
        submit.textContent = COPY.bookings.guestBookingSubmit;
      }
    };
  } catch (err) {
    body.innerHTML = `<div class="sa-card-error" style="padding:24px;text-align:center;">${escapeHtml(formatCopyText(COPY.bookings.guestBookingError, { error: err.message }))}</div>`;
  }
}

export async function openBookingModal(c, mode, opts = {}) {
  // mode: 'book' (simple seat selector) | 'quickbook' (preference setter) | 'autobook' (preference setter)
  // U1-12: book / quickbook both end in a real booking, so the overlap
  // confirmation comes before this modal (or any other) opens. Callers that have
  // already asked pass `overlapChecked`.
  if ((mode === 'book' || mode === 'quickbook') && !opts.overlapChecked) {
    if (!(await overlapGate(c, mode))) return;
  }
  const isAutoBookMode = mode === 'autobook';
  const isQuickBookMode = mode === 'quickbook';
  const isSimpleBookMode = mode === 'book';
  const isSpotFlowStep = !!(opts.setupFlow || opts.oneOffSpots);

  // Mobile, Step A gate (spotmap-booking-flow-spec section 2): Quick-Book / Auto-Book on a map gym
  // with no saved spots go through the one-time setup page first. "Choose a spot" never does.
  if (isMobile() && (isQuickBookMode || isAutoBookMode) && !opts.setupDone) {
    try {
      const { hasPrefs } = await resolveStudioPrefs(c);
      const { hasMap } = getStudioMapInfo(c);
      if (hasMap && !hasPrefs && !setupDeferred(c.gymId, c.studioId)) {
        const next = (extra) => (pageEl, saved) => openBookingModal(c, mode, { ...opts, overlapChecked: true, setupDone: true, replaceEl: pageEl, savedPrefs: saved || null, ...extra });
        openSpotSetup({
          event: c, className: c.discipline || c.name, rowGroups: rowGroupsForStudio(c.studioId, c.gymId),
          onSaved: (slots, rows) => {
            // Keep the shared prefs cache in step (resolveStudioPrefs reads it); a refetch can race invalidation.
            cache.studioPreferences = { ...(cache.studioPreferences || {}), [`${c.gymId}:${c.studioId}`]: { preferredSlots: slots, preferredRows: rows } };
          },
          onContinue: (pageEl, saved) => openBookingModal(c, mode, spotSetupBookingOptions(opts, pageEl, saved)),
          onChooseForNow: (pageEl) => openBookingModal(c, 'book', {
            ...opts, overlapChecked: true, setupDone: true, replaceEl: pageEl, oneOffSpots: true,
          }),
        });
        return;
      }
    } catch (_) { /* fall through to the combined modal */ }
  }

  const modal = document.getElementById('sa-booking-modal');
  const body = document.getElementById('sa-booking-modal-body');
  const title = document.getElementById('sa-booking-modal-title');
  if (!modal || !body || !title) return;

  const noun = seatNoun(c.discipline);
  title.textContent = isAutoBookMode ? COPY.timetable.configureAutoBook : (isQuickBookMode ? COPY.bookingFlow.titleFinishQuickBook : `Select a ${noun} in the studio`);
  const bookingChrome = () => applyBookingChrome(modal, {
    titleText: isAutoBookMode ? COPY.bookingFlow.titleAutoBook : (isQuickBookMode ? COPY.bookingFlow.titleFinishQuickBook : COPY.bookingFlow.titleBook),
    gymId: c.gymId, locationName: c.locationName, studioName: c.studioName, stepper: opts.setupFlow ? 'B' : null,
  });
  bookingChrome();

  // Use cached layout if available — layouts don't change mid-session.
  // WP-C5: the cache now holds NormalizedSlot[]/NormalizedLayoutObject[] (see
  // below), so this is only consulted for the loading-message copy here.
  // C3-21: keyed by gym too — two gyms can publish the same studio id.
  const cachedLayout = api.peekStudioLayout(c.studioId, c.gymId);
  const hasLayout = cachedLayout?.slots?.length > 0;

  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span>${hasLayout ? COPY.timetable.checkingAvailability : COPY.timetable.loadingFloorMap}</span>
    </div>
  `;

  openNavPage(modal, { id: 'booking', replaceEl: opts.replaceEl });

  const closeBtn = document.getElementById('sa-booking-modal-close');
  const overlay = modal.querySelector('.sa-modal-overlay');

  const closeModal = () => {
    if (closeNavPage(modal)) return; // mobile page: pop its history entry
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
  };

  closeBtn.onclick = closeModal;
  overlay.onclick = closeModal;
  delete closeBtn.dataset.nav;

  // Refresh credits when opening booking modal (force — user needs accurate counts)
  await refreshUserData(true);

  try {
    // WP-C5: this renderer consumes NormalizedSlot[] / NormalizedLayoutObject[]
    // straight from the adapter — no raw `studio.layout` access anywhere below
    // — so a MarianaTek layout (an entirely different raw shape) renders here
    // unchanged. Slot `.id` arrives as a string and is coerced to Number for
    // every comparison, matching how preferred-spot maps and bookings store
    // slot ids. Credit metadata is read from the NORMALIZED event
    // (`event.credits`) — `.raw` has no gymId and no credits, and reading it
    // here resolved the balance against the wrong gym.
    const {
      event,
      slots: eventSlots,
      objects: eventObjects,
      maxBookableSlots: providerMaxBookableSlots,
    } = await api.getEventDetails(c.id, c.gymId);
    // MarianaTek publishes per-account eligibility rather than a tenant-wide
    // seat count. It is deliberately fetched only for gyms that opt into that
    // normalized contract; existing providers retain their current limits.
    let bookingEntitlement = null;
    if (canForGym('bookingEntitlement', c.gymId)) {
      try { bookingEntitlement = await api.getBookingEntitlement(c.id, c.gymId); }
      catch (_) { /* provider remains authoritative at submit time */ }
    }

    // A studio's floor plan doesn't vary class-to-class, so a previously-seen
    // layout for this studio is a valid stand-in when THIS event's payload
    // arrives without one (the pre-C5 code kept the same defensive
    // fuller-layout-wins rule, but sourced its fallback from the raw /studios
    // list; the cache is now normalized end-to-end, populated only from this
    // same adapter response). Availability is always taken from the event, never
    // the cache — it's per-class and changes constantly.
    const useCached = hasLayout && cachedLayout.slots.length > eventSlots.length;
    const layoutSlots = useCached ? cachedLayout.slots : eventSlots;
    const layoutObjects = useCached ? cachedLayout.objects : eventObjects;
    if (eventSlots.length > 0) {
      api.rememberStudioLayout(c.studioId, c.gymId, eventSlots, eventObjects);
    }
    // C1-3: keep slot ids as strings throughout this modal — see AGENTS.md
    // "Normalized ids are STRINGS, raw event fields are numbers". A MarianaTek
    // studio's spot ids are not guaranteed numeric (the mock uses `mock-bag-1`
    // etc.), and Number() on those collapses distinct spots to NaN, which then
    // silently satisfies Array.includes(NaN) for every one of them.
    const availableIds = new Set(eventSlots.filter(s => s.isAvailable).map(s => String(s.id)));
    const availableSlots = layoutSlots.map(s => String(s.id)).filter(id => availableIds.has(id));
    const attendeeLimit = bookingEntitlement
      ? Math.max(1, Number(bookingEntitlement.maxSelfBookings) || 1)
      : maxAttendeesPerClass({
        providerLimit: providerMaxBookableSlots,
        gymLimit: capabilityForGym('maxSpotsPerClass', c.gymId),
      });
    const attendeeOptions = bookingQuantityOptions(attendeeLimit);
    const showAttendeeSelector = attendeeOptions.length > 1;

    // Determine if booking window is already open
    const classReleaseTime = getClassReleaseTime(c);
    const isLive = classReleaseTime ? classReleaseTime.toMillis() <= Date.now() : true;

    const instrName = metadata.instructors.find(i => sameId(i.id, c.instructors?.[0]?.id) && (!c.gymId || i.gymId === c.gymId))?.name || '';
    const eventType = metadata.eventTypes.find(t => sameId(t.id, c.classTypeId) && (!c.gymId || t.gymId === c.gymId));
    const groupName = c.discipline || eventType?.group || eventType?.name || COPY.autoBook.class;
    const nounCap = seatNoun(groupName)[0].toUpperCase() + seatNoun(groupName).slice(1);
    const startDate = new Date(c.startAt);
    const timeStr = formatInZone(c.startAt, zoneFor(c)).timeLabel;
    const studioName = c.studioName || gymScopedGet(studioMap, c.studioId, c.gymId) || COPY.spotSelection.thisStudio;

    if (isAutoBookMode) {
      title.textContent = formatCopyText(COPY.timetable.autoBookModalTitle, { time: timeStr, className: groupName, instructor: instrName ? ` with ${instrName}` : '' });
    } else if (isQuickBookMode) {
      title.textContent = formatCopyText(COPY.timetable.quickBookModalTitle, { studio: studioName, time: timeStr, className: groupName, instructor: instrName ? ` with ${instrName}` : '' });
    } else {
      title.textContent = formatCopyText(COPY.timetable.chooseSeatFor, { noun: seatNoun(groupName), time: timeStr, className: groupName, instructor: instrName ? ` with ${instrName}` : '' });
    }
    // Mobile: static title + identity strip (class details move to the class card above the map).
    applyBookingChrome(modal, {
      titleText: isAutoBookMode ? COPY.bookingFlow.titleAutoBook : COPY.bookingFlow.titleBook,
      gymId: c.gymId, locationName: c.locationName, studioName, stepper: opts.setupFlow ? 'B' : null,
    });
    const classCtx = {
      className: groupName === c.name || !c.name ? groupName : c.name, instructorName: instrName || c.instructors?.[0]?.name || '',
      instructorPhoto: c.instructors?.[0]?.thumbUrl || c.instructors?.[0]?.imageUrl, startAt: c.startAt,
      spotsLeft: Array.isArray(availableSlots) ? availableSlots.length : undefined, gymId: c.gymId, timeZone: c.timeZone,
    };
    // Auto-Book: the map is for preferences, picked when booking OPENS (release instant), not live occupancy.
    const releaseDT = isAutoBookMode ? getClassReleaseTime(c) : null;
    if (releaseDT) classCtx.releaseAt = releaseDT.toISO();
    const releaseWhen = releaseDT ? formatInZone(releaseDT.toISO(), zoneFor(c)) : null;
    const classHelper = {
      helperId: 'spotmap-live',
          helperText: opts.oneOffSpots
        ? COPY.bookingFlow.oneOffSpots
        : isAutoBookMode
        ? (releaseWhen ? formatCopyText(COPY.bookingFlow.helperAutoBookAt, { time: `${releaseWhen.date}, ${releaseWhen.timeLabel}` }) : COPY.bookingFlow.helperAutoBook)
        : COPY.bookingFlow.helperLive,
    };

    if (layoutSlots.length === 0) {
      // Mobile compact page for Auto-Book on a class with no assigned spots: explanation, quantity, one action.
      const compactAuto = isMobile() && isAutoBookMode;
      body.innerHTML = compactAuto ? `
        <div class="sa-bk-compact">
          <p>${COPY.bookingFlow.fcfsAutoBook}</p>
          ${showAttendeeSelector ? `<label class="sa-bk-compact-qty"><span>${COPY.bookingFlow.spotsToBook}</span>
            <select id="compact-autobook-qty" class="psycle-select">${attendeeOptions.map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>` : ''}
          <button class="psycle-btn" id="btn-save-simple-autobook" style="background: var(--feat-autoupgrade); color:var(--on-accent); display:flex; align-items:center; justify-content:center; gap:6px;">${COPY.bookingFlow.titleAutoBook}</button>
        </div>` : `
        <div style="padding: 24px; text-align: center; color: var(--text-secondary);">
          <p style="margin-bottom: 16px;">${COPY.timetable.noFloorMap}</p>
          ${isAutoBookMode
            ? `<button class="psycle-btn" id="btn-save-simple-autobook" style="background: var(--feat-autoupgrade); color:var(--on-accent); display:flex; align-items:center; justify-content:center; gap:6px;">${sparklesIcon(14, 'currentColor')} ${COPY.timetable.scheduleAnySeat}</button>`
            : `<button class="psycle-btn" id="btn-book-any" style="background:var(--accent-fill);color:var(--on-accent-fill);">${formatCopyText(COPY.timetable.bookAnyAvailable, { noun: nounCap })}</button>`
          }
        </div>
      `;

      mountBookingContext(body, null, classCtx, { helperId: 'spotmap-live' });
      if (isAutoBookMode) {
        document.getElementById('btn-save-simple-autobook').onclick = () => {
          const qtyEl = document.getElementById('compact-autobook-qty');
          saveAutoBookPreferences(c, [], [], qtyEl ? (parseInt(qtyEl.value) || 1) : 1, true, closeModal);
        };
      } else {
        document.getElementById('btn-book-any').onclick = () => bookSeatDirect(
          c.id, availableSlots[0], closeModal, c, layoutSlots.find((slot) => sameId(slot.id, availableSlots[0]))
        );
      }
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    layoutSlots.forEach(s => {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    });

    const widthRange = maxX - minX || 1;
    const heightRange = maxY - minY || 1;

    // Slots are positioned across 72% of the map height and are 28px tall. To keep a
    // minimum gap between rows (so they never overlap), give the map a minimum height
    // informed by the row count: ~56px per row (28px slot + 12px gap over the 72% span).
    const rowCount = new Set(layoutSlots.map(s => s.y)).size;
    const minMapHeight = Math.max(340, rowCount * 56);

    body.innerHTML = `
      <div id="sa-modal-info-banner" style="margin-bottom:10px;"></div>
      <div class="sa-floor-plan-container" style="position:relative;height:${minMapHeight}px;background:var(--surface-inset);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;overflow:hidden;">
        <div id="sa-floor-plan-grid" style="width:100%;height:100%;"></div>
      </div>
      <div id="psycle-map-edit-toggle"></div>
      <div id="sa-slot-summary" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;min-height:16px;${opts.setupFlow ? 'display:none;' : ''}"></div>
      <div id="sa-modal-controls-container"></div>
    `;

    const floorGrid = body.querySelector('#sa-floor-plan-grid');
    mountBookingContext(body, body.querySelector('.sa-floor-plan-container'), classCtx, classHelper);

    // Render Stage — NormalizedLayoutObject[]; empty for providers with none.
    layoutObjects.forEach(obj => {
      const left = widthRange === 0 ? 50 : ((obj.x - minX) / widthRange) * 80 + 10;
      const top = heightRange === 0 ? 10 : ((obj.y - minY) / heightRange) * 75 + 10;
      const stage = document.createElement('div');
      stage.className = 'sa-minimap-stage';
      stage.style.cssText = `position: absolute; left: ${left}%; top: ${top}%; transform: translate(-50%, -50%); background: color-mix(in srgb, var(--text) 15%, transparent); border: 1px solid color-mix(in srgb, var(--text) 30%, transparent); padding: 4px 16px; border-radius: 6px; font-size: 12px; font-weight: bold; color: #fff; letter-spacing: 0.5px;`;
      stage.textContent = COPY.timetable.stage;
      floorGrid.appendChild(stage);
    });

    // ── State ──────────────────────────────────────────────────────────
    const availableCredits = getAvailableCreditsForEvent(c);
    const upgradeCreditsNeeded = isAutoBookMode ? availableCredits + 1 : 0; // auto-upgrade needs +1 for the upgrade spot before cancelling
    // THIS class's own gym — not the ambient one. Reading the wrong gym here
    // either wrongly capped a Psycle class to JAB's 1-spot limit, or let a JAB
    // class (1 primary spot per member) be booked past that limit.
    const gymMaxSpots = capabilityForGym('maxSpotsPerClass', c.gymId) ?? null;
    const effectiveLimit = gymMaxSpots != null ? Math.min(gymMaxSpots, availableCredits) : availableCredits;
    const legacyMaxBookableSlots = Math.min(providerMaxBookableSlots ?? (availableSlots.length || 1), effectiveLimit);
    const maxBookableSlots = bookingEntitlement
      ? Math.min(attendeeLimit, availableSlots.length || attendeeLimit)
      : legacyMaxBookableSlots;
    const rowGroups = rowGroupsForStudio(c.studioId, c.gymId);
    const state = {
      selectedSlots: [],    // ordered array of slot IDs (index 0 = priority 1)
      selectedRows: new Set(),
      qty: isSimpleBookMode ? maxBookableSlots : 1,  // simple-book: limit selection to max available; quick-book/auto-book: qty selector controls this
      bookAny: true
    };

    // Pre-populate from saved studio prefs (auto-book and quick-book modes)
    let hasExistingPrefs = false;
    try {
      const studioPrefs = await api.getStudioPreferences();
      const prefs = (c.gymId && studioPrefs[`${c.gymId}:${c.studioId}`]) || studioPrefs[c.studioId] || {};
      hasExistingPrefs = (prefs.preferredSlots?.length > 0) || (prefs.preferredRows?.length > 0);
      if (isAutoBookMode || isQuickBookMode) {
        (prefs.preferredSlots || []).forEach(s => state.selectedSlots.push(String(s)));
        if (rowGroups) (prefs.preferredRows || []).forEach(r => state.selectedRows.add(Number(r)));
        state.qty = prefs.requiredCount || 1;
        state.bookAny = prefs.bookAny !== false;
      }
    } catch (e) {}
    // Arrived from Step A: use exactly what was just saved (a refetch can race the cache invalidation).
    if (opts.savedPrefs && (isAutoBookMode || isQuickBookMode)) {
      state.selectedSlots.length = 0;
      (opts.savedPrefs.slots || []).forEach(s => state.selectedSlots.push(String(s)));
      state.selectedRows = new Set(rowGroups ? (opts.savedPrefs.rows || []).map(Number) : []);
      hasExistingPrefs = state.selectedSlots.length > 0 || state.selectedRows.size > 0;
    }
    state.qty = Math.max(1, Math.min(attendeeLimit, Number(state.qty) || 1));

    // Quick-Book shows the saved map read-only until the user explicitly unlocks it.
    // First-time setup (no saved prefs) starts editable since there's nothing to lock.
    let mapEditing = !((isQuickBookMode || isAutoBookMode) && hasExistingPrefs);

    // Snapshot so we can detect whether the user changed the spot map from its saved state.
    const initialSlots = [...state.selectedSlots];
    const initialRowsArr = [...state.selectedRows];
    const mapChanged = () => {
      if (state.selectedSlots.length !== initialSlots.length) return true;
      if (state.selectedSlots.some((id, i) => id !== initialSlots[i])) return true;
      if (state.selectedRows.size !== initialRowsArr.length) return true;
      for (const r of state.selectedRows) if (!initialRowsArr.includes(r)) return true;
      return false;
    };

    // ── Render floor plan with row selection overlay ──────────────────
    const rowYs = [...new Set(layoutSlots.map(s => s.y))].sort((a, b) => a - b);
    const slotsByRow = new Map(); // y → slots
    rowYs.forEach(y => { slotsByRow.set(y, layoutSlots.filter(s => s.y === y)); });

    // Hoisted so the read-only map's edit toggle can refresh banners/controls
    let updateSimpleBookControls = null;
    // Auto-Upgrade without saved spots: a visible, tappable way to fix it (never a silently greyed box).
    const upgradeNeedsRowHtml = () => `<div class="sa-au-needs"><span class="t">${trendingUpIcon(12, 'currentColor', 2)} ${COPY.spotSetup.needsSpots}</span><button type="button" class="psycle-btn sa-au-setup" data-au-setup>${COPY.spotSetup.setUpSpots}</button></div>`;
    let openSetupChild = () => {};
    let updateQuickBookControls = null;
    let updateAutoBookControls = null;

    const autoChosenSlot = () => {
      const preferred = state.selectedSlots.map(String).filter(id => availableSlots.includes(id));
      const rowPreferred = rowYs
        .filter(y => state.selectedRows.has(y))
        .flatMap(y => (slotsByRow.get(y) || []).map(slot => String(slot.id)))
        .filter(id => availableSlots.includes(id) && !preferred.includes(id));
      const ordered = [...preferred, ...rowPreferred];
      if (state.bookAny) ordered.push(...availableSlots.filter(id => !ordered.includes(id)));
      return ordered[0] || null;
    };

    const render = () => {
      floorGrid.innerHTML = '';
      const summaryEl = body.querySelector('#sa-slot-summary');

      // Cyan row backdrops (rendered first, so they stay behind)
      state.selectedRows.forEach(y => {
        const rowSlots = slotsByRow.get(y) || [];
        if (rowSlots.length === 0) return;
        const minYinRow = Math.min(...rowSlots.map(s => s.y));
        const maxYinRow = Math.max(...rowSlots.map(s => s.y));
        const minXinRow = Math.min(...rowSlots.map(s => s.x));
        const maxXinRow = Math.max(...rowSlots.map(s => s.x));

        const left = widthRange === 0 ? 5 : ((minXinRow - minX) / widthRange) * 78 + 5;
        const top = heightRange === 0 ? 10 : ((minYinRow - minY) / heightRange) * 72 + 10;
        const width = widthRange === 0 ? 70 : ((maxXinRow - minXinRow) / widthRange) * 78 + 8;
        const height = heightRange === 0 ? 70 : ((maxYinRow - minYinRow) / heightRange) * 72 + 8;

        const backdrop = document.createElement('div');
        backdrop.style.cssText = `position:absolute;left:${left}%;top:${top}%;width:${width}%;height:${height}%;background:color-mix(in srgb, var(--info) 10%, transparent);border:2px solid color-mix(in srgb, var(--info) 30%, transparent);border-radius:12px;pointer-events:none;z-index:0;`;
        floorGrid.appendChild(backdrop);
      });

      // Slot bubbles
      const chosenSlotId = opts.setupFlow && isQuickBookMode ? autoChosenSlot() : null;
      layoutSlots.forEach(slot => {
        const slotId = String(slot.id);
        const isAvailable = availableSlots.includes(slotId);
        const priority = state.selectedSlots.indexOf(slotId) + 1;
        const inRow = state.selectedRows.has(slot.y);

        const left = widthRange === 0 ? 50 : ((slot.x - minX) / widthRange) * 78 + 8;
        const top = heightRange === 0 ? 50 : ((slot.y - minY) / heightRange) * 72 + 14;
        const label = slot.label || String(slotId);

        const bubble = document.createElement('div');
        bubble.style.position = 'absolute';
        bubble.style.left = `${left}%`;
        bubble.style.top = `${top}%`;
        bubble.style.transform = 'translate(-50%,-50%)';
        bubble.style.width = '28px';
        bubble.style.height = '28px';
        bubble.style.borderRadius = '6px';
        bubble.style.display = 'flex';
        bubble.style.alignItems = 'center';
        bubble.style.justifyContent = 'center';
        bubble.style.fontSize = '10px';
        bubble.style.fontWeight = '700';
        bubble.style.cursor = mapEditing ? 'pointer' : 'default';
        bubble.style.userSelect = 'none';
        bubble.style.transition = 'all 0.1s';
        bubble.style.boxSizing = 'border-box';
        bubble.style.zIndex = '1';
        bubble.title = formatCopyText(COPY.timetable.seatTitle, { label });

        if (opts.setupFlow && isQuickBookMode && priority > 0) {
          // On the final setup step, make the actual current candidate obvious
          // instead of presenting every preferred spot as if all were chosen.
          bubble.style.background = 'color-mix(in srgb, var(--gym-btn) 12%, transparent)';
          bubble.style.border = '1px solid color-mix(in srgb, var(--gym-btn) 35%, transparent)';
          bubble.style.color = 'var(--gym-ink)';
          bubble.textContent = label;
        } else if (priority > 0) {
          // Selected
          bubble.style.background = 'var(--feat-autoupgrade)';
          bubble.style.border = '2px solid color-mix(in srgb, var(--feat-autoupgrade) 70%, #000)';
          bubble.style.color = '#fff';
          bubble.textContent = String(priority);
          if (!isAvailable) {
            // Occupied but selected = danger ring
            bubble.style.boxShadow = '0 0 0 2px var(--danger)';
          }
        } else if (inRow) {
          // In selected row — cyan is a floor-plan-specific indicator, kept literal
          bubble.style.background = 'color-mix(in srgb, var(--info) 25%, transparent)';
          bubble.style.border = '1px solid color-mix(in srgb, var(--info) 50%, transparent)';
          bubble.style.color = 'var(--info)';
          bubble.textContent = label;
        } else if (isAvailable) {
          // Available, not selected
          bubble.style.background = 'color-mix(in srgb, var(--success) 15%, transparent)';
          bubble.style.border = '1px solid color-mix(in srgb, var(--success) 35%, transparent)';
          bubble.style.color = 'var(--success)';
          bubble.textContent = label;
        } else {
          // Occupied, not selected
          bubble.style.background = 'var(--surface-inset)';
          bubble.style.border = '1px solid var(--border)';
          bubble.style.color = 'var(--text-tertiary)';
          bubble.textContent = label;
        }

        if (chosenSlotId === slotId) {
          bubble.style.background = 'var(--gym-btn)';
          bubble.style.border = '2px solid color-mix(in srgb, var(--gym-btn) 75%, #000)';
          bubble.style.color = 'var(--gym-on)';
          bubble.style.boxShadow = '0 0 0 4px color-mix(in srgb, var(--gym-btn) 28%, transparent), 0 0 18px color-mix(in srgb, var(--gym-btn) 55%, transparent)';
          bubble.style.width = '36px';
          bubble.style.height = '36px';
          bubble.style.fontSize = '12px';
          bubble.style.zIndex = '5';
          bubble.textContent = layoutSlots.find(s => String(s.id) === chosenSlotId)?.label || chosenSlotId;
          bubble.setAttribute('aria-label', `Automatically chosen spot ${bubble.textContent}`);
        }

        if (mapEditing) bubble.addEventListener('click', () => {
          const idx = state.selectedSlots.indexOf(slotId);
          if (idx !== -1) {
            // Already selected — deselect
            state.selectedSlots.splice(idx, 1);
          } else {
            // Not selected — try to select. U1-14: only a real booking refuses an
            // occupied spot; quick-book / auto-book are choosing PREFERENCES.
            const rule = spotSelectionRule({ mode, isAvailable });
            if (!rule.allowed) {
              showToast(formatCopyText(COPY.timetable.occupiedUnavailable, { noun: seatNoun(groupName) }), 'warning');
              return;
            }
            if (rule.notice === 'will-target') {
              showToast(COPY.timetable.occupiedNow, 'info');
            }
            // Simple-book: limit selection to qty (credits/max-spots). Quick-book &
            // auto-book are preference setters — the spot map is unlimited; only the
            // "Slots to book" dropdown is policed by credits (via credit warning).
            const qtyLimit = isSimpleBookMode ? state.qty : Infinity;
            if (state.selectedSlots.length < qtyLimit) {
              state.selectedSlots.push(slotId);
            } else if (isSimpleBookMode && qtyLimit === 1) {
              // Single-spot limit: replace existing choice with new spot
              state.selectedSlots = [slotId];
            } else {
              showToast(formatCopyText(COPY.timetable.maxSpots, { count: state.qty, noun: seatNoun(groupName), plural: state.qty !== 1 ? 's' : '' }), 'info');
              return;
            }
          }
          render();
        });

        floorGrid.appendChild(bubble);
      });

      if (chosenSlotId) {
        const chosen = layoutSlots.find(s => String(s.id) === chosenSlotId);
        const chosenLabel = escapeHtml(formatSpotLabel(c.gymId, chosen || chosenSlotId));
        const notice = document.createElement('div');
        notice.className = 'sa-auto-chosen-spot';
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        const sentence = escapeHtml(appCopy(COPY.bookingFlow.autoChosenSpotSentence));
        notice.innerHTML = sentence.replace('{slot}', `<span class="sa-auto-chosen-spot__badge">${chosenLabel}</span>`);
        floorGrid.appendChild(notice);
      }

      // Row +/- buttons (overlaid on right edge) — only for preference modes, not simple book, and only while editing
      if (rowSelectorVisible({ rowGroups, rowCount: rowYs.length, editing: !isSimpleBookMode && mapEditing })) {
        rowYs.forEach((y, idx) => {
          const isOn = state.selectedRows.has(y);
          const rowSlots = slotsByRow.get(y) || [];
          if (rowSlots.length === 0) return;
          const midY = (Math.min(...rowSlots.map(s => s.y)) + Math.max(...rowSlots.map(s => s.y))) / 2;

          const top = heightRange === 0 ? 50 : ((midY - minY) / heightRange) * 72 + 14;
          const btn = document.createElement('button');
          btn.style.cssText = `position:absolute;left:95.5%;top:${top}%;transform:translate(-50%,-50%);width:26px;height:26px;padding:0;border-radius:50%;background:${isOn ? 'color-mix(in srgb, var(--info) 30%, transparent)' : 'var(--surface-inset)'};border:1px solid ${isOn ? 'color-mix(in srgb, var(--info) 50%, transparent)' : 'var(--border-strong)'};color:${isOn ? 'var(--info)' : 'var(--text-secondary)'};font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.1s;z-index:2;`;
          btn.textContent = isOn ? '−' : '+';
          btn.title = isOn ? formatCopyText(COPY.timetable.removeRow, { row: idx + 1 }) : formatCopyText(COPY.timetable.addRow, { row: idx + 1 });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.selectedRows.has(y)) state.selectedRows.delete(y);
            else state.selectedRows.add(y);
            render();
          });
          floorGrid.appendChild(btn);
        });
      }

      // Update summary
      if (summaryEl) {
        const spotLabels = state.selectedSlots.map(id => {
          const slot = layoutSlots.find(s => String(s.id) === id);
          return formatSpotLabel(c.gymId, slot || id);
        });
        const rowLabels = Array.from(state.selectedRows).map(y => {
          const idx = rowYs.indexOf(y);
          return idx >= 0 ? String(idx + 1) : String(y);
        });
        if (spotLabels.length === 0 && rowLabels.length === 0) {
          summaryEl.innerHTML = `<span style="color:var(--text-tertiary);font-style:italic;">${COPY.spotMapEditor.noneSelected}</span>`;
        } else {
          const fmt = (labels, noun) => {
            const shown = labels.slice(0, 3);
            const rest = labels.length > 3 ? ` <span style="color:var(--text-tertiary);">${formatCopyText(COPY.timetable.moreCount, { count: labels.length - 3 })}</span>` : '';
            return `<span style="color:var(--text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">${noun}</span> <span style="color:var(--text);font-weight:700;">${shown.map(escapeHtml).join(', ')}</span>${rest}`;
          };
          const parts = [];
          if (spotLabels.length > 0) parts.push(fmt(spotLabels, COPY.timetable.spotLabel));
          if (rowLabels.length > 0) parts.push(fmt(rowLabels, COPY.timetable.rowLabel));
          const sep = ' <span style="color:var(--text-tertiary);margin:0 4px;">›</span> ';
          summaryEl.innerHTML = `<span style="color:var(--text-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-right:6px;">${COPY.timetable.preferredLabel}</span>${parts.join(sep)}`;
        }
      }

      // Unmapped warning
      if (isAutoBookMode) {
        const layoutSlotIds = new Set(layoutSlots.map(s => String(s.id)));
        const unmappedSlots = availableSlots.filter(id => !layoutSlotIds.has(id));
        const unmappedEl = body.querySelector('#psycle-unmapped-warning');
        if (unmappedEl) {
          unmappedEl.style.display = unmappedSlots.length > 0 ? 'block' : 'none';
          if (unmappedSlots.length > 0) {
            unmappedEl.innerHTML = `<strong>${COPY.timetable.additionalAvailableSpots}</strong> ${unmappedSlots.map(escapeHtml).join(', ')}`;
          }
        }
      }

      // Update simple book controls to reflect current selection
      if (isSimpleBookMode && typeof updateSimpleBookControls !== 'undefined') {
        updateSimpleBookControls();
      }
    };

    // Wide "edit preferred spots" button attached beneath the map (Quick-Book read-only mode)
    const updateMapEditToggle = () => {
      const toggle = body.querySelector('#psycle-map-edit-toggle');
      if (!toggle) return;
      toggle.innerHTML = '';
      // Quick-Book follows the saved map directly; edit it later in Settings or
      // choose a one-off spot through the separate Book action. Auto-Book keeps
      // its in-context editor because those preferences control a future job.
      if (!shouldShowPreferredMapEditToggle(mode, mapEditing)) return;
      const editBtn = document.createElement('button');
      editBtn.className = 'psycle-btn';
      editBtn.style.cssText = 'width:100%;margin-bottom:12px;background:color-mix(in srgb, var(--feat-autoupgrade) 12%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 30%, transparent);color:var(--feat-autoupgrade);';
      editBtn.textContent = formatCopyText(COPY.timetable.editPreferredSpots, { studio: studioName });
      editBtn.onclick = () => {
        mapEditing = true;
        render();
        if (typeof updateQuickBookControls === 'function') updateQuickBookControls();
        if (typeof updateAutoBookControls === 'function') updateAutoBookControls();
      };
      toggle.appendChild(editBtn);
    };

    // ── Auto-Book controls ─────────────────────────────────────────────
    if (isAutoBookMode) {
      const controls = body.querySelector('#sa-modal-controls-container');
      const layoutSlotIds = new Set(layoutSlots.map(s => String(s.id)));
      const unmappedSlots = availableSlots.filter(id => !layoutSlotIds.has(id));
      const releaseStr = isLive ? '' : classReleaseTime.toFormat('EEE d MMM, HH:mm');

      updateAutoBookControls = () => {
        const selectedQty = parseInt(controls.querySelector('#autobook-qty')?.value || state.qty) || 1;
        const creditsNeeded = selectedQty;
        const hasEnoughCredits = availableCredits >= creditsNeeded;
        const creditWarning = !hasEnoughCredits
          ? `${formatCopyText(COPY.timetable.autoBookCreditShortfall, { count: creditsNeeded - availableCredits, plural: creditsNeeded - availableCredits !== 1 ? 's' : '' })}`
          : '';

        body.querySelector('#sa-modal-info-banner').hidden = !!(opts.setupFlow || opts.oneOffSpots);
        body.querySelector('#sa-modal-info-banner').innerHTML = mapEditing
          ? `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">${formatCopyText(COPY.timetable.editingSharedMapHtml, { studio: escapeHtml(studioName), features: 'Quick-Book and Auto-Upgrade too' })}</div>`
          : `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">${formatCopyText(COPY.timetable.sharedMapForStudioHtml, { studio: escapeHtml(studioName) })}</div>`;

        const toggleEl = body.querySelector('#psycle-map-edit-toggle');
        if (toggleEl && mapEditing && !opts.setupFlow && !opts.oneOffSpots) {
          const hint = toggleEl.querySelector('.ab-map-hint');
          if (!hint) {
            const h = document.createElement('div');
            h.className = 'ab-map-hint';
            h.style.cssText = 'font-size:12px;color:var(--text-secondary);font-style:italic;margin:8px 0 4px;';
            h.textContent = `${COPY.timetable.mapEditInstructionHtml}${rowGroups && rowYs.length > 1 ? ` ${COPY.timetable.mapEditRowsInstruction}` : ''}`;
            toggleEl.appendChild(h);
          }
        }

        controls.innerHTML = `
          <div class="sa-booking-controls${isSpotFlowStep ? ' is-spot-flow' : ''}" style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
            ${unmappedSlots.length > 0 ? `<div id="psycle-unmapped-warning" style="font-size:12px;color:var(--warning);background:color-mix(in srgb,var(--warning) 8%,transparent);border:1px solid color-mix(in srgb,var(--warning) 20%,transparent);border-radius:6px;padding:6px 10px;"></div>` : ''}
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            <div style="display:flex;gap:14px;align-items:center;">
              ${showAttendeeSelector ? `<div style="width:110px;">
                <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">${COPY.timetable.slotsToBook}</label>
                <select id="autobook-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
                  ${attendeeOptions.map(n => `<option value="${n}" ${state.qty===n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>` : ''}
              <div style="flex:1;padding-top:14px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="sa-ms-checkbox" id="autobook-fallback-any" ${state.bookAny ? 'checked' : ''}>
                  <span>${COPY.timetable.bookAnyPreferredFallback}</span>
                </label>
              </div>
            </div>
            ${(() => {
              const hasLayout = layoutSlots.length > 0;
              const hasPrefs = state.selectedSlots.length > 0 || state.selectedRows.size > 0;
              if (!hasLayout || !canForGym('autoUpgrade', c.gymId)) return '';
              if (!hasPrefs && isMobile()) return upgradeNeedsRowHtml();
              if (!hasPrefs) return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-tertiary);user-select:none;cursor:not-allowed;">
                  <input type="checkbox" class="sa-ms-checkbox" id="autobook-auto-upgrade" disabled>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} ${COPY.timetable.autoUpgradeConfigurePrompt}</span>
                </label>`;
              return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="sa-ms-checkbox" id="autobook-auto-upgrade" ${isAutoUpgradeDefaultEnabled(c.gymId) ? 'checked' : ''}>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} ${COPY.timetable.autoUpgradeKeepSearchingLabel}</span>
                </label>`;
            })()}
            <button class="psycle-btn" id="btn-save-autobook" style="width:100%;background:var(--feat-autoupgrade);color:var(--on-accent);display:flex;align-items:center;justify-content:center;gap:6px;">${sparklesIcon(14, 'currentColor')} ${!opts.oneOffSpots && mapChanged() ? `${COPY.spotMapEditor.saveMapAnd} ` : ''}${COPY.timetable.scheduleAutoBook}</button>
            <div style="font-size:12px;text-align:center;color:${isLive ? 'var(--success)' : 'var(--text-tertiary)'};">
              ${isLive ? COPY.timetable.bookingWindowIsOpen : `${formatCopyText(COPY.timetable.bookingOpens, { date: `<span style="color:var(--text-secondary);">${escapeHtml(releaseStr)}</span>` })}`}
            </div>
          </div>
        `;

        controls.querySelector('[data-au-setup]')?.addEventListener('click', () => openSetupChild());
        const qtySelector = controls.querySelector('#autobook-qty');
        if (qtySelector) qtySelector.onchange = () => {
          state.qty = parseInt(qtySelector.value) || 1;
          updateAutoBookControls();
        };

        controls.querySelector('#btn-save-autobook').onclick = () => {
          const qty = parseInt(controls.querySelector('#autobook-qty')?.value || state.qty) || 1;
          const fallbackAny = controls.querySelector('#autobook-fallback-any').checked;
          const autoUpgrade = controls.querySelector('#autobook-auto-upgrade')?.checked ?? false;
          const preferredSlots = [...state.selectedSlots];
          const preferredRows = [...state.selectedRows];
          saveAutoBookPreferences(c, preferredSlots, preferredRows, qty, fallbackAny, closeModal, isLive, autoUpgrade, !opts.oneOffSpots);
        };

      };

      updateAutoBookControls();
    } else if (isSimpleBookMode) {
      // ── Simple Book controls (just pick slots, no preferences) ────────────────────
      const controls = body.querySelector('#sa-modal-controls-container');

      // Mobile: set up preferred spots as a Back-arrow child; the live selection on this page survives.
      const openSimpleSetup = () => openStudioFloorPlanEditor(c.studioId, studioName, (slots = [], rows = []) => {
        hasExistingPrefs = slots.length > 0 || rows.length > 0;     // from the saved payload, not a racing refetch
        cache.studioPreferences = { ...(cache.studioPreferences || {}), [`${c.gymId}:${c.studioId}`]: { preferredSlots: slots, preferredRows: rows } };
        body.querySelector('.sa-bk-banner')?.remove();
        updateSimpleBookControls();
      }, { gymId: c.gymId });
      if (isMobile() && !hasExistingPrefs && layoutSlots.length > 0) {
        const banner = bannerEl('spotmap-simple-setup', COPY.bookingFlow.simpleSetupBanner, COPY.spotSetup.setUpSpots, openSimpleSetup);
        if (banner) body.prepend(banner);
      }

      updateSimpleBookControls = () => {
        const slotsSelected = state.selectedSlots.length || 0;
        const isDataLoaded = isCreditInventoryLoaded(cache, c.gymId, isMetered(c.gymId));
        const hasEnoughCredits = slotsSelected === 0 || availableCredits >= slotsSelected;
        const needsMoreCredits = slotsSelected > availableCredits ? slotsSelected - availableCredits : 0;
        const creditWarning = needsMoreCredits > 0 && isDataLoaded
          ? `${formatCopyText(COPY.timetable.simpleBookCreditShortfall, { count: needsMoreCredits, plural: needsMoreCredits !== 1 ? 's' : '' })}`
          : '';

        controls.innerHTML = `
          <div class="sa-booking-controls${isSpotFlowStep ? ' is-spot-flow' : ''}" style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
            <div style="font-size:12px;color:var(--text-secondary);font-style:italic;">${formatCopyText(COPY.timetable.simpleBookPrompt, { noun: seatNoun(groupName), count: `<strong>${isDataLoaded ? availableCredits : '?'}</strong>`, plural: availableCredits !== 1 ? 's' : '' })}</div>
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            ${(() => {
              const hasLayout = layoutSlots.length > 0;
              const hasPrefs = hasExistingPrefs;
              if (!hasLayout || !canForGym('autoUpgrade', c.gymId)) return '';
              if (!hasPrefs && isMobile()) return upgradeNeedsRowHtml();
              if (!hasPrefs) return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-tertiary);user-select:none;cursor:not-allowed;font-weight:500;">
                  <input type="checkbox" class="sa-ms-checkbox" id="simplebook-auto-upgrade" disabled>
                  <span style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${trendingUpIcon(12, 'currentColor', 2)} ${formatCopyText(COPY.timetable.autoUpgradeConfigureFirstHtml, { studio: escapeHtml(studioName) })}</span>
                </label>`;
              return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;font-weight:500;">
                  <input type="checkbox" class="sa-ms-checkbox" id="simplebook-auto-upgrade" ${isAutoUpgradeDefaultEnabled(c.gymId) ? 'checked' : ''}>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} ${COPY.timetable.autoUpgradeKeepSearchingLabel}</span>
                </label>`;
            })()}
            <div style="display:flex;gap:8px;">
              <button class="psycle-btn" id="btn-book-simple" style="flex:1;background:var(--accent-fill);color:var(--on-accent-fill);" ${!isDataLoaded || !hasEnoughCredits ? 'disabled' : ''}>${formatCopyText(COPY.timetable.bookSelectedPlain, { noun: nounCap })}</button>
            </div>
          </div>
        `;

        controls.querySelector('[data-au-setup]')?.addEventListener('click', () => openSimpleSetup());
        const configLink = controls.querySelector('#simplebook-configure-link');
        if (configLink) {
          configLink.onclick = (e) => {
            e.preventDefault();
            if (isMobile()) { openSimpleSetup(); return; }
            // Close the booking modal synchronously to avoid transition race conditions
            modal.classList.remove('show');
            modal.style.display = 'none';
            // Open the dedicated studio floor plan editor from settings
            openStudioFloorPlanEditor(c.studioId, studioName, () => {
              // Re-open the simple booking modal when the preferences are saved
              openBookingModal(c, 'book', { overlapChecked: true });
            }, { gymId: c.gymId });
          };
        }

        controls.querySelector('#btn-book-simple').onclick = async () => {
          if (state.selectedSlots.length === 0) {
            showToast(formatCopyText(COPY.timetable.pleaseSelectSpots, { noun: seatNoun(groupName) }), 'warning');
            return;
          }
          if (state.selectedSlots.length > availableCredits) {
            showToast(formatCopyText(COPY.timetable.simpleBookSelectedCredits, { credits: availableCredits, creditPlural: availableCredits !== 1 ? 's' : '', count: state.selectedSlots.length, noun: seatNoun(groupName), nounPlural: state.selectedSlots.length !== 1 ? 's' : '' }), 'warning');
            return;
          }
          const btn = controls.querySelector('#btn-book-simple');
          if (isWithin12Hours(c.startAt) && btn.dataset.confirmState !== 'confirm') {
            btn.dataset.confirmState = 'confirm';
            btn.textContent = COPY.timetable.confirmSoon;
            btn.style.background = 'var(--warning)';
            setTimeout(() => {
              if (btn.dataset.confirmState === 'confirm') {
                delete btn.dataset.confirmState;
                btn.textContent = formatCopyText(COPY.timetable.bookSelected, { noun: nounCap });
                btn.style.background = '';
              }
            }, 4000);
            return;
          }
          delete btn.dataset.confirmState;
          btn.disabled = true;
          btn.textContent = COPY.timetable.booking;
          try {
            // One request per spot: api.book() books exactly one, because
            // MarianaTek creates one reservation per call (see base.js). Sequential
            // rather than parallel so a mid-way failure leaves a knowable state —
            // `results` says which spots actually got booked.
            const results = [];
            for (const slotId of state.selectedSlots) {
              const r = await api.book(c.id, [slotId], c.gymId);
              if (!r.ok) {
                if (results.length === 0) throw new Error(r.error || COPY.timetable.bookingDeclined);
                // Partial success: keep what we got and tell the truth about it.
                showToast(formatCopyText(COPY.timetable.bookCountPartial, { booked: results.length, total: state.selectedSlots.length, declined: r.error || COPY.timetable.remainingDeclined }), 'error');
                break;
              }
              results.push(r);
            }
            if (results.length === 0) return;
            const bookingRes = { ok: true, bookings: results, bookingId: results[0]?.bookingId, slotId: results[0]?.slotId };
            const bookedSlots = state.selectedSlots.slice(0, results.length);
            const bookedLabels = bookedSlots.map(id => {
              const s = layoutSlots.find(ls => String(ls.id) === String(id));
              return formatSpotLabel(c.gymId, s || id);
            });
            api.notifyBookingSuccess({
              source: 'manual', eventId: c.id, gymId: c.gymId || null, className: c.name || groupName, groupName,
              instructorName: instrName, startAt: c.startAt, slots: bookedLabels,
            }).catch(() => {});
            const autoUpgrade = controls.querySelector('#simplebook-auto-upgrade')?.checked ?? false;
            closeModal();
            let upgradeRegistered = false;
            if (bookedSlots.length > 0) {
              const upgradeRes = await tryAutoRegisterUpgrade(c, bookedSlots[0], bookingRes, autoUpgrade, { silent: true });
              upgradeRegistered = Boolean(upgradeRes?.registered);
            }
            if (results.length === state.selectedSlots.length) {
              const upgradeNote = upgradeRegistered ? COPY.timetable.upgradeEnabledNote : '';
              showToast(formatCopyText(COPY.timetable.bookedCount, { count: state.selectedSlots.length, noun: seatNoun(groupName), plural: state.selectedSlots.length > 1 ? 's' : '', note: upgradeNote }), 'success');
            }
            await refreshUserData(true);
            await refreshBookingState();
          } catch (err) {
            showToast(formatCopyText(COPY.timetable.bookingFailed, { error: err.message }), 'error');
            btn.disabled = false;
            btn.textContent = formatCopyText(COPY.timetable.bookSelected, { noun: nounCap });
          }
        };
      };

      updateSimpleBookControls();
    } else if (isQuickBookMode) {
      // ── Quick-Book controls (preference setter) ────────────────────────────────────────
      const controls = body.querySelector('#sa-modal-controls-container');

      updateQuickBookControls = () => {
        const selectedQty = parseInt(controls.querySelector('#quickbook-qty')?.value || state.qty) || 1;
        const creditsNeeded = selectedQty;
        const hasEnoughCredits = availableCredits >= creditsNeeded;
        const creditWarning = !hasEnoughCredits
          ? `${formatCopyText(COPY.timetable.quickBookCreditShortfall, { count: creditsNeeded - availableCredits, plural: creditsNeeded - availableCredits !== 1 ? 's' : '' })}`
          : '';

        body.querySelector('#sa-modal-info-banner').hidden = !!(opts.setupFlow || opts.oneOffSpots);
        body.querySelector('#sa-modal-info-banner').innerHTML = !mapEditing
          ? `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">${COPY.timetable.quickBookBannerHtml}</div>`
          : (hasExistingPrefs
            ? `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">${formatCopyText(COPY.timetable.editingQuickBookMapHtml, { studio: escapeHtml(studioName) })}</div>`
            : `<div style="font-size:12px;color:var(--text-tertiary);background:color-mix(in srgb,var(--feat-autoupgrade) 7%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 15%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5;">${formatCopyText(COPY.timetable.quickBookFirstSetupHtml, { studio: escapeHtml(studioName) })}</div>`);

        const qbToggleEl = body.querySelector('#psycle-map-edit-toggle');
        if (qbToggleEl && mapEditing && !opts.setupFlow && !opts.oneOffSpots && !qbToggleEl.querySelector('.ab-map-hint')) {
          const h = document.createElement('div');
          h.className = 'ab-map-hint';
          h.style.cssText = 'font-size:12px;color:var(--text-secondary);font-style:italic;margin:8px 0 4px;';
          h.textContent = `${COPY.timetable.mapEditInstructionHtml}${rowGroups && rowYs.length > 1 ? ` ${COPY.timetable.mapEditRowsInstruction}` : ''}`;
          qbToggleEl.appendChild(h);
        } else if (qbToggleEl && !mapEditing) {
          const existing = qbToggleEl.querySelector('.ab-map-hint');
          if (existing) existing.remove();
        }

        controls.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            <div style="display:flex;gap:14px;align-items:center;">
              ${showAttendeeSelector ? `<div style="width:110px;">
                <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">${COPY.timetable.slotsToBook}</label>
                <select id="quickbook-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
                  ${attendeeOptions.map(n => `<option value="${n}" ${state.qty===n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>` : ''}
              <div style="flex:1;padding-top:14px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="sa-ms-checkbox" id="quickbook-fallback-any" ${state.bookAny ? 'checked' : ''}>
                  <span>${COPY.timetable.bookAnyPreferredFallback}</span>
                </label>
              </div>
            </div>
            ${(() => {
              const hasLayout = layoutSlots.length > 0;
              const hasPrefs = state.selectedSlots.length > 0 || state.selectedRows.size > 0;
              if (!hasLayout || !canForGym('autoUpgrade', c.gymId)) return '';
              if (!hasPrefs && isMobile()) return upgradeNeedsRowHtml();
              if (!hasPrefs) return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-tertiary);user-select:none;cursor:not-allowed;">
                  <input type="checkbox" class="sa-ms-checkbox" id="quickbook-auto-upgrade" disabled>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} ${COPY.timetable.autoUpgradeConfigurePrompt}</span>
                </label>`;
              return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="sa-ms-checkbox" id="quickbook-auto-upgrade" ${isAutoUpgradeDefaultEnabled(c.gymId) ? 'checked' : ''}>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} ${COPY.timetable.autoUpgradeKeepSearchingLabel}</span>
                </label>`;
            })()}
            <button class="psycle-btn" id="btn-submit-quickbook" style="width:100%;background:var(--accent-fill);color:var(--on-accent-fill);">${!opts.oneOffSpots && mapChanged() ? `${COPY.spotMapEditor.saveMapAnd} ` : ''}${COPY.timetable.quickBook}</button>
          </div>
        `;

        controls.querySelector('[data-au-setup]')?.addEventListener('click', () => openSetupChild());
        controls.querySelector('#btn-submit-quickbook').onclick = async () => {
          if (state.selectedSlots.length === 0 && state.selectedRows.size === 0) {
            showToast(formatCopyText(COPY.timetable.pleaseSelectSpotOrRow, { noun: seatNoun(groupName) }), 'warning');
            return;
          }
          const btn = controls.querySelector('#btn-submit-quickbook');
          const baseLabel = `${!opts.oneOffSpots && mapChanged() ? `${COPY.spotMapEditor.saveMapAnd} ` : ''}${COPY.timetable.quickBook}`;
          if (isWithin12Hours(c.startAt) && btn.dataset.confirmState !== 'confirm') {
            btn.dataset.confirmState = 'confirm';
            btn.textContent = COPY.timetable.confirmSoon;
            btn.style.background = 'var(--warning)';
            setTimeout(() => {
              if (btn.dataset.confirmState === 'confirm') {
                delete btn.dataset.confirmState;
                btn.textContent = baseLabel;
                btn.style.background = '';
              }
            }, 4000);
            return;
          }
          delete btn.dataset.confirmState;
          btn.disabled = true;
          btn.textContent = COPY.timetable.booking;
          try {
            const qty = parseInt(controls.querySelector('#quickbook-qty')?.value || state.qty) || 1;
            const fallbackAny = controls.querySelector('#quickbook-fallback-any').checked;
            const autoUpgrade = controls.querySelector('#quickbook-auto-upgrade')?.checked ?? false;
            const slots = [...state.selectedSlots];
            const rows = [...state.selectedRows];
            if (mapChanged() && c.studioId && !opts.oneOffSpots) {
              // This class's gym — a studio id is unique only within one.
              await api.updateStudioPreferences(c.studioId, { preferredSlots: slots, preferredRows: rows }, c.gymId);
            }
            await quickBookClass(c.id, {
              preferredSlots: slots,
              preferredRows: rows,
              requiredCount: qty,
              bookAny: fallbackAny,
              autoUpgrade
            }, null, c.gymId);
            closeModal();
          } catch (err) {
            showToast(formatCopyText(COPY.timetable.quickBookError, { error: err.message }), 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = baseLabel;
          }
        };

        const quickbookQtySelector = controls.querySelector('#quickbook-qty');
        if (quickbookQtySelector) quickbookQtySelector.onchange = () => {
          state.qty = parseInt(quickbookQtySelector.value) || 1;
          updateQuickBookControls();
        };
      };

      updateQuickBookControls();
    }

    // Step A as a Back-arrow child of this page; on save the selection becomes the saved map and the
    // controls re-render with Auto-Upgrade enabled (qty / fallback live in `state`, so they are untouched).
    openSetupChild = () => openStudioFloorPlanEditor(c.studioId, studioName, (slots = [], rows = []) => {
      // The fallback box is only read from the DOM at submit time; capture it before the controls re-render.
      const fb = body.querySelector('#autobook-fallback-any, #quickbook-fallback-any');
      if (fb) state.bookAny = fb.checked;
      state.selectedSlots.length = 0;
      slots.forEach(s => state.selectedSlots.push(String(s)));
      state.selectedRows = new Set(rowGroups ? rows.map(Number) : []);
      initialSlots.length = 0; initialSlots.push(...state.selectedSlots);
      initialRowsArr.length = 0; initialRowsArr.push(...state.selectedRows);
      hasExistingPrefs = state.selectedSlots.length > 0 || state.selectedRows.size > 0;
      cache.studioPreferences = { ...(cache.studioPreferences || {}), [`${c.gymId}:${c.studioId}`]: { preferredSlots: slots, preferredRows: rows } };
      mapEditing = !hasExistingPrefs;
      render();
      updateMapEditToggle();
      if (typeof updateQuickBookControls === 'function') updateQuickBookControls();
      if (typeof updateAutoBookControls === 'function') updateAutoBookControls();
    }, { gymId: c.gymId });

    render();
    updateMapEditToggle();

    // U1-14: first-time setup. A studio with a seat map but no saved preferred map
    // opens on an intro; Next swaps in the map that is already rendered behind it.
    if (!isMobile() && needsSetupIntro({ mode, hasSavedMap: hasExistingPrefs, hasSeatMap: layoutSlots.length > 0 })) {
      const copy = setupIntroCopy({
        gymName: getGymShortName(c.gymId),
        locationName: trimLocation(c.locationName || '', getGymShortName(c.gymId)),
      });
      const modeTitle = title.textContent;
      const held = [...body.children];
      held.forEach((el) => { el.dataset.setupDisplay = el.style.display || ''; el.style.display = 'none'; });
      title.textContent = copy.header;
      const intro = document.createElement('div');
      intro.id = 'sa-setup-intro';
      intro.style.cssText = 'padding:8px 0 4px;';
      intro.innerHTML = `
        <p style="margin:0 0 10px;font-size:16px;font-weight:600;color:var(--text);">${copy.sub}</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:var(--text-secondary);">${copy.bodyHtml}</p>
        <button type="button" class="psycle-btn" id="sa-setup-next" style="width:100%;background:var(--accent-fill);color:var(--on-accent-fill);">${copy.next}</button>`;
      body.appendChild(intro);
      intro.querySelector('#sa-setup-next').onclick = () => {
        intro.remove();
        held.forEach((el) => { el.style.display = el.dataset.setupDisplay || ''; delete el.dataset.setupDisplay; });
        title.textContent = modeTitle;
      };
      intro.querySelector('#sa-setup-next').focus();
    }
  } catch (err) {
    console.error('[Timetable] Modal load floor map failed:', err);
    body.innerHTML = `<div class="sa-card-error" style="color: var(--danger); padding: 20px 0; text-align: center;">${formatCopyText(COPY.timetable.errorLoadingLayout, { error: escapeHtml(err.message) })}</div>`;
  }
}

// Auto-register upgrade monitor after a successful booking if the setting is on
async function tryAutoRegisterUpgrade(event, bookedSlotId, bookingRes, enableOverride, { silent = false } = {}) {
  const shouldRegister = enableOverride !== undefined ? enableOverride : isAutoUpgradeDefaultEnabled(event?.gymId);
  debugConsole('[AutoUpgrade] tryAutoRegisterUpgrade called', { shouldRegister, bookedSlotId, eventId: event?.id });
  if (!shouldRegister) {
    debugConsole('[AutoUpgrade] Skipping — auto-upgrade is disabled. userSettings:', JSON.stringify(userSettings));
    return { registered: false };
  }
  if (event?.gymId && gymSetting(event.gymId, 'autoUpgradeEnabled') === false) {
    try {
      await api.updateSettings({ autoUpgradeEnabled: true }, event.gymId);
      if (cache.gymSettings?.[event.gymId]) cache.gymSettings[event.gymId].autoUpgradeEnabled = true;
    } catch (e) {
      console.warn('[AutoUpgrade] Failed to enable autoUpgradeEnabled on explicit upgrade:', e.message);
    }
  }
  try {
    const studioId = event.studioId;
    debugConsole('[AutoUpgrade] Studio ID:', studioId, '| event.studio:', event.studio);

    // Same resolution Quick-Book used, so the two cannot disagree.
    const { prefs, hasPrefs } = await resolveStudioPrefs(event);
    debugConsole('[AutoUpgrade] Resolved prefs:', prefs, 'hasPrefs:', hasPrefs);
    if (!hasPrefs) {
      const studioName = event.studioName || gymScopedGet(studioMap, studioId, event.gymId) || COPY.spotSelection.thisStudio;
      debugConsole('[AutoUpgrade] No preferred spot map for studio:', studioName, '| prefs:', prefs);
      if (!silent) {
        showToast(formatCopyText(COPY.timetable.autoUpgradeMapRequired, { studio: studioName }), 'warning');
      }
      return { registered: false, reason: 'no_prefs' };
    }

    // Resolve booking IDs and slot IDs from response
    const registerPromises = [];
    
    // A NormalizedBookingResult carries { bookingId, slotId } directly, for every
    // provider. This used to unpack CodexFit's `{ bookings: { id: slot } }` map
    // and fall back through two more raw shapes — none of which MarianaTek emits.
    const booked = [];
    if (bookingRes?.bookingId != null) {
      booked.push({ bookingId: bookingRes.bookingId, slotId: bookingRes.slotId ?? bookedSlotId });
    } else if (Array.isArray(bookingRes?.bookings)) {
      // Multi-slot: one result per booked spot.
      for (const b of bookingRes.bookings) {
        if (b?.bookingId != null) booked.push({ bookingId: b.bookingId, slotId: b.slotId ?? bookedSlotId });
      }
    }
    for (const b of booked) {
      registerPromises.push(api.addAutoUpgrade({
        eventId: event.id,
        // See the addAutoBooking note: without this the monitor is stored
        // against the account's active gym, not this class's own.
        gymId: event.gymId || null,
        studioId: studioId || null,
        bookingId: Number(b.bookingId),
        currentSlotId: b.slotId,
        className: event.name || event.name || 'Class',
        instructorName: event.instructors?.[0]?.name || (event.instructors?.[0]?.name) || '',
        studioName: event.studioName || event.studioName || '',
        locationName: event.locationName || event.locationName || '',
        startAt: event.startAt || event.startAt,
        preferences: { keepOriginalOnCutoff: keepOriginalForAutoCreate(gymSetting(event.gymId, 'autoUpgradeKeepOriginalByDefault')) },
      }));
    }

    if (registerPromises.length === 0) {
      console.warn('[AutoUpgrade] Could not resolve any booking IDs — giving up. Response:', bookingRes);
      return { registered: false, reason: 'no_booking_id' };
    }

    await Promise.all(registerPromises);
    if (!silent) {
      showToast(formatCopyText(COPY.timetable.monitorStartedCount, { count: registerPromises.length }), 'info');
    }
    debugConsole('[AutoUpgrade] Monitors registered successfully.');
    return { registered: true, count: registerPromises.length };
  } catch (err) {
    console.warn('[AutoUpgrade] Failed to auto-register:', err.message, err);
    return { registered: false, error: err };
  }
}

// Perform direct booking of spot ID
async function bookSeatDirect(eventId, slotId, callback, event, slot = null) {
  try {
    showToast(formatCopyText(COPY.timetable.bookingSpot, { slot: formatSpotLabel(event?.gymId, slot || slotId) }), 'info');
    const bookingRes = await api.book(eventId, slotId == null ? [] : [slotId], event?.gymId);
    if (!bookingRes.ok) throw new Error(bookingRes.error || COPY.timetable.bookingDeclined);
    callback();
    let upgradeRes = null;
    if (event) upgradeRes = await tryAutoRegisterUpgrade(event, slotId, bookingRes, undefined, { silent: true });
    const upgradeNote = upgradeRes?.registered ? COPY.timetable.upgradeEnabledNote : '';
    haptic('success');
    showToast(formatCopyText(COPY.timetable.spotBooked, { note: upgradeNote }), 'success');
    await refreshUserData(true);
    prefetchTimetableData(true);
  } catch (err) {
    haptic('error');
    showToast(formatCopyText(COPY.timetable.bookingFailed, { error: err.message }), 'error');
  }
}

function isWithin12Hours(startAt) {
  if (!startAt) return false;
  const diff = new Date(startAt) - new Date();
  return diff > 0 && diff <= 12 * 60 * 60 * 1000;
}

// Cancel Booking direct — requires a second click to confirm, unless within
// the 60s grace period (data-grace-deadline attribute present), in which case
// the cancel fires immediately without confirmation.
/**
 * `gymId` is REQUIRED, not optional.
 *
 * This was the only write in this module that didn't carry it, so a cancel from
 * a merged timetable row went to whichever gym the server resolves by default
 * — a JAB booking id looked up against Psycle, which answers "Cancelling
 * failed". The same action from My Bookings worked, because that module has
 * always passed the row's gym. Per-row actions carry their own gym; the active
 * gym is never a substitute for one.
 */
async function cancelBookingDirect(bookingId, isPenalty, btn, gymId) {
  const performCancel = async () => {
    btn.disabled = true;
    btn.textContent = COPY.timetable.cancelling;
    try {
      showToast(COPY.timetable.cancelBooking, 'info');
      await api.cancel(bookingId, gymId);
      haptic('warning');
      showToast(COPY.timetable.cancelled, 'success');

      // Remove any active upgrade monitor for this booking
      const activeUpgrade = cache.upgrades?.find(u =>
        String(u.booking_id) === String(bookingId) &&
        ['active', 'paused_no_credits'].includes(u.status)
      );
      if (activeUpgrade) {
        try {
          await api.deleteAutoUpgrade(activeUpgrade.id, gymId);
        } catch (e) {
          console.warn('[Cancel] Could not remove upgrade monitor:', e.message);
        }
      }

      await refreshUserData(true);
      await refreshBookingState();
    } catch (err) {
      haptic('error');
      showToast(formatCopyText(COPY.timetable.cancelFailed, { error: err.message }), 'error');
      btn.disabled = false;
      btn.textContent = COPY.bookings.cancel;
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
    }
  };

  // 60s grace period: cancel immediately, no confirmation
  if (btn.hasAttribute('data-grace-deadline')) {
    btn.removeAttribute('data-grace-deadline');
    await performCancel();
    return;
  }

  if (btn.dataset.confirmState !== 'confirm') {
    haptic('medium');
    btn.dataset.confirmState = 'confirm';
    btn.textContent = isPenalty ? COPY.timetable.confirmPenaltyCancel : COPY.timetable.confirmCancel;
    btn.style.background = 'var(--danger)';
    btn.style.borderColor = 'var(--danger)';
    btn.style.color = 'var(--on-accent)';

    // Auto-reset confirmation state after 4 seconds
    setTimeout(() => {
      if (btn.dataset.confirmState === 'confirm') {
        btn.removeAttribute('data-confirm-state');
        btn.textContent = COPY.bookings.cancel;
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
      }
    }, 4000);
    return;
  }

  btn.removeAttribute('data-confirm-state');
  await performCancel();
}

// Save scheduled auto-booking record to database
async function saveAutoBookPreferences(c, slots, rows, qty, bookAny, callback, skipImmediate = false, autoUpgrade = false, persistStudioMap = true) {
  const gymMatch = (x) => !c.gymId || x.gymId === c.gymId;
  // The EVENT's own instructor wins over a metadata lookup: the caller already
  // has the name and photo, and for MarianaTek the by-id lookup misses often
  // enough that real names were being dropped. Empty (not a literal
  // "Instructor" placeholder) when a class genuinely has no instructor — that
  // string was being written straight into auto_bookings.instructor_name and
  // rendering as a real name forever.
  const eventInstructor = c.instructors?.[0] || null;
  const instructor = eventInstructor
    || metadata.instructors.find(i => sameId(i.id, c.instructors?.[0]?.id) && gymMatch(i))
    || { name: '' };
  // Persisted because a queue row is read back long after the timetable
  // metadata that could resolve a photo by name has moved on (MarianaTek's
  // instructor list only covers the upcoming-class window).
  const instructorImageUrl = eventInstructor?.thumbUrl || eventInstructor?.imageUrl
    || metadata.instructors.find(i => sameId(i.id, eventInstructor?.id) && gymMatch(i))?.thumbUrl
    || null;
  const studio = metadata.studios.find(s => sameId(s.id, c.studioId) && gymMatch(s)) || { name: 'Studio' };
  const classType = metadata.eventTypes.find(t => sameId(t.id, c.classTypeId) && gymMatch(t)) || { name: 'Class' };
  const studioLocationId = studio.locationId || selectedLocations[0] || c.locationId;
  const location = metadata.locations.find(l => String(l.id) === String(studioLocationId) && gymMatch(l)) || { name: 'Location' };

  // Strip event type prefix from class name (e.g., "RIDE: Signature 45" → "Signature 45")
  const groupName = c.discipline || classType?.group || classType.name || 'Class';
  // U1-19b: this used its own "TYPE: " prefix test, which never matched JAB's
  // "TRAIN - Lower (Focus)" (so the toast and the queued row's class_name kept
  // the prefix). Use the one shared rule.
  const fullClassName = c.name || classType.name;
  const strippedClassName = cleanClassName(fullClassName, groupName) || fullClassName;

  try {
    showToast(COPY.timetable.scheduling, 'info');

    // The studio spot map is the shared source of truth. If the user picked
    // spots/rows here, persist them to the studio map so the live resolver (and
    // every other feature for this studio) uses the same selection.
    if (persistStudioMap && c.studioId && (slots.length > 0 || rows.length > 0)) {
      try {
        await api.updateStudioPreferences(c.studioId, { preferredSlots: slots, preferredRows: rows }, c.gymId);
      } catch (e) {
        console.warn('[AutoBook] Could not persist studio map:', e.message);
      }
    }

    const availForAB = getAvailableCreditsForEvent(c);
    const creditShortfall = Number.isFinite(availForAB) ? Math.max(0, qty - availForAB) : 0;

    const autoBookBody = {
      eventId: c.id,
      durationMin: c.durationMin || null,
      // Without this the server falls back to db.resolveActiveGymId(userId) —
      // the ACCOUNT's globally active gym, not this class's own — so
      // auto-booking a JAB class while Psycle is active silently queued it
      // against Psycle: wrong gym rail, wrong (Psycle) credit balance checked.
      gymId: c.gymId || null,
      studioId: c.studioId || null,
      className: strippedClassName,
      groupName,
      instructorName: instructor.full_name || instructor.name || '',
      instructorImageUrl,
      studioName: studio.name,
      locationName: location.name,
      startAt: c.startAt,
      // The gym's own release instant, when it publishes one (WP-D8). A
      // per-class gym has no weekday rule for the scheduler to recompute this
      // from later, so if it isn't captured here it is gone.
      releaseAt: c.releaseAt || null,
      skipImmediate,
      creditShortfall,
      preferences: {
        preferredSlots: slots,
        preferredRows: rows,
        requiredCount: qty,
        bookAny,
        autoUpgrade
      }
    };

    // U1-6: the server refuses an overlapping auto-book (409 OVERLAP_CONFIRM_REQUIRED,
    // nothing inserted) until the member has seen what it clashes with. Show it as
    // a confirmation; only "Auto-book anyway" resubmits with confirmOverlap. Backing
    // out leaves the config modal open and nothing queued. (An exact duplicate is a
    // different, unconfirmable 409 and falls through to the error toast below.)
    try {
      await api.addAutoBooking(autoBookBody);
    } catch (err) {
      if (err.code !== 'OVERLAP_CONFIRM_REQUIRED') throw err;
      const confirmed = await confirmOverlap({
        subject: {
          gymId: c.gymId || null,
          startAt: c.startAt,
          className: strippedClassName,
          groupName,
          instructorName: instructor.full_name || instructor.name || '',
          instructorImageUrl,
          studioName: studio.name,
          locationName: location.name,
        },
        warnings: err.warnings,
      });
      if (!confirmed) return;
      await api.addAutoBooking({ ...autoBookBody, confirmOverlap: true });
    }

    showToast(formatCopyText(COPY.timetable.autoBookScheduled, { className: strippedClassName }), 'success');
    callback();
    renderTimetableGrid();
  } catch (err) {
    showToast(formatCopyText(COPY.timetable.autoBookScheduleFailed, { error: err.message }), 'error');
  }
}

// ─── Debug Mode ──────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

export async function openDebugModal(event) {
  const modal = document.getElementById('sa-debug-modal');
  const body = document.getElementById('sa-debug-modal-body');
  const title = document.getElementById('sa-debug-modal-title');
  if (!modal || !body || !title) return;

  // Debug modal: deliberately the RAW provider name (it exists to show what the API sent).
  title.textContent = `Debug: ${event.name || 'Class'} — ${event.startAt || ''}`;
  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span>Loading debug data...</span>
    </div>
  `;

  openNavPage(modal, { id: 'debug-class', closeFooter: true });

  const closeBtn = document.getElementById('sa-debug-modal-close');
  const overlay = modal.querySelector('.sa-modal-overlay');

  const closeModal = () => {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
  };

  // Clean up previous listeners by cloning
  const newCloseBtn = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
  newCloseBtn.onclick = closeModal;
  overlay.onclick = closeModal;

  try {
    // Fetch full event data from proxy
    const res = await api.getEventDetails(event.id, event.gymId);
    const eventData = res.data || res;
    const relations = res.relations || eventData.relations || {};

    // Fetch slot availability for the Slots tab
    const studio = metadata.studios.find(s => sameId(s.id, event.studioId) && (!event.gymId || s.gymId === event.gymId));
    const layoutSlots = studio?.layout?.slots || [];
    // Note: /events/{id}/slots endpoint not available; use layout data from studio
    let availableSlots = [];

    // Find matching booking and waitlist for this event
    const matchingBooking = userBookings().find(b => matchesEvent(b, event)) || null;
    const matchingWaitlist = userWaitlists().find(w => matchesEvent(w, event)) || null;

    // Compute key values
    const classRelease = getClassReleaseTime(event, userSettings);
    const now = DateTime.now();
    const isLive = event.alwaysBookable ? true : (classRelease ? now >= classRelease : true);
    const bookingCutoff = event.booking_cutoff || 'N/A';
    const extendedCutoff = event.extended_cutoff || 'N/A';

    // Build tab navigation
    const tabs = [
      { id: 'event-data', label: 'Event Data' },
      { id: 'relations', label: 'Relations' },
    ];
    if (matchingBooking) tabs.push({ id: 'booking-data', label: 'Booking Data' });
    if (matchingWaitlist) tabs.push({ id: 'waitlist-data', label: 'Waitlist Data' });
    tabs.push({ id: 'slots', label: 'Slots' });

    let activeTab = tabs[0]?.id || 'event-data';

    function renderDebugTab(tabId) {
      activeTab = tabId;

      // Update tab buttons
      tabBar.querySelectorAll('.sa-debug-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
        const isActive = btn.dataset.tab === tabId;
        btn.style.background = isActive ? 'color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent)' : 'transparent';
        btn.style.borderColor = isActive ? 'color-mix(in srgb, var(--feat-autoupgrade) 40%, transparent)' : 'var(--border)';
        btn.style.color = isActive ? 'var(--feat-autoupgrade)' : 'var(--text-secondary)';
      });

      // Slots tab: show layout vs availability breakdown
      if (tabId === 'slots') {
        const totalLayout = layoutSlots.length;
        const totalAvail = availableSlots.length;
        const occupied = totalLayout - availableSlots.filter(id => layoutSlots.some(s => Number(s.id) === id)).length;
        const unmapped = availableSlots.filter(id => !layoutSlots.some(s => Number(s.id) === id));
        const rows = [...new Set(layoutSlots.map(s => s.y))].sort((a,b)=>a-b);

        let rowsHtml = rows.map((y, idx) => {
          const rowSlots = layoutSlots.filter(s => s.y === y);
          const rowAvail = rowSlots.filter(s => availableSlots.includes(Number(s.id)));
          return `<tr style="font-size:12px;"><td style="padding:3px 8px;color:var(--text-secondary);">Row ${idx+1}</td><td style="padding:3px 8px;color:var(--text);">${rowSlots.length} spots</td><td style="padding:3px 8px;color:var(--success);">${rowAvail.length} available</td><td style="padding:3px 8px;color:var(--danger);">${rowSlots.length - rowAvail.length} occupied</td></tr>`;
        }).join('');

        contentArea.innerHTML = `
          <div style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent);border-radius:10px;padding:14px;margin-bottom:12px;">
            <h5 style="color:var(--feat-autoupgrade);margin:0 0 10px 0;font-size:13px;font-weight:700;">Spot Availability</h5>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 0;font-size:12px;">
              <span style="color:var(--text-secondary);">Layout spots:</span><span style="color:var(--text);font-weight:600;">${totalLayout}</span><span></span>
              <span style="color:var(--text-secondary);">Available:</span><span style="color:var(--success);font-weight:600;">${totalAvail}</span><span></span>
              <span style="color:var(--text-secondary);">Occupied:</span><span style="color:var(--danger);font-weight:600;">${occupied}</span><span></span>
              <span style="color:var(--text-secondary);">Capacity:</span><span style="color:var(--text);font-weight:600;">${event.capacity ?? 'N/A'}</span><span></span>
              <span style="color:var(--text-secondary);">Occupancy:</span><span style="color:var(--text);font-weight:600;">${(event.capacity != null && event.availableCount != null ? event.capacity - event.availableCount : undefined) ?? 'N/A'}</span><span></span>
            </div>
          </div>
          ${unmapped.length > 0 ? `<div style="font-size:12px;color:var(--warning);background:color-mix(in srgb, var(--warning) 8%, transparent);border:1px solid color-mix(in srgb, var(--warning) 20%, transparent);border-radius:6px;padding:8px 12px;margin-bottom:12px;">⚠ ${unmapped.length} available slot${unmapped.length>1?'s are':' is'} not on the layout map — IDs: ${unmapped.join(', ')}</div>` : ''}
          ${rows.length > 0 ? `<table style="width:100%;border-collapse:collapse;"><thead><tr style="font-size:12px;color:var(--text-tertiary);"><th style="padding:3px 8px;text-align:left;">Row</th><th style="padding:3px 8px;text-align:left;">Total</th><th style="padding:3px 8px;text-align:left;">Available</th><th style="padding:3px 8px;text-align:left;">Occupied</th></tr></thead><tbody>${rowsHtml}</tbody></table>` : ''}
          <div style="margin-top:12px;"><h5 style="color:var(--feat-autoupgrade);margin:0 0 6px 0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Available Slot IDs</h5><pre style="background:var(--surface-inset);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px;color:var(--text);white-space:pre-wrap;word-break:break-all;margin:0;">${JSON.stringify(availableSlots)}</pre></div>
        `;
        return;
      }

      // Render content
      let jsonData = {};
      let tabLabel = '';

      if (tabId === 'event-data') {
        jsonData = eventData;
        tabLabel = 'Raw Event Data';
      } else if (tabId === 'relations') {
        jsonData = relations;
        tabLabel = 'Raw Relations Metadata';
      } else if (tabId === 'booking-data' && matchingBooking) {
        jsonData = matchingBooking;
        tabLabel = 'Raw Booking Data';
      } else if (tabId === 'waitlist-data' && matchingWaitlist) {
        jsonData = matchingWaitlist;
        tabLabel = 'Raw Waitlist Data';
      }

      // Build computed values section for event-data tab
      let computedHtml = '';
      if (tabId === 'event-data') {
        const studio = metadata.studios.find(s => sameId(s.id, event.studioId) && (!event.gymId || s.gymId === event.gymId));
        const loc = studio ? metadata.locations.find(l => sameId(l.id, studio.locationId) && (!event.gymId || l.gymId === event.gymId)) : null;
        const instructor = metadata.instructors.find(i => sameId(i.id, event.instructors?.[0]?.id) && (!event.gymId || i.gymId === event.gymId));
        const typeInfo = metadata.eventTypes.find(t => sameId(t.id, event.classTypeId) && (!event.gymId || t.gymId === event.gymId));

        computedHtml = `
          <div class="sa-debug-computed" style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent); border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent); border-radius:10px; padding:14px; margin-bottom:16px;">
            <h5 style="color:var(--feat-autoupgrade); margin:0 0 10px 0; font-size:13px; font-weight:700;">Key Computed Values</h5>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:12px;">
              <span style="color:var(--text-secondary);">isLive:</span><span style="color:var(--text); font-weight:600;">${isLive}</span>
              <span style="color:var(--text-secondary);">classReleaseTime:</span><span style="color:var(--text); font-weight:600;">${classRelease ? classRelease.toISO() : 'unknown'}</span>
              <span style="color:var(--text-secondary);">bookingCutoff:</span><span style="color:var(--text); font-weight:600;">${bookingCutoff}</span>
              <span style="color:var(--text-secondary);">extendedCutoff:</span><span style="color:var(--text); font-weight:600;">${extendedCutoff}</span>
              <span style="color:var(--text-secondary);">isFullyBooked:</span><span style="color:var(--text); font-weight:600;">${!!event.isFull}</span>
              <span style="color:var(--text-secondary);">isAlwaysBookable:</span><span style="color:var(--text); font-weight:600;">${!!event.alwaysBookable}</span>
              <span style="color:var(--text-secondary);">capacity:</span><span style="color:var(--text); font-weight:600;">${event.capacity ?? 'N/A'}</span>
              <span style="color:var(--text-secondary);">occupancy:</span><span style="color:var(--text); font-weight:600;">${(event.capacity != null && event.availableCount != null ? event.capacity - event.availableCount : undefined) ?? 'N/A'}</span>
              ${studio ? `<span style="color:var(--text-secondary);">Studio:</span><span style="color:var(--text); font-weight:600;">${studio.name} (ID: ${studio.id})</span>` : ''}
              ${loc ? `<span style="color:var(--text-secondary);">Location:</span><span style="color:var(--text); font-weight:600;">${loc.name} (ID: ${loc.id})</span>` : ''}
              ${instructor ? `<span style="color:var(--text-secondary);">Instructor:</span><span style="color:var(--text); font-weight:600;">${instructor.full_name || instructor.name} (ID: ${instructor.id})</span>` : ''}
              ${typeInfo ? `<span style="color:var(--text-secondary);">Event Type:</span><span style="color:var(--text); font-weight:600;">${typeInfo.name} (ID: ${typeInfo.id})</span>` : ''}
              <span style="color:var(--text-secondary);">Bookmark ID:</span><span style="color:var(--text); font-weight:600; word-break:break-all;">${generateBookmarkIdentifier(event) || 'N/A'}</span>
            </div>
          </div>
        `;
      }

      // Relations map on the relations tab
      let relationsMapHtml = '';
      if (tabId === 'relations') {
        relationsMapHtml = buildRelationsMapHtml(relations, event);
      }

      contentArea.innerHTML = `
        ${computedHtml}
        ${relationsMapHtml}
        <div class="sa-debug-json-block">
          <h5 style="color:var(--feat-autoupgrade); margin:0 0 8px 0; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">${tabLabel}</h5>
          <pre style="background:var(--surface-inset); border:1px solid var(--border); border-radius:8px; padding:14px; font-size:12px; line-height:1.5; color:var(--text); max-height:440px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin:0;">${escapeHtml(JSON.stringify(redactSensitivePayload(jsonData), null, 2))}</pre>
        </div>
      `;
    }

    // Helper: build human-readable relations map
    function buildRelationsMapHtml(rels, evt) {
      let html = '<div class="sa-debug-relations-map" style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent); border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent); border-radius:10px; padding:14px; margin-bottom:16px;">';
      html += '<h5 style="color:var(--feat-autoupgrade); margin:0 0 10px 0; font-size:13px; font-weight:700;">Relations Map</h5>';

      // Studios
      const studioList = rels.studios || [];
      html += '<div style="margin-bottom:8px;"><strong style="color:var(--text); font-size:12px;">Studios:</strong>';
      if (studioList.length === 0) {
        html += '<span style="color:var(--text-secondary); font-size:12px; margin-left:6px;">None</span>';
      } else {
        studioList.forEach(s => {
          html += `<div style="margin-left:12px; font-size:12px; color:var(--text-secondary);">• ${s.name || 'Unnamed'} (ID: ${s.id}, Location ID: ${s.locationId ?? s.locationId})</div>`;
        });
      }
      html += '</div>';

      // Locations
      const locList = rels.locations || [];
      html += '<div style="margin-bottom:8px;"><strong style="color:var(--text); font-size:12px;">Locations:</strong>';
      if (locList.length === 0) {
        html += '<span style="color:var(--text-secondary); font-size:12px; margin-left:6px;">None</span>';
      } else {
        locList.forEach(l => {
          html += `<div style="margin-left:12px; font-size:12px; color:var(--text-secondary);">• ${l.name || 'Unnamed'} (ID: ${l.id})</div>`;
        });
      }
      html += '</div>';

      // Instructors
      const instrList = rels.instructors || [];
      html += '<div style="margin-bottom:8px;"><strong style="color:var(--text); font-size:12px;">Instructors:</strong>';
      if (instrList.length === 0) {
        html += '<span style="color:var(--text-secondary); font-size:12px; margin-left:6px;">None</span>';
      } else {
        instrList.forEach(i => {
          html += `<div style="margin-left:12px; font-size:12px; color:var(--text-secondary);">• ${i.full_name || i.name || 'Unnamed'} (ID: ${i.id})</div>`;
        });
      }
      html += '</div>';

      // Event Types
      const etList = rels.event_types || [];
      html += '<div style="margin-bottom:4px;"><strong style="color:var(--text); font-size:12px;">Event Types:</strong>';
      if (etList.length === 0) {
        html += '<span style="color:var(--text-secondary); font-size:12px; margin-left:6px;">None</span>';
      } else {
        etList.forEach(et => {
          const groupName = et.group || '';
          html += `<div style="margin-left:12px; font-size:12px; color:var(--text-secondary);">• ${et.name || 'Unnamed'} (ID: ${et.id}${groupName ? `, Group: ${groupName}` : ''})</div>`;
        });
      }
      html += '</div>';

      html += '</div>';
      return html;
    }

    // C3-27: the gym's OWN class page, from its config; a gym with none gets no
    // button. This was hardcoded to psyclelondon.com for every gym.
    const classPageTemplate = (getLinkedGyms() || []).find((g) => (g.gym_id || g.id) === event.gymId)?.classPageUrl || '';
    const nativePageUrl = classPageTemplate ? classPageTemplate.replace('{id}', encodeURIComponent(event.id)) : '';

    // Build the modal UI
    body.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <!-- Quick-Book / Auto-Book / native page buttons -->
        <div id="sa-debug-action-bar" style="display:flex; gap:8px; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:4px; flex-wrap:wrap;">
          <button id="sa-debug-quick-book-btn" class="psycle-btn-mini variant-success-muted">Quick-Book</button>
          <button id="sa-debug-auto-book-btn" class="psycle-btn-mini variant-neutral">Auto-Book Config</button>
          ${nativePageUrl ? `<a href="${escapeHtml(nativePageUrl)}" target="_blank" rel="noopener noreferrer" class="psycle-btn-mini" style="display:inline-flex; align-items:center; gap:5px; background:color-mix(in srgb, var(--info) 14%, transparent); border-color:color-mix(in srgb, var(--info) 30%, transparent); color:var(--info); text-decoration:none;">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open native booking page
          </a>` : ''}
        </div>
        <!-- Tab bar -->
        <div class="sa-debug-tab-bar" style="display:flex; gap:4px; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:12px; flex-wrap:wrap;">
          ${tabs.map(t => `
            <button class="sa-debug-tab-btn" data-tab="${t.id}" style="background:${t.id === activeTab ? 'color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent)' : 'transparent'}; border:1px solid ${t.id === activeTab ? 'color-mix(in srgb, var(--feat-autoupgrade) 40%, transparent)' : 'var(--border)'}; color:${t.id === activeTab ? 'var(--feat-autoupgrade)' : 'var(--text-secondary)'}; padding:6px 14px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:600; transition:all 0.15s;">
              ${t.label}
            </button>
          `).join('')}
        </div>
        <!-- Content area -->
        <div id="sa-debug-content" style="min-height:200px;"></div>
      </div>
    `;

    body.querySelector('#sa-debug-quick-book-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeModal();
      setTimeout(() => openBookingModal(event, 'quickbook'), 320);
    });
    body.querySelector('#sa-debug-auto-book-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeModal();
      setTimeout(() => openBookingModal(event, 'autobook'), 320);
    });

    const tabBar = body.querySelector('.sa-debug-tab-bar');
    const contentArea = body.querySelector('#sa-debug-content');

    // Tab switching
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.sa-debug-tab-btn');
      if (btn) {
        renderDebugTab(btn.dataset.tab);
      }
    });

    // Render initial tab
    renderDebugTab(activeTab);

  } catch (err) {
    console.error('[Debug Modal] Failed to load event data:', err);
    body.innerHTML = `
      <div style="padding:20px; text-align:center;">
        <p style="color:var(--danger); margin-bottom:12px;">Error loading debug data: ${escapeHtml(err.message)}</p>
        <button class="psycle-btn-mini variant-autoupgrade" id="sa-debug-retry-btn">Retry</button>
      </div>
    `;
    const retryBtn = body.querySelector('#sa-debug-retry-btn');
    if (retryBtn) {
      retryBtn.onclick = () => openDebugModal(event);
    }
  }
}
