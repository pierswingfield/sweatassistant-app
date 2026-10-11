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

/**
 * @param {{x:number,y:number}[]} boundsPoints  points that define the rotation bounds
 * @param {number} rotation  0 | 90 | 180 | 270 (already gated for width)
 * @returns {(point) => point} adds `sourceY` (the original row y) to every point
 */
export function makeDisplayRotator(boundsPoints, rotation) {
  const xs = boundsPoints.map((p) => p.x);
  const ys = boundsPoints.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return (point) => {
    if (rotation === 90) return { ...point, x: point.y - minY, y: maxX - point.x, sourceY: point.y };
    if (rotation === 180) return { ...point, x: maxX - point.x, y: maxY - point.y, sourceY: point.y };
    if (rotation === 270) return { ...point, x: maxY - point.y, y: point.x - minX, sourceY: point.y };
    return { ...point, sourceY: point.y };
  };
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
  if (rotated) return { scale: fillScale, scrolls: false };
  const scale = Math.max(fillScale, minGapScale);
  return { scale, scrolls: minGapScale > fillScale };
}

export function makeUniformFit(points, { boxW, boxH, pad = 12, padRight = pad, itemPx = 28, minGapPx = 32, lockWidth = true } = {}) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  let minDist = Infinity;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
    if (d > 0 && d < minDist) minDist = d;
  }
  const minGapScale = Number.isFinite(minDist) ? minGapPx / minDist : Infinity;
  const availW = Math.max(1, boxW - pad - padRight - itemPx), availH = Math.max(1, boxH - 2 * pad - itemPx);
  const fitW = w > 0 ? availW / w : Infinity, fitH = h > 0 ? availH / h : Infinity;
  const heightFit = Math.min(fitW, Math.max(fitH, minGapScale));
  // lockWidth (rotated maps, non-scrolling previews): width-limited. Otherwise the minimum spot size wins
  // and the box grows wider than the container (the caller scrolls it horizontally).
  let scale = lockWidth ? heightFit : chooseMapScale({ rotated: false, fillScale: heightFit, minGapScale }).scale;
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
