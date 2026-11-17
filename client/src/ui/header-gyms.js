// DOM controller for the collapsible gym header (state lives in header-gyms-state.js).
//
// Markup: #app-hgym > #app-header-credits (the chip strip, rebuilt constantly by
// updateCreditBadge) + #app-hgym-ring (total-progress button) + a polite live region.
// Plain mode leaves the strip exactly as it always was. Collapsible mode shows only
// the ring; tapping it slides the chips out (no fetch) and they slide back 5 s after
// the last gym finishes. The chip BACKGROUND fade is a class on the strip container so
// it survives chip rebuilds.

import { COPY, formatCopyText } from '../copy.js';
import { onGymLoadChange, loadingGymIds, isGymLoading } from './gym-load-state.js';
import {
  computeMode, normaliseSetting, createWaveTracker, createHeaderGymsMachine, createFadeMachine,
} from './header-gyms-state.js';

const END_HOLD_MS = 400;     // ring shows 100% briefly before going idle
const TALL_RATIO = 0.3;      // transient extra bar height when the strip overflows

let setting = 'auto';
let ids = [];
let attention = false;
let mode = 'plain';
let wrap, strip, ring, arc, glow, attnEl, live, header;
let machine, fade, waves;
let endTimer = null;
let wasCollapsibleWave = false;
let reflowRaf = 0;
let initDone = false;
let focusFirstChip = false;

const $ = (id) => document.getElementById(id);
const anyLoading = () => loadingGymIds().some((g) => ids.includes(String(g)));

export function initHeaderGyms() {
  if (initDone) return;
  wrap = $('app-hgym'); strip = $('app-header-credits'); ring = $('app-hgym-ring');
  live = $('app-hgym-live'); header = document.querySelector('.app-header');
  if (!wrap || !strip || !ring) return;
  initDone = true;
  arc = ring.querySelector('.app-hgym-arc');
  glow = ring.querySelector('.app-hgym-glow');
  attnEl = ring.querySelector('.app-hgym-attn');
  waves = createWaveTracker();

  machine = createHeaderGymsMachine({ isLoading: anyLoading, onState: applyState });
  fade = createFadeMachine({ onChange: (s) => strip.classList.toggle('is-muted', s === 'muted') });
  fade.markStrong();

  ring.addEventListener('click', (e) => {
    const keyboard = e.detail === 0;
    const wasOpen = wrap.classList.contains('is-open');
    machine.tap();
    if (keyboard && !wasOpen) focusFirstChip = true;
  });
  strip.addEventListener('pointerdown', () => machine.interact(), { passive: true });
  strip.addEventListener('scroll', () => machine.interact(), { passive: true });
  strip.addEventListener('focusin', (e) => {
    machine.interact();
    if (e.target.matches?.(':focus-visible')) machine.focusIn();
  });
  strip.addEventListener('focusout', (e) => {
    if (!strip.contains(e.relatedTarget)) machine.focusOut();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && strip.contains(document.activeElement)) { e.stopPropagation(); machine.escape(); ring.focus(); }
  });
  strip.addEventListener('transitionend', (e) => {
    if (e.target === strip && e.propertyName === 'clip-path') machine.settled();
  });

  onGymLoadChange(onLoadChange);
  render();
}

export function setMode(next) {
  setting = normaliseSetting(next);
  render();
}

/** Called at the end of every updateCreditBadge render. */
export function syncGyms(gymIds, needsAttention = false) {
  const hadChips = ids.length > 0;
  ids = (gymIds || []).map(String);
  // The chips are first SEEN now: "first load" strength starts here, not at boot (they do not exist yet).
  if (!hadChips && ids.length && fade) { fade.markStrong(); if (anyLoading()) fade.loadBegin(); }
  attention = !!needsAttention;
  render();
}

/** Pull-to-refresh and cold boot: chips return to full strength, then fade again. */
export function markStrong() { if (fade) fade.markStrong(); }

/** The hide-on-scroll header is leaving: snap closed so its height matches the collapsed bar. */
export function onHeaderHidden() { if (machine) machine.headerHidden(); }

/** Transient extra bar height (px) that must NOT be added to the content offset. */
export function headerExtraPx() {
  if (!header || header.classList.contains('hgym-tall-pinned')) return 0;
  return parseFloat(getComputedStyle(header).getPropertyValue('--hgym-x')) || 0;
}

/** Plain-mode overflow (Always): scroll the strip and keep a permanently taller bar. */
export function setOverflow(overflowing) {
  if (!strip || !header) return;
  const pinned = overflowing && mode === 'plain';
  strip.classList.toggle('is-scrolling', overflowing);
  header.classList.toggle('hgym-tall', pinned || header.classList.contains('hgym-tall-open'));
  header.classList.toggle('hgym-tall-pinned', pinned);
  if (pinned) setExtra();
}

export function getMode() { return mode; }

function setExtra() {
  // base bar height = current height minus whatever extra is already applied
  const base = header.offsetHeight - (parseFloat(getComputedStyle(header).getPropertyValue('--hgym-x')) || 0);
  header.style.setProperty('--hgym-extra', `${Math.round((base || 47) * TALL_RATIO)}px`);
}

function render() {
  if (!initDone) return;
  const next = computeMode(setting, ids.length);
  const changed = next !== mode;
  mode = next;
  wrap.dataset.mode = mode;
  ring.hidden = mode !== 'collapsible';
  header.classList.toggle('hgym-on', mode === 'collapsible');
  machine.setCollapsible(mode === 'collapsible');
  if (changed && mode === 'plain') teardown();
  if (changed && mode === 'collapsible') { // plain-mode overflow state (pinned tall bar, scrolling) no longer applies
    header.classList.remove('hgym-tall-pinned');
    header.classList.toggle('hgym-tall', header.classList.contains('hgym-tall-open'));
    strip.classList.remove('is-scrolling');
  }
  if (changed) document.dispatchEvent(new CustomEvent('hgym-mode', { detail: mode }));
  if (mode === 'plain') { strip.inert = false; strip.removeAttribute('aria-hidden'); }
  else strip.inert = machine.state === 'collapsed';
  attnEl.hidden = !(attention && mode === 'collapsible');
  syncWave(false);
  labelRing();
  if (mode === 'collapsible' && machine.state !== 'collapsed') reflow();
}

function teardown() {
  wrap.classList.remove('is-open', 'is-animating');
  wrap.dataset.state = 'collapsed';
  header.classList.remove('hgym-tall-open', 'hgym-open');
  header.classList.toggle('hgym-tall', header.classList.contains('hgym-tall-pinned'));
  strip.classList.remove('is-scrolling');
  strip.querySelectorAll('button').forEach((c) => c.style.removeProperty('--dx'));
}

function onLoadChange() {
  if (!initDone) return;
  const loading = anyLoading();
  if (loading) { machine.loadBegin(); fade.loadBegin(); }
  else { machine.storeIdle(); fade.storeIdle(); }
  syncWave(true);
  if (!loading) return;
  // chips may have been rebuilt mid-slide
  if (machine.state === 'expanding' || machine.state === 'expanded') reflow();
}

function syncWave(fromStore) {
  const w = waves.sync(loadingGymIds(), ids);
  const collapsedNow = mode === 'collapsible' && machine.state === 'collapsed';
  if (w.started && collapsedNow && fromStore) announce(COPY.shell.hgymLiveStart);
  if (w.active) {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    ring.classList.add('is-active');
    ring.classList.remove('is-settled');
    const off = String(100 - Math.round(w.pct * 100));
    arc.style.strokeDashoffset = off;
    if (glow) glow.style.strokeDashoffset = off;
    ring.dataset.progress = `${w.done}/${w.total}`;
    wasCollapsibleWave = collapsedNow;
  } else if (w.ended) {
    ring.classList.add('is-settled');
    arc.style.strokeDashoffset = '0';
    if (glow) glow.style.strokeDashoffset = '0';
    if (wasCollapsibleWave && fromStore) announce(COPY.shell.hgymLiveEnd);
    endTimer = setTimeout(() => {
      endTimer = null;
      ring.classList.remove('is-active', 'is-settled');
      delete ring.dataset.progress;
      labelRing();
    }, END_HOLD_MS);
  }
  labelRing();
}

function announce(text) {
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

function labelRing() {
  if (!ring) return;
  const open = wrap.classList.contains('is-open');
  ring.setAttribute('aria-expanded', String(open));
  let label;
  if (open) label = COPY.shell.hgymHide;
  else if (ring.dataset.progress) {
    const [done, total] = ring.dataset.progress.split('/');
    label = formatCopyText(COPY.shell.hgymShowLoading, { count: ids.length, done, total });
  } else label = formatCopyText(COPY.shell.hgymShow, { count: ids.length });
  if (attention && !open) label += `. ${COPY.shell.hgymAttention}`;
  ring.setAttribute('aria-label', label);
}

/** Measure each chip's travel from the ring (transform-free), so the slide starts AT the ring. */
function measureTravel() {
  measuring(measureTravelNow);
}
function measureTravelNow() {
  const rr = ring.getBoundingClientRect();
  const cx = rr.left + rr.width / 2;
  const kids = [...strip.querySelectorAll('button')];
  kids.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--dx', `${Math.round(cx - (r.left + r.width / 2))}px`);
    c.style.setProperty('--i', String(Math.min(kids.length - 1 - i, 6)));
  });
}

function syncPadding() {
  const cs = getComputedStyle(header);
  strip.style.setProperty('--hgym-pl', cs.paddingLeft);
  strip.style.setProperty('--hgym-pr', cs.paddingRight);
  strip.style.setProperty('--hgym-pt', cs.paddingTop);
}

/** Run a layout measurement with the slide transforms off (a translated chip would inflate scrollWidth). */
function measuring(fn) {
  const wasInstant = wrap.classList.contains('is-instant');
  wrap.classList.add('is-measuring', 'is-instant');
  try { return fn(); } finally {
    wrap.classList.remove('is-measuring');
    void strip.offsetWidth; // flush with transitions off, so restoring the transform does not animate
    if (!wasInstant) wrap.classList.remove('is-instant');
  }
}
const stripOverflows = () => measuring(() => strip.scrollWidth > strip.clientWidth + 1);

/** Compact marks first; only when even those overflow does the strip scroll. */
function fitStrip() {
  strip.classList.remove('app-badges-compact');
  if (stripOverflows()) strip.classList.add('app-badges-compact');
}

function reflow() {
  cancelAnimationFrame(reflowRaf);
  reflowRaf = requestAnimationFrame(() => {
    if (mode !== 'collapsible' || machine.state === 'collapsed') return;
    fitStrip();
    measureTravel();
    const overflowing = stripOverflows();
    strip.classList.toggle('is-scrolling', overflowing);
    header.classList.toggle('hgym-tall-open', overflowing);
    if (overflowing) setExtra();
    header.classList.toggle('hgym-tall', overflowing || header.classList.contains('hgym-tall-pinned'));
  });
}

function applyState(state, { animate }) {
  wrap.dataset.state = state;
  if (state === 'expanding') {
    syncPadding();
    strip.inert = false;
    wrap.classList.add('is-animating');
    header.classList.add('hgym-open');
    // Travel + overflow need the strip laid out, then the slide starts next frame.
    fitStrip();
    measureTravel();
    requestAnimationFrame(() => {
      const overflowing = stripOverflows();
      strip.classList.toggle('is-scrolling', overflowing);
      header.classList.toggle('hgym-tall-open', overflowing);
      if (overflowing) setExtra();
      header.classList.toggle('hgym-tall', overflowing || header.classList.contains('hgym-tall-pinned'));
      wrap.classList.add('is-open');
      labelRing();
      if (focusFirstChip) { focusFirstChip = false; strip.querySelector('button')?.focus(); } // only focusable once visible
    });
  } else if (state === 'expanded') {
    wrap.classList.remove('is-animating');
  } else if (state === 'collapsing') {
    wrap.classList.add('is-animating');
    wrap.classList.remove('is-open');
    header.classList.remove('hgym-open');
    ring.classList.add('is-absorb');
    setTimeout(() => ring.classList.remove('is-absorb'), 200);
  } else { // collapsed
    wrap.classList.remove('is-open', 'is-animating');
    header.classList.remove('hgym-open', 'hgym-tall-open');
    header.classList.toggle('hgym-tall', header.classList.contains('hgym-tall-pinned'));
    if (mode === 'collapsible') { strip.inert = true; strip.classList.remove('is-scrolling'); }
    strip.scrollLeft = 0;
    }
  labelRing();
  if (!animate) {
    wrap.classList.add('is-instant');
    header.classList.add('hgym-instant');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wrap.classList.remove('is-instant');
      header.classList.remove('hgym-instant');
    }));
  }
}
