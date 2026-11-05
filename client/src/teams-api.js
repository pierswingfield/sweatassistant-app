// T-1 Teams client API (PLAN-teams.md §7.4). Thin wrappers over apiFetch: no caching,
// because every Teams payload is a privacy projection that must reflect the latest
// membership and sharing state. Errors carry the server's `code` and `status`.
//
// Invite tokens are secrets (§2 principle 4): nothing here logs a URL or a token.

import { apiFetch } from './api.js';

export class TeamsApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    throw new TeamsApiError((data && data.message) || `Request failed (${res.status})`, { status: res.status, code: (data && data.code) || '' });
  }
  return data || {};
}

const id = (v) => encodeURIComponent(String(v));
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } };

export const teamsApi = {
  // T-2: the device zone decides "today" for the list's summaries.
  list: () => call(`/api/teams?tz=${id(deviceTz())}`),
  today: (teamId) => call(`/api/teams/${id(teamId)}/today?tz=${id(deviceTz())}`),
  create: ({ name, emoji, share }) => call('/api/teams', { method: 'POST', body: { name, emoji: emoji || null, share } }),
  get: (teamId) => call(`/api/teams/${id(teamId)}`),
  update: (teamId, patch) => call(`/api/teams/${id(teamId)}`, { method: 'PATCH', body: patch }),
  remove: (teamId) => call(`/api/teams/${id(teamId)}`, { method: 'DELETE' }),

  getInvite: (teamId) => call(`/api/teams/${id(teamId)}/invite`),
  rotateInvite: (teamId) => call(`/api/teams/${id(teamId)}/invite/rotate`, { method: 'POST' }),
  setInviteEnabled: (teamId, enabled) => call(`/api/teams/${id(teamId)}/invite`, { method: 'PUT', body: { enabled } }),

  previewInvite: (token) => call(`/api/teams/invite/${id(token)}`),
  requestJoin: (token, share) => call(`/api/teams/invite/${id(token)}/request`, { method: 'POST', body: { share } }),
  withdrawRequest: (token) => call(`/api/teams/invite/${id(token)}/request`, { method: 'DELETE' }),

  listRequests: (teamId) => call(`/api/teams/${id(teamId)}/requests`),
  decideRequest: (teamId, requestId, decision) => call(`/api/teams/${id(teamId)}/requests/${id(requestId)}`, { method: 'POST', body: { decision } }),

  updateMe: (teamId, patch) => call(`/api/teams/${id(teamId)}/me`, { method: 'PUT', body: patch }),
  setPinned: (teamId, pinned) => call(`/api/teams/${id(teamId)}/pin`, { method: 'PUT', body: { pinned } }),
  leave: (teamId) => call(`/api/teams/${id(teamId)}/me`, { method: 'DELETE' }),

  setCaptain: (teamId, memberRef, captain) => call(`/api/teams/${id(teamId)}/members/${id(memberRef)}`, { method: 'PUT', body: { captain } }),
  removeMember: (teamId, memberRef, block = false) => call(`/api/teams/${id(teamId)}/members/${id(memberRef)}`, { method: 'DELETE', body: { block } }),

  privacy: () => call('/api/privacy/sharing'),
};
