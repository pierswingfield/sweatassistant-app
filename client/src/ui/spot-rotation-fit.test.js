// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/aarmy-bootcamp-6184.json';
import { makeDisplayRotator, makeUniformFit } from './spot-rotation.js';
import { renderStudioFloorPlan } from './spotmap.js';

const slots = fixture.slots;
const rot = makeDisplayRotator(slots, 90);
const rotated = slots.map(rot);

describe('real Aarmy Bootcamp room (6184), rotated 90 degrees', () => {
  it('rotated coordinates equal the original rotated 90 (uniform, no stretch)', () => {
    const minY = Math.min(...slots.map((s) => s.y)), maxX = Math.max(...slots.map((s) => s.x));
    rotated.forEach((r, i) => {
      expect(r.x).toBeCloseTo(slots[i].y - minY, 9);
      expect(r.y).toBeCloseTo(maxX - slots[i].x, 9);
    });
  });

  it('percentage fit keeps aspect ratio and every pairwise offset (rotated, scaled once)', () => {
    const fit = makeUniformFit(rotated, { boxW: 350, boxH: 340, pad: 10 });
    const px = rotated.map((r) => ({ x: fit.xPct(r.x) / 100 * 350, y: fit.yPct(r.y) / 100 * Math.max(340, fit.neededH) }));
    for (let i = 0; i < slots.length; i += 5) for (let j = 0; j < slots.length; j += 3) {
      const ox = slots[j].x - slots[i].x, oy = slots[j].y - slots[i].y; // original delta
      expect(px[j].x - px[i].x).toBeCloseTo(oy * fit.scale, 6);        // rotated 90: dx' = dy
      expect(px[j].y - px[i].y).toBeCloseTo(-ox * fit.scale, 6);       // dy' = -dx
    }
    const w = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x));
    const h = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y));
    expect(w / h).toBeCloseTo(4.8 / 14.8, 6); // original 14.8 wide x 4.8 tall, now 4.8 wide x 14.8 tall
  });

  it('the editor draws it with one scale on both axes', () => {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    window.matchMedia = vi.fn(() => ({ matches: true, addListener() {}, removeListener() {} }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 350, configurable: true });
    renderStudioFloorPlan(container, slots, [], [], () => {}, { mobileRotation: 90 });
    const pos = new Map();
    [...container.querySelectorAll('.app-floor > div')].forEach((el) => {
      const m = /^Spot (.+)$/.exec(el.title || '');
      if (m) pos.set(m[1], { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    });
    expect(pos.size).toBe(slots.length);
    const byLabel = new Map(slots.map((s) => [s.label, s]));
    const a = '1', b = '41';
    const k = (pos.get(b).x - pos.get(a).x) / (byLabel.get(b).y - byLabel.get(a).y);
    const k2 = (pos.get(b).y - pos.get(a).y) / -(byLabel.get(b).x - byLabel.get(a).x);
    expect(k).toBeGreaterThan(0);
    expect(k2).toBeCloseTo(k, 6);
    ['12', '25', '35'].forEach((l) => {
      expect((pos.get(l).x - pos.get(a).x) / (byLabel.get(l).y - byLabel.get(a).y)).toBeCloseTo(k, 6);
    });
  });
});

import { chooseMapScale } from './spot-rotation.js';

describe('fit vs scroll decision (every studio map)', () => {
  it('unrotated: never below the minimum spot size, scrolls when wider than the box', () => {
    expect(chooseMapScale({ rotated: false, fillScale: 10, minGapScale: 25 })).toEqual({ scale: 25, scrolls: true });
    expect(chooseMapScale({ rotated: false, fillScale: 40, minGapScale: 25 })).toEqual({ scale: 40, scrolls: false });
  });
  it('rotated: locked to the width, never scrolls sideways', () => {
    expect(chooseMapScale({ rotated: true, fillScale: 10, minGapScale: 25 })).toEqual({ scale: 10, scrolls: false });
  });
  it('makeUniformFit: wide unrotated box grows past the container; locked fit stays inside it', () => {
    const wide = Array.from({ length: 20 }, (_, i) => ({ x: i * 1, y: (i % 2) * 1 }));
    const scrolling = makeUniformFit(wide, { boxW: 300, boxH: 300, lockWidth: false });
    expect(scrolling.scrolls).toBe(true);
    expect(scrolling.boxWUsed).toBeGreaterThan(300);
    expect(scrolling.scale * 1).toBeGreaterThanOrEqual(32 / Math.hypot(1, 1) - 1e-9);
    const locked = makeUniformFit(wide, { boxW: 300, boxH: 300 });
    expect(locked.scrolls).toBe(false);
    expect(locked.boxWUsed).toBe(300);
    expect(locked.xPct(19)).toBeLessThanOrEqual(100);
  });
});
