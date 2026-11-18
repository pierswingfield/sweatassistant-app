// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { resetPasswordRequest, validateNewPassword, showResetPasswordPage } from './reset-password.js';

const GOOD = 'B'.repeat(43);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('resetPasswordRequest', () => {
  it('only matches the reset path and validates the token shape', () => {
    expect(resetPasswordRequest({ pathname: '/verify-email', search: `?token=${GOOD}` })).toBeNull();
    expect(resetPasswordRequest({ pathname: '/reset-password', search: `?token=${GOOD}` })).toEqual({ token: GOOD });
    expect(resetPasswordRequest({ pathname: '/reset-password/', search: '' })).toEqual({ token: '' });
    expect(resetPasswordRequest({ pathname: '/reset-password', search: '?token=<b>x</b>aaaaaaaaaaaaaaaaaaaa' })).toEqual({ token: '' });
  });
});

describe('validateNewPassword', () => {
  it('applies the signup rule', () => {
    expect(validateNewPassword('short', 'short')).toMatch(/at least 8/);
    expect(validateNewPassword('long-enough', 'different')).toMatch(/don’t match/);
    expect(validateNewPassword('long-enough', 'long-enough')).toBe('');
  });
});

describe('showResetPasswordPage', () => {
  const mount = () => {
    document.body.innerHTML = `<div id="app-reset-container" style="display:none"><h1 id="app-reset-title"></h1><p id="app-reset-body"></p>
      <form id="app-reset-form"><input id="app-reset-password"><input id="app-reset-confirm"><div id="app-reset-error"></div><button type="submit" id="app-reset-submit"><span></span></button></form>
      <form id="app-reset-request-form" style="display:none"><input id="app-reset-email"><div id="app-reset-request-msg"></div><button type="submit" id="app-reset-request-submit"><span></span></button></form>
      <button id="app-reset-continue" style="display:none"></button></div>`;
  };
  const submit = (id) => document.getElementById(id).dispatchEvent(new Event('submit', { cancelable: true }));
  const fill = (pw, conf) => { document.getElementById('app-reset-password').value = pw; document.getElementById('app-reset-confirm').value = conf; };

  it('does nothing on load, blocks a mismatch client-side, then POSTs once and offers Continue', async () => {
    mount();
    const reset = vi.fn().mockResolvedValue({});
    const go = vi.fn();
    showResetPasswordPage({ token: GOOD }, { reset, forgot: vi.fn(), go });
    expect(reset).not.toHaveBeenCalled();
    fill('long-enough', 'nope'); submit('app-reset-form'); await tick();
    expect(reset).not.toHaveBeenCalled();
    fill('long-enough', 'long-enough'); submit('app-reset-form'); await tick();
    expect(reset).toHaveBeenCalledWith(GOOD, 'long-enough');
    document.getElementById('app-reset-continue').click();
    expect(go).toHaveBeenCalledTimes(1);
  });
  it('turns into the request form for a missing or rejected token', async () => {
    mount();
    const forgot = vi.fn().mockResolvedValue(true);
    showResetPasswordPage({ token: '' }, { reset: vi.fn(), forgot, go: vi.fn() });
    expect(document.getElementById('app-reset-request-form').style.display).toBe('');
    document.getElementById('app-reset-email').value = 'a@b.co'; submit('app-reset-request-form'); await tick();
    expect(forgot).toHaveBeenCalledWith('a@b.co');
    mount();
    const err = Object.assign(new Error('x'), { code: 'INVALID_TOKEN' });
    showResetPasswordPage({ token: GOOD }, { reset: vi.fn().mockRejectedValue(err), forgot, go: vi.fn() });
    fill('long-enough', 'long-enough'); submit('app-reset-form'); await tick();
    expect(document.getElementById('app-reset-request-form').style.display).toBe('');
    expect(document.getElementById('app-reset-form').style.display).toBe('none');
  });
});
