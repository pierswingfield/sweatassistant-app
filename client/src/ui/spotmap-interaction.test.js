// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStudioFloorPlan } from './spotmap.js';

const slots = [
  { id: 1, label: '1', x: 0, y: 0 },
  { id: 2, label: '2', x: 10, y: 0 },
  { id: 3, label: '3', x: 0, y: 10 },
];

beforeEach(() => {
  document.body.replaceChildren();
  window.matchMedia = vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} }));
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});

function mount(options = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  Object.defineProperty(container, 'clientWidth', { value: 320, configurable: true });
  renderStudioFloorPlan(container, slots, [], [], () => {}, options);
  return container;
}

describe('renderStudioFloorPlan interaction state', () => {
  it('retains scroll pan after selecting a spot and reports a genuine tap', () => {
    const onSpotTap = vi.fn();
    const container = mount({ onSpotTap });
    const scroll = container.querySelector('.app-floor-scroll');
    scroll.scrollLeft = 57;
    scroll.scrollTop = 13;
    scroll.dispatchEvent(new Event('scroll'));

    container.querySelector('[title="Spot 1"]').click();

    const rerendered = container.querySelector('.app-floor-scroll');
    expect(onSpotTap).toHaveBeenCalledTimes(1);
    expect(rerendered.scrollLeft).toBe(57);
    expect(rerendered.scrollTop).toBe(13);
  });

  it('does not select after a drag gesture', () => {
    const onSpotTap = vi.fn();
    const container = mount({ onSpotTap });
    const spot = container.querySelector('[title="Spot 1"]');
    spot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    spot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 12, clientY: 0 }));
    spot.click();

    expect(onSpotTap).not.toHaveBeenCalled();
    expect(container.__getSelection().slots).toEqual([]);
  });

  it('rotates display coordinates on mobile without changing spot labels', () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addListener() {}, removeListener() {} }));
    const container = mount({ mobileRotation: 90 });
    const one = container.querySelector('[title="Spot 1"]');
    const two = container.querySelector('[title="Spot 2"]');

    expect(one.textContent).toBe('1');
    expect(two.textContent).toBe('2');
    expect(one.style.left).toBe(two.style.left);
    expect(one.style.top).not.toBe(two.style.top);
  });

  it('Clear selection sits under the map, is disabled when empty, and clears only the draft', () => {
    const container = mount({ clearBelowMap: true, hideActions: true });
    const clear = container.querySelector('.app-spotmap-clear');
    expect(clear).not.toBeNull();
    expect(clear.disabled).toBe(true);
    container.querySelector('[title="Spot 1"]').click();
    container.querySelector('[title="Spot 2"]').click();
    expect(container.querySelector('.app-spotmap-clear').disabled).toBe(false);
    expect(container.__getSelection().slots).toHaveLength(2);
    container.querySelector('.app-spotmap-clear').click();
    expect(container.__getSelection()).toEqual({ slots: [], rows: [] });
    expect(container.querySelector('.app-spotmap-clear').disabled).toBe(true);
  });
});
