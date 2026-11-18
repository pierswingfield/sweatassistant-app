// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { verifyEmailRequest, showVerifyEmailPage } from './verify-email.js';

const GOOD = 'A'.repeat(43);

describe('verifyEmailRequest', () => {
  it('only matches the verify path', () => {
    expect(verifyEmailRequest({ pathname: '/settings', search: `?token=${GOOD}` })).toBeNull();
    expect(verifyEmailRequest({ pathname: '/verify-email', search: `?token=${GOOD}` })).toEqual({ token: GOOD });
    expect(verifyEmailRequest({ pathname: '/verify-email/', search: `?token=${GOOD}` })).toEqual({ token: GOOD });
  });
  it('returns an empty token for missing or malformed values', () => {
    for (const search of ['', '?token=', '?token=short', '?token=' + 'x'.repeat(300), '?token=<script>alert(1)</script>aaaaaaaaaaaaaaaa']) {
      expect(verifyEmailRequest({ pathname: '/verify-email', search })).toEqual({ token: '' });
    }
  });
});

describe('showVerifyEmailPage', () => {
  const mount = () => {
    document.body.innerHTML = '<div id="app-verify-container" style="display:none"><h1 id="app-verify-title"></h1><p id="app-verify-body"></p><button id="app-verify-action"></button></div>';
  };
  it('does nothing until the button is pressed, then POSTs once', async () => {
    mount();
    const verify = vi.fn().mockResolvedValue(true);
    const go = vi.fn();
    showVerifyEmailPage({ token: GOOD }, { verify, go });
    expect(verify).not.toHaveBeenCalled();
    document.getElementById('app-verify-action').click();
    await Promise.resolve(); await Promise.resolve();
    expect(verify).toHaveBeenCalledWith(GOOD);
    expect(document.getElementById('app-verify-action').onclick).toBeTypeOf('function');
    document.getElementById('app-verify-action').click();
    expect(go).toHaveBeenCalledTimes(1);
  });
  it('shows the failure copy for a rejected or missing token', async () => {
    mount();
    showVerifyEmailPage({ token: '' }, { verify: vi.fn(), go: vi.fn() });
    expect(document.getElementById('app-verify-title').textContent).toBe('Link not valid');
    mount();
    const verify = vi.fn().mockRejectedValue(new Error('no'));
    showVerifyEmailPage({ token: GOOD }, { verify, go: vi.fn() });
    document.getElementById('app-verify-action').click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.getElementById('app-verify-title').textContent).toBe('Link not valid');
  });
});
