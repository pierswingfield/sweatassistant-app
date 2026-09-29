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

// Aliases come from the gym config (ctx.locationAlias). This is only the
// fallback for a location that has none: word initials, or the first 3 letters.
export function compressStudioName(name = '') {
  const clean = String(name).trim();
  const words = clean.split(/[\s/&-]+/).filter(Boolean);
  if (words.length <= 1) return clean.slice(0, 3).toUpperCase();
  return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
}

let sheetEl = null;
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
function gymPlate(gymId) {
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

function chip(html, clearKey, label) {
  return `<span class="fr-chip" role="group" aria-label="${escapeHtml(label)}">`
    + `<button type="button" class="fr-chip-body" data-fr-open="1" data-fr-section="${CHIP_SECTION[clearKey] || ''}">${html}</button>`
    + `<button type="button" class="fr-chip-x" data-fr-clear="${clearKey}" aria-label="Clear ${escapeHtml(label)}">&#x2715;</button>`
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

function workoutLabel(s) {
  if (s.eventTypes.length === 1) return escapeHtml(s.eventTypes[0]);
  if (s.eventTypes.length === 2) return dotJoin(s.eventTypes);
  return `<b class="fr-num">${s.eventTypes.length}</b><span class="fr-thin">Types</span>`;
}

export function renderFilterRail(ctx) {
  lastCtx = ctx;
  const host = document.getElementById('psycle-timetable-filters-container');
  if (!host) return;
  let rail = document.getElementById('sweat-filter-rail');
  if (!rail) {
    rail = document.createElement('div');
    rail.id = 'sweat-filter-rail';
    rail.className = 'fr-rail';
    host.prepend(rail);
  }
  const { state } = ctx;
  const parts = [];

  // No filters applied: the button also says "Filters"; once any chip exists it is icon-only. The rail is
  // re-rendered on every filter change, so this re-evaluates for free.
  const noFilters = selectedCount(state) === 0;
  parts.push(`<button type="button" class="fr-trigger${noFilters ? ' has-label' : ''}" data-fr-open="1" aria-label="Filters${selectedCount(state) ? `, ${selectedCount(state)} active` : ''}">${icon('filter', 16)}${noFilters ? '<span class="fr-trigger-label">Filters</span>' : ''}</button>`);

  if (state.gyms.length || state.locations.length) {
    parts.push(chip(gymTileHtml(ctx), 'gyms', 'gym and location filters'));
  }
  if (state.eventTypes.length) {
    // One generic workout glyph (the same one JAB's TRAIN uses), not the first
    // pick's own icon, so the chip reads the same whatever is selected.
    parts.push(chip(`${icon(getDiscipline('train').icon, 13)}<span>${workoutLabel(state)}</span>`, 'eventTypes', 'workout filters'));
  }
  if (state.instructors.length) {
    const first = ctx.instructors.find(i => String(i.id) === state.instructors[0]);
    const body = state.instructors.length === 1
      ? `${avatar(first)}<span>${escapeHtml(((first && first.name) || 'Instructor').split(' ')[0])}</span>`
      : `${icon('user', 13)}<span><b class="fr-num">${state.instructors.length}</b><span class="fr-thin">Instructors</span></span>`;
    parts.push(chip(body, 'instructors', 'instructor filters'));
  }
  if (ctx.canBookmark) {
    // The spacer soaks up free width, so the heart rides the right edge until
    // the chips reach it; once the row overflows the spacer is 0 and the heart is
    // just the last chip in the scroll.
    const heart = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="${state.bookmarks ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z"/></svg>`;
    parts.push(`<span class="fr-spacer" aria-hidden="true"></span>`);
    parts.push(`<button type="button" class="fr-heart${state.bookmarks ? ' active' : ''}" data-fr-heart="1" aria-pressed="${state.bookmarks}" aria-label="Bookmarked classes only">${heart}</button>`);
  }
  rail.innerHTML = parts.join('');

  rail.onclick = (e) => {
    const clear = e.target.closest('[data-fr-clear]');
    if (clear) { ctx.clear(clear.dataset.frClear); return; }
    if (e.target.closest('[data-fr-heart]')) { ctx.toggleBookmarks(); return; }
    const opener = e.target.closest('[data-fr-open]');
    if (opener) openSheet(ctx, opener.dataset.frSection || null);
  };

  if (sheetEl) paintSheet(ctx);
}

export function removeFilterRail() {
  document.getElementById('sweat-filter-rail')?.remove();
  closeSheet();
}

// U2-7: `focusKey` (from a chip) opens just that section, collapses the rest and
// scrolls it into view. The trigger button passes none and keeps the last state.
function openSheet(ctx, focusKey = null) {
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
    sheetEl.innerHTML = '<div class="fr-sheet" role="dialog" aria-modal="true" aria-label="Filters"></div>';
    sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet(); });
    document.body.appendChild(sheetEl);
    requestAnimationFrame(() => sheetEl && sheetEl.classList.add('open'));
  }
  paintSheet(ctx);
  if (focusKey) {
    // Instant and top-aligned, after the sheet's open animation has laid out.
    const el = sheetEl.querySelector(`#fr-sec-${focusKey}`);
    requestAnimationFrame(() => requestAnimationFrame(() => el && el.scrollIntoView({ block: 'start' })));
  }
}

export function closeSheet() {
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null;
}

// Accordion state survives repaints (every toggle re-renders the timetable,
// which repaints the sheet) so a section doesn't snap shut under your thumb.
const openSecs = new Set(['locations']);
const openInstGyms = new Set();   // instructor sub-sections start collapsed
let instQuery = '';
let instSearching = false;   // results show only while the search box is 'in use'

function summarise(names) {
  if (!names.length) return 'All';
  return names.length <= 3 ? names.join(', ') : `${names.length} selected`;
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
      ${count ? `<button type="button" class="fr-sec-clear" data-fr-clear="${clearKey}">Clear</button>` : ''}
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
      : '<p class="fr-hint">No instructors match.</p>';
  }
  const byGym = new Map();
  ctx.instructors.forEach(i => { const k = i.gymId || ''; (byGym.get(k) || byGym.set(k, []).get(k)).push(i); });
  return [...byGym.entries()].map(([gymId, list]) => {
    const open = openInstGyms.has(gymId);
    const picked = list.filter(i => ctx.state.instructors.includes(String(i.id))).length;
    return `<div class="fr-igroup${open ? ' open' : ''}">
      <button type="button" class="fr-igroup-head" data-fr-igroup="${escapeHtml(gymId)}" aria-expanded="${open}">
        ${gymDot(gymId)}<span class="fr-opt-name">${escapeHtml(gymBrand(gymId).name)}</span>
        ${picked ? `<span class="fr-count">${picked}</span>` : ''}<span class="fr-chev" aria-hidden="true">&#x25BE;</span>
      </button>${open ? `<div class="fr-igroup-body fr-grid">${list.map(i => instructorRow(ctx, i, false)).join('')}</div>` : ''}
    </div>`;
  }).join('') || '<p class="fr-hint">No instructors for the selected gyms.</p>';
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
    ? section('gyms', 'Gyms', summarise(state.gyms.map(gymName)), state.gyms.length, gymInner, 'gyms')
    : `<div class="fr-sec fr-sec-plain">${gymInner}</div>`;

  // One merged grid. ctx.locations is already ordered by gym, so same-gym
  // chips sit together; the round logo on each chip says whose it is.
  const locInner = ctx.locations.length ? `<div class="fr-grid">${ctx.locations.map(l => {
      const on = ctx.isOn('locations', l.id);
      return `<button type="button" class="fr-opt${on ? ' on' : ''}" data-fr-toggle="locations" data-id="${escapeHtml(l.id)}" aria-pressed="${on}">
        ${gymDot(l.gymId, 'sm')}<span class="fr-opt-name">${escapeHtml(ctx.locationLabel(l))}</span></button>`;
    }).join('')}</div>` : '<p class="fr-hint">No locations for the selected gyms.</p>';

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

  const instInner = `<input type="search" class="fr-search" placeholder="Search instructors" value="${escapeHtml(instQuery)}" aria-label="Search instructors" autocomplete="off">
    <div class="fr-list">${instructorListHtml(ctx)}</div>`;

  const nameOf = {
    locations: state.locations.map(id => { const l = ctx.locations.find(x => String(x.id) === id); return l ? ctx.locationLabel(l) : id; }),
    instructors: state.instructors.map(id => ctx.instructors.find(x => String(x.id) === id)?.name || id),
  };

  sheet.innerHTML = `
    <div class="fr-grab" aria-hidden="true"></div>
    <div class="fr-head">
      <div class="fr-title">Filters</div><span class="fr-badge" aria-live="polite">${ctx.resultCount} ${ctx.resultCount === 1 ? 'class' : 'classes'}</span>
      <button type="button" class="fr-reset" data-fr-reset="1"${total ? '' : ' disabled'}>Reset all</button>
      <button type="button" class="fr-close" data-fr-close="1" aria-label="Close filters">&#x2715;</button>
    </div>
    <div class="fr-body">
      ${gymBlock}
      ${section('locations', 'Locations', summarise(nameOf.locations), state.locations.length, locInner, 'locations')}
      ${section('workouts', 'Workouts', summarise(state.eventTypes), state.eventTypes.length, workInner, 'eventTypes')}
      ${section('instructors', 'Instructors', summarise(nameOf.instructors), state.instructors.length, instInner, 'instructors')}
    </div>
    <div class="fr-foot"><button type="button" class="fr-save" data-fr-save="1">Save as default</button><button type="button" class="fr-done" data-fr-close="1">${ctx.resultCount === 0 ? 'No classes \u2013 adjust filters' : 'Show classes'}</button></div>`;

  sheet.querySelector('.fr-body').scrollTop = scrollTop;
  const list = sheet.querySelector('.fr-list');
  if (list) list.scrollTop = listTop;

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
    if (t.dataset.frSave) return ctx.save();
    if (t.dataset.frToggle) return ctx.toggle(t.dataset.frToggle, t.dataset.id);
    if (t.dataset.frSec) {
      const k = t.dataset.frSec;
      const opening = !openSecs.has(k);
      opening ? openSecs.add(k) : openSecs.delete(k);
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

export function getLastCtx() { return lastCtx; }
