import { describe, expect, it, vi } from 'vitest';
import { ensureLiveStatusLine, setLiveStatusText } from './status-line.js';

describe('auto-book live status line (U2-3)', () => {
  it('is a polite, atomic status region', () => {
    const host = document.createElement('div');
    const { el, created } = ensureLiveStatusLine(host);
    expect(created).toBe(true);
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(ensureLiveStatusLine(host).el).toBe(el);
    expect(ensureLiveStatusLine(host).created).toBe(false);
  });

  it('attaches a new region empty, then fills it (so the change is announced)', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const { el, created } = ensureLiveStatusLine(host);
    setLiveStatusText(el, 'Attempting slot 12', { created });
    expect(el.textContent).toBe('');
    vi.advanceTimersByTime(60);
    expect(el.textContent).toBe('Attempting slot 12');
    vi.useRealTimers();
  });

  it('the latest write wins over a pending first fill', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const { el, created } = ensureLiveStatusLine(host);
    setLiveStatusText(el, 'Planning', { created });
    setLiveStatusText(el, 'Attempting slot 12');
    vi.advanceTimersByTime(60);
    expect(el.textContent).toBe('Attempting slot 12');
    vi.useRealTimers();
  });

  it('does not touch the DOM when the text has not changed', () => {
    const host = document.createElement('div');
    const { el } = ensureLiveStatusLine(host);
    expect(setLiveStatusText(el, 'Joined waitlist')).toBe(true);
    const mutations = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    expect(setLiveStatusText(el, 'Joined waitlist')).toBe(false);
    return Promise.resolve().then(() => { mo.disconnect(); expect(mutations.length).toBe(0); });
  });
});
