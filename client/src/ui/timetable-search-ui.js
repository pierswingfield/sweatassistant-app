// Timetable search box + autocomplete (DOM only). Owns no filter state and no
// matching logic: suggestions come from timetable-search.js, the committed text
// lives in timetable-search-state.js, and picks are handed back to timetable.js
// (`applyPick`) so they land on the EXISTING filter system.
//
// ARIA: ARIA 1.2 combobox (input role=combobox, listbox popup, aria-activedescendant).
// Mobile: collapsed behind an icon in the filter rail, expands to a full-width
// input and collapses again when empty on blur/Esc. Desktop: always-visible
// inline input at the head of the filter row.

import { COPY, formatCopyText } from '../copy.js';
import { escapeHtml, icon } from './cards.js';
import { suggest } from './timetable-search.js';
import { getSearchQuery, setSearchQuery, clearSearch, onSearchChange } from './timetable-search-state.js';

const ID = 'app-search';
let hooks = null;       // { getIndex, isLoading, applyPick }
let items = [];         // flat, selectable options currently shown
let active = -1;
let unsub = null;

const el = () => document.getElementById(ID);
const input = () => el()?.querySelector('.app-search-input');
const list = () => el()?.querySelector('.app-search-list');

function isOpen() { return el()?.classList.contains('open'); }

function setHostState(open) {
  document.getElementById('app-timetable-filters-container')?.classList.toggle('app-searching', !!open);
}

export function openSearch({ focus = true, suggestions = true } = {}) {
  const root = el();
  if (!root) return;
  root.classList.add('open');
  setHostState(true);
  const inp = input();
  inp.value = getSearchQuery();
  if (focus) inp.focus();
  if (suggestions) paintList(); else closeList();
}

function collapse(refocus = false) {
  const root = el();
  if (!root) return;
  closeList();
  // Desktop keeps the box in the row; mobile folds back to the rail icon.
  root.classList.remove('open');
  setHostState(false);
  if (refocus) document.getElementById('app-filter-rail')?.querySelector('[data-fr-search]')?.focus?.();   // keyboard users only
}

function closeList() {
  const l = list();
  if (l) { l.hidden = true; l.innerHTML = ''; }
  input()?.setAttribute('aria-expanded', 'false');
  input()?.removeAttribute('aria-activedescendant');
  items = []; active = -1;
}

function setActive(i) {
  active = i;
  const l = list();
  l?.querySelectorAll('[role=option]').forEach((o, n) => {
    const on = n === i;
    o.setAttribute('aria-selected', on ? 'true' : 'false');
    o.classList.toggle('active', on);
    if (on) { input().setAttribute('aria-activedescendant', o.id); o.scrollIntoView?.({ block: 'nearest' }); }
  });
  if (i < 0) input()?.removeAttribute('aria-activedescendant');
}

function paintList() {
  const l = list(), inp = input();
  if (!l || !inp) return;
  const text = inp.value.trim();
  if (!text) { closeList(); return; }
  items = [{ type: 'text', label: text }];
  let html = '';
  let n = 0;
  const opt = (it, body) => `<div class="app-search-opt" role="option" id="app-sg-${n}" data-i="${n++}" aria-selected="false">${body}</div>`;
  html += opt(items[0], `<span class="ss-ico">${icon('search', 14)}</span><span class="ss-label">${escapeHtml(formatCopyText(COPY.search.searchFor, { text }))}</span>`);
  if (hooks.isLoading()) {
    html += `<div class="app-search-note" role="status">${COPY.search.loading}</div>`;
  } else {
    for (const g of suggest(hooks.getIndex(), text)) {
      html += `<div role="group" aria-label="${escapeHtml(groupLabel(g.type))}"><div class="app-search-head" aria-hidden="true">${escapeHtml(groupLabel(g.type))}</div>`;
      for (const it of g.items) {
        items.push(it);
        html += opt(it, `<span class="ss-label">${escapeHtml(it.label)}${it.sub ? ` <span class="ss-sub">${escapeHtml(it.sub)}</span>` : ''}</span>`
          + `<span class="ss-count">${escapeHtml(formatCopyText(COPY.search.count, { count: it.count }))}</span>`);
      }
      html += `</div>`;
    }
  }
  l.innerHTML = html;
  l.hidden = false;
  inp.setAttribute('aria-expanded', 'true');
  active = -1;
}

function commitText(text) {
  setSearchQuery(text);
  closeList();
  if (matchMobile()) collapse(); else input()?.blur();
}

function choose(i) {
  const it = items[i];
  if (!it) return;
  if (it.type === 'text') { commitText(it.label); return; }
  if (it.type === 'class') { input().value = it.label; commitText(it.label); return; }
  input().value = '';
  closeList();
  hooks.applyPick(it);
  if (matchMobile()) collapse();
}

const GROUP_COPY = { instructor: COPY.search.groupInstructor, class: COPY.search.groupClass, location: COPY.search.groupLocation, gym: COPY.search.groupGym, workout: COPY.search.groupWorkout };
const groupLabel = (t) => GROUP_COPY[t] || t;
const matchMobile = () => window.matchMedia('(max-width: 768px)').matches;

function build() {
  const root = document.createElement('div');
  root.id = ID;
  root.className = 'app-search';
  root.innerHTML = `<div class="app-search-box">`
    + `<span class="ss-glass" aria-hidden="true">${icon('search', 16)}</span>`
    + `<input class="app-search-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="app-search-list" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="${escapeHtml(COPY.search.placeholder)}" aria-label="${escapeHtml(COPY.search.label)}">`
    + `<button type="button" class="app-search-x" aria-label="${escapeHtml(COPY.search.clearInput)}" hidden>&#x2715;</button>`
    + `</div><div class="app-search-list" id="app-search-list" role="listbox" aria-label="${escapeHtml(COPY.search.suggestionsAria)}" hidden></div>`;
  const inp = root.querySelector('input');
  const x = root.querySelector('.app-search-x');
  const sync = () => { x.hidden = !inp.value; };

  inp.addEventListener('input', () => { sync(); paintList(); });
  inp.addEventListener('focus', () => { if (inp.value.trim()) paintList(); });
  inp.addEventListener('keydown', (e) => {
    const n = items.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!list().hidden && n) setActive((active + 1) % n); else paintList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive(active <= 0 ? n - 1 : active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(active);
      else if (inp.value.trim()) commitText(inp.value);
      else { clearSearch(); if (matchMobile()) collapse(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!list().hidden) { closeList(); }
      else { inp.value = getSearchQuery(); sync(); if (matchMobile()) collapse(true); else inp.blur(); }
    }
  });
  inp.addEventListener('blur', () => {
    // A tap on an option must not collapse the box first: the list swallows
    // mousedown (below), so blur here means the user really left.
    if (matchMobile()) { closeList(); root.classList.remove('open'); setHostState(false); }
  });
  x.addEventListener('mousedown', (e) => e.preventDefault());
  x.addEventListener('click', () => {
    inp.value = ''; sync(); closeList();
    if (getSearchQuery()) clearSearch();
    inp.focus();
  });
  const l = root.querySelector('.app-search-list');
  l.addEventListener('mousedown', (e) => e.preventDefault());   // keep input focus
  l.addEventListener('click', (e) => {
    const o = e.target.closest('[role=option]');
    if (o) choose(Number(o.dataset.i));
  });
  root.syncClear = sync;
  return root;
}

/**
 * Idempotent; called on every timetable render. Places the box where the current
 * viewport wants it and (re)wires the hooks. Never rebuilds an existing box, so
 * focus and typed text survive the re-render a pick triggers.
 */
export function ensureSearchUi(h) {
  hooks = h;
  const host = document.getElementById('app-timetable-filters-container');
  if (!host) return;
  let root = el();
  if (!root) root = build();
  const mobile = matchMobile();
  const row = host.querySelector('.app-filters-row');
  const wantParent = mobile || !row ? host : row;
  if (root.parentElement !== wantParent) {
    if (wantParent === host) host.appendChild(root); else row.prepend(root);
    if (!mobile) { root.classList.remove('open'); setHostState(false); }
  }
  const inp = root.querySelector('input');
  if (document.activeElement !== inp) { inp.value = getSearchQuery(); root.syncClear(); }
  if (!unsub) {
    unsub = onSearchChange((q) => {
      const i = input();
      if (i && document.activeElement !== i) { i.value = q; el()?.syncClear(); }
    });
  }
}

export function removeSearchUi() { el()?.remove(); setHostState(false); }
