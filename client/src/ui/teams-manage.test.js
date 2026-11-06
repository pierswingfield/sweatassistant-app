// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const api = {
  get: vi.fn(), list: vi.fn(), listRequests: vi.fn(), getInvite: vi.fn(), updateMe: vi.fn(), update: vi.fn(), setInviteEnabled: vi.fn(),
};
let pushReady = true;
vi.mock('../main.js', () => ({ showToast: vi.fn(), debugLog: vi.fn() }));
vi.mock('../teams-api.js', () => ({ teamsApi: new Proxy({}, { get: (_, k) => api[k] || vi.fn(() => Promise.resolve({})) }) }));
vi.mock('./device-push.js', () => ({ devicePushReady: () => Promise.resolve(pushReady) }));
vi.mock('./teams.js', () => ({ goTeams: vi.fn() }));
vi.mock('../gym-context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllLinkedGyms: () => [{ gym_id: 'gym-a' }, { gym_id: 'gym-b' }],
  getGymShortName: (g) => g,
}));

let manage;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const SHARE = { gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true, spots: true, autoBookQueue: true, competition: false };

function setup({ role = 'member', paused = false, pausedUntil = null, alertsEnabled = false, push = true } = {}) {
  pushReady = push;
  api.get.mockResolvedValue({
    team: { id: 't1', name: 'Riders', emoji: '🚴', memberCount: 3, weeklyGoal: null, inviteEnabled: true },
    myRole: role, myShare: SHARE, paused, pausedUntil, alertsEnabled, members: [],
  });
  api.list.mockResolvedValue({ teams: [{ id: 't1', pinned: false }] });
  api.listRequests.mockResolvedValue({ requests: [] });
  api.getInvite.mockResolvedValue({ enabled: true });
  api.updateMe.mockResolvedValue({});
}

beforeAll(async () => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  (await import('../config.js')).appConfig.appName = 'Testapp';
  manage = await import('./teams-manage.js');
});
afterEach(() => { document.body.innerHTML = ''; Object.values(api).forEach((f) => f.mockReset()); });

const body = () => document.querySelector('.tm-ovl-body');
const footerLabel = () => document.querySelector('.tm-ovl-footer button').textContent;

describe('Team settings page (T12)', () => {
  it('Captain: removed copy is gone, ONE My sharing row with a summary, emoji row merged into name', async () => {
    setup({ role: 'captain' });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-my-sharing]')).toBeTruthy());
    const text = body().textContent;
    for (const gone of ['Old links stop working', 'Turn off to stop new requests', 'Deleting asks you to type', 'can see about you. Changes apply']) expect(text).not.toContain(gone);
    expect(text).toContain('Reset Team invite link');
    expect(text).toContain('Allow people to join with the link');
    expect(body().querySelectorAll('[data-my-sharing]').length).toBe(1);
    expect(body().querySelector('[data-my-sharing]').textContent).toContain("You're sharing 2 gyms and all of your class information");
    expect(body().querySelector('[data-edit="emoji"]')).toBeNull();
    expect(body().querySelector('[data-edit="name"]').textContent).toContain('Name and emoji');
    expect(footerLabel()).toBe('Done');
  });

  it('join requests help sits behind an accessible (i) toggle inside the list', async () => {
    setup({ role: 'captain' });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-info-toggle]')).toBeTruthy());
    const btn = body().querySelector('[data-info-toggle]');
    const text = document.getElementById(btn.getAttribute('aria-controls'));
    expect(btn.closest('.tm-list')).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(text.hidden).toBe(true);
    expect(text.textContent).toContain('If you decline, block or remove someone');
    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(text.hidden).toBe(false);
    btn.click();
    expect(text.hidden).toBe(true);
  });

  it('Member sharing page: Save button, no help line, hide selector only while hidden', async () => {
    setup({ role: 'member' });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-pause-switch]')).toBeTruthy());
    expect(footerLabel()).toBe('Save');
    expect(body().textContent).not.toContain('Changes apply straight away');
    expect(body().querySelector('[data-pause]')).toBeNull();
    expect(body().textContent).toContain('Never shared: your private details, gym credentials, cancellations and no-shows.');
  });

  it('turning Hide on defaults to "Until I unhide"; the selector appears once hidden', async () => {
    setup({ role: 'member' });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-pause-switch]')).toBeTruthy());
    const sw = body().querySelector('[data-pause-switch]');
    sw.checked = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    expect(api.updateMe).toHaveBeenCalledWith('t1', { pause: 'indefinite' });
    setup({ role: 'member', paused: true, pausedUntil: '9999-12-31T00:00:00.000Z' });
    document.body.innerHTML = '';
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelectorAll('[data-pause]').length).toBe(3));
    expect(body().querySelector('[data-pause="indefinite"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('Notifications card: renamed, enabled when visible with push set up', async () => {
    setup({ role: 'member', alertsEnabled: true });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-alerts-switch]')).toBeTruthy());
    const card = body().querySelector('[data-notify-card]');
    expect(body().textContent).toContain('Notifications');
    expect(card.textContent).toContain('Team notifications enabled');
    expect(card.textContent).not.toContain('Off until you turn it on');
    expect(card.classList.contains('is-disabled')).toBe(false);
    expect(body().querySelector('[data-alerts-switch]').disabled).toBe(false);
  });

  it('Notifications card is disabled with the reason: hidden first, then no device push', async () => {
    setup({ role: 'member', paused: true, pausedUntil: '9999-12-31T00:00:00.000Z', push: false });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-alerts-switch]')).toBeTruthy());
    let card = body().querySelector('[data-notify-card]');
    expect(card.classList.contains('is-disabled')).toBe(true);
    expect(body().querySelector('[data-alerts-switch]').disabled).toBe(true);
    expect(card.textContent).toContain("Disabled while you're hidden.");
    document.body.innerHTML = '';
    setup({ role: 'member', push: false });
    manage.openManage('t1');
    await vi.waitFor(() => expect(body().querySelector('[data-alerts-switch]')).toBeTruthy());
    card = body().querySelector('[data-notify-card]');
    expect(body().querySelector('[data-alerts-switch]').disabled).toBe(true);
    expect(card.textContent).toContain('Notifications are not set up for this device.');
  });
});
