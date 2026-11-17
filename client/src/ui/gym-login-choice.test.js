import { describe, expect, it } from 'vitest';
import { setContinuePending } from './gym-login-choice.js';

const opts = { label: 'Continue', pendingLabel: 'Continue without connecting' };
function btn() {
  document.body.innerHTML = '<button class="app-onb-continue"><span>Continue</span></button>';
  return document.querySelector('button');
}

describe('setContinuePending', () => {
  it('fades and relabels while a gym is selected but not connected, staying enabled', () => {
    const b = btn();
    setContinuePending(b, true, opts);
    expect(b.textContent).toBe('Continue without connecting');
    expect(b.dataset.quiet).toBe('1');
    expect(b.classList.contains('is-pending-connect')).toBe(true);
    expect(b.disabled).toBe(false);
    expect(b.hasAttribute('aria-disabled')).toBe(false);
  });
  it('restores the full Continue when cleared', () => {
    const b = btn();
    setContinuePending(b, true, opts);
    setContinuePending(b, false, opts);
    expect(b.textContent).toBe('Continue');
    expect(b.dataset.quiet).toBeUndefined();
    expect(b.classList.contains('is-pending-connect')).toBe(false);
  });
  it('tolerates a missing button (no linked gym yet)', () => {
    expect(() => setContinuePending(null, true, opts)).not.toThrow();
  });
});
