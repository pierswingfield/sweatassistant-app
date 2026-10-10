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
export function makeUniformFit(points, { boxW, boxH, pad = 12, padRight = pad, itemPx = 28, minGapPx = 32 } = {}) {
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
  let scale = Math.min(fitW, Math.max(fitH, minGapScale));
  if (!Number.isFinite(scale)) scale = 1;
  const contentW = w * scale + itemPx, contentH = h * scale + itemPx;
  const neededH = Math.ceil(contentH + 2 * pad);
  const boxHUsed = Math.max(boxH, neededH);
  const offX = pad + (boxW - pad - padRight - contentW) / 2 + itemPx / 2;
  const offY = (boxHUsed - contentH) / 2 + itemPx / 2;
  return {
    scale, neededH,
    xPct: (x) => ((x - minX) * scale + offX) / boxW * 100,
    yPct: (y) => ((y - minY) * scale + offY) / boxHUsed * 100,
    wPct: (units) => (units * scale + itemPx) / boxW * 100,
    hPct: (units) => (units * scale + itemPx) / boxHUsed * 100,
  };
}
