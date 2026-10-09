// U2-5 — mobile timetable filter rail + bottom sheet.
// Spec: Documentation/TIMETABLE_FILTER_DESIGN_BRIEF.md
//
// This module owns NO filter state. timetable.js owns the selected* arrays and
// hands us a snapshot plus mutators through `ctx` on every render, so the rail,
// the sheet and the desktop dropdowns can never disagree about what is active.
// Ids are compared as strings throughout (normalized ids are strings, raw event
// fields are numbers — see AGENTS.md).

import { icon, gymBrand, getDiscipline } from './cards.js';
import { escapeHtml } from './cards.js';
import { COPY, formatCopyText } from '../copy.js';
import { pushLayer } from './modal-nav.js';
import { summariseInstructorsByGym, compactInstructorsCount } from './instructor-filter.js';
import { quickSelectItems } from './gym-quick-select.js';

// Aliases come from the gym config (ctx.locationAlias). This is only the
// fallback for a location that has none: word initials, or the first 3 letters.
export function compressStudioName(name = '') {
  const clean = String(name).trim();
  const words = clean.split(/[\s/&-]+/).filter(Boolean);
  if (words.length <= 1) return clean.slice(0, 3).toUpperCase();
  return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
}

let sheetEl = null;
let sheetLayer = null;
let lastCtx = null;

const selectedCount = (s) =>
  s.gyms.length + s.locations.length + s.eventTypes.length + s.instructors.length + (s.bookmarks ? 1 : 0);

// Round 1:1 brand mark, and the full wordmark on its brand plate.
// Items in a rail chip are separated by a small dot, not a comma. Escapes each
// item; the result is HTML.
function dotJoin(items) {
  return items.map(escapeHtml).join('<span class="fr-dot" aria-hidden="true">\u00b7</span>');
}

function gymDot(gymId, cls = '') {
  const b = gymBrand(gymId);
  return `<span class="fr-gym-dot ${cls}" style="background:${b.brandBg}" title="${escapeHtml(b.name)}">${b.markHtml}</span>`;
}
export function gymPlate(gymId) {
  const b = gymBrand(gymId);
  return `<span class="fr-logo-plate" style="background:${b.brandBg}" title="${escapeHtml(b.name)}">${b.logoSvg}<span class="u-visually-hidden">${escapeHtml(b.name)}</span></span>`;
}

function avatar(instr) {
  const url = instr && (instr.thumbUrl || instr.imageUrl);
  if (url) return `<img class="fr-avatar" src="${escapeHtml(url)}" alt="" width="20" height="20">`;
  const initial = escapeHtml(((instr && instr.name) || '?')[0]);
  return `<span class="fr-avatar fr-avatar-fallback">${initial}</span>`;
}

// Which sheet section each chip's filter lives in (gym chips carry locations).
const CHIP_SECTION = { gyms: 'locations', eventTypes: 'workouts', instructors: 'instructors' };

function chip(html, clearKey, label, extraClass = '') {
  return `<span class="fr-chip${extraClass ? ' ' + extraClass : ''}" role="group" aria-label="${escapeHtml(label)}">`
    + `<button type="button" class="fr-chip-body" data-fr-open="1" data-fr-section="${CHIP_SECTION[clearKey] || ''}">${html}</button>`
    + `<button type="button" class="fr-chip-x" data-fr-clear="${clearKey}" aria-label="${escapeHtml(formatCopyText(COPY.filters.clearLabel, { label }))}">&#x2715;</button>`
    + `</span>`;
}

// Locations selected, per gym, as initials — or a count once 3+ (keeps the tile
// under ~100px, brief 4.3).
function gymTileHtml(ctx) {
  const { state, locations } = ctx;
  const gymIds = [...new Set([
    ...state.gyms,
    ...state.locations.map(id => locations.find(l => String(l.id) === id)?.gymId).filter(Boolean),
  ])];
  return gymIds.map(gymId => {
    const locs = state.locations
      .map(id => locations.find(l => String(l.id) === id))
      .filter(l => l && l.gymId === gymId);
    let text = '';
    if (locs.length > 0 && locs.length <= 2) text = dotJoin(locs.map(l => ctx.locationAlias(l) || compressStudioName(ctx.locationLabel(l))));
    else if (locs.length > 2) text = `<b class="fr-num">${locs.length}</b>`;
    return `<span class="fr-tile-part">${gymDot(gymId)}${text ? `<span class="fr-initials">${text}</span>` : ''}</span>`;
  }).join('');
}

// Mobile scroll-collapse: the whole gym/location tile folds into "N locations". N = locations picked, or
// (gym-only picks) every location those gyms have. Returns '' when unknown, so the chip just doesn't collapse.
function compactLocationsCount(state, locations = []) {
  const gymIds = state.gyms.map(String);
  return state.locations.length
    ? new Set(state.locations.map(String)).size
    : locations.filter(l => gymIds.includes(String(l.gymId))).length;
}
export function compactLocationsLabel(state, locations = []) {
  const n = compactLocationsCount(state, locations);
  return n ? formatCopyText(COPY.filters.locationsCompact, { count: n, plural: n === 1 ? '' : 's' }) : '';
}
export function compactInstructorsLabel(state, gymIds = []) {
  const info = compactInstructorsCount(state.instructors, gymIds);
  const plural = info.count === 1 && !info.hasUnfilteredGym ? '' : 's';
  const word = formatCopyText(COPY.filters.instructorWord, { plural });
  return countLabelHtml(info.countLabel, word);
}

// ONE renderer for every "N things" label in a rail chip (Types, Locations, Instructors): the count is always
// bold (.fr-num), the word regular (.fr-thin), so no chip can drift from the others.
function countLabelHtml(n, word) {
  return `<b class="fr-num">${n}</b><span class="fr-thin">${escapeHtml(word)}</span>`;
}

// ONE wrapper for the icon + content of every rail chip (Locations, Types, Instructors): icon, then a single
// .fr-chip-main span, so the icon-to-content gap is the chip body's own gap and never differs per section.
function chipBodyHtml(iconHtml, contentHtml) {
  return `${iconHtml}<span class="fr-chip-main">${contentHtml}</span>`;
}

function workoutLabel(s) {
  if (s.eventTypes.length === 1) return escapeHtml(s.eventTypes[0]);
  if (s.eventTypes.length === 2) return dotJoin(s.eventTypes);
  return countLabelHtml(s.eventTypes.length, COPY.filters.types);
}

// Compact (scrolled) state stacks the gym logos; a tap on the stack spreads them until the page expands again.
let gymStackOpen = false;
let compactObserver = null;
function appContainer() { return document.getElementById('app-container'); }
function isGymStacked() {
  const app = appContainer();
  return !!(app && app.classList.contains('app-tt-compact') && !gymStackOpen
    && window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
}
function setGymStackOpen(open, rail) {
  gymStackOpen = open;
  (rail || document.getElementById('app-filter-rail'))?.querySelector('.fr-gymquick')?.classList.toggle('is-open', open);
}
function watchCompact() {
  const app = appContainer();
  if (compactObserver || !app || typeof MutationObserver === 'undefined') return;
  compactObserver = new MutationObserver(() => {
    if (!app.classList.contains('app-tt-compact') && gymStackOpen) setGymStackOpen(false);
  });
  compactObserver.observe(app, { attributes: true, attributeFilter: ['class'] });
}

export function renderFilterRail(ctx) {
  watchCompact();
  lastCtx = ctx;
  const host = document.getElementById('app-timetable-filters-container');
  if (!host) return;
  let rail = document.getElementById('app-filter-rail');
  if (!rail) {
    rail = document.createElement('div');
    rail.id = 'app-filter-rail';
    rail.className = 'fr-rail';
    host.prepend(rail);
  }
  const { state } = ctx;
  const parts = [];      // gym logos, search
  const groupParts = []; // filter button + chips (visually grouped)

  // No filters applied: the button also says "Filters"; once any chip exists it is icon-only. The rail is
  // re-rendered on every filter change, so this re-evaluates for free.
  const noFilters = selectedCount(state) === 0;
  // Gym quick-selector: one small round logo per gym, beside Filters. Tap narrows to that gym.
  const configured = (ctx.allGyms && ctx.allGyms.length ? ctx.allGyms : ctx.gyms) || [];
  if (ctx.setGymQuick && configured.length > 1) {
    const items = quickSelectItems(state.gyms, configured.map(g => g.id), ctx.gyms.map(g => g.id));
    parts.push(`<span class="fr-gymquick${gymStackOpen ? ' is-open' : ''}" role="group" aria-label="${escapeHtml(COPY.filters.gymQuickGroup)}">${items.map(({ gymId, shown, linked }, gi) => {
      const name = gymBrand(gymId).name;
      const label = formatCopyText(!linked ? COPY.filters.gymQuickUnlinked : shown ? COPY.filters.gymQuickShown : COPY.filters.gymQuickHidden, { name });
      return `<button type="button" style="z-index:${items.length - gi}" class="fr-gymquick-btn${shown ? ' is-shown' : ' is-off'}" data-fr-gymquick="${escapeHtml(gymId)}" aria-pressed="${shown}" aria-label="${escapeHtml(label)}">${gymDot(gymId, 'lg')}${shown ? '<svg class="fr-gymquick-tick" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2 4.2 7.4 8 2.8"/></svg>' : ''}</button>`;
    }).join('')}</span>`);
  }

  // Search lives beside Filters; the input it opens is owned by timetable-search-ui.js
  // (persistent, so this per-render repaint can't destroy typed text).
  if (ctx.openSearch) {
    parts.push(`<button type="button" class="fr-trigger fr-search-btn${ctx.searchActive ? ' active' : ''}" data-fr-search="1" aria-label="${COPY.filters.search}">${icon('search', 16)}</button>`);
  }

  groupParts.push(`<button type="button" class="fr-trigger${noFilters ? ' has-label' : ''}" data-fr-open="1" aria-label="${COPY.filters.filters}${selectedCount(state) ? `, ${formatCopyText(COPY.filters.activeFilters, { count: selectedCount(state) })}` : ''}">${icon('filter', 16)}${noFilters ? `<span class="fr-trigger-label">${COPY.filters.filters}</span>` : ''}</button>`);

  if (state.gyms.length || state.locations.length) {
    const compact = compactLocationsLabel(state, ctx.locations);
    // Both faces stay in the DOM; CSS cross-fades them while the page is scrolled down (app-tt-compact).
    const tile = compact
      ? `<span class="fr-tile-full">${gymTileHtml(ctx)}</span><span class="fr-tile-compact" aria-hidden="true">${countLabelHtml(compactLocationsCount(state, ctx.locations), formatCopyText(COPY.filters.locationWord, { plural: compactLocationsCount(state, ctx.locations) === 1 ? '' : 's' }))}</span>`
      : gymTileHtml(ctx);
    groupParts.push(chip(chipBodyHtml(icon('pin', 13), tile), 'gyms', COPY.filters.clearFilterChip, compact ? 'has-compact' : ''));
  }
  if (state.eventTypes.length) {
    // One generic workout glyph (the same one JAB's TRAIN uses), not the first
    // pick's own icon, so the chip reads the same whatever is selected.
    groupParts.push(chip(chipBodyHtml(icon(getDiscipline('train').icon, 13), workoutLabel(state)), 'eventTypes', COPY.filters.workoutFilterChip));
  }
  if (state.instructors.length) {
    const first = ctx.instructors.find(i => String(i.id) === state.instructors[0]);
    const gymIds = (ctx.gyms || []).map(g => g.id);
    const configured = (ctx.allGyms && ctx.allGyms.length ? ctx.allGyms : ctx.gyms) || [];
    const configuredGymIds = configured.map(g => g.id);
    const targetGymIds = configuredGymIds.length > 1 ? configuredGymIds : gymIds;

    // U6-15: Several gyms: tile folds into grand total count on scroll (e.g. "8 Instructors" or "8+ Instructors" if any configured gym has no instructor filter).
    if (targetGymIds.length > 1) {
      const fullTile = summariseInstructorsByGym(state.instructors, targetGymIds).map(({ gymId, count }) =>
        `<span class="fr-tile-part">${gymDot(gymId)}<span class="fr-initials">${count ? `<b class="fr-num">${count}</b>` : COPY.filters.all}</span></span>`).join('');
      const compactTile = `<span class="fr-tile-compact" aria-hidden="true">${compactInstructorsLabel(state, targetGymIds)}</span>`;
      const tile = `<span class="fr-tile-full">${fullTile}</span>${compactTile}`;
      groupParts.push(chip(chipBodyHtml(icon('user', 13), tile), 'instructors', COPY.filters.instructorFilterChip, 'has-compact'));
    } else {
      const body = state.instructors.length === 1
        ? chipBodyHtml(icon('user', 13), escapeHtml(((first && first.name) || COPY.filters.instructorFallback).split(' ')[0]))
        : chipBodyHtml(icon('user', 13), countLabelHtml(state.instructors.length, COPY.filters.instructors));
      groupParts.push(chip(body, 'instructors', COPY.filters.instructorFilterChip));
    }
  }
  parts.push(`<span class="fr-filtergroup">${groupParts.join('')}</span>`);
  rail.innerHTML = parts.join('');

  rail.onclick = (e) => {
    const clear = e.target.closest('[data-fr-clear]');
    if (clear) { ctx.clear(clear.dataset.frClear); return; }
    const gq = e.target.closest('[data-fr-gymquick]');
    if (gq) {
      if (isGymStacked()) { setGymStackOpen(true, rail); return; }
      ctx.setGymQuick(gq.dataset.frGymquick); return;
    }
    if (e.target.closest('[data-fr-search]')) { ctx.openSearch(); return; }
    const opener = e.target.closest('[data-fr-open]');
    if (opener) openSheet(ctx, opener.dataset.frSection || null);
  };

  if (sheetEl) {
    const sheet = sheetEl.querySelector('.fr-sheet');
    const gymsKey = (ctx.state.gyms || []).join(',');
    if (gymsKey !== lastPaintedGymsKey || !sheet?.querySelector('.fr-body')) {
      paintSheet(ctx);
    } else {
      updateSheetState(sheet, ctx);
    }
  }
}

export function isFilterSheetOpen() {
  return !!(sheetEl && sheetEl.classList.contains('open'));
}

export function syncFilterSheetState(ctx) {
  if (!sheetEl || !sheetEl.classList.contains('open')) return;
  const sheet = sheetEl.querySelector('.fr-sheet');
  if (!sheet) return;
  const gymsKey = (ctx.state.gyms || []).join(',');
  if (gymsKey !== lastPaintedGymsKey || !sheet.querySelector('.fr-body')) {
    paintSheet(ctx);
  } else {
    updateSheetState(sheet, ctx);
  }
}

export function removeFilterRail() {
  document.getElementById('app-filter-rail')?.remove();
  destroySheet();
}

let closeTimer = null;
let lastPaintedGymsKey = '';

function destroySheet() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null;
  lastPaintedGymsKey = '';
}

export function closeSheet() {
  if (!sheetEl || !sheetEl.classList.contains('open')) return;
  lastCtx?.flush?.();
  if (sheetLayer) { const l = sheetLayer; sheetLayer = null; l.release(); }
  sheetEl.classList.remove('open');
  const targetEl = sheetEl;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (sheetEl === targetEl) {
      destroySheet();
    } else {
      targetEl?.remove();
    }
  }, 280);
}

// U2-7: `focusKey` (from a chip) opens just that section, collapses the rest and
// scrolls it into view. The trigger button passes none and keeps the last state.
function openSheet(ctx, focusKey = null) {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (focusKey) {
    openSecs.clear();
    openSecs.add(focusKey);
    if (focusKey === 'instructors') {
      // Show the picks, not a wall of collapsed gym groups.
      openInstGyms.clear();
      ctx.instructors.filter(i => ctx.state.instructors.includes(String(i.id)))
        .forEach(i => openInstGyms.add(i.gymId || ''));
    }
  }
  if (!sheetEl) {
    sheetEl = document.createElement('div');
    sheetEl.className = 'fr-sheet-overlay';
    sheetEl.innerHTML = `<div class="fr-sheet" role="dialog" aria-modal="true" aria-label="${COPY.filters.filters}"></div>`;
    sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet(); });
    document.body.appendChild(sheetEl);
    // Mobile: hardware/iOS back closes the sheet, and body scroll is locked while it is open.
    sheetLayer = pushLayer({ id: 'filter-sheet', lock: true, escCloses: true, onBack: () => { sheetLayer = null; closeSheet(); } });
    // Force reflow so translateY(100%) initial frame commits, then transition smoothly to translateY(0)
    void sheetEl.offsetWidth;
    sheetEl.classList.add('open');
  } else {
    sheetEl.classList.add('open');
  }
  paintSheet(ctx);
  if (focusKey) {
    // Instant and top-aligned, after the sheet's open animation has laid out.
    const el = sheetEl.querySelector(`#fr-sec-${focusKey}`);
    requestAnimationFrame(() => requestAnimationFrame(() => el && el.scrollIntoView({ block: 'start' })));
  }
}

// Accordion state survives repaints (every toggle re-renders the timetable,
// which repaints the sheet) so a section doesn't snap shut under your thumb.
const openSecs = new Set(['locations']);
const openInstGyms = new Set();   // instructor sub-sections start collapsed
let instQuery = '';
let instSearching = false;   // results show only while the search box is 'in use'

function summarise(names) {
  if (!names.length) return COPY.filters.all;
  return names.length <= 3 ? names.join(', ') : formatCopyText(COPY.filters.selected, { count: names.length });
}

function section(key, title, summary, count, inner, clearKey) {
  const open = openSecs.has(key);
  return `<div class="fr-sec${open ? ' open' : ''}" id="fr-sec-${key}">
    <div class="fr-sec-row">
      <button type="button" class="fr-sec-head" data-fr-sec="${key}" aria-expanded="${open}">
        <span class="fr-sec-title">${title}</span>
        <span class="fr-sec-sum${count ? ' has' : ''}">${escapeHtml(summary)}</span>
        <span class="fr-chev" aria-hidden="true">&#x25BE;</span>
      </button>
      ${count ? `<button type="button" class="fr-sec-clear" data-fr-clear="${clearKey}">${COPY.filters.clear}</button>` : ''}
    </div>
    ${open ? `<div class="fr-sec-body">${inner}</div>` : ''}
  </div>`;
}

function instructorRow(ctx, i, withLogo) {
  const on = ctx.isOn('instructors', i.id);
  return `<button type="button" class="fr-opt fr-opt-instructor${on ? ' on' : ''}" data-fr-toggle="instructors" data-id="${escapeHtml(i.id)}" aria-pressed="${on}">${avatar(i)}<span class="fr-opt-name">${escapeHtml(i.name || '')}</span>${withLogo ? gymDot(i.gymId, 'sm') : ''}</button>`;
}

function instructorListHtml(ctx) {
  const q = instSearching ? instQuery.trim().toLowerCase() : '';
  if (q) {
    const hits = ctx.instructors.filter(i => (i.name || '').toLowerCase().includes(q));
    return hits.length
      ? `<div class="fr-grid">${hits.map(i => instructorRow(ctx, i, true)).join('')}</div>`
      : `<p class="fr-hint">${COPY.filters.noInstructorsMatch}</p>`;
  }
  const byGym = new Map();
  ctx.instructors.forEach(i => { const k = i.gymId || ''; (byGym.get(k) || byGym.set(k, []).get(k)).push(i); });
  // One linked gym: no group header needed, a flat list says it all.
  if (byGym.size === 1) return `<div class="fr-grid">${[...byGym.values()][0].map(i => instructorRow(ctx, i, false)).join('')}</div>`;
  return [...byGym.entries()].map(([gymId, list]) => {
    const open = openInstGyms.has(gymId);
    const picked = list.filter(i => ctx.state.instructors.includes(String(i.id))).length;
    return `<div class="fr-igroup${open ? ' open' : ''}">
      <button type="button" class="fr-igroup-head" data-fr-igroup="${escapeHtml(gymId)}" aria-expanded="${open}">
        ${gymDot(gymId)}<span class="fr-opt-name">${escapeHtml(gymBrand(gymId).name)}</span>
        ${picked ? `<span class="fr-count">${picked}</span>` : ''}<span class="fr-chev" aria-hidden="true">&#x25BE;</span>
      </button>${open ? `<div class="fr-igroup-body fr-grid">${list.map(i => instructorRow(ctx, i, false)).join('')}</div>` : ''}
    </div>`;
  }).join('') || `<p class="fr-hint">${COPY.filters.noInstructorsForGyms}</p>`;
}

// After opening something, scroll just enough to bring all of it into view.
// A section taller than the pane can never fit, so it is aligned to the top
// instead. `nearest` also scrolls the instructor list when the group is inside it.
function reveal(el, alignTopIfTall) {
  if (!el) return;
  requestAnimationFrame(() => {
    const body = el.closest('.fr-body');
    const tall = alignTopIfTall && body && el.getBoundingClientRect().height > body.clientHeight;
    el.scrollIntoView({ block: tall ? 'start' : 'nearest', behavior: 'smooth' });
  });
}

function paintSheet(ctx) {
  const sheet = sheetEl.querySelector('.fr-sheet');
  const scrollTop = sheet.querySelector('.fr-body')?.scrollTop || 0;
  const listTop = sheet.querySelector('.fr-list')?.scrollTop || 0;
  const { state } = ctx;
  lastPaintedGymsKey = (state.gyms || []).join(',');
  const total = selectedCount(state);
  const showGyms = ctx.gyms.length > 1;
  const gymName = (id) => (ctx.gyms.find(g => String(g.id) === String(id))?.name) || gymBrand(id).name;

  // Gyms: a plain checkbox row per gym with its full logo. Only collapses once
  // there are enough linked gyms for the list to be a burden (>4).
  const gymInner = `<div class="fr-gymrows">${ctx.gyms.map(g => {
    const on = ctx.isOn('gyms', g.id);
    return `<button type="button" class="fr-gymrow${on ? ' on' : ''}" data-fr-toggle="gyms" data-id="${escapeHtml(g.id)}" aria-pressed="${on}" aria-label="${escapeHtml(gymBrand(g.id).name)}">${gymPlate(g.id)}</button>`;
  }).join('')}</div>`;
  const gymBlock = !showGyms ? '' : ctx.gyms.length > 4
    ? section('gyms', COPY.static.gyms, summarise(state.gyms.map(gymName)), state.gyms.length, gymInner, 'gyms')
    : `<div class="fr-sec fr-sec-plain">${gymInner}</div>`;

  // One merged grid. ctx.locations is already ordered by gym, so same-gym
  // chips sit together; the round logo on each chip says whose it is.
  const locInner = ctx.locations.length ? `<div class="fr-grid">${ctx.locations.map(l => {
      const on = ctx.isOn('locations', l.id);
      return `<button type="button" class="fr-opt${on ? ' on' : ''}" data-fr-toggle="locations" data-id="${escapeHtml(l.id)}" aria-pressed="${on}">
        ${gymDot(l.gymId, 'sm')}<span class="fr-opt-name">${escapeHtml(ctx.locationLabel(l))}</span></button>`;
    }).join('')}</div>` : `<p class="fr-hint">${COPY.filters.noLocationsForGyms}</p>`;

  // Workouts grouped by gym. A workout id is the bucket label and is shared
  // across gyms by design (see setupDropdownFilters), so the same label under
  // two gyms lights up together.
  const wByGym = new Map();
  ctx.workouts.forEach(w => { const k = w.gymId || ''; (wByGym.get(k) || wByGym.set(k, []).get(k)).push(w); });
  const workInner = [...wByGym.entries()].map(([gymId, list]) => `<div class="fr-wgroup">
      <div class="fr-wgroup-head">${gymDot(gymId)}<span>${escapeHtml(gymBrand(gymId).name)}</span></div>
      <div class="fr-grid fr-grid3">${list.map(w => {
        const on = ctx.isOn('eventTypes', w.id);
        return `<button type="button" class="fr-opt fr-opt-stack${on ? ' on' : ''}" data-fr-toggle="eventTypes" data-id="${escapeHtml(w.id)}" aria-pressed="${on}">${icon(getDiscipline(w.name).icon, 20)}<span class="fr-opt-name">${escapeHtml(w.name)}</span></button>`;
      }).join('')}</div></div>`).join('');

  const instInner = `<input type="search" class="fr-search" placeholder="${COPY.filters.searchInstructors}" value="${escapeHtml(instQuery)}" aria-label="${COPY.filters.searchInstructorsAria}" autocomplete="off">
    <div class="fr-list">${instructorListHtml(ctx)}</div>`;

  const nameOf = {
    locations: state.locations.map(id => { const l = ctx.locations.find(x => String(x.id) === id); return l ? ctx.locationLabel(l) : id; }),
    instructors: state.instructors.map(id => ctx.instructors.find(x => String(x.id) === id)?.name || id),
  };

  // F-12: Favourites only lives in the drawer on mobile (every gym has favourites now).
  const favOn = !!state.bookmarks;
  const favRow = !ctx.canBookmark ? '' : `<div class="fr-sec fr-sec-plain"><button type="button" class="fr-favrow${favOn ? ' on' : ''}" data-fr-fav="1" aria-pressed="${favOn}"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="${favOn ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z"/></svg><span>${COPY.filters.favouritesOnly}</span></button></div>`;

  sheet.innerHTML = `
    <div class="fr-grab" aria-hidden="true"></div>
    <div class="fr-head">
      <div class="fr-title">${COPY.filters.filters}</div><span class="fr-badge" aria-live="polite">${ctx.resultCount} ${ctx.resultCount === 1 ? COPY.filters.class : COPY.filters.classes}</span>
      <button type="button" class="fr-reset" data-fr-reset="1"${total ? '' : ' disabled'}>${COPY.filters.resetAll}</button>
      <button type="button" class="fr-close" data-fr-close="1" aria-label="${COPY.filters.closeFilters}">&#x2715;</button>
    </div>
    <div class="fr-body">
      ${favRow}
      ${gymBlock}
      ${section('locations', COPY.filters.locations, summarise(nameOf.locations), state.locations.length, locInner, 'locations')}
      ${section('workouts', COPY.filters.workouts, summarise(state.eventTypes), state.eventTypes.length, workInner, 'eventTypes')}
      ${section('instructors', COPY.filters.instructors, summarise(nameOf.instructors), state.instructors.length, instInner, 'instructors')}
    </div>
    <div class="fr-foot"><button type="button" class="fr-save" data-fr-save="1">${COPY.filters.saveAsDefault}</button><button type="button" class="fr-done" data-fr-close="1">${ctx.resultCount === 0 ? COPY.filters.noClassesAdjust : COPY.filters.showClasses}</button></div>`;

  sheet.querySelector('.fr-body').scrollTop = scrollTop;
  const list = sheet.querySelector('.fr-list');
  if (list) list.scrollTop = listTop;

  wireDragToDismiss(sheet, closeSheet);

  // Typing repaints only the list, so the input keeps focus and the keyboard.
  const search = sheet.querySelector('.fr-search');
  if (search) {
    const refresh = () => { sheet.querySelector('.fr-list').innerHTML = instructorListHtml(ctx); };
    search.oninput = () => { instQuery = search.value; instSearching = true; refresh(); };
    search.onfocus = () => { if (!instSearching) { instSearching = true; refresh(); } };
  }

  sheet.onclick = (e) => {
    // Any tap outside the search box and its results puts the results away; the
    // typed query stays, and focusing the box brings them back.
    if (instSearching && !e.target.closest('.fr-search, .fr-list')) {
      instSearching = false;
      if (!e.target.closest('button')) return paintSheet(ctx);
    }
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.frClear) return ctx.clear(t.dataset.frClear);
    if (t.dataset.frClose) return closeSheet();
    if (t.dataset.frReset) return ctx.clearAll();
    if (t.dataset.frFav) return ctx.toggleBookmarks();
    if (t.dataset.frSave) return ctx.save();
    if (t.dataset.frToggle) {
      const group = t.dataset.frToggle;
      const id = t.dataset.id;
      // Optimistic instant visual update:
      const willBeOn = !t.classList.contains('on');
      t.classList.toggle('on', willBeOn);
      t.setAttribute('aria-pressed', String(willBeOn));
      return ctx.toggle(group, id);
    }
    if (t.dataset.frSec) {
      const k = t.dataset.frSec;
      const opening = !openSecs.has(k);
      // Accordion: opening a section closes the others (aria-expanded follows via paintSheet).
      if (opening) { openSecs.clear(); openSecs.add(k); } else openSecs.delete(k);
      paintSheet(ctx);
      if (opening) reveal(sheet.querySelector(`#fr-sec-${k}`), true);
    }
    if (t.dataset.frIgroup !== undefined) {
      const k = t.dataset.frIgroup;
      const opening = !openInstGyms.has(k);
      opening ? openInstGyms.add(k) : openInstGyms.delete(k);
      paintSheet(ctx);
      if (opening) reveal(sheet.querySelector(`.fr-igroup-head[data-fr-igroup="${CSS.escape(k)}"]`)?.parentElement, false);
    }
  };
}

function updateSheetState(sheet, ctx) {
  if (!sheet) return;
  const { state } = ctx;
  const total = selectedCount(state);

  const badge = sheet.querySelector('.fr-badge');
  if (badge) badge.textContent = `${ctx.resultCount} ${ctx.resultCount === 1 ? COPY.filters.class : COPY.filters.classes}`;

  const resetBtn = sheet.querySelector('.fr-reset');
  if (resetBtn) resetBtn.disabled = !total;

  const doneBtn = sheet.querySelector('.fr-done');
  if (doneBtn) doneBtn.textContent = ctx.resultCount === 0 ? COPY.filters.noClassesAdjust : COPY.filters.showClasses;

  const favBtn = sheet.querySelector('[data-fr-fav]');
  if (favBtn) {
    favBtn.classList.toggle('on', !!state.bookmarks);
    favBtn.setAttribute('aria-pressed', String(!!state.bookmarks));
    favBtn.querySelector('svg')?.setAttribute('fill', state.bookmarks ? 'currentColor' : 'none');
  }

  sheet.querySelectorAll('[data-fr-toggle]').forEach((btn) => {
    const on = ctx.isOn(btn.dataset.frToggle, btn.dataset.id);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  });

  const nameOf = {
    locations: state.locations.map(id => { const l = ctx.locations.find(x => String(x.id) === id); return l ? ctx.locationLabel(l) : id; }),
    instructors: state.instructors.map(id => ctx.instructors.find(x => String(x.id) === id)?.name || id),
  };

  const updateSec = (key, summary, count, clearKey) => {
    const secEl = sheet.querySelector(`#fr-sec-${key}`);
    if (!secEl) return;
    const sumEl = secEl.querySelector('.fr-sec-sum');
    if (sumEl) {
      sumEl.textContent = summary;
      sumEl.classList.toggle('has', count > 0);
    }
    const secRow = secEl.querySelector('.fr-sec-row');
    let clearBtn = secRow?.querySelector('.fr-sec-clear');
    if (count > 0 && !clearBtn && secRow) {
      clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'fr-sec-clear';
      clearBtn.dataset.frClear = clearKey;
      clearBtn.textContent = COPY.filters.clear;
      secRow.appendChild(clearBtn);
    } else if (count === 0 && clearBtn) {
      clearBtn.remove();
    }
  };

  updateSec('locations', summarise(nameOf.locations), state.locations.length, 'locations');
  updateSec('workouts', summarise(state.eventTypes), state.eventTypes.length, 'eventTypes');
  updateSec('instructors', summarise(nameOf.instructors), state.instructors.length, 'instructors');

  sheet.querySelectorAll('.fr-igroup').forEach((ig) => {
    const head = ig.querySelector('.fr-igroup-head');
    const gid = head?.dataset.frIgroup;
    if (!gid) return;
    const list = ctx.instructors.filter(i => (i.gymId || '') === gid);
    const picked = list.filter(i => state.instructors.includes(String(i.id))).length;
    let countEl = head.querySelector('.fr-count');
    if (picked > 0) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'fr-count';
        head.insertBefore(countEl, head.querySelector('.fr-chev'));
      }
      countEl.textContent = String(picked);
    } else if (countEl) {
      countEl.remove();
    }
  });
}

export function wireDragToDismiss(sheet, onDismiss) {
  if (!sheet) return;
  const handle = sheet.querySelector('.fr-grab');
  const head = sheet.querySelector('.fr-head');
  let startY = 0;
  let currentY = 0;
  let isDragging = false;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    currentY = startY;
    isDragging = true;
    sheet.style.transition = 'none';
  };

  const onTouchMove = (e) => {
    if (!isDragging) return;
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy > 0) {
      sheet.style.transform = `translateY(${dy}px)`;
      if (e.cancelable) e.preventDefault();
    }
  };

  const onTouchEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    const dy = currentY - startY;
    sheet.style.transition = '';
    if (dy > 70) {
      sheet.style.transform = '';
      onDismiss();
    } else {
      sheet.style.transform = '';
    }
  };

  handle?.addEventListener('touchstart', onTouchStart, { passive: true });
  handle?.addEventListener('touchmove', onTouchMove, { passive: false });
  handle?.addEventListener('touchend', onTouchEnd, { passive: true });

  head?.addEventListener('touchstart', (e) => {
    if (e.target.closest('button, input')) return;
    onTouchStart(e);
  }, { passive: true });
  head?.addEventListener('touchmove', (e) => {
    if (isDragging) onTouchMove(e);
  }, { passive: false });
  head?.addEventListener('touchend', onTouchEnd, { passive: true });
}

export function getLastCtx() { return lastCtx; }
