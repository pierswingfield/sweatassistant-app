import { api } from '../api';
import { getAvailableCreditsForEvent, hasUsableCredit, getIneligibleReason } from './credit-allowance.js';
import { canForGym, capabilityForGym, getGymContext, getLinkedGyms, getGymShortName } from '../gym-context.js';
import { showToast, currentUser, userSettings, refreshUserData, updateCreditBadge, cache, debugConsole } from '../main';
import { getClassReleaseTime, getNextMondayNoonLondon, isInGracePeriod, GRACE_PERIOD_MS, startGraceCountdown } from '../lib';
import { DateTime } from 'luxon';
// === MOBILE TIMETABLE — import renderMinimap (added Jun 2026; delete this block to revert) ===
import { renderMinimap } from './tooltips.js';
// === END MOBILE TIMETABLE BLOCK ===
import { openDB, accountScopedKey } from '../cache.js';
import { disciplineTag, seatNoun, sparklesIcon, trendingUpIcon, icon, pulseIcon, trimLocation, displayStudioName, equalizeDiscTagWidths , gymChip , cleanClassName, getDiscipline } from './cards';
import { openEditBookingModal } from './bookings';
import { openStudioFloorPlanEditor } from './settings';
import { renderTimetableSkeleton } from './loading-skeleton.js';

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
const studioLayoutCache = new Map();
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
  window.dispatchEvent(new CustomEvent('psycle-timetable-performance', { detail: sample }));
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
// Live shared studio preference maps, refreshed each grid render so the action
// model can synchronously decide Quick-Book vs Book per studio.
let studioPrefsMap = {};
let psycleEvents = [];
let userBookings = [];
let userWaitlists = [];
let isPrefetching = false;
let prefetchError = null;

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

// Initializer
export async function initTimetable() {
  const initStartedAt = timetablePerfNow();
  loadStoredFilters();
  setupDropdownFilters();
  await prefetchTimetableData();
  recordTimetableTiming('initialise-total', initStartedAt);
  // Pull-to-refresh is handled centrally in main.js (attached to the shared
  // <main class="psycle-body"> scroller, dispatched by active tab).
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
const FILTERS_KEY_BASE = 'psycleUnifiedDefaultFilters';

function defaultFiltersKey() {
  return accountScopedKey(FILTERS_KEY_BASE);
}

// Load default filter selections from localStorage
function loadStoredFilters() {
  try {
    const stored = localStorage.getItem(defaultFiltersKey());
    if (stored) {
      const parsed = JSON.parse(stored);
      selectedGyms = parsed.gyms || [];
      selectedLocations = parsed.locations || [];
      selectedInstructors = parsed.instructors || [];
      selectedEventTypes = parsed.eventTypes || [];
      showBookmarksOnly = parsed.showBookmarksOnly || false;
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
    showToast('Failed to load filters metadata.', 'error');
  }
}

// Fetch all events for the prefetch window in parallel across all linked gyms
// Uses instant SWR: renders cached events in 0ms on startup, refreshes in background
const CACHE_KEY_EVENTS = 'psycleUnifiedCacheEvents';
const CACHE_KEY_META = 'psycleUnifiedCacheMeta';
const CACHE_KEY_TIME = 'psycleUnifiedCacheTime';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function prefetchTimetableData(force = false) {
  if (isPrefetching) return;
  
  const ttContainer = document.getElementById('psycle-timetable-grid');
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
      psycleEvents = cachedEvents;
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

  // 2. If cold start without any cached data, show spinner while initial fetch completes
  if (!hasCached) {
    ttContainer.innerHTML = renderTimetableSkeleton();
  }

  isPrefetching = true;
  prefetchError = null;

  try {
    // Fetch user bookings and waitlists to keep action buttons in sync
    const refreshStartedAt = timetablePerfNow();
    const metadataStartedAt = timetablePerfNow();
    const [, bookingsRes, waitlistsRes, autoBookingsRes, studioPrefsRes] = await Promise.all([
      loadMetadata(true).finally(() => recordTimetableTiming('metadata-refresh', metadataStartedAt)),
      api.getBookings(),
      api.getWaitlists(),
      api.getAutoBookings().catch(() => cache.autoBookings || []),
      api.getStudioPreferences().catch(() => cache.studioPrefs || {}),
    ]);
    userBookings = bookingsRes || [];
    userWaitlists = waitlistsRes || [];
    cache.bookings = userBookings;
    cache.waitlists = userWaitlists;
    cache.autoBookings = autoBookingsRes || [];
    cache.studioPrefs = studioPrefsRes || {};

    // Fetch fresh events across all linked gyms
    const prefetchWeeks = userSettings.prefetchWeeks || 4;
    const startDate = new Date();
    const startStr = startDate.toISOString().split('T')[0];
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + (prefetchWeeks * 7));
    const endStr = endDate.toISOString().split('T')[0];

    // `force` here is the user pressing refresh (or pull-to-refresh), which is
    // the one case that should reach past the SHARED server cache to the
    // provider. Ordinary renders ride the cache — that is what makes the second
    // load fast.
    const freshEvents = await api.getTimetable({ startDate: startStr, endDate: endStr, refresh: force });
    recordTimetableTiming('network-refresh', refreshStartedAt, {
      eventCount: freshEvents?.length || 0,
    });
    if (freshEvents && freshEvents.length > 0) {
      psycleEvents = freshEvents;
      mergeMetadataFromEvents(freshEvents);
      buildMetaMaps();
      try {
        await cacheSet(accountScopedKey(CACHE_KEY_EVENTS), psycleEvents);
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
    isPrefetching = false;
    renderTimetableGrid('network-refresh');
  } catch (err) {
    isPrefetching = false;
    prefetchError = err.message;
    console.error('[Timetable] Prefetch failed:', err);
    if (!hasCached) {
      ttContainer.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: var(--text-secondary);">
          <p style="font-size:16px;margin-bottom:8px">No cached timetable available</p>
          <p style="font-size:13px;color:var(--text-tertiary)">Connect to the internet to load the timetable.</p>
          <button id="psycle-timetable-retry-btn" class="psycle-btn variant-danger" style="margin-top: 12px; display: inline-block; width: auto; padding: 8px 16px; border-radius: 8px;">Retry</button>
        </div>
      `;
      const retryBtn = document.getElementById('psycle-timetable-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = () => prefetchTimetableData(true);
      }
    }
  }
}

// Generate the dropdown filter option checklists
// activeIds: { locationIds, instructorIds, classTypeIds } — each a Set of IDs from interdependently-filtered events
function setupDropdownFilters({ locationIds, instructorIds, classTypeIds } = {}) {
  const container = document.getElementById('psycle-timetable-filters-container');
  if (!container) return;

  // Gym filter (rendered only when >1 gym linked)
  const linked = getLinkedGyms() || [];
  const gymDropdown = document.getElementById('psycle-ms-gym');
  if (gymDropdown) {
    if (linked.length > 1) {
      gymDropdown.style.display = 'block';
      const gymItems = linked.map(g => ({
        id: g.gym_id || g.id,
        name: g.gym_name || g.name || g.gym_id || g.id,
      }));
      populateOptionsList('psycle-ms-gym', gymItems, selectedGyms, 'gym');
      updateTriggerLabel('psycle-ms-gym', selectedGyms, 'All Gyms', 'Gym');
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
  const instructorsToRender = [...instructorPool].sort((a, b) => {
    const nameA = (a.full_name || a.name || '').toLowerCase();
    const nameB = (b.full_name || b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const eventTypesToRender = (!classTypeIds || classTypeIds.size === 0)
    ? metadata.eventTypes
    : metadata.eventTypes.filter(t => hasId(classTypeIds, t.id));

  populateOptionsList('psycle-ms-location', locationsToRender, selectedLocations, 'location');
  // Normalized instructors expose `name`; the old raw CodexFit shape used
  // `full_name`, and the default labelField is already 'name'.
  populateOptionsList('psycle-ms-instructor', instructorsToRender, selectedInstructors, 'instructor');

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
    .map(t => ({ ...t, bucketLabel: getDiscipline(t.group).label }))
    .filter(t => {
      const key = `${t.gymId || ''}:${t.bucketLabel}`;
      if (seenGroupKeys.has(key)) return false;
      seenGroupKeys.add(key);
      return true;
    })
    .map(t => ({ id: t.bucketLabel, name: t.bucketLabel, gymId: t.gymId }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.gymId || '').localeCompare(b.gymId || ''));

  populateOptionsList('psycle-ms-class-type', eventTypeGroups, selectedEventTypes, 'class-type');
  
  // Set labels
  updateTriggerLabel('psycle-ms-location', selectedLocations, 'All Locations', 'Location');
  updateTriggerLabel('psycle-ms-instructor', selectedInstructors, 'All Instructors', 'Instructor');
  updateTriggerLabel('psycle-ms-class-type', selectedEventTypes, 'All Types', 'Type');

  // Bookmarked button class
  const bookmarksFilterBtn = document.getElementById('psycle-filter-favorites-only');
  if (bookmarksFilterBtn) {
    if (showBookmarksOnly) {
      bookmarksFilterBtn.classList.add('active');
      bookmarksFilterBtn.textContent = '♥ Bookmarked';
    } else {
      bookmarksFilterBtn.classList.remove('active');
      bookmarksFilterBtn.textContent = '♡ Bookmarked';
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
  const menu = dropdown.querySelector('.psycle-ms-menu');
  const list = dropdown.querySelector('.psycle-ms-options-list');
  if (!list) return;

  // Instructor dropdown: inject instant-search input once, then wire it
  if (dropdownId === 'psycle-ms-instructor' && menu) {
    let searchInput = menu.querySelector('.psycle-ms-search');
    if (!searchInput) {
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'psycle-ms-search';
      searchInput.placeholder = 'Search instructors…';
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
        if (child.classList.contains('psycle-ms-group-heading')) {
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

  const isLocation = dropdownId === 'psycle-ms-location';
  const isInstructor = dropdownId === 'psycle-ms-instructor';
  const isClassType = dropdownId === 'psycle-ms-class-type';
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
      heading.className = 'psycle-ms-group-heading';
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
  label.className = 'psycle-ms-option-label';
  label.innerHTML = `
    <input type="checkbox" class="psycle-ms-checkbox" data-type="${type}" data-id="${item.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
    <span>${labelText}</span>
  `;
  return label;
}

// Update the select button trigger text description
function updateTriggerLabel(dropdownId, selectedArray, defaultText, labelSingular) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  const labelTextEl = dropdown.querySelector('.psycle-ms-trigger-text');
  if (!labelTextEl) return;

  if (selectedArray.length === 0) {
    labelTextEl.textContent = defaultText;
  } else if (selectedArray.length === 1) {
    // Resolve single item name
    let name = '1 Selected';
    if (dropdownId === 'psycle-ms-gym') {
      const g = (getLinkedGyms() || []).find(x => String(x.gym_id || x.id) === selectedArray[0]);
      if (g) name = g.gym_name || g.name || g.gym_id || g.id;
    } else if (dropdownId === 'psycle-ms-location') {
      const loc = metadata.locations.find(l => String(l.id) === selectedArray[0]);
      if (loc) name = disambiguateGymLabel(loc, locationBaseLabel(loc), metadata.locations, locationBaseLabel);
    } else if (dropdownId === 'psycle-ms-instructor') {
      const instr = metadata.instructors.find(i => String(i.id) === selectedArray[0]);
      if (instr) name = disambiguateGymLabel(instr, instructorBaseLabel(instr), metadata.instructors, instructorBaseLabel);
    } else if (dropdownId === 'psycle-ms-class-type') {
      // The selection id IS the bucket label (see setupDropdownFilters) — no
      // lookup needed, unlike the other dropdowns where the id is a provider id.
      name = selectedArray[0];
    }
    labelTextEl.textContent = name;
  } else {
    labelTextEl.textContent = `${selectedArray.length} ${labelSingular}s`;
  }
}

// Setup multiselect dropdown toggle event bindings
function setupFilterEventListeners() {
  const container = document.getElementById('psycle-timetable-filters-container');
  if (!container) return;

  // 1. Toggle open dropdowns on trigger clicks
  container.querySelectorAll('.psycle-ms-trigger').forEach(trigger => {
    trigger.onclick = (e) => {
      e.stopPropagation();
      const dropdown = trigger.parentElement;
      const menu = dropdown.querySelector('.psycle-ms-menu');
      const arrow = trigger.querySelector('.psycle-ms-arrow');
      const isVisible = menu.style.display === 'block';

      // Close all first
      container.querySelectorAll('.psycle-ms-menu').forEach(m => m.style.display = 'none');
      container.querySelectorAll('.psycle-ms-arrow').forEach(a => a.style.transform = 'rotate(0deg)');

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
  container.querySelectorAll('.psycle-ms-dropdown').forEach(dropdown => {
    dropdown.onclick = (e) => e.stopPropagation();
  });

  // Document listener to close dropdowns when clicking outside
  document.onclick = () => {
    container.querySelectorAll('.psycle-ms-menu').forEach(m => m.style.display = 'none');
    container.querySelectorAll('.psycle-ms-arrow').forEach(a => a.style.transform = 'rotate(0deg)');
    openDropdownId = null;
  };

  // 2. Options checkbox change listeners
  container.querySelectorAll('.psycle-ms-checkbox').forEach(checkbox => {
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
        updateTriggerLabel('psycle-ms-gym', selectedGyms, 'All Gyms', 'Gym');
      } else if (type === 'location') {
        if (isChecked) {
          if (!selectedLocations.includes(id)) selectedLocations.push(id);
        } else {
          selectedLocations = selectedLocations.filter(x => x !== id);
        }
        updateTriggerLabel('psycle-ms-location', selectedLocations, 'All Locations', 'Location');
      } else if (type === 'instructor') {
        if (isChecked) {
          if (!selectedInstructors.includes(id)) selectedInstructors.push(id);
        } else {
          selectedInstructors = selectedInstructors.filter(x => x !== id);
        }
        updateTriggerLabel('psycle-ms-instructor', selectedInstructors, 'All Instructors', 'Instructor');
      } else if (type === 'class-type') {
        if (isChecked) {
          if (!selectedEventTypes.includes(id)) selectedEventTypes.push(id);
        } else {
          selectedEventTypes = selectedEventTypes.filter(x => x !== id);
        }
        updateTriggerLabel('psycle-ms-class-type', selectedEventTypes, 'All Types', 'Type');
      }

      renderTimetableGrid();
    };
  });

  // 3. Clear button inside individual menus
  container.querySelectorAll('.psycle-ms-dropdown').forEach(dropdown => {
    const clearBtn = dropdown.querySelector('.psycle-ms-clear-btn');
    if (clearBtn) {
      clearBtn.onclick = (e) => {
        e.stopPropagation();
        const idAttr = dropdown.id;
        dropdown.querySelectorAll('.psycle-ms-checkbox').forEach(c => c.checked = false);

        if (idAttr === 'psycle-ms-gym') {
          selectedGyms = [];
          updateTriggerLabel('psycle-ms-gym', selectedGyms, 'All Gyms', 'Gym');
        } else if (idAttr === 'psycle-ms-location') {
          selectedLocations = [];
          updateTriggerLabel('psycle-ms-location', selectedLocations, 'All Locations', 'Location');
        } else if (idAttr === 'psycle-ms-instructor') {
          selectedInstructors = [];
          updateTriggerLabel('psycle-ms-instructor', selectedInstructors, 'All Instructors', 'Instructor');
        } else if (idAttr === 'psycle-ms-class-type') {
          selectedEventTypes = [];
          updateTriggerLabel('psycle-ms-class-type', selectedEventTypes, 'All Types', 'Type');
        }
        renderTimetableGrid();
      };
    }
  });

  // 4. Global Bookmarked toggle click handler
  const bookmarksFilterBtn = document.getElementById('psycle-filter-favorites-only');
  if (bookmarksFilterBtn) {
    bookmarksFilterBtn.onclick = () => {
      showBookmarksOnly = !showBookmarksOnly;
      if (showBookmarksOnly) {
        bookmarksFilterBtn.classList.add('active');
        bookmarksFilterBtn.textContent = '♥ Bookmarked';
      } else {
        bookmarksFilterBtn.classList.remove('active');
        bookmarksFilterBtn.textContent = '♡ Bookmarked';
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
      
      container.querySelectorAll('.psycle-ms-checkbox').forEach(c => c.checked = false);
      
      updateTriggerLabel('psycle-ms-gym', selectedGyms, 'All Gyms', 'Gym');
      updateTriggerLabel('psycle-ms-location', selectedLocations, 'All Locations', 'Location');
      updateTriggerLabel('psycle-ms-instructor', selectedInstructors, 'All Instructors', 'Instructor');
      updateTriggerLabel('psycle-ms-class-type', selectedEventTypes, 'All Types', 'Type');
      
      if (bookmarksFilterBtn) {
        bookmarksFilterBtn.classList.remove('active');
        bookmarksFilterBtn.textContent = '♡ Bookmarked';
      }

      renderTimetableGrid();
      showToast('All filters cleared.', 'success');
    };
  }

  // 6. Global Save Defaults click handler
  const saveDefaultFiltersBtn = document.getElementById('psycle-btn-save-default-filters');
  let isSavingDefaults = false;
  if (saveDefaultFiltersBtn) {
    saveDefaultFiltersBtn.onclick = () => {
      if (isSavingDefaults) return;
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
      saveDefaultFiltersBtn.innerHTML = `Saving...`;

      try {
        localStorage.setItem(defaultFiltersKey(), JSON.stringify(defaultFilters));
        setTimeout(() => {
          saveDefaultFiltersBtn.innerHTML = `✓ Saved!`;
          saveDefaultFiltersBtn.style.background = 'var(--success)';
          saveDefaultFiltersBtn.style.color = 'var(--on-accent)';
          showToast('Current filters saved as defaults on this device!', 'success');
          
          setTimeout(() => {
            saveDefaultFiltersBtn.innerHTML = originalText;
            saveDefaultFiltersBtn.style.background = '';
            saveDefaultFiltersBtn.style.color = '';
            saveDefaultFiltersBtn.style.cursor = 'pointer';
            isSavingDefaults = false;
          }, 1200);
        }, 300);
      } catch (e) {
        showToast('Failed to save filters.', 'error');
        saveDefaultFiltersBtn.innerHTML = originalText;
        saveDefaultFiltersBtn.style.cursor = 'pointer';
        isSavingDefaults = false;
      }
    };
  }
}

// Core timetable grid and date selector rendering
export async function renderTimetableGrid(reason = 'interaction') {
  const renderStartedAt = timetablePerfNow();
  const ttGrid = document.getElementById('psycle-timetable-grid');
  if (!ttGrid) return;

  // Compute interdependent dropdown options: each filter shows only values present in events
  // that match ALL OTHER active filters (but not the filter for that dropdown itself).
  const now = new Date();
  const futureEvents = psycleEvents.filter(e => new Date(e.startAt) >= now);

  function eventsExcluding(excludeFilter) {
    return futureEvents.filter(e => {
      if (excludeFilter !== 'gym' && selectedGyms.length > 0) {
        if (!e.gymId || !selectedGyms.includes(String(e.gymId))) return false;
      }
      if (excludeFilter !== 'location' && selectedLocations.length > 0) {
        const studioObj = e.studio || gymScopedGet(studioObjMap, e.studioId, e.gymId);
        const locId = String(studioObj?.locationId || e.locationId || '');
        if (!locId || !selectedLocations.includes(locId)) return false;
      }
      if (excludeFilter !== 'instructor' && selectedInstructors.length > 0 && !selectedInstructors.includes(String(e.instructors?.[0]?.id))) return false;
      if (excludeFilter !== 'class-type' && selectedEventTypes.length > 0) {
        const et = metadata.eventTypes.find(t => sameId(t.id, e.classTypeId) && (!e.gymId || t.gymId === e.gymId));
        // Bucketed the same way the filter list itself is built (see
        // setupDropdownFilters) — a selected "Boxing" must match any event
        // whose specific class type buckets to Boxing, not just one literal
        // string.
        const etGroupId = et?.group != null ? getDiscipline(String(et.group)).label : null;
        if (!etGroupId || !selectedEventTypes.includes(etGroupId)) return false;
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
  const filteredEvents = psycleEvents.filter(e => {
    // Filter out past classes
    if (new Date(e.startAt) < new Date()) return false;

    // Filter by Gym
    if (selectedGyms.length > 0) {
      if (!e.gymId || !selectedGyms.includes(String(e.gymId))) return false;
    }
    // Filter by Location
    if (selectedLocations.length > 0) {
      const studioObj = e.studio || gymScopedGet(studioObjMap, e.studioId, e.gymId);
      const locId = String(studioObj?.locationId || e.locationId || '');
      if (!locId || !selectedLocations.includes(locId)) return false;
    }
    // Filter by Instructor
    if (selectedInstructors.length > 0 && !selectedInstructors.includes(String(e.instructors?.[0]?.id))) return false;
    // Filter by Class Type Group ID
    if (selectedEventTypes.length > 0) {
      // `discipline` IS the normalized group. Fall back to the metadata lookup
      // for events whose discipline the provider didn't populate. Bucketed
      // the same way the filter list is built (setupDropdownFilters) — a
      // selected "Boxing" must match any event whose specific class type
      // buckets to Boxing, not just one literal string.
      const et = metadata.eventTypes.find(t => sameId(t.id, e.classTypeId) && (!e.gymId || t.gymId === e.gymId));
      const rawGroup = e.discipline ?? (et?.group != null ? String(et.group) : null);
      const etGroupId = rawGroup != null ? getDiscipline(String(rawGroup)).label : null;
      if (!etGroupId || !selectedEventTypes.includes(etGroupId)) return false;
    }
    // Filter by Bookmarked Only
    if (showBookmarksOnly) {
      const identifier = generateBookmarkIdentifier(e);
      if (!canForGym('bookmarks', e.gymId)) return true; // no bookmarks concept → filter is a no-op
      const bookmarks = cache.profile?.metafields?.public?.bookmarks?.events || [];
      if (!bookmarks.includes(identifier)) return false;
    }
    return true;
  });

  // 2. Sort remaining filtered events chronologically
  const sortedEvents = [...filteredEvents].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  // 3. Extract unique dates containing matching events
  const daysWithEvents = Array.from(new Set(sortedEvents.map(e => e.startAt.split('T')[0]))).sort();

  // 4. Validate/Update selected date state
  if (daysWithEvents.length > 0) {
    if (!selectedTimetableDate || !daysWithEvents.includes(selectedTimetableDate)) {
      const todayStr = new Date().toISOString().split('T')[0];
      selectedTimetableDate = daysWithEvents.includes(todayStr) ? todayStr : daysWithEvents[0];
    }
  } else {
    selectedTimetableDate = null;
  }

  // 5. Render Horizontal Date Carousel
  const carousel = document.getElementById('psycle-timetable-carousel');
  if (carousel) {
    carousel.innerHTML = '';
    
    if (daysWithEvents.length === 0) {
      carousel.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; font-style: italic; padding: 8px;">No dates match filter criteria.</div>';
    } else {
      daysWithEvents.forEach(dayStr => {
        const d = new Date(dayStr);
        const isSelected = dayStr === selectedTimetableDate;
        const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' });
        const dayNum = d.getDate();
        const monthName = d.toLocaleDateString('en-GB', { month: 'short' });

        const pill = document.createElement('div');
        pill.className = `psycle-day-pill ${isSelected ? 'active' : ''}`;
        pill.innerHTML = `
          <span class="day-name">${dayName}</span>
          <div style="display: flex; align-items: baseline; gap: 4px; line-height: 1;">
            <span class="day-num">${dayNum}</span>
            <span class="day-month">${monthName}</span>
          </div>
        `;
        pill.onclick = () => {
          selectedTimetableDate = dayStr;
          carousel.querySelectorAll('.psycle-day-pill').forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          renderTimetableGrid();
        };
        carousel.appendChild(pill);
      });
    }
  }

  // Remove any body-appended mobile menus from the previous render, then inject
  // the mobile filter ellipsis + its menu. Both run BEFORE the table render (and
  // before the no-results early return) so the filter menu survives the purge
  // and is available even when no classes match the current filters.
  document.querySelectorAll('body > .psycle-mobile-menu').forEach(m => m.remove());
  if (window.matchMedia('(max-width: 768px)').matches) {
    injectMobileFilterHamburger();
  } else {
    // Found 2026-09-02: the trigger was only ever REMOVED at the top of
    // injectMobileFilterHamburger(), which only runs on this branch — so a
    // resize from mobile to desktop left the mobile ellipsis stranded in the
    // desktop filter row: present, unstyled for the wider layout, and its
    // click handler pointing at a menu of mobile-only filter controls that
    // no longer make sense next to the real dropdowns now visible.
    document.getElementById('psycle-mobile-filter-trigger')?.remove();
  }

  // 6. Render the Class Timetable Grid Table
  if (!selectedTimetableDate) {
    ttGrid.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); padding: 40px; font-style: italic;">
        No classes match the current filters. Clear filters to see more.
      </div>
    `;
    return;
  }

  const finalEvents = sortedEvents.filter(e => e.startAt.startsWith(selectedTimetableDate));

  // The outer #psycle-timetable-grid (.psycle-timetable-list) is the single scroll
  // container — see initTimetableTab for the pull-to-refresh wiring. The inner
  // container must NOT scroll, otherwise iOS has two nested scrollers and the
  // outer grid's scrollTop stays 0 (breaking the at-top check for pull-to-refresh).
  ttGrid.innerHTML = `
    <div class="psycle-table-container">
      <table class="psycle-table" style="width: 100%; border-collapse: collapse; text-align: left; table-layout: fixed;">
        <thead>
          <tr>
            <th style="width: 7%;">Time</th>
            <th style="width: 8%;">Gym</th>
            <th style="width: 27%;">Class</th>
            <th style="width: 12%;">Instructor</th>
            <th style="width: 15%;">Location / Studio</th>
            <th style="width: 11%;">Status</th>
            <th style="width: 20%; text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody id="psycle-timetable-rows"></tbody>
      </table>
    </div>
  `;

  const tbody = ttGrid.querySelector('#psycle-timetable-rows');

  finalEvents.forEach(event => {
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
    const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

    // Cutoff status calculation (London timezone)
    const classRelease = getClassReleaseTime(event, userSettings);
    const now = DateTime.now().setZone('Europe/London');
    const isLive = event.alwaysBookable ? true : (now >= classRelease);
    const isFullyBooked = !!event.isFull;
    const canWaitlist = event.waitlistAvailable !== false;

    const isBooked = userBookings.some(b => matchesEvent(b, event));
    const isOnWaitlist = userWaitlists.some(w => matchesEvent(w, event));

    const availableSpots = (typeof event.capacity === 'number' && typeof (event.capacity != null && event.availableCount != null ? event.capacity - event.availableCount : undefined) === 'number')
      ? Math.max(0, event.capacity - (event.capacity != null && event.availableCount != null ? event.capacity - event.availableCount : undefined))
      : null;
    const spotsText = availableSpots !== null ? `${availableSpots} / ${event.capacity}` : 'Open';

    const identifier = generateBookmarkIdentifier(event);
    // Bookmarks live in CodexFit profile metafields. A gym without the
    // capability has none — don't reach into a provider-shaped blob for them.
    const bookmarks = canForGym('bookmarks', event.gymId) ? (cache.profile?.metafields?.public?.bookmarks?.events || []) : [];
    const isBookmarked = bookmarks.includes(identifier);
    const heartChar = isBookmarked ? '♥' : '♡';
    const heartClass = isBookmarked ? 'psycle-timetable-heart bookmarked' : 'psycle-timetable-heart unbookmarked';

    // ── Status badge (kept as a restyled column) + shared action model ──
    let statusBadge = '';
    let rowClass = 'psycle-table-row';
    let bookingId = null, isPenalty = false, slotsBookedCount = 0, waitlistId = null, graceDeadline = null;
    const hasCredit = hasUsableCredit(event);

    const isScheduled = autoBookedIds.has(event.id) || autoBookedIds.has(Number(event.id)) || autoBookedIds.has(String(event.id));

    if (!isLive) {
      if (isScheduled) {
        rowClass = 'psycle-table-row row-beyond-cutoff row-scheduled';
        statusBadge = `<span class="badge-pill scheduled psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}">${pulseIcon(12)}AUTO-BOOK</span>`;
      } else {
        rowClass = 'psycle-table-row row-beyond-cutoff';
        statusBadge = `<span class="badge-pill not-live psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}">Not Live</span>`;
      }
    } else if (isBooked) {
      const eventBookings = userBookings.filter(b => matchesEvent(b, event));
      slotsBookedCount = eventBookings.length;
      statusBadge = `<span class="badge-pill yes psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">Booked${slotsBookedCount > 1 ? ` (${slotsBookedCount})` : ''}</span>`;
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
      statusBadge = `<span class="badge-pill waitlisted psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">Waitlisted</span>`;
      const waitlistEntry = userWaitlists.find(w => matchesEvent(w, event));
      if (waitlistEntry) waitlistId = waitlistEntry.id;
    } else if (isFullyBooked) {
      statusBadge = canWaitlist
        ? `<span class="badge-pill waitlist-open psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">Waitlist</span>`
        : `<span class="badge-pill no fully-booked psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}">Full</span>`;
    } else if (!hasCredit) {
      // Short label in the pill, full reason in the tooltip — the column is
      // narrow and "NO CREDITS AVAILABLE" spends all of it restating "no".
      // NO badge here beyond the occupancy. The row's primary action already
      // says "Buy Credits", so a "No credits" pill beside it is the same fact
      // twice — and it was spending the narrowest column in the table to do it.
      // The reason still reaches the user: it's the button's tooltip.
      statusBadge = `<span class="badge-pill yes psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;" title="${escapeHtml(getIneligibleReason(event.gymId) || 'No credits')}">${spotsText}</span>`;
    } else {
      statusBadge = `<span class="badge-pill yes psycle-occupancy-hover" data-id="${event.id}" data-gym-id="${event.gymId || ''}" style="cursor: pointer;">${spotsText}</span>`;
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
    row.setAttribute('data-gym', event.gymId || 'psycle-london');
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
        <div class="psycle-tt-class-cell">
          ${canForGym('bookmarks', event.gymId) ? `<span class="${heartClass}" data-event-id="${event.id}" title="${isBookmarked ? 'Remove Bookmark' : 'Bookmark Class'}">${heartChar}</span>` : ''}
          ${disciplineTag(groupName)}
          <span class="psycle-tt-class-name">${strippedClassName}</span>
        </div>
      </td>
      <td class="col-instructor">${instrName ? `<span class="psycle-instructor-hover" data-id="${event.instructors?.[0]?.id}" data-gym-id="${event.gymId || ''}">${instrName}</span>` : ''}</td>
      ${/* MID-WIDTH COLUMN: instructor + top-level location only ("SW1",
           "Oxford Circus"), with the specific studio dropped — at that width
           the studio is the least useful thing on the row and the most
           expensive, since it forces a second line.
           Always rendered; CSS shows exactly one of {instructor+location} or
           {this} at any width, so a resize needs no re-render. */ ''}
      <td class="col-who-where">
        ${instrName ? `<span class="psycle-ww-who psycle-instructor-hover" data-id="${event.instructors?.[0]?.id}" data-gym-id="${event.gymId || ''}">${instrName}</span>` : ''}
        ${locName ? `<span class="psycle-ww-loc">${trimLocation(locName, getGymShortName(event.gymId))}</span>` : ''}
      </td>
      <td class="col-location">
        <span style="font-weight:600; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${trimLocation(locName, getGymShortName(event.gymId))}</span>
        ${studioName ? `<span style="font-size:12px; color:var(--text-secondary); display:block; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${displayStudioName(studioName)}</span>` : ''}
      </td>
      <td class="col-status">${statusBadge}</td>
      <td class="col-actions"></td>
    `;

    row.querySelector('.col-actions').appendChild(buildDesktopActions(actionModel, event, userSettings.debugMode, isBookmarked));

    // Heart click listener — the element only exists when the gym HAS bookmarks
    // (the markup above is capability-gated), so this must be optional. An
    // unconditional querySelector here threw on every row for a gym without
    // them, which emptied the whole timetable.
    const heartEl = row.querySelector('.psycle-timetable-heart');
    if (heartEl) {
      heartEl.onclick = (e) => {
        e.stopPropagation();
        toggleNativeBookmark(event, e.target);
      };
    }

    tbody.appendChild(row);
  });

  equalizeDiscTagWidths(ttGrid);
  recordTimetableTiming('render-dom', domStartedAt, {
    reason,
    eventCount: sortedEvents.length,
  });
  recordTimetableTiming('render-total', renderStartedAt, {
    reason,
    eventCount: sortedEvents.length,
  });
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
  const prefs = (studioPrefsMap && (
    (event.gymId && studioPrefsMap[`${event.gymId}:${event.studioId}`]) || studioPrefsMap[event.studioId]
  )) || {};
  const hasPrefs = (prefs.preferredSlots?.length > 0) || (prefs.preferredRows?.length > 0);
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
        label: isScheduled ? 'Scheduled' : 'Auto-Book',
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
      ? { label: 'Edit', variant: 'autoupgrade', run: () => doEditBooking(event) }
      : { label: 'Booked', variant: 'neutral', disabled: true };
    if (slotsBookedCount === 1 && bookingId) {
      const cancelLabel = graceDeadline
        ? `Cancel (${Math.ceil((graceDeadline - Date.now()) / 1000)}s)`
        : 'Cancel';
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
    // Multiple spots booked → manage in My Bookings
    return {
      primary, config: null,
      secondary: { label: 'Manage', variant: 'autoupgrade', run: () => window.switchTab('my-bookings') },
    };
  }

  // On the waitlist → Leave (confirmed)
  if (isOnWaitlist) {
    if (waitlistId) {
      return {
        primary: {
          label: 'Leave WL', variant: 'danger', isCancel: true,
          run: (btn) => twoTapConfirm(btn, 'Confirm leave?', () => doLeaveWaitlist(waitlistId, btn, event.gymId)),
        },
        secondary: null, config: null,
      };
    }
    return { primary: { label: 'On Waitlist', variant: 'neutral', disabled: true }, secondary: null, config: null };
  }

  // Full → join waitlist if possible
  if (isFullyBooked) {
    if (canWaitlist) {
      return {
        primary: { label: 'Join Waitlist', variant: 'warning-solid', run: (btn) => doJoinWaitlist(event, btn) },
        secondary: null, config: null,
      };
    }
    return { primary: { label: 'Full', variant: 'neutral', disabled: true }, secondary: null, config: null };
  }

  // No eligible credits → send to Buy Credits
  if (!hasCredit) {
    return {
      primary: { label: 'Buy Credits', variant: 'danger', run: () => window.switchTab('buy-credits') },
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
    primary: { label: 'Quick Book', variant: 'success', run: (btn) => doQuickBook(event, btn) },
    // No ⚙ on the row: "Configure Quick-Book" is in the overflow menu, and two
    // affordances for one action spend 40px of every row to save one click on
    // a rare one. `config` is still set so the menu knows to offer it.
    config: hasMap ? 'quickbook' : null,
    showConfigButton: false,
    secondary: null,
    alternate: hasMap ? { label: 'Book (choose a spot)', run: () => openBookingModal(event, 'book') } : null,
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
  if (!allPrefs || studioId == null) return {};
  const prefKey = gymId ? `${gymId}:${studioId}` : studioId;
  return allPrefs[prefKey] || allPrefs[studioId] || {};
}

async function resolveStudioPrefs(event) {
  const studioId = event.studioId;
  const prefKey = event.gymId ? `${event.gymId}:${studioId}` : studioId;
  let all = cache.studioPreferences;
  if (!all || !(prefKey in all || studioId in all)) {
    all = await api.getStudioPreferences();
    cache.studioPreferences = all;
  }
  const prefs = pickStudioPrefs(all, studioId, event.gymId);
  const hasPrefs = !!(prefs.preferredSlots?.length || prefs.preferredRows?.length);
  return { prefs, hasPrefs };
}

function doQuickBook(event, btn) {
  const run = async () => {
    try {
      const { prefs, hasPrefs } = await resolveStudioPrefs(event);
      const { hasMap } = getStudioMapInfo(event);
      if (!hasPrefs && hasMap) { openBookingModal(event, 'quickbook'); return; }
      quickBookClass(event.id, {
        preferredSlots: prefs.preferredSlots || [],
        preferredRows: prefs.preferredRows || [],
        requiredCount: 1, bookAny: true,
      }, btn, event.gymId);
    } catch (err) {
      openBookingModal(event, 'quickbook');
    }
  };
  // Booking within 12h of start needs an explicit confirm.
  if (isWithin12Hours(event.startAt)) twoTapConfirm(btn, 'Starts soon — confirm?', run);
  else run();
}

async function doAutoBookToggle(event, btn, isScheduled) {
  if (isScheduled) {
    try {
      showToast('Removing scheduled booking...', 'info');
      const autoBookings = await api.getAutoBookings();
      const existing = (autoBookings.data || autoBookings || []).find(x => String(x.event_id || x.eventId) === String(event.id));
      if (existing) {
        await api.deleteAutoBooking(existing.id);
        showToast('Scheduled auto-book cancelled.', 'info');
        renderTimetableGrid();
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
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
async function doEditBooking(event) {
  const eventBookings = userBookings.filter(b => matchesEvent(b, event));
  if (!eventBookings.length) { showToast('Booking not found — refresh and try again.', 'error'); return; }

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
    userBookings = bookingsRes || [];
    userWaitlists = waitlistsRes || [];
    cache.bookings = userBookings;
    cache.waitlists = userWaitlists;
  } catch (e) {
    console.warn('[Timetable] refreshBookingState failed:', e);
  }
  renderTimetableGrid();
}

async function doJoinWaitlist(event, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Joining...';
  try {
    await api.joinWaitlist(event.id, event.gymId);
    showToast('Successfully joined waitlist!', 'success');
    prefetchTimetableData(true);
  } catch (err) {
    showToast(`Waitlist failed: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function doLeaveWaitlist(waitlistId, btn, gymId = null) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Leaving...';
  try {
    await api.leaveWaitlist(waitlistId, gymId);
    showToast('Left waitlist successfully!', 'success');
    await refreshUserData(true);
    await refreshBookingState();
  } catch (err) {
    showToast(`Error leaving waitlist: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// Unicode (non-emoji) glyph that prefixes certain action labels.
function actionGlyph(label) {
  if (label === 'Quick-Book' || label === 'Quick Book') return '⚡︎';
  if (label === 'Auto-Book' || label === 'Auto Book' || label === 'Scheduled' || label === 'Sched.') return sparklesIcon(16, 'currentColor');
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
  if (!r) return 'No credits';
  if (/no credits/i.test(r)) return 'No credits';
  if (/membership/i.test(r)) return 'No membership';
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
      icon: model.secondary.isCancel ? 'close' : (isBookish ? 'bolt' : 'chevron'),
      variant: model.secondary.isCancel ? 'danger' : (isBookish ? 'book' : ''),
      keepOpen: !!model.secondary.isCancel, // cancel runs its own two-tap confirm in place
      graceDeadline: model.secondary.graceDeadline,
      action: (el) => model.secondary.run(el),
    });
  }

  // The other way to do what the primary does — e.g. pick your own spot when
  // the primary quick-books one for you.
  if (model.alternate && model.alternate.run) {
    items.push({ label: model.alternate.label, icon: 'grid', variant: 'book', action: () => model.alternate.run() });
  }

  if (model.config) {
    items.push({
      label: model.config === 'autobook' ? 'Configure Auto-Book' : 'Configure Quick-Book',
      icon: 'cog',
      variant: '',
      action: () => openBookingModal(event, model.config),
    });
  }

  if (canForGym('bookmarks', event.gymId)) {
    items.push({
      label: isBookmarked ? 'Unfavourite' : 'Favourite',
      icon: 'heart',
      variant: 'favourite',
      action: () => toggleNativeBookmark(event, null),
    });
  }

  items.push({ label: 'Studio Occupancy', icon: 'grid', variant: '', action: () => openOccupancyModal(event) });

  if (userSettings.debugMode) {
    items.push({ label: 'Debug', icon: 'bug', variant: 'debug', action: () => openDebugModal(event) });
  }
  return items;
}

/** Build the floating menu element for a set of items (shared desktop/mobile). */
function buildActionMenuElement(menuItems) {
  const menu = document.createElement('div');
  menu.className = 'psycle-mobile-menu';
  menu.style.display = 'none';
  menuItems.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'psycle-mobile-menu-item';
    // Icon + label. The label goes in its own span with textContent — menu
    // labels can include a class name, and those come from the provider.
    if (item.icon) {
      const ic = document.createElement('span');
      ic.className = 'psycle-menu-item-icon';
      ic.innerHTML = icon(item.icon, 15);
      ic.setAttribute('aria-hidden', 'true');
      div.appendChild(ic);
    }
    const label = document.createElement('span');
    label.className = 'psycle-menu-item-label';
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
  wrap.className = 'psycle-tt-actions';

  const group = document.createElement('div');
  group.className = 'psycle-tt-seg-group' + (model.config && model.showConfigButton !== false ? ' has-caret' : '');

  const pbtn = document.createElement('button');
  pbtn.className = `psycle-tt-seg primary variant-${model.primary.variant}` + (model.primary.scheduled ? ' scheduled' : '');
  setSegLabel(pbtn, model.primary.label);
  if (model.primary.disabled) pbtn.disabled = true;
  else if (model.primary.run) pbtn.onclick = (e) => { e.stopPropagation(); model.primary.run(pbtn); };
  group.appendChild(pbtn);

  if (model.config && model.showConfigButton !== false) {
    const caret = document.createElement('button');
    caret.className = `psycle-tt-seg psycle-tt-seg-caret primary variant-${model.primary.variant}` + (model.primary.scheduled ? ' scheduled' : '');
    caret.innerHTML = '⚙';
    caret.title = model.config === 'autobook' ? 'Configure auto-book' : 'Configure quick-book';
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
    sbtn.className = `psycle-tt-seg secondary variant-${model.secondary.variant}`;
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
    more.className = 'psycle-tt-seg psycle-tt-seg-more';
    more.innerHTML = '⋯';
    more.setAttribute('aria-label', 'More actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.title = 'More actions';
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
    document.querySelectorAll('.psycle-mobile-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
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
  const filtersRow = document.querySelector('#psycle-timetable-filters-container .psycle-filters-row');
  if (!filtersRow) return;

  // Rebuild the trigger + menu every render. The grid clears all body-appended
  // .psycle-mobile-menu nodes on each render (see renderTimetableGrid), which
  // would otherwise orphan a once-created menu and silently break opening.
  document.getElementById('psycle-mobile-filter-trigger')?.remove();

  const trigger = document.createElement('button');
  trigger.id = 'psycle-mobile-filter-trigger';
  trigger.className = 'psycle-mobile-ellipsis psycle-mobile-filter-ellipsis';
  trigger.innerHTML = '\u22ef';
  trigger.setAttribute('aria-label', 'Filter options');

  const menu = document.createElement('div');
  menu.className = 'psycle-mobile-menu';
  menu.style.display = 'none';

  const favBtn = document.getElementById('psycle-filter-favorites-only');
  const clearBtn = document.getElementById('psycle-btn-clear-all-filters');
  const saveBtn = document.getElementById('psycle-btn-save-default-filters');

  const items = [];
  if (favBtn) items.push({ label: showBookmarksOnly ? 'Bookmarked (on)' : 'Bookmarked', icon: 'heart', variant: 'favourite', action: () => favBtn.click() });
  if (clearBtn) items.push({ label: 'Clear Filters', icon: 'close', variant: 'danger', action: () => clearBtn.click() });
  if (saveBtn) items.push({ label: 'Save Defaults', icon: 'check', variant: 'success', action: () => saveBtn.click() });

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'psycle-mobile-menu-item';
    // Icon + label. The label goes in its own span with textContent — menu
    // labels can include a class name, and those come from the provider.
    if (item.icon) {
      const ic = document.createElement('span');
      ic.className = 'psycle-menu-item-icon';
      ic.innerHTML = icon(item.icon, 15);
      ic.setAttribute('aria-hidden', 'true');
      div.appendChild(ic);
    }
    const label = document.createElement('span');
    label.className = 'psycle-menu-item-label';
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
  tr.className = `psycle-mobile-row ${rowClass || ''}`;

  const td = document.createElement('td');
  td.colSpan = 6;

  const card = document.createElement('div');
  card.className = 'psycle-mobile-class-card';
  card.setAttribute('data-gym', event.gymId || 'psycle-london');

  const displayLoc = trimLocation(locName, getGymShortName(event.gymId));

  // Favourite heart is a non-interactive indicator on mobile (only shown when
  // bookmarked), sitting between the time and the discipline chip. Toggling
  // happens through the context menu instead.
  const favIndicator = isBookmarked
    ? (canForGym('bookmarks', event.gymId) ? `<span class="psycle-mobile-fav-indicator" aria-label="Favourited">${heartChar}</span>` : '')
    : '';

  card.innerHTML = `
    <div class="psycle-mobile-content">
      <div class="psycle-mobile-top-line">
        <strong>${timeStr}</strong>
        ${favIndicator}
        ${/* Gym BEFORE the discipline pill. Ownership is the first question a
             merged timetable has to answer, and on a narrow card the eye runs
             left-to-right along one line — putting the gym second made you read
             past the discipline to find out whose class it was. Matches the
             desktop column order, where GYM also precedes CLASS. */ ''}
        ${gymChip(event.gymId)}
        ${disciplineTag(groupName)}
        ${instrName ? `<span class="psycle-mobile-instructor psycle-instructor-hover" data-id="${event.instructors?.[0]?.id}" data-gym-id="${event.gymId || ''}">${instrName}</span>` : ''}
      </div>
      <div class="psycle-mobile-bottom-line">
        <span class="psycle-mobile-class-name">${strippedClassName}</span>
        <span class="psycle-mobile-dot">&middot;</span>
        <span class="psycle-mobile-location">${displayLoc}</span>
      </div>
    </div>
    <div class="psycle-mobile-rail"></div>
  `;

  const rail = card.querySelector('.psycle-mobile-rail');

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
  pbtn.className = `psycle-mobile-seg primary variant-${mobilePrimary.variant}` + (mobilePrimary.scheduled ? ' scheduled' : '');
  if (mobilePrimary.scheduled && mobilePrimary.variant === 'autoupgrade') {
    // "Scheduled" is too wide for 52px — abbreviate it.
    setSegLabel(pbtn, 'Sched.');
  } else {
    setSegLabel(pbtn, mobilePrimary.label);
  }
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
  ellipsis.className = 'psycle-mobile-seg ellipsis';
  ellipsis.innerHTML = '⋯';
  ellipsis.setAttribute('aria-label', 'More actions');
  rail.appendChild(ellipsis);

  // When Cancel took the visible slot, hide it from the shared overflow
  // builder (it's already reachable directly) and surface Edit there instead
  // — otherwise Edit would be lost entirely on mobile.
  const menuItems = buildActionMenuItems(event, swapForCancel ? { ...model, secondary: null } : model, isBookmarked);
  if (swapForCancel) {
    menuItems.unshift({ label: model.primary.label, icon: 'chevron', variant: '', action: () => model.primary.run() });
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
  overlay.className = 'psycle-modal';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '2000001';

  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'psycle-modal-overlay';

  const card = document.createElement('div');
  card.className = 'psycle-modal-card';
  card.style.width = '420px';
  card.style.maxWidth = '95vw';

  const header = document.createElement('div');
  header.className = 'psycle-modal-header';
  header.innerHTML = `
    <h4>Studio Occupancy</h4>
    <button class="psycle-modal-close-btn">&times;</button>
  `;

  const body = document.createElement('div');
  body.className = 'psycle-modal-body';
  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 20px 0;">
      <div class="psycle-spinner"></div>
      <span>Loading layout...</span>
    </div>
  `;

  card.appendChild(header);
  card.appendChild(body);
  overlay.appendChild(modalOverlay);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  setTimeout(() => overlay.classList.add('show'), 10);

  const closeModal = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  };

  header.querySelector('.psycle-modal-close-btn').onclick = closeModal;
  modalOverlay.onclick = closeModal;

  try {
    const res = await api.getEventDetails(event.id, event.gymId);
    body.innerHTML = '';
    renderMinimap(res, body);
  } catch (err) {
    body.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--danger); font-size: 13px;">
        Failed to load occupancy data.
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
    timeZone: 'Europe/London',
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
    showToast('Error generating bookmark ID.', 'error');
    return;
  }
  
  const bookmarks = cache.profile?.metafields?.public?.bookmarks?.events || [];
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
      showToast('This gym does not support bookmarks.', 'info');
      return;
    }
    await api.setBookmark(identifier, !isCurrentlyBookmarked);
    
    // Refresh user profile cache
    await refreshUserData();
    showToast(isCurrentlyBookmarked ? 'Removed bookmark.' : 'Class bookmarked successfully!', 'success');
    setupDropdownFilters();
    renderTimetableGrid();
  } catch (err) {
    console.error('[Timetable] Bookmark toggle failed:', err);
    showToast('Failed to update class bookmark.', 'error');
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
    btn.innerHTML = `Booking...`;
  }

  const preferredSlots = prefs.preferredSlots || [];
  const preferredRows = prefs.preferredRows || [];
  const requiredCount = prefs.requiredCount || 1;
  const bookAny = prefs.bookAny !== false;
  const autoUpgrade = prefs.autoUpgrade !== false;

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
      showToast('Could not load class data.', 'error');
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
            showToast('Fully booked! Joining waitlist...', 'warning');
            try {
              await api.joinWaitlist(eventId, gymId);
              showToast('Joined waitlist successfully!', 'success');
              prefetchTimetableData(true);
            } catch (wlErr) {
              showToast(`Waitlist failed: ${wlErr.message}`, 'error');
            }
          } else {
            showToast(`Quick book failed: ${bookRes.error || 'Booking was declined'}`, 'error');
          }
          return;
        }
        showToast('Quick-booked! 🎉', 'success');
        api.notifyBookingSuccess({
          source: 'quickbook', eventId,
          className: eventData.name || '', groupName: eventData.discipline || '',
          instructorName: eventData.instructors?.[0]?.name || '',
          startAt: eventData.startAt, slots: [],
        }).catch(() => {});
        await refreshUserData(true);
        await refreshBookingState();
      } catch (err) {
        showToast(`Quick book failed: ${err.message}`, 'error');
      }
      return;
    }

    const liveAvailable = slots.filter((s) => s.isAvailable).map((s) => Number(s.id));

    if (liveAvailable.length === 0) {
      showToast('Fully booked! Joining waitlist...', 'warning');
      try {
        await api.joinWaitlist(eventId, gymId);
        showToast('Joined waitlist successfully!', 'success');
        prefetchTimetableData(true);
      } catch (wlErr) {
        showToast(`Waitlist failed: ${wlErr.message}`, 'error');
      }
      return;
    }

    const primarySlots = preferredSlots.filter(id => liveAvailable.includes(Number(id)));

    let rowSlots = [];
    if (preferredRows && preferredRows.length > 0 && slots.length > 0) {
      preferredRows.forEach(ry => {
        const slotsInRow = slots.filter(s => s.row === ry);
        const rowSlotIds = slotsInRow.map(s => Number(s.id));
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
      const remainingAvailable = liveAvailable.filter(id => !slotsToTry.includes(Number(id)));
      slotsToTry.push(...remainingAvailable);
    }

    if (slotsToTry.length === 0) {
      showToast('No eligible slots available matching preferences.', 'error');
      return;
    }

    let bookedCount = 0;
    let attemptIdx = 0;

    let lastBookedSlot = null;
    let lastBookingRes = null;
    const bookedSlotLabels = [];
    const qbNoun = seatNoun(eventData.discipline);
    while (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
      const targetSlot = slotsToTry[attemptIdx];
      try {
        // api.book() returns a NormalizedBookingResult { ok, bookingId, slotId,
        // error } and does NOT throw on a decline — unlike the raw proxy, which
        // threw. A refusal is data here, so it has to be checked, or a failed
        // booking reads as a success.
        const bookRes = await api.book(eventId, [targetSlot], gymId);
        if (!bookRes.ok) throw new Error(bookRes.error || 'Booking was declined');
        bookedCount++;
        lastBookedSlot = targetSlot;
        lastBookingRes = bookRes;
        const ls = slots.find(s => Number(s.id) === Number(targetSlot));
        bookedSlotLabels.push(ls?.label ?? targetSlot);
        showToast(`Quick-booked ${qbNoun} ${ls?.label ?? targetSlot}! 🎉`, 'success');
      } catch (err) {
        console.error(`Quick book failed for slot ${targetSlot}:`, err.message);
      }
      attemptIdx++;
      if (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    if (bookedCount > 0) {
      api.notifyBookingSuccess({
        source: 'quickbook', eventId,
        className: eventData.name || '',
        groupName: eventData.discipline || '',
        instructorName: eventData.instructors?.[0]?.name || '',
        startAt: eventData.startAt, slots: bookedSlotLabels,
      }).catch(() => {});
      // `event` (normalized), not `eventData` (== event.raw): tryAutoRegisterUpgrade
      // reads studioId/gymId, which only exist on the normalized shape. Passing the
      // raw provider object here made resolveStudioPrefs resolve to nothing, since
      // raw CodexFit events use `studio_id` and carry no `gymId` at all — so the
      // "no preferred spot map" toast fired even when Quick-Book had just proven one existed.
      if (lastBookedSlot !== null) await tryAutoRegisterUpgrade(event, lastBookedSlot, lastBookingRes, autoUpgrade);
      await refreshUserData(true);
      await refreshBookingState();
      setTimeout(() => {
        if (!userSettings.autoUpgradeByDefault) {
          showToast('💡 Tip: Enable "Auto-upgrade spots by default" in Settings to monitor for better slots automatically!', 'info');
        }
      }, 2000);
    } else {
      showToast('Failed to quick book any slots.', 'error');
    }
  } catch (err) {
    showToast(`Quick Book error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `Quick Book`;
    }
  }
}

// Modal handler for spot selection layout and auto-book row preference checklist
async function openBookingModal(c, mode) {
  // mode: 'book' (simple seat selector) | 'quickbook' (preference setter) | 'autobook' (preference setter)
  const isAutoBookMode = mode === 'autobook';
  const isQuickBookMode = mode === 'quickbook';
  const isSimpleBookMode = mode === 'book';

  const modal = document.getElementById('psycle-booking-modal');
  const body = document.getElementById('psycle-booking-modal-body');
  const title = document.getElementById('psycle-booking-modal-title');
  if (!modal || !body || !title) return;

  const noun = seatNoun(c.discipline);
  title.textContent = isAutoBookMode ? 'Configure Auto-Book' : (isQuickBookMode ? `Select a ${noun} in the studio` : `Select a ${noun} in the studio`);

  // Use cached layout if available — layouts don't change mid-session.
  // WP-C5: the cache now holds NormalizedSlot[]/NormalizedLayoutObject[] (see
  // below), so this is only consulted for the loading-message copy here.
  const cachedLayout = studioLayoutCache.get(c.studioId);
  const hasLayout = cachedLayout?.slots?.length > 0;

  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span>${hasLayout ? 'Checking availability…' : 'Fetching studio floor map…'}</span>
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
      studioLayoutCache.set(c.studioId, { slots: eventSlots, objects: eventObjects });
    }
    const availableIds = new Set(eventSlots.filter(s => s.isAvailable).map(s => Number(s.id)));
    const availableSlots = layoutSlots.map(s => Number(s.id)).filter(id => availableIds.has(id));

    // Determine if booking window is already open
    const classReleaseTime = getClassReleaseTime(c);
    const isLive = classReleaseTime.toMillis() <= Date.now();

    const instrName = metadata.instructors.find(i => sameId(i.id, c.instructors?.[0]?.id) && (!c.gymId || i.gymId === c.gymId))?.name || '';
    const eventType = metadata.eventTypes.find(t => sameId(t.id, c.classTypeId) && (!c.gymId || t.gymId === c.gymId));
    const groupName = c.discipline || eventType?.group || eventType?.name || 'Class';
    const nounCap = seatNoun(groupName)[0].toUpperCase() + seatNoun(groupName).slice(1);
    const startDate = new Date(c.startAt);
    const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const studioName = c.studioName || gymScopedGet(studioMap, c.studioId, c.gymId) || 'this studio';

    if (isAutoBookMode) {
      title.textContent = `Auto-Book: ${timeStr} ${groupName}${instrName ? ' with ' + instrName : ''}`;
    } else if (isQuickBookMode) {
      title.textContent = `Configure Quick-Book for ${studioName}: ${timeStr} ${groupName}${instrName ? ' with ' + instrName : ''}`;
    } else {
      title.textContent = `Choose a ${seatNoun(groupName)} for ${timeStr} ${groupName}${instrName ? ' with ' + instrName : ''}`;
    }

    if (layoutSlots.length === 0) {
      body.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-secondary);">
          <p style="margin-bottom: 16px;">No floor map layout available for this studio.</p>
          ${isAutoBookMode
            ? `<button class="psycle-btn" id="btn-save-simple-autobook" style="background: var(--feat-autoupgrade); color:var(--on-accent); display:flex; align-items:center; justify-content:center; gap:6px;">${sparklesIcon(14, 'currentColor')} Schedule Auto-Book (Any Seat)</button>`
            : `<button class="psycle-btn" id="btn-book-any" style="background: var(--success); color:var(--on-accent);">Book Any Available ${nounCap}</button>`
          }
        </div>
      `;

      if (isAutoBookMode) {
        document.getElementById('btn-save-simple-autobook').onclick = () => {
          saveAutoBookPreferences(c, [], [], 1, true, closeModal);
        };
      } else {
        document.getElementById('btn-book-any').onclick = () => bookSeatDirect(c.id, availableSlots[0], closeModal, c);
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
      <div id="psycle-modal-info-banner" style="margin-bottom:10px;"></div>
      <div class="psycle-floor-plan-container" style="position:relative;height:${minMapHeight}px;background:var(--surface-inset);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;overflow:hidden;">
        <div id="psycle-floor-plan-grid" style="width:100%;height:100%;"></div>
      </div>
      <div id="psycle-map-edit-toggle"></div>
      <div id="psycle-slot-summary" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;min-height:16px;"></div>
      <div id="psycle-modal-controls-container"></div>
    `;

    const floorGrid = body.querySelector('#psycle-floor-plan-grid');

    // Render Stage — NormalizedLayoutObject[]; empty for providers with none.
    layoutObjects.forEach(obj => {
      const left = widthRange === 0 ? 50 : ((obj.x - minX) / widthRange) * 80 + 10;
      const top = heightRange === 0 ? 10 : ((obj.y - minY) / heightRange) * 75 + 10;
      const stage = document.createElement('div');
      stage.className = 'psycle-minimap-stage';
      stage.style.cssText = `position: absolute; left: ${left}%; top: ${top}%; transform: translate(-50%, -50%); background: color-mix(in srgb, var(--text) 15%, transparent); border: 1px solid color-mix(in srgb, var(--text) 30%, transparent); padding: 4px 16px; border-radius: 6px; font-size: 12px; font-weight: bold; color: #fff; letter-spacing: 0.5px;`;
      stage.textContent = 'STAGE';
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
    const maxBookableSlots = Math.min(providerMaxBookableSlots || availableSlots.length || 1, effectiveLimit);
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
        (prefs.preferredSlots || []).forEach(s => state.selectedSlots.push(Number(s)));
        (prefs.preferredRows || []).forEach(r => state.selectedRows.add(Number(r)));
        state.qty = prefs.requiredCount || 1;
        state.bookAny = prefs.bookAny !== false;
      }
    } catch (e) {}

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
    let updateQuickBookControls = null;
    let updateAutoBookControls = null;

    const render = () => {
      floorGrid.innerHTML = '';
      const summaryEl = body.querySelector('#psycle-slot-summary');

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
      layoutSlots.forEach(slot => {
        const slotId = Number(slot.id);
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
        bubble.title = `Seat ${label}`;

        if (priority > 0) {
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

        if (mapEditing) bubble.addEventListener('click', () => {
          const idx = state.selectedSlots.indexOf(slotId);
          if (idx !== -1) {
            // Already selected — deselect
            state.selectedSlots.splice(idx, 1);
          } else {
            // Not selected — try to select
            if (!isAutoBookMode && !isAvailable) {
              showToast(`⚠ This ${seatNoun(groupName)} is occupied or unavailable.`, 'warning');
              return;
            }
            if (isAutoBookMode && !isAvailable) {
              showToast('⚠ Currently occupied — will be targeted when booking fires.', 'info');
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
              showToast(`You can select up to ${state.qty} ${seatNoun(groupName)}${state.qty !== 1 ? 's' : ''}.`, 'info');
              return;
            }
          }
          render();
        });

        floorGrid.appendChild(bubble);
      });

      // Row +/- buttons (overlaid on right edge) — only for preference modes, not simple book, and only while editing
      if (rowYs.length > 1 && !isSimpleBookMode && mapEditing) {
        rowYs.forEach((y, idx) => {
          const isOn = state.selectedRows.has(y);
          const rowSlots = slotsByRow.get(y) || [];
          if (rowSlots.length === 0) return;
          const midY = (Math.min(...rowSlots.map(s => s.y)) + Math.max(...rowSlots.map(s => s.y))) / 2;

          const top = heightRange === 0 ? 50 : ((midY - minY) / heightRange) * 72 + 14;
          const btn = document.createElement('button');
          btn.style.cssText = `position:absolute;left:95.5%;top:${top}%;transform:translate(-50%,-50%);width:26px;height:26px;padding:0;border-radius:50%;background:${isOn ? 'color-mix(in srgb, var(--info) 30%, transparent)' : 'var(--surface-inset)'};border:1px solid ${isOn ? 'color-mix(in srgb, var(--info) 50%, transparent)' : 'var(--border-strong)'};color:${isOn ? 'var(--info)' : 'var(--text-secondary)'};font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.1s;z-index:2;`;
          btn.textContent = isOn ? '−' : '+';
          btn.title = isOn ? `Remove Row ${idx + 1}` : `Add Row ${idx + 1}`;
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
          const slot = layoutSlots.find(s => Number(s.id) === id);
          return slot?.label || String(id);
        });
        const rowLabels = Array.from(state.selectedRows).map(y => {
          const idx = rowYs.indexOf(y);
          return idx >= 0 ? String(idx + 1) : String(y);
        });
        if (spotLabels.length === 0 && rowLabels.length === 0) {
          summaryEl.innerHTML = '<span style="color:var(--text-tertiary);font-style:italic;">(None selected yet)</span>';
        } else {
          const fmt = (labels, noun) => {
            const shown = labels.slice(0, 3);
            const rest = labels.length > 3 ? ` <span style="color:var(--text-tertiary);">+${labels.length - 3} more</span>` : '';
            return `<span style="color:var(--text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">${noun}</span> <span style="color:var(--text);font-weight:700;">${shown.join(', ')}</span>${rest}`;
          };
          const parts = [];
          if (spotLabels.length > 0) parts.push(fmt(spotLabels, 'Spots'));
          if (rowLabels.length > 0) parts.push(fmt(rowLabels, 'Rows'));
          const sep = ' <span style="color:var(--text-tertiary);margin:0 4px;">›</span> ';
          summaryEl.innerHTML = `<span style="color:var(--text-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-right:6px;">Preferred</span>${parts.join(sep)}`;
        }
      }

      // Unmapped warning
      if (isAutoBookMode) {
        const layoutSlotIds = new Set(layoutSlots.map(s => Number(s.id)));
        const unmappedSlots = availableSlots.filter(id => !layoutSlotIds.has(id));
        const unmappedEl = body.querySelector('#psycle-unmapped-warning');
        if (unmappedEl) {
          unmappedEl.style.display = unmappedSlots.length > 0 ? 'block' : 'none';
          if (unmappedSlots.length > 0) {
            unmappedEl.innerHTML = `⚠ <strong>Additional Available Spots:</strong> ${unmappedSlots.join(', ')}`;
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
      if ((!isQuickBookMode && !isAutoBookMode) || mapEditing) return;
      const editBtn = document.createElement('button');
      editBtn.className = 'psycle-btn';
      editBtn.style.cssText = 'width:100%;margin-bottom:12px;background:color-mix(in srgb, var(--feat-autoupgrade) 12%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 30%, transparent);color:var(--feat-autoupgrade);';
      editBtn.textContent = `Edit preferred spots for ${studioName}`;
      editBtn.onclick = () => {
        mapEditing = true;
        render();
        updateMapEditToggle();
        if (typeof updateQuickBookControls === 'function') updateQuickBookControls();
        if (typeof updateAutoBookControls === 'function') updateAutoBookControls();
      };
      toggle.appendChild(editBtn);
    };

    // ── Auto-Book controls ─────────────────────────────────────────────
    if (isAutoBookMode) {
      const controls = body.querySelector('#psycle-modal-controls-container');
      const layoutSlotIds = new Set(layoutSlots.map(s => Number(s.id)));
      const unmappedSlots = availableSlots.filter(id => !layoutSlotIds.has(id));
      const releaseStr = isLive ? '' : classReleaseTime.toFormat('EEE d MMM, HH:mm');

      updateAutoBookControls = () => {
        const selectedQty = parseInt(controls.querySelector('#autobook-qty')?.value || state.qty) || 1;
        const creditsNeeded = selectedQty;
        const hasEnoughCredits = availableCredits >= creditsNeeded;
        const creditWarning = !hasEnoughCredits
          ? `In order for Auto-Book to work, you need to purchase ${creditsNeeded - availableCredits} more credit${creditsNeeded - availableCredits !== 1 ? 's' : ''}.`
          : '';

        body.querySelector('#psycle-modal-info-banner').innerHTML = mapEditing
          ? `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">You are editing your preferred spot map for <strong>${studioName}</strong>. Changes here apply to Quick-Book and Auto-Upgrade too.</div>`
          : `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">Spots here are your one shared preferred map for <strong>${studioName}</strong>. Scheduling updates it for Quick-Book and Auto-Upgrade too.</div>`;

        const toggleEl = body.querySelector('#psycle-map-edit-toggle');
        if (toggleEl && mapEditing) {
          const hint = toggleEl.querySelector('.ab-map-hint');
          if (!hint) {
            const h = document.createElement('div');
            h.className = 'ab-map-hint';
            h.style.cssText = 'font-size:12px;color:var(--text-secondary);font-style:italic;margin:8px 0 4px;';
            h.innerHTML = 'Click on the spots to set your priority order. Click the <strong>+</strong> button on the right to prefer entire rows.';
            toggleEl.appendChild(h);
          }
        }

        controls.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
            ${unmappedSlots.length > 0 ? `<div id="psycle-unmapped-warning" style="font-size:12px;color:var(--warning);background:color-mix(in srgb,var(--warning) 8%,transparent);border:1px solid color-mix(in srgb,var(--warning) 20%,transparent);border-radius:6px;padding:6px 10px;"></div>` : ''}
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            <div style="display:flex;gap:14px;align-items:center;">
              <div style="width:110px;">
                <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Slots to book:</label>
                <select id="autobook-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
                  ${[1,2,3,4].map(n => `<option value="${n}" ${state.qty===n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>
              <div style="flex:1;padding-top:14px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="autobook-fallback-any" ${state.bookAny ? 'checked' : ''}>
                  <span>Book any slot if preferred is unavailable</span>
                </label>
              </div>
            </div>
            ${(() => {
              const hasLayout = layoutSlots.length > 0;
              const hasPrefs = state.selectedSlots.length > 0 || state.selectedRows.size > 0;
              if (!hasLayout) return '';
              if (!hasPrefs) return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-tertiary);user-select:none;cursor:not-allowed;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="autobook-auto-upgrade" disabled>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} Auto-Upgrade: Please configure your preferred spots for this studio first.</span>
                </label>`;
              return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="autobook-auto-upgrade" ${userSettings.autoUpgradeByDefault ? 'checked' : ''}>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} Auto-Upgrade: Keep searching for a better spot for me</span>
                </label>`;
            })()}
            <button class="psycle-btn" id="btn-save-autobook" style="width:100%;background:var(--feat-autoupgrade);color:var(--on-accent);display:flex;align-items:center;justify-content:center;gap:6px;">${sparklesIcon(14, 'currentColor')} ${mapChanged() ? 'Save map and ' : ''}Schedule Auto-Book</button>
            <div style="font-size:12px;text-align:center;color:${isLive ? 'var(--success)' : 'var(--text-tertiary)'};">
              ${isLive ? '✓ Booking window is open' : `Booking opens: <span style="color:var(--text-secondary);">${releaseStr}</span>`}
            </div>
          </div>
        `;

        const qtySelector = controls.querySelector('#autobook-qty');
        qtySelector.onchange = () => {
          state.qty = parseInt(qtySelector.value) || 1;
          updateAutoBookControls();
        };

        controls.querySelector('#btn-save-autobook').onclick = () => {
          const qty = parseInt(controls.querySelector('#autobook-qty').value) || 1;
          const fallbackAny = controls.querySelector('#autobook-fallback-any').checked;
          const autoUpgrade = controls.querySelector('#autobook-auto-upgrade')?.checked ?? false;
          const preferredSlots = [...state.selectedSlots];
          const preferredRows = [...state.selectedRows];
          saveAutoBookPreferences(c, preferredSlots, preferredRows, qty, fallbackAny, closeModal, isLive, autoUpgrade);
        };

      };

      updateAutoBookControls();
    } else if (isSimpleBookMode) {
      // ── Simple Book controls (just pick slots, no preferences) ────────────────────
      const controls = body.querySelector('#psycle-modal-controls-container');

      updateSimpleBookControls = () => {
        const slotsSelected = state.selectedSlots.length || 0;
        const isDataLoaded = cache.profile && cache.profile.available_credits;
        const hasEnoughCredits = slotsSelected === 0 || availableCredits >= slotsSelected;
        const needsMoreCredits = slotsSelected > availableCredits ? slotsSelected - availableCredits : 0;
        const creditWarning = needsMoreCredits > 0 && isDataLoaded
          ? `In order to book, you need to purchase ${needsMoreCredits} more credit${needsMoreCredits !== 1 ? 's' : ''}.`
          : '';

        controls.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
            <div style="font-size:12px;color:var(--text-secondary);font-style:italic;">Select the ${seatNoun(groupName)}(s) you want to book for this class. You have <strong>${isDataLoaded ? availableCredits : '?'}</strong> credit${availableCredits !== 1 ? 's' : ''} available.</div>
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            ${(() => {
              const hasLayout = layoutSlots.length > 0;
              const hasPrefs = hasExistingPrefs;
              if (!hasLayout) return '';
              if (!hasPrefs) return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-tertiary);user-select:none;cursor:not-allowed;font-weight:500;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="simplebook-auto-upgrade" disabled>
                  <span style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${trendingUpIcon(12, 'currentColor', 2)} Auto-Upgrade: Please <a href="#" id="simplebook-configure-link" style="color:var(--feat-autoupgrade);text-decoration:underline;cursor:pointer;">configure your preferred spots</a> for <strong>${studioName}</strong> first.</span>
                </label>`;
              return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;font-weight:500;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="simplebook-auto-upgrade" ${userSettings.autoUpgradeByDefault ? 'checked' : ''}>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} Auto-Upgrade: Keep searching for a better spot for me</span>
                </label>`;
            })()}
            <div style="display:flex;gap:8px;">
              <button class="psycle-btn" id="btn-book-simple" style="flex:1;background:var(--success);color:var(--on-accent);" ${!isDataLoaded || !hasEnoughCredits ? 'disabled' : ''}>Book Selected ${nounCap}s</button>
            </div>
          </div>
        `;

        const configLink = controls.querySelector('#simplebook-configure-link');
        if (configLink) {
          configLink.onclick = (e) => {
            e.preventDefault();
            // Close the booking modal synchronously to avoid transition race conditions
            modal.classList.remove('show');
            modal.style.display = 'none';
            // Open the dedicated studio floor plan editor from settings
            openStudioFloorPlanEditor(c.studioId, studioName, () => {
              // Re-open the simple booking modal when the preferences are saved
              openBookingModal(c, 'book');
            }, { gymId: c.gymId });
          };
        }

        controls.querySelector('#btn-book-simple').onclick = async () => {
          if (state.selectedSlots.length === 0) {
            showToast(`Please select at least one ${seatNoun(groupName)} to book.`, 'warning');
            return;
          }
          if (state.selectedSlots.length > availableCredits) {
            showToast(`You only have ${availableCredits} credit${availableCredits !== 1 ? 's' : ''} available, but selected ${state.selectedSlots.length} ${seatNoun(groupName)}${state.selectedSlots.length !== 1 ? 's' : ''}.`, 'warning');
            return;
          }
          const btn = controls.querySelector('#btn-book-simple');
          if (isWithin12Hours(c.startAt) && btn.dataset.confirmState !== 'confirm') {
            btn.dataset.confirmState = 'confirm';
            btn.textContent = 'Class starts soon. Confirm?';
            btn.style.background = 'var(--warning)';
            setTimeout(() => {
              if (btn.dataset.confirmState === 'confirm') {
                delete btn.dataset.confirmState;
                btn.textContent = `Book Selected ${nounCap}s`;
                btn.style.background = '';
              }
            }, 4000);
            return;
          }
          delete btn.dataset.confirmState;
          btn.disabled = true;
          btn.textContent = 'Booking...';
          try {
            // One request per spot: api.book() books exactly one, because
            // MarianaTek creates one reservation per call (see base.js). Sequential
            // rather than parallel so a mid-way failure leaves a knowable state —
            // `results` says which spots actually got booked.
            const results = [];
            for (const slotId of state.selectedSlots) {
              const r = await api.book(c.id, [slotId], c.gymId);
              if (!r.ok) {
                if (results.length === 0) throw new Error(r.error || 'Booking was declined');
                // Partial success: keep what we got and tell the truth about it.
                showToast(`Booked ${results.length} of ${state.selectedSlots.length} — ${r.error || 'the rest were declined'}`, 'error');
                break;
              }
              results.push(r);
            }
            if (results.length === 0) return;
            const bookingRes = { ok: true, bookings: results, bookingId: results[0]?.bookingId, slotId: results[0]?.slotId };
            if (results.length === state.selectedSlots.length) {
              showToast(`Successfully booked ${state.selectedSlots.length} ${seatNoun(groupName)}${state.selectedSlots.length > 1 ? 's' : ''}! 🎉`, 'success');
            }
            const bookedSlots = state.selectedSlots.slice(0, results.length);
            const bookedLabels = bookedSlots.map(id => {
              const s = layoutSlots.find(ls => String(ls.id) === String(id));
              return s?.label ?? id;
            });
            api.notifyBookingSuccess({
              source: 'manual', eventId: c.id, className: c.name || groupName, groupName,
              instructorName: instrName, startAt: c.startAt, slots: bookedLabels,
            }).catch(() => {});
            const autoUpgrade = controls.querySelector('#simplebook-auto-upgrade')?.checked ?? false;
            closeModal();
            await tryAutoRegisterUpgrade(c, bookedSlots[0], bookingRes, autoUpgrade);
            await refreshUserData(true);
            await refreshBookingState();
          } catch (err) {
            showToast(`Booking failed: ${err.message}`, 'error');
            btn.disabled = false;
            btn.textContent = `Book Selected ${nounCap}s`;
          }
        };
      };

      updateSimpleBookControls();
    } else if (isQuickBookMode) {
      // ── Quick-Book controls (preference setter) ────────────────────────────────────────
      const controls = body.querySelector('#psycle-modal-controls-container');

      updateQuickBookControls = () => {
        const selectedQty = parseInt(controls.querySelector('#quickbook-qty')?.value || state.qty) || 1;
        const creditsNeeded = selectedQty;
        const hasEnoughCredits = availableCredits >= creditsNeeded;
        const creditWarning = !hasEnoughCredits
          ? `In order for Quick-Book to work, you need to purchase ${creditsNeeded - availableCredits} more credit${creditsNeeded - availableCredits !== 1 ? 's' : ''}.`
          : '';

        body.querySelector('#psycle-modal-info-banner').innerHTML = !mapEditing
          ? `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">Quick-Book uses your preferred spot map to book the best spot it can. You can edit your preferred spots any time in Settings.</div>`
          : (hasExistingPrefs
            ? `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb,var(--feat-autoupgrade) 8%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 18%,transparent);border-radius:8px;padding:8px 10px;line-height:1.5;">You are editing your preferred spot map for <strong>${studioName}</strong>. Changes here apply to Auto-Book and Auto-Upgrade too.</div>`
            : `<div style="font-size:12px;color:var(--text-tertiary);background:color-mix(in srgb,var(--feat-autoupgrade) 7%,transparent);border:1px solid color-mix(in srgb,var(--feat-autoupgrade) 15%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5;">First time setup: Quick-Book grabs a preferred spot in any class in one click. Set your preferred spots for <strong style="color:var(--feat-autoupgrade);">${studioName}</strong> once and they'll apply everywhere.</div>`);

        const qbToggleEl = body.querySelector('#psycle-map-edit-toggle');
        if (qbToggleEl && mapEditing && !qbToggleEl.querySelector('.ab-map-hint')) {
          const h = document.createElement('div');
          h.className = 'ab-map-hint';
          h.style.cssText = 'font-size:12px;color:var(--text-secondary);font-style:italic;margin:8px 0 4px;';
          h.innerHTML = 'Click on the spots to set your priority order. Click the <strong>+</strong> button on the right to prefer entire rows.';
          qbToggleEl.appendChild(h);
        } else if (qbToggleEl && !mapEditing) {
          const existing = qbToggleEl.querySelector('.ab-map-hint');
          if (existing) existing.remove();
        }

        controls.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px;background:var(--surface-inset);padding:14px;border-radius:12px;border:1px solid var(--border);">
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            <div style="display:flex;gap:14px;align-items:center;">
              <div style="width:110px;">
                <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Slots to book:</label>
                <select id="quickbook-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
                  ${[1,2,3,4].map(n => `<option value="${n}" ${state.qty===n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>
              <div style="flex:1;padding-top:14px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="quickbook-fallback-any" ${state.bookAny ? 'checked' : ''}>
                  <span>Book any slot if preferred is unavailable</span>
                </label>
              </div>
            </div>
            ${(() => {
              const hasLayout = layoutSlots.length > 0;
              const hasPrefs = state.selectedSlots.length > 0 || state.selectedRows.size > 0;
              if (!hasLayout) return '';
              if (!hasPrefs) return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-tertiary);user-select:none;cursor:not-allowed;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="quickbook-auto-upgrade" disabled>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} Auto-Upgrade: Please configure your preferred spots for this studio first.</span>
                </label>`;
              return `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" class="psycle-ms-checkbox" id="quickbook-auto-upgrade" ${userSettings.autoUpgradeByDefault ? 'checked' : ''}>
                  <span style="display:flex;align-items:center;gap:4px;">${trendingUpIcon(12, 'currentColor', 2)} Auto-Upgrade: Keep searching for a better spot for me</span>
                </label>`;
            })()}
            <button class="psycle-btn" id="btn-submit-quickbook" style="width:100%;background:var(--success);color:var(--on-accent);">${mapChanged() ? 'Save map and ' : ''}Quick-Book</button>
          </div>
        `;

        controls.querySelector('#btn-submit-quickbook').onclick = async () => {
          if (state.selectedSlots.length === 0 && state.selectedRows.size === 0) {
            showToast(`Please select at least one ${seatNoun(groupName)} or row to book.`, 'warning');
            return;
          }
          const btn = controls.querySelector('#btn-submit-quickbook');
          const baseLabel = `${mapChanged() ? 'Save map and ' : ''}Quick-Book`;
          if (isWithin12Hours(c.startAt) && btn.dataset.confirmState !== 'confirm') {
            btn.dataset.confirmState = 'confirm';
            btn.textContent = 'Class starts soon. Confirm?';
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
          btn.textContent = 'Booking...';
          try {
            const qty = parseInt(controls.querySelector('#quickbook-qty').value) || 1;
            const fallbackAny = controls.querySelector('#quickbook-fallback-any').checked;
            const autoUpgrade = controls.querySelector('#quickbook-auto-upgrade')?.checked ?? false;
            const slots = [...state.selectedSlots];
            const rows = [...state.selectedRows];
            if (mapChanged() && c.studioId) {
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
            showToast(`Quick Book error: ${err.message}`, 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = baseLabel;
          }
        };

        const quickbookQtySelector = controls.querySelector('#quickbook-qty');
        quickbookQtySelector.onchange = () => {
          state.qty = parseInt(quickbookQtySelector.value) || 1;
          updateQuickBookControls();
        };
      };

      updateQuickBookControls();
    }

    render();
    updateMapEditToggle();
  } catch (err) {
    console.error('[Timetable] Modal load floor map failed:', err);
    body.innerHTML = `<div class="psycle-card-error" style="color: var(--danger); padding: 20px 0; text-align: center;">Error loading layout: ${err.message}</div>`;
  }
}

// Auto-register upgrade monitor after a successful booking if the setting is on
async function tryAutoRegisterUpgrade(event, bookedSlotId, bookingRes, enableOverride) {
  const shouldRegister = enableOverride !== undefined ? enableOverride : userSettings.autoUpgradeByDefault;
  debugConsole('[AutoUpgrade] tryAutoRegisterUpgrade called', { shouldRegister, bookedSlotId, eventId: event?.id });
  if (!shouldRegister) {
    debugConsole('[AutoUpgrade] Skipping — auto-upgrade is disabled. userSettings:', JSON.stringify(userSettings));
    return;
  }
  try {
    const studioId = event.studioId;
    debugConsole('[AutoUpgrade] Studio ID:', studioId, '| event.studio:', event.studio);

    // Same resolution Quick-Book used, so the two cannot disagree.
    const { prefs, hasPrefs } = await resolveStudioPrefs(event);
    debugConsole('[AutoUpgrade] Resolved prefs:', prefs, 'hasPrefs:', hasPrefs);
    if (!hasPrefs) {
      const studioName = event.studioName || gymScopedGet(studioMap, studioId, event.gymId) || 'this studio';
      debugConsole('[AutoUpgrade] No preferred spot map for studio:', studioName, '| prefs:', prefs);
      showToast(`Can't set auto-upgrade because you don't have a preferred spot map for ${studioName}. Please configure one!`, 'warning');
      return;
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
        currentSlotId: Number(b.slotId),
        className: event.name || event.name || 'Class',
        instructorName: event.instructors?.[0]?.name || (event.instructors?.[0]?.name) || '',
        studioName: event.studioName || event.studioName || '',
        locationName: event.locationName || event.locationName || '',
        startAt: event.startAt || event.startAt,
        preferences: { keepOriginalOnCutoff: true },
      }));
    }

    if (registerPromises.length === 0) {
      console.warn('[AutoUpgrade] Could not resolve any booking IDs — giving up. Response:', bookingRes);
      return;
    }

    await Promise.all(registerPromises);
    showToast(`Auto-upgrade monitor started for ${registerPromises.length} spot(s).`, 'info');
    debugConsole('[AutoUpgrade] Monitors registered successfully.');
  } catch (err) {
    console.warn('[AutoUpgrade] Failed to auto-register:', err.message, err);
  }
}

// Perform direct booking of spot ID
async function bookSeatDirect(eventId, slotId, callback, event) {
  try {
    showToast(`Booking spot ${slotId}...`, 'info');
    const bookingRes = await api.book(eventId, slotId == null ? [] : [slotId], event?.gymId);
    if (!bookingRes.ok) throw new Error(bookingRes.error || 'Booking was declined');
    showToast('Spot booked successfully! 🎉', 'success');
    callback();
    if (event) await tryAutoRegisterUpgrade(event, slotId, bookingRes);
    await refreshUserData(true);
    prefetchTimetableData(true);
  } catch (err) {
    showToast(`Booking failed: ${err.message}`, 'error');
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
    btn.textContent = 'Cancelling...';
    try {
      showToast('Cancelling booking...', 'info');
      await api.cancel(bookingId, gymId);
      showToast('Booking cancelled successfully!', 'success');

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
      showToast(`Cancel failed: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Cancel';
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
    btn.dataset.confirmState = 'confirm';
    btn.textContent = isPenalty ? 'Confirm penalty cancel?' : 'Confirm cancel?';
    btn.style.background = 'var(--danger)';
    btn.style.borderColor = 'var(--danger)';
    btn.style.color = 'var(--on-accent)';

    // Auto-reset confirmation state after 4 seconds
    setTimeout(() => {
      if (btn.dataset.confirmState === 'confirm') {
        btn.removeAttribute('data-confirm-state');
        btn.textContent = 'Cancel';
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
async function saveAutoBookPreferences(c, slots, rows, qty, bookAny, callback, skipImmediate = false, autoUpgrade = false) {
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
  const typePrefix = groupName.toUpperCase() + ': ';
  const fullClassName = c.name || c.name || classType.name;
  const strippedClassName = fullClassName.toUpperCase().startsWith(typePrefix)
    ? fullClassName.substring(typePrefix.length)
    : fullClassName;

  try {
    showToast('Scheduling auto-booking...', 'info');

    // The studio spot map is the shared source of truth. If the user picked
    // spots/rows here, persist them to the studio map so the live resolver (and
    // every other feature for this studio) uses the same selection.
    if (c.studioId && (slots.length > 0 || rows.length > 0)) {
      try {
        await api.updateStudioPreferences(c.studioId, { preferredSlots: slots, preferredRows: rows }, c.gymId);
      } catch (e) {
        console.warn('[AutoBook] Could not persist studio map:', e.message);
      }
    }

    const availForAB = getAvailableCreditsForEvent(c);
    const creditShortfall = Number.isFinite(availForAB) ? Math.max(0, qty - availForAB) : 0;

    await api.addAutoBooking({
      eventId: c.id,
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
    });

    showToast(`Successfully scheduled auto-book for ${strippedClassName}!`, 'success');
    callback();
    renderTimetableGrid();
  } catch (err) {
    showToast(`Failed to schedule auto-book: ${err.message}`, 'error');
  }
}

// ─── Debug Mode ──────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

export async function openDebugModal(event) {
  const modal = document.getElementById('psycle-debug-modal');
  const body = document.getElementById('psycle-debug-modal-body');
  const title = document.getElementById('psycle-debug-modal-title');
  if (!modal || !body || !title) return;

  title.textContent = `Debug: ${event.name || event.name || 'Class'} — ${event.startAt || ''}`;
  body.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span>Loading debug data...</span>
    </div>
  `;

  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('show'), 10);

  const closeBtn = document.getElementById('psycle-debug-modal-close');
  const overlay = modal.querySelector('.psycle-modal-overlay');

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
    const matchingBooking = userBookings.find(b => matchesEvent(b, event)) || null;
    const matchingWaitlist = userWaitlists.find(w => matchesEvent(w, event)) || null;

    // Compute key values
    const classRelease = getClassReleaseTime(event, userSettings);
    const now = DateTime.now().setZone('Europe/London');
    const isLive = event.alwaysBookable ? true : (now >= classRelease);
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
      tabBar.querySelectorAll('.psycle-debug-tab-btn').forEach(btn => {
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
          <div class="psycle-debug-computed" style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent); border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent); border-radius:10px; padding:14px; margin-bottom:16px;">
            <h5 style="color:var(--feat-autoupgrade); margin:0 0 10px 0; font-size:13px; font-weight:700;">Key Computed Values</h5>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:12px;">
              <span style="color:var(--text-secondary);">isLive:</span><span style="color:var(--text); font-weight:600;">${isLive}</span>
              <span style="color:var(--text-secondary);">classReleaseTime:</span><span style="color:var(--text); font-weight:600;">${classRelease.toISO()}</span>
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
        <div class="psycle-debug-json-block">
          <h5 style="color:var(--feat-autoupgrade); margin:0 0 8px 0; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">${tabLabel}</h5>
          <pre style="background:var(--surface-inset); border:1px solid var(--border); border-radius:8px; padding:14px; font-size:12px; line-height:1.5; color:var(--text); max-height:440px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin:0;">${escapeHtml(JSON.stringify(jsonData, null, 2))}</pre>
        </div>
      `;
    }

    // Helper: build human-readable relations map
    function buildRelationsMapHtml(rels, evt) {
      let html = '<div class="psycle-debug-relations-map" style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent); border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent); border-radius:10px; padding:14px; margin-bottom:16px;">';
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

    // Build the modal UI
    body.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:4px;">
        <!-- Quick-Book / Auto-Book / native page buttons -->
        <div id="psycle-debug-action-bar" style="display:flex; gap:8px; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:4px; flex-wrap:wrap;">
          <button id="psycle-debug-quick-book-btn" class="psycle-btn-mini variant-success-muted">Quick-Book</button>
          <button id="psycle-debug-auto-book-btn" class="psycle-btn-mini variant-neutral">Auto-Book Config</button>
          <a href="https://psyclelondon.com/pages/class/${event.id}" target="_blank" rel="noopener noreferrer" class="psycle-btn-mini" style="display:inline-flex; align-items:center; gap:5px; background:color-mix(in srgb, var(--info) 14%, transparent); border-color:color-mix(in srgb, var(--info) 30%, transparent); color:var(--info); text-decoration:none;">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open native booking page
          </a>
        </div>
        <!-- Tab bar -->
        <div class="psycle-debug-tab-bar" style="display:flex; gap:4px; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:12px; flex-wrap:wrap;">
          ${tabs.map(t => `
            <button class="psycle-debug-tab-btn" data-tab="${t.id}" style="background:${t.id === activeTab ? 'color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent)' : 'transparent'}; border:1px solid ${t.id === activeTab ? 'color-mix(in srgb, var(--feat-autoupgrade) 40%, transparent)' : 'var(--border)'}; color:${t.id === activeTab ? 'var(--feat-autoupgrade)' : 'var(--text-secondary)'}; padding:6px 14px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:600; transition:all 0.15s;">
              ${t.label}
            </button>
          `).join('')}
        </div>
        <!-- Content area -->
        <div id="psycle-debug-content" style="min-height:200px;"></div>
      </div>
    `;

    body.querySelector('#psycle-debug-quick-book-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeModal();
      setTimeout(() => openBookingModal(event, 'quickbook'), 320);
    });
    body.querySelector('#psycle-debug-auto-book-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeModal();
      setTimeout(() => openBookingModal(event, 'autobook'), 320);
    });

    const tabBar = body.querySelector('.psycle-debug-tab-bar');
    const contentArea = body.querySelector('#psycle-debug-content');

    // Tab switching
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.psycle-debug-tab-btn');
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
        <button class="psycle-btn-mini variant-autoupgrade" id="psycle-debug-retry-btn">Retry</button>
      </div>
    `;
    const retryBtn = body.querySelector('#psycle-debug-retry-btn');
    if (retryBtn) {
      retryBtn.onclick = () => openDebugModal(event);
    }
  }
}
