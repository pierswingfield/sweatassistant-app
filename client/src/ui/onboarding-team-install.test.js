import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ loggedIn: false, invite: 'invite', signup: false }));
const api = vi.hoisted(() => ({ getGyms: vi.fn(), getMyGyms: vi.fn(), teamSignupOnboarding: vi.fn(), getSettings: vi.fn() }));
vi.mock('../api', () => ({ api, isLoggedIn: () => state.loggedIn }));
vi.mock('../team-invite-intent.js', () => ({ pendingTeamInvite: () => state.invite, isTeamInviteSignup: () => state.signup, publicTeamPreview: async () => null }));
vi.mock('../main', () => ({ consumeInstallPrompt: vi.fn(), initApp: vi.fn(), togglePushSubscription: vi.fn(), warmCaches: vi.fn(), showToast: vi.fn() }));
vi.mock('./settings', () => ({ openManageSpotMapsModal: vi.fn() }));
vi.mock('./calendar-section.js', () => ({ openCalendarSettingsModal: vi.fn() }));
vi.mock('./gym-logo-strip.js', () => ({ startGymLogoDiscovery: vi.fn(), setGymLogoDiscoveryVisible: vi.fn() }));
import { startOnboarding, resumeOnboarding, offerInstallBeforeLogin, advanceAfterLogin } from './onboarding.js';
import { initApp } from '../main';

beforeEach(() => {
  vi.clearAllMocks();
  state.loggedIn = false; state.invite = 'invite'; state.signup = false;
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone) AppleWebKit Safari' });
  window.matchMedia = () => ({ matches: false });
  document.body.innerHTML = '<div id="app-login-container"><button id="app-auth-to-login"></button><button id="app-auth-to-signup"></button></div><div id="app-container"></div><div id="app-onboarding-container"></div>';
  api.getGyms.mockResolvedValue([{ id: 'alpha', name: 'Alpha' }]);
  api.getMyGyms.mockResolvedValue({ gyms: [] });
  api.teamSignupOnboarding.mockResolvedValue({});
  api.getSettings.mockResolvedValue({});
});

describe('Team invitation onboarding order', () => {
  it('does not offer the standalone pre-login install screen for a Team invite', () => {
    offerInstallBeforeLogin();
    expect(document.querySelector('.app-onb-skip-inline')).toBeNull();
  });
  it('retains the pre-login offer when there is no Team invite', () => {
    state.invite = null;
    offerInstallBeforeLogin();
    expect(document.querySelector('.app-onb-skip-inline')).not.toBeNull();
  });
  it('offers account choice before install, then install after new signup before gyms', async () => {
    startOnboarding();
    expect(document.querySelector('[data-auth-mode="signup"]')).not.toBeNull();
    document.querySelector('[data-auth-mode="signup"]').click();
    await vi.waitFor(() => expect(document.querySelector('#app-login-container').style.display).toBe('flex'));
    state.loggedIn = true; state.signup = true;
    advanceAfterLogin({ resumeStep: 'gyms', newSignup: true });
    await vi.waitFor(() => expect(document.querySelector('#app-onboarding-container').dataset.step).toBe('install'));
    document.querySelector('.app-onb-skip-inline').click();
    await vi.waitFor(() => expect(document.querySelector('#app-onboarding-container').dataset.step).toBe('gyms'));
  });
  it('keeps the ordinary mobile intro followed by install', async () => {
    state.invite = null; startOnboarding();
    expect(document.querySelectorAll('[data-auth-mode]')).toHaveLength(1);
    document.querySelector('[data-auth-mode]').click();
    await vi.waitFor(() => expect(document.querySelector('#app-onboarding-container').dataset.step).toBe('install'));
  });
  it('takes a returning Team login straight to the invite without install or setup', async () => {
    const flow = startOnboarding();
    document.querySelector('[data-auth-mode="login"]').click();
    await vi.waitFor(() => expect(document.querySelector('#app-login-container').style.display).toBe('flex'));
    state.loggedIn = true;
    advanceAfterLogin({ skipSetup: true });
    await flow;
    expect(initApp).toHaveBeenCalledOnce();
    expect(location.pathname).toBe('/t/invite');
    expect(document.querySelector('.app-onb-skip-inline')).toBeNull();
  });
  it('skips install in standalone after signup and resumes pending setup on login', async () => {
    window.matchMedia = (query) => ({ matches: query === '(display-mode: standalone)' });
    startOnboarding();
    document.querySelector('[data-auth-mode="signup"]').click();
    await vi.waitFor(() => expect(document.querySelector('#app-login-container').style.display).toBe('flex'));
    state.loggedIn = true; state.signup = true;
    advanceAfterLogin({ resumeStep: 'gyms', newSignup: true });
    await vi.waitFor(() => expect(document.querySelector('#app-onboarding-container').dataset.step).toBe('gyms'));
  });
  it('resumes an existing pending setup stage without reoffering install', async () => {
    startOnboarding();
    document.querySelector('[data-auth-mode="login"]').click();
    await vi.waitFor(() => expect(document.querySelector('#app-login-container').style.display).toBe('flex'));
    state.loggedIn = true; state.signup = true;
    advanceAfterLogin({ resumeStep: 'gyms' });
    await vi.waitFor(() => expect(document.querySelector('#app-onboarding-container').dataset.step).toBe('gyms'));
  });
  it('does not resume the old anonymous install step before Team authentication', async () => {
    localStorage.setItem('appOnboardingStep:anonymous', 'install');
    resumeOnboarding();
    expect(document.querySelector('[data-auth-mode="signup"]')).not.toBeNull();
    expect(document.querySelector('#app-onboarding-container').dataset.step).toBe('intro');
  });
});
