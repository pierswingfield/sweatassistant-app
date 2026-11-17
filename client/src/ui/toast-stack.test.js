import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createToastStack } from './toast-stack.js';

function mk(container, name) {
  const el = document.createElement('div');
  el.className = 'app-toast info';
  el.textContent = name;
  return el;
}

describe('toast stack', () => {
  let container, stack;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    stack = createToastStack(container, { max: 3, leaveFallbackMs: 400, reducedMotion: () => true });
  });
  afterEach(() => { vi.useRealTimers(); container.remove(); });

  it('enters: appended without .show, then shown after frames', () => {
    const el = mk(container, 'a');
    stack.show(el);
    expect(container.contains(el)).toBe(true);
    expect(el.classList.contains('show')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(el.classList.contains('show')).toBe(true);
  });

  it('exit waits for the animation: still in DOM after dismiss, removed on transitionend', () => {
    const el = mk(container, 'a');
    const h = stack.show(el);
    vi.advanceTimersByTime(50);
    h.dismiss();
    expect(el.classList.contains('is-leaving')).toBe(true);
    expect(el.classList.contains('show')).toBe(false);
    vi.advanceTimersByTime(200);
    expect(container.contains(el)).toBe(true);
    const ev = new Event('transitionend'); ev.propertyName = 'opacity';
    el.dispatchEvent(ev);
    expect(container.contains(el)).toBe(false);
  });

  it('exit falls back to a timeout when no transitionend fires', () => {
    const el = mk(container, 'a');
    const h = stack.show(el);
    h.dismiss();
    vi.advanceTimersByTime(399);
    expect(container.contains(el)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(container.contains(el)).toBe(false);
  });

  it('ignores transitionend bubbling from a child', () => {
    const el = mk(container, 'a');
    const child = document.createElement('span'); el.appendChild(child);
    const h = stack.show(el); h.dismiss();
    const ev = new Event('transitionend', { bubbles: true }); ev.propertyName = 'opacity';
    child.dispatchEvent(ev);
    expect(container.contains(el)).toBe(true);
  });

  it('dismiss is idempotent', () => {
    const el = mk(container, 'a');
    const h = stack.show(el);
    h.dismiss(); h.dismiss();
    vi.advanceTimersByTime(500);
    expect(container.contains(el)).toBe(false);
    expect(stack.count).toBe(0);
  });

  it('timers are independent per toast and auto-dismiss on their own schedule', () => {
    const a = mk(container, 'a'), b = mk(container, 'b');
    stack.show(a, { duration: 1000 });
    vi.advanceTimersByTime(600);
    stack.show(b, { duration: 1000 });
    vi.advanceTimersByTime(450); // a due at 1000, b not until 1600
    expect(a.classList.contains('is-leaving')).toBe(true);
    expect(b.classList.contains('is-leaving')).toBe(false);
    vi.advanceTimersByTime(600);
    expect(b.classList.contains('is-leaving')).toBe(true);
  });

  it('pause stops the timer and resume restarts it', () => {
    const a = mk(container, 'a');
    const h = stack.show(a, { duration: 1000 });
    h.pause();
    vi.advanceTimersByTime(5000);
    expect(a.classList.contains('is-leaving')).toBe(false);
    h.resume();
    vi.advanceTimersByTime(1001);
    expect(a.classList.contains('is-leaving')).toBe(true);
  });

  it('caps visible toasts: the oldest leaves (animated) when a fourth arrives', () => {
    const els = ['a', 'b', 'c', 'd'].map((n) => mk(container, n));
    els.forEach((e) => stack.show(e, { duration: 0 }));
    expect(stack.count).toBe(3);
    expect(els[0].classList.contains('is-leaving')).toBe(true);
    expect(container.contains(els[0])).toBe(true); // still animating out
    expect(els.slice(1).every((e) => !e.classList.contains('is-leaving'))).toBe(true);
    vi.advanceTimersByTime(500);
    expect(container.contains(els[0])).toBe(false);
  });

  it('FLIP: leaving toast goes out of flow; sibling is inverted to its old spot, committed, then released', () => {
    const motion = createToastStack(container, { max: 3, leaveFallbackMs: 400, reducedMotion: () => false });
    const a = mk(container, 'a'), b = mk(container, 'b');
    a.getBoundingClientRect = () => ({ top: 0 });
    // B sits at 60 while A is in flow, and moves up to 0 once A is taken out of flow.
    b.getBoundingClientRect = () => ({ top: a.style.position === 'absolute' ? 0 : 60 });
    const ha = motion.show(a, { duration: 0 });
    motion.show(b, { duration: 0 });
    const seen = [];
    Object.defineProperty(container, 'offsetHeight', { get() { seen.push(b.style.transform + '|' + b.style.transition); return 0; }, configurable: true });
    ha.dismiss();
    expect(a.style.position).toBe('absolute');
    expect(seen).toEqual(['translateY(60px)|none']);
    expect(b.style.transform).toBe('');
    expect(b.style.transition).toBe('');
  });
});
