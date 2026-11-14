// A Team link is an intent to view an invitation, never permission to join.
import { COPY } from './copy.js';
import { parseTeamsPath, isInviteToken, stashPendingInvite, peekPendingInvite } from './ui/teams-model.js';

const INSTALL_KEY = 'appTeamInstallContinuation';
const SIGNUP_KEY = 'appTeamInviteSignup';
const INITIAL_RELOAD_KEY = 'appTeamInitialManifestReload';
let blockedInitialInvite = null;
const storage = () => { try { return window.localStorage; } catch { return null; } };
const read = (key) => { try { return storage()?.getItem(key); } catch { return null; } };
const write = (key, value) => { try { value === null ? storage()?.removeItem(key) : storage()?.setItem(key, value); } catch { /* blocked storage */ } };
const opaque = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const intentSnapshot = () => ({ href: location.href, pending: read('appPendingTeamInvite') });
const sameIntent = (snapshot) => location.href === snapshot.href && read('appPendingTeamInvite') === snapshot.pending;

export function pendingTeamInvite() {
  const route = parseTeamsPath(location.pathname);
  return route?.view === 'invite' ? route.token : peekPendingInvite(storage());
}

export function markTeamInviteSignup(accountId) {
  if (pendingTeamInvite() && accountId) write(SIGNUP_KEY, String(accountId));
}
export function isTeamInviteSignup(accountId) {
  return !!accountId && read(SIGNUP_KEY) === String(accountId);
}

/** Load private unfinished signup state only after authenticating the current account. */
export async function syncTeamInviteSignup(accountId, loadProgress) {
  let invite = pendingTeamInvite();
  if (!accountId) return null;
  const snapshot = intentSnapshot();
  const token = read('appLocalToken');
  const current = () => read('appUserId') === String(accountId) && read('appLocalToken') === token && sameIntent(snapshot);
  if (!current()) return null;
  let progress;
  try { progress = await loadProgress(invite); }
  catch (cause) {
    if (!current()) return null;
    const error = new Error(COPY.onboarding.setupLoadFailed, { cause });
    error.code = 'TEAM_SETUP_UNAVAILABLE';
    throw error;
  }
  if (!current()) return null;
  let step = ['gyms', 'name', 'features'].includes(progress?.step) ? progress.step : null;
  if (step && !invite) {
    // Only authenticated own-account recovery can restore a missing Team intent.
    invite = isInviteToken(progress?.inviteToken) ? progress.inviteToken : null;
    if (!invite || !stashPendingInvite(storage(), invite)) step = null;
  }
  if (step) {
    markTeamInviteSignup(accountId);
    write(`appOnboardingStep:${accountId}`, step);
  } else if (isTeamInviteSignup(accountId)) write(SIGNUP_KEY, null);
  return step;
}

function setManifest(url = '/manifest.json') {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) { link.href = url; link.removeAttribute('data-team-invite-hash'); }
}

/** Resolve a fresh installed-app launch before choosing any onboarding destination. */
export async function restoreTeamInvite() {
  const url = new URL(location.href);
  const snapshot = intentSnapshot();
  if (url.searchParams.has('teamContinuation')) {
    const continuation = url.searchParams.get('teamContinuation');
    let inviteToken = null;
    try {
      if (opaque(continuation)) {
        const res = await fetch(`/api/teams/continuation/${encodeURIComponent(continuation)}`, { method: 'POST' });
        if (!sameIntent(snapshot)) return;
        if (!res.ok) return; // temporary server failures must leave the launch intent retryable
        inviteToken = (await res.json()).inviteToken;
        if (!sameIntent(snapshot)) return;
      }
    } catch {
      // Keep the launch URL for a retry when the server becomes reachable.
      return;
    }
    url.searchParams.delete('teamContinuation');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    if (inviteToken && stashPendingInvite(storage(), inviteToken)) {
      history.replaceState(history.state, '', `/t/${inviteToken}`);
    }
    // Old installed launch URLs are ordinary launches; they must not erase a newer invite.
    try {
      const saved = JSON.parse(read(INSTALL_KEY) || 'null');
      if (saved?.continuation === continuation) write(INSTALL_KEY, null);
    } catch { /* malformed saved metadata is ignored */ }
  }
  const invite = pendingTeamInvite();
  if (invite) stashPendingInvite(storage(), invite);
}

/** Fetch only the public name and emoji; failures must not block account access. */
export async function publicTeamPreview() {
  const token = pendingTeamInvite();
  if (!token) return null;
  const snapshot = intentSnapshot();
  try {
    const res = await fetch(`/api/teams/invite/${encodeURIComponent(token)}/preview`);
    if (!sameIntent(snapshot) || pendingTeamInvite() !== token || !res.ok) return null;
    const preview = await res.json();
    return sameIntent(snapshot) && pendingTeamInvite() === token ? preview : null;
  } catch { return null; }
}

/** A distinct manifest URL carries an opaque one-use handoff into separate PWA storage. */
export async function prepareTeamInstall({ navigate = (url) => window.location.replace(url) } = {}) {
  const invite = pendingTeamInvite();
  if (!invite) return;
  const snapshot = intentSnapshot();
  try {
    const link = document.querySelector('link[rel="manifest"]');
    const href = link?.getAttribute('href') || '';
    const initial = href.match(/^\/api\/teams\/install-manifest\/([A-Za-z0-9_-]{43})$/);
    const expectedHash = link?.getAttribute('data-team-invite-hash');
    const sameManifest = () => document.querySelector('link[rel="manifest"]') === link && (link?.getAttribute('href') || '') === href && link?.getAttribute('data-team-invite-hash') === expectedHash;
    if (expectedHash && (!initial || !/^[a-f0-9]{64}$/.test(expectedHash) || !globalThis.crypto?.subtle)) {
      blockedInitialInvite = invite; setManifest(); return;
    }
    if (initial && /^[a-f0-9]{64}$/.test(expectedHash || '') && globalThis.crypto?.subtle) {
      let digest;
      try { digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invite)); }
      catch (_) { if (sameIntent(snapshot) && sameManifest()) { blockedInitialInvite = invite; setManifest(); } return; }
      const actualHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      if (!sameIntent(snapshot) || pendingTeamInvite() !== invite || !sameManifest()) return;
      if (actualHash === expectedHash && link.getAttribute('href') === href) {
        blockedInitialInvite = null;
        try { sessionStorage.removeItem(INITIAL_RELOAD_KEY); } catch (_) { /* no persistence required */ }
        write(INSTALL_KEY, JSON.stringify({ invite, continuation: initial[1], at: Date.now() }));
        return;
      }
      blockedInitialInvite = invite;
      setManifest();
      if (location.pathname === `/t/${invite}`) {
        try {
          if (sessionStorage.getItem(INITIAL_RELOAD_KEY) !== actualHash) {
            sessionStorage.setItem(INITIAL_RELOAD_KEY, actualHash);
            if (sessionStorage.getItem(INITIAL_RELOAD_KEY) === actualHash) navigate(`/t/${invite}`);
          }
        } catch (_) { /* without a reliable guard do not reload or issue a handoff */ }
      }
      return;
    }
    if (blockedInitialInvite === invite) return;
    let reloadGuard;
    try { reloadGuard = sessionStorage.getItem(INITIAL_RELOAD_KEY); } catch (_) { reloadGuard = null; }
    if (reloadGuard && location.pathname === `/t/${invite}`) return;
    const saved = JSON.parse(read(INSTALL_KEY) || 'null');
    if (saved?.invite === invite && opaque(saved.continuation) && Date.now() - saved.at < 24 * 60 * 60 * 1000) {
      setManifest(`/api/teams/install-manifest/${saved.continuation}`);
      return;
    }
    const res = await fetch(`/api/teams/invite/${encodeURIComponent(invite)}/continuation`, { method: 'POST' });
    if (!sameIntent(snapshot) || pendingTeamInvite() !== invite || !sameManifest()) return;
    if (!res.ok) return;
    const { continuation } = await res.json();
    if (!sameIntent(snapshot) || pendingTeamInvite() !== invite || !sameManifest()) return;
    if (!opaque(continuation)) return;
    write(INSTALL_KEY, JSON.stringify({ invite, continuation, at: Date.now() }));
    setManifest(`/api/teams/install-manifest/${continuation}`);
  } catch { /* account access still works without install continuation */ }
}

/** Invalidate the browser's install handoff when the invitation is reached here instead. */
export async function finishTeamInviteHandoff() {
  write(SIGNUP_KEY, null);
  const continuations = new Set();
  const link = document.querySelector('link[rel="manifest"]');
  const initial = (link?.getAttribute('href') || '').match(/^\/api\/teams\/install-manifest\/([A-Za-z0-9_-]{43})$/);
  if (initial && /^[a-f0-9]{64}$/.test(link?.getAttribute('data-team-invite-hash') || '')) continuations.add(initial[1]);
  try {
    const saved = JSON.parse(read(INSTALL_KEY) || 'null');
    if (opaque(saved?.continuation)) continuations.add(saved.continuation);
  } catch { /* malformed local state is ignored */ }
  write(INSTALL_KEY, null);
  setManifest();
  for (const continuation of continuations) {
    try { await fetch(`/api/teams/continuation/${continuation}`, { method: 'POST' }); }
    catch { /* 24-hour server expiry remains the fallback when offline */ }
  }
}
