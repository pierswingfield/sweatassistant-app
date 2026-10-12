// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import bootcamp from './__fixtures__/aarmy-bootcamp-6184.json';
import cycle from './__fixtures__/aarmy-cycle-6182.json';
import { makeDisplayRotator, makeUniformFit, minSeparation, ROTATED_MIN_GAP_PX } from './spot-rotation.js';
import { renderStudioFloorPlan } from './spotmap.js';

// Mockup B heights at 358px wide (Documentation/QA/mockups/rotated-map-compaction.html).
const CASES = [['Bootcamp 6184', bootcamp, 455], ['Cycle 6182', cycle, 615]];

describe.each(CASES)('rotated compact map: %s', (_name, fx, maxH) => {
  const rot = makeDisplayRotator(fx.slots, 90);
  const pts = fx.slots.map(rot);

  it('keeps row and column order and never overlaps at the fitted scale', () => {
    // order along each display axis is non-decreasing relative to the plain rotation
    const plain = fx.slots.map(makeDisplayRotator(fx.slots, 90, { compact: false }));
    for (let i = 0; i < pts.length; i += 3) for (let j = 0; j < pts.length; j += 2) {
      expect(Math.sign(pts[i].x - pts[j].x)).toBeGreaterThanOrEqual(Math.min(0, Math.sign(plain[i].x - plain[j].x)));
      if (plain[i].x < plain[j].x - 1e-6) expect(pts[i].x).toBeLessThanOrEqual(pts[j].x);
      if (plain[i].y < plain[j].y - 1e-6) expect(pts[i].y).toBeLessThanOrEqual(pts[j].y);
    }
    const fit = makeUniformFit(pts, { boxW: 358, boxH: 340, pad: 22, rotated: true, minGapPx: ROTATED_MIN_GAP_PX });
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const sep = Math.max(Math.abs(pts[i].x - pts[j].x), Math.abs(pts[i].y - pts[j].y)) * fit.scale;
      expect(sep).toBeGreaterThanOrEqual(28);
    }
  });

  it('is not stretched to the width: spot spacing stays ~31px and height fits under mockup B', () => {
    const fit = makeUniformFit(pts, { boxW: 358, boxH: 340, pad: 22, rotated: true, minGapPx: ROTATED_MIN_GAP_PX });
    expect(fit.scale * minSeparation(pts)).toBeCloseTo(ROTATED_MIN_GAP_PX, 3);
    expect(fit.neededH).toBeLessThanOrEqual(maxH);
  });

  it('editor renders it at 358px wide: whole map, no inner scroll, short enough', () => {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    window.matchMedia = vi.fn(() => ({ matches: true, addListener() {}, removeListener() {} }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 358, configurable: true });
    renderStudioFloorPlan(container, fx.slots, [], [], () => {}, { mobileRotation: 90 });
    const floor = container.querySelector('.app-floor');
    expect(parseFloat(floor.style.height)).toBeLessThanOrEqual(maxH);
    expect(parseFloat(floor.style.width)).toBeLessThan(358);
    expect(container.querySelector('.app-floor-scroll').style.maxHeight).toBe('none');
  });
});

describe('gap compaction', () => {
  it('collapses a wide aisle to a smaller visible gap, keeping order', () => {
    const slots = [{ x: 0, y: 0 }, { x: 1.2, y: 0 }, { x: 2.4, y: 0 }, { x: 10, y: 0 }, { x: 11.2, y: 0 }].map((p, i) => ({ ...p, id: i }));
    const out = slots.map(makeDisplayRotator(slots, 90)); // rotated: original x becomes display y
    const ys = out.map((p) => p.y).sort((a, b) => a - b);
    const span = ys[ys.length - 1] - ys[0];
    expect(span).toBeLessThan(11.2);
    expect(ys[1] - ys[0]).toBeCloseTo(1.2, 6);
    expect(out[0].y).toBeGreaterThan(out[4].y); // x ascending -> display y descending, order kept
  });
});
