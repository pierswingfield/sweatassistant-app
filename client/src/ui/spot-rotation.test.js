// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { makeDisplayRotator, effectiveRotation } from './spot-rotation.js';

const mobile = (m) => { window.matchMedia = (q) => ({ matches: m, media: q, addEventListener() {}, removeEventListener() {} }); };
const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }];

describe('display rotation helper', () => {
  it('90 degrees turns a wide room into a tall one and keeps the source row', () => {
    const r = makeDisplayRotator(pts, 90);
    expect(r({ x: 10, y: 0 })).toMatchObject({ x: 0, y: 0, sourceY: 0 });
    expect(r({ x: 0, y: 4 })).toMatchObject({ x: 4, y: 10, sourceY: 4 });
  });
  it('0 leaves coordinates alone', () => {
    expect(makeDisplayRotator(pts, 0)({ x: 3, y: 2 })).toMatchObject({ x: 3, y: 2, sourceY: 2 });
  });
  it('only rotates at mobile width', () => {
    mobile(true); expect(effectiveRotation(90)).toBe(90);
    mobile(false); expect(effectiveRotation(90)).toBe(0);
    mobile(true); expect(effectiveRotation(45)).toBe(0);
  });
});

describe('occupancy minimap', () => {
  let renderMinimap;
  beforeAll(async () => { mobile(false); ({ renderMinimap } = await import('./tooltips.js')); });
  const payload = (extra = {}) => ({
    slots: [{ id: '1', label: '1', x: 0, y: 0, isAvailable: true }, { id: '2', label: '2', x: 10, y: 0, isAvailable: false }],
    objects: [], event: { capacity: 2, availableCount: 1, studioId: '6184', gymId: 'aarmy' }, ...extra,
  });
  const dots = (el) => [...el.querySelectorAll('.app-minimap-dot')].map((d) => [d.title, d.style.left, d.style.top]);

  it('is rotated for a rotated studio at <=768px, unrotated on desktop', () => {
    const el = document.createElement('div');
    mobile(false); renderMinimap(payload({ mobileRotation: 90 }), el);
    const flat = dots(el);
    mobile(true); renderMinimap(payload({ mobileRotation: 90 }), el);
    const rotated = dots(el);
    expect(rotated).not.toEqual(flat);
    // 90 degrees: the two spots stack vertically instead of sitting side by side
    expect(rotated[0][1]).toBe(rotated[1][1]);
    expect(flat[0][2]).toBe(flat[1][2]);
  });
});
