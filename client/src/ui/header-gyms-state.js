// Collapsible gym header: the pure state. No DOM access, timers injected (fake-timer friendly).
//
//  - computeMode: plain strip (as before) vs a single progress ring that expands the strip on tap
//  - createWaveTracker: ONE total-progress figure across the per-gym load store (gym-load-state.js)
//  - createHeaderGymsMachine: collapsed -> expanding -> expanded -> collapsing and the 5 s hold timer
//  - createFadeMachine: chip backgrounds start strong (first load, pull-to-refresh) then settle to muted

export const COLLAPSE_AT = 5;        // "Automatic" collapses from this many gyms
export const HOLD_MS = 5000;         // strip stays open this long after the last gym finishes
export const SETTLE_MS = 700;        // fallback for transitionend
export const FADE_SETTLE_MS = 800;   // idle this long after the first wave, then fade the chip backgrounds
export const FADE_MAX_WAIT_MS = 4000; // no load at all within this: fade anyway

export const HEADER_GYMS_MODES = ['auto', 'always', 'never'];

export function normaliseSetting(v) {
  return HEADER_GYMS_MODES.includes(v) ? v : 'auto';
}

/** 'collapsible' = ring + slide-out strip; 'plain' = the strip exactly as it always was. */
export function computeMode(setting, gymCount) {
  const s = normaliseSetting(setting);
  if (s === 'never') return 'collapsible';
  if (s === 'always') return 'plain';
  return gymCount >= COLLAPSE_AT ? 'collapsible' : 'plain';
}

/**
 * Aggregate progress. A wave starts when something loads while idle and ends when nothing does.
 * pct = gyms finished / gyms touched this wave (a late joiner grows the denominator).
 * Gyms that are not rendered chips are ignored.
 */
export function createWaveTracker() {
  let wave = null;
  return {
    /** @returns {{active:boolean, pct:number, total:number, done:number, started:boolean, ended:boolean}} */
    sync(loadingIds, renderedIds) {
      const rendered = new Set((renderedIds || []).map(String));
      const loading = new Set((loadingIds || []).map(String).filter((id) => rendered.has(id)));
      let started = false;
      if (!wave && loading.size) { wave = { gyms: new Set() }; started = true; }
      if (!wave) return { active: false, pct: 0, total: 0, done: 0, started: false, ended: false };
      loading.forEach((id) => wave.gyms.add(id));
      const total = wave.gyms.size;
      const done = [...wave.gyms].filter((id) => !loading.has(id)).length;
      if (loading.size === 0) {
        wave = null;
        return { active: false, pct: 1, total, done: total, started: false, ended: true };
      }
      return { active: true, pct: done / total, total, done, started, ended: false };
    },
    reset() { wave = null; },
  };
}

const T = {
  set: (...a) => globalThis.setTimeout(...a),
  clear: (...a) => globalThis.clearTimeout(...a),
};

/**
 * @param {{ isLoading:()=>boolean, onState:(state:string, info:{animate:boolean})=>void,
 *           holdMs?:number, settleMs?:number }} deps
 */
export function createHeaderGymsMachine(deps) {
  const holdMs = deps.holdMs ?? HOLD_MS;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  let state = 'collapsed';
  let collapsible = true;
  let holdTimer = null;
  let settleTimer = null;
  let focusInside = false;

  const clearHold = () => { if (holdTimer != null) { T.clear(holdTimer); holdTimer = null; } };
  const clearSettle = () => { if (settleTimer != null) { T.clear(settleTimer); settleTimer = null; } };
  const isOpen = () => state === 'expanding' || state === 'expanded';
  const set = (s, animate = true) => { state = s; deps.onState(s, { animate }); };

  const collapse = (animate = true) => {
    clearHold(); clearSettle();
    if (state === 'collapsed') return;
    if (!animate) { set('collapsed', false); return; }
    set('collapsing');
    settleTimer = T.set(() => { settleTimer = null; if (state === 'collapsing') set('collapsed'); }, settleMs);
  };
  const arm = () => {
    clearHold();
    holdTimer = T.set(() => { holdTimer = null; if (isOpen() && !focusInside) collapse(); }, holdMs);
  };
  const armIfIdle = () => { if (isOpen() && !deps.isLoading() && !focusInside) arm(); };
  const expand = () => {
    clearSettle();
    set('expanding');
    settleTimer = T.set(() => { settleTimer = null; if (state === 'expanding') set('expanded'); }, settleMs);
    armIfIdle();
  };

  return {
    get state() { return state; },
    tap() {
      if (!collapsible) return;
      if (isOpen()) collapse(); else expand();
    },
    /** The CSS transition finished (earlier than the fallback). */
    settled() {
      clearSettle();
      if (state === 'expanding') set('expanded');
      else if (state === 'collapsing') set('collapsed');
    },
    loadBegin() { if (isOpen()) clearHold(); },
    storeIdle() { armIfIdle(); },
    interact() { if (isOpen() && !deps.isLoading() && !focusInside) arm(); },
    focusIn() { focusInside = true; clearHold(); },
    focusOut() { focusInside = false; armIfIdle(); },
    escape() { if (isOpen()) collapse(); },
    headerHidden() { collapse(false); },
    setCollapsible(on) {
      collapsible = !!on;
      if (!collapsible) { focusInside = false; collapse(false); }
    },
  };
}

/** strong -> muted. `markStrong()` at boot and at the start of a pull-to-refresh. */
export function createFadeMachine({ onChange, settleMs = FADE_SETTLE_MS, maxWaitMs = FADE_MAX_WAIT_MS }) {
  let state = 'strong';
  let sawLoad = false;
  let settleTimer = null;
  let maxTimer = null;
  const clear = () => {
    if (settleTimer != null) { T.clear(settleTimer); settleTimer = null; }
    if (maxTimer != null) { T.clear(maxTimer); maxTimer = null; }
  };
  const mute = () => { clear(); if (state !== 'muted') { state = 'muted'; onChange(state); } };
  return {
    get state() { return state; },
    markStrong() {
      clear();
      sawLoad = false;
      if (state !== 'strong') { state = 'strong'; onChange(state); }
      maxTimer = T.set(mute, maxWaitMs);
    },
    loadBegin() {
      if (state !== 'strong') return;
      sawLoad = true;
      clear();
    },
    storeIdle() {
      if (state !== 'strong' || !sawLoad) return;
      clear();
      settleTimer = T.set(mute, settleMs);
    },
  };
}
