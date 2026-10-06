// Pure decision logic for the mobile scroll-collapse (header hide + timetable compact bar).
// One state, `collapsed`, drives both: the header slides away and the date strip / location chip
// shrink together, and both come back together. Kept DOM-free so the hysteresis is unit-testable.
//
// Hysteresis comes from four things: a dead zone of net travel before a direction counts (slow drags
// add up because the anchor only moves when we act), top/bottom edge zones (iOS bounce), a "busy"
// cool-down after each toggle or programmatic scroll (merge-in anchor restore), and rubber-band
// samples (scrollTop < 0 or > max) being ignored outright.

export const COLLAPSE_TUNING = Object.freeze({ deadZone: 12, edgeZone: 32, topZone: 4 });

/**
 * @param {{top:number,max:number,anchor:number,collapsed:boolean,busy:boolean,modalOpen:boolean,headerH:number}} s
 * @returns {{collapsed:boolean, anchor:number}}  next state (anchor/collapsed unchanged = no-op)
 */
export function nextCollapseState(s, t = COLLAPSE_TUNING) {
  const { top, max, anchor, collapsed, busy, modalOpen, headerH } = s;
  // Too short to scroll meaningfully: never collapsed.
  if (max < headerH + 48) return { collapsed: false, anchor: 0 };
  // iOS rubber-band: not real scrolling.
  if (top < 0 || top > max) return { collapsed, anchor };
  if (modalOpen || top <= t.topZone) return { collapsed: false, anchor: top };
  if (busy) return { collapsed, anchor: top };                       // settle, then re-baseline
  if (top >= max - t.edgeZone) return { collapsed, anchor: top };    // bottom bounce zone: keep state
  if (top <= t.edgeZone && !collapsed) return { collapsed, anchor: top };
  const delta = top - anchor;
  if (Math.abs(delta) < t.deadZone) return { collapsed, anchor };    // dead zone
  return { collapsed: delta > 0, anchor: top };
}
