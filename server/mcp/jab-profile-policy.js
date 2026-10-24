'use strict';

const HOST = 'jabboxingclub.marianatek.com';
const gym = require('../gyms.config').getGymConfig('jab-boxing');
const CALLBACK = gym.redirectUri;
const CLIENT_ID = gym.clientId;
const SCOPE = gym.scope;
function keysExactly(keys, wanted) { return keys.length === wanted.length && wanted.every(k => keys.includes(k)); }
function allowedAuthorize(q) {
  const names = [...q.keys()];
  return keysExactly(names, ['client_id', 'scope', 'response_type', 'redirect_uri', 'code_challenge', 'code_challenge_method']) &&
    q.get('client_id') === CLIENT_ID && q.get('scope') === SCOPE && q.get('response_type') === 'code' &&
    q.get('redirect_uri') === CALLBACK && /^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') || '') && q.get('code_challenge_method') === 'S256';
}

function assertAllowedProfileRequest(url, options = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const method = String(options.method || 'GET').toUpperCase();
  if (target.protocol !== 'https:' || target.hostname !== HOST || target.port || target.username || target.password)
    throw Object.assign(new Error('JAB profile request is outside the approved host'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  const p = target.pathname;
  const allowed = (method === 'GET' && (p === '/o/authorize/' || p === '/auth/login/' || p === '/api/customer/v1/me/account')) ||
    (method === 'POST' && (p === '/auth/login/' || p === '/o/token/'));
  if (!allowed || target.hash) throw Object.assign(new Error('JAB request is outside the profile-only allowlist'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  if (p === '/o/authorize/' && !allowedAuthorize(target.searchParams)) throw Object.assign(new Error('JAB authorization parameters are outside the profile-only allowlist'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  if (p === '/auth/login/') {
    if (!keysExactly([...target.searchParams.keys()], ['next'])) throw Object.assign(new Error('JAB login parameters are outside the profile-only allowlist'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
    let next; try { next = new URL(target.searchParams.get('next'), `https://${HOST}`); } catch (_) {}
    if (!next || next.origin !== `https://${HOST}` || next.pathname !== '/o/authorize/' || !allowedAuthorize(next.searchParams)) throw Object.assign(new Error('JAB login redirect is outside the profile-only allowlist'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  }
  if (p === '/api/customer/v1/me/account' && target.search) throw Object.assign(new Error('JAB profile query parameters are not permitted'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  if (p === '/o/token/') {
    const form = new URLSearchParams(String(options.body || ''));
    if (!keysExactly([...form.keys()], ['grant_type', 'code', 'client_id', 'redirect_uri', 'code_verifier']) || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== CLIENT_ID || form.get('redirect_uri') !== CALLBACK || !/^[A-Za-z0-9_-]{43}$/.test(form.get('code_verifier') || '')) throw Object.assign(new Error('Only the approved authorization-code exchange is allowed'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  }
  if (p === '/auth/login/' && method === 'POST') {
    const form = new URLSearchParams(String(options.body || ''));
    const contentType = new Headers(options.headers || {}).get('content-type') || '';
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType) || String(options.body || '').length > 16 * 1024 ||
      !keysExactly([...form.keys()], ['csrfmiddlewaretoken', 'username', 'password', 'next']) || !form.get('username') || form.get('username').length > 512 ||
      !form.get('password') || form.get('password').length > 512 || !form.get('csrfmiddlewaretoken') || form.get('csrfmiddlewaretoken').length > 512 ||
      form.get('next') !== target.searchParams.get('next')) throw Object.assign(new Error('JAB login form is outside the approved flow'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  }
  if (p === '/o/token/' && method === 'POST') {
    const contentType = new Headers(options.headers || {}).get('content-type') || '';
    const form = new URLSearchParams(String(options.body || ''));
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType) || String(options.body || '').length > 16 * 1024 || !form.get('code') || form.get('code').length > 2048) throw Object.assign(new Error('JAB token exchange body is outside bounds'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  }
  return target;
}

module.exports = { assertAllowedProfileRequest };
