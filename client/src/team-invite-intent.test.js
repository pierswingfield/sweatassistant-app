import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreTeamInvite, pendingTeamInvite, prepareTeamInstall, finishTeamInviteHandoff, markTeamInviteSignup, isTeamInviteSignup, publicTeamPreview } from './team-invite-intent.js';
import { peekPendingInvite, stashPendingInvite } from './ui/teams-model.js';
import { createHash, webcrypto } from 'node:crypto';
const invite = 'a'.repeat(22);
const continuation = 'b'.repeat(43);
const response = (data, ok = true) => Promise.resolve({ ok, json: async () => data });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const responseWithJson = (promise) => Promise.resolve({ ok: true, json: () => promise });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('appUserId', '42');
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  document.head.innerHTML = '<link rel="manifest" href="/manifest.json">';
  vi.stubGlobal('fetch', vi.fn());
});

describe('Team install intent across separate storage', () => {
  it.each(['fetch', 'json'])('discards an old Team preview after delayed %s', async (phase) => {
    const wait = deferred(); const other = 'c'.repeat(22);
    history.replaceState(null, '', `/t/${invite}`);
    fetch.mockImplementation(() => phase === 'fetch' ? wait.promise : responseWithJson(wait.promise));
    const preview = publicTeamPreview();
    if (phase === 'json') await Promise.resolve();
    history.replaceState(null, '', `/t/${other}`); stashPendingInvite(localStorage, other);
    if (phase === 'fetch') wait.resolve({ ok: true, json: async () => ({ name: 'Old Team' }) });
    else wait.resolve({ name: 'Old Team' });
    await expect(preview).resolves.toBeNull();
  });
  it.each(['fetch', 'json'])('does not let a delayed %s redemption replace a newer Team link', async (phase) => {
    const wait = deferred(); const other = 'c'.repeat(22);
    history.replaceState(null, '', `/?teamContinuation=${continuation}`);
    fetch.mockImplementation(() => phase === 'fetch' ? wait.promise : responseWithJson(wait.promise));
    const restoring = restoreTeamInvite();
    if (phase === 'json') await Promise.resolve();
    history.replaceState(null, '', `/t/${other}`); stashPendingInvite(localStorage, other);
    if (phase === 'fetch') wait.resolve({ ok: true, json: async () => ({ inviteToken: invite }) });
    else wait.resolve({ inviteToken: invite });
    await restoring;
    expect(location.pathname).toBe(`/t/${other}`); expect(peekPendingInvite(localStorage)).toBe(other);
  });
  it.each(['fetch', 'json'])('does not install a stale manifest after delayed %s', async (phase) => {
    const wait = deferred(); const other = 'c'.repeat(22);
    history.replaceState(null, '', `/t/${invite}`);
    fetch.mockImplementation(() => phase === 'fetch' ? wait.promise : responseWithJson(wait.promise));
    const preparing = prepareTeamInstall();
    if (phase === 'json') await Promise.resolve();
    history.replaceState(null, '', `/t/${other}`); stashPendingInvite(localStorage, other);
    if (phase === 'fetch') wait.resolve({ ok: true, json: async () => ({ continuation }) });
    else wait.resolve({ continuation });
    await preparing;
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest.json');
    expect(localStorage.getItem('appTeamInstallContinuation')).toBeNull();
  });
  it('does not overwrite a newer manifest on the same route', async () => {
    history.replaceState(null, '', `/t/${invite}`);
    const wait = deferred(); fetch.mockReturnValue(wait.promise);
    const preparing = prepareTeamInstall();
    document.querySelector('[rel=manifest]').setAttribute('href', '/manifest-new.json');
    wait.resolve({ ok: true, json: async () => ({ continuation }) });
    await preparing;
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest-new.json');
  });
  it('does not reset a newer manifest when an old initial-manifest digest fails', async () => {
    const wait = deferred(); vi.stubGlobal('crypto', { subtle: { digest: () => wait.promise } });
    history.replaceState(null, '', `/t/${invite}`);
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${'a'.repeat(64)}">`;
    const preparing = prepareTeamInstall();
    document.querySelector('[rel=manifest]').setAttribute('href', '/manifest-new.json');
    wait.reject(new Error('digest failed')); await preparing;
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest-new.json');
  });
  it('restores only the invitation and removes the opaque token from the launch URL', async () => {
    history.replaceState(null, '', `/?teamContinuation=${continuation}`);
    fetch.mockImplementation(() => response({ inviteToken: invite }));
    await restoreTeamInvite();
    expect(fetch).toHaveBeenCalledWith(`/api/teams/continuation/${continuation}`, { method: 'POST' });
    expect(location.pathname).toBe(`/t/${invite}`);
    expect(location.search).toBe('');
    expect(peekPendingInvite(localStorage)).toBe(invite);
  });
  it('silently ignores a used token without deleting an unrelated current invitation', async () => {
    stashPendingInvite(localStorage, invite);
    history.replaceState(null, '', `/?teamContinuation=${continuation}`);
    fetch.mockImplementation(() => response({ inviteToken: null }));
    await restoreTeamInvite();
    expect(location.href).not.toContain('teamContinuation');
    expect(pendingTeamInvite()).toBe(invite);
    localStorage.clear();
    history.replaceState(null, '', `/?teamContinuation=${continuation}`);
    await restoreTeamInvite();
    expect(pendingTeamInvite()).toBeNull();
  });
  it('retains the launch URL through HTTP failures and network failures so refresh can retry', async () => {
    history.replaceState(null, '', `/?teamContinuation=${continuation}`);
    fetch.mockImplementationOnce(() => response({}, false)).mockRejectedValueOnce(new TypeError('offline'));
    await restoreTeamInvite();
    expect(location.search).toContain(continuation);
    await restoreTeamInvite();
    expect(location.search).toContain(continuation);
  });
  it('prepares an opaque manifest once and invalidates its token when the browser reaches the welcome', async () => {
    history.replaceState(null, '', `/t/${invite}`);
    fetch.mockImplementation(() => response({ continuation }));
    await prepareTeamInstall();
    await prepareTeamInstall();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe(`/api/teams/install-manifest/${continuation}`);
    markTeamInviteSignup(42);
    expect(isTeamInviteSignup(42)).toBe(true);
    expect(isTeamInviteSignup(43)).toBe(false);
    await finishTeamInviteHandoff();
    expect(fetch).toHaveBeenLastCalledWith(`/api/teams/continuation/${continuation}`, { method: 'POST' });
    expect(isTeamInviteSignup(42)).toBe(false);
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest.json');
  });
  it('reuses the initial document manifest for the same invite without issuing another', async () => {
    vi.stubGlobal('crypto', webcrypto);
    history.replaceState(null, '', `/t/${invite}`);
    const hash = createHash('sha256').update(invite).digest('hex');
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${hash}">`;
    await prepareTeamInstall();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe(`/api/teams/install-manifest/${continuation}`);
    await finishTeamInviteHandoff();
    expect(fetch).toHaveBeenCalledWith(`/api/teams/continuation/${continuation}`, { method: 'POST' });
  });
  it('invalidates an initial SSR handoff even when preparation never ran', async () => {
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${'a'.repeat(64)}">`;
    await finishTeamInviteHandoff();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`/api/teams/continuation/${continuation}`, { method: 'POST' });
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest.json');
  });
  it('deduplicates an initial handoff already saved by preparation', async () => {
    vi.stubGlobal('crypto', webcrypto);
    history.replaceState(null, '', `/t/${invite}`);
    const hash = createHash('sha256').update(invite).digest('hex');
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${hash}">`;
    await prepareTeamInstall();
    await finishTeamInviteHandoff();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`/api/teams/continuation/${continuation}`, { method: 'POST' });
  });
  it('invalidates both different initial and saved handoffs even if one request fails', async () => {
    localStorage.setItem('appTeamInstallContinuation', JSON.stringify({ invite, continuation: 'c'.repeat(43), at: Date.now() }));
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${'a'.repeat(64)}">`;
    fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true });
    await finishTeamInviteHandoff();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, `/api/teams/continuation/${continuation}`, { method: 'POST' });
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/teams/continuation/${'c'.repeat(43)}`, { method: 'POST' });
  });
  it('never invalidates an ordinary, foreign or malformed initial manifest', async () => {
    for (const link of [
      '<link rel="manifest" href="/manifest.json">',
      `<link rel="manifest" href="https://other.test/api/teams/install-manifest/${continuation}" data-team-invite-hash="${'a'.repeat(64)}">`,
      `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="bad">`,
      `<link rel="manifest" href="/api/teams/install-manifest/bad" data-team-invite-hash="${'a'.repeat(64)}">`,
    ]) {
      document.head.innerHTML = link;
      await finishTeamInviteHandoff();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reloads the current Team link once when the initial manifest belongs to another invite', async () => {
    vi.stubGlobal('crypto', webcrypto);
    history.replaceState(null, '', `/t/${invite}`);
    const hash = createHash('sha256').update('c'.repeat(22)).digest('hex');
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${hash}">`;
    const navigate = vi.fn();
    await prepareTeamInstall({ navigate });
    expect(navigate).toHaveBeenCalledWith(`/t/${invite}`);
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest.json');
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${hash}">`;
    await prepareTeamInstall({ navigate });
    expect(navigate).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toBe('/manifest.json');
    const matchingHash = createHash('sha256').update(invite).digest('hex');
    document.head.innerHTML = `<link rel="manifest" href="/api/teams/install-manifest/${continuation}" data-team-invite-hash="${matchingHash}">`;
    await prepareTeamInstall({ navigate });
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[rel=manifest]').getAttribute('href')).toContain(continuation);
  });
  it('never passes malformed continuation input to the server', async () => {
    history.replaceState(null, '', '/?teamContinuation=bad');
    await restoreTeamInvite();
    expect(fetch).not.toHaveBeenCalled();
    expect(location.search).toBe('');
  });
});

describe('authenticated Team signup setup restoration', () => {
  it('discards account A recovery after the signed-in account changes', async () => {
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    const wait = deferred(); const other = 'c'.repeat(22);
    const syncing = syncTeamInviteSignup(42, () => wait.promise);
    localStorage.setItem('appUserId', '43'); history.replaceState(null, '', `/t/${other}`);
    wait.resolve({ step: 'gyms', inviteToken: invite });
    expect(await syncing).toBeNull();
    history.replaceState(null, '', '/');
    expect(pendingTeamInvite()).toBeNull(); expect(isTeamInviteSignup(42)).toBe(false);
    expect(localStorage.getItem('appOnboardingStep:42')).toBeNull();
  });
  it('discards recovery errors after the account token changes', async () => {
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    localStorage.setItem('appLocalToken', 'old');
    const wait = deferred(); const syncing = syncTeamInviteSignup(42, () => wait.promise);
    localStorage.setItem('appLocalToken', 'new'); wait.reject(new Error('offline'));
    await expect(syncing).resolves.toBeNull();
  });
  it('discards stale recovery and errors when the same account opens a new Team', async () => {
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    const other = 'c'.repeat(22); const wait = deferred();
    const syncing = syncTeamInviteSignup(42, () => wait.promise);
    history.replaceState(null, '', `/t/${other}`); wait.resolve({ step: 'gyms', inviteToken: invite });
    expect(await syncing).toBeNull(); expect(isTeamInviteSignup(42)).toBe(false); expect(pendingTeamInvite()).toBe(other);
    const failure = deferred(); const retry = syncTeamInviteSignup(42, () => failure.promise);
    history.replaceState(null, '', `/t/${invite}`); failure.reject(new Error('offline'));
    await expect(retry).resolves.toBeNull();
  });
  it('restores the authenticated account step without copying account or session state from an install', async () => {
    history.replaceState(null, '', `/t/${invite}`);
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    const load = vi.fn().mockResolvedValue({ step: 'features' });
    expect(await syncTeamInviteSignup(42, load)).toBe('features');
    expect(load).toHaveBeenCalledWith(invite);
    expect(isTeamInviteSignup(42)).toBe(true);
    expect(localStorage.getItem('appOnboardingStep:42')).toBe('features');
  });
  it('does not inherit or erase another account signup marker when server returns no state', async () => {
    history.replaceState(null, '', `/t/${invite}`);
    markTeamInviteSignup(42);
    localStorage.setItem('appUserId', '43');
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    expect(await syncTeamInviteSignup(43, async () => ({ step: null }))).toBeNull();
    expect(isTeamInviteSignup(43)).toBe(false);
    expect(isTeamInviteSignup(42)).toBe(true);
  });
  it('fails closed on transient authenticated lookup failure and leaves retryable state', async () => {
    history.replaceState(null, '', `/t/${invite}`);
    markTeamInviteSignup(42);
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    await expect(syncTeamInviteSignup(42, async () => { throw new TypeError('offline'); })).rejects.toMatchObject({ code: 'TEAM_SETUP_UNAVAILABLE' });
    expect(isTeamInviteSignup(42)).toBe(true);
  });
});

describe('Team intent recovery when an installed launch loses all browser state', () => {
  it('recovers an unfinished own-account Team signup without any launch token or storage intent', async () => {
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    localStorage.setItem('appOnboardingComplete:42', '4'); // ordinary setup may already have finished
    const load = vi.fn().mockResolvedValue({ step: 'features', inviteToken: invite });
    expect(await syncTeamInviteSignup(42, load)).toBe('features');
    expect(load).toHaveBeenCalledWith(null);
    expect(pendingTeamInvite()).toBe(invite);
    expect(isTeamInviteSignup(42)).toBe(true);
    expect(localStorage.getItem('appOnboardingStep:42')).toBe('features');
  });
  it('does not replace an explicit different Team link with account recovery', async () => {
    const explicit = 'c'.repeat(22);
    history.replaceState(null, '', `/t/${explicit}`);
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    const load = vi.fn().mockResolvedValue({ step: null });
    expect(await syncTeamInviteSignup(42, load)).toBeNull();
    expect(load).toHaveBeenCalledWith(explicit);
    expect(pendingTeamInvite()).toBe(explicit);
    expect(location.pathname).toBe(`/t/${explicit}`);
  });
  it('requires a valid own invitation in the authenticated recovery response', async () => {
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    expect(await syncTeamInviteSignup(42, async () => ({ step: 'gyms', inviteToken: 'bad' }))).toBeNull();
    expect(pendingTeamInvite()).toBeNull();
    expect(isTeamInviteSignup(42)).toBe(false);
  });
  it('fails closed on a temporary account lookup failure even when no invite is in storage', async () => {
    const { syncTeamInviteSignup } = await import('./team-invite-intent.js');
    await expect(syncTeamInviteSignup(42, async () => { throw new TypeError('offline'); })).rejects.toMatchObject({ code: 'TEAM_SETUP_UNAVAILABLE' });
    expect(pendingTeamInvite()).toBeNull();
  });
});
