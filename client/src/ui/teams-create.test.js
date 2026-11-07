// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
vi.mock('../main.js', () => ({ showToast: vi.fn(), debugLog: vi.fn() }));
vi.mock('../teams-api.js', () => ({ teamsApi: { create: (...a) => create(...a), getInvite: vi.fn() } }));
vi.mock('../gym-context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllLinkedGyms: () => [{ gym_id: 'gym-a' }],
  getGymShortName: () => 'Gym A',
}));

let flow;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  (await import('../config.js')).appConfig.appName = 'Testapp';
  flow = await import('./teams-create.js');
});

afterEach(() => {
  document.body.innerHTML = '';
  create.mockReset();
});

const byEmoji = (e) => [...document.querySelectorAll('[data-emoji]')].find((b) => b.getAttribute('data-emoji') === e);
const step = () => document.querySelector('[data-cf-step]').dataset.cfStep;
const primary = () => document.querySelector('.tm-ovl-footer .tm-btn-primary');

describe('create flow markup (T10)', () => {
  it('progress indicator: "Step n of 3", hidden on ready', () => {
    const html = flow.progressHtml('emoji');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('Step 2 of 3');
    expect((html.match(/is-done/g) || []).length).toBe(2);
    expect(flow.progressHtml('ready')).toBe('');
  });

  it('escapes the mascot line and the Team name on the ready page', () => {
    expect(flow.bubbleHtml('<b>hi</b>')).toContain('&lt;b&gt;hi&lt;/b&gt;');
    const html = flow.readyHtml({ name: '<img src=x onerror=1>', emoji: '"><svg onload=1>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg onload');
    expect(html).toContain('You&#39;re the captain of <b>&lt;img src=x onerror=1&gt;</b>.');
    expect(html).toContain('Your Team is ready!');
  });
});

describe('create flow walk-through (T10)', () => {
  it('name focus enters compact editing mode and restores Ideas after blur settles', async () => {
    flow.openCreateTeamFlow(); const input = document.querySelector('.tm-cf-name');
    input.focus(); expect(document.querySelector('.tm-cf-ovl').classList.contains('is-name-editing')).toBe(true);
    input.blur(); expect(document.querySelector('.tm-cf-ovl').classList.contains('is-name-editing')).toBe(true);
    await tick(260); expect(document.querySelector('.tm-cf-ovl').classList.contains('is-name-editing')).toBe(false);
  });

  it('name -> emoji -> sharing -> ready, then shares the invite text', async () => {
    const onCreated = vi.fn();
    const onGoToTeam = vi.fn();
    flow.openCreateTeamFlow({ onCreated, onGoToTeam });
    expect(step()).toBe('name');
    // No Back on the first step, and no "Up to 40 characters" helper.
    expect(document.querySelectorAll('.tm-ovl-footer button')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Up to 40 characters');

    // Continue with no name: a gentle error, still on step 1.
    primary().click();
    expect(step()).toBe('name');
    expect(document.querySelector('.tm-cf-error').hidden).toBe(false);

    // Too long: the inline error appears as you type.
    const input = document.querySelector('.tm-cf-name');
    input.value = 'x'.repeat(41);
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector('.tm-cf-error').textContent).toBe('Keep it to 40 characters.');

    // A suggestion fills the input.
    const sug = document.querySelector('[data-suggest]');
    sug.click();
    expect(input.value).toBe(sug.getAttribute('data-suggest'));
    input.value = 'Run <Club>';
    input.dispatchEvent(new Event('input'));
    input.value = 'Run Club';
    input.dispatchEvent(new Event('input'));
    primary().click();
    expect(step()).toBe('emoji');

    // Pick from the grid: the live avatar preview shows it.
    byEmoji('🚴').click();
    expect(document.querySelector('[data-cf-preview] .tm-tav-emoji').textContent).toBe('🚴');
    // Or type any emoji.
    const other = document.querySelector('.tm-cf-other-input');
    other.value = '🏃';
    other.dispatchEvent(new Event('input'));
    expect(document.querySelector('[data-cf-preview] .tm-tav-emoji').textContent).toBe('🏃');
    expect(document.querySelectorAll('.tm-cf-emo.is-on')).toHaveLength(0);

    // Back keeps the draft.
    document.querySelector('.tm-ovl-footer .tm-btn-ghost').click();
    expect(step()).toBe('name');
    expect(document.querySelector('.tm-cf-name').value).toBe('Run Club');
    primary().click();
    primary().click();
    expect(step()).toBe('sharing');
    expect(document.querySelector('.tm-cf-teamname').textContent).toBe('Run Club');
    expect(document.querySelector('.tm-cf-hero .tm-tav-hero .tm-tav-emoji').textContent).toBe('🏃');
    // Segmented control and gym cards carry an explicit selected state.
    expect(document.querySelector('[data-gyms-mode="all"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.tm-gymcard').classList.contains('is-on')).toBe(true);

    create.mockResolvedValue({ team: { id: 't1', name: 'Run Club', emoji: '🏃' }, inviteToken: 'AbCdEfGhIjKlMnOpQrStUv' });
    primary().click();
    await tick(10);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Run Club', emoji: '🏃' }));
    expect(onCreated).toHaveBeenCalled();
    expect(step()).toBe('ready');
    expect(document.querySelector('.tm-ovl').classList.contains('is-untitled')).toBe(true);
    expect(document.querySelector('.tm-ovl-footer').hidden).toBe(true);
    expect(document.querySelector('.tm-cf-readyname').textContent).toBe('Run Club');

    const share = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    document.querySelector('[data-cf-share]').click();
    await tick(10);
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      text: "You're invited to Testapp! Join my Team 🏃 Run Club.",
      url: `${window.location.origin}/t/AbCdEfGhIjKlMnOpQrStUv`,
    }));

    // Fallback: no share sheet -> the clipboard gets the message and the link.
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    document.querySelector('[data-cf-share]').click();
    await tick(10);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Join my Team 🏃 Run Club.\n'));
    const { showToast } = await import('../main.js');
    expect(showToast).toHaveBeenCalledWith('Invite copied. Paste it into your group chat.', 'success');

    document.querySelector('[data-cf-go]').click();
    await tick(10);
    expect(onGoToTeam).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('keeps the member on the sharing step when creation fails', async () => {
    flow.openCreateTeamFlow();
    const input = document.querySelector('.tm-cf-name');
    input.value = 'Riders';
    input.dispatchEvent(new Event('input'));
    primary().click();
    primary().click();
    create.mockRejectedValue(Object.assign(new Error('nope'), { code: 'TEAM_LIMIT' }));
    primary().click();
    await tick(10);
    expect(step()).toBe('sharing');
    expect(primary().disabled).toBe(false);
  });

  it('blocks Continue on an invalid typed emoji until it is fixed', () => {
    flow.openCreateTeamFlow();
    const input = document.querySelector('.tm-cf-name');
    input.value = 'Run Club';
    input.dispatchEvent(new Event('input'));
    primary().click();
    expect(step()).toBe('emoji');
    byEmoji('🚴').click();
    const other = document.querySelector('.tm-cf-other-input');
    other.value = 'abc';
    other.dispatchEvent(new Event('input'));
    primary().click();
    expect(step()).toBe('emoji');
    expect(document.querySelector('.tm-cf-error').hidden).toBe(false);
    other.value = '🏃';
    other.dispatchEvent(new Event('input'));
    primary().click();
    expect(step()).toBe('sharing');
  });
});
