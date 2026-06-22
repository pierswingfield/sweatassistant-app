import { api } from '../api';
import { showToast, currentUser, userSettings, refreshUserData, updateCreditBadge, cache } from '../main';
import { getClassReleaseTime, getNextMondayNoonLondon } from '../lib';
import { DateTime } from 'luxon';
// === MOBILE TIMETABLE — import renderMinimap (added Jun 2026; delete this block to revert) ===
import { renderMinimap } from './tooltips.js';
// === END MOBILE TIMETABLE BLOCK ===
import { openDB } from '../cache.js';

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
let studioObjMap = new Map(); // full studio object for location_id lookup
let instructorMap = new Map();
// Session-level studio layout cache keyed by studio_id — layouts rarely change mid-session
const studioLayoutCache = new Map();
let eventTypeMap = new Map();
let eventTypeGroupMap = new Map(); // eventTypeId -> group name

/** Rebuild lookup Maps from current metadata arrays. Includes both int and string keys. */
function buildMetaMaps() {
  locationMap = new Map();
  studioMap = new Map();
  studioObjMap = new Map();
  instructorMap = new Map();
  eventTypeMap = new Map();
  eventTypeGroupMap = new Map();

  metadata.locations.forEach(x => {
    locationMap.set(x.id, x.name);
    locationMap.set(String(x.id), x.name);
  });
  metadata.studios.forEach(x => {
    studioMap.set(x.id, x.name);
    studioMap.set(String(x.id), x.name);
    studioObjMap.set(x.id, x);
    studioObjMap.set(String(x.id), x);
  });
  metadata.instructors.forEach(x => {
    const name = x.full_name || x.name;
    instructorMap.set(x.id, name);
    instructorMap.set(String(x.id), name);
  });
  metadata.eventTypes.forEach(x => {
    eventTypeMap.set(x.id, x.name);
    eventTypeMap.set(String(x.id), x.name);
    if (x.group) {
      eventTypeGroupMap.set(x.id, x.group.name);
      eventTypeGroupMap.set(String(x.id), x.group.name);
    }
  });
}

/** Merge relations from an events payload into metadata (extension pattern). */
function mergeRelations(rels) {
  if (!rels) return;
  let changed = false;
  if (rels.locations) {
    rels.locations.forEach(x => {
      if (!metadata.locations.some(e => e.id === x.id)) {
        metadata.locations.push(x); changed = true;
      }
    });
  }
  if (rels.studios) {
    rels.studios.forEach(x => {
      if (!metadata.studios.some(e => e.id === x.id)) {
        metadata.studios.push(x); changed = true;
      }
    });
  }
  if (rels.instructors) {
    rels.instructors.forEach(x => {
      if (!metadata.instructors.some(e => e.id === x.id)) {
        metadata.instructors.push(x); changed = true;
      }
    });
  }
  if (rels.event_types) {
    rels.event_types.forEach(x => {
      if (!metadata.eventTypes.some(e => e.id === x.id)) {
        metadata.eventTypes.push(x); changed = true;
      }
    });
  }
  if (changed) buildMetaMaps();
}

let selectedLocations = [];
let selectedInstructors = [];
let selectedEventTypes = [];
let showBookmarksOnly = false;

let selectedTimetableDate = null;
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
  loadStoredFilters();
  await loadMetadata();
  setupDropdownFilters();
  await prefetchTimetableData();
  // Pull-to-refresh is handled centrally in main.js (attached to the shared
  // <main class="psycle-body"> scroller, dispatched by active tab).
}

// Load default filter selections from localStorage
function loadStoredFilters() {
  try {
    const stored = localStorage.getItem('psycleDefaultFilters');
    if (stored) {
      const parsed = JSON.parse(stored);
      selectedLocations = parsed.locations || [];
      selectedInstructors = parsed.instructors || [];
      selectedEventTypes = parsed.eventTypes || [];
      showBookmarksOnly = parsed.showBookmarksOnly || false;
    }
  } catch (e) {
    console.error('[Timetable] Failed to load default filters:', e);
  }
}

// Load metadata from API proxy
async function loadMetadata() {
  try {
    const promises = [];
    if (metadata.locations.length === 0) {
      promises.push(api.proxyGet('/locations', { ttlMs: 3600000 }).then(res => {
        metadata.locations = Array.isArray(res) ? res : (res.data || []);
      }));
    }
    if (metadata.instructors.length === 0) {
      promises.push(api.proxyGet('/instructors', { ttlMs: 3600000 }).then(res => {
        metadata.instructors = Array.isArray(res) ? res : (res.data || []);
      }));
    }
    if (metadata.eventTypes.length === 0) {
      promises.push(api.proxyGet('/event-types', { ttlMs: 3600000 }).then(res => {
        metadata.eventTypes = Array.isArray(res) ? res : (res.data || []);
      }));
    }
    if (metadata.studios.length === 0) {
      promises.push(api.proxyGet('/studios', { ttlMs: 3600000 }).then(res => {
        metadata.studios = Array.isArray(res) ? res : (res.data || []);
      }));
    }
    await Promise.all(promises);
  } catch (err) {
    console.error('[Timetable] Metadata load failed:', err);
    showToast('Failed to load filters metadata.', 'error');
  }
}

// Fetch all events for the prefetch window in parallel for all locations
// Uses smart caching: 4hr TTL for events, force-refresh after Monday 12PM London
const CACHE_KEY_EVENTS = 'psycleCacheEvents';
const CACHE_KEY_META = 'psycleCacheMeta';
const CACHE_KEY_TIME = 'psycleCacheTime';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function prefetchTimetableData(force = false) {
  if (isPrefetching) return;
  
  const ttContainer = document.getElementById('psycle-timetable-grid');
  if (!ttContainer) return;

  // Check if we can use cached event data
  const now = Date.now();
  const cacheTime = parseInt(localStorage.getItem(CACHE_KEY_TIME) || '0', 10);
  const cacheAge = now - cacheTime;
  
  // Force-refresh if past Monday 12PM London release window
  const nextMonday = getNextMondayNoonLondon();
  const lastMonday = nextMonday.minus({ weeks: 1 });
  const pastReleaseWindow = DateTime.now().setZone('Europe/London') >= lastMonday && cacheTime < lastMonday.toMillis();
  
  const cacheValid = !force && cacheAge < CACHE_TTL_MS && !pastReleaseWindow;
  
  if (cacheValid) {
    // Use cached events + metadata, always refresh bookings/waitlists
    try {
      const cachedEvents = await cacheGet(CACHE_KEY_EVENTS);
      const cachedMeta = await cacheGet(CACHE_KEY_META);
      if (cachedEvents && cachedEvents.length > 0) {
        psycleEvents = cachedEvents;
        // Restore metadata from cache so Maps can be rebuilt
        if (cachedMeta) {
          if (cachedMeta.locations?.length) metadata.locations = cachedMeta.locations;
          if (cachedMeta.studios?.length) metadata.studios = cachedMeta.studios;
          if (cachedMeta.instructors?.length) metadata.instructors = cachedMeta.instructors;
          if (cachedMeta.eventTypes?.length) metadata.eventTypes = cachedMeta.eventTypes;
        }
        buildMetaMaps(); // Rebuild maps from restored metadata
        isPrefetching = true;
        
        // Still refresh bookings/waitlists (they change frequently)
        const [bookingsRes, waitlistsRes] = await Promise.all([
          api.proxyGet('/bookings?limit=100&page=1', { ttlMs: 120000 }),
          api.proxyGet('/waitlists?limit=100&page=1', { ttlMs: 120000 })
        ]);
        userBookings = bookingsRes.data || bookingsRes || [];
        userWaitlists = waitlistsRes.data || waitlistsRes || [];
        cache.bookings = userBookings;
        cache.waitlists = userWaitlists;

        isPrefetching = false;
        renderTimetableGrid();
        return;
      }
    } catch (e) {
      console.warn('[Timetable] Cache read failed, refetching:', e);
    }
  }

  isPrefetching = true;
  prefetchError = null;

  ttContainer.innerHTML = `
    <div class="psycle-loading-spinner-container" style="padding: 40px 0;">
      <div class="psycle-spinner"></div>
      <span style="margin-top: 10px;">Fetching classes for all locations...</span>
    </div>
  `;

  try {
    // 1. Fetch user bookings and waitlists to keep action buttons in sync
    const [bookingsRes, waitlistsRes] = await Promise.all([
      api.proxyGet('/bookings?limit=100&page=1', { ttlMs: 120000 }),
      api.proxyGet('/waitlists?limit=100&page=1', { ttlMs: 120000 })
    ]);
    userBookings = bookingsRes.data || bookingsRes || [];
    userWaitlists = waitlistsRes.data || waitlistsRes || [];
    cache.bookings = userBookings;
    cache.waitlists = userWaitlists;

    // 2. Fetch events for all locations in parallel
    const prefetchWeeks = userSettings.prefetchWeeks || 4;
    const startDate = new Date();
    const startStr = startDate.toISOString().split('T')[0] + ' 00:00:00';
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + (prefetchWeeks * 7));
    const endStr = endDate.toISOString().split('T')[0] + ' 23:59:59';

    const eventPromises = metadata.locations.map(async (loc) => {
      try {
        const url = `/events?location=${loc.id}&start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`;
        const res = await api.proxyGet(url);
        return res; // Return full payload so we can extract relations
      } catch (err) {
        console.warn(`[Timetable] Failed to fetch events for location ${loc.name}:`, err.message);
        return null;
      }
    });

    const results = await Promise.all(eventPromises);
    const freshEvents = [];
    let hasData = false;
    for (const payload of results) {
      if (!payload) continue;
      hasData = true;
      const events = payload.data || (Array.isArray(payload) ? payload : []);
      freshEvents.push(...events);
      // Merge embedded relations into metadata — this is the key fix
      if (payload.relations) mergeRelations(payload.relations);
    }
    if (hasData) {
      psycleEvents = freshEvents;
    }
    buildMetaMaps(); // Rebuild maps with all merged metadata
    
    // Cache events + metadata for smart TTL (only if we got fresh data)
    if (hasData) {
      try {
        await cacheSet(CACHE_KEY_EVENTS, psycleEvents);
        await cacheSet(CACHE_KEY_META, {
          locations: metadata.locations,
          studios: metadata.studios,
          instructors: metadata.instructors,
          eventTypes: metadata.eventTypes
        });
        localStorage.setItem(CACHE_KEY_TIME, String(Date.now()));
      } catch (e) {
        console.warn('[Timetable] Failed to cache events:', e);
      }
    }
    
    isPrefetching = false;
    renderTimetableGrid();
  } catch (err) {
    isPrefetching = false;
    prefetchError = err.message;
    console.error('[Timetable] Prefetch failed:', err);

    // Try to re-hydrate from IDB cache before showing error
    try {
      const cachedEvents = await cacheGet(CACHE_KEY_EVENTS);
      const cachedMeta = await cacheGet(CACHE_KEY_META);
      if (cachedEvents && cachedEvents.length > 0) {
        psycleEvents = cachedEvents;
        if (cachedMeta) {
          if (cachedMeta.locations?.length) metadata.locations = cachedMeta.locations;
          if (cachedMeta.studios?.length) metadata.studios = cachedMeta.studios;
          if (cachedMeta.instructors?.length) metadata.instructors = cachedMeta.instructors;
          if (cachedMeta.eventTypes?.length) metadata.eventTypes = cachedMeta.eventTypes;
        }
        buildMetaMaps();
        renderTimetableGrid();
        return;
      }
    } catch (cacheErr) {
      console.warn('[Timetable] Cache re-hydration failed:', cacheErr);
    }

    // Only show error if there's genuinely no cached data
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

// Generate the dropdown filter option checklists
// activeIds: { locationIds, instructorIds, classTypeIds } — each a Set of IDs from interdependently-filtered events
function setupDropdownFilters({ locationIds, instructorIds, classTypeIds } = {}) {
  const container = document.getElementById('psycle-timetable-filters-container');
  if (!container) return;

  const locationsToRender = (!locationIds || locationIds.size === 0)
    ? metadata.locations
    : metadata.locations.filter(l => locationIds.has(Number(l.id)));

  // Instructors filtered to timetable data, sorted alphabetically
  const instructorPool = (!instructorIds || instructorIds.size === 0)
    ? metadata.instructors
    : metadata.instructors.filter(i => instructorIds.has(Number(i.id)));
  const instructorsToRender = [...instructorPool].sort((a, b) => {
    const nameA = (a.full_name || a.name || '').toLowerCase();
    const nameB = (b.full_name || b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const eventTypesToRender = (!classTypeIds || classTypeIds.size === 0)
    ? metadata.eventTypes
    : metadata.eventTypes.filter(t => classTypeIds.has(Number(t.id)));

  populateOptionsList('psycle-ms-location', locationsToRender, selectedLocations, 'location');
  populateOptionsList('psycle-ms-instructor', instructorsToRender, selectedInstructors, 'instructor', 'full_name');

  // Event Type groups (Ride, Strength, etc.)
  const eventTypeGroups = Array.from(new Set(eventTypesToRender.map(t => t.group ? JSON.stringify({ id: t.group.id, name: t.group.name }) : null)))
    .filter(Boolean)
    .map(str => JSON.parse(str))
    .sort((a, b) => a.name.localeCompare(b.name));

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
      list.querySelectorAll('.psycle-ms-option-label').forEach(label => {
        const text = label.querySelector('span')?.textContent?.toLowerCase() || '';
        label.style.display = text.includes(q) ? '' : 'none';
      });
    };
  }

  list.innerHTML = '';
  items.forEach(item => {
    let labelText = (item[labelField] || item.name || `${item.first_name || ''} ${item.last_name || ''}`).trim();
    // === MOBILE TIMETABLE — strip "Psycle " prefix from location dropdown options (delete to revert) ===
    if (dropdownId === 'psycle-ms-location') {
      labelText = labelText.replace(/^Psycle\s*/i, '');
    }
    // === END MOBILE TIMETABLE BLOCK ===
    const isChecked = selectedArray.includes(String(item.id));
    const label = document.createElement('label');
    label.className = 'psycle-ms-option-label';
    label.innerHTML = `
      <input type="checkbox" class="psycle-ms-checkbox" data-type="${type}" data-id="${item.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
      <span>${labelText}</span>
    `;
    list.appendChild(label);
  });
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
    if (dropdownId === 'psycle-ms-location') {
      const loc = metadata.locations.find(l => String(l.id) === selectedArray[0]);
      if (loc) name = loc.name.replace(/^Psycle\s*/i, '');
    } else if (dropdownId === 'psycle-ms-instructor') {
      const instr = metadata.instructors.find(i => String(i.id) === selectedArray[0]);
      if (instr) name = instr.full_name || instr.name;
    } else if (dropdownId === 'psycle-ms-class-type') {
      // Look up group name
      const group = metadata.eventTypes.find(t => t.group && String(t.group.id) === selectedArray[0])?.group;
      if (group) name = group.name;
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

      if (type === 'location') {
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

        if (idAttr === 'psycle-ms-location') {
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
      selectedLocations = [];
      selectedInstructors = [];
      selectedEventTypes = [];
      showBookmarksOnly = false;
      
      container.querySelectorAll('.psycle-ms-checkbox').forEach(c => c.checked = false);
      
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
        locations: selectedLocations,
        instructors: selectedInstructors,
        eventTypes: selectedEventTypes,
        showBookmarksOnly: showBookmarksOnly
      };

      const originalText = saveDefaultFiltersBtn.innerHTML;
      saveDefaultFiltersBtn.style.cursor = 'not-allowed';
      saveDefaultFiltersBtn.innerHTML = `Saving...`;

      try {
        localStorage.setItem('psycleDefaultFilters', JSON.stringify(defaultFilters));
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
async function renderTimetableGrid() {
  const ttGrid = document.getElementById('psycle-timetable-grid');
  if (!ttGrid) return;

  // Compute interdependent dropdown options: each filter shows only values present in events
  // that match ALL OTHER active filters (but not the filter for that dropdown itself).
  const now = new Date();
  const futureEvents = psycleEvents.filter(e => new Date(e.start_at) >= now);

  function eventsExcluding(excludeFilter) {
    return futureEvents.filter(e => {
      if (excludeFilter !== 'location' && selectedLocations.length > 0) {
        const studioObj = e.studio || studioObjMap.get(e.studio_id);
        const locId = String(studioObj?.location_id || studioObj?.location?.id || e.location_id || '');
        if (!locId || !selectedLocations.includes(locId)) return false;
      }
      if (excludeFilter !== 'instructor' && selectedInstructors.length > 0 && !selectedInstructors.includes(String(e.instructor_id))) return false;
      if (excludeFilter !== 'class-type' && selectedEventTypes.length > 0) {
        const et = metadata.eventTypes.find(t => t.id === e.event_type_id);
        const etGroupId = et?.group?.id != null ? String(et.group.id) : null;
        if (!etGroupId || !selectedEventTypes.includes(etGroupId)) return false;
      }
      return true;
    });
  }

  const locationIds = new Set(eventsExcluding('location').map(e => {
    const studio = metadata.studios.find(s => s.id === e.studio_id);
    return studio ? studio.location_id : null;
  }).filter(Boolean));
  const instructorIds = new Set(eventsExcluding('instructor').map(e => e.instructor_id).filter(Boolean));
  const classTypeIds = new Set(eventsExcluding('class-type').map(e => e.event_type_id).filter(Boolean));

  setupDropdownFilters({ locationIds, instructorIds, classTypeIds });

  // === MOBILE TIMETABLE — inject filter hamburger (added Jun 2026; part of mobile block) ===
  if (window.matchMedia('(max-width: 768px)').matches) {
    injectMobileFilterHamburger();
  }
  // === END MOBILE TIMETABLE BLOCK ===

  // Load auto bookings to check Scheduled indicator
  let autoBookedIds = new Set();
  try {
    const autoBookings = await api.getAutoBookings();
    autoBookedIds = new Set((autoBookings.data || autoBookings || []).map(x => x.eventId));
  } catch (err) {
    console.warn('[Timetable] Failed to fetch auto bookings for scheduling synchronization:', err.message);
  }

  // 1. Filter events by selected dropdown metadata arrays
  const filteredEvents = psycleEvents.filter(e => {
    // Filter out past classes
    if (new Date(e.start_at) < new Date()) return false;

    // Filter by Location
    if (selectedLocations.length > 0) {
      const studioObj = e.studio || studioObjMap.get(e.studio_id);
      const locId = String(studioObj?.location_id || studioObj?.location?.id || e.location_id || '');
      if (!locId || !selectedLocations.includes(locId)) return false;
    }
    // Filter by Instructor
    if (selectedInstructors.length > 0 && !selectedInstructors.includes(String(e.instructor_id))) return false;
    // Filter by Class Type Group ID
    if (selectedEventTypes.length > 0) {
      const groupId = e.event_type?.group?.id != null
        ? String(e.event_type.group.id)
        : String(eventTypeGroupMap.get(e.event_type_id) ? '' : ''); // use group map below
      const et = metadata.eventTypes.find(t => t.id === e.event_type_id);
      const etGroupId = et?.group?.id != null ? String(et.group.id) : null;
      if (!etGroupId || !selectedEventTypes.includes(etGroupId)) return false;
    }
    // Filter by Bookmarked Only
    if (showBookmarksOnly) {
      const identifier = generateBookmarkIdentifier(e);
      const bookmarks = cache.profile?.metafields?.public?.bookmarks?.events || [];
      if (!bookmarks.includes(identifier)) return false;
    }
    return true;
  });

  // 2. Sort remaining filtered events chronologically
  const sortedEvents = [...filteredEvents].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // 3. Extract unique dates containing matching events
  const daysWithEvents = Array.from(new Set(sortedEvents.map(e => e.start_at.split('T')[0]))).sort();

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

  // 6. Render the Class Timetable Grid Table
  if (!selectedTimetableDate) {
    ttGrid.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); padding: 40px; font-style: italic;">
        No classes match the current filters. Clear filters to see more.
      </div>
    `;
    return;
  }

  const finalEvents = sortedEvents.filter(e => e.start_at.startsWith(selectedTimetableDate));

  // Remove any body-appended mobile menus from the previous render
  document.querySelectorAll('body > .psycle-mobile-menu').forEach(m => m.remove());

  // The outer #psycle-timetable-grid (.psycle-timetable-list) is the single scroll
  // container — see initTimetableTab for the pull-to-refresh wiring. The inner
  // container must NOT scroll, otherwise iOS has two nested scrollers and the
  // outer grid's scrollTop stays 0 (breaking the at-top check for pull-to-refresh).
  ttGrid.innerHTML = `
    <div class="psycle-table-container">
      <table class="psycle-table" style="width: 100%; border-collapse: collapse; text-align: left; table-layout: fixed;">
        <thead>
          <tr>
            <th style="width: 8%;">Time</th>
            <th style="width: 36%;">Class</th>
            <th style="width: 11%;">Instructor</th>
            <th style="width: 16%;">Location / Studio</th>
            <th style="width: 13%;">Status</th>
            <th style="width: 16%; text-align: center;">Actions</th>
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
    const studioObj = event.studio || studioObjMap.get(event.studio_id);
    const studioName = studioObj?.name || studioMap.get(event.studio_id) || 'Studio';
    const locName = studioObj?.location?.name
      || locationMap.get(studioObj?.location_id)
      || locationMap.get(event.location_id)
      || 'Location';
    const instrName = event.instructor?.full_name || event.instructor?.name
      || instructorMap.get(event.instructor_id) || 'Instructor';
    const eventTypeName = event.event_type?.name || eventTypeMap.get(event.event_type_id) || 'Class';
    const className = event.name || eventTypeName;
    // Group name is the short type label (e.g., "Ride", "Barre", "Yoga")
    const groupName = event.event_type?.group?.name
      || eventTypeGroupMap.get(event.event_type_id)
      || 'Class';
    // Strip "TYPE: " prefix from class name (e.g., "RIDE: Signature 45" → "Signature 45")
    // Use groupName since eventTypeName is the full class name, not just the type
    const typePrefix = groupName.toUpperCase() + ': ';
    const strippedClassName = className.toUpperCase().startsWith(typePrefix)
      ? className.substring(typePrefix.length)
      : className;

    const startDate = new Date(event.start_at);
    const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

    // Cutoff status calculation (London timezone)
    const classRelease = getClassReleaseTime(event.start_at, userSettings);
    const now = DateTime.now().setZone('Europe/London');
    const isLive = event.is_always_bookable ? true : (now >= classRelease);
    const isFullyBooked = !!event.is_fully_booked;
    const canWaitlist = event.is_waitlistable !== false && event.waitlist_available !== false && !event.is_waitlist_full;

    const isBooked = userBookings.some(b => b.event_id === event.id || b.event?.id === event.id);
    const isOnWaitlist = userWaitlists.some(w => w.event_id === event.id || w.event?.id === event.id);

    const availableSpots = (typeof event.capacity === 'number' && typeof event.occupancy === 'number')
      ? Math.max(0, event.capacity - event.occupancy)
      : null;
    const spotsText = availableSpots !== null ? `${availableSpots} / ${event.capacity}` : 'Open';

    const identifier = generateBookmarkIdentifier(event);
    const bookmarks = cache.profile?.metafields?.public?.bookmarks?.events || [];
    const isBookmarked = bookmarks.includes(identifier);
    const heartChar = isBookmarked ? '♥' : '♡';
    const heartClass = isBookmarked ? 'psycle-timetable-heart bookmarked' : 'psycle-timetable-heart unbookmarked';

    let statusBadge = '';
    let actionBtn = '';
    let rowClass = 'psycle-table-row';

    if (!isLive) {
      rowClass = 'psycle-table-row row-beyond-cutoff';
      statusBadge = `<span class="badge-pill not-live psycle-occupancy-hover" data-id="${event.id}">Not Live</span>`;
      actionBtn = getSplitButtonHtml(event.id, true, autoBookedIds.has(event.id));
    } else {
      if (isBooked) {
        const eventBookings = userBookings.filter(b => b.event_id === event.id || b.event?.id === event.id);
        const slotsBookedCount = eventBookings.length;
        statusBadge = `<span class="badge-pill yes psycle-occupancy-hover" data-id="${event.id}" style="cursor: pointer;">Booked${slotsBookedCount > 1 ? ` (${slotsBookedCount})` : ''}</span>`;

        if (slotsBookedCount === 1) {
          const booking = eventBookings[0];
          const diffMs = startDate - new Date();
          const diffHours = diffMs / (1000 * 60 * 60);
          const closePenalty = diffHours < 12 && diffHours > 0;
          const mediumPenalty = diffHours < 24 && diffHours >= 12;

          const cancelVariant = closePenalty ? 'variant-danger-strong' : mediumPenalty ? 'variant-warning' : 'variant-danger';
          actionBtn = `<button class="psycle-btn-mini psycle-timetable-cancel-booking-btn ${cancelVariant}" data-booking-id="${booking.id}" data-penalty="${closePenalty}">Cancel</button>`;
        } else {
          actionBtn = `<button class="psycle-btn-mini psycle-btn-manage-bookings variant-autoupgrade" onclick="window.switchTab('my-bookings')">Manage</button>`;
        }
      } else if (isOnWaitlist) {
        statusBadge = `<span class="badge-pill no psycle-occupancy-hover" data-id="${event.id}" style="cursor: pointer;">Waitlisted</span>`;

        // Find waitlist ID to leave it
        const waitlistEntry = userWaitlists.find(w => w.event_id === event.id || w.event?.id === event.id);
        if (waitlistEntry) {
          actionBtn = `<button class="psycle-btn-mini psycle-timetable-leave-waitlist-btn variant-danger" data-waitlist-id="${waitlistEntry.id}">Leave WL</button>`;
        } else {
          actionBtn = `<button class="psycle-btn-mini" disabled>On Waitlist</button>`;
        }
      } else if (isFullyBooked) {
        if (canWaitlist) {
          statusBadge = `<span class="badge-pill no psycle-occupancy-hover" data-id="${event.id}" style="cursor: pointer;">Waitlisted</span>`;
          actionBtn = `<button class="psycle-btn-mini psycle-timetable-waitlist-btn variant-warning-solid" data-id="${event.id}">Join Waitlist</button>`;
        } else {
          statusBadge = `<span class="badge-pill no fully-booked psycle-occupancy-hover" data-id="${event.id}">Fully Booked</span>`;
          actionBtn = `<button class="psycle-btn-mini" disabled>Full</button>`;
        }
      } else {
        const hasCredit = hasUsableCredit(event);
        if (!hasCredit) {
          statusBadge = `<span class="badge-pill yes psycle-occupancy-hover" data-id="${event.id}" style="cursor: pointer;">${spotsText}</span><div style="color:var(--danger); font-size:12px; font-weight:600; margin-top:3px; white-space:nowrap;">No eligible credits</div>`;
          actionBtn = `<button class="psycle-btn-mini variant-danger" onclick="window.switchTab('buy-credits')">Buy Credits</button>`;
        } else {
          statusBadge = `<span class="badge-pill yes psycle-occupancy-hover" data-id="${event.id}" style="cursor: pointer;">${spotsText}</span>`;
          actionBtn = `
            <div style="display: flex; gap: 4px; align-items: center;">
              <button class="psycle-btn-mini psycle-timetable-book-btn variant-success" data-id="${event.id}">Book</button>
              ${getSplitButtonHtml(event.id, false, false)}
            </div>
          `;
        }
      }
    }

    const debugBtnHtml = userSettings.debugMode
      ? `<button class="psycle-btn-mini psycle-debug-btn variant-debug" data-event-id="${event.id}">Debug</button>`
      : '';

    // === MOBILE TIMETABLE — PWA MOBILE LAYOUT (added Jun 2026; delete this block to revert) ===
    if (window.matchMedia('(max-width: 768px)').matches) {
      tbody.appendChild(buildMobileClassRow(event, {
        timeStr, groupName, strippedClassName, instrName, locName, studioName,
        isLive, isBooked, isOnWaitlist, isFullyBooked, canWaitlist, spotsText,
        isBookmarked, heartChar, heartClass, rowClass
      }));
      return; // skip desktop rendering for this row
    }
    // === END MOBILE TIMETABLE BLOCK ===

    const row = document.createElement('tr');
    row.className = rowClass;
    row.innerHTML = `
      <td class="col-time"><strong>${timeStr}</strong></td>
      <td class="col-class">
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; overflow: hidden;">
          <span class="${heartClass}" data-event-id="${event.id}" title="${isBookmarked ? 'Remove Bookmark' : 'Bookmark Class'}" style="flex-shrink:0;">${heartChar}</span>
          <span class="psycle-class-type-chip">${groupName}</span>
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${strippedClassName}</span>
        </div>
      </td>
      <td class="col-instructor"><span class="psycle-instructor-hover" data-id="${event.instructor_id}">${instrName}</span></td>
      <td class="col-location">
        <span style="font-weight:600; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${locName.replace(/^Psycle\s*/i, '')}</span>
        <span style="font-size:12px; color:var(--text-secondary); display:block; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${studioName}</span>
      </td>
      <td class="col-status">${statusBadge}</td>
      <td class="col-actions">
        <div style="display:flex; align-items:center; justify-content:center; gap:4px;">
          ${actionBtn}
          ${debugBtnHtml}
        </div>
      </td>
    `;

    // Heart click listener
    row.querySelector('.psycle-timetable-heart').onclick = (e) => {
      e.stopPropagation();
      toggleNativeBookmark(event, e.target);
    };

    // Direct book click listener
    const splitMainBtn = row.querySelector('.psycle-split-main-btn');
    if (splitMainBtn) {
      splitMainBtn.onclick = async (e) => {
        e.stopPropagation();
        const type = splitMainBtn.getAttribute('data-type');
        if (type === 'quickbook') {
          if (isWithin12Hours(event.start_at) && splitMainBtn.dataset.confirmState !== 'confirm') {
            splitMainBtn.dataset.confirmState = 'confirm';
            const origHtml = splitMainBtn.innerHTML;
            splitMainBtn.innerHTML = 'Class starts soon. Confirm?';
            splitMainBtn.style.background = 'var(--warning)';
            setTimeout(() => {
              if (splitMainBtn.dataset.confirmState === 'confirm') {
                delete splitMainBtn.dataset.confirmState;
                splitMainBtn.innerHTML = origHtml;
                splitMainBtn.style.background = '';
              }
            }, 4000);
            return;
          }
          delete splitMainBtn.dataset.confirmState;
          // Get studio preferences from settings
          try {
            const studioPrefs = await api.getStudioPreferences();
            const studioId = event.studio_id;
            const prefs = studioPrefs[studioId] || {};

            // If no studio prefs exist, open modal to set them first
            if (!prefs.preferredSlots || prefs.preferredSlots.length === 0) {
              if (!prefs.preferredRows || prefs.preferredRows.length === 0) {
                openBookingModal(event, 'quickbook');
                return;
              }
            }

            quickBookClass(event.id, {
              preferredSlots: prefs.preferredSlots || [],
              preferredRows: prefs.preferredRows || [],
              requiredCount: 1,
              bookAny: true
            }, splitMainBtn);
          } catch (err) {
            // On error getting prefs, open modal to let user set them
            openBookingModal(event, 'quickbook');
          }
        } else if (type === 'autobook') {
          if (splitMainBtn.classList.contains('scheduled')) {
            // Unschedule auto-book directly
            try {
              showToast('Removing scheduled booking...', 'info');
              const autoBookings = await api.getAutoBookings();
              const existing = (autoBookings.data || autoBookings || []).find(x => x.eventId === event.id);
              if (existing) {
                await api.deleteAutoBooking(existing.id);
                showToast('Scheduled auto-book cancelled.', 'info');
                renderTimetableGrid();
              }
            } catch (err) {
              showToast(`Error: ${err.message}`, 'error');
            }
          } else {
            // One-click setup: if prefs exist, register auto-book directly; else open modal
            try {
              const studioPrefs = await api.getStudioPreferences();
              const studioId = event.studio_id;
              const prefs = studioPrefs[studioId] || {};

              if (prefs.preferredSlots?.length > 0 || prefs.preferredRows?.length > 0) {
                // Prefs exist — quick-register auto-book
                saveAutoBookPreferences(event, prefs.preferredSlots || [], prefs.preferredRows || [], 1, true, () => {});
              } else {
                // No prefs — open modal to set them first
                openBookingModal(event, 'autobook');
              }
            } catch (err) {
              openBookingModal(event, 'autobook');
            }
          }
        }
      };
    }

    // Split toggle ⚙ click → open config modal
    const splitToggleBtn = row.querySelector('.psycle-split-context-toggle');
    if (splitToggleBtn) {
      splitToggleBtn.onclick = (e) => {
        e.stopPropagation();
        const type = splitToggleBtn.getAttribute('data-type');
        const mode = type === 'autobook' ? 'autobook' : 'quickbook';
        openBookingModal(event, mode);
      };
    }

    // Split dropdown item click handlers
    const dropdownEl = row.querySelector('.psycle-split-dropdown');
    if (dropdownEl) {
      dropdownEl.onclick = async (e) => {
        e.stopPropagation();
        const item = e.target.closest('.psycle-split-dropdown-item');
        if (!item) return;
        const action = item.getAttribute('data-action');
        const eid = item.getAttribute('data-id');

        // Close the dropdown
        dropdownEl.style.display = 'none';

        if (action === 'quickbook') {
          try {
            const studioPrefs = await api.getStudioPreferences();
            const studioId = event.studio_id;
            const prefs = studioPrefs[studioId] || {};
            quickBookClass(event.id, {
              preferredSlots: prefs.preferredSlots || [],
              preferredRows: prefs.preferredRows || [],
              requiredCount: 1,
              bookAny: true
            }, null);
          } catch (err) {
            quickBookClass(event.id, { preferredSlots: [], preferredRows: [], requiredCount: 1, bookAny: true }, null);
          }
        } else if (action === 'autobook') {
          try {
            const studioPrefs = await api.getStudioPreferences();
            const studioId = event.studio_id;
            const prefs = studioPrefs[studioId] || {};
            saveAutoBookPreferences(event, prefs.preferredSlots || [], prefs.preferredRows || [], 1, true, () => {});
          } catch (err) {
            saveAutoBookPreferences(event, [], [], 1, true, () => {});
          }
        } else if (action === 'waitlist') {
          item.disabled = true;
          item.textContent = 'Joining...';
          try {
            await api.proxyPut(`/waitlists/${eid}`);
            showToast('Successfully joined waitlist!', 'success');
            await refreshUserData();
            renderTimetableGrid();
          } catch (err) {
            showToast(`Waitlist failed: ${err.message}`, 'error');
            item.disabled = false;
            item.textContent = 'Waitlist';
          }
        }
      };
    }

    // Book button click → open booking modal (spot selection)
    const bookBtn = row.querySelector('.psycle-timetable-book-btn');
    if (bookBtn) {
      bookBtn.onclick = (e) => {
        e.stopPropagation();
        openBookingModal(event, 'book');
      };
    }

    // Cancel Booking click listener
    const cancelBtn = row.querySelector('.psycle-timetable-cancel-booking-btn');
    if (cancelBtn) {
      cancelBtn.onclick = (e) => {
        e.stopPropagation();
        const bookingId = cancelBtn.getAttribute('data-booking-id');
        const isPenalty = cancelBtn.getAttribute('data-penalty') === 'true';
        cancelBookingDirect(bookingId, isPenalty, cancelBtn);
      };
    }

    // Leave Waitlist click listener
    const leaveWlBtn = row.querySelector('.psycle-timetable-leave-waitlist-btn');
    if (leaveWlBtn) {
      leaveWlBtn.onclick = async (e) => {
        e.stopPropagation();
        const waitlistId = leaveWlBtn.getAttribute('data-waitlist-id');
        leaveWlBtn.disabled = true;
        leaveWlBtn.innerHTML = 'Leaving...';
        try {
          await api.proxyDelete(`/waitlists/${waitlistId}`);
          showToast('Left waitlist successfully!', 'success');
          await refreshUserData();
          renderTimetableGrid();
        } catch (err) {
          showToast(`Error leaving waitlist: ${err.message}`, 'error');
          leaveWlBtn.disabled = false;
          leaveWlBtn.innerHTML = 'Leave WL';
        }
      };
    }

    // Waitlist Join click listener
    const wlBtn = row.querySelector('.psycle-timetable-waitlist-btn');
    if (wlBtn) {
      wlBtn.onclick = async (e) => {
        e.stopPropagation();
        wlBtn.disabled = true;
        wlBtn.innerHTML = 'Joining...';
        try {
          await api.proxyPut(`/waitlists/${event.id}`);
          showToast('Successfully joined waitlist!', 'success');
          prefetchTimetableData(true);
        } catch (err) {
          showToast(`Waitlist failed: ${err.message}`, 'error');
          wlBtn.disabled = false;
          wlBtn.innerHTML = 'Join Waitlist';
        }
      };
    }

    // Debug button click listener
    const debugBtn = row.querySelector('.psycle-debug-btn');
    if (debugBtn) {
      debugBtn.onclick = (e) => {
        e.stopPropagation();
        openDebugModal(event);
      };
    }

    tbody.appendChild(row);
  });

  // Close split dropdowns when clicking outside any split button group
  const closeSplitDropdowns = (e) => {
    if (!e.target.closest('.psycle-split-btn-group')) {
      document.querySelectorAll('.psycle-split-dropdown').forEach(d => d.style.display = 'none');
    }
  };
  document.removeEventListener('click', closeSplitDropdowns);
  document.addEventListener('click', closeSplitDropdowns);
}

// === MOBILE TIMETABLE — injectMobileFilterHamburger (added Jun 2026; delete this block to revert) ===
function injectMobileFilterHamburger() {
  if (document.getElementById('psycle-mobile-filter-hamburger')) return;

  const filtersRow = document.querySelector('#psycle-timetable-filters-container .psycle-filters-row');
  if (!filtersRow) return;

  const hamburger = document.createElement('button');
  hamburger.id = 'psycle-mobile-filter-hamburger';
  hamburger.className = 'psycle-mobile-hamburger';
  hamburger.innerHTML = '&#9776;';
  hamburger.style.flexShrink = '0';

  const menu = document.createElement('div');
  menu.className = 'psycle-mobile-menu';
  menu.style.display = 'none';

  const favBtn = document.getElementById('psycle-filter-favorites-only');
  const clearBtn = document.getElementById('psycle-btn-clear-all-filters');
  const saveBtn = document.getElementById('psycle-btn-save-default-filters');

  const items = [];
  if (favBtn) {
    items.push({
      label: () => showBookmarksOnly ? '\u2665 Bookmarked (on)' : '\u2661 Bookmarked',
      variant: 'favourite',
      action: () => favBtn.click()
    });
  }
  if (clearBtn) {
    items.push({ label: () => 'Clear Filters', variant: 'danger', action: () => clearBtn.click() });
  }
  if (saveBtn) {
    items.push({ label: () => 'Save Defaults', variant: 'success', action: () => saveBtn.click() });
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'psycle-mobile-menu-item';
    div.textContent = item.label();
    if (item.variant) div.setAttribute('data-variant', item.variant);
    div.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      item.action();
    };
    menu.appendChild(div);
  });

  filtersRow.appendChild(hamburger);
  document.body.appendChild(menu);

  hamburger.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = menu.style.display === 'block';
    document.querySelectorAll('.psycle-mobile-menu').forEach(m => {
      if (m !== menu) m.style.display = 'none';
    });
    if (!wasOpen) {
      // Refresh labels (bookmark state may have changed)
      const itemEls = menu.querySelectorAll('.psycle-mobile-menu-item');
      items.forEach((item, i) => {
        if (itemEls[i]) itemEls[i].textContent = item.label();
      });
      const rect = hamburger.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
      menu.style.left = 'auto';
      menu.style.display = 'block';
      const closeMenu = (ev) => {
        if (!menu.contains(ev.target) && !hamburger.contains(ev.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', closeMenu);
          window.removeEventListener('scroll', closeMenu, true);
          window.removeEventListener('resize', closeMenu);
        }
      };
      setTimeout(() => {
        document.addEventListener('click', closeMenu);
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('resize', closeMenu);
      }, 0);
    }
  };
}
// === END MOBILE TIMETABLE BLOCK ===

// === MOBILE TIMETABLE — buildMobileClassRow (added Jun 2026; delete this block to revert) ===
function buildMobileClassRow(event, ctx) {
  const {
    timeStr, groupName, strippedClassName, instrName, locName,
    isLive, isBooked, isOnWaitlist, isFullyBooked, canWaitlist,
    spotsText, isBookmarked, heartChar, heartClass, rowClass
  } = ctx;

  const tr = document.createElement('tr');
  tr.className = `psycle-mobile-row ${rowClass || ''}`;

  const td = document.createElement('td');
  td.colSpan = 6;

  const card = document.createElement('div');
  card.className = 'psycle-mobile-class-card';

  const displayLoc = locName.replace(/^Psycle\s*/i, '');

  let bookingId = null;
  let isPenalty = false;
  if (isBooked) {
    const eventBookings = userBookings.filter(b => b.event_id === event.id || b.event?.id === event.id);
    if (eventBookings.length === 1) {
      bookingId = eventBookings[0].id;
      const diffMs = new Date(event.start_at) - new Date();
      const diffHours = diffMs / (1000 * 60 * 60);
      isPenalty = diffHours < 12 && diffHours > 0;
    }
  }

  let waitlistId = null;
  if (isOnWaitlist) {
    const entry = userWaitlists.find(w => w.event_id === event.id || w.event?.id === event.id);
    if (entry) waitlistId = entry.id;
  }

  const hasCredit = hasUsableCredit(event);

  let primaryBtnHtml = '';
  let primaryAction = null;

  if (!isLive) {
    primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn variant-autoupgrade">Auto book</button>`;
    primaryAction = () => openBookingModal(event, 'autobook');
  } else if (isBooked) {
    const eventBookings = userBookings.filter(b => b.event_id === event.id || b.event?.id === event.id);
    if (eventBookings.length === 1) {
      const cancelVariant = isPenalty ? 'variant-danger-strong' : 'variant-danger';
      primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn ${cancelVariant}" data-booking-id="${bookingId}" data-penalty="${isPenalty}">Cancel</button>`;
      primaryAction = (btn) => cancelBookingDirect(bookingId, isPenalty, btn);
    } else {
      primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn variant-autoupgrade" onclick="window.switchTab('my-bookings')">Manage</button>`;
    }
  } else if (isOnWaitlist) {
    if (waitlistId) {
      primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn variant-danger" data-waitlist-id="${waitlistId}">Leave WL</button>`;
      primaryAction = async (btn) => {
        btn.disabled = true;
        btn.textContent = 'Leaving...';
        try {
          await api.proxyDelete(`/waitlists/${waitlistId}`);
          showToast('Left waitlist successfully!', 'success');
          await refreshUserData();
          renderTimetableGrid();
        } catch (err) {
          showToast(`Error leaving waitlist: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = 'Leave WL';
        }
      };
    } else {
      primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn" disabled>On Waitlist</button>`;
    }
  } else if (isFullyBooked) {
    if (canWaitlist) {
      primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn psycle-timetable-waitlist-btn variant-warning-solid" data-id="${event.id}">Join Waitlist</button>`;
      primaryAction = async (btn) => {
        btn.disabled = true;
        btn.textContent = 'Joining...';
        try {
          await api.proxyPut(`/waitlists/${event.id}`);
          showToast('Successfully joined waitlist!', 'success');
          prefetchTimetableData(true);
        } catch (err) {
          showToast(`Waitlist failed: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = 'Join Waitlist';
        }
      };
    } else {
      primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn" disabled>Full</button>`;
    }
  } else if (!hasCredit) {
    primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn variant-danger" onclick="window.switchTab('buy-credits')">Buy Credits</button>`;
  } else {
    primaryBtnHtml = `<button class="psycle-btn-mini psycle-mobile-primary-btn psycle-timetable-book-btn variant-success" data-id="${event.id}">Quick Book</button>`;
    primaryAction = async (btn) => {
      if (isWithin12Hours(event.start_at) && btn.dataset.confirmState !== 'confirm') {
        btn.dataset.confirmState = 'confirm';
        const origText = btn.textContent;
        btn.textContent = 'Confirm?';
        btn.style.background = 'var(--warning)';
        setTimeout(() => {
          if (btn.dataset.confirmState === 'confirm') {
            delete btn.dataset.confirmState;
            btn.textContent = origText;
            btn.style.background = '';
          }
        }, 4000);
        return;
      }
      delete btn.dataset.confirmState;
      try {
        const studioPrefs = await api.getStudioPreferences();
        const studioId = event.studio_id;
        const prefs = studioPrefs[studioId] || {};
        if ((!prefs.preferredSlots || prefs.preferredSlots.length === 0) && (!prefs.preferredRows || prefs.preferredRows.length === 0)) {
          openBookingModal(event, 'quickbook');
          return;
        }
        quickBookClass(event.id, {
          preferredSlots: prefs.preferredSlots || [],
          preferredRows: prefs.preferredRows || [],
          requiredCount: 1,
          bookAny: true
        }, btn);
      } catch (err) {
        openBookingModal(event, 'quickbook');
      }
    };
  }

  const heartEl = document.createElement('span');
  heartEl.className = heartClass;
  heartEl.textContent = heartChar;
  heartEl.style.display = 'none';

  card.innerHTML = `
    <div class="psycle-mobile-content">
      <div class="psycle-mobile-top-line">
        <strong>${timeStr}</strong>
        <span class="psycle-class-type-chip">${groupName}</span>
        <span class="psycle-mobile-instructor">${instrName}</span>
      </div>
      <div class="psycle-mobile-bottom-line">
        <span class="psycle-mobile-class-name">${strippedClassName}</span>
        <span class="psycle-mobile-dot">&middot;</span>
        <span class="psycle-mobile-location">${displayLoc}</span>
      </div>
    </div>
    <div class="psycle-mobile-actions">
      ${primaryBtnHtml}
      <button class="psycle-mobile-hamburger">&#9776;</button>
    </div>
  `;

  card.appendChild(heartEl);

  const menu = document.createElement('div');
  menu.className = 'psycle-mobile-menu';
  menu.style.display = 'none';

  const menuItems = [];
  if (isLive && !isBooked && !isOnWaitlist && !isFullyBooked && hasCredit) {
    menuItems.push({ label: 'Book', variant: 'book', action: () => openBookingModal(event, 'book') });
  }
  menuItems.push({
    label: isBookmarked ? 'Unfavourite' : 'Favourite',
    variant: 'favourite',
    action: () => toggleNativeBookmark(event, heartEl)
  });
  menuItems.push({ label: 'Studio Occupancy', variant: '', action: () => openOccupancyModal(event) });
  if (userSettings.debugMode) {
    menuItems.push({ label: 'Debug', variant: 'debug', action: () => openDebugModal(event) });
  }

  menuItems.forEach(item => {
    const div = document.createElement('div');
    div.className = 'psycle-mobile-menu-item';
    div.textContent = item.label;
    if (item.variant) div.setAttribute('data-variant', item.variant);
    div.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      item.action();
    };
    menu.appendChild(div);
  });

  // Append menu to body (not card) so position:fixed escapes the card's
  // backdrop-filter containing block and renders above sibling rows
  document.body.appendChild(menu);

  const hamburger = card.querySelector('.psycle-mobile-hamburger');
  if (hamburger) {
    hamburger.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = menu.style.display === 'block';
      document.querySelectorAll('.psycle-mobile-menu').forEach(m => {
        if (m !== menu) m.style.display = 'none';
      });
      if (!wasOpen) {
        const rect = hamburger.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        menu.style.left = 'auto';
        menu.style.display = 'block';
        const closeMenu = (ev) => {
          if (!menu.contains(ev.target) && !hamburger.contains(ev.target)) {
            menu.style.display = 'none';
            document.removeEventListener('click', closeMenu);
            window.removeEventListener('scroll', closeMenu, true);
            window.removeEventListener('resize', closeMenu);
          }
        };
        setTimeout(() => {
          document.addEventListener('click', closeMenu);
          window.addEventListener('scroll', closeMenu, true);
          window.addEventListener('resize', closeMenu);
        }, 0);
      }
    };
  }

  const primaryBtn = card.querySelector('.psycle-mobile-primary-btn');
  if (primaryBtn && primaryAction) {
    primaryBtn.onclick = (e) => {
      e.stopPropagation();
      primaryAction(primaryBtn);
    };
  }

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
    const res = await api.proxyGet(`/events/${event.id}`, { ttlMs: 120000 });
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

// Check if user has an unused credit that matches the event's accepted credit types
function hasUsableCredit(event) {
  return getAvailableCreditsForEvent(event) > 0;
}

function getAvailableCreditsForEvent(event) {
  if (!cache.profile || !cache.profile.available_credits) return 0;

  // Map event credit_types to numeric IDs
  // credit_types entries can be {credit_type: number} or {credit_type: {id: number}} or {id: number}
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

// Resilient bookmark ID generator
function generateBookmarkIdentifier(event) {
  if (!event) return '';
  const studioId = event.studio_id || (event.studio ? event.studio.id : null);
  if (!studioId || !event.start_at) return '';
  
  const dateObj = new Date(event.start_at);
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
    const url = `/profile/metafields/bookmarks.events.${identifier}`;
    if (isCurrentlyBookmarked) {
      await api.proxyDelete(url);
    } else {
      await api.proxyPut(url, { data: identifier });
    }
    
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

// Construct split buttons with dropdown menu
function getSplitButtonHtml(eventId, isNotLive, isScheduled) {
  const mainClass = isScheduled ? 'psycle-split-main-btn scheduled' : 'psycle-split-main-btn';
  const mainText = isNotLive ? (isScheduled ? 'Scheduled' : 'Auto book') : 'Quick Book';
  const type = isNotLive ? 'autobook' : 'quickbook';
  
  const event = psycleEvents.find(e => e.id === eventId);
  const studio = event ? metadata.studios.find(s => s.id === event.studio_id) : null;
  const hasSeatMap = studio && studio.layout && studio.layout.slots && studio.layout.slots.length > 0;
  
  if (!hasSeatMap) {
    const borderRightStyle = isScheduled ? '1px solid color-mix(in srgb, var(--feat-autoupgrade) 30%, transparent)' : 'none';
    return `
      <div class="psycle-split-btn-group" data-id="${eventId}" data-type="${type}" style="position:relative;">
        <button class="${mainClass}" data-id="${eventId}" data-type="${type}" style="border-radius: 6px !important; padding: 0 16px; border-right: ${borderRightStyle};">${mainText}</button>
      </div>
    `;
  }
  
  const contextClass = isScheduled ? 'psycle-split-context-btn scheduled' : 'psycle-split-context-btn';
  const dropdownItemsHtml = getDropdownItemsHtml(eventId, isNotLive);
  return `
    <div class="psycle-split-btn-group" data-id="${eventId}" data-type="${type}" style="position:relative;">
      <button class="${mainClass}" data-id="${eventId}" data-type="${type}">${mainText}</button>
      <button class="${contextClass} psycle-split-context-toggle" data-id="${eventId}" data-type="${type}">⚙</button>
      <div class="psycle-split-dropdown" data-id="${eventId}" style="display:none;">
        ${dropdownItemsHtml}
      </div>
    </div>
  `;
}

/** Generate dropdown items for the split button ⚙ menu */
function getDropdownItemsHtml(eventId, isNotLive) {
  let items = '';
  
  // Quick Book — only for live classes
  if (!isNotLive) {
    items += `<button class="psycle-split-dropdown-item" data-action="quickbook" data-id="${eventId}">Quick Book</button>`;
  }

  // Auto-Book — always available (schedule for release or upgrade)
  items += `<button class="psycle-split-dropdown-item" data-action="autobook" data-id="${eventId}">Auto-Book</button>`;

  // Waitlist — only for live classes
  if (!isNotLive) {
    items += `<button class="psycle-split-dropdown-item" data-action="waitlist" data-id="${eventId}">Waitlist</button>`;
  }
  
  return items;
}

// Perform instant booking using preferred seat priorities
async function quickBookClass(eventId, prefs, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `Booking...`;
  }

  const preferredSlots = prefs.preferredSlots || [];
  const preferredRows = prefs.preferredRows || [];
  const requiredCount = prefs.requiredCount || 1;
  const bookAny = prefs.bookAny !== false;

  try {
    const res = await api.proxyGet(`/events/${eventId}`, { ttlMs: 120000 });
    const eventData = res.data || res;
    if (!eventData) {
      showToast('Could not load class data.', 'error');
      return;
    }

    const studio = res.relations?.studios?.[0] || eventData.relations?.studios?.[0] || eventData.studio || {};
    const layoutSlots = studio?.layout?.slots || [];
    const liveAvailable = (res.slots || eventData.slots || []).map(id => Number(id));

    if (liveAvailable.length === 0) {
      showToast('Fully booked! Joining waitlist...', 'warning');
      try {
        await api.proxyPut(`/waitlists/${eventId}`);
        showToast('Joined waitlist successfully!', 'success');
        prefetchTimetableData(true);
      } catch (wlErr) {
        showToast(`Waitlist failed: ${wlErr.message}`, 'error');
      }
      return;
    }

    const primarySlots = preferredSlots.filter(id => liveAvailable.includes(Number(id)));

    let rowSlots = [];
    if (preferredRows && preferredRows.length > 0 && layoutSlots.length > 0) {
      preferredRows.forEach(ry => {
        const slotsInRow = layoutSlots.filter(s => Math.round(s.y * 10) / 10 === ry);
        const rowSlotIds = slotsInRow.map(s => Number(s.id));
        rowSlotIds.forEach(id => {
          if (liveAvailable.includes(id) && !primarySlots.includes(id) && !rowSlots.includes(id)) {
            rowSlots.push(id);
          }
        });
      });
    }

    const slotsToTry = [...primarySlots, ...rowSlots];
    const finalBookAny = layoutSlots.length === 0 || bookAny;

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
    while (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
      const targetSlot = slotsToTry[attemptIdx];
      try {
        const bookRes = await api.proxyPost('/bookings', {
          event_id: eventId,
          slots: [targetSlot]
        });
        bookedCount++;
        lastBookedSlot = targetSlot;
        lastBookingRes = bookRes;
        const ls = layoutSlots.find(s => Number(s.id) === Number(targetSlot));
        bookedSlotLabels.push(ls?.label ?? targetSlot);
        showToast(`Quick-booked spot ${ls?.label ?? targetSlot}! 🎉`, 'success');
      } catch (err) {
        console.error(`Quick book failed for slot ${targetSlot}:`, err.message);
      }
      attemptIdx++;
      if (bookedCount < requiredCount && attemptIdx < slotsToTry.length) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    if (bookedCount > 0) {
      const qbInstructor = res.relations?.instructors?.find(i => i.id === eventData.instructor_id)
        || res.relations?.instructors?.[0] || eventData.instructor;
      const qbEventType = res.relations?.event_types?.find(t => t.id === eventData.event_type_id)
        || res.relations?.event_types?.[0] || eventData.event_type;
      api.notifyBookingSuccess({
        source: 'quickbook', eventId,
        className: eventData.name || qbEventType?.name,
        groupName: qbEventType?.group?.name || '',
        instructorName: qbInstructor?.full_name || qbInstructor?.name || '',
        startAt: eventData.start_at, slots: bookedSlotLabels,
      }).catch(() => {});
      if (lastBookedSlot !== null) await tryAutoRegisterUpgrade(eventData, lastBookedSlot, lastBookingRes);
      await refreshUserData();
      renderTimetableGrid();
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

  title.textContent = isAutoBookMode ? 'Configure Auto-Book' : (isQuickBookMode ? 'Select a spot in the studio' : 'Select a spot in the studio');

  // Use cached layout if available — layouts don't change mid-session
  const cachedStudio = studioLayoutCache.get(c.studio_id)
    || studioObjMap.get(c.studio_id)
    || metadata.studios.find(s => s.id === c.studio_id);
  const hasLayout = cachedStudio?.layout?.slots?.length > 0;

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

  // Refresh credits when opening booking modal
  await refreshUserData();

  try {
    const res = await api.proxyGet(`/events/${c.id}`, { ttlMs: 120000 });
    const eventDetails = res.data || res;
    const studioFromEvent = res.relations?.studios?.[0] || eventDetails.relations?.studios?.[0] || eventDetails.studio || {};
    // Prefer cached layout (it may have been preloaded from /studios at startup)
    const studio = (hasLayout && cachedStudio.layout?.slots?.length >= (studioFromEvent.layout?.slots?.length || 0))
      ? { ...studioFromEvent, layout: cachedStudio.layout }
      : studioFromEvent;
    // Cache the layout for future opens (keyed by studio_id)
    if (studio?.layout?.slots?.length > 0) {
      studioLayoutCache.set(c.studio_id, { layout: studio.layout });
    }
    const layoutSlots = studio?.layout?.slots || [];
    const availableSlots = (res.slots || eventDetails.slots || []).map(Number);

    // Determine if booking window is already open
    const classReleaseTime = getClassReleaseTime(c.start_at);
    const isLive = classReleaseTime.toMillis() <= Date.now();

    const instrName = metadata.instructors.find(i => i.id === c.instructor_id)?.full_name || '';
    const eventType = metadata.eventTypes.find(t => t.id === c.event_type_id);
    const groupName = c.event_type?.group?.name || eventType?.group?.name || eventType?.name || 'Class';
    const startDate = new Date(c.start_at);
    const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const studioName = studio?.name || studioMap.get(c.studio_id) || 'this studio';

    if (isAutoBookMode) {
      title.textContent = `Auto-Book: ${timeStr} ${groupName}${instrName ? ' with ' + instrName : ''}`;
    } else if (isQuickBookMode) {
      title.textContent = `Configure Quick-Book for ${studioName}: ${timeStr} ${groupName}${instrName ? ' with ' + instrName : ''}`;
    } else {
      title.textContent = `Choose a spot for ${timeStr} ${groupName}${instrName ? ' with ' + instrName : ''}`;
    }

    if (layoutSlots.length === 0) {
      body.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-secondary);">
          <p style="margin-bottom: 16px;">No floor map layout available for this studio.</p>
          ${isAutoBookMode
            ? `<button class="psycle-btn" id="btn-save-simple-autobook" style="background: var(--feat-autoupgrade); color:var(--on-accent);">Schedule Auto-Book (Any Seat)</button>`
            : `<button class="psycle-btn" id="btn-book-any" style="background: var(--success); color:var(--on-accent);">Book Any Available Spot</button>`
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

    // Render Stage
    const layoutObjects = studio?.layout?.objects || [];
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
    const maxBookableSlots = Math.min(eventDetails.max_bookable_slots || availableSlots.length || 1, availableCredits);
    const state = {
      selectedSlots: [],    // ordered array of slot IDs (index 0 = priority 1)
      selectedRows: new Set(),
      qty: isAutoBookMode ? 1 : maxBookableSlots,  // simple/quick-book: allow selecting up to max available; auto-book: qty selector controls this
      bookAny: true
    };

    // Pre-populate from saved studio prefs (auto-book and quick-book modes)
    let hasExistingPrefs = false;
    if (isAutoBookMode || isQuickBookMode) {
      try {
        const studioPrefs = await api.getStudioPreferences();
        const prefs = studioPrefs[c.studio_id] || {};
        (prefs.preferredSlots || []).forEach(s => state.selectedSlots.push(Number(s)));
        (prefs.preferredRows || []).forEach(r => state.selectedRows.add(Number(r)));
        state.qty = prefs.requiredCount || 1;
        state.bookAny = prefs.bookAny !== false;
        hasExistingPrefs = (prefs.preferredSlots?.length > 0) || (prefs.preferredRows?.length > 0);
      } catch (e) {}
    }

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
        const label = slot.label || slot.slot || String(slotId);

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
              showToast('⚠ This spot is occupied or unavailable.', 'warning');
              return;
            }
            if (isAutoBookMode && !isAvailable) {
              showToast('⚠ Currently occupied — will be targeted when booking fires.', 'info');
            }
            // In quick-book: limit to qty; in auto-book: unlimited preferences
            const qtyLimit = isAutoBookMode ? Infinity : state.qty;
            if (state.selectedSlots.length < qtyLimit) {
              state.selectedSlots.push(slotId);
            } else {
              showToast(`You can select up to ${state.qty} spot${state.qty !== 1 ? 's' : ''}.`, 'info');
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
          return slot?.label || slot?.slot || String(id);
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
            <div style="display:flex;gap:14px;align-items:center;border-top:1px solid var(--separator);padding-top:12px;">
              <div style="width:110px;">
                <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Slots to book:</label>
                <select id="autobook-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
                  ${[1,2,3,4].map(n => `<option value="${n}" ${state.qty===n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>
              <div style="flex:1;padding-top:14px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" id="autobook-fallback-any" ${state.bookAny ? 'checked' : ''}>
                  <span>Book any slot if preferred is unavailable</span>
                </label>
              </div>
            </div>
            <button class="psycle-btn" id="btn-save-autobook" style="width:100%;background:var(--feat-autoupgrade);color:var(--on-accent);">${mapChanged() ? 'Save map and ' : ''}Schedule Auto-Book</button>
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
          const preferredSlots = [...state.selectedSlots];
          const preferredRows = [...state.selectedRows];
          saveAutoBookPreferences(c, preferredSlots, preferredRows, qty, fallbackAny, closeModal, isLive);
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
            <div style="font-size:12px;color:var(--text-secondary);font-style:italic;">Select the spot(s) you want to book for this class. You have <strong>${isDataLoaded ? availableCredits : '?'}</strong> credit${availableCredits !== 1 ? 's' : ''} available.</div>
            ${creditWarning ? `<div style="font-size:12px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:8px;padding:10px;line-height:1.5;">${creditWarning}</div>` : ''}
            <div style="display:flex;gap:8px;">
              <button class="psycle-btn" id="btn-book-simple" style="flex:1;background:var(--success);color:var(--on-accent);" ${!isDataLoaded || !hasEnoughCredits ? 'disabled' : ''}>Book Selected Spots</button>
            </div>
          </div>
        `;

        controls.querySelector('#btn-book-simple').onclick = async () => {
          if (state.selectedSlots.length === 0) {
            showToast('Please select at least one spot to book.', 'warning');
            return;
          }
          if (state.selectedSlots.length > availableCredits) {
            showToast(`You only have ${availableCredits} credit${availableCredits !== 1 ? 's' : ''} available, but selected ${state.selectedSlots.length} spot${state.selectedSlots.length !== 1 ? 's' : ''}.`, 'warning');
            return;
          }
          const btn = controls.querySelector('#btn-book-simple');
          if (isWithin12Hours(c.start_at) && btn.dataset.confirmState !== 'confirm') {
            btn.dataset.confirmState = 'confirm';
            btn.textContent = 'Class starts soon. Confirm?';
            btn.style.background = 'var(--warning)';
            setTimeout(() => {
              if (btn.dataset.confirmState === 'confirm') {
                delete btn.dataset.confirmState;
                btn.textContent = 'Book Selected Spots';
                btn.style.background = '';
              }
            }, 4000);
            return;
          }
          delete btn.dataset.confirmState;
          btn.disabled = true;
          btn.textContent = 'Booking...';
          try {
            const bookingRes = await api.proxyPost('/bookings', {
              event_id: c.id,
              slots: state.selectedSlots
            });
            showToast(`Successfully booked ${state.selectedSlots.length} spot${state.selectedSlots.length > 1 ? 's' : ''}! 🎉`, 'success');
            const bookedLabels = state.selectedSlots.map(id => {
              const s = layoutSlots.find(ls => Number(ls.id) === Number(id));
              return s?.label ?? id;
            });
            api.notifyBookingSuccess({
              source: 'manual', eventId: c.id, className: c.name || groupName, groupName,
              instructorName: instrName, startAt: c.start_at, slots: bookedLabels,
            }).catch(() => {});
            closeModal();
            if (state.selectedSlots.length === 1) await tryAutoRegisterUpgrade(c, state.selectedSlots[0], bookingRes);
            await refreshUserData();
            renderTimetableGrid();
          } catch (err) {
            showToast(`Booking failed: ${err.message}`, 'error');
            btn.disabled = false;
            btn.textContent = 'Book Selected Spots';
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
            <div style="display:flex;gap:14px;align-items:center;border-top:1px solid var(--separator);padding-top:12px;">
              <div style="width:110px;">
                <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">Slots to book:</label>
                <select id="quickbook-qty" class="psycle-select" style="width:100%;padding:6px 8px;font-size:13px;">
                  ${[1,2,3,4].map(n => `<option value="${n}" ${state.qty===n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>
              <div style="flex:1;padding-top:14px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);user-select:none;">
                  <input type="checkbox" id="quickbook-fallback-any" ${state.bookAny ? 'checked' : ''}>
                  <span>Book any slot if preferred is unavailable</span>
                </label>
              </div>
            </div>
            <button class="psycle-btn" id="btn-submit-quickbook" style="width:100%;background:var(--success);color:var(--on-accent);">${mapChanged() ? 'Save map and ' : ''}Quick-Book</button>
          </div>
        `;

        controls.querySelector('#btn-submit-quickbook').onclick = async () => {
          if (state.selectedSlots.length === 0 && state.selectedRows.size === 0) {
            showToast('Please select at least one spot or row to book.', 'warning');
            return;
          }
          const btn = controls.querySelector('#btn-submit-quickbook');
          const baseLabel = `${mapChanged() ? 'Save map and ' : ''}Quick-Book`;
          if (isWithin12Hours(c.start_at) && btn.dataset.confirmState !== 'confirm') {
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
            const slots = [...state.selectedSlots];
            const rows = [...state.selectedRows];
            if (mapChanged() && c.studio_id) {
              await api.updateStudioPreferences(c.studio_id, { preferredSlots: slots, preferredRows: rows });
            }
            await quickBookClass(c.id, {
              preferredSlots: slots,
              preferredRows: rows,
              requiredCount: qty,
              bookAny: fallbackAny
            }, null);
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
async function tryAutoRegisterUpgrade(event, bookedSlotId, bookingRes) {
  console.log('[AutoUpgrade] tryAutoRegisterUpgrade called', { autoUpgradeByDefault: userSettings.autoUpgradeByDefault, bookedSlotId, eventId: event?.id });
  if (!userSettings.autoUpgradeByDefault) {
    console.log('[AutoUpgrade] Skipping — autoUpgradeByDefault is off. userSettings:', JSON.stringify(userSettings));
    return;
  }
  try {
    const studioId = event.studio_id;
    console.log('[AutoUpgrade] Studio ID:', studioId, '| event.studio:', event.studio);

    // Check preferred spot map exists for this studio
    let prefs = cache.studioPreferences?.[studioId];
    console.log('[AutoUpgrade] Cached prefs:', prefs);
    if (!prefs) {
      const allPrefs = await api.getStudioPreferences();
      cache.studioPreferences = allPrefs;
      prefs = allPrefs[studioId];
      console.log('[AutoUpgrade] Fetched all prefs, studioId prefs:', prefs);
    }
    if (!prefs?.preferredSlots?.length && !prefs?.preferredRows?.length) {
      const studioName = event.studio?.name || studioMap.get(studioId) || 'this studio';
      console.log('[AutoUpgrade] No preferred spot map for studio:', studioName, '| prefs:', prefs);
      showToast(`Can't set auto-upgrade because you don't have a preferred spot map for ${studioName}. Please configure one!`, 'warning');
      return;
    }

    // Resolve booking ID from various response shapes
    console.log('[AutoUpgrade] Raw bookingRes:', JSON.stringify(bookingRes));
    let bookingId;

    // CodexFit returns: { success: true, bookings: { "8255409": 53 } }
    // The key is the booking ID, value is the slot ID
    if (bookingRes?.bookings && typeof bookingRes.bookings === 'object') {
      bookingId = Object.keys(bookingRes.bookings)[0];
      console.log('[AutoUpgrade] Extracted from bookings object:', bookingId);
    } else {
      // Fallback for other response shapes
      const dataObj = Array.isArray(bookingRes?.data) ? bookingRes.data[0] : bookingRes?.data;
      bookingId = dataObj?.id || bookingRes?.id;
      console.log('[AutoUpgrade] Fallback extraction:', bookingId, '| dataObj:', dataObj);
    }

    if (!bookingId) {
      console.warn('[AutoUpgrade] Could not resolve booking ID — giving up. Full response:', bookingRes);
      return;
    }

    const payload = {
      eventId: event.id,
      studioId: studioId || null,
      bookingId,
      currentSlotId: bookedSlotId,
      className: event.event_type?.name || 'Ride',
      instructorName: event.instructor?.full_name || 'Instructor',
      studioName: event.studio?.name || '',
      locationName: event.studio?.location?.name || '',
      startAt: event.start_at,
      preferences: { keepOriginalOnCutoff: true }
    };
    console.log('[AutoUpgrade] Sending addAutoUpgrade payload:', JSON.stringify(payload));
    await api.addAutoUpgrade(payload);
    showToast('Auto-upgrade monitor started for better spot availability.', 'info');
    console.log('[AutoUpgrade] Monitor registered successfully.');
  } catch (err) {
    console.warn('[AutoUpgrade] Failed to auto-register:', err.message, err);
  }
}

// Perform direct booking of spot ID
async function bookSeatDirect(eventId, slotId, callback, event) {
  try {
    showToast(`Booking seat ${slotId}...`, 'info');
    const bookingRes = await api.proxyPost('/bookings', {
      event_id: eventId,
      slots: [slotId]
    });
    showToast('Seat booked successfully! 🎉', 'success');
    callback();
    if (event) await tryAutoRegisterUpgrade(event, slotId, bookingRes);
    await refreshUserData();
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

// Cancel Booking direct — always requires a second click to confirm
async function cancelBookingDirect(bookingId, isPenalty, btn) {
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
  btn.disabled = true;
  btn.textContent = 'Cancelling...';

  try {
    showToast('Cancelling booking...', 'info');
    await api.proxyDelete(`/bookings/${bookingId}`);
    showToast('Booking cancelled successfully!', 'success');

    // Remove any active upgrade monitor for this booking
    const activeUpgrade = cache.upgrades?.find(u =>
      String(u.booking_id) === String(bookingId) &&
      ['active', 'paused_no_credits'].includes(u.status)
    );
    if (activeUpgrade) {
      try {
        await api.deleteAutoUpgrade(activeUpgrade.id);
      } catch (e) {
        console.warn('[Cancel] Could not remove upgrade monitor:', e.message);
      }
    }

    await refreshUserData();
    renderTimetableGrid();
  } catch (err) {
    showToast(`Cancel failed: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Cancel';
    btn.style.background = '';
    btn.style.borderColor = '';
    btn.style.color = '';
  }
}

// Save scheduled auto-booking record to database
async function saveAutoBookPreferences(c, slots, rows, qty, bookAny, callback, skipImmediate = false) {
  const instructor = metadata.instructors.find(i => i.id === c.instructor_id) || { full_name: 'Instructor' };
  const studio = metadata.studios.find(s => s.id === c.studio_id) || { name: 'Studio' };
  const classType = metadata.eventTypes.find(t => t.id === c.event_type_id) || { name: 'Class' };
  const studioLocationId = studio.location_id || selectedLocations[0] || c.location_id;
  const location = metadata.locations.find(l => String(l.id) === String(studioLocationId)) || { name: 'Location' };

  // Strip event type prefix from class name (e.g., "RIDE: Signature 45" → "Signature 45")
  const groupName = c.event_type?.group?.name || classType?.group?.name || classType.name || 'Class';
  const typePrefix = groupName.toUpperCase() + ': ';
  const fullClassName = c.name || c.event_type?.name || classType.name;
  const strippedClassName = fullClassName.toUpperCase().startsWith(typePrefix)
    ? fullClassName.substring(typePrefix.length)
    : fullClassName;

  try {
    showToast('Scheduling auto-booking...', 'info');

    // The studio spot map is the shared source of truth. If the user picked
    // spots/rows here, persist them to the studio map so the live resolver (and
    // every other feature for this studio) uses the same selection.
    if (c.studio_id && (slots.length > 0 || rows.length > 0)) {
      try {
        await api.updateStudioPreferences(c.studio_id, { preferredSlots: slots, preferredRows: rows });
      } catch (e) {
        console.warn('[AutoBook] Could not persist studio map:', e.message);
      }
    }

    const availForAB = getAvailableCreditsForEvent(c);
    const creditShortfall = Number.isFinite(availForAB) ? Math.max(0, qty - availForAB) : 0;

    await api.addAutoBooking({
      eventId: c.id,
      studioId: c.studio_id || null,
      className: strippedClassName,
      groupName,
      instructorName: instructor.full_name || instructor.name,
      studioName: studio.name,
      locationName: location.name,
      startAt: c.start_at,
      skipImmediate,
      creditShortfall,
      preferences: {
        preferredSlots: slots,
        preferredRows: rows,
        requiredCount: qty,
        bookAny
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

  title.textContent = `Debug: ${event.name || event.event_type_name || 'Class'} — ${event.start_at || ''}`;
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
    const res = await api.proxyGet(`/events/${event.id}`, { ttlMs: 120000 });
    const eventData = res.data || res;
    const relations = res.relations || eventData.relations || {};

    // Fetch slot availability for the Slots tab
    const studio = metadata.studios.find(s => s.id === event.studio_id);
    const layoutSlots = studio?.layout?.slots || [];
    // Note: /events/{id}/slots endpoint not available; use layout data from studio
    let availableSlots = [];

    // Find matching booking and waitlist for this event
    const matchingBooking = userBookings.find(b => b.event_id === event.id || b.event?.id === event.id) || null;
    const matchingWaitlist = userWaitlists.find(w => w.event_id === event.id || w.event?.id === event.id) || null;

    // Compute key values
    const classRelease = getClassReleaseTime(event.start_at, userSettings);
    const now = DateTime.now().setZone('Europe/London');
    const isLive = event.is_always_bookable ? true : (now >= classRelease);
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
          return `<tr style="font-size:12px;"><td style="padding:3px 8px;color:var(--text-secondary);">Row ${idx+1}</td><td style="padding:3px 8px;color:var(--text);">${rowSlots.length} seats</td><td style="padding:3px 8px;color:var(--success);">${rowAvail.length} available</td><td style="padding:3px 8px;color:var(--danger);">${rowSlots.length - rowAvail.length} occupied</td></tr>`;
        }).join('');

        contentArea.innerHTML = `
          <div style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent);border-radius:10px;padding:14px;margin-bottom:12px;">
            <h5 style="color:var(--feat-autoupgrade);margin:0 0 10px 0;font-size:13px;font-weight:700;">Seat Availability</h5>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 0;font-size:12px;">
              <span style="color:var(--text-secondary);">Layout seats:</span><span style="color:var(--text);font-weight:600;">${totalLayout}</span><span></span>
              <span style="color:var(--text-secondary);">Available:</span><span style="color:var(--success);font-weight:600;">${totalAvail}</span><span></span>
              <span style="color:var(--text-secondary);">Occupied:</span><span style="color:var(--danger);font-weight:600;">${occupied}</span><span></span>
              <span style="color:var(--text-secondary);">Capacity:</span><span style="color:var(--text);font-weight:600;">${event.capacity ?? 'N/A'}</span><span></span>
              <span style="color:var(--text-secondary);">Occupancy:</span><span style="color:var(--text);font-weight:600;">${event.occupancy ?? 'N/A'}</span><span></span>
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
        const studio = metadata.studios.find(s => s.id === event.studio_id);
        const loc = studio ? metadata.locations.find(l => String(l.id) === String(studio.location_id)) : null;
        const instructor = metadata.instructors.find(i => i.id === event.instructor_id);
        const typeInfo = metadata.eventTypes.find(t => t.id === event.event_type_id);

        computedHtml = `
          <div class="psycle-debug-computed" style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent); border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent); border-radius:10px; padding:14px; margin-bottom:16px;">
            <h5 style="color:var(--feat-autoupgrade); margin:0 0 10px 0; font-size:13px; font-weight:700;">Key Computed Values</h5>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:12px;">
              <span style="color:var(--text-secondary);">isLive:</span><span style="color:var(--text); font-weight:600;">${isLive}</span>
              <span style="color:var(--text-secondary);">classReleaseTime:</span><span style="color:var(--text); font-weight:600;">${classRelease.toISO()}</span>
              <span style="color:var(--text-secondary);">bookingCutoff:</span><span style="color:var(--text); font-weight:600;">${bookingCutoff}</span>
              <span style="color:var(--text-secondary);">extendedCutoff:</span><span style="color:var(--text); font-weight:600;">${extendedCutoff}</span>
              <span style="color:var(--text-secondary);">isFullyBooked:</span><span style="color:var(--text); font-weight:600;">${!!event.is_fully_booked}</span>
              <span style="color:var(--text-secondary);">isAlwaysBookable:</span><span style="color:var(--text); font-weight:600;">${!!event.is_always_bookable}</span>
              <span style="color:var(--text-secondary);">capacity:</span><span style="color:var(--text); font-weight:600;">${event.capacity ?? 'N/A'}</span>
              <span style="color:var(--text-secondary);">occupancy:</span><span style="color:var(--text); font-weight:600;">${event.occupancy ?? 'N/A'}</span>
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
          html += `<div style="margin-left:12px; font-size:12px; color:var(--text-secondary);">• ${s.name || 'Unnamed'} (ID: ${s.id}, Location ID: ${s.location_id})</div>`;
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
          const groupName = et.group ? et.group.name : '';
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
        <!-- Quick-Book / Auto-Book buttons -->
        <div id="psycle-debug-action-bar" style="display:flex; gap:8px; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:4px;">
          <button id="psycle-debug-quick-book-btn" class="psycle-btn-mini variant-success-muted">Quick-Book</button>
          <button id="psycle-debug-auto-book-btn" class="psycle-btn-mini variant-neutral">Auto-Book Config</button>
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
