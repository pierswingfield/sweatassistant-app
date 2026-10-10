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
