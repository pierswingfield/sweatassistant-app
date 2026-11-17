import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runButton, asyncHandler, pressAndAdvance, waitUntilSettled, isButtonBusy, installPressFeedback } from './async-button.js';

const mkBtn = (label = 'Book') => {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<span>${label}</span>`;
  document.body.appendChild(b);
  return b;
};
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('runButton', () => {
  it('is single-flight: a second tap while pending shares the first run', async () => {
    const btn = mkBtn();
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const p1 = runButton(btn, fn);
    const p2 = runButton(btn, fn);
    expect(p2).toBe(p1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isButtonBusy(btn)).toBe(true);
    d.resolve('ok');
    await vi.runAllTimersAsync();
    await expect(p1).resolves.toBe('ok');
    expect(isButtonBusy(btn)).toBe(false);
  });

  it('a synchronous handler gets no async state and never blocks the next tap', () => {
    const btn = mkBtn();
    const fn = vi.fn(() => 'armed');
    expect(runButton(btn, fn)).toBeInstanceOf(Promise);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.querySelector('.abtn-ind')).toBeNull();
    runButton(btn, fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(isButtonBusy(btn)).toBe(false);
  });

  it('sets aria-busy and the spinner while pending, clears both afterwards', async () => {
    const btn = mkBtn();
    const d = deferred();
    const p = runButton(btn, () => d.promise, { success: false });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.classList.contains('abtn-busy')).toBe(true);
    expect(btn.querySelector('.abtn-ind')).not.toBeNull();
    expect(btn.style.getPropertyValue('color')).toBe('transparent');
    d.resolve();
    await vi.runAllTimersAsync();
    await p;
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.classList.contains('abtn-busy')).toBe(false);
    expect(btn.querySelector('.abtn-ind')).toBeNull();
    expect(btn.style.getPropertyValue('color')).toBe('');
    expect(btn.textContent).toBe('Book');
  });

  it('holds the spinner for minPendingMs when the work is instant, never longer', async () => {
    const btn = mkBtn();
    let settled = false;
    runButton(btn, async () => 1, { minPendingMs: 350, success: false }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    expect(btn.classList.contains('abtn-busy')).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(settled).toBe(true);
  });

  it('does not delay slow work beyond its own duration', async () => {
    const btn = mkBtn();
    let settled = false;
    runButton(btn, () => new Promise((r) => setTimeout(r, 1000)), { minPendingMs: 350, success: false }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1001);
    expect(settled).toBe(true);
  });

  it('with showDelayMs, a fast action shows no spinner at all', async () => {
    const btn = mkBtn();
    const seen = [];
    const obs = new MutationObserver(() => seen.push(btn.classList.contains('abtn-busy')));
    obs.observe(btn, { attributes: true, attributeFilter: ['class'] });
    const p = runButton(btn, () => new Promise((r) => setTimeout(r, 50)), { showDelayMs: 120 });
    await vi.advanceTimersByTimeAsync(60);
    await p;
    obs.disconnect();
    expect(seen.includes(true)).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('plays the success check, announces it, then restores the label', async () => {
    const btn = mkBtn();
    const p = runButton(btn, async () => 'done', { minPendingMs: 0, successMs: 500, successLabel: 'Booked' });
    await vi.advanceTimersByTimeAsync(10);
    expect(btn.classList.contains('abtn-success')).toBe(true);
    expect(btn.querySelector('.abtn-ind .abtn-check')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe('done');
    expect(btn.classList.contains('abtn-success')).toBe(false);
    expect(document.querySelector('.abtn-live').textContent).toBe('Booked');
    expect(document.querySelector('.abtn-live').getAttribute('aria-live')).toBe('polite');
  });

  it('a thrown error shakes, restores and rethrows by default', async () => {
    const btn = mkBtn();
    const p = runButton(btn, async () => { throw new Error('nope'); }, { minPendingMs: 0, errorLabel: 'Failed' });
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5);
    expect(btn.classList.contains('abtn-error')).toBe(true);
    expect(btn.classList.contains('abtn-busy')).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await caught).message).toBe('nope');
    expect(btn.classList.contains('abtn-error')).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(document.querySelector('.abtn-live').textContent).toBe('Failed');
  });

  it('rethrow:false swallows; a false result counts as an error', async () => {
    const btn = mkBtn();
    const p = runButton(btn, async () => false, { minPendingMs: 0, rethrow: false });
    await vi.advanceTimersByTimeAsync(5);
    expect(btn.classList.contains('abtn-error')).toBe(true);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(false);
  });

  it('hapticOutcome: an error haptic fails the run; no success signal means no check', async () => {
    const btn = mkBtn();
    const fail = runButton(btn, async () => { window.dispatchEvent(new CustomEvent('app-haptic', { detail: { type: 'error' } })); }, { minPendingMs: 0, hapticOutcome: true });
    await vi.advanceTimersByTimeAsync(5);
    expect(btn.classList.contains('abtn-error')).toBe(true);
    await vi.runAllTimersAsync(); await fail;

    const quiet = runButton(btn, async () => undefined, { minPendingMs: 0, hapticOutcome: true });
    await vi.advanceTimersByTimeAsync(5);
    expect(btn.classList.contains('abtn-success')).toBe(false);
    await vi.runAllTimersAsync(); await quiet;

    const ok = runButton(btn, async () => { window.dispatchEvent(new CustomEvent('app-haptic', { detail: { type: 'success' } })); }, { minPendingMs: 0, hapticOutcome: true });
    await vi.advanceTimersByTimeAsync(5);
    expect(btn.classList.contains('abtn-success')).toBe(true);
    await vi.runAllTimersAsync(); await ok;
  });

  it('re-attaches the spinner when the action rewrites the label, and locks the width', async () => {
    const btn = mkBtn();
    btn.getBoundingClientRect = () => ({ width: 80, height: 40 });
    const d = deferred();
    const p = runButton(btn, async () => { btn.innerHTML = 'Booking…'; await d.promise; }, { success: false });
    expect(btn.style.width).toBe('80px');
    await Promise.resolve(); await Promise.resolve();
    expect(btn.querySelector('.abtn-ind')).not.toBeNull();
    d.resolve();
    await vi.runAllTimersAsync(); await p;
    expect(btn.style.width).toBe('');
  });

  it('settle(): a re-rendered replacement gets the check instead of the detached button', async () => {
    const btn = mkBtn();
    const next = mkBtn('Booked');
    const p = runButton(btn, async () => { btn.remove(); }, { minPendingMs: 0, settle: () => next });
    await vi.advanceTimersByTimeAsync(5);
    expect(next.classList.contains('abtn-success')).toBe(true);
    await vi.runAllTimersAsync(); await p;
    expect(next.classList.contains('abtn-success')).toBe(false);
    expect(next.textContent).toBe('Booked');
  });
});

describe('asyncHandler / pressAndAdvance / waitUntilSettled', () => {
  it('asyncHandler runs the handler through the clicked button', async () => {
    const btn = mkBtn();
    const d = deferred();
    btn.addEventListener('click', asyncHandler(() => d.promise));
    btn.click(); btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    d.resolve();
    await vi.runAllTimersAsync();
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('pressAndAdvance stays pending until the button leaves the page', async () => {
    const btn = mkBtn();
    let done = false;
    pressAndAdvance(btn, () => {}).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    btn.remove();
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(true);
  });

  it('waitUntilSettled resolves when a disabled button is re-enabled', async () => {
    const btn = mkBtn(); btn.disabled = true;
    let done = false;
    waitUntilSettled(btn, 5000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    btn.disabled = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
  });
});

describe('installPressFeedback', () => {
  it('adds is-pressed on pointerdown and holds it for a short minimum, then springs back', async () => {
    const off = installPressFeedback(document);
    const btn = mkBtn();
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    expect(btn.classList.contains('is-pressed')).toBe(true);
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(btn.classList.contains('is-pressed')).toBe(true); // a fast tap still shows
    await vi.advanceTimersByTimeAsync(120);
    expect(btn.classList.contains('is-pressed')).toBe(false);
    expect(btn.classList.contains('is-released')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(btn.classList.contains('is-released')).toBe(false);
    // disabled controls never press
    btn.disabled = true;
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(btn.classList.contains('is-pressed')).toBe(false);
    off();
  });
});
