import { describe, it, expect, beforeEach, vi } from 'vitest';
import { connectionEpoch, connectionStates, isGymAvailable, isAvailableLink, updateConnectionStates, noteUnavailable } from './gym-availability.js';
vi.mock('./config.js', () => ({ appConfig: { appName: 'Dibs' } }));
import { gymLoginChoiceHtml, bindGymLoginChoice, sessionNotice } from './ui/gym-login-choice.js';
describe('gym connection availability', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('appUserId', 'member-a'); });
  it('keeps failed gyms unavailable after reload while preserving healthy gyms', () => {
    updateConnectionStates([{ gym_id: 'gym-a', status: 'needs_relogin' }, { gym_id: 'gym-b', status: 'active' }]);
    expect(isAvailableLink({ gym_id: 'gym-a', status: 'active' })).toBe(false);
    expect(isGymAvailable('gym-b')).toBe(true);
    expect(JSON.parse(localStorage.getItem('dibs:gym-connections:member-a'))['gym-a'].status).toBe('needs_relogin');
  });
  it('separates connection availability from the explicit gym switch', () => {
    expect(isAvailableLink({ gym_id: 'gym-a', status: 'active', account_enabled: 0 })).toBe(false);
    expect(isAvailableLink({ gym_id: 'gym-a', status: 'syncing', account_enabled: 1 })).toBe(false);
    expect(isAvailableLink({ gym_id: 'gym-a', status: 'active', account_enabled: 1 })).toBe(true);
  });
  it('deduplicates a failure and advances the epoch to retire late responses', () => {
    const before = connectionEpoch();
    expect(noteUnavailable('gym-a')).toBe(true); expect(connectionEpoch()).toBe(before + 1);
    expect(noteUnavailable('gym-a')).toBe(false); expect(connectionEpoch()).toBe(before + 1);
  });
  it('isolates persisted warnings between accounts', () => {
    noteUnavailable('gym-a'); localStorage.setItem('appUserId', 'member-b');
    expect(isGymAvailable('gym-a')).toBe(true); expect(connectionStates()).toEqual({});
  });
  it('only restores availability from fresh confirmed server state', () => {
    updateConnectionStates([{ gym_id: 'gym-a', status: 'needs_relogin' }]);
    expect(updateConnectionStates([{ gym_id: 'gym-a', status: 'active' }])).toBe(true);
    expect(isGymAvailable('gym-a')).toBe(true);
  });
});
describe('explicit gym login disclosure', () => {
  it('starts unticked on each render and uses the exact unchecked notice', () => {
    document.body.innerHTML = gymLoginChoiceHtml('remember'); bindGymLoginChoice(document.body);
    const checkbox = document.querySelector('input'); expect(checkbox.checked).toBe(false);
    expect(document.querySelector('[data-gym-login-notice]').textContent).toBe('Dibs won’t save copies of your gym login details. You may be asked to log back in more often.');
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    expect(document.querySelector('[data-gym-login-notice]').textContent).toBe('Dibs will securely store copies of your gym login details, and use them on your behalf. More info can be found in the Terms and Conditions and Privacy Policy.');
    expect([...document.querySelectorAll('a')].map(a => a.textContent)).toEqual(['Terms and Conditions', 'Privacy Policy']);
    document.body.innerHTML = gymLoginChoiceHtml('remember-again'); expect(document.querySelector('input').checked).toBe(false);
  });
  it('returns to the unchecked notice after opt out', () => {
    document.body.innerHTML = gymLoginChoiceHtml('remember'); bindGymLoginChoice(document.body);
    const checkbox = document.querySelector('input'); checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
    expect(document.querySelector('[data-gym-login-notice]').textContent).toBe(sessionNotice);
  });
});
