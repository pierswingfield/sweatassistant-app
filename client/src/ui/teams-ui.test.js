import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../main.js', () => ({ showToast: vi.fn(), debugLog: vi.fn() }));
vi.mock('../gym-context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllLinkedGyms: () => [{ gym_id: 'gym-a' }, { gym_id: 'gym-b' }],
  getGymShortName: (g) => ({ 'gym-a': 'Gym A', 'gym-b': 'Gym <B>' }[g] || g),
}));

let ui;
const mobile = (matches) => { window.matchMedia = (query) => ({ matches, media: query, addEventListener() {}, removeEventListener() {} }); };

beforeAll(async () => {
  mobile(false);
  ui = await import('./teams-ui.js');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Teams markup escapes every user-supplied string', () => {
  it('avatar initials and labels', () => {
    const html = ui.avatarHtml({ name: '<img src=x onerror=1> Bob', colourIndex: 21 });
    expect(html).not.toContain('<img');
    expect(html).toContain('tm-av-c5');
    expect(html).toContain('aria-label="&lt;img src=x onerror=1&gt; Bob"');
  });
  it('team titles: the name alone, escaped (T10: the emoji lives on the Team avatar)', () => {
    expect(ui.teamTitleHtml({ name: '"><script>x</script>', emoji: '🚲' })).toBe('&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(ui.teamTitleText({ name: 'Riders', emoji: '🚲' })).toBe('Riders');
  });
  it('Team avatar: emoji in its badge, escaped', () => {
    const html = ui.teamAvatar({ emoji: '<i>', size: 'lg' });
    expect(html).toContain('tm-tav tm-tav-lg');
    expect(html).toContain('&lt;i&gt;');
    expect(html).toContain('tm-mascot');
  });
});

describe('leave confirmation names what stops being shared (§5.7)', () => {
  it('lists only what is shared', () => {
    expect(ui.sharedThingsText({ gyms: 'all', upcoming: true, waitlists: false, activity: true, recent: true })).toBe('upcoming classes, activity counts and recent classes');
    expect(ui.sharedThingsText({ gyms: ['gym-a'], spots: true })).toBe('spot numbers');
    expect(ui.sharedThingsText({ gyms: [], upcoming: true })).toBe('');
    expect(ui.leaveBodyText('Riders', { gyms: [] })).toContain("You aren't sharing anything with Riders");
    expect(ui.leaveBodyText('Riders', { gyms: 'all', upcoming: true })).toContain('Riders will stop seeing your upcoming classes straight away');
  });
});

describe('sharing sheet (§3)', () => {
  it('starts from the given share and reports edits', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    const sheet = ui.renderSharingSheet(host, { share: { gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true, spots: false, autoBookQueue: false }, onChange });
    expect(host.querySelector('input[data-share-key="upcoming"]').checked).toBe(true);
    expect(host.querySelector('input[data-share-key="spots"]').checked).toBe(false);
    expect(host.innerHTML).toContain('Gym &lt;B&gt;');
    expect(host.querySelector('input[data-share-key="competition"]')).toBeNull();

    const spots = host.querySelector('input[data-share-key="spots"]');
    spots.checked = true;
    spots.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    expect(sheet.getShare().spots).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    host.querySelector('[data-gyms-mode="choose"]').click();
    await Promise.resolve();
    expect(sheet.getShare().gyms).toEqual(['gym-a', 'gym-b']);
    host.querySelector('[data-gym="gym-b"]').click();
    await Promise.resolve();
    expect(sheet.getShare().gyms).toEqual(['gym-a']);
  });

  it('reverts a change the server refused', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const sheet = ui.renderSharingSheet(host, { share: { gyms: 'all', upcoming: true }, onChange: () => Promise.reject(new Error('nope')) });
    const up = host.querySelector('input[data-share-key="upcoming"]');
    up.checked = false;
    up.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(sheet.getShare().upcoming).toBe(true));
  });

  it('shows the competition opt-in only when asked', () => {
    const host = document.createElement('div');
    ui.renderSharingSheet(host, { share: {}, competitionTeamName: 'Riders' });
    expect(host.querySelector('input[data-share-key="competition"]')).not.toBeNull();
  });
});

describe('Teams pages use modal-nav (DESIGN.md §6.2.1)', () => {
  it('is a full-screen page on mobile and closes once', async () => {
    mobile(true);
    const onClose = vi.fn();
    const page = ui.openTeamsPage({ title: 'Manage', onClose });
    expect(page.overlay.classList.contains('app-page')).toBe(true);
    expect(page.overlay.querySelector('[data-nav-title]').textContent).toBe('Manage');
    ui.setFooter(page, [{ label: 'Done', kind: 'primary', onClick: () => page.close() }]);
    page.footer.querySelector('button').click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
    expect(onClose).toHaveBeenCalledTimes(1);
    mobile(false);
  });

  it('closes on desktop and calls onClose once', () => {
    mobile(false);
    const onClose = vi.fn();
    const page = ui.openTeamsPage({ title: 'X', onClose });
    page.close();
    page.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('typed confirmation enables only on the exact name', async () => {
    mobile(false);
    const p = ui.confirmPage({ title: 'Delete', body: 'Sure?', confirmLabel: 'Delete Team', danger: true, typeToConfirm: 'Riders', typeLabel: 'Team name' });
    const overlay = document.querySelector('.tm-ovl');
    const [, ok] = overlay.querySelectorAll('.tm-ovl-footer button');
    expect(ok.disabled).toBe(true);
    const input = overlay.querySelector('input.tm-input');
    input.value = 'riders';
    input.dispatchEvent(new Event('input'));
    expect(ok.disabled).toBe(true);
    input.value = 'Riders';
    input.dispatchEvent(new Event('input'));
    expect(ok.disabled).toBe(false);
    ok.click();
    await expect(p).resolves.toBe(true);
  });
});
