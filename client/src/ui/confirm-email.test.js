// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { confirmEmailRequest, showConfirmEmailPage } from './confirm-email.js';

const GOOD = 'A'.repeat(43);

describe('confirmEmailRequest', () => {
  it('only matches the confirm path and rejects malformed tokens', () => {
    expect(confirmEmailRequest({ pathname: '/verify-email', search: `?token=${GOOD}` })).toBeNull();
    expect(confirmEmailRequest({ pathname: '/confirm-email/', search: `?token=${GOOD}` })).toEqual({ token: GOOD });
    expect(confirmEmailRequest({ pathname: '/confirm-email', search: '?token=<b>x</b>aaaaaaaaaaaaaaaaaaaa' })).toEqual({ token: '' });
  });
});

describe('showConfirmEmailPage', () => {
  const mount = () => {
    document.body.innerHTML = '<div id="app-confirm-email-container" style="display:none"><h1 id="app-confirm-email-title"></h1><p id="app-confirm-email-body"></p><button id="app-confirm-email-action"></button></div>';
  };
  it('acts only on the button press, once', async () => {
    mount();
    const confirm = vi.fn().mockResolvedValue(true);
    const go = vi.fn();
    showConfirmEmailPage({ token: GOOD }, { confirm, go });
    expect(confirm).not.toHaveBeenCalled();
    document.getElementById('app-confirm-email-action').click();
    await Promise.resolve(); await Promise.resolve();
    expect(confirm).toHaveBeenCalledWith(GOOD);
    expect(document.getElementById('app-confirm-email-title').textContent).toBe('Email changed');
    document.getElementById('app-confirm-email-action').click();
    expect(go).toHaveBeenCalledTimes(1);
  });
  it('shows failure copy for a rejected or missing token', async () => {
    mount();
    showConfirmEmailPage({ token: '' }, { confirm: vi.fn(), go: vi.fn() });
    expect(document.getElementById('app-confirm-email-title').textContent).toBe('Link not valid');
    mount();
    showConfirmEmailPage({ token: GOOD }, { confirm: vi.fn().mockRejectedValue(new Error('x')), go: vi.fn() });
    document.getElementById('app-confirm-email-action').click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.getElementById('app-confirm-email-title').textContent).toBe('Link not valid');
  });
});
