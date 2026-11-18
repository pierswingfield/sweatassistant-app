// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { notMeRequest, showNotMePage, createTwoPress } from './not-me.js';

const GOOD = 'A'.repeat(43);
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('notMeRequest', () => {
  it('matches only /not-me and rejects malformed tokens', () => {
    expect(notMeRequest({ pathname: '/reset-password', search: `?token=${GOOD}` })).toBeNull();
    expect(notMeRequest({ pathname: '/not-me/', search: `?token=${GOOD}` })).toEqual({ token: GOOD });
    expect(notMeRequest({ pathname: '/not-me', search: '?token=<b>x</b>aaaaaaaaaaaaaaaaaaaa' })).toEqual({ token: '' });
  });
});

describe('createTwoPress', () => {
  it('arms on the first press, confirms on the second, and can be reset', () => {
    const p = createTwoPress();
    expect(p.armed).toBe(false);
    expect(p.press()).toBe('armed');
    expect(p.armed).toBe(true);
    expect(p.press()).toBe('confirmed');
    p.reset();
    expect(p.press()).toBe('armed');
  });
});

describe('showNotMePage', () => {
  const mount = () => {
    document.body.innerHTML = '<div id="app-notme-container" style="display:none"><h1 id="app-notme-title"></h1><p id="app-notme-body"></p><div id="app-notme-widget"></div><button id="app-notme-action" disabled></button></div>';
  };
  const widget = () => {
    const state = { cb: null };
    return { state, loadWidget: async () => ({ render: (_el, o) => { state.cb = o.callback; return 'w1'; }, reset: vi.fn() }) };
  };
  const btn = () => document.getElementById('app-notme-action');

  it('shows the address, does nothing on load, needs a Turnstile pass, then two presses to submit', async () => {
    mount();
    const w = widget();
    const preview = vi.fn().mockResolvedValue('me@example.com');
    const submit = vi.fn().mockResolvedValue(true);
    showNotMePage({ token: GOOD }, { preview, submit, siteKey: 'k', loadWidget: w.loadWidget });
    await flush();
    expect(document.getElementById('app-notme-body').textContent).toContain('did NOT create an account using email address me@example.com');
    expect(submit).not.toHaveBeenCalled();
    expect(btn().disabled).toBe(true);
    btn().click();
    expect(submit).not.toHaveBeenCalled();

    w.state.cb('ts-token');
    expect(btn().disabled).toBe(false);
    btn().click();
    expect(btn().textContent).toBe('Press again to confirm');
    expect(submit).not.toHaveBeenCalled();
    btn().click();
    await flush();
    expect(submit).toHaveBeenCalledWith(GOOD, 'ts-token');
    expect(document.getElementById('app-notme-body').textContent).toBe('Thank you for confirming. We’ve received your request to delete your email address and any related data from our services. It will be processed shortly.');
  });

  it('a failed check resets the widget and the button for another try', async () => {
    mount();
    const w = widget();
    const submit = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'TURNSTILE_FAILED' }));
    showNotMePage({ token: GOOD }, { preview: vi.fn().mockResolvedValue('m@example.com'), submit, siteKey: 'k', loadWidget: w.loadWidget });
    await flush();
    w.state.cb('t1');
    btn().click(); btn().click();
    await flush();
    expect(btn().disabled).toBe(true); // token spent: wait for a fresh pass
    expect(btn().textContent).toBe('I did not create an account');
    w.state.cb('t2');
    btn().click();
    expect(btn().textContent).toBe('Press again to confirm');
  });

  it('shows failure for a missing/invalid token and unavailable without a site key', async () => {
    mount();
    showNotMePage({ token: '' }, { preview: vi.fn(), submit: vi.fn(), siteKey: 'k' });
    expect(document.getElementById('app-notme-title').textContent).toBe('Link not valid');
    mount();
    showNotMePage({ token: GOOD }, { preview: vi.fn(), submit: vi.fn(), siteKey: '' });
    expect(document.getElementById('app-notme-title').textContent).toBe('Unavailable');
    mount();
    showNotMePage({ token: GOOD }, { preview: vi.fn().mockRejectedValue(new Error('x')), submit: vi.fn(), siteKey: 'k', loadWidget: widget().loadWidget });
    await flush();
    expect(document.getElementById('app-notme-title').textContent).toBe('Link not valid');
  });
});
