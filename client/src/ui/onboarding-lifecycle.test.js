import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getMyGyms: vi.fn(), getGyms: vi.fn(), getSettings: vi.fn(), getCalendarStatus: vi.fn(), getStudioPreferences: vi.fn(), updateSettings: vi.fn(), linkGym: vi.fn() }));
const initApp = vi.hoisted(() => vi.fn());
const calendarModal = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api, isLoggedIn: () => true }));
vi.mock('../main', () => ({ consumeInstallPrompt: vi.fn(), initApp, togglePushSubscription: vi.fn(), warmCaches: vi.fn(), showToast: vi.fn() }));
vi.mock('./home.js', () => ({ renderHome: vi.fn() }));
vi.mock('./settings', () => ({ openManageSpotMapsModal: vi.fn() }));
vi.mock('./calendar-section.js', () => ({ openCalendarSettingsModal: calendarModal }));
vi.mock('./teams-ui.js', () => ({ teamAvatar: () => '<span data-team-avatar></span>' }));
vi.mock('./gym-logo-strip.js', () => ({ startGymLogoDiscovery: vi.fn() }));
import { resumeOnboarding, startOnboarding } from './onboarding.js';
import { appConfig } from '../config.js';

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.appName = 'Testapp';
  window.matchMedia = () => ({ matches: true });
  document.body.innerHTML = '<div id="app-login-container"></div><div id="app-container"><section id="app-panel-home"><div class="app-tab-header"><h1>Home greeting</h1></div></section></div><div id="app-onboarding-container"></div>';
  api.getGyms.mockResolvedValue([{ id: 'alpha', name: 'Alpha', capabilities: { autoUpgrade: true } }]);
  api.getMyGyms.mockResolvedValue({ gyms: [{ gym_id: 'alpha', gym_name: 'Alpha' }] });
  api.getSettings.mockResolvedValue({});
  api.getCalendarStatus.mockResolvedValue({ enabled: false });
  api.getStudioPreferences.mockResolvedValue({});
  api.updateSettings.mockResolvedValue({});
});
afterEach(() => { document.body.innerHTML = ''; });
const feature = (name) => document.querySelector(`[data-feature="${name}"]`);
const ready = async () => vi.waitFor(() => expect(document.querySelectorAll('.app-onb-feature-status')).toHaveLength(4));
const finish = () => document.querySelector('.app-onb-finish').click();

describe('optional setup lifecycle', () => {
  it('offers four features, persists only an explicit switch, then collapses and reopens saved success', async () => {
    let saved;
    api.updateSettings.mockImplementation(() => new Promise((resolve) => { saved = resolve; }));
    const flow = resumeOnboarding({ optionalOnly: true }); await ready();
    expect(document.querySelectorAll('.app-onb-feature-card')).toHaveLength(4);
    const input = document.querySelector('[role="switch"]');
    expect(input.checked).toBe(false); expect(api.updateSettings).not.toHaveBeenCalled();
    input.click();
    await vi.waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ autoUpgradeEnabled: true }, 'alpha'));
    expect(feature('autoupgrade').classList.contains('is-complete')).toBe(false);
    expect(document.querySelector('.app-onb-finish').disabled).toBe(true);
    saved({});
    await vi.waitFor(() => expect(feature('autoupgrade').classList.contains('is-complete')).toBe(true));
    const status = feature('autoupgrade').querySelector('.app-onb-feature-status');
    expect(status.getAttribute('aria-expanded')).toBe('false'); status.click();
    expect(status.getAttribute('aria-expanded')).toBe('true');
    finish(); await flow; expect(initApp).toHaveBeenCalledTimes(1); expect(location.pathname).toBe('/');
  });

  it('keeps partial failure incomplete, rolls the switch back and permits retry', async () => {
    api.getMyGyms.mockResolvedValue({ gyms: [{ gym_id: 'alpha' }, { gym_id: 'beta' }] });
    api.getGyms.mockResolvedValue([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]);
    api.updateSettings.mockImplementation((_, id) => id === 'beta' ? Promise.reject(new Error('offline')) : Promise.resolve({}));
    const flow = resumeOnboarding({ optionalOnly: true }); await ready();
    const input = document.querySelector('[role="switch"]'); input.click();
    await vi.waitFor(() => expect(feature('autoupgrade').textContent).toContain('Could not enable Auto-Upgrade for Beta'));
    expect(input.checked).toBe(false); expect(input.disabled).toBe(false);
    expect(feature('autoupgrade').classList.contains('is-complete')).toBe(false);
    api.updateSettings.mockResolvedValue({}); input.click();
    await vi.waitFor(() => expect(feature('autoupgrade').classList.contains('is-complete')).toBe(true));
    finish(); await flow;
  });

  it('collapses persisted calendar status and requests the onboarding renderer when reopened', async () => {
    api.getCalendarStatus.mockResolvedValue({ enabled: true });
    const flow = resumeOnboarding({ optionalOnly: true }); await ready();
    const card = feature('calendar'); expect(card.classList.contains('is-complete')).toBe(true);
    card.querySelector('.app-onb-feature-status').click();
    card.querySelector('[data-feature-action]').click();
    expect(calendarModal.mock.calls[0][0].context).toBe('onboarding');
    const button = document.querySelector('.app-onb-finish'); expect(button.textContent).toBe('Continue to Testapp');
    button.click(); button.click(); await flow; expect(initApp).toHaveBeenCalledTimes(1);
  });

  it('finishes once even when a background animation never ticks, and focuses the stable greeting', async () => {
    window.matchMedia = () => ({ matches: false });
    const cancel = vi.fn();
    document.querySelector('#app-onboarding-container').animate = () => ({ finished: new Promise(() => {}), cancel });
    const flow = resumeOnboarding({ optionalOnly: true }); await ready(); finish();
    await flow;
    expect(cancel).toHaveBeenCalledOnce(); expect(initApp).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.querySelector('#app-panel-home h1'));
  });

  it('leaves gym credentials hidden until selection and keeps the strip across form state changes', async () => {
    api.getMyGyms.mockResolvedValue({ gyms: [{ gym_id: 'other' }] });
    const flow = startOnboarding(); document.querySelector('.app-onb-auth').click();
    await vi.waitFor(() => expect(document.querySelector('#app-onb-add-another')).not.toBeNull());
    const strip = document.querySelector('.app-onb-gym-logos');
    document.querySelector('#app-onb-add-another').click();
    const select = document.querySelector('#app-onb-gym-select');
    expect(select.value).toBe(''); expect(document.querySelector('.app-onb-credentials').hidden).toBe(true);
    select.value = 'alpha'; select.dispatchEvent(new Event('change'));
    expect(document.querySelector('.app-onb-credentials').hidden).toBe(false);
    expect(api.linkGym).not.toHaveBeenCalled(); expect(document.querySelector('.app-onb-gym-logos')).toBe(strip);
    document.querySelector('.app-onb-continue').click();
    await vi.waitFor(() => expect(document.querySelector('.app-onb-name-save')).not.toBeNull());
    document.querySelector('#app-onb-first-name').value = 'Alex'; document.querySelector('.app-onb-name-save').click();
    await ready(); finish(); await flow;
  });
});
