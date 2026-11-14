import { describe, it, expect } from 'vitest';
import { shouldOpenInviteImmediately, hasSavedAccountName } from './onboarding-routing.js';

describe('Team invitation entry routing', () => {
  it('opens the welcome immediately for an existing session or returning login, even with no gym', () => {
    expect(shouldOpenInviteImmediately({ hasInvite: true })).toBe(true);
  });
  it('keeps a new signup in onboarding until setup has finished', () => {
    expect(shouldOpenInviteImmediately({ hasInvite: true, newSignup: true })).toBe(false);
    expect(shouldOpenInviteImmediately({ hasInvite: false })).toBe(false);
  });
  it('skips name capture only for saved, valid first and last names', () => {
    expect(hasSavedAccountName({ firstName: 'Alex', lastName: 'Smith' })).toBe(true);
    expect(hasSavedAccountName({ firstName: 'Alex' })).toBe(false);
    expect(hasSavedAccountName({ firstName: '<Alex>', lastName: 'Smith' })).toBe(false);
    expect(hasSavedAccountName({})).toBe(false);
  });
});
