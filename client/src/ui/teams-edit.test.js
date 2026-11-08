// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const update = vi.fn(() => Promise.resolve({}));
vi.mock('../main.js', () => ({ showToast: vi.fn(), debugLog: vi.fn() }));
vi.mock('../teams-api.js', () => ({ teamsApi: { update: (...a) => update(...a) } }));
vi.mock('../gym-context.js', async (importOriginal) => ({ ...(await importOriginal()), getAllLinkedGyms: () => [], getGymShortName: (g) => g }));

let edit;
beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  (await import('../config.js')).appConfig.appName = 'Testapp';
  edit = await import('./teams-edit.js');
});
afterEach(() => { document.body.innerHTML = ''; update.mockClear(); });

const team = { id: 't1', name: 'Riders', emoji: '🚴' };

describe('Team name and emoji edit page (T12)', () => {
  it('editChanges sends only what changed, and emoji "" clears to null', () => {
    expect(edit.editChanges(team, { name: 'Riders', emoji: '🚴' })).toEqual({});
    expect(edit.editChanges(team, { name: 'Cyclists', emoji: '🚴' })).toEqual({ name: 'Cyclists' });
    expect(edit.editChanges(team, { name: 'Riders', emoji: '' })).toEqual({ emoji: null });
    expect(edit.editChanges({ name: 'A', emoji: null }, { name: 'A', emoji: '' })).toEqual({});
  });

  it('escapes the Team name nowhere in markup (it lives in the input value) and shows the create-flow pieces', () => {
    const html = edit.editBodyHtml({ name: '<img src=x onerror=1>', emoji: '' });
    expect(html).not.toContain('<img src=x');
    for (const c of ['tm-cf-name', 'data-suggests', 'tm-cf-emojis', 'data-cf-preview']) expect(html).toContain(c);
    expect(html).toContain('placeholder="Name your Team"');
  });

  it('saves a new name and emoji; Save is the footer button', async () => {
    const onSaved = vi.fn();
    edit.openEditTeamPage(team, { onSaved });
    const input = document.querySelector('.tm-cf-name');
    expect(input.value).toBe('Riders');
    expect(document.querySelector('.tm-ovl-footer button').textContent).toBe('Save');
    input.value = 'Night Riders';
    input.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('[data-emoji]')].find((b) => b.getAttribute('data-emoji') === '🌙').click();
    document.querySelector('.tm-ovl-footer button').click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('t1', { name: 'Night Riders', emoji: '🌙' }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('rejects an empty name without calling the server', async () => {
    edit.openEditTeamPage(team);
    const input = document.querySelector('.tm-cf-name');
    input.value = '   ';
    document.querySelector('.tm-ovl-footer button').click();
    expect(update).not.toHaveBeenCalled();
    expect(document.querySelector('[data-name-error]').hidden).toBe(false);
  });

  it('blocks Save on an invalid typed emoji, and double Enter sends one PATCH', async () => {
    edit.openEditTeamPage(team);
    const other = document.querySelector('.tm-cf-other-input');
    other.value = 'abc';
    other.dispatchEvent(new Event('input'));
    const err = document.querySelector('.tm-cf-error:not([data-name-error])');
    expect(err.hidden).toBe(false);
    document.querySelector('.tm-ovl-footer button').click();
    expect(update).not.toHaveBeenCalled();
    other.value = '🌙';
    other.dispatchEvent(new Event('input'));
    const input = document.querySelector('.tm-cf-name');
    const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    enter(); enter();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('t1', { emoji: '🌙' });
  });
});
