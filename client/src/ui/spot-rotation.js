import { COPY } from '../copy.js';
// The ONE display-coordinate helper for rotated studio maps (mobile only). Provider layout coordinates
// stay untouched for selection and booking; only what is drawn is transformed. Labels are never rotated.
export function isMobileWidth() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

/** Rotation to draw with: the studio's policy at <=768px, otherwise 0. */
export function effectiveRotation(degrees) {
  const d = Number(degrees);
  return isMobileWidth() && [0, 90, 180, 270].includes(d) ? d : 0;
}

/** Typical centre-to-centre step of neighbouring spots along a source row (coordinate units). */
function typicalStep(points) {
  const rows = new Map();
  points.forEach((p) => { const k = +p.y.toFixed(3); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(p.x); });
  const gaps = [];
  rows.forEach((xs) => { xs.sort((a, b) => a - b); for (let i = 1; i < xs.length; i++) { const g = xs[i] - xs[i - 1]; if (g > 0.05) gaps.push(g); } });
  if (!gaps.length) return 1;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Collapse every gap along one axis to at most `cap` (order kept; values between known ones interpolate). */
function makeAxisCollapser(values, cap) {
  const vals = [...new Set(values.map((v) => +v.toFixed(3)))].sort((a, b) => a - b);
  const pos = [];
  let acc = 0;
  vals.forEach((v, i) => { if (i) acc += Math.min(v - vals[i - 1], cap); pos.push(acc); });
  return (v) => {
    if (v <= vals[0]) return pos[0] + (v - vals[0]);
    const last = vals.length - 1;
    if (v >= vals[last]) return pos[last] + (v - vals[last]);
    let i = 0; while (i < last && vals[i + 1] < v) i++;
    const span = vals[i + 1] - vals[i];
    return pos[i] + (span > 0 ? (v - vals[i]) / span * (pos[i + 1] - pos[i]) : 0);
  };
}

/** Centre-to-centre px between neighbouring spots on a rotated (compacted) map: 28px spot + 3px gap. */
export const ROTATED_MIN_GAP_PX = 31;

/** Aisle width kept visible after compaction, as a multiple of the normal spot step. */
export const AISLE_STEPS = 1.35;

/**
 * Smallest separation between any two points where the pair is non-overlapping at a given scale, i.e.
 * the min over pairs of max(|dx|, |dy|). Scaling by (spotPx + gap) / this guarantees no two squares overlap
 * (Euclidean nearest-neighbour does not: a diagonal pair can overlap on both axes).
 */
export function minSeparation(points) {
  let m = Infinity;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const d = Math.max(Math.abs(points[i].x - points[j].x), Math.abs(points[i].y - points[j].y));
    if (d > 1e-9 && d < m) m = d;
  }
  return m;
}

/**
 * @param {{x:number,y:number}[]} boundsPoints  points that define the rotation bounds
 * @param {number} rotation  0 | 90 | 180 | 270 (already gated for width)
 * @param {{compact?:boolean}} [opts] compact (default: when rotated) collapses empty gaps along each display
 *   axis to AISLE_STEPS x the normal spot step, so a rotated room keeps its spot spacing instead of being
 *   stretched. Order is preserved and no gap shrinks below the spot step. Unrotated maps are untouched.
 * @returns {(point) => point} adds `sourceY` (the original row y) to every point
 */
export function makeDisplayRotator(boundsPoints, rotation, { compact = rotation !== 0 } = {}) {
  const xs = boundsPoints.map((p) => p.x);
  const ys = boundsPoints.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const turn = (point) => {
    if (rotation === 90) return { ...point, x: point.y - minY, y: maxX - point.x, sourceY: point.y };
    if (rotation === 180) return { ...point, x: maxX - point.x, y: maxY - point.y, sourceY: point.y };
    if (rotation === 270) return { ...point, x: maxY - point.y, y: point.x - minX, sourceY: point.y };
    return { ...point, sourceY: point.y };
  };
  if (!compact || !boundsPoints.length) return turn;
  const cap = typicalStep(boundsPoints) * AISLE_STEPS;
  const turned = boundsPoints.map(turn);
  const cx = makeAxisCollapser(turned.map((p) => p.x), cap);
  const cy = makeAxisCollapser(turned.map((p) => p.y), cap);
  return (point) => { const t = turn(point); return { ...t, x: cx(t.x), y: cy(t.y) }; };
}

/**
 * Uniform (aspect-preserving) fit of display points into a pixel box, for renderers that place items by
 * percentage. ONE scale serves both axes, so the (rotated) map keeps its true proportions and is centred;
 * the old per-axis `(v - min) / range * 78%` stretched whatever shape the room had to fill the box.
 * The scale never drops below what keeps `minGapPx` between the closest two items unless the box WIDTH
 * forces it (then it is width-limited); `neededH` tells the caller how tall the box must be to fit.
 * @param {{x:number,y:number}[]} points display coordinates (already rotated)
 */
/**
 * ONE decision for every studio-map renderer: fit to the width, or keep a minimum spot size and scroll.
 * - rotated (vertical) maps are locked to the available width: fit to width, never scroll sideways;
 * - unrotated maps never shrink below the minimum gap between spots, so a wider map scrolls horizontally.
 * @param {{rotated:boolean, fillScale:number, minGapScale:number}} a fillScale = scale that fits the box
 * @returns {{scale:number, scrolls:boolean}}
 */
export function chooseMapScale({ rotated = false, fillScale, minGapScale }) {
  // Rotated maps are compacted (makeDisplayRotator), so they are NEVER stretched past the minimum-gap
  // scale to fill the width: they keep a readable spot size, are centred, and only shrink if the width forces it.
  if (rotated) return { scale: Math.min(fillScale, minGapScale), scrolls: false };
  const scale = Math.max(fillScale, minGapScale);
  return { scale, scrolls: minGapScale > fillScale };
}

export function makeUniformFit(points, { boxW, boxH, pad = 12, padRight = pad, itemPx = 28, minGapPx = 32, lockWidth = true, rotated = false } = {}) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  let minDist = Infinity;
  if (rotated) minDist = minSeparation(points);
  else for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
    if (d > 0 && d < minDist) minDist = d;
  }
  const minGapScale = Number.isFinite(minDist) ? minGapPx / minDist : Infinity;
  const availW = Math.max(1, boxW - pad - padRight - itemPx), availH = Math.max(1, boxH - 2 * pad - itemPx);
  const fitW = w > 0 ? availW / w : Infinity, fitH = h > 0 ? availH / h : Infinity;
  const heightFit = Math.min(fitW, Math.max(fitH, minGapScale));
  // lockWidth (rotated maps, non-scrolling previews): width-limited. Otherwise the minimum spot size wins
  // and the box grows wider than the container (the caller scrolls it horizontally).
  let scale = rotated ? Math.min(fitW, minGapScale) : lockWidth ? heightFit : chooseMapScale({ rotated: false, fillScale: heightFit, minGapScale }).scale;
  if (!Number.isFinite(scale)) scale = 1;
  const contentW = w * scale + itemPx, contentH = h * scale + itemPx;
  const neededH = Math.ceil(contentH + 2 * pad);
  const neededW = Math.ceil(contentW + pad + padRight);
  const boxHUsed = Math.max(boxH, neededH);
  const boxWUsed = lockWidth ? boxW : Math.max(boxW, neededW);
  const offX = pad + (boxWUsed - pad - padRight - contentW) / 2 + itemPx / 2;
  const offY = (boxHUsed - contentH) / 2 + itemPx / 2;
  return {
    scale, neededH, boxWUsed, scrolls: boxWUsed > boxW,
    xPct: (x) => ((x - minX) * scale + offX) / boxWUsed * 100,
    yPct: (y) => ((y - minY) * scale + offY) / boxHUsed * 100,
    wPct: (units) => (units * scale + itemPx) / boxWUsed * 100,
    hPct: (units) => (units * scale + itemPx) / boxHUsed * 100,
  };
}

// Counter-clockwise order of sides: a 90 degree display turn (x' = y - minY, y' = maxX - x) carries
// top -> left -> bottom -> right -> top, so one step per 90 degrees.
const SIDES_CCW = ['top', 'left', 'bottom', 'right'];

/**
 * Where the room's FRONT is drawn after rotation. `front` is the side in the ORIGINAL provider orientation
 * (gym config spotMap.frontStudios); returns null when unset/unknown so nothing is drawn.
 */
export function displayFrontSide(front, rotation) {
  const i = SIDES_CCW.indexOf(front);
  if (i < 0) return null;
  const steps = (([0, 90, 180, 270].includes(Number(rotation)) ? Number(rotation) : 0) / 90) % 4;
  return SIDES_CCW[(i + steps) % 4];
}

/** Extra room (px) a front marker needs along its edge so spots never touch it. */
export const FRONT_BAR_PX = 12;

/**
 * Subtle "FRONT" bar on one edge of a positioned map box. Mount it inside the same box the spots are
 * placed in (it is absolutely positioned, non-interactive, behind the spots).
 */
export function makeFrontBar(side) {
  if (!['top', 'right', 'bottom', 'left'].includes(side)) return null;
  const el = document.createElement('div');
  el.className = 'app-front-marker';
  el.dataset.side = side;
  el.setAttribute('aria-hidden', 'true');
  el.textContent = COPY.spotMapEditor.front; // upper-cased by CSS
  const t = FRONT_BAR_PX - 3;
  const place = {
    top: `top:2px;left:30%;width:40%;height:${t}px;`,
    bottom: `bottom:2px;left:30%;width:40%;height:${t}px;`,
    left: `left:2px;top:30%;height:40%;width:${t}px;writing-mode:vertical-rl;transform:rotate(180deg);`,
    right: `right:2px;top:30%;height:40%;width:${t}px;writing-mode:vertical-rl;`,
  }[side];
  el.style.cssText = `position:absolute;${place}display:flex;align-items:center;justify-content:center;box-sizing:border-box;`
    + 'font-size:8px;font-weight:700;letter-spacing:0.18em;line-height:1;text-transform:uppercase;pointer-events:none;z-index:0;'
    + `color:var(--text-tertiary);background:color-mix(in srgb, var(--text) 7%, transparent);border-radius:3px;`;
  return el;
}
